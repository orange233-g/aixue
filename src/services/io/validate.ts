/**
 * S-02 / V2-F01 / V2-S05 / 6.83：导入文件全量运行时校验 + 规范化。
 * 对每个 pack / question / knowledgeBase / learning / wrongs / answer / usage / category /
 * preference 做 schema 校验与字段规范化，并施加数量、字符串长度、总题数、章节深度、ID
 * 唯一性上限，杜绝恶意/损坏备份绕过 validation 层污染 IndexedDB。
 * 6.83 起分两层：**内容级**问题（单题校验不过/题型非法/ID 重复/错题记录损坏）跳过并留痕
 * （sanitizeImportDetailed 的 skipped，预览页向用户展示），不再「一题错全包拒」；
 * **结构/资源级**问题（超上限、重复题包 ID、层级过深、文本超预算）依旧抛错中止——
 * 超量数组报错而非静默截断。全部校验通过后才进入单个跨 store 事务提交（applyImport）。
 */
import type {
  AnswerRecord,
  ExportFile,
  KBDoc,
  KBSection,
  KBSourceText,
  KnowledgePoint,
  LearningState,
  Pack,
  Preferences,
  QuestionTypeId,
  Question,
  UsageRecord,
  WrongRecord,
} from '../../types'
import { QUESTION_TYPES } from '../../types'
import { validateQuestion } from '../validation'
import { uid } from '../../utils'
import { RECENT_WINDOW } from '../learning'

/** 导入上限（防资源耗尽：超大备份/数组；超上限一律抛错，不静默截断——V2-S05） */
const MAX_PACKS = 200
const MAX_QUESTIONS_PER_PACK = 5000
const MAX_TOTAL_QUESTIONS = 20000
const MAX_LEARNING = 5000
const MAX_WRONGS = 5000
const MAX_ANSWERS = 50000
const MAX_USAGE = 5000
const MAX_KB = 500
const MAX_CATEGORIES = 500
const MAX_CHAPTER_DEPTH = 8
const MAX_STR_LEN = 200_000
/** 全文件字符串总长度预算（V2-S05：粗粒度防超大字符串耗尽内存，按全部字符串长度累加） */
export const MAX_TOTAL_STR_CHARS = 30_000_000
/** 选择导入文件的体积上限（V2-S05，选文件后应先检查再读入，见 utils/pickFile） */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024
/** 字符串总量遍历的最大 JSON 层级（V3-S07）：超过即受控报错，防恶意深层嵌套先触发调用栈溢出 */
const MAX_ESTIMATE_DEPTH = 100
/** 知识库内部数组上限：超限一律抛错，与顶层数组“超限直接拒绝”口径一致（V3-S07，不静默截断） */
const MAX_KB_SOURCE_FILES = 500
const MAX_KB_SOURCES_TEXT = 5000
const MAX_KB_SECTIONS = 10000

const valTypeIds = new Set<string>(QUESTION_TYPES.map((t) => t.id))
const VALID_LEARNING_STATES = new Set<string>(['未学习', '学习中', '基本掌握', '已掌握'])

function isStr(v: unknown): v is string {
  return typeof v === 'string'
}

function str(v: unknown, max = MAX_STR_LEN): string {
  if (!isStr(v)) return ''
  return v.slice(0, max)
}

function num(v: unknown, def = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : def
}

function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = num(v, def)
  if (n < min) return min
  if (n > max) return max
  return n
}

function strArr(v: unknown, max = MAX_STR_LEN): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const s = isStr(item) ? item : ''
    const t = s.slice(0, max)
    if (t) out.push(t)
  }
  return out.slice(0, 1000)
}

