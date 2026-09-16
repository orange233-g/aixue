import { create } from 'zustand'
import type { AIConfig, CustomProviderMeta, ProviderCfg } from '../types'
import { PROVIDERS, getAdapter, registerCustomProvider, unregisterCustomProvider } from '../ai/providers'
import { AIError } from '../ai/types'
import { withTimeoutSignal } from '../ai/timeout'
import { dbConfig } from '../db'
import { log } from '../utils/log'
import { uid } from '../utils'

const CONFIG_KEY = 'ai-config'

/** I-03：直连调用（fetchModels/testConnection）统一超时，防网络悬挂长期 loading */
const LIST_MODELS_TIMEOUT = 15_000
const TEST_CONN_TIMEOUT = 20_000

function defaultConfig(): AIConfig {
  const providers: Record<string, ProviderCfg> = {}
  for (const p of PROVIDERS) {
    providers[p.id] = { apiKey: '', model: '' }
  }
  return { providers, defaultId: PROVIDERS[0].id }
}

/** 厂商是否已配置可用（API Key + 模型齐全） */
export function isProviderReady(p?: ProviderCfg): boolean {
  return !!p?.apiKey?.trim() && !!p?.model
}

/**
 * 实际生效的默认厂商：defaultId 优先调用；其未配置时回退到第一个已配置厂商。
 * 「默认」是优先级而非绑定——避免 DeepSeek 等 PROVIDERS[0] 未填 Key 却挡住已配置厂商的调用。
 */
export function resolveActiveId(providers: Record<string, ProviderCfg>, defaultId: string): string {
  if (isProviderReady(providers[defaultId])) return defaultId
  return Object.keys(providers).find((id) => isProviderReady(providers[id])) ?? defaultId
}

interface AIStore extends AIConfig {
  loaded: boolean
  load: () => Promise<void>
  /** V4-F02：返回 Promise，等待 IndexedDB 落库成功才 resolve；失败回滚内存状态并 reject（调用方据此提示错误而非「已保存」） */
  setProvider: (id: string, patch: Partial<ProviderCfg>) => Promise<void>
  setDefault: (id: string) => Promise<void>
  clearProvider: (id: string) => Promise<void>
  /** 添加自定义提供商：注册适配器 + 落库元信息；返回新元信息（含生成的 id） */
  addCustomProvider: (name: string, baseUrl: string) => Promise<CustomProviderMeta>
  /** 删除自定义提供商：注销适配器 + 清掉其 ProviderCfg + 落库；预置厂商忽略 */
  removeCustomProvider: (id: string) => Promise<void>
  /** 实际生效的默认厂商 id（默认未配置时回退到第一个已配置厂商，见 resolveActiveId） */
  getActiveId: () => string
  /** 拉取模型列表（可传草稿配置；未配 Key 抛 AUTH_FAILED）。signal 供设置页取消/卸载时中断 */
  fetchModels: (id: string, cfg?: ProviderCfg, signal?: AbortSignal) => Promise<string[]>
  /** 测试连通（可传草稿配置；不写入用量统计） */
  testConnection: (id: string, cfg?: ProviderCfg, signal?: AbortSignal) => Promise<{ ok: boolean; message: string }>
}

