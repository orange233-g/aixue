/**
 * V2 finalIntent 门禁与协议需求判定（实施路线 6.3、6.5 / TASK-04）。
 *
 * 职责：只做「取消 / 否定与假设安全门禁 / 明确题数题型 / 裸值回答」这类确定性判定，
 * 不维护流程状态机（实施路线 1.3 冻结决策表「本地规则」行）。
 * 模型负责语义理解；本模块决定：①是否需要协议块；②模型意图是否被采纳/降级；
 * ③纯取消是否本地短路（不调用模型）；④本地显式值是否可参与合并。
 * 纯函数：无 Store、无网络。
 */
import type { DraftEvaluation, DraftPatch, GenerationDraft } from '../../types'
import {
  hasExplicitGenIntent,
  isAdjustment,
  isDefaultAnswer,
  isGenAbort,
  isGenSpecReply,
  NOT_A_REQUEST_RE,
} from './intentRules'
import { extractExplicitTotal } from './draftProtocol'

/* ============================ 纯取消与复合取消 ============================ */

/** 取消语义（含否定出题措辞）：「不要出题」「不出了」「取消」「停止生成」等 */
const CANCEL_GEN_RE = /(?:不要|不用|别|先不|不出了?|不弄了?|取消|放弃|停止|停吧|停).{0,8}(?:出题|出|生成|做题|弄|练习)/
/** 疑问/假设开头不是取消指令（「怎么不出题了」「如果不想出题呢」交模型/聊天处理） */
const QUESTION_HEAD_RE = /^(?:怎么|如何|怎样|在哪|在哪儿|哪里|哪儿|为什么|如果|假如|要是|是不是|能不能|可不可以|难道|要不要)/

export type LocalCancelResolution =
  | { action: 'none' }
  | { action: 'cancel' }
  | { action: 'cancel_and_chat'; remainder: string }

/**
 * 解析本地取消（实施路线 6.3 流程首步）：
 * - 无活动草稿：否定句只是拒绝生题，不是取消 → none（交聊天）。
 * - 纯取消短句（含「不要出题」）：本地立即 cancel，不调用模型。
 * - 复合输入「不要出题，只给我讲概念」：先取消草稿，剩余部分继续一次正常聊天。
 */
export function resolveLocalCancel(input: string, hasActiveDraft: boolean): LocalCancelResolution {
  if (!hasActiveDraft) return { action: 'none' }
  const t = (input ?? '').trim()
  if (!t) return { action: 'none' }
  if (isGenAbort(t)) return { action: 'cancel' }

  const m = t.match(/^([^，,。；;！!]+)[，,。；;！!]\s*(.*)$/)
  const head = (m ? m[1] : t).trim()
  const tail = m ? (m[2] ?? '').trim() : ''
  if (QUESTION_HEAD_RE.test(head)) return { action: 'none' }
  const headIsCancel = isGenAbort(head) || CANCEL_GEN_RE.test(head)
  if (!headIsCancel) return { action: 'none' }
  if (!tail) return { action: 'cancel' }
  // 尾部仍是取消语义（「不出了，太麻烦」已在上面整句命中，这里兜住「取消，先这样吧」变体）
  if (isGenAbort(tail) || CANCEL_GEN_RE.test(tail)) return { action: 'cancel' }
  return { action: 'cancel_and_chat', remainder: tail }
}

/* ============================ 是否需要协议块 ============================ */

/** 明确的资料去留操作措辞（source_policy 触发信号） */
const SOURCE_OP_RE = /沿用|原资料|之前的?资料|刚才的?文件|换个?资料|换资料|重新选择资料|不要资料|去掉资料|清除资料|不(带|用)资料/

/** 明确的需求修改措辞（V2 需要协议：isAdjustment 在 V1 把「难一点」交给 LLM 判型，
 *  V2 统一聊天调用下这类短句必须携带协议才能被结构化吸收，实施路线 14 节验收） */
const MODIFY_RE =
  /(?:改成|改为|换成|变为|去掉|删除|移除|再加|减少|增加|多一点|少一点|再难|简单一点|简单一些|难一点|难一些|进阶|难度|再出|加题|改题|再来|补充要求|追加|主题|要求|题型|分配|总数)/

/** 判定「用户短回答是否无歧义命中当前唯一 nextQuestion」（实施路线 6.3 门禁 3②） */
export function isBareAnswerToNextQuestion(t: string, evaluation: DraftEvaluation): boolean {
  if (evaluation.missing.length !== 1) return false
  const only = evaluation.missing[0]
  if (only.code === 'TOTAL_REQUIRED') {
    return extractExplicitTotal(t) !== null || isDefaultAnswer(t)
  }
  return false
}

