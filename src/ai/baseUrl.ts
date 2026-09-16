import { AIError } from './types'

/**
 * 统一自定义 baseUrl 安全归一化（V2-I03 / V2-S07）：
 * - 生产环境只允许 https:；开发环境额外放行本机回环 http（http://localhost / 127.0.0.1），
 *   避免把长期 API Key 发往明文不安全的第三方链路。
 * - 去除尾斜杠，避免与下游 `${baseUrl}/path` 拼出双斜杠。
 * - 禁止非 http(s) 协议、URL 内嵌用户名/密码、fragment。
 * - 空字符串视为「未填写」，返回空串，交由调用方回退默认 baseUrl。
 * 保存与真实请求前都应经过本函数校验（单一入口，防止某条链路漏校验）。
 */
export function normalizeProviderBaseUrl(raw: string | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return ''

  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new AIError('NETWORK', `API 地址「${s}」不是合法 URL`)
  }

  if (u.username || u.password) {
    throw new AIError('NETWORK', 'API 地址不能包含用户名/密码')
  }

  if (isReservedTestHost(u.hostname)) {
    throw new AIError('NETWORK', 'API 地址不能使用保留测试域名')
  }

  if (u.protocol === 'http:') {
    // 明文链路：仅开发环境 + 本机回环允许（本地代理不打真实长期 Key 之外的不安全目标）
    if (!import.meta.env.DEV || !isLoopback(u.hostname)) {
      throw new AIError('NETWORK', '生产环境仅允许 https 接口，避免明文发送 API Key')
    }
  } else if (u.protocol !== 'https:') {
    throw new AIError('NETWORK', 'API 地址仅支持 http(s) 协议')
  }

  u.hash = ''
  return u.toString().replace(/\/+$/, '')
}

/** 是否本机回环：localhost / 127.0.0.1 / ::1 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/** RFC 6761 保留测试域名不可能成为真实 API 目标。 */
function isReservedTestHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return h === 'invalid' || h.endsWith('.invalid')
}

/**
 * 解析自定义 baseUrl 的目标 origin（用于保存/切换时向用户展示「Key 将发送到哪」），
 * 非法或为空时返回 null。不抛错，便于 UI 直接展示提示。
 */
export function resolveBaseUrlOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/**
 * V4-I01：判定用户填的 baseUrl 是否为「预置之外的自定义 host」。
 * 预置 = provider.defaultBaseUrl 的 host ∪ provider.allowedHosts；
 * 在该集合内视为厂商官方/合法别名（不弹「Key 将发送到自定义地址」二次确认），
 * 在集合外视为用户自定义中转/反向代理（需要用户确认）。
 * 协议无关（http/https 一视同仁）；生产 https 校验由 normalizeProviderBaseUrl 独立把关。
 */
export function isCustomProviderHost(
  baseUrl: string,
  provider: { defaultBaseUrl: string; allowedHosts?: readonly string[] },
): boolean {
  const userOrigin = resolveBaseUrlOrigin(baseUrl)
  if (!userOrigin) return false
  const stripProto = (o: string) => o.replace(/^https?:\/\//, '')
  const userHost = stripProto(userOrigin)
  const allowed = new Set<string>(provider.allowedHosts ?? [])
  const defOrigin = resolveBaseUrlOrigin(provider.defaultBaseUrl)
  if (defOrigin) allowed.add(stripProto(defOrigin))
  return !allowed.has(userHost)
}
