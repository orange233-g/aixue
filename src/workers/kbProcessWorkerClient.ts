/**
 * 知识库处理 Worker 客户端（V2-P04；V3-P01：新增单次超时/取消/重建）：
 * 优先把清洗+分块丢给 Worker，避免大库整理/迁移卡 UI；
 * Worker 创建失败（老 WebView / 构建环境不支持 module worker）时回退主线程等价处理
 * （共用 services/kb/process.ts 的 processSources，两条路径结果一致）。
 */
import type { KBSourceText } from '../types'
import { processSources } from '../services/kb/process'
import type { KBProcessResult } from '../services/kb/process'

/** V3-P01：单次 Worker 任务超时上限。超过视为失联，终止并重建 Worker，避免 Promise 永久 pending */
const WORKER_TIMEOUT_MS = 60_000

let worker: Worker | null = null
let seq = 0
/** V3-P01：主线程回退时仅提示一次性能降级，避免大库整理期间刷屏 */
let warnedFallback = false
const pending = new Map<number, { resolve: (r: KBProcessResult) => void; reject: (e: Error) => void }>()

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./kbProcess.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

function rejectAllPending(err: Error): void {
  const list = [...pending.values()]
  pending.clear()
  for (const p of list) p.reject(err)
}

/** 终止并丢弃当前 Worker；下一次 getWorker 惰性重建（V3-P01：异常/超时后自动重建，不再一坏永久回退主线程） */
function resetWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
}

function getWorker(): Worker | null {
  if (worker) return worker
  const w = createWorker()
  if (!w) return null
  w.addEventListener('message', (e: MessageEvent<{ id: number; ok?: KBProcessResult; error?: string }>) => {
    const { id, ok, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok) p.resolve(ok)
    else p.reject(new Error(error ?? '知识库处理失败'))
  })
  w.addEventListener('error', () => {
    resetWorker()
    rejectAllPending(new Error('知识库处理 Worker 异常'))
  })
  worker = w
  return w
}

/** 清洗 + 分块知识库源切片；Worker 可用走异步，否则主线程同步等价处理。
 *  V3-P01：支持单次超时与 AbortSignal——超时视为 Worker 失联，终止并重建以保证后续任务可用；
 *  用户取消（signal.abort）只放弃当前任务，不复用坏实例、也不打断其它任务。 */
export function processKBSources(
  sourcesText: KBSourceText[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<KBProcessResult> {
  const signal = opts?.signal
  const timeoutMs = Math.max(0, opts?.timeoutMs ?? WORKER_TIMEOUT_MS)
  const w = getWorker()
  if (!w) {
    // V3-P01：主线程回退时提示性能降级（本地毫秒级可接受；仅提示一次避免刷屏）
    if (!warnedFallback) {
      warnedFallback = true
      console.warn('[kb-worker] Worker 不可用，回退主线程处理；超大知识库整理可能卡顿')
    }
    return Promise.resolve(processSources(sourcesText))
  }

  return new Promise((resolve, reject) => {
    const id = ++seq
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      pending.delete(id)
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onTimeout = () =>
      settle(() => {
        reject(new Error('知识库处理超时，已中止并重建 Worker'))
        // Worker 可能卡在长计算里：终止重建，避免后续任务排队在坏实例后
        resetWorker()
      })
    // V4-P01：取消时不能只 reject Promise——Worker 仍在后台跑清洗/分块占 CPU；
    // 同类任务本就是单任务顺序处理，直接 terminate 丢弃当前实例，下次 getWorker 惰性重建。
    const onAbort = () =>
      settle(() => {
        reject(new Error('知识库处理已取消'))
        resetWorker()
      })
    const timer = setTimeout(onTimeout, timeoutMs)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }
    pending.set(id, {
      resolve: (r) => settle(() => resolve(r)),
      reject: (e) => settle(() => reject(e)),
    })
    // 若 signal 在调用前已 aborted，上面已同步拒绝，不必再向 Worker 派发一个无人消费的任务
    if (!settled) w.postMessage({ id, sourcesText })
  })
}