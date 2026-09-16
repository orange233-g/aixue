/**
 * V2 上下文与重试契约（实施路线 14 节 / TASK-04）。
 *
 * - 系统提示明确「模型只描述本轮增量，不宣布流程完成」——绝不出现
 *   complete/gathering/ready/show_button 指令；App 拥有就绪判定与下一问。
 * - 上下文只注入必要结构：当前草稿规范字段 + 缺项/冲突 + 最近消息窗口 + 本轮输入。
 *   历史 gen_intent 围栏**不再回注**（V1 遗产）；结构化 draft 才是事实源（实施路线 14 节）。
 * - 重试：首次解析失败只重试一次；重试提示携带当前事实源与本轮明确输入，但不拼接半成品。
 * 纯函数：无 Store、无网络、不调用模型。
 */
import type { ChatMessage } from '../../ai/types'
import type { DraftEvaluation, GenerationDraft, KbScope, Session } from '../../types'
import { markUntrusted, msgText, refsHeads } from './context'
import { chatWindowKeep } from './context'
import { formatGenerationDraft } from './draftPresentation'
import { evaluateGenerationDraft } from './draftValidation'
import type { DraftProtocolErrorCode } from './draftProtocol'

/** 协议尝试次数上限：首次 + 一次重试（实施路线 6.5 规则 1～2） */
export const MAX_PROTOCOL_ATTEMPTS = 2

/** 协议块标记与 schema 要点（与 draftProtocol.ts 的白名单一一对应） */
const PROTOCOL_SPEC = [
  '输出协议要求（严格遵守）：',
  '- 在回复正文之后输出一个 ```gen_draft_patch 围栏 JSON 块，描述【本轮】用户对生题需求的增量；没有需求变化时省略该块。',
  '- 顶层仅允许：schema_version(=2)、intent(chat|update|replace|cancel)、acknowledgement(≤80字简短确认)、patch。',
  '- patch 仅允许：topic、count_plan、source_policy、requirements；未知键一律视为协议错误。',
  '- topic: {op:"set", value, basis:"user_explicit"|"model_inferred", evidence} 或 {op:"unset", evidence}。',
  '- count_plan 仅四种：{op:"set_ai", total?, basis:"user_explicit", evidence}、{op:"set_custom", type_counts, stated_total?, unset_stated_total?, basis, evidence}、{op:"patch_custom", set?, unset?, stated_total?, unset_stated_total?, basis, evidence}、{op:"unset", evidence}。',
  '- source_policy 仅允许 {op:"keep_existing"|"clear", evidence}，表达旧资料去留；禁止输出任何资料 id/正文。',
  '- requirements 仅允许 {append?:[{text, basis, evidence?}], remove?:[{id, evidence}]}。',
].join('\n')

