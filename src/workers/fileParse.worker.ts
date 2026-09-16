/**
 * Office 文件解压 Worker：zip 容器里只解压需要的条目（fflate filter 单挑解压），
 * 大 zip 不全量展开、解压不卡 UI。XML→文本的抠取在主线程用 DOMParser 完成
 * （DOMParser 不存在于 Worker 环境）。
 */
import { unzipSync } from 'fflate'
import { guardedFilter } from './officeCaps'

export interface FileParseWorkerReq {
  id: number
  ext: 'docx' | 'xlsx' | 'odt'
  buffer: ArrayBuffer
}

export interface FileParseWorkerRes {
  id: number
  ok?: Record<string, Uint8Array>
  error?: string
}

// 安全上限（单条目/总体积/压缩比）与主线程回退共用 officeCaps.guardedFilter，见 officeCaps.ts
self.onmessage = (e: MessageEvent<FileParseWorkerReq>) => {
  const { id, ext, buffer } = e.data
  try {
    const filter = guardedFilter(ext)
    const unzipped = unzipSync(new Uint8Array(buffer), { filter })
    const out: Record<string, Uint8Array> = {}
    for (const [name, data] of Object.entries(unzipped)) out[name] = data
    const res: FileParseWorkerRes = { id, ok: out }
    ;(self as unknown as Worker).postMessage(res)
  } catch (err) {
    const res: FileParseWorkerRes = {
      id,
      error: err instanceof Error ? err.message : '解压失败（文件可能不是有效的 docx/xlsx/odt）',
    }
    ;(self as unknown as Worker).postMessage(res)
  }
}
