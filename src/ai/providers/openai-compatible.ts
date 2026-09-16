import type { ProviderAdapter, ChatMessage, ChatOptions, ChatResult, ChatUsage } from '../types'
import { AIError } from '../types'
import type { ProviderCfg } from '../../types'
import { aiFetch } from '../requests'
import { normalizeProviderBaseUrl } from '../baseUrl'

/** 请求前归一化并校验 baseUrl（V2-I03/S07）：校验失败抛错，fail-closed，避免明文或非法目标 */
function baseUrlOf(cfg: ProviderCfg, defaultBaseUrl: string): string {
  return normalizeProviderBaseUrl(cfg.baseUrl) || defaultBaseUrl
}

/**
 * OpenAI 兼容适配器工厂：通义千问、OpenAI、自定义 baseUrl 均走此实现。
 * 差异仅体现在 baseUrl / 鉴权方式 / 模型名，由参数注入。
 */
export function createOpenAICompatAdapter(opts: {
  id: string
  name: string
  defaultBaseUrl: string
  auth: 'bearer' | 'api-key'
}): ProviderAdapter {
  return {
    id: opts.id,
    name: opts.name,
    defaultBaseUrl: opts.defaultBaseUrl,
    auth: opts.auth,

    async listModels(cfg: ProviderCfg, req2?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string[]> {
      const baseUrl = baseUrlOf(cfg, opts.defaultBaseUrl)
      const headers: Record<string, string> = {}
      if (opts.auth === 'bearer') headers.Authorization = `Bearer ${cfg.apiKey}`
      else headers['api-key'] = cfg.apiKey
      // I-03：listModels 统一支持取消与超时（timeout 由 aiFetch 外层控制器触发 abort）
      const res = await aiFetch(`${baseUrl}/models`, { headers, signal: req2?.signal })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw mapError(res.status, err)
      }
      const data = await res.json()
      return (data.data || []).map((m: { id: string }) => m.id)
    },

    async chat(messages: ChatMessage[], cfg: ProviderCfg, opts2: ChatOptions): Promise<ChatResult> {
      const baseUrl = baseUrlOf(cfg, opts.defaultBaseUrl)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (opts.auth === 'bearer') headers.Authorization = `Bearer ${cfg.apiKey}`
      else headers['api-key'] = cfg.apiKey
      const body: Record<string, unknown> = {
        model: opts2.model,
        messages,
        temperature: opts2.temperature ?? 0.7,
        // 输出上限遵循「尽量不主动截断」：未配置 maxTokens 则不发送该字段，交由服务端按模型窗口自然输出完成，
        // 避免硬编码小值导致长回复一触即溃；需约束时由调用方（或 ProviderCfg.maxOutputTokens）显式传入。
        ...(opts2.maxTokens != null ? { max_tokens: opts2.maxTokens } : {}),
        // 通用推理抑制（分场景）：生题批次是时延敏感场景——「始终思考」类模型每批先吐 reasoning 再出正文，
        // 单批前置等待约 1 分钟，故 module='generate' 用独立的 genDisableThinking 开关（缺省启用）；
        // 其余模块（聊天/意图/摘要等）遵循用户 disableThinking 开关；调用方可 noThink 单次强制关闭（意图判型等
        // 结构化小输出场景）。均通用透传，不针对特定厂商硬编码。
        ...(opts2.noThink
          ? { thinking: { type: 'disabled' } }
          : opts2.module === 'generate'
            ? cfg.genDisableThinking !== false
              ? { thinking: { type: 'disabled' } }
              : {}
            : cfg.disableThinking
              ? { thinking: { type: 'disabled' } }
              : {}),
        ...(opts2.stream ? { stream: true } : {}),
      }
      const send = (payload: Record<string, unknown>) =>
        aiFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: opts2.signal,
        })
      let res = await send(body)
      if (!res.ok && 'thinking' in body) {
        // 通用思考降级：部分「始终思考」模型不支持关闭思考，会对 thinking 参数报 4xx。
        // 错误文案中英文都可能（如 GLM 返回「不支持关闭思考，请使用 low/high/max」），
        // 识别到 thinking/思考 关键词即去掉该参数重试一次——机制通用，不针对任何厂商/模型写死。
        const err1 = await res.json().catch(() => ({}))
        const msg = err1?.error?.message ?? JSON.stringify(err1 ?? {})
        if (/thinking|思考/i.test(String(msg))) {
          const retryBody: Record<string, unknown> = { ...body }
          delete retryBody.thinking
          res = await send(retryBody)
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw mapError(res.status, err)
      }
      if (opts2.stream && res.body) {
        return parseSSE(res.body, opts2)
      }
      const data = await res.json()
      const choice = data.choices?.[0]
      // 触顶截断不再抛错丢弃 content：携带 finishReason 交给调用方续写拼接
      return {
        content: choice?.message?.content ?? '',
        usage: normalizeUsage(data.usage),
        providerId: opts.id,
        model: opts2.model,
        finishReason: choice?.finish_reason === 'length' ? 'length' : 'stop',
      }
    },
  }
}

