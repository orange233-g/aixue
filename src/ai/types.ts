import type { ProviderCfg } from '../types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  providerId: string
  model: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 单次请求超时（ms），默认 60s（见 PRD 10.6 TIMEOUT 重试策略） */
  timeoutMs?: number
  module: string
  /** 是否使用 SSE 流式输出（生题场景开启，首 token 更快、可透传进度） */
  stream?: boolean
  /** 流式分片回调：每收到一段增量文本触发（仅 stream 时有效） */
  onToken?: (delta: string, reasoning: string) => void
  /** 真实网络调用计数回调（V2-I02）：每次建立连接/重试 attempt 前触发，用于生成器累计请求预算。
   *  返回 false 表示预算已耗尽，网关应立即中止本次调用并抛 ABORTED（不重试不续发）。 */
  onRequest?: (attempt: number) => boolean
  /** 单次调用强制关闭思考（通用机制，不绑厂商）：结构化小输出调用（意图判型/需求收集/确认精炼等）
   *  时延敏感且无需推理——「始终思考」类模型会烧掉 maxTokens 预算导致 JSON 截断/超时。
   *  适配器对不支持关闭思考的模型自动剥参数重试（openai-compatible 通用降级）。 */
  noThink?: boolean
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
}

export interface ChatResult {
  content: string
  usage: ChatUsage
  providerId: string
  model: string
  /** 结束原因：stop=正常；length=触顶截断（调用方可续写拼接，不丢已生成内容） */
  finishReason?: 'stop' | 'length'
}

export type AIErrorCode =
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PARSE_FAILED'
  | 'ABORTED'
  /** 模型输出触顶被截断（finish_reason=length）。适配器现改在 ChatResult.finishReason 携带，保留码位兼容 */
  | 'TRUNCATED'
  /** 断点续跑引用的知识库已被删除/损坏（V2-F05）：不得静默脱离资料继续生成 */
  | 'KB_SOURCE_MISSING'

export class AIError extends Error {
  code: AIErrorCode
  constructor(code: AIErrorCode, message: string) {
    super(message)
    this.name = 'AIError'
    this.code = code
  }
}

/** Provider 适配器接口（见 PRD 10.7） */
export interface ProviderAdapter {
  id: string
  name: string
  defaultBaseUrl: string
  auth: 'bearer' | 'api-key'
  listModels(cfg: ProviderCfg, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string[]>
  chat(messages: ChatMessage[], cfg: ProviderCfg, opts: ChatOptions): Promise<ChatResult>
}
