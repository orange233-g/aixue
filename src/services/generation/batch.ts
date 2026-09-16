import type { ChatMessage } from '../../ai/types'
import { AIError } from '../../ai/types'
import { chat } from '../../ai/gateway'
import { parseMarkdown } from '../../ai/parse'
import type { AIConfig, Question, QuestionTypeId } from '../../types'
import { uid } from '../../utils'
import type { SessionSnapshot } from './session'

/** 每批最多题目数（硬上限，防超低权重题型无限批内）。实际批大小由 token 预算决定，见 splitBatches */
export const BATCH_MAX = 40

/**
 * 各题型单题预估输出 token 数（题干+选项+解析）。不同题型差异巨大：
 * 单选题可能仅 ~120 token，而案例分析/论述题可达 700+ token——若按固定每题 200 估算，
 * 一批 40 道论文题需 40×900=36000 token，远超单请求预算，必然被截断。
 * 权重取「偏保守」（宁可分批小、多调几批，也保证单批不超模型输出上限），
 * 并经真实 API 实测校准（智谱 GLM-4.5-air：论文 ~680+/题、案例 ~670/题、多选 ~200+/题）。
 * 铁律：兼容所有厂商，不针对单一模型硬编码，权重为通用启发式。
 */
export const QUESTION_WEIGHTS: Record<QuestionTypeId, number> = {
  single: 120,    // 单选
  multiple: 400,  // 多选（实测含选项+解析常>300/题，取保守值避免截断）
  judge: 100,     // 判断
  fill: 160,      // 填空
  match: 260,     // 匹配
  order: 260,     // 排序
  short: 420,     // 简答
  case: 800,      // 案例分析（实测 ~670/题；思考模型思考 token 也计入输出，取更保守值）
  essay: 1100,    // 论述/论文（实测 ~680+/题 + 思考模型长思考余量）
}

/**
 * 单批预估输出 token 预算：保证任意题型组合单批不超该值，兼容各厂商模型单次输出上限。
 * 取 6000 而非 8000：主流模型单次输出下限约 8192 token，若预算顶到 8000，
 * max_tokens 一旦逼近该上限，实际输出略超即触顶截断（实测多选 20 题/批即失败）。
 * 压低预算让单批 max_tokens 远离模型上限，留足实际输出余量，杜绝截断。
 */
export const MAX_BATCH_TOKENS = 6000
/** JSON 包装 / 推理思考等额外余量 */
export const TOKEN_HEADROOM = 2000
/** AI 模式题型未知，按最高权重保守分批，保证「某批恰好全是论文/分析题」也不超预算 */
export const AI_BATCH_WEIGHT = 900

/**
 * 单批生成参数：按「批题数 × 题型权重」动态推导，避免按固定上限或针对单一模型硬编码。
 * - maxTokens：预估输出 + JSON/思考余量
 * - timeout：按实测各厂商主流模型 ~20-60 token/s 的输出吞吐保守估算，再给充足网络余量。
 *   实测（智谱 GLM-4.5-air）：论文批 ~58 token/s，12 题约需 134s。超时过短会假超时导致大批次失败，
 *   故按「预估×20 + 60s 基础」留足余量，兼容不同厂商的慢速输出。
 */
export function batchParams(count: number, weight: number) {
  const estimate = count * weight
  return {
    maxTokens: Math.max(6000, estimate + TOKEN_HEADROOM),
    timeoutMs: Math.max(90_000, estimate * 20 + 60_000),
  }
}

/**
 * 归一化模型返回的 answer 为应用约定格式（见 PRD 5.2 / 4.7）：
 * 单选/多选/匹配/排序 → JSON 字符串（如 "[0]"）；判断 → "true"/"false"；填空/主观 → 文本。
 * 模型可能返回数组/布尔/对象，统一转成字符串，避免校验与判分崩溃。
 */
function normalizeAnswer(q: Question): string {
  const a = q.answer
  if (typeof a === 'string') return a
  if (q.type === 'judge') {
    if (typeof a === 'boolean') return String(a)
    if (Array.isArray(a)) return a[0] === 0 ? 'true' : 'false'
    if (typeof a === 'number') return a === 0 ? 'true' : 'false'
  }
  if (typeof a === 'number') return String(a)
  if (typeof a === 'boolean') return String(a)
  if (a === null || a === undefined) return ''
  return JSON.stringify(a)
}

export interface Batch {
  typeId: QuestionTypeId | 'ai'
  count: number
}

/**
 * 单批最大题数：由「(token 预算 − 余量) ÷ 题型权重」推导，使单批预估上限 + 余量 ≤ MAX_BATCH_TOKENS，
 * 即单批 max_tokens 恒 ≤ MAX_BATCH_TOKENS（=8000），稳在主流模型 8192 输出下限之内，杜绝截断。
 * 例：论文题 900 → 6000/900=6 道/批；单选题 120 → 50 道触顶 BATCH_MAX=40 道/批。
 */
