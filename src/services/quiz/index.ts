import type { Pack, Question } from '../../types'

/**
 * 刷题引擎（见 PRD 4.7）：10 种题型作答判分 + 刷题序列构建。
 * 客观题自动判分；主观题（简答/案例/论文）由用户对照参考答案自评。
 */

export type QuizMode = 'seq' | 'rand' | 'chapter' | 'wrong'

export interface GradeResult {
  correct: boolean
  /** 得分比例 0-1（匹配/排序按正确项计分） */
  score: number
  /** 主观题：需用户自评 */
  subjective?: boolean
  /** 主观题已有文本但尚未完成自评：展示为待自评，不计分也不进入错题本 */
  pendingSelfReview?: boolean
}

/** 归一化文本：小写、去首尾空格、折叠空白、去常见标点 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：""''（）()\[\]【】,.!?;:'"\-—]/g, '')
}

/** 内置同义词表（填空题容错，见 PRD 4.7；V2 可升级为 AI 判分） */
const SYNONYM_GROUPS: string[][] = [
  ['print', '输出', '打印', 'console.log', 'echo'],
  ['function', '函数', '方法', 'def'],
  ['import', '导入', '引入', 'require'],
  ['list', '列表', '数组', 'array'],
  ['dict', '字典', '映射', 'map'],
  ['tuple', '元组'],
  ['set', '集合'],
  ['loop', '循环', 'for', 'while'],
  ['if', '条件', '判断'],
  ['return', '返回'],
  ['class', '类', '对象模板'],
  ['string', '字符串', 'str'],
  ['integer', '整数', 'int'],
  ['boolean', '布尔', 'bool'],
  ['float', '浮点数'],
  ['variable', '变量'],
  ['keyword', '关键字', '关键词'],
  ['module', '模块'],
  ['package', '包'],
  ['exception', '异常', '错误'],
  ['debug', '调试'],
  ['compile', '编译'],
  ['interpret', '解释'],
]

/** 填空题容错判分：归一化后相等，或互为同义词 */
export function fillMatch(answer: string, user: string): boolean {
  const a = normalize(answer)
  const b = normalize(user)
  if (!a || !b) return false
  if (a === b) return true
  return SYNONYM_GROUPS.some((g) => g.includes(a) && g.includes(b))
}

/** 解析索引数组答案（单选/多选/排序）：'[0,2]' → [0,2] */
export function parseIndexArray(s: string): number[] {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v.map(Number) : []
  } catch {
    return []
  }
}

/** 解析配对答案（匹配题）：'[[0,1],[1,0]]' → [[0,1],[1,0]] */
export function parsePairs(s: string): [number, number][] {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v.map((p: unknown) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [-1, -1])) : []
  } catch {
    return []
  }
}

/** 解析配对答案（匹配题）：'{"right":[...],"pairs":[[0,1],...]}' → { right, pairs } */
export function parseMatchAnswer(s: string): { right: string[]; pairs: [number, number][] } {
  try {
    const v = JSON.parse(s || '{}')
    const right = Array.isArray(v.right) ? v.right.map(String) : []
    const pairs = Array.isArray(v.pairs)
      ? v.pairs.map((p: unknown) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [-1, -1]))
      : []
    return { right, pairs }
  } catch {
    return { right: [], pairs: [] }
  }
}

/**
 * 从题干里拆出内嵌的匹配左右列（旧数据/异常导入的兜底）：
 * 典型形态「……进行匹配。1. On sale 2. Fitting room A. 试衣间 B. 收银机」——
 * 数字序号段为左列，字母序号段为右列，序号前的文字为题干说明（head）。
 * 只识别「数字+点 + 字母+点」都成段出现的结构，否则返回 null 交还原解析，避免误拆正常题干。
 */
