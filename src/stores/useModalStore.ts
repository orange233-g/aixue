import { create } from 'zustand'

export type QuizMode = 'seq' | 'rand'
export type ModalType = 'confirm' | 'prompt' | 'select' | 'menu' | 'shua' | null

export interface MenuItem {
  label: string
  /** 危险操作（如删除）标红提示 */
  danger?: boolean
  /** 回调返回值（缺省用 label） */
  value?: string
}

interface ModalState {
  type: ModalType
  title: string
  desc?: string
  placeholder?: string
  value?: string
  options?: string[]
  menuItems?: MenuItem[]
  /** 刷题弹窗可用题目总数上限 */
  max?: number
  onConfirm?: (value?: string) => void
  /** 刷题弹窗确认回调：返回模式与题数 */
  onShua?: (mode: QuizMode, count: number) => void
  onCancel?: () => void

  confirm: (title: string, desc: string, cb: () => void) => void
  prompt: (title: string, placeholder: string, cb: (value?: string) => void) => void
  select: (title: string, options: string[], cb: (value?: string) => void) => void
  menu: (title: string, items: MenuItem[], cb: (value?: string) => void) => void
  shua: (max: number, cb: (mode: QuizMode, count: number) => void) => void
  close: () => void
}

export const useModal = create<ModalState>((set) => ({
  type: null,
  title: '',
  desc: '',
  placeholder: '',
  value: '',
  options: [],
  onConfirm: undefined,
  onCancel: undefined,

  confirm(title, desc, cb) {
    set({ type: 'confirm', title, desc, onConfirm: cb })
  },
  prompt(title, placeholder, cb) {
    set({ type: 'prompt', title, placeholder, value: '', onConfirm: cb })
  },
  select(title, options, cb) {
    set({ type: 'select', title, options, onConfirm: cb })
  },
  menu(title, items, cb) {
    set({ type: 'menu', title, menuItems: items, onConfirm: cb })
  },
  shua(max, cb) {
    set({ type: 'shua', title: '开始刷题', max, onShua: cb })
  },
  close() {
    set({ type: null, onConfirm: undefined, onShua: undefined, onCancel: undefined })
  },
}))
