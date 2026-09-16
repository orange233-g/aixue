/**
 * 知识库处理 Worker（V2-P04）：把清洗 + 结构分块 + 统计搬出主线程，避免大库整理/迁移时 UI 卡顿。
 * 核心逻辑在 services/kb/process.ts（纯函数、无 DOM），Worker 与主线程回退共用同一份语义。
 */
import { processSources } from '../services/kb/process'
import type { KBSourceText } from '../types'

export interface KbProcessWorkerReq {
  id: number
  /** raw 源切片层（聚合还原→清洗→分块的输入） */
  sourcesText: KBSourceText[]
}

export type KbProcessWorkerOk = ReturnType<typeof processSources>

export interface KbProcessWorkerRes {
  id: number
  ok?: KbProcessWorkerOk
  error?: string
}

self.onmessage = (e: MessageEvent<KbProcessWorkerReq>) => {
  const { id, sourcesText } = e.data
  try {
    const ok = processSources(sourcesText)
    const res: KbProcessWorkerRes = { id, ok }
    ;(self as unknown as Worker).postMessage(res)
  } catch (err) {
    const res: KbProcessWorkerRes = {
      id,
      error: err instanceof Error ? err.message : '知识库整理失败',
    }
    ;(self as unknown as Worker).postMessage(res)
  }
}