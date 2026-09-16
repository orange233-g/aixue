/**
 * 语义索引向量化 Worker 客户端（V-EMB 一期，仿 kbProcessWorkerClient 模式）：
 * - Worker 优先（分批发送，批间回报进度；AbortSignal 可中断；超时视为失联终止重建）
 * - Worker 不可用（老 WebView / 构建不支持 module worker）回退主线程等价处理（仅提示一次）
 */
import { embedTexts } from '../ai/embed/loader'

/** 单批章节数：批内合并推理更高效，批间可回报进度/响应中断 */
const BATCH_SIZE = 8
/** 单次任务超时（含全部批次；超时终止重建 Worker） */
const TASK_TIMEOUT_MS = 300_000

let worker: Worker | null = null
let seq = 0
let warnedFallback = false

interface PendingTask {
  resolve: (v: Float32Array[]) => void
  reject: (e: Error) => void
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

const pending = new Map<number, PendingTask>()

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

function getWorker(): Worker | null {
  if (worker) return worker
  const w = createWorker()
  if (!w) return null
  w.addEventListener('message', (e: MessageEvent<{ id: number; ok?: boolean; vectors?: number[][]; error?: string }>) => {
    const { id, ok, vectors, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok && vectors) {
      p.resolve(vectors.map((v) => Float32Array.from(v)))
    } else {
      p.reject(new Error(error ?? 'embedding 失败'))
    }
  })
  w.addEventListener('error', () => {
    terminateWorker()
    rejectAllPending(new Error('embedding Worker 异常'))
  })
  worker = w
  return w
}

function terminateWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
}

function rejectAllPending(err: Error): void {
  const list = [...pending.values()]
  pending.clear()
  for (const p of list) p.reject(err)
}

/**
 * 批量文本向量化（分批复用 worker，进度/中断/超时/降级全在这里）。
 * vectors 与 texts 等长；任一批失败整体 reject（调用方置 embedStatus=error）。
 * onBatch：每批完成后回调（batchFirstIdx=该批首条在 texts 中的下标 + 批向量），
 * 供调用方做断点续建的增量持久化（真机 6.x：大库中断后从零重算不可接受）。
 */
export async function runEmbed(
  modelId: string,
  texts: string[],
  opts?: {
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
    onBatch?: (batchFirstIdx: number, vectors: Float32Array[]) => void
  },
): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const signal = opts?.signal
  const total = texts.length
  const out: Float32Array[] = new Array(total)

  // 主线程降级：Worker 不可用时同步跑（小库可接受；仅提示一次）
  const w = getWorker()
  if (!w) {
    if (!warnedFallback) {
      warnedFallback = true
      console.warn('[embed-worker] Worker 不可用，回退主线程向量化；大库可能卡顿')
    }
    const vectors = await embedTexts(modelId, texts)
    opts?.onProgress?.(total, total)
    return vectors
  }

  // Worker 路径：分批发
  const batches: string[][] = []
  for (let i = 0; i < total; i += BATCH_SIZE) batches.push(texts.slice(i, i + BATCH_SIZE))

  let done = 0
  for (let b = 0; b < batches.length; b++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const vectors = await new Promise<Float32Array[]>((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          terminateWorker()
          reject(new Error('embedding 超时，已终止重建 Worker'))
        }
      }, TASK_TIMEOUT_MS)
      // 任务完成/失败时清理 timer（resolve/reject 后 pending 已删，此处兜底防泄漏）
      const origResolve = resolve
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          origResolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
        signal,
        onProgress: opts?.onProgress,
      })
      w.postMessage({ id, modelId, texts: batches[b] })
    })
    // 按批写入对应下标
    for (let i = 0; i < vectors.length; i++) {
      out[b * BATCH_SIZE + i] = vectors[i]
    }
    done += vectors.length
    opts?.onBatch?.(b * BATCH_SIZE, vectors)
    opts?.onProgress?.(done, total)
  }
  return out
}