/**
 * 解析 OpenAI 兼容 SSE 流：累积 message.content 与 reasoning_content，
 * 每收到增量触发 onToken；返回完整内容（业务层仍按完整 JSON 解析）。
 */
async function parseSSE(body: ReadableStream<Uint8Array>, opts: ChatOptions): Promise<ChatResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let truncated = false
  const usage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0 }

  const flush = async () => {
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      let chunk: any
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      // 触顶截断：模型在 max_tokens 处被切断，content 不完整
      if (chunk.choices?.[0]?.finish_reason === 'length') truncated = true
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) {
        content += delta.content
        opts.onToken?.(delta.content, '')
      }
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content
        opts.onToken?.('', delta.reasoning_content)
      }
      if (chunk.usage) {
        const u = normalizeUsage(chunk.usage)
        usage.inputTokens = u.inputTokens
        usage.outputTokens = u.outputTokens
        usage.cacheReadTokens = u.cacheReadTokens
        usage.cacheMissTokens = u.cacheMissTokens
      }
    }
  }

  // 5.6 / V4 复审补充：reader.read({ signal }) 是 Web Streams API 的非标扩展，TS 类型为 ()，
  // Chrome 部分版本/Safari 不识别 signal 参数，会被静默忽略——abort 触发后 read() 仍阻塞等下一 chunk。
  // 改为「循环顶部 signal 守卫 + signal abort 监听里主动 reader.cancel() 强制中断 read」
  // 两层兜底：cancel() 让当前 read 立即 resolve {done:true}，下轮循环 signal 检查抛出 AbortError，
  // gateway 把 AbortError 归一为 ABORTED → store chat() catch 走「已停止回复」分支。
  opts.signal?.addEventListener(
    'abort',
    () => {
      try {
        reader.cancel()
      } catch {
        // reader 可能已关闭，忽略
      }
    },
    { once: true },
  )

  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    await flush()
  }
  buffer += decoder.decode()
  await flush()

  // BUG-4 真根因修复：abort 监听里 reader.cancel() 会让挂起的 read() 以 {done:true} 返回，
  // 上面的 break 会把它当成「流正常结束」返回半截内容——用户点「停止回复」、网关 60s 超时中断、
  // 上游断流全都被静默吞掉（store 永远走不到 catch 的「已停止回复」分支，气泡残留成
  // 「（已中断）」或莫名只有一句话）。信号已中止时必须抛 AbortError，交由上层按取消/超时处理
  if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')

  // 截断不抛错：已收到的 content 连同 finishReason 返回，调用方续写拼接
  return {
    content,
    usage,
    providerId: opts.providerId,
    model: opts.model,
    finishReason: truncated ? 'length' : 'stop',
  }
}

function normalizeUsage(usage: {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
}): ChatUsage {
  const inputTokens = usage?.prompt_tokens ?? 0
  const outputTokens = usage?.completion_tokens ?? 0
  const cacheReadTokens = usage?.prompt_cache_hit_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheMissTokens: Math.max(0, inputTokens - cacheReadTokens),
  }
}

function mapError(status: number, err: { error?: { message?: string } }): AIError {
  const msg = err?.error?.message ?? 'Unknown error'
  // OBS-6 修复：开发代理自身的拒绝（SSRF 白名单/方法/并发限制）message 以 proxy: 开头，
  // 此前其 403 命中上游鉴权语义被映射成 AUTH_FAILED——用户改错 API 地址自测时看到
  // 「API Key 无效」被严重误导。代理拒绝一律按网络/地址问题归类。
  if (typeof msg === 'string' && msg.startsWith('proxy:')) return new AIError('NETWORK', msg)
  if (status === 401 || status === 403) return new AIError('AUTH_FAILED', msg)
  if (status === 429) return new AIError('RATE_LIMITED', msg)
  if (status === 404) return new AIError('MODEL_NOT_FOUND', msg)
  return new AIError('NETWORK', msg)
}
