import 'fake-indexeddb/auto'
import { resetDB, dbUsage, clearAllStores } from '../src/db'
import { chat, setRetryBaseDelay } from '../src/ai/gateway'
import { AIError } from '../src/ai/types'
import { parseJSON, stripCodeFence, repairJSON } from '../src/ai/parse'
import { isPeakHour, estimateCost } from '../src/ai/usage/cost'
import type { AIConfig, PriceItem } from '../src/types'

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

const cfg: AIConfig = {
  defaultId: 'deepseek',
  providers: {
    deepseek: { apiKey: 'test-key', model: 'deepseek-chat' },
    qwen: { apiKey: 'qwen-key', model: 'qwen-plus' },
    openai: { apiKey: 'openai-key', model: 'gpt-4o-mini' },
  },
}

/** 构造一个可编程的 fetch mock */
function mockFetch(handler: (url: string, init?: RequestInit, call: number) => Promise<Response> | Response) {
  let call = 0
  const fn = async (url: string, init?: RequestInit) => {
    call++
    return handler(url, init, call)
  }
  ;(fn as unknown as { __calls: () => number }).__calls = () => call
  globalThis.fetch = fn as unknown as typeof fetch
  return fn as unknown as { __calls: () => number }
}

function okResponse(content: string, usage?: Record<string, number>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5 },
    }),
  } as unknown as Response
}

function errResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  } as unknown as Response
}

