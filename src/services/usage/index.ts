import type { UsageRecord } from '../../types'

export type TimeWindow = 'today' | 'week' | 'month' | 'all'

export const WINDOW_OPTIONS: { id: TimeWindow; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'month', label: '本月' },
  { id: 'all', label: '全部' },
]

/** 板块显示名（见 PRD 4.6.2），新增板块在此登记；未登记的模块名回退原样展示不臆造 */
export const MODULE_LABELS: Record<string, string> = {
  generate: '生题',
  structure: '结构推荐',
  summary: '摘要压缩',
  doc: '文档整理',
  test: '连通测试',
  // 会话/意图链路（GeneratePage 对话分流）
  chat: '闲聊对话',
  gather: '需求收集',
  intent: '意图识别',
  prompt: '出题提示',
  // 学习本入库后的小模型元信息补充
  'enrich-meta': '学习本元信息',
  // 知识库整理（旧版 AI 整理已下线，映射保留供历史用量记录归组；本地处理不耗 token）
  kb: '知识库整理',
}

export function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module
}

/**
 * 板块两级结构：大板块（group）→ 消耗子类（module）。
 * 每个消费 module 归属一个大板块；未登记 / 工具类（连通测试等零星调用）归「其他」兜底，避免硬塞进业务大板块。
 */
export const MODULE_GROUP: Record<string, string> = {
  // 生题链路（需求收集 → 意图识别 → 出题提示 → 生题 → 结构推荐 → 摘要压缩 → 入库元信息，及文档整理作生题资料）
  generate: 'gen',
  structure: 'gen',
  summary: 'gen',
  gather: 'gen',
  intent: 'gen',
  prompt: 'gen',
  'enrich-meta': 'gen',
  doc: 'gen',
  // 知识库整理（旧版 AI 整理已下线，历史记录归组用）
  kb: 'kb',
  // 闲聊对话
  chat: 'chat',
  // 工具/其他：连通测试等零星调用
  test: 'other',
}

export const GROUP_LABELS: Record<string, string> = {
  gen: '生题',
  kb: '知识库',
  chat: '闲聊对话',
  other: '其他',
}

/** 大板块展示顺序（生成/知识库/闲聊在前，其余兜底在后） */
export const GROUP_ORDER: string[] = ['gen', 'kb', 'chat', 'other']

/** module → 大板块 id；未登记归「其他」 */
export function groupOf(module: string): string {
  return MODULE_GROUP[module] ?? 'other'
}

export interface ModuleStat {
  module: string
  label: string
  cost: number | null
  totalTokens: number
  calls: number
}

export interface GroupStat {
  id: string
  label: string
  cost: number | null
  totalTokens: number
  calls: number
  modules: ModuleStat[]
}

/** 费用聚合：任一侧未定价(null) 则结果视为无法计算(null) */
function addCost(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a + b
}

/** 按大板块聚合，每个板块内子类按消耗降序（两级视图的顶层数据） */
export function byGroup(records: UsageRecord[]): GroupStat[] {
  const map = new Map<string, GroupStat>()
  for (const r of records) {
    const gid = groupOf(r.module)
    let gs = map.get(gid)
    if (!gs) {
      gs = { id: gid, label: GROUP_LABELS[gid] ?? gid, cost: 0, totalTokens: 0, calls: 0, modules: [] }
      map.set(gid, gs)
    }
    gs.cost = addCost(gs.cost, r.cost)
    gs.totalTokens += r.totalTokens
    gs.calls++
    const label = moduleLabel(r.module)
    const ms = gs.modules.find((m) => m.module === r.module)
    if (ms) {
      ms.cost = addCost(ms.cost, r.cost)
      ms.totalTokens += r.totalTokens
      ms.calls++
    } else {
      gs.modules.push({ module: r.module, label, cost: r.cost, totalTokens: r.totalTokens, calls: 1 })
    }
  }
  return [...map.values()]
    .sort((a, b) => GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id))
    .map((g) => ({ ...g, modules: g.modules.sort((a, b) => b.totalTokens - a.totalTokens) }))
}

/** 时间窗起止（本地时区）：今天 / 本周（周一起）/ 本月 / 全部 */
export function windowRange(window: TimeWindow, now = Date.now()): { from: number; to: number } {
  const d = new Date(now)
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (window === 'today') return { from: startOfDay, to: now }
  if (window === 'week') {
    const offset = (d.getDay() + 6) % 7 // 0=周一
    return { from: startOfDay - offset * 86400000, to: now }
  }
  if (window === 'month') {
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now }
  }
  return { from: 0, to: now }
}

