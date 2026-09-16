import 'fake-indexeddb/auto'
import { resetDB, dbUsage, clearAllStores } from '../src/db'
import { useAI } from '../src/stores/useAIStore'
import { AIError } from '../src/ai/types'
import type { ProviderCfg } from '../src/types'

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

function okModels(models: string[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: models.map((id) => ({ id })) }),
  } as unknown as Response
}

function okChat(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
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
  await clearAllStores()
  // 重置 store 为默认空配置，保证测试隔离
  useAI.setState({
    providers: {
      deepseek: { apiKey: '', model: '' },
      qwen: { apiKey: '', model: '' },
      openai: { apiKey: '', model: '' },
    },
    defaultId: 'deepseek',
    loaded: true,
  })

  const draft: ProviderCfg = { apiKey: 'test-key', model: 'deepseek-chat' }

  console.log('—— store.fetchModels ——')
  let authErr = false
  try {
    await useAI.getState().fetchModels('deepseek', { apiKey: '', model: '' })
  } catch (e) {
    authErr = e instanceof AIError && e.code === 'AUTH_FAILED'
  }
  assert(authErr, '未填 Key → AUTH_FAILED')

  let modelErr = false
  try {
    await useAI.getState().fetchModels('nope', draft)
  } catch (e) {
    modelErr = e instanceof AIError && e.code === 'MODEL_NOT_FOUND'
  }
  assert(modelErr, '未知厂商 → MODEL_NOT_FOUND')

  const listMock = mockFetch((url) => {
    assert(url.endsWith('/models'), `请求 /models（实际 ${url}）`)
    return okModels(['deepseek-chat', 'deepseek-reasoner'])
  })
  const models = await useAI.getState().fetchModels('deepseek', draft)
  assert(models.length === 2 && models[0] === 'deepseek-chat', '返回模型列表')
  assert(listMock.__calls() === 1, '只请求 1 次')

  const failMock = mockFetch(() => errResponse(401, 'invalid key'))
  let authErr2 = false
  try {
    await useAI.getState().fetchModels('deepseek', draft)
  } catch (e) {
    authErr2 = e instanceof AIError && e.code === 'AUTH_FAILED'
  }
  assert(authErr2, 'Key 无效 → AUTH_FAILED')
  assert(failMock.__calls() === 1, '失败不重试')

  console.log('—— store.testConnection ——')
  let authErr3 = false
  try {
    await useAI.getState().testConnection('deepseek', { apiKey: '', model: 'm' })
  } catch (e) {
    authErr3 = e instanceof AIError && e.code === 'AUTH_FAILED'
  }
  assert(authErr3, '未填 Key → AUTH_FAILED')

  let modelErr2 = false
  try {
    await useAI.getState().testConnection('deepseek', { apiKey: 'k', model: '' })
  } catch (e) {
    modelErr2 = e instanceof AIError && e.code === 'MODEL_NOT_FOUND'
  }
  assert(modelErr2, '未选模型 → MODEL_NOT_FOUND')

  await clearAllStores()
  const chatMock = mockFetch((url) => {
    assert(url.endsWith('/chat/completions'), `请求 chat/completions（实际 ${url}）`)
    return okChat('pong')
  })
  const r = await useAI.getState().testConnection('deepseek', draft)
  assert(r.ok === true && r.message === '连接成功', '连通成功返回 ok')
  const records = await dbUsage.getAll()
  assert(records.length === 0, '测试连通不写入用量统计')
  assert(chatMock.__calls() === 1, '只请求 1 次')

  const failMock2 = mockFetch(() => errResponse(401, 'bad key'))
  let authErr4 = false
  try {
    await useAI.getState().testConnection('deepseek', draft)
  } catch (e) {
    authErr4 = e instanceof AIError && e.code === 'AUTH_FAILED'
  }
  assert(authErr4, 'Key 无效 → AUTH_FAILED')

  console.log('—— store：setProvider / clearProvider 持久化 ——')
  await clearAllStores()
  useAI.setState({ providers: { deepseek: { apiKey: '', model: '' }, qwen: { apiKey: '', model: '' }, openai: { apiKey: '', model: '' } }, defaultId: 'deepseek' })
  await useAI.getState().setProvider('deepseek', { apiKey: 'saved-key', model: 'deepseek-chat' }) // V4-F02：等待真实落库
  const saved = (await (await import('../src/db')).dbConfig.get('ai-config')) as {
    providers: Record<string, ProviderCfg>
  }
  assert(saved?.providers?.deepseek?.apiKey === 'saved-key', 'setProvider 持久化到 dbConfig')

  await useAI.getState().clearProvider('deepseek')
  const after = (await (await import('../src/db')).dbConfig.get('ai-config')) as {
    providers: Record<string, ProviderCfg>
  }
  assert(after?.providers?.deepseek?.apiKey === '', 'clearProvider 清空 Key 与模型')

  console.log('—— V4-F02：持久化失败回滚 + 抛错 ——')
  const db = await (await import('../src/db'))
  const origSet = db.dbConfig.set
  db.dbConfig.set = async () => {
    throw new Error('IndexedDB 写入失败')
  }
  let rollbackOk = false
  let threwMsg = ''
  try {
    await useAI.getState().setProvider('deepseek', { apiKey: 'should-not-persist', model: 'm' })
  } catch (e) {
    threwMsg = e instanceof Error ? e.message : ''
    // 内存状态必须回滚到本次失败前的值（上一次成功写入的 'saved-key' 已在上面 clearProvider 中被清空，故应为 ''）
    rollbackOk = useAI.getState().providers.deepseek.apiKey === ''
  }
  db.dbConfig.set = origSet
  assert(threwMsg.includes('无法写入本机存储'), `setProvider 失败时抛错误信息（实际: ${threwMsg}）`)
  assert(rollbackOk, 'setProvider 失败时内存状态回滚，不残留失败写入的 Key')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
