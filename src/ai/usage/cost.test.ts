import { describe, expect, it } from 'vitest'
import { estimateCost, isPeakHour, type PeakCfg } from './cost'
import type { PriceItem } from '../../types'

/** 构造一个「北京时间 H 点整」的时刻 */
function beijingTs(h: number, mi = 0): number {
  return Date.UTC(2026, 0, 1, h - 8, mi, 0)
}

describe('isPeakHour：可配置高峰时段', () => {
  it('缺省默认两段 9-12 与 14-18', () => {
    expect(isPeakHour(beijingTs(8))).toBe(false)
    expect(isPeakHour(beijingTs(9))).toBe(true)
    expect(isPeakHour(beijingTs(11))).toBe(true)
    expect(isPeakHour(beijingTs(12))).toBe(false)
    expect(isPeakHour(beijingTs(13))).toBe(false)
    expect(isPeakHour(beijingTs(14))).toBe(true)
    expect(isPeakHour(beijingTs(17))).toBe(true)
    expect(isPeakHour(beijingTs(18))).toBe(false)
  })

  it('自定义单段时段生效', () => {
    expect(isPeakHour(beijingTs(21), [20, 23])).toBe(true)
    expect(isPeakHour(beijingTs(19), [20, 23])).toBe(false)
  })

  it('支持跨午夜时段（22:00-次日 6:00）', () => {
    expect(isPeakHour(beijingTs(23), [22, 6])).toBe(true)
    expect(isPeakHour(beijingTs(5), [22, 6])).toBe(true)
    expect(isPeakHour(beijingTs(12), [22, 6])).toBe(false)
    expect(isPeakHour(beijingTs(7), [22, 6])).toBe(false)
  })
})

describe('estimateCost：峰谷金额随服务商级时段切换', () => {
  const PRICE: PriceItem = { input: 10, inputOff: 2 }
  const PEAK: PeakCfg = { enabled: true, times: [20, 23] }

  it('低谷段用谷价，高峰段用峰价（时段来自服务商级配置）', () => {
    const off = estimateCost('x', 'y', 0, 0, 0, 1_000_000, PRICE, PEAK, beijingTs(12))
    const on = estimateCost('x', 'y', 0, 0, 0, 1_000_000, PRICE, PEAK, beijingTs(21))
    expect(off).toBeCloseTo(2)
    expect(on).toBeCloseTo(10)
  })

  it('服务商级开关关闭时始终用平峰价（低谷段也不用谷价）', () => {
    const flat = estimateCost('x', 'y', 0, 0, 0, 1_000_000, PRICE, { enabled: false }, beijingTs(12))
    expect(flat).toBeCloseTo(10)
  })

  it('未配置定价返回 null（预计花费无法计算），不再回退内置价', () => {
    expect(estimateCost('x', 'y', 0, 0, 0, 1_000_000, undefined, PEAK, beijingTs(12))).toBeNull()
    expect(estimateCost('x', 'y', 0, 0, 0, 1_000_000, {}, PEAK, beijingTs(12))).toBeNull()
    // 部分定价也参与计算（缺省字段按 0 计），不再算 null
    expect(estimateCost('x', 'y', 0, 0, 0, 1_000_000, { input: 10 }, PEAK, beijingTs(21))).toBeCloseTo(10)
  })
})