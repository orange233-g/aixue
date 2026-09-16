import { create } from 'zustand'
import type { ExportFile } from '../types'

export type PageId =
  | 'home' | 'packs' | 'generate' | 'kb' | 'me'
  | 'pack-detail' | 'cat-manage' | 'quiz' | 'review' | 'wrong'
  | 'preview' | 'ai-settings' | 'usage' | 'import' | 'preferences'
  | 'kb-reader'
  | 'embed-settings'
  | 'kb-detail'

interface UIState {
  page: PageId
  subPage: PageId | null
  toast: string | null
  currentPackId: string | null
  /** 待导入文件（导入预览页读取，见 PRD 6.7） */
  importFile: ExportFile | null
  navigate: (page: PageId, isSub?: boolean) => void
  /** 返回上一页：子页 → 其宿主主 tab；已在主 tab 返回 false（供 Android 返回手势判定退出） */
  goBack: () => boolean
  openPack: (id: string) => void
  showToast: (msg: string) => void
  setImportFile: (f: ExportFile | null) => void
}

/** 子页 → 宿主主 tab 映射（与各子页返回按钮的 navigate 目标一致） */
const SUB_PAGE_HOME: Record<string, PageId> = {
  'pack-detail': 'packs',
  'cat-manage': 'packs',
  'quiz': 'packs',
  'wrong': 'packs',
  'import': 'packs',
  'review': 'home',
  'preview': 'generate',
  'ai-settings': 'me',
  'usage': 'me',
  'preferences': 'me',
  'kb-reader': 'kb',
  'kb-detail': 'kb',
  'embed-settings': 'me',
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useUI = create<UIState>((set, get) => ({
  page: 'home',
  subPage: null,
  toast: null,
  currentPackId: null,
  importFile: null,
  navigate: (page, isSub = false) =>
    set(isSub ? { subPage: page } : { page, subPage: null }),
  goBack: () => {
    const sp = get().subPage
    if (!sp) return false
    set({ page: SUB_PAGE_HOME[sp] ?? 'home', subPage: null })
    return true
  },
  openPack: (id) => set({ currentPackId: id }),
  showToast: (msg) => {
    set({ toast: msg })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), 1800)
  },
  setImportFile: (f) => set({ importFile: f }),
}))
