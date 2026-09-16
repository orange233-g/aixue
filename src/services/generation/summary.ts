import type { ChatMessage } from '../../ai/types'
import { chat } from '../../ai/gateway'
import type { AIConfig, Session } from '../../types'
import type { SessionSnapshot } from './session'
import { chatBudget, chatWindowKeep, estimateChatContext } from './context'

/** 摘要压缩系统提示（见 PRD 10.4） */
const SUMMARY_PROMPT = [
  '你是对话记录整理助手。请把下面的学习会话压缩成一段简洁摘要，',
  '保留：学习主题、已生成题包及数量、用户补充/调整的需求、当前进度。',
  '只输出摘要文本，不要输出其他内容。',
].join('\n')

/** 聊天自动压缩系统提示（阶段 3：只压缩将被丢弃的最旧内容，最近原文保留） */
const CHAT_SUMMARY_PROMPT = [
  '你是对话记录整理助手。请把「需要压缩的早期内容」压缩成一段简洁摘要，',
  '保留：学习主题、已讨论或已生成的知识点/题包及数量、用户明确的需求或偏好、当前进度、尚未解决或待办的事项。',
  '若提供了旧摘要，需与新内容合并成一份连贯摘要，不要遗漏旧信息。',
  '只输出合并后的摘要文本本身，不要任何解释或格式标记，用中文。',
].join('\n')

/** 压缩会话为摘要（每次生成完成后调用，输出 ~200-300 token） */
export async function compressSummary(
  session: Session,
  cfg: AIConfig,
  snapshot: SessionSnapshot,
): Promise<string> {
  const history = session.messages
    .slice(-10)
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n')
  const old = session.summary ? `旧摘要：${session.summary}\n` : ''
  const messages: ChatMessage[] = [
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: `${old}[会话历史]\n${history}` },
  ]
  const result = await chat(
    messages,
    {
      providerId: snapshot.providerId,
      model: snapshot.model,
      temperature: 0.3,
      // 推理模型会占用 max_tokens 预算，300 会被推理耗尽导致摘要为空，放宽到 1000
      maxTokens: 1000,
      module: 'summary',
    },
    cfg,
  )
  return result.content.trim()
}

/**
 * 聊天分支的「按预算自动压缩」（阶段 3）：仅当估算上下文超过预算阈值时触发。
 * 把「会被 buildChatContext 裁剪掉的最旧内容」用 LLM 压缩进 session.summary（与旧摘要合并），
 * 最近的原文仍保留；rest≥旧内容不丢，避免上下文变长后模型「失忆」。
 * 失败时降级保留旧摘要并静默返回，绝不阻断聊天（compressSummary 同理的容错，见铁律第 16 条精神）。
 */
export async function maybeCompressChat(
  session: Session,
  cfg: AIConfig,
  snapshot: SessionSnapshot,
  contextWindow: number,
  reserveTokens: number,
): Promise<void> {
  const { threshold } = chatBudget(contextWindow)
  const total = estimateChatContext(session) + reserveTokens
  if (total <= threshold) return // 未超阈值，直接用满预算，不压缩
  const { keepStart } = chatWindowKeep(session, reserveTokens, contextWindow)
  // 只压缩「尚未折叠」的早期内容（>= summaryBound）：已折叠进 summary 的部分不再重复压缩（对齐 Cherry 的折叠边界）
  const bound = Math.min(session.summaryBound ?? 0, session.messages.length)
  const dropped = session.messages.slice(bound, keepStart).filter((m) => m.content)
  if (dropped.length === 0) return // 仍在保留窗口内
  const oldText = dropped.map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`).join('\n')
  const prev = session.summary ? `旧摘要：${session.summary}\n` : ''
  const messages: ChatMessage[] = [
    { role: 'system', content: CHAT_SUMMARY_PROMPT },
    { role: 'user', content: [prev, '[需要压缩的早期内容]', oldText, '[注意] 只输出合并后的摘要文本'].join('\n') },
  ]
  const result = await chat(
    messages,
    {
      providerId: snapshot.providerId,
      model: snapshot.model,
      temperature: 0.3,
      // 推理模型会占用 max_tokens 预算，300 会被推理耗尽导致摘要为空，放宽到 1000
      maxTokens: 1000,
      module: 'summary',
    },
    cfg,
  )
  const out = result.content.trim()
  // 压缩成功才推进折叠边界：已合并进 summary 的 [bound, keepStart) 不再参与后续统计/压缩；
  // 空摘要则降级保留旧摘要与原消息（不推进边界，等价 Cherry 的 skipped，绝不丢历史）
  if (out && dropped.length > 0) {
    session.summary = out
    session.summaryBound = keepStart
  }
}