export const useAI = create<AIStore>((set, get) => ({
  ...defaultConfig(),
  loaded: false,

  async load() {
    const saved = (await dbConfig.get(CONFIG_KEY)) as AIConfig | undefined
    if (saved) {
      // 兼容迁移：旧版逐模型「prices」数组已废弃 → 移除；单份「price」是用户数据，一律保留。
      // 仅当存在遗留 prices 或从未跑过迁移标记时才落盘，幂等不误清用户手填价。
      const providers: Record<string, ProviderCfg> = {}
      let changed = false
      for (const [id, p] of Object.entries(saved.providers)) {
        if (!p) continue
        if ('prices' in (p as ProviderCfg & { prices?: unknown })) {
          const { prices: _ps, ...rest } = p as ProviderCfg & { prices?: unknown }
          providers[id] = rest
          changed = true
        } else {
          providers[id] = p
        }
      }
      if (changed || !saved.pricesCleared) {
        const migrated: AIConfig = { ...saved, providers, pricesCleared: true }
        for (const m of migrated.customProviders ?? []) registerCustomProvider(m)
        set({ ...migrated, loaded: true })
        dbConfig.set(CONFIG_KEY, migrated)
      } else {
        for (const m of saved.customProviders ?? []) registerCustomProvider(m)
        set({ ...saved, loaded: true })
      }
    } else {
      set({ loaded: true })
    }
  },

  async setProvider(id, patch) {
    const prevAll = get().providers
    const providers = { ...prevAll, [id]: { ...prevAll[id], ...patch } }
    set({ providers })
    const cfg = { providers, defaultId: get().defaultId, pricesCleared: true, customProviders: get().customProviders }
    try {
      // V4-F02：必须等待 IndexedDB 写入结果再提示成功；失败回滚内存并抛错，杜绝「界面成功、落库失败」
      await dbConfig.set(CONFIG_KEY, cfg)
    } catch (e) {
      set({ providers: prevAll })
      log('error', 'ai', `持久化厂商配置 ${id} 失败`, { provider: id, err: e instanceof Error ? e.message : String(e) })
      throw new Error(`保存失败：无法写入本机存储（${e instanceof Error ? e.message : '未知错误'}）`)
    }
    // 关键配置变更落日志：换模型/换 Key 是最常排查的改动点（仅在确认落库成功后再记）
    const keys = Object.keys(patch)
    if (keys.some((k) => ['model', 'apiKey', 'baseUrl'].includes(k))) {
      log('info', 'ui', `配置厂商 ${id}：${keys.filter((k) => ['model', 'apiKey', 'baseUrl'].includes(k)).join(', ')}`, {
        provider: id,
        model: patch.model ?? prevAll[id]?.model,
        hasKey: !!((patch.apiKey ?? prevAll[id]?.apiKey)), baseUrl: patch.baseUrl ?? prevAll[id]?.baseUrl,
      })
    }
  },

  async setDefault(id) {
      const prev = get().defaultId
      if (prev === id) return
      log('info', 'ui', `切换默认厂商 ${prev} → ${id}`, { from: prev, to: id })
      set({ defaultId: id })
      try {
        // V4-F02：等待落库，失败回滚默认厂商并抛错
        await dbConfig.set(CONFIG_KEY, { providers: get().providers, defaultId: id, pricesCleared: true, customProviders: get().customProviders })
      } catch (e) {
        set({ defaultId: prev })
        log('error', 'ai', `持久化默认厂商失败`, { from: prev, to: id, err: e instanceof Error ? e.message : String(e) })
        throw new Error(`保存失败：无法写入本机存储（${e instanceof Error ? e.message : '未知错误'}）`)
      }
    },

  async clearProvider(id) {
    if (!get().providers[id]) return
    log('info', 'ui', `清空厂商配置 ${id}`, { provider: id })
    const prevAll = get().providers
    const providers = { ...prevAll, [id]: { apiKey: '', model: '' } }
    set({ providers })
    try {
      // V4-F02：Key 清除属于安全操作，必须等待真实 IndexedDB 结果而非 fire-and-forget
      await dbConfig.set(CONFIG_KEY, { providers, defaultId: get().defaultId, pricesCleared: true, customProviders: get().customProviders })
    } catch (e) {
      set({ providers: prevAll })
      log('error', 'ai', `清除厂商配置失败`, { provider: id, err: e instanceof Error ? e.message : String(e) })
      throw new Error(`清除失败：无法写入本机存储（${e instanceof Error ? e.message : '未知错误'}）`)
    }
  },

  getActiveId() {
    return resolveActiveId(get().providers, get().defaultId)
  },

  async addCustomProvider(name, baseUrl) {
    const meta: CustomProviderMeta = { id: uid('cp_'), name: name.trim(), baseUrl }
    const prevCustoms = get().customProviders
    const prevProviders = get().providers
    const customProviders = [...(prevCustoms ?? []), meta]
    // 预置空的 ProviderCfg，使自定义厂商与其他厂商在配置字典里完全同构
    set({ customProviders, providers: { ...prevProviders, [meta.id]: { apiKey: '', model: '' } } })
    registerCustomProvider(meta)
    try {
      await dbConfig.set(CONFIG_KEY, {
        providers: get().providers,
        defaultId: get().defaultId,
        pricesCleared: true,
        customProviders,
      })
      log('info', 'ui', `添加自定义提供商 ${meta.name}`, { provider: meta.id, baseUrl: meta.baseUrl })
      return meta
    } catch (e) {
      // 失败回滚：内存元信息/配置字典 + 适配器注册表
      set({ customProviders: prevCustoms, providers: prevProviders })
      unregisterCustomProvider(meta.id)
      log('error', 'ai', `添加自定义提供商失败`, { name: meta.name, err: e instanceof Error ? e.message : String(e) })
      throw new Error(`添加失败：无法写入本机存储（${e instanceof Error ? e.message : '未知错误'}）`)
    }
  },

  async removeCustomProvider(id) {
    const customs = get().customProviders ?? []
    const meta = customs.find((m) => m.id === id)
    if (!meta) return // 非自定义（预置/不存在）忽略
    const prevCustoms = customs
    const prevProviders = get().providers
    const prevDefault = get().defaultId
    const providers = { ...prevProviders }
    delete providers[id]
    const customProviders = customs.filter((m) => m.id !== id)
    // 删除的是默认厂商时回退到第一个预置厂商（resolveActiveId 会在其未配置时自动回退已配置厂商）
    const defaultId = prevDefault === id ? PROVIDERS[0].id : prevDefault
    set({ customProviders, providers, defaultId })
    unregisterCustomProvider(id)
    try {
      await dbConfig.set(CONFIG_KEY, { providers, defaultId, pricesCleared: true, customProviders })
      log('info', 'ui', `删除自定义提供商 ${meta.name}`, { provider: id })
    } catch (e) {
      // 失败回滚：内存元信息/配置字典/默认厂商 + 适配器注册表
      set({ customProviders: prevCustoms, providers: prevProviders, defaultId: prevDefault })
      registerCustomProvider(meta)
      log('error', 'ai', `删除自定义提供商失败`, { provider: id, err: e instanceof Error ? e.message : String(e) })
      throw new Error(`删除失败：无法写入本机存储（${e instanceof Error ? e.message : '未知错误'}）`)
    }
  },

  async fetchModels(id, cfg, extSignal) {
    const adapter = getAdapter(id)
    const c = cfg ?? get().providers[id]
    if (!adapter) throw new AIError('MODEL_NOT_FOUND', `未知厂商: ${id}`)
    if (!c?.apiKey) throw new AIError('AUTH_FAILED', '请先填写 API Key')
    // I-03/V2-I04：统一走 withTimeoutSignal（合并外部取消信号 + 超时），设置页可主动取消/卸载中断
    const handle = withTimeoutSignal(extSignal, LIST_MODELS_TIMEOUT)
    try {
      return await adapter.listModels(c, { signal: handle.signal, timeoutMs: LIST_MODELS_TIMEOUT })
    } catch (e) {
      if (handle.timedOut()) throw new AIError('TIMEOUT', '获取模型列表超时')
      throw e
    } finally {
      handle.cleanup()
    }
  },

  async testConnection(id, cfg, extSignal) {
    const adapter = getAdapter(id)
    const c = cfg ?? get().providers[id]
    if (!adapter) throw new AIError('MODEL_NOT_FOUND', `未知厂商: ${id}`)
    if (!c?.apiKey) throw new AIError('AUTH_FAILED', '请先填写 API Key')
    if (!c.model) throw new AIError('MODEL_NOT_FOUND', '请先选择模型')
    // I-03/V2-I04：合并外部取消信号 + 超时（不写入用量统计，故不经网关）
    const handle = withTimeoutSignal(extSignal, TEST_CONN_TIMEOUT)
    try {
      await adapter.chat([{ role: 'user', content: 'ping' }], c, {
        providerId: id,
        model: c.model,
        module: 'test',
        signal: handle.signal,
      })
      return { ok: true, message: '连接成功' }
    } catch (e) {
      if (handle.timedOut()) throw new AIError('TIMEOUT', '连接测试超时')
      throw e
    } finally {
      handle.cleanup()
    }
  },
}))
