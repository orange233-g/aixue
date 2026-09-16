import type { PriceItem } from '../../types'

/** 服务商级峰谷配置（来自 ProviderCfg.peakEnabled/peakTimes，时段按厂商判定，非按模型） */
export interface PeakCfg {
  enabled?: boolean
  times?: number[]
}

/** 默认高峰时段（北京时间 9:00-12:00、14:00-18:00，参考橘子工作台 usage.ts）。可被 ProviderCfg.peakTimes 覆盖 */
const DEFAULT_PEAK_TIMES = [9, 12, 14, 18]

/** 判断 ts 是否处于高峰时段。windows 为 24h 偶长数组两两一段（[s,e]），支持跨午夜（s>e）。缺省用默认两段 */
export function isPeakHour(ts: number, windows: number[] = DEFAULT_PEAK_TIMES): boolean {
  const d = new Date(ts + 8 * 3600000) // 转北京时间（UTC+8）
  const h = d.getUTCHours()
  for (let i = 0; i + 1 < windows.length; i += 2) {
    const s = windows[i]
    const e = windows[i + 1]
    if (s < e ? h >= s && h < e : h >= s || h < e) return true
  }
  return false
}

/** 判断是否已配置定价：任一项为有效正数即视为已填（选填；未填则「预计花费无法计算」） */
export function hasPriceCfg(price?: PriceItem): boolean {
  if (!price) return false
  return [price.input, price.cacheRead, price.output, price.inputOff, price.cacheReadOff, price.outputOff].some(
    (v) => typeof v === 'number' && isFinite(v) && v > 0,
  )
}

/**
 * 估算单次调用费用（元）：
 * 缓存命中输入 × 缓存单价 + 缓存未命中输入 × 输入单价 + 输出 × 输出单价。
 * 峰谷由服务商级开关决定：服务商开启高峰时段（peakCfg.enabled）时，高峰用峰价、空闲用谷价（谷价默认 = 峰价一半）；
 * 高峰时段取服务商级 peakCfg.times，缺省用全局默认；未开启则一律平峰价。
 */
export function estimateCost(
  _providerId: string,
  _model: string,
  _inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheMissTokens: number,
  price?: PriceItem,
  peakCfg?: PeakCfg,
  ts?: number,
): number | null {
  if (!hasPriceCfg(price)) return null // 未配置定价：无法计算
  const useValley = !!peakCfg?.enabled
  const peak = useValley && isPeakHour(ts ?? Date.now(), peakCfg?.times)
  const p = price as PriceItem
  let input: number
  let cacheRead: number
  let output: number
  if (useValley && !peak) {
    // 空闲时段用谷价（缺省 = 峰价一半）
    input = p.inputOff ?? (p.input ?? 0) / 2
    cacheRead = p.cacheReadOff ?? (p.cacheRead ?? 0) / 2
    output = p.outputOff ?? (p.output ?? 0) / 2
  } else {
    // 高峰（或未开峰谷）：一律峰价
    input = p.input ?? 0
    cacheRead = p.cacheRead ?? 0
    output = p.output ?? 0
  }
  return (cacheMissTokens * input + cacheReadTokens * cacheRead + outputTokens * output) / 1_000_000
}
