import type { Message } from '../../types'
import { stripUntrustedMarkers } from './context'

type MessageActionInput = Pick<Message, 'role' | 'content'>

/** 复制到剪贴板的正文：不携带 refs，助手正文去除不可信边界标记。 */
export function getMessageCopyText(message: MessageActionInput): string {
  const content = message.content ?? ''
  return message.role === 'assistant' ? stripUntrustedMarkers(content).trim() : content
}

/** 只有非空用户消息允许回填到生成页输入框。 */
export function canEditMessage(message: MessageActionInput): boolean {
  return message.role === 'user' && message.content.trim().length > 0
}

/** 复制实现注入 writer，便于 Web/Capacitor 共用且可独立测试。 */
export async function copyMessageText(
  message: MessageActionInput,
  writeText: (text: string) => Promise<void> | void,
): Promise<void> {
  await writeText(getMessageCopyText(message))
}