/** 校验并规范化一道题目；非法则抛错（跳过策略由调用方 catch 留痕，见 sanitizePack） */
function sanitizeQuestion(raw: unknown, qIndex: number): Question {
  if (!raw || typeof raw !== 'object') throw new Error(`第 ${qIndex + 1} 题格式无效`)
  const r = raw as Record<string, unknown>
  const type = r.type
  if (!valTypeIds.has(type as string)) throw new Error(`第 ${qIndex + 1} 题题型非法: ${String(type)}`)
  const q: Question = {
    id: str(r.id, 100) || uid('q_'),
    type: type as QuestionTypeId,
    stem: str(r.stem),
    answer: str(r.answer),
    explanation: str(r.explanation),
    kp_ids: strArr(r.kp_ids, 100),
    difficulty: (r.difficulty === 1 || r.difficulty === 2 || r.difficulty === 3 ? r.difficulty : 1) as 1 | 2 | 3,
  }
  if (r.options !== undefined) q.options = strArr(r.options).slice(0, 26)
  if (r.material !== undefined) q.material = str(r.material)
  if (typeof r.score === 'number') q.score = r.score
  // 6.83 补充：本项目数据模型 judge 携带「正确/错误」选项对（hasOptions=true，刷题页按选项渲染），
  // 外部来源的判断题常不带 options——缺失时补默认值，避免合法判断题被误判「选择题缺少选项」
  if (q.type === 'judge' && (!q.options || q.options.length < 2)) q.options = ['正确', '错误']
  const issues = validateQuestion(q)
  if (issues.length) throw new Error(`第 ${qIndex + 1} 题校验不通过：${issues.join('、')}`)
  return q
}

function sanitizeKp(raw: unknown): KnowledgePoint {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    id: str(r.id, 100) || uid('kp_'),
    title: str(r.title, 1000) || '未命名知识点',
    content: str(r.content),
    examples: strArr(r.examples),
    pitfalls: strArr(r.pitfalls),
  }
}

function sanitizeChapter(
  raw: unknown,
  qIndexesNeedDirect: boolean,
  depth = 0,
): Pack['chapters'][number] {
  // V2-S05：章节递归深度上限，防恶意深嵌套导致调用栈溢出
  if (depth > MAX_CHAPTER_DEPTH) throw new Error('章节嵌套层级超过上限')
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kpArr = Array.isArray(r.knowledge_points) ? r.knowledge_points : []
  return {
    id: str(r.id, 100) || uid('ch_'),
    title: str(r.title, 1000) || '',
    summary: str(r.summary),
    knowledge_points: kpArr.slice(0, 2000).map(sanitizeKp),
    question_ids: strArr(r.question_ids, 100).slice(0, 5000),
    ...(qIndexesNeedDirect && r.children !== undefined
      ? { children: Array.isArray(r.children) ? r.children.map((c) => sanitizeChapter(c, false, depth + 1)) : [] }
      : {}),
  }
}

/**
 * 6.83：题目级跳过留痕。题目级问题（校验不过/题型非法/格式无效/ID 重复）不再整包拒绝，
 * 跳过该题并记录明细（预览页展示，防静默丢数据）；结构/资源类问题（超上限、重复题包 ID、
 * 层级过深、文本超预算）依旧整体抛错——安全防线不放宽，只把「坏内容」与「坏结构」区分开。
 */
export interface QuestionSkip {
  packTitle: string
  /** 1 起始的文件内题号（与界面「第 N 题」口径一致） */
  index: number
  reason: string
}

export interface ImportSkips {
  /** 被跳过题目明细（样本上限 50 条，全量计数看 questionTotal） */
  questions: QuestionSkip[]
  questionTotal: number
  /** 整包跳过（包内题目全部不合法；0 题空包不算，保持旧行为可导入） */
  packs: { title: string; reason: string }[]
  /** 跳过的错题记录数（内嵌题目不合法或引用不一致） */
  wrongs: number
}

export function emptyImportSkips(): ImportSkips {
  return { questions: [], questionTotal: 0, packs: [], wrongs: 0 }
}

const MAX_SKIP_SAMPLES = 50

