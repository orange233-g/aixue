import {
  windowRange,
  calcKPI,
  byModule,
  byModel,
  dailySeriesByWindow,
  moduleLabel,
  dayStr,
  type TimeWindow,
} from '../src/services/usage'
import type { UsageRecord } from '../src/types'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

function rec(p: Partial<UsageRecord>): UsageRecord {
  return {
    id: 0,
    module: 'generate',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    cost: 0,
    timestamp: 0,
    ...p,
  }
}

async function run() {
  console.log('—— 时间窗（本地时区）——')
  const now = new Date(2026, 7, 15, 10, 0, 0).getTime() // 2026-08-15 10:00 本地
  const startOfDay = new Date(2026, 7, 15).getTime()

  const today = windowRange('today', now)
  assert(today.from === startOfDay && today.to === now, '今天：从当日零点到 now')

  const dow = new Date(now).getDay()
  const offset = (dow + 6) % 7 // 0=周一
  const week = windowRange('week', now)
  assert(week.from === startOfDay - offset * 86400000 && week.to === now, '本周：从周一起到 now')

  const month = windowRange('month', now)
  assert(month.from === new Date(2026, 7, 1).getTime() && month.to === now, '本月：从 1 号零点到 now')

  const all = windowRange('all', now)
  assert(all.from === 0 && all.to === now, '全部：从 0 到 now')

  console.log('—— dayStr / moduleLabel ——')
  assert(dayStr(new Date(2026, 7, 15, 23, 59).getTime()) === '2026-08-15', 'dayStr 本地日期格式')
  assert(moduleLabel('generate') === '生题', 'generate → 生题')
  assert(moduleLabel('doc') === '文档整理', 'doc → 文档整理')
  assert(moduleLabel('test') === '连通测试', 'test → 连通测试')
  assert(moduleLabel('unknown') === 'unknown', '未知板块回退原名')

  console.log('—— calcKPI ——')
  const ts1 = new Date(2026, 7, 15, 9, 0).getTime()
  const ts2 = new Date(2026, 7, 15, 10, 0).getTime()
  const records: UsageRecord[] = [
    rec({ id: 1, module: 'generate', inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 30, cacheMissTokens: 70, cost: 0.001, timestamp: ts1 }),
    rec({ id: 2, module: 'test', inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheMissTokens: 10, cost: 0, timestamp: ts2 }),
  ]
  const kpi = calcKPI(records)
  assert(Math.abs(kpi.cost - 0.001) < 1e-9, 'KPI 累计费用')
  assert(kpi.totalTokens === 165, 'KPI 累计 token')
  assert(kpi.inputTokens === 110 && kpi.outputTokens === 55, 'KPI input/output')
  assert(kpi.cacheReadTokens === 30 && kpi.cacheMissTokens === 80, 'KPI 缓存命中/未命中')
  assert(Math.abs(kpi.cacheHitRate - 30 / 110) < 1e-9, 'KPI 缓存命中率')
  assert(kpi.calls === 2, 'KPI 调用次数')
  assert(calcKPI([]).cacheHitRate === 0 && calcKPI([]).calls === 0, '空记录 KPI 为 0')

  console.log('—— byModule ——')
  const modules = byModule(records)
  assert(modules.length === 2, '按板块分组数量')
  assert(modules[0].module === 'generate' && modules[0].label === '生题', '费用高的板块排前')
  assert(modules[0].cost === 0.001 && modules[0].calls === 1, '板块统计费用与次数')
  assert(modules[1].label === '连通测试', 'test 板块显示名')

  console.log('—— byModel ——')
  const models = byModel(records)
  assert(models.length === 1, '同厂商同模型合并')
  assert(models[0].model === 'deepseek-chat' && models[0].calls === 2, '模型合并统计')
  assert(models[0].totalTokens === 165, '模型合并 token')

  const mixed = [
    rec({ id: 3, providerId: 'qwen', model: 'qwen-plus', cost: 0.5, totalTokens: 100, timestamp: ts1 }),
    rec({ id: 4, providerId: 'deepseek', model: 'deepseek-chat', cost: 0.1, totalTokens: 50, timestamp: ts1 }),
  ]
  const models2 = byModel(mixed)
  assert(models2[0].model === 'qwen-plus' && models2[1].model === 'deepseek-chat', '按费用降序排列模型')

  console.log('—— dailySeriesByWindow ——')
  const ts3 = new Date(2026, 7, 14, 10, 0).getTime()
  // 2026-08-15 是周六，本周一为 08-10，窗口序列应为 08-10..08-15 共 6 天
  const days = dailySeriesByWindow(
    [
      rec({ id: 5, totalTokens: 100, cost: 0.1, timestamp: ts2 }),
      rec({ id: 6, totalTokens: 200, cost: 0.2, timestamp: ts3 }),
      rec({ id: 7, totalTokens: 50, cost: 0.05, timestamp: ts2 }),
    ],
    'week',
    new Date(2026, 7, 15, 10, 0, 0),
  )
  assert(days.length === 6, '本周窗口生成 6 天连续序列')
  assert(days[0].date === '2026-08-10' && days[4].date === '2026-08-14', '序列从周一起，无数据日补零')
  assert(days[4].tokens === 200 && days[4].cost === 0.2, '08-14 聚合 token 与费用')
  assert(days[5].tokens === 150 && Math.abs(days[5].cost - 0.15) < 1e-9, '08-15 同日聚合 token 与费用')

  const todaySeries = dailySeriesByWindow(
    [rec({ id: 8, totalTokens: 10, cost: 0.01, timestamp: ts2 })],
    'today',
    new Date(2026, 7, 15, 10, 0, 0),
  )
  assert(todaySeries.length === 1 && todaySeries[0].date === '2026-08-15', '今天窗口仅当日一列')

  const monthSeries = dailySeriesByWindow([], 'month', new Date(2026, 7, 15, 10, 0, 0))
  assert(monthSeries.length === 15 && monthSeries[0].date === '2026-08-01', '本月窗口从 1 号起连续')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
