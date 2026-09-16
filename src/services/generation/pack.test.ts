import { describe, it, expect } from 'vitest'
import { buildPackChapters } from './pack'
import type { Question } from '../../types'

function q(id: string, kps: string[]): Question {
  return {
    id,
    type: 'single',
    stem: `题${id}`,
    options: ['A. a', 'B. b'],
    answer: 'A',
    explanation: 'x',
    kp_ids: kps,
    difficulty: 2,
  }
}

describe('buildPackChapters', () => {
  it('普通（无「>」）保持扁平章节，无 children，兼容旧行为', () => {
    const qs = [
      q('1', ['代数', '方程']),
      q('2', ['代数', '数轴']),
      q('3', ['几何', '三角形']),
      q('4', ['几何']),
    ]
    const chapters = buildPackChapters(qs)
    expect(chapters.length).toBe(2)
    for (const c of chapters) {
      expect(c.children).toBeUndefined()
    }
    const titles = chapters.map((c) => c.title)
    expect([...titles].sort()).toEqual(['代数', '几何'])
    expect(chapters.map((c) => c.question_ids).flat().sort()).toEqual(['1', '2', '3', '4'])
  })

  it('出现「大类>子类」触发两级：一级章下挂二级叶章，一级聚合全部二级题号', () => {
    const qs = [
      q('1', ['代数>一元方程']),
      q('2', ['代数>一元方程']),
      q('3', ['代数>不等式']),
      q('4', ['几何>三角形']),
    ]
    const chapters = buildPackChapters(qs)
    expect(chapters.length).toBe(2)
    const dai = chapters.find((c) => c.title === '代数')!
    expect(dai.children?.length).toBe(2)
    const jih = chapters.find((c) => c.title === '几何')!
    expect(jih.children?.length).toBe(1)
    // 一级题号 = 其全部二级题号并集
    expect(dai.question_ids.sort()).toEqual(['1', '2', '3'])
    expect(dai.children!.flatMap((s) => s.question_ids).sort()).toEqual(['1', '2', '3'])
  })

  it('同级超过 8 个合并进「其他综合」，一二级同理', () => {
    const kps = Array.from({ length: 10 }, (_, i) => `大类${i}>子类`)
    const qs = kps.map((k, i) => q(String(i), [k]))
    const chapters = buildPackChapters(qs)
    expect(chapters.length).toBe(8) // 前 7 大类 + 其他综合
    // 每道题都能在树中找到归属
    const allLeaves = chapters.flatMap((c) => c.children ?? [])
    expect(allLeaves.length).toBe(chapters.length)
    const leafQids = allLeaves.flatMap((s) => s.question_ids).sort()
    expect(leafQids).toEqual(qs.map((qq) => qq.id).sort())
  })

  it('大包（>100 题）章节上限自适应放宽到 12', () => {
    // 14 个大类、每类 9 题 = 126 题：小包上限下会折成 8 章，大包上限下保留 12 章（11 大类 + 其他综合）
    const qs = Array.from({ length: 126 }, (_, i) => q(String(i), [`大类${Math.floor(i / 9)}`]))
    const chapters = buildPackChapters(qs)
    expect(chapters.length).toBe(12) // 前 11 大类 + 其他综合
    const allQids = chapters.flatMap((c) => c.question_ids).sort()
    expect(allQids).toEqual(qs.map((qq) => qq.id).sort()) // 无一题丢失
  })

  it('恰好 100 题仍用默认上限 8（严格大于阈值才放宽）', () => {
    const qs = Array.from({ length: 100 }, (_, i) => q(String(i), [`大类${Math.floor(i / 8)}`]))
    const chapters = buildPackChapters(qs)
    expect(chapters.length).toBe(8) // 100 题未超阈值：13 组折叠为 8 章
  })
})