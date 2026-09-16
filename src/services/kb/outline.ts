/**
 * 阅读器目录树解析（Phase 3 阅读器，见需求「目录/书签/想法」）：
 * 从清洗后正文（bodyText；旧库未迁移时为 consolidated）中解析出带层级的标题结构，并切分「章」用于分页阅读。
 *
 * 标题规范（沿用旧版 AI 整理的编号约定，兼容已迁移的旧库正文）：
 * 一级「## 1. 标题」、二级「## 1.1 标题」、三级「## 1.1.1 标题」、四级「## 1.1.1.1 标题」——全部用 ## 前缀，
 * 层级由编号段数决定。解析时优先按编号定层级；对旧数据/不规范输出做兼容回退：
 * 无编号时按 # 数量定层级（#=1、##=2、###=3、####=4）。
 */
import type { KBSection } from '../../types'

export interface OutlineItem {
  /** 全局标题序号（渲染锚点 id 的索引，形如 h-<index>） */
  index: number
  title: string
  /** 1 级章 / 2 级节 / 3 级小节 */
  level: number
  /** 该标题在正文（bodyText）中的字符偏移 */
  offset: number
  /** 所属源文件名（多文件知识库；由调用方传 fileOf 推断，旧库/未传为 undefined） */
  file?: string
}

