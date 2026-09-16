import { AIError } from './types'
import type { Question, QuestionTypeId } from '../types'
import { uid } from '../utils'

/**
 * 模型输出解析与容错（见 PRD 10.5）：
 * 剥离代码块标记 → 尝试 JSON 解析 → 截断补全后重试 → 仍失败抛 PARSE_FAILED。
 */

/** 剥离 ```json ... ``` 或 ``` ... ``` 代码块标记 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return m ? m[1].trim() : trimmed
}

/**
 * 补全被截断的 JSON：
 * 去掉末尾不完整 token → 若字符串未闭合则截断到最后一个引号 → 补齐缺失的右括号。
 */
export function repairJSON(text: string): string {
  let s = text.trim().replace(/[,:\s]+$/, '')

  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const open = stack.pop()
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) break
    }
  }

  // 字符串未闭合：丢弃末尾不完整的字符串内容
  if (inString) {
    const lastQuote = s.lastIndexOf('"')
    if (lastQuote >= 0) s = s.slice(0, lastQuote + 1)
  }

  // 补齐未闭合的右括号（后进先出）
  while (stack.length) {
    const open = stack.pop()
    s += open === '{' ? '}' : ']'
  }
  return s
}

/** 解析模型输出为 JSON；失败抛 PARSE_FAILED（调用方按 10.6 整批重试 ≤1 次） */
export function parseJSON<T>(text: string): T {
  const cleaned = stripCodeFence(text)
  try {
    return JSON.parse(cleaned) as T
  } catch {
    try {
      return JSON.parse(repairJSON(cleaned)) as T
    } catch {
      throw new AIError('PARSE_FAILED', '模型输出不是有效 JSON')
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Markdown 出题格式解析（见 PRD：JSON 严格格式在长文本题型上易解析失败，
 *  改为模型天然擅长的 md 结构，截断只丢最后一道不完整题，其余保留）。
 * ------------------------------------------------------------------ */

const TYPE_BY_NAME: Record<string, QuestionTypeId> = {
  单选题: 'single', 多选题: 'multiple', 判断题: 'judge', 填空题: 'fill',
  匹配题: 'match', 排序题: 'order', 简答题: 'short', 案例分析题: 'case',
  案例分析: 'case', 案例题: 'case', 论文题: 'essay', 论述题: 'essay',
  single: 'single', multiple: 'multiple', judge: 'judge', fill: 'fill',
  match: 'match', order: 'order', short: 'short', case: 'case', essay: 'essay',
}

export const MD_FIELD_NAMES = [
  '题型', '材料', '题干', '左列', '选项', '右列', '答案', '参考答案', '解析', '知识点', '难度',
]

/** 匹配题右列行解析：去掉行首序号/字母标记（"1. xxx" / "① xxx" / "A. xxx"）取正文 */
function parseMdRight(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const t = (line || '').trim()
    if (!t) continue
    const m = t.match(/^(?:[0-9]+|[一二三四五六七八九十]+|[A-Za-z])\s*[.、．):：]\s*(.+)$/)
    out.push((m ? m[1] : t).trim())
  }
  return out.filter(Boolean)
}

/** 匹配题答案归一：把 md 的配对关系（「右列：」+「答案：A-1,B-2」或「左→右」）转成应用约定的 {"right":[...],"pairs":[[l,r],...]}。
 *  已带 right 结构的 JSON / 无法解析的原始文本原样返回（后两者右列为空时展示页会降级但不崩溃）。 */
function normalizeMatchAnswer(answerText: string, options: string[], rightLines: string[]): string {
  const a = (answerText || '').trim()
  if (!a) return a
  // 已是约定 JSON 结构（含 right）：导出再导入 / demo / JSON 路径直接复用，不二次改写
  try {
    const v = JSON.parse(a)
    if (v && Array.isArray(v.right)) return a
  } catch {
    /* 非 JSON，走恢复解析 */
  }

  const norm = (s: string) => s.trim().replace(/\s+/g, '')
  const idxOf = (text: string, arr: string[]): number => {
    const t = norm(text)
    if (!t || !Array.isArray(arr)) return -1
    return arr.findIndex((x) => norm(x) === t)
  }
  const prepareRight = (arr: string[], val: string): number => {
    const t = norm(val)
    const i = idxOf(t, arr)
    if (i >= 0) return i
    arr.push(t)
    return arr.length - 1
  }

  let right = parseMdRight(rightLines)
  const pairs: [number, number][] = []
  const segs = a.split(/[；;，,、\n]+/).map((s) => s.trim()).filter(Boolean)
  for (const seg of segs) {
    // 左文本 → 右文本（箭头分隔，最常见；右列标签可从中提取）
    const am = seg.match(/^(.+?)\s*(?:→|->|—|→)\s*(.+)$/)
    if (am) {
      const lToken = am[1].trim()
      const rToken = am[2].trim()
      let li = idxOf(lToken, options)
      if (li < 0) li = letterIndex(lToken)
      if (li < 0 && /^\d+$/.test(lToken)) li = Number(lToken) - 1
      let ri = /^\d+$/.test(rToken) ? Number(rToken) - 1 : idxOf(rToken, right)
      if (ri < 0) ri = letterIndex(rToken)
      if (ri < 0) ri = prepareRight(right, rToken)
      if (li >= 0 && ri >= 0) pairs.push([li, ri])
      continue
    }
    // 字母/序号-序号：如 "A-1,B-2"
    const dm = seg.match(/^([A-Za-z0-9])\s*[-—:：]\s*(\d+)$/)
    if (dm) {
      let li = letterIndex(dm[1])
      if (li < 0 && /^\d+$/.test(dm[1])) li = Number(dm[1]) - 1
      const ri = Number(dm[2]) - 1
      if (li >= 0 && ri >= 0) pairs.push([li, ri])
    }
  }
  if (pairs.length) return JSON.stringify({ right, pairs })
  return a
}

/** 按「题型：」/「===」/「## 」等标记切分为一题一块 */
function splitMdBlocks(text: string): string[] {
  const t = stripCodeFence(text || '')
  const blocks: string[] = []
  let cur: string[] = []
  for (const line of t.split('\n')) {
    const s = line.trim()
    if (/^题型\s*[:：]/.test(s) || /^={3,}\s*第/.test(s) || /^#{2,}\s*第/.test(s)) {
      if (cur.length) blocks.push(cur.join('\n'))
      cur = []
    }
    cur.push(line)
  }
  if (cur.length) blocks.push(cur.join('\n'))
  return blocks
}

/** 从块内按「字段名：」前缀提取各字段到多行数组 */
function extractMdFields(block: string): Record<string, string[]> {
  const fields: Record<string, string[]> = Object.create(null)
  let current: string | null = null
  const push = () => {
    if (current) fields[current] = fields[current] ?? []
  }
  for (const line of block.split('\n')) {
    const m = line.match(/^(\*\*)?(题型|材料|题干|左列|选项|右列|答案|参考答案|解析|知识点|难度)(\*\*)?\s*[:：]\s*(.*)$/)
    if (m) {
      push()
      current = m[2]
      const rest = m[4].trim()
      fields[current] = fields[current] ?? []
      // 值同行（如「题型：单选题」）直接存入；值在后续行（如「选项：」）则当前字段进入块模式
      if (rest) fields[current].push(rest)
    } else if (current) {
      fields[current].push(line)
    }
  }
  push()
  return fields
}

function parseMdOptions(lines: string[]): string[] {
  const opts: string[] = []
  for (const line of lines) {
    const m = line.trim().match(/^([A-Za-z])[.、．)\s]+(.+)$/)
    if (m) {
      const idx = m[1].toUpperCase().charCodeAt(0) - 65
      opts[idx] = m[2].trim()
    } else if (line.trim()) {
      opts.push(line.trim())
    }
  }
  return opts.filter(Boolean)
}

