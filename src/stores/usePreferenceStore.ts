import { create } from 'zustand'
import { dbConfig } from '../db'

const PREF_KEY = 'preferences'
/** 换肤偏好独立键（6.86）：设备本地外观，不随备份导出（恢复到别的设备不该带走肤色）；
 *  也与 dailyReviewLimit 的持久化天然隔离，避免互相覆盖 */
const APPEARANCE_KEY = 'appearance'

export interface Preferences {
  /** 每日复习上限（见 PRD 4.6 偏好设置，默认 20） */
  dailyReviewLimit: number
}

/** 全局背景色（6.86 换肤）：default=暖纸主题原色；green/yellow/blue 与阅读器护眼四色同源；
 *  dark=暗色模式（变量级换肤，阅读器自身的阅读设置不受影响） */
export type AppBgId = 'default' | 'green' | 'yellow' | 'blue' | 'dark'

export const APP_BG_OPTIONS: { id: AppBgId; label: string; color: string }[] = [
  { id: 'default', label: '默认', color: '#f5f1e8' },
  { id: 'green', label: '浅绿', color: '#e7f2e3' },
  { id: 'yellow', label: '浅黄', color: '#f7f0d6' },
  { id: 'blue', label: '浅蓝', color: '#e2edf7' },
  { id: 'dark', label: '暗色', color: '#171d19' },
]

function isAppBg(v: unknown): v is AppBgId {
  return typeof v === 'string' && APP_BG_OPTIONS.some((o) => o.id === v)
}

function defaults(): Preferences {
  return { dailyReviewLimit: 20 }
}

interface PrefStore extends Preferences {
  loaded: boolean
  appBg: AppBgId
  load: () => Promise<void>
  setDailyReviewLimit: (n: number) => void
  setAppBg: (id: AppBgId) => void
}

export const usePreferences = create<PrefStore>((set, get) => ({
  ...defaults(),
  loaded: false,
  appBg: 'default',

  async load() {
    const saved = (await dbConfig.get(PREF_KEY)) as Partial<Preferences> | undefined
    const appearance = (await dbConfig.get(APPEARANCE_KEY)) as { bg?: unknown } | undefined
    set({
      dailyReviewLimit: saved?.dailyReviewLimit ?? defaults().dailyReviewLimit,
      appBg: isAppBg(appearance?.bg) ? appearance.bg : 'default',
      loaded: true,
    })
  },

  setDailyReviewLimit(n) {
    const dailyReviewLimit = Math.max(1, Math.min(200, Math.round(n)))
    set({ dailyReviewLimit })
    dbConfig.set(PREF_KEY, { dailyReviewLimit })
  },

  setAppBg(id) {
    if (!isAppBg(id)) return
    set({ appBg: id })
    void dbConfig.set(APPEARANCE_KEY, { bg: get().appBg })
  },
}))