export function extractInlineMatch(stem: string): { left: string[]; right: string[]; head: string } | null {
  if (!stem) return null
  const clean = (s: string) => s.replace(/^[\s,，、.．:：;；-]+|[\s,，、.．:：;；-]+$/g, '').trim()
  const lettered: { pos: number; text: string }[] = []
  const reL = /([A-Za-z])\s*[.、．)）]\s*([\s\S]*?)(?=(?:[A-Za-z]\s*[.、．)）]\s)|$)/g
  let m: RegExpExecArray | null
  while ((m = reL.exec(stem))) {
    const t = clean(m[2])
    if (t) lettered.push({ pos: m.index, text: t })
  }
  const right = lettered.map((x) => x.text)
  const left: string[] = []
  // 左列数字项只取「第一个字母右列项之前」的部分，避免把右列内容误收进左列
  const headEnd = lettered.length ? lettered[0].pos : stem.length
  const reN = /(\d+)\s*[.、．)）]\s*([\s\S]*?)(?=(?:\d+\s*[.、．)）])|(?:[A-Za-z]\s*[.、．)）]\s)|$)/g
  let firstNum = -1
  while ((m = reN.exec(stem))) {
    if (m.index >= headEnd) break
    if (firstNum < 0) firstNum = m.index
    const t = clean(m[2])
    if (t) left.push(t)
  }
  if (!left.length || !right.length) return null
  const head = firstNum > 0 ? stem.slice(0, firstNum).trim() : stem.trim()
  return { left, right, head: head || stem.trim() }
}

/** 匹配题左右列与配对解析：优先用结构化数据；缺失时从题干内嵌列表兜底拆分。
 *  returns stem 为去除了内嵌列表后的题干展示文本；incomplete=true 表示题目数据缺列，无法作答（供界面提示）。 */
export function resolveMatchCols(q: Question): { left: string[]; right: string[]; pairs: [number, number][]; stem: string; incomplete?: boolean } {
  const parsed = parseMatchAnswer(q.answer)
  const optLeft = q.options && q.options.length ? q.options : []
  const pairs = parsed.pairs
  // 1) 结构化数据齐全（左列 options + 右列 right）
  if (optLeft.length && parsed.right.length) {
    return { left: optLeft, right: parsed.right, pairs, stem: q.stem }
  }
  // 2) 题干内嵌列表（数字左列 + 字母右列）
  const ex = extractInlineMatch(q.stem)
  if (ex && ex.left.length && ex.right.length) return { left: ex.left, right: ex.right, pairs, stem: ex.head }
  // 3) options 里同时塞了左右两列（后半段带数字前缀的为右列，如 "1. 我喉咙痛。"）
  if (optLeft.length >= 4 && !parsed.right.length) {
    const split = splitHybridOptions(optLeft)
    if (split && split.left.length === split.right.length) {
      return { left: split.left, right: split.right, pairs, stem: q.stem }
    }
  }
  // 4) 只有一边或缺数据 → 不完整，回退展示原状并标记
  const incomplete = !(optLeft.length && parsed.right.length)
  return { left: optLeft, right: parsed.right, pairs, stem: q.stem, incomplete }
}

/** 把「左右两列混在一个 options 数组里」的题目拆开：末尾带数字前缀（"1. xxx"）的为右列，其余为左列。
 *  仅当两列数量相等才拆，避免误判。 */
function splitHybridOptions(opts: string[]): { left: string[]; right: string[] } | null {
  const left: string[] = []
  const right: string[] = []
  for (const o of opts) {
    const t = (o || '').trim()
    const m = t.match(/^(\d+)\s*[.、．)）]\s*(.+)$/)
    if (m) right.push(m[2].trim())
    else left.push(t)
  }
  if (!left.length || !right.length || left.length !== right.length) return null
  return { left, right }
}

/** 客观题判分（见 PRD 4.7 题型与判分规则表） */
export function gradeAnswer(q: Question, userAnswer: string): GradeResult {
  switch (q.type) {
    case 'single': {
      const correct = parseIndexArray(q.answer)
      const user = parseIndexArray(userAnswer)
      const ok = correct.length === 1 && user.length === 1 && correct[0] === user[0]
      return { correct: ok, score: ok ? 1 : 0 }
    }
    case 'multiple': {
      const correct = parseIndexArray(q.answer).sort()
      const user = parseIndexArray(userAnswer).sort()
      const ok = correct.length === user.length && correct.every((v, i) => v === user[i])
      return { correct: ok, score: ok ? 1 : 0 }
    }
    case 'judge': {
      const ok = q.answer.trim().toLowerCase() === userAnswer.trim().toLowerCase()
      return { correct: ok, score: ok ? 1 : 0 }
    }
    case 'fill': {
      const ok = fillMatch(q.answer, userAnswer)
      return { correct: ok, score: ok ? 1 : 0 }
    }
    case 'match': {
      const { pairs: correct } = parseMatchAnswer(q.answer)
      const user = parsePairs(userAnswer)
      const matched = correct.filter(([l, r]) => user.some(([ul, ur]) => ul === l && ur === r)).length
      const score = correct.length ? matched / correct.length : 0
      return { correct: score === 1, score }
    }
    case 'order': {
      const correct = parseIndexArray(q.answer)
      const user = parseIndexArray(userAnswer)
      const matched = correct.filter((v, i) => user[i] === v).length
      const score = correct.length ? matched / correct.length : 0
      return { correct: score === 1, score }
    }
    default:
      // 主观题：参考答案 + 用户自评（AI 判分为 V1.1 增强）
      return { correct: false, score: 0, subjective: true }
  }
}