export function maxPerBatchFor(typeId: QuestionTypeId | 'ai'): number {
  const weight = typeId === 'ai' ? AI_BATCH_WEIGHT : QUESTION_WEIGHTS[typeId]
  return Math.min(BATCH_MAX, Math.floor((MAX_BATCH_TOKENS - TOKEN_HEADROOM) / weight) || 1)
}

/** 按题型拆批：一种题型一批，批大小由该题型 token 权重决定，超出预算拆多批 */
export function splitBatches(structure: Record<QuestionTypeId, number>): Batch[] {
  const batches: Batch[] = []
  for (const [typeId, n] of Object.entries(structure)) {
    const count = Number(n)
    if (!Number.isFinite(count) || count <= 0) continue
    const id = typeId as QuestionTypeId
    const per = maxPerBatchFor(id)
    for (let start = 0; start < count; start += per) {
      batches.push({ typeId: id, count: Math.min(per, count - start) })
    }
  }
  return batches
}

/**
 * AI 推荐模式拆批：不预设题型，按最高权重保守分批，保证「某批恰好全是论文/分析题」也不超预算。
 * 例：总 100 题 → 12+12+...+4 共 9 批。
 */
export function splitAiBatches(total: number): Batch[] {
  const per = maxPerBatchFor('ai')
  const batches: Batch[] = []
  for (let start = 0; start < total; start += per) {
    batches.push({ typeId: 'ai', count: Math.min(per, total - start) })
  }
  return batches
}

/**
 * 单批生成（含截断续写与自适应降级，见 PRD 10.5）。
 * 截断续写：输出触顶（finish_reason=length）不丢弃已生成内容，把其作为 assistant 消息回传
 * 并要求模型从中断处继续，多段拼接后整体解析——替代旧的「整批丢弃重试」，不浪费已生成的 token。
 * 降级重试：拼接后仍解析失败（格式坏而非截断）才减半题数重来；网关已处理超时/限流重试。
 * @param buildMessages 按指定题数构建请求消息（降级时用它重建更小批次）
 */
export const MAX_CONTINUATIONS = 3

const CONTINUE_PROMPT =
  '你上一条输出因长度限制被截断了。请从中断处继续生成剩余题目，' +
  '保持与之前完全一致的格式（「=== 第 N 题 ===」与各字段），不要重复已生成的题目，不要输出任何解释。'

/** 批内按题干去重（续写拼接时模型可能重写中断处的题目开头） */
function dedupeByStem(list: Question[]): Question[] {
  const seen = new Set<string>()
  return list.filter((q) => {
    const key = q.stem.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function generateBatchQuestions(
  buildMessages: (count: number) => ChatMessage[],
  cfg: AIConfig,
  snapshot: SessionSnapshot,
  signal?: AbortSignal,
  onToken?: (delta: string, reasoning: string) => void,
  batchCount = 20,
  weight = 80,
): Promise<Question[]> {
  let count = batchCount
  // 三级降级链：目标 → 减半 → 1 题。批次越小成功率越高，最终 1 题级批次近乎必成
  for (let attempt = 0; attempt < 3; attempt++) {
    const { maxTokens, timeoutMs } = batchParams(count, weight)
    const base = buildMessages(count)
    let messages = base
    let prefix = ''
    // 内层续写循环：首请求 + 最多 MAX_CONTINUATIONS 次续写，逐段累积
    for (let c = 0; c <= MAX_CONTINUATIONS; c++) {
      const result = await chat(
        messages,
        {
          providerId: snapshot.providerId,
          model: snapshot.model,
          temperature: 0.6,
          maxTokens,
          timeoutMs,
          signal,
          module: 'generate',
          // SSE 流式：首 token 更快，且可透传实时生成进度（感知提速）
          stream: true,
          onToken,
        },
        cfg,
      )
      prefix += result.content
      if (result.finishReason !== 'length' || c === MAX_CONTINUATIONS) break
      // 截断续写：基于原始请求回传全量已生成内容，模型从中断处接着写（避免多轮历史重复累积）
      messages = [
        ...base,
        { role: 'assistant', content: prefix },
        { role: 'user', content: CONTINUE_PROMPT },
      ]
    }
    try {
      const list = parseMarkdown(prefix)
      return dedupeByStem(list)
        .slice(0, count)
        .map((q) => ({
          ...q,
          id: q.id || uid('q_'),
          kp_ids: q.kp_ids ?? [],
          answer: normalizeAnswer(q),
        }))
    } catch (e) {
      if (attempt === 2) throw e
      // 仅解析失败值得降级；鉴权/限流/超时/网络等降级无意义，直接抛出
      if (e instanceof AIError && e.code !== 'PARSE_FAILED') throw e
      // 降级：减半题数重试（至少 1 题），并同步重建更小批次消息
      count = Math.max(1, Math.floor(count / 2))
    }
  }
  throw new AIError('PARSE_FAILED', '模型输出解析失败')
}
