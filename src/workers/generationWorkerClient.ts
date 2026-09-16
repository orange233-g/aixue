/**
 * 生题生成 Worker Client（主线程侧桥接）：
 * 暴露与 runGeneration 同签名的 generationStart()，内部持有 Worker、收发消息。
 * 主线程 store 调用处零改动语义——传 AbortSignal，client 把它的 abort 事件翻译成 postMessage({type:'abort'})；
 * 把 worker 回传的 progress/token/draft/done/error 原样转发给对应回调。
 *
 * 若 Worker 不可用（极端环境 / Capacitor 旧 WebView 实例化失败），回退到主线程直跑 runGeneration，
 * 保证功能绝不因 Worker 而降级。
 */
import { runGeneration } from '../services/generation'
import type { GenerateProgress, GenerateResult } from '../services/generation'
import type { AIConfig, GenerateRequest, Question, Session } from '../types'

export interface GenerationStartOptions {
  session: Session
  input: string
  req: GenerateRequest
  cfg: AIConfig
  seed?: Question[]
  /** 用户消息已由调用方（send 乐观写入）追加进会话，生题流程不再重复追加 */
  skipUserMsg?: boolean
  /** 多卷流水线中间卷：跳过会话更新（消息追加/摘要压缩/保存），由末卷统一收尾 */
  skipSessionUpdate?: boolean
}

export interface GenerationCallbacks {
  onProgress?: (p: GenerateProgress) => void
  onToken?: (delta: string, reasoning: string) => void
  onDraft?: (questions: Question[]) => Promise<void> | void
}

type WorkerMsg =
  | { type: 'progress'; progress: GenerateProgress }
  | { type: 'token'; delta: string; reasoning: string }
  | { type: 'draft'; questions: Question[] }
  | { type: 'done'; result: GenerateResult }
  | { type: 'error'; code?: string; message: string; partial?: Question[] }

/** 尝试构造 Worker；任何失败返回 null（回退主线程直跑） */
function createGenerationWorker(): Worker | null {
  try {
    if (typeof Worker === 'undefined') return null
    // Vite 构造器导入：把 worker 及依赖闭包按独立 chunk 打包，Capacitor 走同源 https 加载
    return new Worker(new URL('./generation.worker.ts', import.meta.url), { type: 'module' })
  } catch (e) {
    console.warn('[gen-worker] create failed, fallback to main thread:', e)
    return null
  }
}

/** Worker 可用性探测（供 UI 展示是否走 worker 路径，纯信息性） */
export function isGenerationWorkerSupported(): boolean {
  try {
    return typeof Worker !== 'undefined'
  } catch {
    return false
  }
}

export async function generationStart(
  opts: GenerationStartOptions,
  callbacks: GenerationCallbacks,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const worker = createGenerationWorker()
  // 回退：Worker 构造失败时直接主线程直跑（语义完全一致，只是 UI 无 offload）
  if (!worker) {
    return runGeneration(
      opts.session,
      opts.input,
      opts.req,
      opts.cfg,
      callbacks.onProgress,
      signal,
      callbacks.onToken,
      callbacks.onDraft,
      opts.seed,
      opts.skipUserMsg,
      opts.skipSessionUpdate,
    )
  }

  return new Promise<GenerateResult>((resolve, reject) => {
    let settled = false
    // 一次性消息编号：done/error 同批只消费一次
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as WorkerMsg
      switch (msg.type) {
        case 'progress':
          callbacks.onProgress?.(msg.progress)
          break
        case 'token':
          callbacks.onToken?.(msg.delta, msg.reasoning)
          break
        case 'draft':
          void (async () => await callbacks.onDraft?.(msg.questions))()
          break
        case 'done':
          if (settled) return
          settled = true
          cleanup()
          resolve(msg.result)
          break
        case 'error':
          if (settled) return
          settled = true
          cleanup()
          const err = Object.assign(new Error(msg.message), { code: msg.code })
          if (msg.partial) (err as Error & { partial?: Question[] }).partial = msg.partial
          reject(err)
          break
      }
    }
    worker.addEventListener('message', onMessage)

    const onAbort = () => worker.postMessage({ type: 'abort' })
    if (signal) {
      if (signal.aborted) worker.postMessage({ type: 'abort' })
      else signal.addEventListener('abort', onAbort)
    }

    const cleanup = () => {
      worker.removeEventListener('message', onMessage)
      signal?.removeEventListener('abort', onAbort)
      // P-02：任务结束（成功/失败/取消）即终止 Worker，避免长驻空转、占内存与多实例堆积
      worker.terminate()
    }

    worker.postMessage({
      type: 'start',
      session: opts.session,
      input: opts.input,
      req: opts.req,
      cfg: opts.cfg,
      seed: opts.seed,
      skipUserMsg: opts.skipUserMsg,
      skipSessionUpdate: opts.skipSessionUpdate,
    })

    // 泄漏防护：worker 启动失败/异常退出时避免 Promise 永不 settle。
    // TASK-09 走查：error 事件只带「运行异常」无细节——打印 ErrorEvent 的 message/filename/lineno
    // （dev 下通常是 worker 模块加载 404/500 或 worker 顶层抛错），并补听 messageerror（克隆失败）。
    worker.addEventListener('error', (ev) => {
      if (settled) return
      settled = true
      cleanup()
      const ee = ev as ErrorEvent
      console.error(
        '[gen-worker] worker error event:',
        ee.message || '(no message)',
        '| file:', ee.filename || '(none)',
        '| line:', ee.lineno ?? '-',
      )
      reject(new Error('生题 Worker 运行异常'))
    })
    worker.addEventListener('messageerror', () => {
      if (settled) return
      settled = true
      cleanup()
      console.error('[gen-worker] messageerror: worker 回传消息无法结构化克隆')
      reject(new Error('生题 Worker 消息克隆失败'))
    })
  })
}