/** 章：一级标题为页边界；一页 = 从该一级标题到下一个一级标题之间的全部内容（含子节） */
export interface ReaderChapter {
  index: number
  title: string
  /** 本页内容（含本页一级标题行） */
  markdown: string
  /** 所属源文件名（多文件知识库分页/横幅用） */
  file?: string
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/

/** 中文序数词（含零千百两及〇，识别「第二千零三十二章」「第两千四百三十七章」等大小章节号） */
const ORDER_NUM = '零〇一二三四五六七八九十百千万两'
/** 行首中文章节标题：第N章/回/卷/篇/节 或 楔子/序章 等，后跟分隔符或行尾（区别于 split.ts 的分块粒度） */
const CN_CHAPTER_RE = new RegExp(
  `^(第[${ORDER_NUM}0-9]+[章回卷篇节]|楔子|序章|引子|序言|前言|尾声|后记|番外|外传)(?:[\\s：:．.、，]|$)`,
)
/** 纯文本小说章节标题（如「第二章 青牛镇」）→ 作为一级章边界；无序号之「第N节」名义分块不在此列 */
function plainChapterHeading(line: string): string | null {
  const t = line.trim()
  if (!t || !CN_CHAPTER_RE.test(t)) return null
  return t
}

/** 从标题行文本提取标题内容并判断层级 */
function parseHeading(line: string): { level: number; title: string } | null {
  const m = HEADING_RE.exec(line.trim())
  if (!m) return null
  const body = m[2].trim()
  // 优先按编号定层级：## 1. 标题 / ## 1.1 标题 / ## 1.1.1 标题 / ## 1.1.1.1 标题
  const num = /^(\d+(?:\.\d+)*)[.．、\s]+(.+)$/.exec(body)
  if (num) {
    const segs = num[1].split('.').length
    if (segs >= 1 && segs <= 4) return { level: segs, title: num[2].trim() }
  }
  // 兼容回退：无编号按 # 数量（1~6），但只认前四级（其余视为正文标题）
  const lv = Math.min(4, m[1].length)
  return { level: lv, title: body }
}

/** 解析正文为目录树（按出现顺序，index 即锚点号）。
 *  - Markdown「# 」标题：保留原层级（一级为章页边界）；
 *  - 无 Markdown 标题但正文有明显中文章节（第N章/回/卷 等，小说txt典型）：按章出目录，一页一章；
 *  - 完全无标题的纯文本（去凝练架构常见）再按 sections 兜底：每节一页、页标题 = section.title。 */
export function parseOutline(md: string, sections?: KBSection[], fileOf?: (offset: number) => string | undefined): OutlineItem[] {
  if (!md) return []
  const markdown: OutlineItem[] = []
  const plain: OutlineItem[] = []
  let offset = 0
  for (const raw of md.split('\n')) {
    const h = parseHeading(raw)
    if (h) {
      markdown.push({ index: markdown.length, title: h.title, level: h.level, offset, file: fileOf?.(offset) })
    } else {
      const pc = plainChapterHeading(raw)
      if (pc) plain.push({ index: plain.length, title: pc, level: 1, offset, file: fileOf?.(offset) })
    }
    offset += raw.length + 1
  }
  // 有 Markdown 标题：优先用它（层级结构），无一级时把首个二级当一级页边界
  if (markdown.length > 0) {
    if (!markdown.some((o) => o.level === 1)) for (const o of markdown) o.level = 1
    return markdown
  }
  // 无 Markdown 标题但章节明确（≥2 章，过滤孤立误命中）→ 按章出目录
  if (plain.length >= 2) return plain
  // 完全无标题：sections 生成分块目录（level=1 → splitChapters 自然按节分页）
  if (sections && sections.length > 0) {
    return sections.map((sec, i) => ({ index: i, title: sec.title || `第 ${i + 1} 节`, level: 1, offset: sec.start, file: sec.file }))
  }
  return []
}

/** 判断一段 markdown 是否只有标题行（没有正文/列表/段落），用于剔除「文档总标题」「只有卷名」这类空章。
 *  标题行包括：Markdown `# ` 标题、以及纯文本行首章节/卷标题（第N卷/章/回/篇/节、楔子/序章等）。
 *  否则纯文本小说的「第一卷 七玄门风云」这种只有一行卷名的切片会被当成有正文，渲染成一个「只有标题、正文空白」的空首页。 */
export function hasBody(md: string): boolean {
  for (const raw of md.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    if (/^(#{1,6})\s+/.test(t)) continue
    if (plainChapterHeading(t)) continue
    return true
  }
  return false
}

/** 把正文切成章（一级标题为边界）；无一级标题时整篇一页。
 *  RC-06 深化：多级标题书（如「# 书名 / ## 序章 / ## 第一卷 / ## 第N章」的小说）一级只有
 *  书名+卷，幸存章 ≤2 → 整本变成 1-2 个巨型章页，目录/翻页形同虚设。此时若二级标题充足
 *  （≥3 个），降级用二级标题做章边界（第N章本身成为章页，目录点击精确命中）。
 *  RC-06 终版扩展：一级稍多（≤6）但二级标题密集（≥ 一级 3 倍，如「书名+3 卷」各含 15 章）
 *  同样降级——否则目录点二级章名只会解析回所在卷（target===idx 原地不动）、标红/页码停在卷级。
 *  3 倍阈值避免把「章+节」结构书的正常章级切分打碎（如 3 章 × 1-2 节仍按章切）。 */
export function splitChapters(md: string, outline: OutlineItem[]): ReaderChapter[] {
  if (!md.trim()) return []
  let tops = outline.filter((o) => o.level === 1)
  if (tops.length === 0) return [{ index: 0, title: '', markdown: md }]
  const l2 = outline.filter((o) => o.level === 2)
  const level1Body = (items: OutlineItem[]) => {
    let n = 0
    for (let i = 0; i < items.length; i++) {
      const end = i + 1 < items.length ? items[i + 1].offset : md.length
      if (hasBody(md.slice(items[i].offset, end))) n++
    }
    return n
  }
  if (tops.length <= 2) {
    if (l2.length >= 3 && level1Body(tops) <= 2) tops = l2
  } else if (tops.length <= 6 && l2.length >= tops.length * 3) {
    tops = l2
  }
  const chapters: ReaderChapter[] = []
  for (let i = 0; i < tops.length; i++) {
    const start = tops[i].offset
    const end = i + 1 < tops.length ? tops[i + 1].offset : md.length
    const markdown = md.slice(start, end)
    // 跳过只有标题、没有正文字节的内容段（典型是文档开头用 `# ` 写的总标题，避免渲染成空白首页）
    if (!hasBody(markdown)) continue
    chapters.push({ index: tops[i].index, title: tops[i].title, markdown, file: tops[i].file })
  }
  // 全部被剔除（整篇只有标题）时兜底：整篇一页
  if (chapters.length === 0) return [{ index: 0, title: '', markdown: md }]
  return chapters
}

/**
 * 目录点击 → 目标章下标（viewChapters 下标）。
 * RC-06：目录树展示的是全部标题（含二级及以下、以及被 hasBody 剔除的「只有标题行」章，
 * 如纯文本小说的「第N卷」只有一行卷名）——这些项在 viewChapters 里没有 index 相同的章，
 * 此前 findIndex 落空 → 静默不跳。解析规则：
 * - 恰好是章边界 → 原样命中；
 * - 二级及以下标题 → 归入其**所在章**（向前找最近的一个真实存在的章边界）；
 * - 被剔除的一级标题（只有标题行）→ 其内容从下一个章开始（向后找最近的真实章）；
 * - 都找不到（目录与章完全错位）→ 兜底第 0 章；viewChapters 为空返回 -1（调用方按原地处理）。
 */
export function resolveTocTarget(
  viewOutline: OutlineItem[],
  viewChapters: ReaderChapter[],
  outlineIndex: number,
): number {
  if (viewChapters.length === 0) return -1
  const exact = viewChapters.findIndex((c) => c.index === outlineIndex)
  if (exact >= 0) return exact
  const oi = viewOutline.findIndex((o) => o.index === outlineIndex)
  if (oi >= 0) {
    const clickedLevel = viewOutline[oi].level
    if (clickedLevel >= 2) {
      // 二级及以下：属于上方最近的一级章
      for (let i = oi; i >= 0; i--) {
        const hit = viewChapters.findIndex((c) => c.index === viewOutline[i].index)
        if (hit >= 0) return hit
      }
    } else {
      // 被剔除的一级标题：内容从下一个真实章开始
      for (let i = oi; i < viewOutline.length; i++) {
        const hit = viewChapters.findIndex((c) => c.index === viewOutline[i].index)
        if (hit >= 0) return hit
      }
    }
  }
  return 0
}
