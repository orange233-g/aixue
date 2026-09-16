import { create } from 'zustand'
import type { Pack } from '../types'
import { dbPacks, dbCategories } from '../db'
import { listSessions, saveSession } from '../services/generation/session'

interface PackStore {
  packs: Pack[]
  categories: string[]
  filterCat: string
  search: string
  loaded: boolean

  load: () => Promise<void>
  setFilterCat: (cat: string) => void
  setSearch: (s: string) => void
  addPack: (p: Pack) => Promise<void>
  renamePack: (id: string, title: string) => Promise<void>
  movePack: (id: string, category: string) => Promise<void>
  deletePack: (pack: Pack) => Promise<void>
  addCategory: (name: string) => Promise<void>
  deleteCategory: (name: string) => Promise<void>
}

export const usePacks = create<PackStore>((set, get) => ({
  packs: [],
  categories: [],
  filterCat: '',
  search: '',
  loaded: false,

  async load() {
    try {
      const [packs, cats] = await Promise.all([dbPacks.getAll(), dbCategories.getAll()])
      // 题包列表按入库/创建时间倒序：最新题包置顶（dbPacks.getAll 返回 IDB 存储序，非时间序）
      packs.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
      set({ packs, categories: ['', ...cats], loaded: true })
    } catch (e) {
      // 初始化失败不阻塞首屏（见 PRD 11.4 迁移失败兜底）
      console.error('[packs] load failed:', e)
      set({ packs: [], categories: [''], loaded: true })
    }
  },

  setFilterCat(cat) { set({ filterCat: cat }) },
  setSearch(search) { set({ search }) },

  async addPack(p) {
    await dbPacks.put(p)
    // 与新入库一致：保持按时间倒序，最新题包插入到最前
    set({ packs: [...get().packs, p].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)) })
  },

  async renamePack(id, title) {
    const pack = get().packs.find((p) => p.id === id)
    if (!pack) return
    const updated = { ...pack, title }
    await dbPacks.put(updated)
    set({ packs: get().packs.map((p) => (p.id === id ? updated : p)) })
  },

  async movePack(id, category) {
    const pack = get().packs.find((p) => p.id === id)
    if (!pack) return
    const updated = { ...pack, category }
    await dbPacks.put(updated)
    set({ packs: get().packs.map((p) => (p.id === id ? updated : p)) })
  },

  async deletePack(pack) {
    await dbPacks.deletePack(pack)
    set({ packs: get().packs.filter((p) => p.id !== pack.id) })
    // F-06 自愈：题库删除后把生成记录中的对应 ref 标记为失效，
    // 使「已入库」标签与题包真实存在性保持一致（AGENTS.md 真实存在性铁律）
    await markSessionsRemoved(pack.id)
  },

  async addCategory(name) {
    await dbCategories.add(name)
    const cats = await dbCategories.getAll()
    set({ categories: ['', ...cats] })
  },

  async deleteCategory(name) {
    await dbPacks.moveCategoryToUncategorized(name)
    await dbCategories.delete(name)
    const cats = await dbCategories.getAll()
    set({ categories: ['', ...cats], filterCat: get().filterCat === name ? '' : get().filterCat })
  },
}))

/** F-06：把生成记录中 status='in_bank' 的题包 ref 修复为失效态（题包已从题库删除） */
async function markSessionsRemoved(packId: string): Promise<void> {
  try {
    const sessions = await listSessions()
    for (const s of sessions) {
      let changed = false
      for (const m of s.messages) {
        if (m.result?.id === packId && m.result.status === 'in_bank') {
          m.result.status = 'removed'
          changed = true
        }
      }
      if (changed) await saveSession(s)
    }
  } catch {
    /* 自愈失败静默降级：下次打开生成历史时 listGeneratedPacks 会再纠偏 */
  }
}