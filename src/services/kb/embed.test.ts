import { describe, expect, it } from 'vitest'
import {
  buildAnchors,
  chunkTexts,
  decideAnchorStrategy,
  CHUNK_CHARS,
  ANCHOR_BUDGET,
} from './embed'
import type { KBSection } from '../../types'

const mk = (sections: KBSection[], body: string) => ({ sections, bodyText: body })

describe('decideAnchorStrategy：规模自适应决策', () => {
  it('小库（≤预算锚点数）→ full', () => {
    // 500 字 → 全量需 2 锚点 ≤ 4000 → full
    expect(decideAnchorStrategy(500)).toBe('full')
    // 恰好到预算边界
    expect(decideAnchorStrategy(CHUNK_CHARS * ANCHOR_BUDGET)).toBe('full')
  })
  it('大库（>预算锚点数）→ section', () => {
    // 130 万字 → 全量需 4334 锚点 > 4000 → section
    expect(decideAnchorStrategy(1300000)).toBe('section')
    expect(decideAnchorStrategy(CHUNK_CHARS * ANCHOR_BUDGET + 1)).toBe('section')
  })
})

describe('buildAnchors：full 模式（小库全量 chunk）', () => {
  it('短节整节一个锚点，映射正确', () => {
    const body = '甲节内容' + '。'.repeat(100) + '\n\n' + '乙节内容' + '。'.repeat(100)
    const sections: KBSection[] = [
      { id: 's0', title: '甲', start: 0, end: 103 },
      { id: 's1', title: '乙', start: 105, end: 208 },
    ]
    const { anchors, anchorSectionIdx } = buildAnchors(mk(sections, body))
    expect(anchors).toHaveLength(2)
    expect(anchors[0].startsWith('甲')).toBe(true)
    expect(anchorSectionIdx).toEqual([0, 1])
  })

  it('长节按 CHUNK_CHARS 切多个锚点，全部映射回该节', () => {
    const longBody = '核心事件'.repeat(150) // 600 字 → 3 chunk（300×2）
    const body = longBody
    const sections: KBSection[] = [{ id: 's0', title: '长章', start: 0, end: body.length }]
    const { anchors, anchorSectionIdx } = buildAnchors(mk(sections, body))
    expect(anchors.length).toBeGreaterThan(1)
    expect(anchors[0].startsWith('长章')).toBe(true) // 首 chunk 带标题
    expect(anchorSectionIdx.every((i) => i === 0)).toBe(true)
    // 覆盖整节：拼接后应包含原文
    expect(anchors.join('').length).toBeGreaterThanOrEqual(body.length)
  })

  it('空 sections 返回空', () => {
    expect(buildAnchors(mk([], 'x'))).toEqual({ anchors: [], anchorSectionIdx: [] })
  })
})

describe('buildAnchors：section 模式（大库节采样）', () => {
  it('大库每节 1 锚点（节首 200 字），长节追加中段锚点', () => {
    // 构造总字数 > 120 万（CHUNK_CHARS×ANCHOR_BUDGET）触发 section
    const pad = '填充文字'.repeat(400000) // 160 万字
    const longSec = '长节正文' + '中段事件'.repeat(1200) + '结尾' // > 2000 字
    const shortSec = '短节正文内容。'
    const body = pad + '\n\n' + longSec + '\n\n' + shortSec
    const padEnd = pad.length
    const longStart = padEnd + 2
    const longEnd = longStart + longSec.length
    const shortStart = longEnd + 2
    const shortEnd = shortStart + shortSec.length
    const sections: KBSection[] = [
      { id: 's0', title: '填充', start: 0, end: padEnd },
      { id: 's1', title: '长节', start: longStart, end: longEnd },
      { id: 's2', title: '短节', start: shortStart, end: shortEnd },
    ]
    const { anchors, anchorSectionIdx } = buildAnchors(mk(sections, body))
    expect(decideAnchorStrategy(body.length)).toBe('section')
    // 填充节 2 锚点（160 万字节首+中段）；长节 2 锚点（节首+中段）；短节 1 锚点
    expect(anchors.length).toBe(5)
    expect(anchorSectionIdx).toEqual([0, 0, 1, 1, 2])
    // 节首锚点带标题
    expect(anchors[2].startsWith('长节')).toBe(true)
  })
})

describe('chunkTexts：分批切分', () => {
  it('按 batchSize 切分', () => {
    const chunks = chunkTexts(['a', 'b', 'c', 'd', 'e'], 2)
    expect(chunks).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('batchSize<=0 整批', () => {
    const chunks = chunkTexts(['a', 'b'], 0)
    expect(chunks).toEqual([['a', 'b']])
  })

  it('空数组返回空', () => {
    expect(chunkTexts([], 2)).toEqual([])
  })
})
