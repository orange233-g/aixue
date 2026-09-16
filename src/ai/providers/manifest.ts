/**
 * 预置厂商清单（V2-I06 单源）。纯数据模块，不依赖 React/SVG/适配器/浏览器 API，
 * 供两处共用同一来源，避免改厂商时 vite 白名单与前端目录脱节：
 * - 前端：src/ai/providers/index.ts 据此构造 ProviderAdapter；
 * - 开发代理：vite.config.ts 据此推导网关 host 白名单。
 */
export interface ProviderManifestItem {
  id: string
  name: string
  defaultBaseUrl: string
  /** V4-I01：官方已知网关的显式精确 host 清单（含默认地址之外的区域/国际版别名，如 MiMo 的历史网关） */
  allowedHosts?: string[]
}

export const PROVIDER_MANIFEST: ProviderManifestItem[] = [
  { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'zhipu', name: '智谱 AI', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'hunyuan', name: '腾讯混元', defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', allowedHosts: ['api.tencentcloudapi.com', 'hunyuan.tencentcloudapi.com'] },
  { id: 'kimi', name: 'Kimi', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'minimax', name: 'MiniMax', defaultBaseUrl: 'https://api.minimaxi.com/v1' },
  { id: 'openai', name: 'OpenAI 兼容', defaultBaseUrl: 'https://api.openai.com/v1' },
  // V4-I01：MiMo 历史上按模型不同走相隔网关，token-plan-cn.xiaomimimo.com 为踩坑记录确认过的域名，
  // 精确登记避免开发代理 403 回归（不恢复宽泛子域匹配）
  { id: 'mimo', name: '小米 MiMo', defaultBaseUrl: 'https://api.xiaomimimo.com/v1', allowedHosts: ['token-plan-cn.xiaomimimo.com', 'api.xiaomimimo.com'] },
  { id: 'volc', name: '火山方舟', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'qwen', name: '通义千问', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
]

/**
 * 已知厂商网关「host 精确白名单」。
 * 由各 defaultBaseUrl 的完整 hostname（如 dashscope.aliyuncs.com）推导，并合并显式 allowedHosts；
 * V4-I01：合法别名不靠猜，由厂商在 manifest 精确登记（含挑战踩坑记录里的 MiMo token-plan-cn.xiaomimimo.com）。
 * V3-S02：只做「host === 白名单项」的精确匹配，不再用末两段域后缀匹配（endsWith），
 * 避免把同域内的任意不可控子域（如 attacker.evil.example.com）一并放行，收窄代理目标边界。
 */
export function providerHostSuffixes(): string[] {
  const set = new Set<string>()
  for (const { defaultBaseUrl, allowedHosts } of PROVIDER_MANIFEST) {
    try {
      const host = new URL(defaultBaseUrl).hostname.toLowerCase()
      if (host) set.add(host)
    } catch {
      // 忽略无法解析的条目；manifest 为常量，正常不会走到
    }
    for (const extra of allowedHosts ?? []) {
      if (extra) set.add(extra.toLowerCase())
    }
  }
  return [...set]
}