/** 校验并规范化一个题包；包内题目全不合法时返回 null 并在 skips.packs 留痕 */
export function sanitizePack(raw: unknown, seenQIds?: Set<string>, skips?: ImportSkips): Pack | null {
  if (!raw || typeof raw !== 'object') throw new Error('题包格式无效')
  const r = raw as Record<string, unknown>
  const rawQ = Array.isArray(r.questions) ? r.questions : []
  if (rawQ.length > MAX_QUESTIONS_PER_PACK) throw new Error(`题包题目数超过上限 ${MAX_QUESTIONS_PER_PACK}`)
  const packTitle = str(r.title, 500) || '未命名学习本'
  const recordSkip = (index: number, reason: string) => {
    if (!skips) return
    skips.questionTotal++
    if (skips.questions.length < MAX_SKIP_SAMPLES) {
      skips.questions.push({ packTitle, index, reason })
    }
  }
  const questions: Question[] = []
  const droppedIds = new Set<string>()
  const localIds = new Set<string>()
  for (let i = 0; i < rawQ.length; i++) {
    let q: Question
    try {
      q = sanitizeQuestion(rawQ[i], i)
    } catch (e) {
      recordSkip(i + 1, e instanceof Error ? e.message : String(e))
      // 解析中断的题其原始 id 仍可能被章节 question_ids 引用，一并剔除防悬空引用
      const rawId = rawQ[i] && typeof rawQ[i] === 'object' ? (rawQ[i] as Record<string, unknown>).id : undefined
      if (typeof rawId === 'string' && rawId) droppedIds.add(rawId.slice(0, 100))
      continue
    }
    // V2-S05：题包内题目 ID 唯一性，防重复 key 覆盖错题绑定歧义；V4-F01：跨题包题目 ID 也必须唯一——
    // 6.83 起从「抛错中止」放宽为「跳后来者并留痕」：库内题目 id 仍唯一，引用完整性不破坏。
    if (localIds.has(q.id)) {
      recordSkip(i + 1, `题目 ID 重复（${q.id}），已跳过`)
      droppedIds.add(q.id)
      continue
    }
    if (seenQIds?.has(q.id)) {
      recordSkip(i + 1, `题目 ID 与文件内其他题包重复（${q.id}），已跳过`)
      droppedIds.add(q.id)
      continue
    }
    localIds.add(q.id)
    seenQIds?.add(q.id)
    questions.push(q)
  }
  // 全部题目不合法 → 整包跳过（0 题空包不算坏包，保持旧行为）
  if (rawQ.length > 0 && questions.length === 0) {
    skips?.packs.push({ title: packTitle, reason: `共 ${rawQ.length} 题全部不合法` })
    return null
  }
  const chaptersRaw = Array.isArray(r.chapters) ? r.chapters : []
  let chapters = chaptersRaw.slice(0, 2000).map((c) => sanitizeChapter(c, true))
  if (droppedIds.size) {
    // 章节引用同步剔除被跳过的题目，不留悬空 question_id（章节刷/预览按 id 取题）
    const prune = (c: Pack['chapters'][number]): Pack['chapters'][number] => ({
      ...c,
      question_ids: c.question_ids.filter((id) => !droppedIds.has(id)),
      children: c.children?.map(prune),
    })
    chapters = chapters.map(prune)
  }
  const metaRaw = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>
  return {
    id: str(r.id, 100) || uid('p_'),
    title: packTitle,
    category: str(r.category, 200),
    source: r.source === 'import' || r.source === 'manual' ? r.source : 'import',
    description: r.description !== undefined ? str(r.description, 5000) : undefined,
    meta: {
      difficulty: str(metaRaw.difficulty, 100) || '未标注',
      objectives: strArr(metaRaw.objectives, 5000),
      tags: strArr(metaRaw.tags, 200),
      types: strArr(metaRaw.types, 200),
      source: str(metaRaw.source, 500) || '导入',
      version: str(metaRaw.version, 50) || '1.0',
      formatVersion: str(metaRaw.formatVersion, 50) || '1.0',
    },
    chapters,
    questions,
    created_at: num(r.created_at, Date.now()),
  }
}

/** 校验并规范化一条学习记录 */
function sanitizeLearning(raw: unknown): LearningState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const state = isStr(r.state) && VALID_LEARNING_STATES.has(r.state) ? r.state : '未学习'
  return {
    kp_id: str(r.kp_id, 200) ?? '',
    mastery: clampNum(r.mastery, 0, 1, 0),
    state: state as LearningState['state'],
    interval_days: clampNum(r.interval_days, 0, 10000, 0),
    next_review: str(r.next_review, 100) || new Date().toISOString(),
    wrong_count: clampNum(r.wrong_count, 0, 10000, 0),
    last_result: r.last_result === 'wrong' ? 'wrong' : 'correct',
    // V2-F04：只接收布尔，保持「答对 true / 答错 false」原样，不再全部改写为 true（拟高掌握度/改复习计划）
    recent: Array.isArray(r.recent)
      ? r.recent.filter((v): v is boolean => typeof v === 'boolean').slice(-RECENT_WINDOW)
      : undefined,
  }
}

