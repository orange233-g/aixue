/**
 * 知识库阅读器状态（书签 / 想法批注 / 阅读设置），localStorage 持久化。
 * 设置全局共享；书签与想法按 kbId 分组存储。
 */
import { create } from 'zustand'
import type { KBBookmark, KBNote, ReaderSettings } from '../types'
import { uid } from '../utils'

const LS_KEY = 'kb-reader-v1'

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 16,
  bg: 'paper',
  night: false,
  brightness: 100,
  followSystem: false,
  animation: 'cover',
}

interface ReaderStore {
  settings: ReaderSettings
  bookmarks: Record<string, KBBookmark[]>
  notes: Record<string, KBNote[]>
  setSettings: (patch: Partial<ReaderSettings>) => void
  addBookmark: (b: Omit<KBBookmark, 'id' | 'createdAt'>) => void
  removeBookmark: (kbId: string, id: string) => void
  addNote: (n: Omit<KBNote, 'id' | 'createdAt'>) => void
  removeNote: (kbId: string, id: string) => void
}

interface PersistedShape {
  settings?: Partial<ReaderSettings>
  bookmarks?: Record<string, KBBookmark[]>
  notes?: Record<string, KBNote[]>
}

function loadPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as PersistedShape
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

const persisted = loadPersisted()

function save(state: Pick<ReaderStore, 'settings' | 'bookmarks' | 'notes'>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
  } catch {
    /* 存储不可用时静默（不影响阅读） */
  }
}

export const useReader = create<ReaderStore>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS, ...(persisted.settings ?? {}) },
  bookmarks: persisted.bookmarks ?? {},
  notes: persisted.notes ?? {},

  setSettings(patch) {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    save({ settings, bookmarks: get().bookmarks, notes: get().notes })
  },

  addBookmark(b) {
    const item: KBBookmark = { ...b, id: uid('bm_'), createdAt: Date.now() }
    const list = [...(get().bookmarks[b.kbId] ?? []), item]
    const bookmarks = { ...get().bookmarks, [b.kbId]: list }
    set({ bookmarks })
    save({ settings: get().settings, bookmarks, notes: get().notes })
  },

  removeBookmark(kbId, id) {
    const list = (get().bookmarks[kbId] ?? []).filter((x) => x.id !== id)
    const bookmarks = { ...get().bookmarks, [kbId]: list }
    set({ bookmarks })
    save({ settings: get().settings, bookmarks, notes: get().notes })
  },

  addNote(n) {
    const item: KBNote = { ...n, id: uid('nt_'), createdAt: Date.now() }
    const list = [...(get().notes[n.kbId] ?? []), item]
    const notes = { ...get().notes, [n.kbId]: list }
    set({ notes })
    save({ settings: get().settings, bookmarks: get().bookmarks, notes })
  },

  removeNote(kbId, id) {
    const list = (get().notes[kbId] ?? []).filter((x) => x.id !== id)
    const notes = { ...get().notes, [kbId]: list }
    set({ notes })
    save({ settings: get().settings, bookmarks: get().bookmarks, notes })
  },
}))
