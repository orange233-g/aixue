// 验证生题数上限的系统级约束：AI 总题数 clamp、自定义单题型+总题数双约束、模板应用 clamp、生成前兜底拦截
import 'fake-indexeddb/auto'
import { MAX_QUESTIONS_PER_GENERATION, MAX_PER_TYPE } from '../src/types'
import { useGenerate } from '../src/stores/useGenerateStore'
import { useAI } from '../src/stores/useAIStore'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}
const S = () => useGenerate.getState()

async function run() {
  // AI 模式总题数 clamp
  S().setAiTotal(2000)
  assert(S().structureTotal === MAX_QUESTIONS_PER_GENERATION, `AI 总题数 clamp 到上限 ${MAX_QUESTIONS_PER_GENERATION}（实际 ${S().structureTotal}）`)
  S().setAiTotal(0)
  assert(S().structureTotal === 1, 'AI 总题数下限 1')

  // 自定义：单题型 clamp 到 MAX_PER_TYPE
  S().setMode('custom')
  S().setStructure('single', 500)
  assert(S().structure.single === MAX_PER_TYPE, `单题型 clamp 到 ${MAX_PER_TYPE}（实际 ${S().structure.single}）`)

  // 自定义：总题数不能超过系统红线（多个题型叠加）
  S().setStructure('single', 400)
  S().setStructure('judge', 900)
  const total = S().structureTotal
  assert(total <= MAX_QUESTIONS_PER_GENERATION, `自定义总题数 ≤ 上限（实际 ${total}）`)
  assert(S().structure.single === MAX_PER_TYPE, 'single 受单题型上限约束为 100')
  assert(S().structure.judge === MAX_PER_TYPE, 'judge 从 900 clamp 到 100（单题型上限）')

  // 模板/默认结构应用 clamp
  S().applyStructure({ single: 600, judge: 500, fill: 300 }, 'custom')
  const appliedTotal = S().structureTotal
  assert(appliedTotal <= MAX_QUESTIONS_PER_GENERATION, `模板应用后总题数 ≤ 上限（实际 ${appliedTotal}）`)

  // 生成前兜底拦截：强制把结构设为超限（模拟未来绕过 UI 的极端情况），generate 应在发起任何请求前拦截
  useAI.setState((s) => ({
    ...s,
    defaultId: 'zhipu',
    providers: { ...s.providers, zhipu: { apiKey: 'test-key', model: 'glm-4.5-air' } },
  }))
  useGenerate.setState({ structureTotal: 2000, structureMode: 'ai', structure: { ...defaultStruct(), single: 2000 } })
  let fetched = false
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => { fetched = true; throw new Error('不应发起请求') }) as unknown as typeof fetch
  await S().generate('测一批超限题目')
  globalThis.fetch = origFetch
  assert(fetched === false, '超限时未发起任何请求（系统级拦截）')
  assert(S().phase === 'idle', '超限时未进入生成阶段')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}
function defaultStruct() {
  const o: Record<string, number> = {}
  for (const k of ['single', 'multiple', 'judge', 'fill', 'match', 'order', 'short', 'case', 'essay', 'code']) o[k] = 0
  return o
}
run().catch((e) => { console.error('异常:', e); process.exit(1) })