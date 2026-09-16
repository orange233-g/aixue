/**
 * 结构感知分块（借鉴 Cherry splitter.ts 评分制断点 + chunk.ts 单源偏移，见可行性分析 §5.1）。
 * 对清洗后正文按「断点质量打分」切分成语义连贯的 section，只存 {title,start,end} 偏移、不复制正文；
 * 断点分数：标题 h1=100…h6=50、代码块=80、分割线=60、空行(段落)=15、列表项=5、普通换行=0。
 * 在目标切点附近的窗口内找最高分断点截断，绝不在标题/代码块半腰处硬切；找不到断点才退回按字符硬切（并吸附到换行边界）。
 * 无结构纯文本降级：标题兜底「第 N 节」（N 为全局序号）。
 */
import type { KBSection } from '../../types'
import { uid } from '../../utils'

export interface SplitOptions {
  /** 目标 section 字符数（默认 800，落在 PRD 500–1000 区间） */
  targetChars?: number
  /** 寻找断点的最小偏移（低于此不切，避免碎片） */
  minChars?: number
  /** 断点搜索窗口上限（超出仍找不到断点则硬切） */
  maxChars?: number
}

function parseLines(md: string): { start: number; end: number; text: string }[] {
  const lines: { start: number; end: number; text: string }[] = []
  let start = 0
  while (start < md.length) {
    let nl = md.indexOf('\n', start)
    const end = nl === -1 ? md.length : nl + 1
    lines.push({ start, end, text: md.slice(start, nl === -1 ? md.length : nl) })
    if (nl === -1) break
    start = end
  }
  return lines
}

/** 中文数字字符（序数/编号跨「零〇一两…十百千万两」与阿拉伯数字；含千百零两及〇，识别「第二千零三十二章」「第两千四百三十七章」等大小章节号） */
const CN_NUM = '零〇一二三四五六七八九十百千万两'
/** 「第 N 章/节/卷/篇」「序章/前言/引言/附录/结语」（F-05：TXT/DOCX 常见中文章节标题） */
const CHAPTER_TITLE_RE = new RegExp(
  `^(第[${CN_NUM}0-9]+[章节卷篇]|序章|前言|引言|附录|结语)(?:[\\s:.．、]|$)`,
  'm',
)
/** 编号小标题：「一、」「（一）」「1.2」「1.2.3」 等行首编号（F-05） */
const NUMBERED_TITLE_RE = new RegExp(
  `^(?:[${CN_NUM}—]+[、.]|[（(][${CN_NUM}0-9]+[）)][、]?|[0-9]+(?:\\.[0-9]+)+)`,
  'm',
)

/** 行级断点质量分（结构提示越强分越高；普通正文行不是断点） */
function boundaryScore(line: string): number {
  const s = line.trim()
  if (!s) return 15
  const heading = /^(#{1,6})\s+/.exec(s)
  if (heading) return 100 - (heading[1].length - 1) * 10 // h1=100 … h6=50
  if (CHAPTER_TITLE_RE.test(s)) return 95 // 中文章节标题
  if (NUMBERED_TITLE_RE.test(s)) return 70 // 中文/层级编号标题
  if (/^```/.test(s)) return 80
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(s)) return 60
  if (/^([-*+]\s+|\d+[.)、]\s+)/.test(s)) return 5
  return 0
}

/** 提取 section 标题：取段内第一个非空行，剥掉 Markdown/列表标记（保留章节编号前缀，便于范围选题与定位）。
 *  F-05：中文章节标题（第 N 章/一、/1.2 等）本身就是最有用的定位信息，不剥离编号前缀 */
function extractTitle(md: string, start: number, end: number): string {
  const seg = md.slice(start, end)
  for (const l of seg.split('\n')) {
    const s = l.trim()
    if (!s) continue
    const cleaned = s.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim()
    if (cleaned) return cleaned.slice(0, 40)
  }
  return ''
}

/** 块内是否含结构标记（标题/列表行）：纯正文块视为无结构，标题降级为「第 N 节」 */
function hasStructure(md: string, start: number, end: number): boolean {
  const seg = md.slice(start, end)
  return (
    /^(#{1,6}\s|[-*+]\s|\d+[.)、]\s)/m.test(seg) ||
    CHAPTER_TITLE_RE.test(seg) ||
    NUMBERED_TITLE_RE.test(seg)
  )
}

export function splitSections(md: string, opts: SplitOptions = {}): KBSection[] {
  const target = opts.targetChars ?? 800
  const minC = opts.minChars ?? 300
  const maxC = opts.maxChars ?? 1500
  if (!md.trim()) return []

  const lines = parseLines(md)
  const len = md.length
  // 候选断点：行首偏移 → 质量分（只保留可断行）
  const boundaries: { offset: number; score: number }[] = []
  for (const l of lines) {
    const sc = boundaryScore(l.text)
    if (sc > 0) boundaries.push({ offset: l.start, score: sc })
  }

  const sections: KBSection[] = []
  let start = 0
  const push = (from: number, to: number) => {
    // 无结构纯文本降级：标题兜底「第 N 节」（N 为全局序号，含带结构块）
    const title = hasStructure(md, from, to) ? extractTitle(md, from, to) : `第 ${sections.length + 1} 节`
    sections.push({ id: uid('sec_'), title, start: from, end: to })
  }
  const snapHardCut = (from: number): number => {
    // 硬切吸附到换行边界，避免拦腰截断
    const nl = md.indexOf('\n', from)
    if (nl === -1) return len
    return nl + 1
  }
  while (start < len) {
    if (len - start <= maxC) {
      push(start, len)
      break
    }
    const lo = start + minC
    const hi = start + maxC
    let best: { offset: number; score: number } | null = null
    for (const b of boundaries) {
      if (b.offset <= lo || b.offset >= hi) continue
      if (b.offset + 1 >= len) continue
      if (
        !best ||
        b.score > best.score ||
        (b.score === best.score && Math.abs(b.offset - (start + target)) < Math.abs(best.offset - (start + target)))
      ) {
        best = b
      }
    }
    const end = best ? best.offset : snapHardCut(start + target)
    if (end <= start) {
      push(start, len)
      break
    }
    push(start, end)
    start = end
  }
  return sections
}