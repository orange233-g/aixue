/**
 * AI 请求统一包装（所有厂商适配器的网络请求都走这里，见项目铁律：不针对单一厂商写死）。
 *
 * 背景：浏览器直连各家模型 API 会触发 CORS 预检，多数厂商（如火山方舟）不返回允许的 CORS 头，
 * 导致浏览器 fetch 报 "Failed to fetch"。因此：
 * - 开发环境（import.meta.env.DEV）对跨域目标改走本机同源代理 /__ai（见 vite.config.ts），
 *   由 dev server 转发到上游，规避浏览器 CORS 拦截；生产（Capacitor 原生 WebView）无 CORS 限制，直连。
 * - 代理按字节流透传，SSE 分片可实时回传，生题的流式进度不受影响。
 */

export interface AIFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

const isDev = () => typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

/** 当前页面源（origin），供代理判断与 /__ai 拼接。Worker 内 location.origin 不可用，故统一走当前全局源 */
function currentOrigin(): string {
  // Worker 环境下通过 self.location 取；主线程走 window.location
  // 两者 origin 均代表「应用所在源」，与 AI 上游（跨域）区分，作为同源代理的目标
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  // Worker 环境下 self.location.origin 存在（WorkerGlobalScope），与主线程通语义
  if (typeof self !== 'undefined' && self.location?.origin) return self.location.origin
  return ''
}

/** URL 是否为 http(s) 且与当前页面跨域（跨域才需要代理，同源直连；非 http 协议视为不可代理） */
function needsProxy(url: string): boolean {
  if (!isDev()) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const origin = currentOrigin()
  return origin !== '' && u.origin !== origin
}

/**
 * 发起一次 AI 上游请求。返回的 Response 与直接 fetch 上游语义一致（含 status/headers/body 流），
 * 因此调用方无需感知是否走了代理。
 * 用 `import.meta.env.DEV && …` 编译期短路：生产构建 DEV 被 define 为 false，整个代理分支（含 /__ai
 * 路径字面量）被 dead-code 消除，不会打进生产包。needsProxy 内的 isDev() 运行时守卫仅作兜底。
 */
export async function aiFetch(url: string, init: AIFetchInit = {}): Promise<Response> {
  if (import.meta.env.DEV && needsProxy(url)) {
    return fetch(`${currentOrigin()}/__ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: init.method ?? 'GET',
        url,
        headers: init.headers ?? {},
        // undefined 会自然被 JSON.stringify 丢弃，代理据此决定是否带 body
        body: init.body,
      }),
      signal: init.signal,
    })
  }
  return fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })
}