/** 校验并规范化一条错题记录（V4-F01：questionId 与内嵌题目 id 必须一致） */
function sanitizeWrong(raw: unknown): WrongRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const q = sanitizeQuestion(r.question, 0)
  const rawQid = str(r.questionId, 200) ?? ''
  // V4-F01：错题的 questionId 与其内嵌题目 id 必须一致，避免引用歧义污染本机错题库；
  // 缺 questionId 时用题目 id 归一化；两者都有且冲突则拒绝。
  const embeddedId = (r.question && typeof r.question === 'object'
    ? str((r.question as Record<string, unknown>).id, 100)
    : '') as string
  if (rawQid && embeddedId && rawQid !== embeddedId) {
    throw new Error(`错题记录引用不一致：questionId=${rawQid} 与题目 id=${embeddedId} 不匹配`)
  }
  const questionId = rawQid || q.id
  return {
    questionId,
    packId: str(r.packId, 200) ?? '',
    packTitle: str(r.packTitle, 500) ?? '',
    question: q,
    wrongCount: clampNum(r.wrongCount, 0, 10000, 0),
    correctStreak: clampNum(r.correctStreak, 0, 10000, 0),
    mastered: Boolean(r.mastered),
    lastWrongAt: num(r.lastWrongAt, Date.now()),
    createdAt: num(r.createdAt, Date.now()),
  }
}

/** 校验并规范化一条用量记录（数值字段非负夹取，防注入异常大数组/负值） */
function sanitizeUsage(raw: unknown): UsageRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const nonNeg = (v: unknown) => {
    const n = num(v, 0)
    return n < 0 ? 0 : n
  }
  return {
    id: str(r.id, 100) || uid('u'),
    module: str(r.module, 100) || 'import',
    providerId: str(r.providerId, 100) || 'unknown',
    model: str(r.model, 200) || '',
    inputTokens: nonNeg(r.inputTokens),
    outputTokens: nonNeg(r.outputTokens),
    totalTokens: nonNeg(r.totalTokens),
    cacheReadTokens: nonNeg(r.cacheReadTokens),
    cacheMissTokens: nonNeg(r.cacheMissTokens),
    cost: r.cost === null || typeof r.cost === 'number' ? r.cost : null,
    timestamp: num(r.timestamp, Date.now()),
  }
}

/** 校验并规范化一条作答记录（V2-F01；保留原自增 id 以维持首页统计关联） */
function sanitizeAnswer(raw: unknown): AnswerRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mode = r.mode === 'review' || r.mode === 'wrong' ? r.mode : 'quiz'
  return {
    id: num(r.id, Date.now()),
    packId: str(r.packId, 200) || '',
    questionId: str(r.questionId, 200) || '',
    correct: Boolean(r.correct),
    mode,
    timestamp: num(r.timestamp, Date.now()),
  }
}

function sanitizeSourceText(raw: unknown): KBSourceText {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const spanRaw = (r.span && typeof r.span === 'object' ? r.span : undefined) as { start?: unknown; end?: unknown } | undefined
  return {
    file: str(r.file, 300),
    span: spanRaw ? { start: num(spanRaw.start, 0), end: num(spanRaw.end, 0) } : undefined,
    text: str(r.text, MAX_STR_LEN * 10),
  }
}

function sanitizeSection(raw: unknown): KBSection {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    id: str(r.id, 100) || uid('sec_'),
    title: str(r.title, 1000),
    start: num(r.start, 0),
    end: num(r.end, 0),
  }
}