async function run() {
  resetDB()
  setRetryBaseDelay(1)

  console.log('—— 峰谷时段判定（北京时间）——')
  const beijing = (h: number) => Date.UTC(2026, 0, 1, h - 8, 0, 0) // UTC = 北京 - 8
  assert(isPeakHour(beijing(10)) === true, '北京 10:00 高峰')
  assert(isPeakHour(beijing(15)) === true, '北京 15:00 高峰')
  assert(isPeakHour(beijing(8)) === false, '北京 08:00 空闲')
  assert(isPeakHour(beijing(13)) === false, '北京 13:00 空闲（12-14 之间）')
  assert(isPeakHour(beijing(20)) === false, '北京 20:00 空闲')

  console.log('—— 费用估算 ——')
  const peakTs = beijing(10)
  const offTs = beijing(20)
  const base = estimateCost('deepseek', 'deepseek-chat', 1000, 500, 200, 800, undefined, peakTs)
  assert(Math.abs(base - (800 * 1 + 200 * 0.02 + 500 * 2) / 1e6) < 1e-9, '内置价表 deepseek-chat 估算')

  const custom: PriceItem = { model: 'm1', input: 10, cacheRead: 2, output: 30 }
  const c1 = estimateCost('deepseek', 'm1', 1000, 500, 200, 800, custom, peakTs)
  assert(Math.abs(c1 - (800 * 10 + 200 * 2 + 500 * 30) / 1e6) < 1e-9, '自定义定价（未开峰谷）')

  const peakValley: PriceItem = {
    model: 'm2', input: 10, cacheRead: 2, output: 30,
    peak: true, inputOff: 5, cacheReadOff: 1, outputOff: 15,
  }
  const cPeak = estimateCost('deepseek', 'm2', 1000, 500, 200, 800, peakValley, peakTs)
  assert(Math.abs(cPeak - (800 * 10 + 200 * 2 + 500 * 30) / 1e6) < 1e-9, '峰谷：高峰用峰价')
  const cOff = estimateCost('deepseek', 'm2', 1000, 500, 200, 800, peakValley, offTs)
  assert(Math.abs(cOff - (800 * 5 + 200 * 1 + 500 * 15) / 1e6) < 1e-9, '峰谷：空闲用谷价')

  console.log('—— 响应解析容错 ——')
  assert(parseJSON<{ a: number }>('{"a": 1}').a === 1, '标准 JSON 解析')
  assert(parseJSON<{ a: number }>('```json\n{"a": 1}\n```').a === 1, '剥离代码块标记')
  assert(parseJSON<{ a: number }>('```\n{"a": 1}\n```').a === 1, '剥离无语言代码块')
  assert(stripCodeFence('```json\n{"a": 1}\n```') === '{"a": 1}', 'stripCodeFence 精确剥离')
  assert(repairJSON('{"a": [1, 2') === '{"a": [1, 2]}', 'repairJSON 补全右括号')
  assert(parseJSON<{ a: number[] }>('{"a": [1, 2').a.length === 2, '截断 JSON 补全右括号')
  assert(parseJSON<{ a: number }>('{"a": 1, "b": 2,') !== null, '末尾逗号容错')
  let parseErr = false
  try {
    parseJSON('这不是 JSON')
  } catch (e) {
    parseErr = e instanceof AIError && e.code === 'PARSE_FAILED'
  }
  assert(parseErr, '非 JSON 抛 PARSE_FAILED')

  console.log('—— 网关：鉴权与未知厂商 ——')
  let authErr = false
  try {
    await chat([{ role: 'user', content: 'hi' }], { providerId: 'deepseek', model: 'm', module: 'generate' }, {
      defaultId: 'deepseek',
      providers: { deepseek: { apiKey: '' } },
    })
  } catch (e) {
    authErr = e instanceof AIError && e.code === 'AUTH_FAILED'
  }
  assert(authErr, '未配置 API Key → AUTH_FAILED')

  let modelErr = false
  try {
    await chat([{ role: 'user', content: 'hi' }], { providerId: 'nope', model: 'm', module: 'generate' }, cfg)
  } catch (e) {
    modelErr = e instanceof AIError && e.code === 'MODEL_NOT_FOUND'
  }
  assert(modelErr, '未知厂商 → MODEL_NOT_FOUND')

  console.log('—— 网关：限流重试（指数退避 ≤3）——')
  const rateMock = mockFetch((_url, _init, call) => {
    if (call <= 2) return errResponse(429, 'rate limited')
    return okResponse('第三次成功')
  })
  const r1 = await chat([{ role: 'user', content: 'hi' }], { providerId: 'deepseek', model: 'deepseek-chat', module: 'generate' }, cfg)
  assert(r1.content === '第三次成功', '429 重试后成功')
  assert(rateMock.__calls() === 3, `限流重试 3 次调用（实际 ${rateMock.__calls()}）`)

  console.log('—— 网关：超时重试（≤2）——')
  setRetryBaseDelay(1)
  const timeoutMock = mockFetch((_url, init) => {
    return new Promise<Response>((_, reject) => {
      // 永不 resolve；由 AbortSignal 触发 reject（模拟真实 fetch 的中断行为）
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  })
  let timeoutErr: AIError | null = null
  try {
    await chat([{ role: 'user', content: 'hi' }], { providerId: 'deepseek', model: 'deepseek-chat', module: 'generate', timeoutMs: 20 }, cfg)
  } catch (e) {
    timeoutErr = e instanceof AIError ? e : null
  }
  assert(timeoutErr?.code === 'TIMEOUT', '超时抛 TIMEOUT')
  assert(timeoutMock.__calls() === 3, `超时重试 3 次调用（初始 + 2 次重试，实际 ${timeoutMock.__calls()}）`)

  console.log('—— 网关：用量记录 ——')
  await clearAllStores()
  const okMock = mockFetch(() => okResponse('你好', { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 30 }))
  await chat([{ role: 'user', content: 'hi' }], { providerId: 'deepseek', model: 'deepseek-chat', module: 'generate' }, cfg)
  const records = await dbUsage.getAll()
  assert(records.length === 1, '成功调用写入 1 条用量')
  assert(records[0].module === 'generate', '记录 module')
  assert(records[0].inputTokens === 100 && records[0].outputTokens === 50, '记录 input/output token')
  assert(records[0].cacheReadTokens === 30 && records[0].cacheMissTokens === 70, '记录缓存命中/未命中')
  assert(records[0].cost > 0, '记录估算费用')
  assert(okMock.__calls() === 1, '成功场景只调用 1 次')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
