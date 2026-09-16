import { create } from 'zustand'
import type { Pack, Question, WrongRecord } from '../types'
import { dbPacks } from '../db'
import { buildQuiz, gradeAnswer, isEntrySubmitted, type GradeResult, type QuizMode } from '../services/quiz'
import { commitQuizSubmission, type WrongQuestionRef } from '../services/learning'
import { uid } from '../utils'
import { useLearning } from './useLearningStore'
import { useUI } from './useUIStore'

/** 单题暂存作答（统一提交前可任意前后切换修改） */
export interface AnswerEntry {
  /** 用户作答原文（客观题为 JSON 索引/文本，主观题为文本） */
  ua: string
  /** 主观题用户自评（答对/答错），客观题无 */
  selfCorrect?: boolean
}

/** 刷题会话（见 PRD 4.7：中途退出本地保存，下次进入可续刷）
 *   F5 改造：作答阶段只暂存答案，全部答完后再一次性统一提交判分落库 */
export interface QuizSession {
  packId: string
  packTitle: string
  mode: QuizMode
  chapterId?: string
  questionIds: string[]
  /** 题目来源引用；错题重练必须同时携带题包 id，避免同题号冲突 */
  questionRefs?: WrongQuestionRef[]
  /** 涉及题包 id 列表（跨题包错题重练可能需要多个）；实际题包常驻内存，
   *  恢复时从 IndexedDB 重载，不写进 localStorage（F-03 瘦身） */
  packIds: string[]
  index: number
  /** 答卷暂存：questionId -> 用户作答（提交前可修改） */
  answers: Record<string, AnswerEntry>
  /** 提交后判分结果：questionId -> GradeResult */
  results: Record<string, GradeResult>
  /** 是否已完成统一提交（完成后进入回顾页） */
  submitted: boolean
  /** 统一提交的幂等 id：首次提交生成、提交失败重试复用（V2-I01 去重） */
  submitId?: string
  correct: number
  startedAt: number
}

const STORAGE_KEY = 'ai-xue-quiz-session'

function normalizeSession(s: QuizSession): QuizSession {
  // F-03 迁移：旧存档含完整题包正文 packs 且可能缺 packIds，提取 id 列表并丢弃正文
  const legacy = s as QuizSession & { packs?: Pack[] }
  const packIds = s.packIds ?? (Array.isArray(legacy.packs) ? legacy.packs.map((p) => p.id) : [])
  return {
      ...s,
      packIds,
      answers: s.answers ?? {},
      results: s.results ?? {},
      submitted: s.submitted ?? false,
      submitId: s.submitId,
    }
}

/** 按 id 从 IndexedDB 重载题包（合并传入的 always 题包，避免重复读取当前包） */
async function loadPacks(ids: string[], always?: Pack[]): Promise<Pack[]> {
  const map = new Map<string, Pack>()
  for (const p of always ?? []) map.set(p.id, p)
  for (const id of ids) {
    if (!map.has(id)) {
      const p = await dbPacks.get(id)
      if (p) map.set(id, p)
    }
  }
  return [...map.values()]
}

/** 保存失败（多为 localStorage 配额满）后向用户提示一次，避免逐次作答刷屏 */
let persistWarnShown = false
function warnPersistFailed(): void {
  if (persistWarnShown) return
  persistWarnShown = true
  useUI.getState().showToast('续做进度未保存（本地存储已满），请尽快完成并提交')
}

function loadSession(): QuizSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as QuizSession
    // 旧格式存档（无答卷暂存字段，非统一提交模式）不参与续刷，交由上层重建
    if (!parsed.answers) return null
    return normalizeSession(parsed)
  } catch {
    return null
  }
}

/** 持久化轻量会话：只存定位/进度/作答，不落完整题包正文（F-03）。
 *  返回是否保存成功；配额满等异常返回 false，由调用方提示用户。 */
function saveSession(s: QuizSession | null): boolean {
  try {
    if (s) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          packId: s.packId,
          packTitle: s.packTitle,
          mode: s.mode,
          chapterId: s.chapterId,
          questionIds: s.questionIds,
          questionRefs: s.questionRefs,
          packIds: s.packIds,
          index: s.index,
          answers: s.answers,
          results: s.results,
          submitted: s.submitted,
          submitId: s.submitId,
          correct: s.correct,
          startedAt: s.startedAt,
        }),
      )
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
    return true
  } catch {
    return false
  }
}

