import { create } from 'zustand'
import type { Pack, Question } from '../types'
import { dbLearning, dbPacks } from '../db'
import { DAILY_REVIEW_LIMIT, commitQuizSubmission, nextInterval, todayStr } from '../services/learning'
import { useLearning } from './useLearningStore'
import { usePreferences } from './usePreferenceStore'
import { uid } from '../utils'

/** 复习项：一个到期知识点抽取 1 道关联题目（见 PRD 4.8） */
export interface ReviewQuestion {
  kpId: string
  kpTitle: string
  packId: string
  packTitle: string
  question: Question
}

interface ReviewStore {
  /** 今日到期知识点数（首页卡片） */
  dueCount: number
  list: ReviewQuestion[]
  index: number
  /** 已作答数 */
  done: number
  /** 最近一次作答的间隔反馈（下次 N 天后 / 明天） */
  lastFeedback: { correct: boolean; interval: number } | null
  /** V4-F04：正在原子提交本次作答（防双击重复计账/半提交期间继续作答） */
  saving: boolean
  loaded: boolean
  load: () => Promise<void>
  /** 构建本次复习序列（受每日复习上限约束，V4-F04：按题目去重） */
  start: () => Promise<void>
  answer: (item: ReviewQuestion, correct: boolean) => Promise<void>
  next: () => boolean
  finish: () => void
}

export const useReview = create<ReviewStore>((set, get) => ({
  dueCount: 0,
  list: [],
  index: 0,
  done: 0,
  lastFeedback: null,
  saving: false,
  loaded: false,

  async load() {
    try {
      const due = await dbLearning.getDue(todayStr())
      set({ dueCount: due.length, loaded: true })
    } catch {
      set({ dueCount: 0, loaded: true })
    }
  },

  async start() {
    const limit = usePreferences.getState().dailyReviewLimit || DAILY_REVIEW_LIMIT
    const due = (await dbLearning.getDue(todayStr())).slice(0, limit)
    const packs = await dbPacks.getAll()
    const list: ReviewQuestion[] = []
    // V4-F04：按题目去重——一道题挂多个到期知识点时只进列表一次（否则列表重复出现且答一次更新全部 kp，
    // 重复出现会再次更新学习状态，造成重复计账）；被覆盖到的多个到期知识点会在同一次原子提交中一并更新。
    const seenQuestions = new Set<string>()
    for (const state of due) {
      const pack = packs.find((p) => p.questions.some((q) => q.kp_ids.includes(state.kp_id)))
      if (!pack) continue
      const q = pack.questions.find((x) => x.kp_ids.includes(state.kp_id))
      if (!q || seenQuestions.has(q.id)) continue
      seenQuestions.add(q.id)
      list.push({
        kpId: state.kp_id,
        kpTitle: findKpTitle(pack, state.kp_id),
        packId: pack.id,
        packTitle: pack.title,
        question: q,
      })
    }
    set({ list, index: 0, done: 0, lastFeedback: null, saving: false })
  },

  async answer(item, correct) {
    // V4-F04：提交中禁止再次作答，避免用户在保存期间继续触发，破坏单事务原子性
    if (get().saving) return
    set({ saving: true })
    try {
      const prev = await dbLearning.get(item.kpId)
      const interval = correct ? nextInterval(prev?.interval_days ?? 0, true) : 1
      const pack = await dbPacks.get(item.packId)
      if (pack) {
        // V4-F04：learning/wrongs/answers/幂等标记放到同一 IndexedDB 事务原子提交，
        // 任一失败整体回滚，不复用逐点写（recordAnswer 会先写 learning 再写 wrongs，失败留半提交）。
        await commitQuizSubmission(
          { learned: [{ pack, question: item.question, correct }], wrongCorrectIds: [], schedule: true, mode: 'review' },
          uid('rev_'),
        )
      }
      set((s) => ({ done: s.done + 1, lastFeedback: { correct, interval } }))
      await useLearning.getState().refresh()
    } finally {
      set({ saving: false })
    }
  },

  next() {
    const s = get()
    const done = s.index + 1 >= s.list.length
    set({ index: s.index + 1 })
    return done
  },

  finish() {
    set({ list: [], index: 0, done: 0, lastFeedback: null, saving: false })
  },
}))

function findKpTitle(pack: Pack, kpId: string): string {
  for (const ch of pack.chapters) {
    const kp = ch.knowledge_points.find((k) => k.id === kpId)
    if (kp) return kp.title
  }
  return ''
}
