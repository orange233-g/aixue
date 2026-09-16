import type { Chapter, KnowledgePoint, Question } from '../../types'
import { uid } from '../../utils'
import { QUESTION_TYPES } from '../../types'
import type { ChatMessage } from '../../ai/types'
import { chat } from '../../ai/gateway'
import { parseJSON } from '../../ai/parse'
import type { AIConfig } from '../../types'
import type { SessionSnapshot } from './session'

/**
 * 题包结构化（见 PRD：生成后用户应能一眼看出「主要内容/包含哪些题/有哪些章节」）。
 * 复用每题的 kp_ids（即模型输出的「知识点」分词）确定性分组，无需额外 AI 调用，
 * 对大批量（500/1000 题）同样廉价可靠，不写死任何厂商。
 */

// 难度粒度与题包元数据格式保持一致（简单/中等/困难）
const DIFF_LABEL: Record<number, string> = { 1: '简单', 2: '中等', 3: '困难' }

function countByType(questions: Question[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const q of questions) m.set(q.type, (m.get(q.type) ?? 0) + 1)
  return m
}

/** 每个层级的默认章节数量上限（超过把题数最少者并入「其他综合」，避免章节碎片化） */
const MAX_CHAPTERS = 8
/** 大题包放宽上限：题数超过该阈值时章节数放宽到 12（题多组多，8 章粒度过粗、找题针对性弱） */
const LARGE_PACK_QUESTIONS = 100
const MAX_CHAPTERS_LARGE = 12

/** 按题量自适应的章节上限：小包 8 防碎片化，大包（>100 题）12 保细分 */
function chapterLimit(total: number): number {
  return total > LARGE_PACK_QUESTIONS ? MAX_CHAPTERS_LARGE : MAX_CHAPTERS
}

/** 拆两级知识点：用「>」分隔「大类>子类」；无分隔符则视为纯一级主题 */
function splitKp(raw: string): { l1: string; l2: string | null } {
  const t = (raw || '').trim()
  if (!t) return { l1: '', l2: null }
  const i = t.indexOf('>')
  if (i > 0) {
    const a = t.slice(0, i).trim()
    const b = t.slice(i + 1).trim()
    return { l1: a || t, l2: b || null }
  }
  return { l1: t, l2: null }
}

/** 由一组题目构造章节（聚合知识点与题号；children 由调用方决定是否挂接） */
function makeChapter(title: string, qs: Question[]): Chapter {
  const kps: KnowledgePoint[] = []
  for (const q of qs) {
    for (const s of q.kp_ids ?? []) {
      const k = (s || '').trim()
      if (k && !kps.some((x) => x.title === k)) kps.push({ id: k, title: k, content: '', examples: [], pitfalls: [] })
    }
  }
  return {
    id: uid('c_'),
    title,
    summary: `本章围绕「${title}」共 ${qs.length} 题，涵盖 ${kps.length} 个知识点。`,
    knowledge_points: kps,
    question_ids: qs.map((q) => q.id),
  }
}

/** 合并超过上限的组：保留前 N-1 大组，其余并入一个「其他综合」 */
function capGroups<T>(groups: { title: string; qs: T[] }[], mergeTitle: string, max: number): { title: string; qs: T[] }[] {
  if (groups.length <= max) return groups
  const keep = groups.slice(0, max - 1)
  const rest = groups.slice(max - 1)
  keep.push({ title: mergeTitle, qs: rest.reduce((acc, r) => acc.concat(r.qs), [] as T[]) })
  return keep
}

/**
 * 按知识点把题目划分为章节（一级）；两级的层级由题目知识点里的「>」触发。
 * 普通模式：与旧逻辑一致，扁平章节（无 children，兼容旧包）。
 * 两级模式：一级章按「大类」归组，其下再按「子类」拆出二级叶章；每级上限按题量自适应（小包 8 / 大包 12）。
 */