export function dayStr(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/* ============================ 格式化（参考橘子工作台 usage.ts） ============================ */

/** 千分位 token 格式化：超过 1 万显示「xx万」，超过 1 亿显示「xx亿」，否则返回整数 */
export function formatTokens(n: number): string {
  if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(2) + '万'
  return String(Math.round(n))
}

/** 费用格式化：未定价(null) 显示「无法计算」；金额小，<0.01 保留 4 位，否则 2 位 */
export function formatCost(n: number | null): string {
  if (n === null) return '无法计算'
  if (!isFinite(n) || n <= 0) return '¥0'
  if (n < 0.01) return '¥' + n.toFixed(4)
  return '¥' + n.toFixed(2)
}

/** 纯数字费用格式（不带 ¥ 符号），用于图上数值标注；未定价(null) 显示「无法计算」 */
export function formatCostPlain(n: number | null): string {
  if (n === null) return '无法计算'
  if (!isFinite(n) || n <= 0) return '0'
  if (n < 0.01) return n.toFixed(4)
  return n.toFixed(2)
}

/* ============================ 聚合统计（纯函数） ============================ */

export interface UsageKPI {
  cost: number | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  cacheHitRate: number
  calls: number
}

export function calcKPI(records: UsageRecord[]): UsageKPI {
  let cost: number | null = 0
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheMissTokens = 0
  for (const r of records) {
    cost = addCost(cost, r.cost)
    totalTokens += r.totalTokens
    inputTokens += r.inputTokens
    outputTokens += r.outputTokens
    cacheReadTokens += r.cacheReadTokens
    cacheMissTokens += r.cacheMissTokens
  }
  return {
    cost,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheMissTokens,
    cacheHitRate: cacheReadTokens + cacheMissTokens > 0 ? cacheReadTokens / (cacheReadTokens + cacheMissTokens) : 0,
    calls: records.length,
  }
}

export function byModule(records: UsageRecord[]): ModuleStat[] {
  const map = new Map<string, ModuleStat>()
  for (const r of records) {
    const s = map.get(r.module) ?? { module: r.module, label: moduleLabel(r.module), cost: 0, totalTokens: 0, calls: 0 }
    s.cost = addCost(s.cost, r.cost)
    s.totalTokens += r.totalTokens
    s.calls++
    map.set(r.module, s)
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

export interface ModelStat {
  providerId: string
  model: string
  cost: number | null
  totalTokens: number
  calls: number
}

export function byModel(records: UsageRecord[]): ModelStat[] {
  const map = new Map<string, ModelStat>()
  for (const r of records) {
    const key = `${r.providerId}:${r.model}`
    const s = map.get(key) ?? { providerId: r.providerId, model: r.model, cost: 0, totalTokens: 0, calls: 0 }
    s.cost = addCost(s.cost, r.cost)
    s.totalTokens += r.totalTokens
    s.calls++
    map.set(key, s)
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

export interface DailyStat {
  date: string
  label: string
  tokens: number
  cost: number | null
}

/**
 * 按时间窗口返回每日 token / 费用序列（柱状图跟随当前窗口，参考橘子工作台 dailySeriesByWindow）：
 * 今天→单日，本周→本周每天，本月→本月每天，全部→有记录的天（最多最近 60 天）。
 */
export function dailySeriesByWindow(records: UsageRecord[], mode: TimeWindow, now = new Date()): DailyStat[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const keys: string[] = []
  if (mode === 'today') {
    keys.push(dayStr(today.getTime()))
  } else if (mode === 'week') {
    const dow = today.getDay()
    const monday = new Date(today.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000)
    for (let d = new Date(monday); d <= today; d.setDate(d.getDate() + 1)) {
      keys.push(dayStr(new Date(d).getTime()))
    }
  } else if (mode === 'month') {
    const y = now.getFullYear()
    const m = now.getMonth()
    for (let day = 1; day <= now.getDate(); day++) {
      keys.push(dayStr(new Date(y, m, day).getTime()))
    }
  } else {
    const floor = new Date(today.getTime() - 59 * 86400000)
    let start = today
    for (const r of records) {
      const d = new Date(dayStr(r.timestamp) + 'T00:00:00')
      if (d < start) start = d
    }
    if (start < floor) start = floor
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      keys.push(dayStr(new Date(d).getTime()))
    }
  }
  const list: DailyStat[] = keys.map((date) => {
    const d = new Date(date + 'T00:00:00')
    // BUG-7 修复：日累计种子必须是 0 而非 null——addCost 的 null 语义是「该日存在未定价记录，无法计算」，
    // 种子 null 会与第一条记录相加时把整日污染成 null（addCost(null, n) === null），
    // 柱状图恒「无法计算」。种子 0 后：无记录日保持 0（UI 空串）、有未定价记录仍如实显示无法计算
    return { date, label: `${d.getMonth() + 1}/${d.getDate()}`, tokens: 0, cost: 0 }
  })
  const idx = new Map(list.map((x, i) => [x.date, i]))
  for (const r of records) {
    const j = idx.get(dayStr(r.timestamp))
    if (j !== undefined) {
      list[j].tokens += r.totalTokens
      list[j].cost = addCost(list[j].cost, r.cost)
    }
  }
  return list
}