/**
 * 本轮是否要求协议块（实施路线 6.3 draftTurnPolicy）：
 * - 无草稿：有明确生题信号（出题动词 / 承接式题数规格）→ true；闲聊/假设/否定 → false。
 * - 有 active 草稿：明确修改词、对当前唯一 nextQuestion 的直接回答、明确 source 操作、
 *   新生题信号 → true；明显的一般知识闲聊 → false（漏协议不重试，草稿保持）。
 */
export function requiresDraftProtocol(
  input: string,
  draft: GenerationDraft | null,
  evaluation: DraftEvaluation | null,
): boolean {
  const t = (input ?? '').trim()
  if (!t) return false
  const freshSignal = hasExplicitGenIntent(t) || isGenSpecReply(t)
  if (draft && draft.lifecycle === 'active') {
    if (freshSignal) return true
    if (isAdjustment(t) || MODIFY_RE.test(t)) return true
    if (SOURCE_OP_RE.test(t)) return true
    if (evaluation && isBareAnswerToNextQuestion(t, evaluation)) return true
    return false
  }
  // 无活动草稿：否定/疑问/假设开头（「不要出题」「如果要出20题该怎么分配」）是拒绝或咨询，
  // 不要求协议——交一次普通聊天由模型结合语境回答（实施路线 6.3 门禁 1）
  if (NOT_A_REQUEST_RE.test(t)) return false
  return freshSignal
}

/* ============================ finalIntent 门禁（实施路线 6.3 唯一顺序） ============================ */

/** replace 只在用户明确表达「重新来一套/另出一套/换一个主题」时接受，否则降级 update */
const REPLACE_RE = /另出|另起|重新出|重新来|再来一套|换一个(?:主题|话题|方案)|换个新的?|换套/

export type FinalIntentDecision =
  | { kind: 'chat'; dropLocal: boolean }
  | { kind: 'update'; promoteReason?: 'explicit_signal' | 'bare_answer' }
  | { kind: 'replace' }
  | { kind: 'cancel' }

export interface FinalIntentParams {
  /** 用户本轮原文 */
  input: string
  /** 模型输出的 intent（协议解析成功）；null = 无协议块/解析失败 */
  modelIntent: 'chat' | 'update' | 'replace' | 'cancel' | null
  hasActiveDraft: boolean
  /** 当前活动草稿的评估（唯一缺项裸回答判定用） */
  evaluation: DraftEvaluation | null
  /** 本地确定性提取的显式补丁（可能为 null） */
  localPatch: DraftPatch | null
}

/**
 * 唯一 finalIntent 门禁（实施路线 6.3 规则 1～8）：
 * - 模型 update/replace 采纳；replace 无明确「另出一套」措辞降级 update。
 * - 模型 cancel 需本地取消语义佐证；无活动草稿时 cancel 当普通聊天。
 * - 模型 chat 仅两种情况提升为 update：①明确生题动词 + 非否定/非假设 + 可靠数字或题型；
 *   ②active 且唯一缺总数、系统刚追问、用户裸值直接回答。
 * - 其余一律 chat：本地数字提取结果必须丢弃（dropLocal），不得建草稿、不得改草稿。
 */
export function resolveFinalIntent(params: FinalIntentParams): FinalIntentDecision {
  const { input, modelIntent, hasActiveDraft, evaluation, localPatch } = params
  const t = (input ?? '').trim()

  if (modelIntent === 'cancel') {
    if (!hasActiveDraft) return { kind: 'chat', dropLocal: true } // 不创建 cancelled 空草稿
    const cancelish = isGenAbort(t) || CANCEL_GEN_RE.test(t)
    return cancelish ? { kind: 'cancel' } : { kind: 'chat', dropLocal: true }
  }

  if (modelIntent === 'replace') {
    if (!hasActiveDraft) return { kind: 'update' }
    return REPLACE_RE.test(t) ? { kind: 'replace' } : { kind: 'update' }
  }

  if (modelIntent === 'update') return { kind: 'update' }

  // modelIntent === 'chat' 或 null：按门禁 3/4 判定是否提升
  if (hasExplicitGenIntent(t) && localPatch !== null) {
    return { kind: 'update', promoteReason: 'explicit_signal' }
  }
  if (hasActiveDraft && localPatch !== null && MODIFY_RE.test(t)) {
    return { kind: 'update', promoteReason: 'explicit_signal' }
  }
  if (hasActiveDraft && evaluation && localPatch !== null && isBareAnswerToNextQuestion(t, evaluation)) {
    return { kind: 'update', promoteReason: 'bare_answer' }
  }
  return { kind: 'chat', dropLocal: true }
}