export function quizQuestionKey(session: QuizSession, index: number): string {
  const ref = session.questionRefs?.[index]
  // 普通刷题继续使用题目 id，兼容已有本地会话；跨题包错题重练才必须使用复合键。
  return ref && session.mode === 'wrong' ? `${ref.packId}::${ref.questionId}` : (session.questionIds[index] ?? '')
}

function questionRefAt(session: QuizSession, index: number): WrongQuestionRef {
  const ref = session.questionRefs?.[index]
  return ref ?? { packId: session.packId, questionId: session.questionIds[index] ?? '' }
}

interface QuizStore {
  session: QuizSession | null
  packs: Pack[]
  /** 正在统一提交（防止重复点击重复累计） */
  submitting: boolean
  /** 进入刷题：同题包同模式未完成时自动续刷，否则新建；count 可选刷题数量（超过则取前 count 题） */
  start: (pack: Pack, mode: QuizMode, count?: number, chapterId?: string) => Promise<void>
  /** 错题重练：只抽取错题作答，跨题包；count 可选题数 */
  startWrong: (records: WrongRecord[], packs: Pack[], count?: number) => Promise<void>
  /** 暂存作答（不判分不落库，可反复修改）；主观题由 selfCorrect 自评 */
  answer: (q: Question, userAnswer: string, selfCorrect?: boolean) => void
  /** 跳转到指定题号（0-based），支持前后切换 */
  go: (index: number) => void
  /** 统一提交：遍历已作答题目判分并落库，返回统计 */
  submit: () => Promise<{ total: number; correct: number } | null>
  /** 完成并清理会话 */
  finish: () => void
  /** 退出刷题（保留进度） */
  exit: () => void
}

