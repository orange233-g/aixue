/**
 * I-01 回归测试：一旦某次 attempt 已产出 token，网关禁止透明重试，
 * 由业务层「继续/重试」，避免流式输出拼接两次响应（聊天重复段落 / 生题残块）。
 * 不联网：mock getAdapter 与 dbUsage。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, setRetryBaseDelay } from './gateway'
import type { ProviderAdapter, ChatOptions } from './types'
import type { AIConfig, ProviderCfg } from '../types'

vi.mock('./providers', () => ({ getAdapter: vi.fn() }))
vi.mock('../db', () => ({ dbUsage: { add: vi.fn() } }))
vi.mock('./usage/cost', async (orig) => ({
  ...(await orig<typeof import('./usage/cost')>()),
  estimateCost: () => 0,
}))

const { getAdapter } = await import('./providers')

function cfg(apiKey = 'k'): AIConfig {
  return { defaultId: 't', providers: { t: { apiKey, model: 'm' } as ProviderCfg } }
}

describe('I-01 流式重试策略', () => {
  let adapter: ProviderAdapter
  beforeEach(() => {
    setRetryBaseDelay(1)
    adapter = {
      id: 't',
      name: 'T',
      defaultBaseUrl: 'https://x',
      auth: 'bearer',
      listModels: async () => [],
      chat: async () => {
        throw new Error('unexpected')
      },
    }
    vi.mocked(getAdapter).mockReturnValue(adapter)
  })
  afterEach(() => vi.clearAllMocks())

  it('已产出 token 后网络错误：不再透明重试，直接抛错（避免流输出拼接两次）', async () => {
    let calls = 0
    adapter.chat = async (_m, _unused, o: ChatOptions) => {
      calls++
      if (calls === 1) o.onToken?.('abc', '') // 模拟首轮已流式输出一段增量
      throw new Error('disconnected')
    }
    await expect(
      chat([{ role: 'user', content: 'hi' }], { providerId: 't', model: 'm', module: 'test', onToken: () => {} }, cfg()),
    ).rejects.toThrow()
    expect(calls).toBe(1) // 已输出 token → 只发起第一次请求，绝不第 2 次重试
  })

  it('未产出 token 的网络错误仍按最大重试次数重试（不误伤可自愈场景）', async () => {
    let netCalls = 0
    adapter.chat = async () => {
      netCalls++
      if (netCalls <= 1) throw new Error('flaky network')
      return { content: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheMissTokens: 0 }, providerId: 't', model: 'm' }
    }
    const result = await chat([{ role: 'user', content: 'hi' }], { providerId: 't', model: 'm', module: 'test' }, cfg())
    expect(result.content).toBe('ok')
    expect(netCalls).toBe(2) // NETWORK 最大重试 1 次 → 第 2 次成功
  })
})