/** 排序题兼容模型把 ①②③…条目直接写进题干、未单列「选项：」的格式。 */
function parseInlineOrderOptions(stem: string): string[] {
  const matches = [...stem.matchAll(/([①-⑳])\s*([\s\S]*?)(?=\s*[①-⑳]|$)/g)]
  return matches.map((m) => m[2].trim().replace(/[。；;]+$/u, '')).filter(Boolean)
}

function letterIndex(letter: string): number {
  const c = (letter || '').trim().toUpperCase().charCodeAt(0)
  return c >= 65 && c <= 90 ? c - 65 : -1
}

/** 判断题答案 → 布尔。模型输出的「对/错、正确/不正确、是/否、√/×、T/F、Y/N、1/0」及带句号变体统一归一 */
function normalizeJudgement(a: string): string {
  const s = a.trim().replace(/[。.．!！,，、\s]+$/u, '')
  if (/^(正确|对|是|true|t|yes|y|√|✓|✔|1)$/iu.test(s)) return 'true'
  if (/^(错误|错|否|不正确|不对|不是|false|f|no|n|×|✗|✘|0)$/iu.test(s)) return 'false'
  return a
}

/** 判断题答案若为字母（模型常把判断题出成「A.正确 B.错误」），按选项内容解析 A/B 哪个是"对" */
function judgeByLetter(letter: string, options: string[]): string {
  const clean = (s: string) => (s ?? '').trim().replace(/[。.．!！,，、\s]+$/u, '')
  const isTrue = /^(正确|对|是|true|√|✓|✔|yes|y|t)$/iu
  const isFalse = /^(错误|错|否|不正确|不对|不是|false|×|✗|✘|no|n|f)$/iu
  const idx = letterIndex(letter)
  if (idx < 0 || !options[idx]) return letter
  if (isTrue.test(clean(options[idx]))) return 'true'
  if (isFalse.test(clean(options[idx]))) return 'false'
  return letter
}