export const useQuiz = create<QuizStore>((set, get) => ({
  session: null,
  packs: [],
  submitting: false,

  async start(pack, mode, count, chapterId) {
    const saved = loadSession()
    if (
      saved &&
      saved.packId === pack.id &&
      saved.mode === mode &&
      saved.chapterId === chapterId &&
      saved.index < saved.questionIds.length &&
      !saved.submitted
    ) {
      // 续刷：题包正文已不入 localStorage，从 IndexedDB 重载
      const ps = await loadPacks(saved.packIds, [pack])
      set({ session: saved, packs: ps })
      return
    }
    let questions = buildQuiz(pack, mode, chapterId)
    if (count != null && count > 0 && count < questions.length) {
      questions = questions.slice(0, count)
    }
    const session: QuizSession = {
      packId: pack.id,
      packTitle: pack.title,
      mode,
      chapterId,
      questionIds: questions.map((q) => q.id),
      questionRefs: questions.map((q) => ({ packId: pack.id, questionId: q.id })),
      packIds: [pack.id],
      index: 0,
      answers: {},
      results: {},
      submitted: false,
      correct: 0,
      startedAt: Date.now(),
    }
    saveSession(session)
    set({ session, packs: [pack] })
  },

  async startWrong(records, packs, count) {
    const saved = loadSession()
    if (saved && saved.mode === 'wrong' && saved.index < saved.questionIds.length && !saved.submitted) {
      const ps = await loadPacks(saved.packIds, packs)
      set({ session: saved, packs: ps })
      return
    }
    let refs = records.map((r) => ({ packId: r.packId, questionId: r.questionId }))
    if (count != null && count > 0 && count < refs.length) refs = refs.slice(0, count)
    const session: QuizSession = {
      packId: '__wrong__',
      packTitle: '错题重练',
      mode: 'wrong',
      questionIds: refs.map((ref) => ref.questionId),
      questionRefs: refs,
      packIds: packs.map((p) => p.id),
      index: 0,
      answers: {},
      results: {},
      submitted: false,
      correct: 0,
      startedAt: Date.now(),
    }
    saveSession(session)
    set({ session, packs })
  },

  answer(_q, userAnswer, selfCorrect) {
    const s = get().session
    // V4-F03：提交中禁止作答写入——事务落库期间仍可触发 answer 会改变 session.answers，
    // 与正在快照提交的 data 产生竞态，故 store 层也要锁
    if (!s || s.submitted || get().submitting) return
    const answers = { ...s.answers, [quizQuestionKey(s, s.index)]: { ua: userAnswer, selfCorrect } }
    const next = { ...s, answers }
    if (!saveSession(next)) warnPersistFailed()
    set({ session: next })
  },

  go(index) {
    const s = get().session
    // V3-F02：提交中禁止切题，避免在事务落库期间改变 index/answers 造成数据不一致
    if (!s || s.submitted || get().submitting) return
    if (index < 0 || index >= s.questionIds.length) return
    const next = { ...s, index }
    if (!saveSession(next)) warnPersistFailed()
    set({ session: next })
  },

  async submit() {
    const s = get().session
    if (!s || s.submitted || get().submitting) return null
    const allPacks = get().packs
    const allQuestions = allPacks.flatMap((p) => p.questions)
    const results: Record<string, GradeResult> = {}
    let correct = 0
    let total = 0
    const learned: { pack: Pack; question: Question; correct: boolean }[] = []
    const wrongCorrectIds: WrongQuestionRef[] = []
    for (let i = 0; i < s.questionIds.length; i++) {
      const id = s.questionIds[i]
      const ref = questionRefAt(s, i)
      const pack = s.questionRefs
        ? allPacks.find((p) => p.id === ref.packId)
        : allPacks.find((p) => p.id === s.packId) ?? allPacks.find((p) => p.questions.some((x) => x.id === id))
      const q = pack?.questions.find((x) => x.id === ref.questionId) ?? allQuestions.find((x) => x.id === id)
      if (!q) continue
      const answerKey = quizQuestionKey(s, i)
      const entry = s.answers[answerKey]
      // 没有内容才算未作答；主观题有文本但未自评进入待自评状态，不计分、不入错题本。
      if (!isEntrySubmitted(q, entry)) continue
      const r = gradeAnswer(q, entry.ua)
      if (r.subjective && entry.selfCorrect == null) {
        results[answerKey] = { ...r, pendingSelfReview: true }
        continue
      }
      const result = { ...r, correct: r.subjective ? (entry.selfCorrect ?? false) : r.correct }
      results[answerKey] = result
      const isCorrect = result.correct
      if (isCorrect) correct++
      total++

      if (pack) {
        learned.push({ pack, question: q, correct: isCorrect })
        if (s.mode === 'wrong' && isCorrect) wrongCorrectIds.push({ packId: pack.id, questionId: q.id })
      }
    }

    // 提交中：加锁防重复点击重复累计（V2-I01）
    set({ submitting: true })
    let submitId = s.submitId ?? uid('sub_')
    // 先把 submitId 持久化（保持 submitted=false）：即使中途崩溃/失败，重载后仍持同一 id，
    // 重试可复用以命中 config 幂等标记，避免数据已提交却生成新 id 导致重复累计（V2-I01）。
    const staged = { ...s, submitId }
    // V3-F02：submitId 必须持久化成功才允许进入事务；局部存储配额满等问题导致保存失败时
    // 直接阻断提交并解锁，避免进入事务后重试（新 submitId）破坏幂等去重
    if (!saveSession(staged)) {
      warnPersistFailed()
      set({ submitting: false })
      throw new Error('提交 ID 保存失败，无法保证幂等去重，请稍后重试')
    }
    try {
      // V2-F02 / V2-I01：learning + wrongs + answers + 幂等标记 放进同一 IndexedDB readwrite
      // 事务原子提交，任一步失败整体回滚。
      await commitQuizSubmission(
        { learned, wrongCorrectIds, schedule: false, mode: s.mode === 'wrong' ? 'wrong' : 'quiz' },
        submitId,
      )
    } catch (e) {
      // 事务已回滚：保持未提交，保留答卷与结果，交由调用方提示重试
      useLearning.getState().refresh().catch(() => {})
      set({ submitting: false })
      throw e
    }
    const next: QuizSession = { ...s, results, correct, submitted: true, submitId }
    if (!saveSession(next)) warnPersistFailed()
    await useLearning.getState().refresh()
    set({ session: next, submitting: false })
    return { total, correct }
  },

  finish() {
    // V3-F02：提交进行中禁止清理会话，避免事务仍在跑时 session 被清空导致状态错乱
    if (get().submitting) return
    saveSession(null)
    set({ session: null, packs: [] })
  },

  exit() {
    // 保留进度，仅退出页面（会话仍在 store 中）
  },
}))