export function buildPackChapters(questions: Question[]): Chapter[] {
  if (!questions.length) return []
  // 主题词频：kp_ids 存的是知识点名
  const freq = new Map<string, number>()
  for (const q of questions) {
    for (const kp of q.kp_ids ?? []) {
      const k = (kp || '').trim()
      if (k) freq.set(k, (freq.get(k) ?? 0) + 1)
    }
  }
  const topicRank = new Map<string, number>()
  ;[...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k], i) => topicRank.set(k, i))

  // 每题主知识点 = 其 kp_ids 中全局权重最高的
  const primaryOf = new Map<string, string>()
  for (const q of questions) {
    const p =
      (q.kp_ids ?? [])
        .map((s) => s.trim())
        .filter(Boolean)
        .map((k) => ({ k, w: topicRank.get(k) ?? 999 }))
        .sort((a, b) => a.w - b.w)[0]?.k ?? '综合'
    primaryOf.set(q.id, p)
  }

  // 是否触发了「大类>子类」两级写法
  const hasHier = questions.some((q) => (q.kp_ids ?? []).some((k) => (k || '').includes('>')))

  // 一级分组：按主知识点的「大类」归组
  const byL1 = new Map<string, Question[]>()
  for (const q of questions) {
    const k = splitKp(primaryOf.get(q.id) ?? '').l1 || '综合'
    if (!byL1.has(k)) byL1.set(k, [])
    byL1.get(k)!.push(q)
  }
  const l1Groups = capGroups(
    [...byL1.entries()].map(([title, qs]) => ({ title, qs })).sort((a, b) => b.qs.length - a.qs.length),
    '其他综合',
    chapterLimit(questions.length),
  )

  return l1Groups.map((g) => {
    const root = makeChapter(g.title, g.qs)
    if (!hasHier) return root
    // 两级模式：一级章内再按「子类」拆二级叶章
    const bySub = new Map<string, Question[]>()
    for (const q of g.qs) {
      const k = splitKp(primaryOf.get(q.id) ?? '').l2 || '综合'
      if (!bySub.has(k)) bySub.set(k, [])
      bySub.get(k)!.push(q)
    }
    const subGroups = capGroups(
      [...bySub.entries()].map(([title, qs]) => ({ title, qs })).sort((a, b) => b.qs.length - a.qs.length),
      '其他综合',
      chapterLimit(questions.length),
    )
    root.children = subGroups.map((sg) => makeChapter(sg.title, sg.qs))
    // 一级章 question_ids 聚合其全部二级章题号，便于旧消费方/统计直接读
    root.question_ids = root.children.flatMap((c) => c.question_ids)
    return root
  })
}

export interface PackStructureInfo {
  difficulty: string
  objectives: string[]
  description: string
  chapters: Chapter[]
  /** 题型（人类可读名，去重有序） */
  types: string[]
  /** 来源描述（AI 生成 / 用户整理 / 手动导入 等） */
  source: string
  /** 标签，未做 AI 富化时默认取全局高频知识点兜底 */
  tags: string[]
  version: string
  formatVersion: string
}

