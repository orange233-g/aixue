import { describe, expect, it } from 'vitest'
import { searchSections, tokenize } from './search'
import type { KBSection } from '../../types'

function secs(body: string): KBSection[] {
  const parts = body.split('\n\n')
  const out: KBSection[] = []
  let p = 0
  for (let i = 0; i < parts.length; i++) {
    const len = i < parts.length - 1 ? parts[i].length + 2 : parts[i].length
    out.push({ id: `s${i}`, title: `节${i}`, start: p, end: p + len })
    p += len
  }
  return out
}

describe('BM25 索引缓存（V2-P03）', () => {
  it('同一份 bodyText+sections 再次查询命中缓存，结果一致', () => {
    const body = '海洋环境是生物多样性最丰富的栖息地之一。\n\n潮流会影响海洋生物的分布。'
    const sections = secs(body)
    const a = searchSections(body, sections, '海洋', 4)
    const b = searchSections(body, sections, '海洋', 4)
    expect(b.map((h) => h.section.id)).toEqual(a.map((h) => h.section.id))
    expect(b.map((h) => h.score)).toEqual(a.map((h) => h.score))
    expect(b.length).toBeGreaterThan(0)
  })

  it('不同查询共用同一份索引，命中结果随查询变化', () => {
    const body = '海洋的潮汐由月球引力驱动。\n\n大陆板块运动造就山脉。'
    const sections = secs(body)
    const hitOcean = searchSections(body, sections, '潮汐', 4).map((h) => h.section.id)
    const hitMountain = searchSections(body, sections, '山脉', 4).map((h) => h.section.id)
    expect(hitOcean).toContain('s0')
    expect(hitMountain).toContain('s1')
  })

  it('重建后的新 bodyText（即使内容近似）不误用旧索引', () => {
    const body1 = '第一部分讲海洋。\n\n第二部分讲陆地。'
    const body2 = '第一部分讲海洋。\n\n第二部分讲生物。'
    const s1 = secs(body1)
    const s2 = secs(body2)
    // 先让 s1 入缓存
    const before = searchSections(body1, s1, '陆地', 4)
    expect(before.some((h) => h.section.id === 's1' && h.score > 0)).toBe(true)
    // 新数组 + 新正文走新索引，不应命中「陆地→s1」的旧关系
    const after = searchSections(body2, s2, '生物', 4)
    expect(after.some((h) => h.section.id === 's1')).toBe(true)
  })

  it('空查询或空 sections 返回空', () => {
    expect(searchSections('任意正文 x'.repeat(10), secs('一段\n\n两段'), '', 4)).toEqual([])
    expect(searchSections('', [], '海洋', 4)).toEqual([])
  })
})

describe('tokenize（CJK bigram 与拉丁整词）', () => {
  it('连续中文生成重叠 bigram，单字回退为单字', () => {
    expect(tokenize('海洋知识')).toEqual(['海洋', '洋知', '知识'])
    expect(tokenize('海')).toEqual(['海'])
  })

  it('拉丁/数字小写整词，与中文分词交错', () => {
    expect(tokenize('Python3入门')).toEqual(['python3', '入门'])
  })
})