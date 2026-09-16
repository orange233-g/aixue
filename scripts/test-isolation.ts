// 专项验证失败隔离：单批失败应跳过、保留其他批成功题目、不中断全局
import 'fake-indexeddb/auto'
import { resetDB, clearAllStores } from '../src/db'
import { runGeneration } from '../src/services/generation'
import type { AIConfig, GenerateRequest, Session } from '../src/types'
import { encodeSnapshot } from '../src/services/generation'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const cfg: AIConfig = {
  defaultId: 'deepseek',
  providers: { deepseek: { apiKey: 'test-key', model: 'deepseek-chat' } },
}
const snap = { providerId: 'deepseek', model: 'deepseek-chat' }

function bodyOf(init?: RequestInit) {
  return JSON.parse(String(init?.body))
}
function okQuestions(questions: unknown[]): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ questions }) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
  } as unknown as Response
}
function okText(content: string): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
  } as unknown as Response
}
function makeSession(): Session {
  return { id: 's_iso', title: '隔离', created: 0, summary: '', messages: [], packages: [], provider: encodeSnapshot(snap) }
}

async function run() {
  resetDB()
  await clearAllStores()
  let isoCalls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    isoCalls++
    const body = bodyOf(init)
    const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
    const m = user.match(/本批请生成 (\d+) 道/)
    const count = m ? Number(m[1]) : 0
    if (count === 10) return okText('非法 JSON，模拟模型失败')
    const questions = Array.from({ length: count }, (_, i) => ({
      type: 'single', stem: `隔离题 ${i + 1}`, options: ['A', 'B', 'C', 'D'],
      answer: '[0]', explanation: '解析', kp_ids: ['kp_1'], difficulty: 2,
    }))
    return okQuestions(questions)
  }) as unknown as typeof fetch

  const req: GenerateRequest = { content: '隔离测试', structure: { single: 50 }, source: 'custom' }
  const { questions, failedBatches } = await runGeneration(makeSession(), '生成一批', req, cfg)
  assert(questions.length === 40, `失败批被跳过，保留成功批 40 题（实际 ${questions.length}）`)
  assert(failedBatches === 1, `记录失败批数 1（实际 ${failedBatches}）`)
  assert(isoCalls === 4, `40 批1次 + 10 批重试2次 + 摘要1次，共 ${isoCalls} 次`)

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}
run().catch((e) => { console.error('异常:', e); process.exit(1) })