/** 校验并规范化一个知识库文档（V2-F01；V3-S07 内部数组超限直接拒绝，不静默截断） */
function sanitizeKBDoc(raw: unknown): KBDoc {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const sourceFilesArr = Array.isArray(r.sourceFiles) ? r.sourceFiles : []
  if (sourceFilesArr.length > MAX_KB_SOURCE_FILES) throw new Error(`知识库源文件数超过上限 ${MAX_KB_SOURCE_FILES}`)
  const sourceFiles = sourceFilesArr.map((sf) => {
    const s = (sf && typeof sf === 'object' ? sf : {}) as Record<string, unknown>
    return { name: str(s.name, 300) || '未命名', size: Math.max(0, num(s.size, 0)) }
  })
  const sourcesTextArr = Array.isArray(r.sourcesText) ? r.sourcesText : []
  if (sourcesTextArr.length > MAX_KB_SOURCES_TEXT) throw new Error(`知识库原文切片数超过上限 ${MAX_KB_SOURCES_TEXT}`)
  const sourcesText = sourcesTextArr.map(sanitizeSourceText)
  const sectionsArr = Array.isArray(r.sections) ? r.sections : []
  if (sectionsArr.length > MAX_KB_SECTIONS) throw new Error(`知识库分块数超过上限 ${MAX_KB_SECTIONS}`)
  const sections = sectionsArr.map(sanitizeSection)
  const status = r.status === 'failed' ? 'failed' : r.status === 'indexing' ? 'indexing' : 'ready'
  return {
    id: str(r.id, 100) || uid('kb_'),
    name: str(r.name, 300) || '未命名知识库',
    sourceFiles,
    sourcesText,
    bodyText: str(r.bodyText, MAX_STR_LEN * 10),
    schema: 2,
    summary: str(r.summary, 5000),
    consolidated: str(r.consolidated, MAX_STR_LEN * 10),
    sections,
    charCount: clampNum(r.charCount, 0, 100_000_000, 0),
    source: r.source === 'import' ? 'import' : 'kb',
    status,
    error: r.error !== undefined ? str(r.error, 2000) : undefined,
    created_at: num(r.created_at, Date.now()),
    updated_at: num(r.updated_at, Date.now()),
  }
}

/** 校验并规范化偏好设置（V2-F01；非法值夹取到合法区间，缺失给默认） */
function sanitizePreferences(raw: unknown): Preferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { dailyReviewLimit: clampNum(r.dailyReviewLimit, 1, 200, 20) }
}

/**
 * 遍历原文件累加全部字符串长度（V2-S05 前置粗粒度预算，防超大字符串/海量小字符串耗尽内存）。
 * V3-S07：改为显式栈迭代并施加最大嵌套深度——恶意深层 JSON 先抛「层级过深」这类受控错误，
 * 而不是在递归中触发调用栈溢出（RangeError）落成不可控崩溃。
 */
function estimateTotalStrChars(file: unknown, budget: number): void {
  let total = 0
  const stack: { value: unknown; depth: number }[] = [{ value: file, depth: 0 }]
  while (stack.length) {
    const { value: v, depth } = stack.pop()!
    if (depth > MAX_ESTIMATE_DEPTH) throw new Error('导入文件内部层级过深，已中止')
    if (typeof v === 'string') {
      total += v.length
      if (total > budget) throw new Error('导入文件文本内容过大，请压缩后再试')
      continue
    }
    if (Array.isArray(v)) {
      const nextDepth = depth + 1
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], depth: nextDepth })
      continue
    }
    if (v && typeof v === 'object') {
      const nextDepth = depth + 1
      const rec = v as Record<string, unknown>
      const keys = Object.keys(rec)
      // 键名计入，如实反映序列化体积；从后往前压栈保证遍历顺序与递归一致（总量不依赖顺序）
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push({ value: keys[i], depth: nextDepth })
        stack.push({ value: rec[keys[i]], depth: nextDepth })
      }
    }
  }
}

/**
 * S-02 顶层入口（6.83 起带跳过明细）：文件整体校验 + 规范化并施加上限。
 * 题目级/错题记录级问题跳过并留痕（skipped，预览页展示）；贡献性结构错误
 * （超上限、重复题包 ID、层级过深、文本超预算）依旧抛错终止——不静默截断（V2-S05）。
 */
