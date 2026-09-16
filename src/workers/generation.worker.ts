/**
 * 生题生成 Worker（借鉴 Cherry Studio 的「执行与 UI 分离」）：
 * 把 runGeneration 的「批次网络请求 + SSE 流式解析 + 逐题哈希/校验 + IndexedDB 写入」整体迁出主线程，
 * 主线程只通过 postMessage 收进度/结果，避免高频回调触发 React 重渲染造成 UI 卡顿。
 *
 * 通信协议（消息均为可结构化克隆的纯数据）：
 *   主线程 → Worker
 *     { type:'start', session, input, req, cfg, seed? }
 *     { type:'abort' }
 *   Worker → 主线程
 *     { type:'progress', progress }
 *     { type:'token',  delta, reasoning }   // 仅 DEV 实时面板用
 *     { type:'draft',  questions }
 *     { type:'done',   result }
 *     { type:'error',  code?, message, partial? }
 */
import { runGeneration } from '../services/generation'
import type { AIConfig, GenerateRequest, Question, Session } from '../types'

/** 主线程在 start 消息里下发的 (session/input/req)，与 runGeneration 参数一致 */
interface StartMessage {
  type: 'start'
  session: Session
  input: string
  req: GenerateRequest
  cfg: AIConfig
  seed?: Question[]
  /** 用户消息已由 send() 乐观写入会话，生题流程不再重复追加 */
  skipUserMsg?: boolean
  /** 多卷流水线中间卷：跳过会话更新（消息追加/摘要压缩/保存），由末卷统一收尾 */
  skipSessionUpdate?: boolean
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (msg: unknown) => void
}

let controller: AbortController | null = null

function ensureAbortable(): AbortController {
  controller = new AbortController()
  return controller
}

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as StartMessage | { type: 'abort' }
  if (msg?.type === 'abort') {
    controller?.abort()
    return
  }
  if (msg?.type !== 'start') return
  const { session, input, req, cfg, seed, skipUserMsg, skipSessionUpdate } = msg
  const abort = ensureAbortable()
  void runGeneration(
    session,
    input,
    req,
    cfg,
    (progress) => scope.postMessage({ type: 'progress', progress }),
    abort.signal,
    (delta, reasoning) => scope.postMessage({ type: 'token', delta, reasoning }),
    async (questions) => scope.postMessage({ type: 'draft', questions }),
    seed,
    skipUserMsg,
    skipSessionUpdate,
  )
    .then((res) => scope.postMessage({ type: 'done', result: res }))
    .catch((e) => {
      const partial = (e as Error & { partial?: Question[] }).partial
      scope.postMessage({
        type: 'error',
        code: (e as { code?: string })?.code,
        message: e instanceof Error ? e.message : String(e),
        partial,
      })
    })
}