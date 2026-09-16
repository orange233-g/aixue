/**
 * 参考资料池（导入文件 → 发送内容）：预算封顶 + water-filling 平分 + 「继续读取」续读。
 * 借鉴 Cherry attachmentBudget 的分配方程：小文件优先拿满自身，剩余预算由大文件平分，
 * 保证多文件场景总额永不超过池上限；截断用 surrogateSafeEnd 防切坏代理对。
 * 本项目无 tokenizer，按字符近似（中文 1 字 ≈ 1 token，预算取字符数已偏保守）。
 */
import { sanitizeInput } from '../../utils/sanitize'

/** 参考资料池总预算（字符）：默认 8000 窗口下 ≈ 4500 中文字喂料（可行性分析 §11 容量口径） */
export const REF_POOL_CHARS = 4500

/* ---- V2-P01：多文件总配额 + 解析并发上限（防多份 50MB 同时 readAsText/解压 OOM） ---- */

/** 单次发送可引用的最大文件数 */
export const MAX_FILE_COUNT = 10
/** 单次发送可引用的文件总体积上限（字节） */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024

/** 计算文件列表总体积 */
export function totalBytesOf(files: readonly { size: number }[]): number {
  return files.reduce((s, f) => s + f.size, 0)
}

/** 带并发上限的 Promise 映射（保留 allSettled 语义：单项失败不中断整体）：
 *  避免多份大文件同时进入 readAsText/解压/DOMParser 造成内存峰值。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const workers: Promise<void>[] = []
  const run = async (i: number) => {
    if (i >= items.length) return
    try {
      out[i] = { status: 'fulfilled', value: await fn(items[i], i) }
    } catch (reason) {
      out[i] = { status: 'rejected', reason }
    }
    if (next < items.length) await run(next++)
  }
  const n = Math.min(limit, items.length)
  for (let k = 0; k < n; k++) workers.push(run(next++))
  await Promise.all(workers)
  return out
}

/** 截断点回退到不切断 UTF-16 代理对的位置（借鉴 Cherry textPaging.surrogateSafeEnd） */
export function surrogateSafeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const c = text.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) return end - 1
  }
  return end
}

/** water-filling 预算分配（借鉴 Cherry allocateAttachmentBudget）：最小文件优先，
 *  各文件取 min(自身大小, 剩余预算/未服务数)，小文件拿满后大文件平分余量 */
export function allocateBudget(sizes: readonly number[], total: number): number[] {
  const allocated = new Array<number>(sizes.length).fill(0)
  const smallestFirst = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size)
  let remaining = Math.max(0, total)
  let unserved = smallestFirst.length
  for (const { size, index } of smallestFirst) {
    const take = Math.min(Math.max(0, size), Math.floor(remaining / Math.max(1, unserved)))
    allocated[index] = take
    remaining -= take
    unserved--
  }
  return allocated
}

/** 生成页文件 chip 的数据结构。
 *  对齐 Cherry/Reasonix：选中文件只保留引用（浏览器 File 对象），不立即解析内容；
 *  text/cursor 在首次发送时才解析并填充，供预算注入与「继续读取」续读。 */
export interface FileChip {
  id: string
  name: string
  size: number
  /** 选中时仅挂引用；内容解析推迟到发送/续读时（file 需保存活引用） */
  file: File
  /** 解析出的全文（首次发送后才缓存，undefined 表示尚未解析） */
  text?: string
  /** 已读到的字符位置（water-filling 首轮分配，之后由「继续读取」推进） */
  cursor?: number
}

/** 选中文件 → chip（不解析内容） */
export function toChips(files: File[]): FileChip[] {
  return files.map((f, i) => ({ id: `fc_${Date.now().toString(36)}_${i}`, name: f.name, size: f.size, file: f }))
}

/** 首次解析后回填：给尚未解析的 chip 填入 text，并按 water-filling 分配首轮已读量 cursor。
 *  已解析/已推进的 chip 保持不变（不覆盖用户「继续读取」的进度）。 */
export function seedParsed(chips: FileChip[], texts: Record<string, string>): FileChip[] {
  const fresh = chips.filter((c) => c.text === undefined && texts[c.id])
  const caps = allocateBudget(fresh.map((c) => texts[c.id].length), REF_POOL_CHARS)
  const idx = new Map(fresh.map((c, i) => [c.id, i] as const))
  return chips.map((c) =>
    c.text !== undefined || !texts[c.id] ? c : { ...c, text: texts[c.id], cursor: caps[idx.get(c.id)!] }
  )
}

/** 把 chips 按各自已读量合成「参考资料块」：每文件标注已读/总长，全文过 sanitizeInput。
 *  尚未解析（失败或未发送）的 chip 跳过，不产出空块；截断仅内联预算内开头（对齐 Cherry inline cap）。 */
export function buildFilesRef(chips: FileChip[]): string {
  const parts: string[] = []
  for (const c of chips) {
    if (!c.text) continue
    const total = c.text.length
    const end = surrogateSafeEnd(c.text, c.cursor ?? total)
    const body = sanitizeInput(c.text.slice(0, end))
    const note = end < total ? `\n（已截断：已读 ${end}/${total} 字）` : ''
    parts.push(`◆ 文件：${sanitizeInput(c.name)}\n${body}${note}`)
  }
  if (parts.length === 0) return ''
  return `【参考资料·导入文件】以下为导入的文件内容，供分析与出题参考：\n${parts.join('\n\n')}`
}
