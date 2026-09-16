/**
 * 源文件 → 段落切片（F7 防线①，见可行性分析 §4.5）：把每份解析后的源文本按段落切成
 * 带 span 偏移的片段集，作为「原文证据层」落库；回源时可定位到 {file + span}，聚合可还原全文。
 * 纯本地、零依赖。
 */
import type { KBSourceText } from '../../types'

export interface SourceSlice {
  span: { start: number; end: number }
  text: string
}

/** 单个 span 段落的最大字符数，超长按句读边界硬切，避免巨型段落影响回源定位与补提 snippet */
const MAX_SPAN_CHARS = 2000

/** 从 from 向前找最近的句读边界（。！？；或换行），找不到则原样返回 from */
function cutAtSentence(text: string, from: number): number {
  if (from >= text.length) return text.length
  const lo = Math.max(0, from - 400)
  for (let p = from; p >= lo; p--) {
    const ch = text[p]
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '\n') return p + 1
  }
  return from
}

/** 把一段源文本按「空行分段、超长按句读再切」切成 span 切片（span 为原文本偏移） */
export function splitSourceText(text: string, maxSpan = MAX_SPAN_CHARS): SourceSlice[] {
  if (!text) return []
  const out: SourceSlice[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    // 跳过前导空白（含换行/空格）
    while (i < n && (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t')) i++
    if (i >= n) break
    let end: number
    const blank = text.indexOf('\n\n', i)
    if (blank !== -1 && blank - i <= maxSpan) {
      end = blank
    } else if (n - i <= maxSpan) {
      end = n
    } else {
      end = cutAtSentence(text, i + maxSpan)
      if (end <= i) end = Math.min(n, i + maxSpan)
    }
    const seg = text.slice(i, end).trim()
    if (seg) out.push({ span: { start: i, end }, text: seg })
    i = end
  }
  return out
}

/** 把分片的 sourcesText 按 file 聚合还原为每份文件的全文（按 span.start 排序拼接）。
 *  切片间以 '\n\n' 衔接：splitSourceText 切分时吞掉了空行，单 '\n' 拼接会抹掉段落边界，
 *  导致下游分块拿不到空行断点（15 分）而全部退化为硬切。 */
export function aggregateSourceTexts(sourcesText: KBSourceText[]): { name: string; text: string }[] {
  const map = new Map<string, KBSourceText[]>()
  for (const s of sourcesText) {
    const arr = map.get(s.file)
    if (arr) arr.push(s)
    else map.set(s.file, [s])
  }
  return [...map.entries()].map(([name, arr]) => {
    const sorted = arr.slice().sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0))
    return { name, text: sorted.map((s) => s.text).join('\n\n') }
  })
}