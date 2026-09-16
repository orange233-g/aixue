import type { ChatMessage, ChatOptions, ChatResult } from './types'
import { AIError } from './types'
import { getAdapter } from './providers'
import type { AIConfig, PriceItem, ProviderCfg } from '../types'
import { dbUsage } from '../db'
import { estimateCost } from './usage/cost'
import { log } from '../utils/log'
import { uid } from '../utils'

/**
 * AI 网关唯一入口（见 PRD 10.2）：业务层只依赖 chat()。
 * 内部：路由适配器 → 合并用户配置 → 发起请求（超时 + 重试）→ 归一化结果 → 记录用量。
 */

/** 单次请求默认超时（ms） */
const DEFAULT_TIMEOUT = 60_000
/** 重试退避基数（ms），指数退避：1s → 2s → 4s */
const RETRY_BASE_DELAY = 1000

/** 测试可覆盖退避延迟以加速（见 scripts/test-ai.ts） */
export let retryBaseDelay = RETRY_BASE_DELAY
export function setRetryBaseDelay(ms: number): void {
  retryBaseDelay = ms
}

/** 各错误码最大重试次数（见 PRD 10.6）：限流指数退避 ≤3，超时 ≤2，网络错误 1（真机弱网瞬时断连可自愈），其余不重试 */
const MAX_RETRIES: Partial<Record<AIError['code'], number>> = {
  RATE_LIMITED: 3,
  TIMEOUT: 2,
  NETWORK: 1,
}

export async function chat(messages: ChatMessage[], opts: ChatOptions, cfg: AIConfig): Promise<ChatResult> {
  const started = Date.now()
  const ref: { attempts: number } = { attempts: 0 }
  const providerCfg = cfg.providers[opts.providerId]
  log('info', 'model', `调用 ${opts.module}·${opts.model}`, {
    provider: opts.providerId, model: opts.model, module: opts.module, hasKey: !!providerCfg?.apiKey,
  })
  try {
    const result = await chatInner(messages, opts, cfg, ref)
    log('info', 'model', `OK ${opts.module}·${opts.model}`, {
      provider: opts.providerId, model: opts.model, module: opts.module,
      ms: Date.now() - started, attempts: ref.attempts,
      input: result.usage?.inputTokens, output: result.usage?.outputTokens,
      finish: result.finishReason,
    })
    return result
  } catch (e) {
    const code = e instanceof AIError ? e.code : 'NETWORK'
    log('error', 'model', `FAIL ${opts.module}·${opts.model} ${code}`, {
      provider: opts.providerId, model: opts.model, module: opts.module,
      ms: Date.now() - started, attempts: ref.attempts,
      code, message: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

async function chatInner(messages: ChatMessage[], opts: ChatOptions, cfg: AIConfig, ref: { attempts: number }): Promise<ChatResult> {
  const adapter = getAdapter(opts.providerId)
  if (!adapter) throw new AIError('MODEL_NOT_FOUND', `未知厂商: ${opts.providerId}`)

  const providerCfg = cfg.providers[opts.providerId]
  if (!providerCfg?.apiKey) throw new AIError('AUTH_FAILED', '未配置 API Key，请到 AI 设置填写')

  let attempts = 0
  // I-01：追踪本 attempt 是否已产出 token——一旦已有输出，禁止网关透明重试，
  // 因为重试会从头生成并拼接在首轮残片后，造成重复段落 / 生题残块；交由业务层"继续/重试"。
  let tokensReceived = false
  const onToken = opts.onToken
    ? (delta: string, reasoning: string) => {
        tokensReceived = true
        opts.onToken?.(delta, reasoning)
      }
    : undefined
  const attemptOpts: ChatOptions = { ...opts, onToken }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // V2-I02：每次真实 attempt（含重试）前计入请求预算；已耗尽则立即中止，不再发起/重试
    if (opts.onRequest && !opts.onRequest(attempts + 1)) {
      throw new AIError('ABORTED', '生题请求预算已用完')
    }
    const handle = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT)
    try {
      const result = await adapter.chat(messages, providerCfg, { ...attemptOpts, signal: handle.signal })
      await recordUsage(opts, result, providerCfg.price, providerCfg)
      ref.attempts = attempts
      return result
    } catch (e) {
      const err = toAIError(e, handle.timedOut())
      // 不重试：用户取消 / 鉴权失败 / 模型不存在
      if (err.code === 'ABORTED' || err.code === 'AUTH_FAILED' || err.code === 'MODEL_NOT_FOUND') {
        ref.attempts = attempts
        throw err
      }
      // I-01：已产出 token 后即使超时/网络错误也不再透明重试，避免流输出拼接两次
      if (tokensReceived) {
        ref.attempts = attempts
        throw err
      }
      const maxRetries = MAX_RETRIES[err.code] ?? 0
      if (attempts >= maxRetries) {
        ref.attempts = attempts
        throw err
      }
      attempts++
      ref.attempts = attempts
      // I-02：进入退避前与退避中途都检查取消信号，取消后立即抛出，避免卡在 sleep 延迟反馈
      if (opts.signal?.aborted) {
        ref.attempts = attempts
        throw new AIError('ABORTED', '已取消')
      }
      await cancellableDelay(retryBaseDelay * 2 ** (attempts - 1), opts.signal)
      if (opts.signal?.aborted) {
        ref.attempts = attempts
        throw new AIError('ABORTED', '已取消')
      }
    } finally {
      handle.cleanup()
    }
  }
}

/** 把任意异常归一化为 AIError；AbortError 区分超时与用户取消 */
function toAIError(e: unknown, timedOut: boolean): AIError {
  if (e instanceof AIError) return e
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new AIError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? '响应超时' : '已取消')
  }
  return new AIError('NETWORK', e instanceof Error ? e.message : '网络错误')
}

interface TimeoutHandle {
  signal: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
}

/** 合并用户取消信号与超时：超时触发时 abort 并标记 timedOut */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): TimeoutHandle {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort)
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** I-02：可取消延迟。signal 中断时提前 resolve（resolve 后由调用方再次检查 signal 决定是否退出） */
function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(onAbort, ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function recordUsage(opts: ChatOptions, result: ChatResult, price: PriceItem | undefined, cfg: ProviderCfg): Promise<void> {
  const cost = estimateCost(
    opts.providerId,
    opts.model,
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cacheReadTokens,
    result.usage.cacheMissTokens,
    price,
    { enabled: cfg.peakEnabled, times: cfg.peakTimes },
  )
  try {
    await dbUsage.add({
      // I-04：用量主键用唯一 uid，避免并发批次同一毫秒 Date.now() 冲突、put 覆盖导致 token/费用被低估
      id: uid('u'),
      module: opts.module,
      providerId: opts.providerId,
      model: opts.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheMissTokens: result.usage.cacheMissTokens,
      cost,
      timestamp: Date.now(),
    })
  } catch (e) {
    // 用量记录失败不影响主流程
    console.error('[usage] record failed:', e)
  }
}