/** 系统提示（实施路线 14 节「系统提示必须明确」全部 11 条） */
export function buildDraftSystemPrompt(): string {
  return [
    '你负责理解用户对「生成题目」需求的增量变化，并按协议输出结构化补丁。',
    '职责边界：',
    '1. 只抽取用户【本轮】新增、修改、删除的需求；',
    '2. 用户未提到的字段不要重复输出、更不要清空——不输出即代表保持原值；',
    '3. 你不能判断信息是否齐全：不要输出任何「信息已收齐/可以开始生成/显示按钮」之类的流程状态宣告，也不要自行判断流程阶段；是否可以生成由应用自行计算；',
    '4. 用户给出总题数且未指定题型分配时，输出 count_plan 的 set_ai（不要替用户编造各题型数量）；用户说「题型你安排」时省略 total；所有数值操作必须引用用户本轮明确说出的原文作为 evidence，禁止 model_inferred 数量；',
    '5. 只有用户明确说了题型分配，才输出 set_custom（完整重定）或 patch_custom（局部修改）；',
    '6. 「不要多选/多选改成0」输出 patch_custom 的 unset（如 ["multiple"]），绝不能把 0 写进 set 或 type_counts；',
    '7. 只有用户明确说「沿用原资料/不要原资料」时，才输出带 evidence 的 source_policy；绝不能输出资料 id 或资料正文；',
    '8. 区分事实要求与假设、疑问、否定和闲聊：「如果要出20题该怎么分配」是咨询，「讲解20个概念」是讲解——都不是需求变更，intent 用 chat；',
    '9. acknowledgement 只做一句简短确认，不负责最终摘要，也不要自己追问缺失信息；',
    '10. 应用会根据缺项自动生成下一问，你不需要追问流程进度；',
    '11. 普通聊天（含假设咨询、讲解）输出正常正文并使用 intent=chat，省略 patch；只有真的发生需求变更才用 update/replace 和 acknowledgement。',
    '',
    PROTOCOL_SPEC,
    '',
    '示例一（新建：用户说「围绕牛顿第二定律出20题」）：',
    '正文：好的，已记录主题和题数。',
    '```gen_draft_patch',
    '{"schema_version":2,"intent":"update","acknowledgement":"已记录主题和题数。","patch":{"topic":{"op":"set","value":"牛顿第二定律","basis":"user_explicit","evidence":"牛顿第二定律"},"count_plan":{"op":"set_ai","total":20,"basis":"user_explicit","evidence":"出20题"}}}',
    '```',
    '示例二（修改：用户已有方案，说「多选改成8题，删掉判断题」）：',
    '```gen_draft_patch',
    '{"schema_version":2,"intent":"update","acknowledgement":"已调整题型。","patch":{"count_plan":{"op":"patch_custom","set":{"multiple":8},"unset":["judge"],"basis":"user_explicit","evidence":"多选改成8题，删掉判断题"}}}',
    '```',
    '示例三（取消：用户说「先不出了」）：',
    '```gen_draft_patch',
    '{"schema_version":2,"intent":"cancel","acknowledgement":"好的，已取消当前方案。"}',
    '```',
    '示例四（普通聊天/咨询：用户说「如果要出20题该怎么分配？」）：',
    '正文：直接回答这个问题本身……',
    '```gen_draft_patch',
    '{"schema_version":2,"intent":"chat"}',
    '```',
  ].join('\n')
}

/* ---------------- 当前方案状态块（结构化事实源） ---------------- */

function draftStateBlock(draft: GenerationDraft | null, evaluation: DraftEvaluation | null): string {
  if (!draft) return '[当前生题方案]\n（尚无进行中的方案）'
  const view = formatGenerationDraft(draft, evaluation ?? evaluateGenerationDraft(draft))
  const lines: string[] = ['[当前生题方案]']
  lines.push(`- 主题：${view.topic ? (view.topic.inferred ? `${view.topic.value}（AI 理解，请确认）` : view.topic.value) : '未确定'}`)
  if (view.aiTypes) lines.push(`- 题量：${view.totalText ?? '未确定'}；题型：AI 推荐`)
  else if (view.typeCounts) {
    lines.push(`- 题量：${view.totalText ?? '未确定'}；题型：${view.typeCounts.map((t) => `${t.name}${t.count}`).join('、')}`)
    if (view.statedTotalText) lines.push(`- 对账总数：${view.statedTotalText}`)
  } else lines.push('- 题量：未确定')
  if (view.requirements?.length) lines.push(`- 附加要求：${view.requirements.map((r) => r.text).join('；')}`)
  if (view.sourceSummary) lines.push(`- 资料范围：${view.sourceSummary}`)
  if (view.missing.length) lines.push(`- 还缺：${view.missing.map((i) => i.message).join('；')}`)
  if (view.conflicts.length) lines.push(`- 冲突：${view.conflicts.map((i) => i.message).join('；')}`)
  return lines.join('\n')
}

export interface DraftTurnContextInput {
  session: Session
  draft: GenerationDraft | null
  evaluation: DraftEvaluation | null
  userInput: string
  /** 本轮携带的资料范围（只注入来源标识，不注入正文） */
  refs?: string
  kbScope?: KbScope
  contextWindow?: number
}

export interface DraftRetryContext {
  draft: GenerationDraft | null
  evaluation: DraftEvaluation | null
  userInput: string
}

