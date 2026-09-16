import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../types'
import { canEditMessage, copyMessageText, getMessageCopyText } from './messageActions'

const message = (role: Message['role'], content: string): Message => ({
  id: 'm_test',
  role,
  content,
  tokens: 1,
})

describe('生成页消息操作', () => {
  it('复制用户消息时保留原始输入，不把参考资料正文带入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const userMessage = { ...message('user', '请生成 10 道历史题'), refs: '参考资料正文' }

    await copyMessageText(userMessage, writeText)

    expect(writeText).toHaveBeenCalledWith('请生成 10 道历史题')
  })

  it('复制助手消息时去除不可信边界标记但保留 Markdown 正文', () => {
    const assistantMessage = message(
      'assistant',
      '<untrusted_user_content>不应复制</untrusted_user_content>\n\n**结论**：可以。',
    )

    expect(getMessageCopyText(assistantMessage)).toBe('不应复制\n\n**结论**：可以。')
  })

  it('只有非空用户消息可进入修改流程', () => {
    expect(canEditMessage(message('user', '修改这条需求'))).toBe(true)
    expect(canEditMessage(message('user', '   '))).toBe(false)
    expect(canEditMessage(message('assistant', '模型回复'))).toBe(false)
  })

  it('复制失败时把错误交给调用方，不吞掉异常', async () => {
    const error = new Error('clipboard denied')
    const writeText = vi.fn().mockRejectedValue(error)

    await expect(copyMessageText(message('assistant', '回复'), writeText)).rejects.toBe(error)
  })
})
