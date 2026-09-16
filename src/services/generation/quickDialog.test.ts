import { describe, expect, it } from 'vitest'
import { closeQuickDialogState } from './quickDialog'

describe('closeQuickDialogState', () => {
  it('关闭快捷生成弹窗时清空临时内容和来源消息', () => {
    expect(closeQuickDialogState({ content: '上次主题', count: 109, msgId: 'm1' })).toEqual({
      quickDlg: null,
      quickContent: '',
    })
  })
})