/** 排序题答案归一：应用内部统一保存为 0-based 选项索引的完整排列。 */
function normalizeOrderAnswer(answerText: string, options: string[]): string {
  const n = options.length
  if (!n) return answerText

  const normalizeOption = (s: string) =>
    s
      .trim()
      .replace(/^[「『【（(]+|[」』】）)]+$/g, '')
      .replace(/\s+/g, '')
      .replace(/[。.．,，、;；:：]+$/u, '')

  const isPermutation = (indices: number[], offset: 0 | 1): boolean => {
    if (indices.length !== n) return false
    const normalized = indices.map((i) => i - offset)
    return normalized.every((i) => i >= 0 && i < n) && new Set(normalized).size === n
  }

  const toCanonical = (indices: number[]): string => {
    if (isPermutation(indices, 0)) return JSON.stringify(indices)
    if (isPermutation(indices, 1)) return JSON.stringify(indices.map((i) => i - 1))
    return answerText
  }

  const parseOrderNumber = (token: string): number | null => {
    const t = normalizeOption(token)
    if (/^\d+$/.test(t)) return Number(t)
    if (/^[①-⑳]$/.test(t)) return t.codePointAt(0)! - '①'.codePointAt(0)! + 1
    return null
  }

  const resolveToken = (token: string): number => {
    const t = normalizeOption(token)
    if (!t) return -1
    const exact = options.findIndex((option) => normalizeOption(option) === t)
    if (exact >= 0) return exact
    if (/^[A-Za-z]$/.test(t)) return letterIndex(t)
    const marker = t.match(/^([A-Za-z])[.、．):：-]/)
    return marker ? letterIndex(marker[1]) : -1
  }

  const raw = answerText.trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      if (parsed.every((v) => typeof v === 'number' && Number.isInteger(v))) {
        return toCanonical(parsed)
      }
      if (parsed.every((v) => typeof v === 'string')) {
        const tokens = parsed as string[]
        const numbers = tokens.map(parseOrderNumber)
        if (numbers.every((v): v is number => v != null)) return toCanonical(numbers)
        const indices = tokens.map(resolveToken)
        if (indices.every((i) => i >= 0)) return toCanonical(indices)
      }
    }
  } catch {
    // Markdown 答案通常不是 JSON，继续按分隔符解析。
  }

  const body = raw.replace(/^(?:答案|正确(?:顺序|排列)?|排序)\s*[:：=]\s*/u, '')
  const tokens = body
    .split(/(?:,|，|、|;|；|\r?\n|→|➜|->|=>|＞|>)+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) return answerText
  const numbers = tokens.map(parseOrderNumber)
  if (numbers.every((v): v is number => v != null)) return toCanonical(numbers)
  const indices = tokens.map(resolveToken)
  return indices.every((i) => i >= 0) ? toCanonical(indices) : answerText
}

