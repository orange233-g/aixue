/**
 * 请求超时/取消统一处理（I-03）：
 * 把「调用方取消信号 + 超时定时器」合并为单一 AbortSignal，供 fetchModels / testConnection 等
 * 绕过网关的直连调用使用，保证它们与主聊天链路一致地受超时约束，网络悬挂时不会长期 loading。
 */

export interface TimeoutHandle {
  signal: AbortSignal
  /** 是否因超时主动 abort（用于错误归一化为 TIMEOUT，区别于用户取消） */
  timedOut: () => boolean
  cleanup: () => void
}

export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): TimeoutHandle {
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