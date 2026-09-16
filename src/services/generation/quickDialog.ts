export interface QuickDialogState {
  content: string
  count: number
  msgId?: string
}

export interface ClosedQuickDialogState {
  quickDlg: null
  quickContent: ''
}

/** 关闭快捷生成弹窗时，临时内容和来源消息都不应泄漏到下一次打开。 */
export function closeQuickDialogState(_state: QuickDialogState | null): ClosedQuickDialogState {
  return { quickDlg: null, quickContent: '' }
}