export function sanitizeImportDetailed(file: ExportFile): { file: ExportFile; skipped: ImportSkips } {
  // V2-S05：先做全文件字符串总量预算，超限直接拒绝（不进入逐项规范化）
  estimateTotalStrChars(file, MAX_TOTAL_STR_CHARS)

  const skipped = emptyImportSkips()
  const isBackup = file.type === 'backup'
  const packsRaw: unknown[] = isBackup ? (file.packs ?? []) : file.pack ? [file.pack] : []
  if (packsRaw.length > MAX_PACKS) throw new Error(`题包数量超过上限 ${MAX_PACKS}`)

  // V2-S05：全文件题目总数上限 + 题包 ID 唯一性（跨包判重）
  const seenPackIds = new Set<string>()
  const seenQIds = new Set<string>()
  let totalQuestions = 0
  for (const raw of packsRaw) {
    const id = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : undefined) as string | undefined
    if (id && seenPackIds.has(id)) throw new Error(`存在重复题包 ID：${id}`)
    if (id) seenPackIds.add(id)
    const qs = raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).questions)
      ? ((raw as Record<string, unknown>).questions as unknown[])
      : []
    totalQuestions += qs.length
    if (totalQuestions > MAX_TOTAL_QUESTIONS) throw new Error(`总题数超过上限 ${MAX_TOTAL_QUESTIONS}`)
  }
  const packs = packsRaw
    .map((p) => sanitizePack(p, seenQIds, skipped))
    .filter((p): p is Pack => p !== null)

  // 顶层数组上限：超过直接抛错，不静默截断（V2-S05）
  if (isBackup && (file.learning?.length ?? 0) > MAX_LEARNING) throw new Error(`学习记录超过上限 ${MAX_LEARNING}`)
  if (isBackup && (file.wrongs?.length ?? 0) > MAX_WRONGS) throw new Error(`错题数量超过上限 ${MAX_WRONGS}`)
  if (isBackup && (file.answers?.length ?? 0) > MAX_ANSWERS) throw new Error(`作答记录超过上限 ${MAX_ANSWERS}`)
  if (isBackup && (file.usage?.length ?? 0) > MAX_USAGE) throw new Error(`用量记录超过上限 ${MAX_USAGE}`)
  if (isBackup && (file.knowledgeBases?.length ?? 0) > MAX_KB) throw new Error(`知识库数量超过上限 ${MAX_KB}`)
  if (isBackup && (file.categories?.length ?? 0) > MAX_CATEGORIES) throw new Error(`分类数量超过上限 ${MAX_CATEGORIES}`)

  // 6.83：错题记录级问题（内嵌题目不合法 / questionId 与内嵌 id 不一致）跳过该记录并计数
  const wrongs: WrongRecord[] = []
  if (isBackup) {
    for (const w of file.wrongs ?? []) {
      try {
        wrongs.push(sanitizeWrong(w))
      } catch {
        skipped.wrongs++
      }
    }
  }

  return {
    file: {
      version: 2,
      type: file.type,
      ...(file.pack !== undefined && packs[0] ? { pack: packs[0] } : {}),
      ...(isBackup ? { packs } : {}),
      ...(isBackup && file.knowledgeBases ? { knowledgeBases: file.knowledgeBases.map(sanitizeKBDoc) } : {}),
      ...(isBackup ? { learning: (file.learning ?? []).map(sanitizeLearning) } : {}),
      ...(isBackup ? { wrongs } : {}),
      ...(isBackup ? { answers: (file.answers ?? []).map(sanitizeAnswer) } : {}),
      ...(isBackup ? { usage: (file.usage ?? []).map(sanitizeUsage) } : {}),
      ...(isBackup ? { categories: (file.categories ?? []).filter((c): c is string => typeof c === 'string' && c.trim() !== '').slice(0, MAX_CATEGORIES) } : {}),
      ...(isBackup && file.preferences ? { preferences: sanitizePreferences(file.preferences) } : {}),
      exportedAt: num(file.exportedAt, Date.now()),
    },
    skipped,
  }
}

/** 兼容旧签名：只要规范化结果（6.83 前的唯一出口；跳过明细走 sanitizeImportDetailed） */
export function sanitizeImport(file: ExportFile): ExportFile {
  return sanitizeImportDetailed(file).file
}