/** 主观题题型（简答/案例/论文）：作答 + 自评两段式 */
export const SUBJECTIVE_TYPES = ['short', 'case', 'essay']

/**
 * 单题「已作答」统一判定（BUG-1/2 修复）：
 * 计数、提交确认弹窗、提交判分三处必须共用同一口径——
 * 客观题 = 有作答内容；主观题 = 有作答内容且已自评（selfCorrect 为 true/false）。
 * 此前 UI 计数要求主观题「文本+自评」、store 提交只看「文本」、计分又把「未自评」按答错计，
 * 三口径不一致导致「提示未作答但计分」与「自评状态显示已标记但判答错」的矛盾。
 */
export function isEntryAnswered(
  q: Pick<Question, 'type'>,
  entry?: { ua?: string; selfCorrect?: boolean },
): boolean {
  if (!isEntrySubmitted(q, entry)) return false
  if (SUBJECTIVE_TYPES.includes(q.type)) return entry?.selfCorrect != null
  return true
}

/** 单题是否已提交内容：主观题填写文本即可进入「待自评」，不再误报为未作答。 */
export function isEntrySubmitted(
  _q: Pick<Question, 'type'>,
  entry?: { ua?: string; selfCorrect?: boolean },
): boolean {
  return !!entry?.ua?.trim()
}

/** 格式化正确答案用于展示 */
export function formatAnswer(q: Question): string {
  switch (q.type) {
    case 'single':
    case 'multiple': {
      const idx = parseIndexArray(q.answer)
      return idx.map((i) => `${String.fromCharCode(65 + i)}. ${q.options?.[i] ?? ''}`).join('；')
    }
    case 'judge':
      return q.answer === 'true' ? '正确' : '错误'
    case 'fill':
      return q.answer
    case 'match': {
      const { left, right, pairs } = resolveMatchCols(q)
      return pairs.map(([l, r]) => `${left[l] ?? ''} → ${right[r] ?? ''}`).join('；')
    }
    case 'order': {
      const order = parseIndexArray(q.answer)
      return order.map((i) => q.options?.[i] ?? '').join(' → ')
    }
    default:
      return q.answer
  }
}

/** 题型中文名 */
export function typeName(type: string): string {
  const map: Record<string, string> = {
    single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题',
    match: '匹配题', order: '排序题', short: '简答题', case: '案例分析',
    essay: '论文题',
  }
  return map[type] || '题目'
}

/** Fisher-Yates 洗牌 */
export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 构建刷题序列（见 PRD 4.7：顺序 / 随机 / 章节）。
 *  chapterId 只要提供就按章过滤（'chapter' 模式或 seq/rand+章节=章内顺序/随机，章节刷弹窗复用） */
export function buildQuiz(pack: Pack, mode: QuizMode, chapterId?: string): Question[] {
  let questions = pack.questions
  if (chapterId) {
    const ch =
      pack.chapters.find((c) => c.id === chapterId) ??
      pack.chapters.flatMap((c) => c.children ?? []).find((c) => c.id === chapterId)
    if (ch) {
      const kpIds = new Set(ch.knowledge_points.map((k) => k.id))
      questions = pack.questions.filter((q) => q.kp_ids.some((k) => kpIds.has(k)))
    }
  }
  if (mode === 'rand') questions = shuffle(questions)
  return questions
}

/** 排序题显示顺序：把正确顺序打乱供用户重排 */
export function shuffleOrder(q: Question): number[] {
  const n = q.options?.length ?? 0
  const order = Array.from({ length: n }, (_, i) => i)
  return shuffle(order)
}
