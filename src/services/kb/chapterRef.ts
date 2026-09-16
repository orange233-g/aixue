/**
 * 章号定位指令解析（V-EMB 一期，纳入 buildKbRef 第一通道）：
 * 用户问「第 N 章讲了什么」「根据第 3 章到第 5 章出题」时，直接从 sections 按章号取章注入，
 * 不走语义检索（语义检索解决「相关内容在哪章」，章号定位解决「明确第几章」，两者并行互补）。
 * 支持中文/阿拉伯数字、单章/范围（到/至/—/-/~/～）；中文数字支持千/万级（网文几千章）。
 */
import type { KBSection } from '../../types'

/** 1-based 章号区间（from<=to，均已钳制） */
export interface ChapterRange {
  from: number
  to: number
}

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 中文数字转阿拉伯（支持 零〇一两三四五六七八九十百千万 组合，如「第二千零三十二章」→ 2032）；非法返回 null */
export function cnToInt(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (!/^[零〇一二两三四五六七八九十百千万]{1,8}$/.test(s)) return null
  let total = 0
  let section = 0
  let num = 0
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) {
      num = CN_DIGIT[ch]
    } else if (ch === '万') {
      section = (section + (num || 1)) * 10000
      total += section
      section = 0
      num = 0
    } else if (ch === '千') {
      section += (num || 1) * 1000
      num = 0
    } else if (ch === '百') {
      section += (num || 1) * 100
      num = 0
    } else if (ch === '十') {
      section += (num || 1) * 10
      num = 0
    } else {
      return null
    }
  }
  return total + section + num
}

/** 单个「第N章」的 N（阿拉伯/中文数字），非法返回 null */
function parseChapterNo(s: string): number | null {
  const n = cnToInt(s.trim())
  if (n == null || n <= 0) return null
  return n
}

const NO = `[0-9]+|[零〇一二两三四五六七八九十百千万]{1,8}`

/** 编号单位：章/节/条——通用文档（制度/章程/合同按「第X条」组织，书籍按「第X章」），标题解析与 query 解析共用 */
const UNIT = `(?:章|节|条)`
/** 范围-长格式：第A章(到|至|-|—|~|～)(第)?B章 */
const RANGE_RE = new RegExp(
  `第\\s*(${NO})\\s*${UNIT}\\s*(?:到|至|—|－|-|~|～|…)\\s*(?:第)?\\s*(${NO})\\s*${UNIT}`,
)
/** 范围-短格式：第A-B章（A 后无编号单位字） */
const RANGE_SHORT_RE = new RegExp(`第\\s*(${NO})\\s*(?:-|—|－|~|～)\\s*(${NO})\\s*${UNIT}`)
/** 单条/单章/单节：第N条（通用知识库场景——制度/章程/合同按「第X条」组织） */
const SINGLE_RE = new RegExp(`第\\s*(${NO})\\s*${UNIT}`)
/** 兜底（query 内）：无「第」前缀的编号表达，如「1999章节说了什么」「5条内容」——
 *  严格限定 query 开头（去前导空白/标点后第一个词就是数字+编号单位），避免误匹配正文片段；
 *  仅在 query 解析时使用，标题解析保持严格（第N章/条/节）。 */
const SINGLE_FALLBACK_RE = new RegExp(`^[\\s、，。：；！？「」"'《》（）()]*(${NO})\\s*${UNIT}`)

/**
 * 从 query 提取章号指令；无章号返回 null（走语义检索通道）。
 * 范围 A>B 时自动交换；章号过大在 resolve 层钳制。
 */
export function parseChapterRange(query: string): ChapterRange | null {
  if (!query) return null
  const rangeM = query.match(RANGE_RE) ?? query.match(RANGE_SHORT_RE)
  if (rangeM) {
    const a = parseChapterNo(rangeM[1])
    const b = parseChapterNo(rangeM[2])
    if (a == null || b == null) return null
    return { from: Math.min(a, b), to: Math.max(a, b) }
  }
  const singleM = query.match(SINGLE_RE)
  if (singleM) {
    const n = parseChapterNo(singleM[1])
    if (n == null) return null
    return { from: n, to: n }
  }
  // 兜底：无「第」前缀的章号提问（用户实测 case：「1999章节说了什么」未识别 → 误走向量通道）
  const fallbackM = query.match(SINGLE_FALLBACK_RE)
  if (fallbackM) {
    const n = parseChapterNo(fallbackM[1])
    if (n != null) return { from: n, to: n }
  }
  return null
}

/** 从条目标题提取编号（「第三章 启程」→ 3；「第一条 总则」→ 1；「12. 标题」无编号单位 → null） */
export function chapterNoOfTitle(title: string): number | null {
  const m = title?.match(new RegExp(`^第\\s*(${NO})\\s*${UNIT}`))
  if (!m) return null
  return parseChapterNo(m[1])
}

/**
 * 按章号区间定位 sections：优先「标题含第N章」精确匹配，兜底按数组序（1-based：第N章=sections[N-1]）。
 * 区间超界自动钳制；返回空数组 = 无有效章节。
 */
export function resolveChapterSections(sections: KBSection[], range: ChapterRange): KBSection[] {
  if (sections.length === 0) return []
  const titleIdx = new Map<number, number>()
  sections.forEach((s, i) => {
    const n = chapterNoOfTitle(s.title)
    if (n != null && !titleIdx.has(n)) titleIdx.set(n, i)
  })
  const out: KBSection[] = []
  const maxN = Math.max(sections.length, ...titleIdx.keys())
  const from = Math.max(1, range.from)
  const to = Math.min(maxN, range.to)
  for (let n = from; n <= to; n++) {
    const i = titleIdx.get(n) ?? n - 1
    if (i >= 0 && i < sections.length && !out.includes(sections[i])) out.push(sections[i])
  }
  return out
}
