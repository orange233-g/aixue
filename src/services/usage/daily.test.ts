import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../types'
import { dailySeriesByWindow } from './index'

function rec(partial: Partial<UsageRecord>): UsageRecord {
  const ts = partial.timestamp ?? new Date('2026-08-30T10:00:00').getTime()
  return {
    id: 'r',
    module: 'chat',
    providerId: 'p',
    model: 'm',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 0,
    cacheMissTokens: 150,
    cost: null,
    timestamp: ts,
    ...partial,
  }
}

describe('BUG-7：按天花费图——日累计种子必须为 0，未定价记录仍如实「无法计算」', () => {
  const now = new Date('2026-08-31T12:00:00')

  it('当天记录全部已定价 → 日 cost 为累计金额（修复前恒 null 显示「无法计算」）', () => {
    const records = [
      rec({ timestamp: new Date('2026-08-31T08:00:00').getTime(), cost: 0.01, totalTokens: 100 }),
      rec({ timestamp: new Date('2026-08-31T09:00:00').getTime(), cost: 0.02, totalTokens: 200 }),
    ]
    const series = dailySeriesByWindow(records, 'today', now)
    expect(series).toHaveLength(1)
    expect(series[0].date).toBe('2026-08-31')
    expect(series[0].cost).toBeCloseTo(0.03, 6)
    expect(series[0].tokens).toBe(300)
  })

  it('当天含未定价记录（cost=null）→ 日 cost 为 null（如实「无法计算」）', () => {
    const records = [
      rec({ timestamp: new Date('2026-08-31T08:00:00').getTime(), cost: 0.01 }),
      rec({ timestamp: new Date('2026-08-31T09:00:00').getTime(), cost: null }),
    ]
    const series = dailySeriesByWindow(records, 'today', now)
    expect(series[0].cost).toBeNull()
  })

  it('无记录的日期 cost=0（空柱，不再显示「无法计算」）', () => {
    const records = [rec({ timestamp: new Date('2026-08-29T08:00:00').getTime(), cost: 0.01 })]
    const series = dailySeriesByWindow(records, 'week', now)
    const empty = series.find((s) => s.date === '2026-08-31')
    expect(empty?.cost).toBe(0)
    expect(empty?.tokens).toBe(0)
  })
})
