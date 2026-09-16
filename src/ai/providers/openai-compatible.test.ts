/**
 * 输出上限「默认不主动截断」逻辑回归测试（借鉴 Cherry Studio：未配置则不发送 max_tokens）。
 * 不联网、不真实调用模型：stub 全局 fetch，仅断言往上游发出的请求体是否带 max_tokens 键。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICompatAdapter } from './openai-compatible'
import type { ProviderCfg } from '../../types'
import type { ChatOptions } from '../types'

const adapter = createOpenAICompatAdapter({
  id: 'test-vendor',
  name: 'TestVendor',
  defaultBaseUrl: 'https://api.example.com',
  auth: 'bearer',
})

const fetchMock = vi.fn()

async function capturedBody(maxTokens: number | undefined): Promise<Record<string, unknown>> {
  const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' }
  const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module: 'chat', stream: false, maxTokens }
  await adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const init = fetchMock.mock.calls[0][1] as { body?: string }
  expect(init?.body).toBeTruthy()
  return JSON.parse(init!.body!)
}

describe('openai-compatible 输出上限逻辑', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    // 模拟上游正常返回：非流式、finish_reason=stop，无 content
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', finish_reason: 'stop' } }], usage: {} }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('未配置 maxTokens 时，请求体不发送 max_tokens 字段（交服务端自然输出，避免静默截断）', async () => {
    const body = await capturedBody(undefined)
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('配置了 maxTokens 时，请求体按该值发送 max_tokens（受限场景仍可约束输出）', async () => {
    const body = await capturedBody(300)
    expect(body.max_tokens).toBe(300)
  })
})

describe('openai-compatible 单次调用关思考（noThink，通用机制不绑厂商）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', finish_reason: 'stop' } }], usage: {} }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('noThink: true 时携带 thinking disabled（即使用户未开 disableThinking）', async () => {
    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' }
    const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module: 'intent', noThink: true }
    await adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)
    const init = fetchMock.mock.calls[0][1] as { body?: string }
    expect(JSON.parse(init!.body!).thinking).toEqual({ type: 'disabled' })
  })

  it('未传 noThink 的普通 chat 模块不携带 thinking（遵循用户开关）', async () => {
    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' }
    const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module: 'chat' }
    await adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)
    const init = fetchMock.mock.calls[0][1] as { body?: string }
    expect(JSON.parse(init!.body!)).not.toHaveProperty('thinking')
  })
})

describe('openai-compatible 思考降级重试（始终思考模型不支持关闭思考）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('带 thinking 请求被「不支持关闭思考」类错误拒绝时，自动去掉 thinking 参数重试一次并成功', async () => {
    // 第一次：模拟 GLM flash 系报错（thinking disabled 被拒）
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: '该模型始终思考，不支持关闭思考，请使用 low、high 或 max。' } }),
    } as Response)
    // 第二次（去 thinking 重试）：正常返回
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok', finish_reason: 'stop' } }], usage: {} }),
    } as Response)

    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', disableThinking: true }
    const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module: 'chat', stream: false }
    const out = await adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body1 = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    const body2 = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)
    expect(body1.thinking).toEqual({ type: 'disabled' }) // 首次按用户配置携带
    expect(body2).not.toHaveProperty('thinking') // 重试时已剥离
    expect(out.content).toBe('ok')
  })

  it('非 thinking 类错误不触发降级重试（只发一次请求，直接抛错）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    } as Response)

    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', disableThinking: true }
    const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module: 'chat', stream: false }
    await expect(adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('未开启关闭思考时不携带 thinking 字段，失败也不触发降级', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'boom' } }),
    } as Response)

    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' }
    const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module: 'chat', stream: false }
    await expect(adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body).not.toHaveProperty('thinking')
  })
})

describe('openai-compatible 生题场景思考开关（module=generate 独立于聊天配置）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    // 模拟上游正常返回
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', finish_reason: 'stop' } }], usage: {} }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  async function bodyOf(module: string, cfg: ProviderCfg): Promise<Record<string, unknown>> {
    const opts: ChatOptions = { providerId: 'test-vendor', model: 'm', module, stream: false }
    await adapter.chat([{ role: 'user', content: 'hi' }], cfg, opts)
    const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as { body?: string }
    return JSON.parse(init!.body!)
  }

  it('generate 模块：未配置 genDisableThinking 时默认启用（带 thinking disabled）——时延敏感场景缺省提速', async () => {
    const body = await bodyOf('generate', { baseUrl: '', apiKey: 'k', model: 'm' })
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('generate 模块：显式 genDisableThinking=false 时不携带 thinking（尊重用户关闭）', async () => {
    const body = await bodyOf('generate', { baseUrl: '', apiKey: 'k', model: 'm', genDisableThinking: false })
    expect(body).not.toHaveProperty('thinking')
  })

  it('chat 模块不受 genDisableThinking 影响：仍遵循 disableThinking 开关', async () => {
    const on = await bodyOf('chat', { baseUrl: '', apiKey: 'k', model: 'm', disableThinking: true, genDisableThinking: false })
    expect(on.thinking).toEqual({ type: 'disabled' })
    const off = await bodyOf('chat', { baseUrl: '', apiKey: 'k', model: 'm', genDisableThinking: true })
    expect(off).not.toHaveProperty('thinking')
  })
})

/** 构造一个挂起的 SSE 流：先推入给定 chunk 后保持挂起（不 close），模拟模型思考中/上游断流前的等待 */
function pendingSSE(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      // 不 close：read() 挂起等下一 chunk
    },
  })
}

describe('BUG-4：流式中断不得被当成正常结束（停止/超时/断流吞没根因）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('abort 后必须抛 AbortError，而不是把半截内容当成功返回（修复前 reader.cancel→done→break 静默返回）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: pendingSSE([
        'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n',
      ]),
    } as unknown as Response)
    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' }
    const ac = new AbortController()
    const onToken = vi.fn()
    const p = adapter.chat([{ role: 'user', content: 'hi' }], cfg, {
      providerId: 'test-vendor',
      model: 'm',
      module: 'chat',
      stream: true,
      signal: ac.signal,
      onToken,
    })
    // 等流开始消费（首个 token 到达），再模拟用户点停止
    await vi.waitFor(() => expect(onToken).toHaveBeenCalled())
    ac.abort()
    await expect(p).rejects.toThrow()
    await p.catch((e: unknown) => {
      const name = (e as { name?: string }).name
      const msg = e instanceof Error ? e.message : ''
      expect(name === 'AbortError' || msg === 'aborted').toBe(true)
    })
  })

  it('未中断时流正常结束返回完整内容（不回归）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"完整内容"}}]}\n\n'))
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
    } as unknown as Response)
    const cfg: ProviderCfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' }
    const r = await adapter.chat([{ role: 'user', content: 'hi' }], cfg, {
      providerId: 'test-vendor',
      model: 'm',
      module: 'chat',
      stream: true,
    })
    expect(r.content).toBe('完整内容')
    expect(r.finishReason).toBe('stop')
  })
})