/** 组装 V2 一次统一聊天调用的消息序列（普通聊天与生题更新共用，实施路线 6.3） */
export function buildDraftMessages(input: DraftTurnContextInput): ChatMessage[] {
  const { session, draft, evaluation, userInput } = input
  const messages: ChatMessage[] = [{ role: 'system', content: buildDraftSystemPrompt() }]
  if (session.summary) {
    messages.push({ role: 'user', content: markUntrusted(`[会话摘要]\n${session.summary}`) })
  }
  // 最近消息窗口：复用既有窗口能力；不回注历史 gen_intent 围栏（结构化 draft 才是事实源）
  for (const m of chatWindowKeep(session, 0, input.contextWindow ?? 100000).kept) {
    if (!m.content) continue
    messages.push({ role: m.role, content: markUntrusted(msgText(m)) })
  }
  const heads = refsHeads(input.refs)
  const kbHeads = input.kbScope?.volumes.length ? `知识库范围：${input.kbScope.volumes.map((v) => v.kbName).join('、')}` : ''
  const stateBlock = [
    draftStateBlock(draft, evaluation),
    ...(heads ? [heads] : []),
    ...(kbHeads ? [kbHeads] : []),
  ].join('\n')
  messages.push({
    role: 'user',
    content: [
      stateBlock,
      '',
      '[本轮用户输入]',
      userInput,
      '',
      '请先正常回应用户；若本轮发生真实的生题需求变更（或取消），按系统提示的协议在正文后输出 gen_draft_patch 块。',
    ].join('\n'),
  })
  return messages
}

/* ---------------- 重试契约（实施路线 6.5：只含错误码与 schema 要求） ---------------- */

const RETRY_HINT: Record<DraftProtocolErrorCode, string> = {
  NO_PROTOCOL_BLOCK: '上一条回复缺少 gen_draft_patch 协议块。',
  INVALID_JSON: '上一条回复的协议 JSON 损坏或被截断。',
  SCHEMA_INVALID: '上一条回复的协议结构不合法（schema_version/intent/字段互斥）。',
  UNKNOWN_KEY: '上一条回复的协议里出现了白名单以外的键。',
  INTENT_PATCH_CONFLICT: '上一条回复 intent 与 patch 互相矛盾（chat/cancel 不允许携带 patch）。',
  EMPTY_PATCH: '上一条回复声明了 update/replace 却没有任何有效操作。',
  DUPLICATE_TYPE_CONFLICT: '同一题型出现了多个不同的数量（别名冲突）。',
  COUNT_NOT_EXPLICIT: '数值操作缺少用户本轮明确原文作为 evidence，或试图使用推测数量。',
  COUNT_PLAN_REQUIRED: 'patch_custom 只能在已有自定义题型方案上使用，请改用 set_custom。',
  INVALID_COUNT_VALUE: '数值必须为正整数（禁止 0、负数、小数、字符串）。',
}

/** 重试消息：补充当前事实源与明确输入，绝不拼接被错误解析的半成品（实施路线 6.5 规则 2） */
export function buildDraftRetryMessages(errorCode: DraftProtocolErrorCode, context?: DraftRetryContext): ChatMessage[] {
  const contextLines = context
    ? [
        draftStateBlock(context.draft, context.evaluation),
        '',
        '[本轮明确输入]',
        context.userInput,
        '',
        '只处理本轮明确变化；未提到的字段保持不变。',
      ]
    : []
  return [
    {
      role: 'user',
      content: [
        `[协议重试] ${RETRY_HINT[errorCode] ?? '上一条回复协议解析失败。'}`,
        ...contextLines,
        '请重新输出一条完整回复：正文 + 一个全新的 gen_draft_patch 协议块，满足：',
        '- schema_version=2；intent 与 patch 符合白名单（无未知键）；',
        '- 数值操作必须引用用户本轮明确原文作为 evidence；',
        '- 不要解释错误，不要输出任何 JSON 片段以外的内容到协议块里。',
        PROTOCOL_SPEC,
      ].join('\n'),
    },
  ]
}
