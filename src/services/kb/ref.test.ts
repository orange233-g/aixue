import { describe, expect, it } from 'vitest'
import { shouldRejectQuery, MIN_EMBED_COS, searchKbHits } from './ref'
import type { KBDoc } from '../../types'

/** 最小 KBDoc 夹具：仅含检索所需的 bodyText + sections（start/end 切出正文片段） */
function makeKb(body: string): KBDoc {
  const parts = body.split('\n\n')
  let p = 0
  const sections = parts.map((text, i) => {
    const len = i < parts.length - 1 ? text.length + 2 : text.length
    const s = { id: `s${i}`, title: `节${i}`, start: p, end: p + len }
    p += len
    return s
  })
  return {
    id: 'kb-test-force', name: '测试库', status: 'ready', embedStatus: 'none',
    bodyText: body, consolidated: '', sections, files: [], created: 0, updated: 0,
  } as unknown as KBDoc
}

describe('shouldRejectQuery：相关性门禁（S2 评估定标）', () => {
  it('BM25 零命中 且 余弦低于阈值 → 拒绝（库内无相关内容）', () => {
    expect(shouldRejectQuery(0, 0.38)).toBe(true)
    expect(shouldRejectQuery(0, MIN_EMBED_COS - 0.01)).toBe(true)
  })
  it('BM25 有命中 → 不拒（部分相关，交给 prompt 纪律说明）', () => {
    expect(shouldRejectQuery(2.5, 0.3)).toBe(false)
    expect(shouldRejectQuery(0.5, 0)).toBe(false)
  })
  it('余弦达阈值 → 不拒（语义相关）', () => {
    expect(shouldRejectQuery(0, 0.62)).toBe(false)
    expect(shouldRejectQuery(0, MIN_EMBED_COS)).toBe(false)
  })
})

describe('searchKbHits：P1 通道强档（force）与会话级 topK', () => {
  const body = '海洋的潮汐由月球引力驱动，影响近岸生物分布。\n\n大陆板块运动造就山脉与峡谷。'
  const kb = makeKb(body)

  it('force=bm25：仅关键词通道，命中 BM25 相关节，返回 channel=bm25', async () => {
    const { hits, channel, gate } = await searchKbHits(kb, '潮汐', { force: 'bm25', topK: 4 })
    expect(channel).toBe('bm25')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].section.title).toContain('节0')
    expect(gate).toBeUndefined() // 纯 BM25 不做门禁
  })

  it('force=vec 且无向量缓存：不降级为 BM25，返回空 + channel=vec', async () => {
    // 该 id 从未 warmVectorCache，缓存缺失 → 直接判「向量不可用」返回空 vec
    const { hits, channel } = await searchKbHits(kb, '潮汐', { force: 'vec' })
    expect(channel).toBe('vec')
    expect(hits).toEqual([])
  })

  it('force=bm25 同时尊重 topK：返回节数不超 topK', async () => {
    const { hits } = await searchKbHits(kb, '海洋', { force: 'bm25', topK: 1 })
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  it('BM25 真无命中返回空，不应沿用上一条查询结果', async () => {
    await searchKbHits(kb, '潮汐', { force: 'bm25', topK: 4 })
    const { hits, channel } = await searchKbHits(kb, 'unseen_qzx_8941', { force: 'bm25', topK: 4 })
    expect(channel).toBe('bm25')
    expect(hits).toEqual([])
  })
})
