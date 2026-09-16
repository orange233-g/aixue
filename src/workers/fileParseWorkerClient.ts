/**
 * Office 解压 Worker 客户端（对齐 generationWorkerClient 的回退策略；V3-P01：新增单次超时/取消/重建）：
 * Worker 创建失败（老 WebView / 构建环境不支持 module worker）时回退主线程 fflate 直解，
 * 保证功能可用优先，性能次之。
 */
import type { FileParseWorkerRes } from './fileParse.worker'
import { guardedFilter } from './officeCaps'

/** V3-P01：单次解压任务超时上限。超过视为失联，终止并重建 Worker，避免 Promise 永久 pending */
const WORKER_TIMEOUT_MS = 60_000

let worker: Worker | null = null
let seq = 0
/** V3-P01：主线程回退时仅提示一次性能降级，避免批量导入期间刷屏 */
let warnedFallback = false
const pending = new Map<number, { resolve: (v: Record<string, Uint8Array>) => void; reject: (e: Error) => void }>()

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./fileParse.worker.ts', import.meta.url), { type: 'module' })
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
  w.addEventListener('message', (e: MessageEvent<FileParseWorkerRes>) => {
    const { id, ok, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok) p.resolve(ok)
    else p.reject(new Error(error ?? '解压失败'))
  })
  w.addEventListener('error', () => {
    resetWorker()
    rejectAllPending(new Error('解压 Worker 异常'))
  })
  worker = w
  return w
}

async function unzipOnMain(buffer: ArrayBuffer, ext: 'docx' | 'xlsx' | 'odt'): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate')
  // V2-S06：回退路径同样强制单条目/总体积/压缩比上限（与 Worker 共用 officeCaps.guardedFilter），
  // 杜绝 Worker 异常时绕过防护直解 zip bomb（fail-closed，不再无条件允许）
  return unzipSync(new Uint8Array(buffer), { filter: guardedFilter(ext) }) as Record<string, Uint8Array>
}

/** 解压 Office zip 中需要的条目；Worker 不可用时回退主线程（同样受限，fail-closed）。
 *  V3-P01：支持单次超时与 AbortSignal——超时视为 Worker 失联，终止并重建以保证后续任务可用。 */
export function unzipOfficeEntries(
  buffer: ArrayBuffer,
  ext: 'docx' | 'xlsx' | 'odt',
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, Uint8Array>> {
  const signal = opts?.signal
  const timeoutMs = Math.max(0, opts?.timeoutMs ?? WORKER_TIMEOUT_MS)
  const w = getWorker()
  if (!w) {
    // V3-P01：主线程回退时提示性能降级（单文件解压可接受；仅提示一次避免批量导入刷屏）
    if (!warnedFallback) {
      warnedFallback = true
      console.warn('[zip-worker] Worker 不可用，Office 解压回退主线程；多个大文件可能卡顿')
    }
    return unzipOnMain(buffer, ext)
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
        reject(new Error('解压超时，已中止并重建 Worker'))
        // Worker 可能卡在长计算里：终止重建，避免后续任务排队在坏实例后
        resetWorker()
      })
    // V4-P01：取消时不能只 reject——Worker 仍可能在后台解压占 CPU；直接 terminate 并惰性重建
    const onAbort = () =>
      settle(() => {
        reject(new Error('解压已取消'))
        resetWorker()
      })
    const timer = setTimeout(onTimeout, timeoutMs)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }
    pending.set(id, {
      resolve: (v) => settle(() => resolve(v)),
      reject: (e) => settle(() => reject(e)),
    })
    // 若 signal 在调用前已 aborted，上面已同步拒绝，不必再向 Worker 派发一个无人消费的任务
    if (!settled) w.postMessage({ id, ext, buffer }, [buffer])
  })
}