/** 把 md 答案文本转成应用约定格式（answer 为字符串，见 normalizeAnswer） */
function normalizeMdAnswer(type: QuestionTypeId, answerText: string, options: string[]): string {
  const a = (answerText || '').trim()
  if (!a) return ''
  if (type === 'judge') {
    const byLetter = judgeByLetter(a, options)
    if (byLetter === 'true' || byLetter === 'false') return byLetter
    return normalizeJudgement(a)
  }
  if (type === 'single' || type === 'multiple') {
    const letters = a.split(/[,，、\s]+/).filter(Boolean)
    const idx = letters.map(letterIndex).filter((i) => i >= 0)
    if (idx.length) return JSON.stringify(type === 'single' ? [idx[0]] : idx)
    return a
  }
  if (type === 'order') return normalizeOrderAnswer(a, options)
  return a
}

function parseMdDifficulty(lines: string[]): 1 | 2 | 3 {
  const txt = (lines.join('') || '').trim()
  const n = Number(txt)
  if (n === 1 || n === 2 || n === 3) return n
  if (/难/.test(txt)) return 3
  if (/易|简单/.test(txt)) return 1
  return 2
}

/** 解析单块 md 为 Question；缺题型/题干/答案视为不完整（多为截断残段）→ 丢弃 */
function parseMdBlock(block: string): Question | null {
  const f = extractMdFields(block)
  const collect = (k: string) => (f[k] ?? []).join('\n').trim()
  const typeName = collect('题型')
  const type = TYPE_BY_NAME[typeName]
  const stem = collect('题干')
  const answerText = collect('答案') || collect('参考答案')
  if (!type || !stem || !answerText) return null
  // 匹配题左列放「选项：」（或别名「左列：」），右列放「右列：」
  const optionLines = (f['选项'] ?? []).length ? f['选项'] : (f['左列'] ?? [])
  const options = parseMdOptions(optionLines)
  const orderOptions = type === 'order' && !options.length ? parseInlineOrderOptions(stem) : options
  const kpText = collect('知识点')
  const answer =
    type === 'match'
      ? normalizeMatchAnswer(answerText, options, f['右列'] ?? [])
      : normalizeMdAnswer(type, answerText, orderOptions)
  return {
    id: uid('q_'),
    type,
    stem,
    material: collect('材料') || undefined,
    options: orderOptions.length ? orderOptions : undefined,
    answer,
    explanation: collect('解析'),
    kp_ids: kpText ? kpText.split(/[,，\s]+/).filter(Boolean) : [],
    difficulty: parseMdDifficulty(f['难度'] ?? []),
  }
}

/** 解析模型输出（Markdown 格式）为题目数组；截断时最后一块不完整会被自动丢弃 */
export function parseMarkdown(text: string): Question[] {
  // RC-08：先归一换行——Windows CRLF 文件的行尾 \r 是 JS 行终止符，「字段：值\r」的字段提取正则
  // `(.*)$` 无法收尾导致整条失配，42 块全被当「不完整残段」丢弃（真实真题文件导入全灭的根因）。
  // \r 单独成行尾（旧 Mac）一并处理；后续所有按行切分/逐行匹配都在 LF 上进行。
  const normalized = (text || '').replace(/\r\n?/g, '\n')
  if (!normalized.trim()) throw new AIError('PARSE_FAILED', '未识别到题目，请检查文件格式')
  const questions = splitMdBlocks(normalized)
    .map(parseMdBlock)
    .filter((q): q is Question => q !== null)
  if (!questions.length) throw new AIError('PARSE_FAILED', '未识别到题目，请检查文件格式')
  return questions
}
