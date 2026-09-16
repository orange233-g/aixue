import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderCfg } from '../types'
import { clearAllStores, dbConfig, resetDB } from '../db'
import { getAdapter } from '../ai/providers'
import { useAI } from './useAIStore'

function resetStore() {
  useAI.setState({
    providers: { deepseek: { apiKey: '', model: '' } as ProviderCfg },
    defaultId: 'deepseek',
    loaded: true,
    customProviders: undefined,
  })
}

beforeEach(async () => {
  resetDB()
  await clearAllStores()
  resetStore()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('V4-F02：API Key 保存/清除等待真实 IndexedDB 结果', () => {
  it('setProvider resolve 前已把最新配置写入 dbConfig（非 fire-and-forget）', async () => {
    const spy = vi.spyOn(dbConfig, 'set')
    await useAI.getState().setProvider('deepseek', { apiKey: 'sk-saved', model: 'deepseek-chat' })
    expect(spy).toHaveBeenCalledTimes(1)
    const saved = (await dbConfig.get('ai-config')) as { providers: Record<string, ProviderCfg> }
    expect(saved.providers.deepseek.apiKey).toBe('sk-saved')
  })

  it('setProvider 落库失败时回滚内存状态并抛错', async () => {
    vi.spyOn(dbConfig, 'set').mockRejectedValueOnce(new Error('IndexedDB 写入失败'))
    await expect(useAI.getState().setProvider('deepseek', { apiKey: 'should-rollback', model: 'm' }))
      .rejects.toThrow(/无法写入本机存储/)
    expect(useAI.getState().providers.deepseek.apiKey).toBe('') // 不残留失败写入的 Key
  })

  it('clearProvider 落库失败时回滚，不清空内存中的 Key', async () => {
    await useAI.getState().setProvider('deepseek', { apiKey: 'sk-keep', model: 'm' })
    vi.spyOn(dbConfig, 'set').mockRejectedValueOnce(new Error('IndexedDB 写入失败'))
    await expect(useAI.getState().clearProvider('deepseek'))
      .rejects.toThrow(/无法写入本机存储/)
    expect(useAI.getState().providers.deepseek.apiKey).toBe('sk-keep') // 清除失败必须保留原 Key
  })

  it('setDefault 落库失败时回滚默认厂商并抛错', async () => {
    vi.spyOn(dbConfig, 'set').mockRejectedValueOnce(new Error('IndexedDB 写入失败'))
    await expect(useAI.getState().setDefault('qwen')).rejects.toThrow(/无法写入本机存储/)
    expect(useAI.getState().defaultId).toBe('deepseek') // 失败后仍是原默认
  })
})

describe('自定义提供商：添加/删除（注册适配器 + 落库元信息）', () => {
  it('addCustomProvider：注册适配器、清库可回读元信息与空 ProviderCfg；setProvider 保留 customProviders', async () => {
    const meta = await useAI.getState().addCustomProvider('测试中转', 'https://api.example.com/v1')
    expect(meta.id).toMatch(/^cp_/)
    expect(getAdapter(meta.id)).toBeDefined()
    const saved = (await dbConfig.get('ai-config')) as { customProviders?: { id: string; name: string; baseUrl: string }[]; providers: Record<string, ProviderCfg> }
    expect(saved.customProviders).toHaveLength(1)
    expect(saved.customProviders![0].name).toBe('测试中转')
    expect(saved.providers[meta.id]).toEqual({ apiKey: '', model: '' })
    // 关键回归：其他厂商保存配置时不得丢掉 customProviders 字段（落库为重建对象）
    await useAI.getState().setProvider('deepseek', { apiKey: 'sk-x', model: 'm' })
    const saved2 = (await dbConfig.get('ai-config')) as { customProviders?: unknown[] }
    expect(saved2.customProviders).toHaveLength(1)
    await useAI.getState().removeCustomProvider(meta.id)
  })

  it('removeCustomProvider：注销适配器、清 ProviderCfg；删除默认厂商时回退预置', async () => {
    const meta = await useAI.getState().addCustomProvider('要删的', 'https://api.example.com/v1')
    await useAI.getState().setProvider(meta.id, { apiKey: 'sk-del', model: 'm1' })
    await useAI.getState().setDefault(meta.id)
    expect(useAI.getState().defaultId).toBe(meta.id)
    await useAI.getState().removeCustomProvider(meta.id)
    expect(getAdapter(meta.id)).toBeUndefined()
    expect(useAI.getState().providers[meta.id]).toBeUndefined()
    expect(useAI.getState().defaultId).toBe('deepseek')
    const saved = (await dbConfig.get('ai-config')) as { customProviders?: unknown[] }
    expect(saved.customProviders ?? []).toHaveLength(0)
  })

  it('addCustomProvider 落库失败时回滚（元信息/ProviderCfg/适配器注册）', async () => {
    vi.spyOn(dbConfig, 'set').mockRejectedValueOnce(new Error('IndexedDB 写入失败'))
    await expect(useAI.getState().addCustomProvider('失败的', 'https://api.example.com/v1')).rejects.toThrow(/无法写入本机存储/)
    expect(useAI.getState().customProviders ?? []).toHaveLength(0)
    expect(Object.keys(useAI.getState().providers).some((k) => k.startsWith('cp_'))).toBe(false)
  })

  it('load：从 IndexedDB 恢复 customProviders 并重新注册适配器', async () => {
    const meta = await useAI.getState().addCustomProvider('重启前', 'https://api.example.com/v1')
    // 模拟重启：清内存（注册表保留不影响——用未注册的新 id 验证 load 恢复路径）
    const saved = (await dbConfig.get('ai-config')) as Record<string, unknown>
    useAI.setState({ providers: { deepseek: { apiKey: '', model: '' } }, defaultId: 'deepseek', loaded: false, customProviders: undefined })
    await useAI.getState().load()
    expect(useAI.getState().customProviders).toHaveLength(1)
    expect(useAI.getState().customProviders![0].name).toBe('重启前')
    expect(getAdapter(meta.id)).toBeDefined()
    expect(saved).toBeTruthy()
  })
})