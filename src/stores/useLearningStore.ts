import { create } from 'zustand'
import type { LearningState, WrongRecord } from '../types'
import { dbLearning, dbWrongs } from '../db'
import { markWrongMastered, removeWrong } from '../services/learning'

/** 学习数据状态（见 PRD 6.4）：掌握度 + 错题本，随作答实时刷新 */
interface LearningStore {
  states: LearningState[]
  wrongs: WrongRecord[]
  loaded: boolean
  load: () => Promise<void>
  /** 作答后刷新（由刷题 / 复习 store 触发） */
  refresh: () => Promise<void>
  /** 标记错题已掌握（自动达标或手动） */
  markMastered: (record: WrongRecord) => Promise<void>
  /** 手动移出错题本 */
  remove: (questionId: string, packId?: string) => Promise<void>
}

export const useLearning = create<LearningStore>((set, get) => ({
  states: [],
  wrongs: [],
  loaded: false,

  async load() {
    try {
      const [states, wrongs] = await Promise.all([dbLearning.getAll(), dbWrongs.getAll()])
      set({ states, wrongs, loaded: true })
    } catch (e) {
      console.error('[learning] load failed:', e)
      set({ states: [], wrongs: [], loaded: true })
    }
  },

  async refresh() {
    const [states, wrongs] = await Promise.all([dbLearning.getAll(), dbWrongs.getAll()])
    set({ states, wrongs })
  },

  async markMastered(record) {
    await markWrongMastered(record)
    await get().refresh()
  },

  async remove(questionId, packId) {
    await removeWrong(questionId, packId)
    await get().refresh()
  },
}))
