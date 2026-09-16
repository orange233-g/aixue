import type { ProviderAdapter } from '../types'
import type { CustomProviderMeta } from '../../types'
import { createOpenAICompatAdapter } from './openai-compatible'
import { PROVIDER_MANIFEST } from './manifest'

// 内联引入 logo（走 Vite 资源管线，避免 Capacitor 下相对路径在页面重挂时失效）
import deepseekLogo from '../../assets/providers/deepseek.svg'
import zhipuLogo from '../../assets/providers/zhipu.svg'
import hunyuanLogo from '../../assets/providers/hunyuan.svg'
import openaiLogo from '../../assets/providers/openai.svg'
import mimoLogo from '../../assets/providers/mimo.svg'
import volcLogo from '../../assets/providers/volc.svg'
import qwenLogo from '../../assets/providers/qwen.svg'
import kimiLogo from '../../assets/providers/kimi.svg'
import minimaxLogo from '../../assets/providers/minimax.svg'
import genericLogo from '../../assets/providers/generic.svg'

/** 厂商 logo 资源映射（新增内置厂商在此登记对应 logo） */
const LOGOS: Record<string, string> = {
  deepseek: deepseekLogo,
  zhipu: zhipuLogo,
  hunyuan: hunyuanLogo,
  openai: openaiLogo,
  mimo: mimoLogo,
  volc: volcLogo,
  qwen: qwenLogo,
  kimi: kimiLogo,
  minimax: minimaxLogo,
}

/** 预置厂商 id 集（不可被自定义注册覆盖/注销） */
const PRESET_IDS = new Set(PROVIDER_MANIFEST.map((p) => p.id))

/**
 * 厂商适配器注册表：预置厂商在模块加载时由 manifest 构造；自定义提供商（「添加自定义提供商」功能）
 * 运行时动态注册——全部走同一个 OpenAI 兼容工厂，仅 id/name/defaultBaseUrl 不同（见铁律：通用机制，不针对单一厂商）。
 */
const registry = new Map<string, ProviderAdapter>()
for (const p of PROVIDER_MANIFEST) {
  registry.set(p.id, createOpenAICompatAdapter({ id: p.id, name: p.name, defaultBaseUrl: p.defaultBaseUrl, auth: 'bearer' }))
}

/** 注册（或补注册）自定义提供商适配器；幂等，预置 id 忽略，已注册的同 id 不覆盖 */
export function registerCustomProvider(meta: CustomProviderMeta): void {
  if (!meta?.id || PRESET_IDS.has(meta.id) || registry.has(meta.id)) return
  registry.set(meta.id, createOpenAICompatAdapter({ id: meta.id, name: meta.name, defaultBaseUrl: meta.baseUrl, auth: 'bearer' }))
}

/** 注销自定义提供商适配器；预置 id 忽略 */
export function unregisterCustomProvider(id: string): void {
  if (!id || PRESET_IDS.has(id)) return
  registry.delete(id)
}

/** 预置 + 已注册自定义的完整厂商列表（补注册保证列表与持久化元信息自愈同步，如 HMR 后注册表被重置） */
export function listProviders(customs?: CustomProviderMeta[]): ProviderAdapter[] {
  for (const m of customs ?? []) registerCustomProvider(m)
  return [...registry.values()]
}

export function getAdapter(providerId: string): ProviderAdapter | undefined {
  return registry.get(providerId)
}

/** 是否预置厂商（自定义提供商的删除入口仅对非预置开放） */
export function isPresetProvider(providerId: string): boolean {
  return PRESET_IDS.has(providerId)
}

/** 某厂商的品牌 logo 图片路径（Vite 打包为稳定资源 URL，见 PRD 模型服务）；未登记的自定义提供商用通用兜底图 */
export function providerLogo(id: string): string {
  return LOGOS[id] ?? genericLogo
}

// ---- 兼容导出：既有消费方（默认配置构造等）只关心预置目录 ----
export const PROVIDERS: ProviderAdapter[] = PROVIDER_MANIFEST.map((p) =>
  createOpenAICompatAdapter({ id: p.id, name: p.name, defaultBaseUrl: p.defaultBaseUrl, auth: 'bearer' }),
)