/** 由题目推导题包含题型列表（人类可读名，保持题目出现顺序去重） */
export function computeQuestionTypes(questions: Question[]): string[] {
  const out: string[] = []
  for (const q of questions) {
    const name = QUESTION_TYPES.find((x) => x.id === q.type)?.name ?? q.type
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** 由题目推导题包元信息：难度 / 学习目标 / 一句话简介 / 章节结构 / 题型 / 来源 / 标签兜底 / 版本 */
export function buildPackStructureInfo(questions: Question[]): PackStructureInfo {
  const avg = questions.length
    ? Math.round(questions.reduce((a, q) => a + (q.difficulty || 2), 0) / questions.length)
    : 2
  const chapters = buildPackChapters(questions)
  const objectives = chapters.slice(0, 6).map((c) => c.title)
  const byType = countByType(questions)
  const dist = [...byType.entries()]
    .map(([t, n]) => `${QUESTION_TYPES.find((x) => x.id === t)?.name ?? t} ${n} 题`)
    .join('、')
  const desc = questions.length
    ? `共 ${questions.length} 题，按 ${chapters.length} 个章节组织，覆盖${objectives.length ? `知识点：${objectives.join('、')}；` : ''}题型分布为${dist}。`
    : '该学习本暂无题目。'
  const types = computeQuestionTypes(questions)
  // 标签兜底：全局出现频率最高的几个知识点，AI 富化前保证非空
  const freq = new Map<string, number>()
  for (const q of questions) for (const s of q.kp_ids ?? []) {
    const k = (s || '').trim()
    if (k) freq.set(k, (freq.get(k) ?? 0) + 1)
  }
  const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  return {
    difficulty: DIFF_LABEL[avg as 1 | 2 | 3] ?? '中等',
    objectives,
    description: desc,
    chapters,
    types,
    source: 'AI 生成',
    tags,
    version: '1.0',
    formatVersion: '1.0',
  }
}

const ENRICH_PROMPT = [
  '你是内容编目助手。为一道题包归纳「标题」「分类」和「标签」，帮助用户快速判断题包内容与归属。',
  '规则：',
  '1. 标题：对学习本的学习主题做精简概括，作为学习本名称，控制在 12 字以内，直接给纯文本主题词，不要带书名号、引号、分隔符或「学习本」字样。',
  '2. 分类：给出一到两个层级的归属，用「/」连接，如「程序语言/Python」「计算机/网络」「财经/会计」，不要超过两级。',
  '3. 标签：给出 3-6 个短标签，逗号分隔，如「Python,编程,入门」。',
  '4. 只输出 JSON，如 {"title":"Transformer架构","category":"程序语言/Python","tags":["Python","编程","入门"]}，不要输出其他内容。',
].join('\n')

export interface EnrichedMeta {
  /** 由 AI 提炼的题包精简标题（≤12 字，失败时由规则兜底） */
  title?: string
  category?: string
  tags?: string[]
}

/** 解析富化 JSON，失败返回 null */
function parseEnriched(content: string): EnrichedMeta | null {
  try {
    const r = parseJSON<{ title?: unknown; category?: string; tags?: unknown }>(content)
    const tags = Array.isArray(r.tags)
      ? r.tags.map((t) => String(t)).map((s) => s.trim()).filter(Boolean).slice(0, 6)
      : undefined
    const category = typeof r.category === 'string' ? r.category.trim() : undefined
    const title = typeof r.title === 'string' ? r.title.trim().replace(/\s+/g, ' ').slice(0, 20) : undefined
    if (!title && !category && (!tags || !tags.length)) return null
    return { title: title || undefined, category: category || undefined, tags }
  } catch {
    return null
  }
}

/**
 * 规则抽取题包标题（AI 提炼失败/为空时的离线兜底）：
 * 优先在「连接词 + 主题 + 的」结构里捕获主题词；否则清理祈使前缀/尾缀与数量词后取余下短句。
 * 不追求覆盖所有口语句式，只保证返回比原话短、干净、无「题包」装饰的核心词。
 */
export function extractTopicTitle(input: string): string {
  const clean = (s: string) => s.trim().replace(/\s+/g, ' ').trim()
  const t = clean(
    input.replace(/["“”『』「」【】*`_~#]/g, ' ').replace(/[，。！？；：、，]/g, ' '),
  )
  if (!t) return input.trim().slice(0, 18)
  // 连接词 + 主题 + 的/题：稳定命中最常见的「关于/根据/围绕 X 的题」
  const m = t.match(/(?:关于|根据|针对|围绕|基于|有关|学习)\s*([^\s，。！？；：帮给我出]{1,12}?)\s*的/)
  if (m && m[1]) {
    const r = clean(m[1])
    if (r) return r.length > 18 ? r.slice(0, 18) + '…' : r
  }
  // 直达：去数量词 → 反复去祈使/客套/连接词前缀（trim 后再锚定，避免残留空格挡住）→ 去题类尾缀，再截断
  let s = t.replace(/\d+\s*道?\s*(?:练习)?\s*题?/g, ' ')
  for (let i = 0; i < 5; i++) {
    s = s.trim()
    s = s.replace(/^(?:请|麻烦|帮我|给我|请你|你能|你|我|我们|想|帮我出|给我出|为|来|大家|给大家|一次|一下|出|给|生成|写|做|编)+\s*/g, '')
    s = s.replace(/^(?:根据|围绕|针对|基于|关于|有关|学习|了解|复习|掌握)+\s*/g, '')
  }
  s = s.replace(/(?:的)?\s*(?:题|题目|练习题|习题|试卷|集|单)+$/g, ' ').trim()
  s = s.replace(/(?:帮我|给我|帮我出|给我出|生成|出|做|写|编|一下吧|一下|吧|讲几个例子|并)*$/g, '').trim()
  s = clean(s)
  if (!s) return input.trim().slice(0, 18)
  return s.length > 18 ? s.slice(0, 18) + '…' : s
}

/**
 * 由 AI 派生题包的「分类」与「标签」（一次轻量调用，见需求）。
 * 解析失败 / 无模型时不阻塞，返回空对象，由调用方回退到确定性派生结果。
 */
export async function enrichPackMeta(
  content: string,
  snapshot: SessionSnapshot,
  cfg: AIConfig,
): Promise<EnrichedMeta> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: ENRICH_PROMPT },
      { role: 'user', content: `题包内容：${content}\n（如题包内容较长，请忽略题面细节，仅归纳学习主题。）` },
    ]
    const result = await chat(messages, {
      providerId: snapshot.providerId,
      model: snapshot.model,
      temperature: 0.3,
      maxTokens: 600,
      module: 'enrich-meta',
    }, cfg)
    return parseEnriched(result.content) ?? {}
  } catch {
    return {}
  }
}