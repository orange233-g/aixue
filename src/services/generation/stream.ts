import type { ChatMessage } from '../../ai/types'
import { chat } from '../../ai/gateway'
import { parseMarkdown } from '../../ai/parse'
import type { AIConfig, Question, QuestionTypeId, RejectStats } from '../../types'
import { uid } from '../../utils'
import type { SessionSnapshot } from './session'
import { batchParams, QUESTION_WEIGHTS, AI_BATCH_WEIGHT } from './batch'
import { validateAnswer } from '../validation'

/**
 * 流式小批量生成（见 PRD：解决「指定 100 题实际只成功一半」）。
 * - 固定每批 10 题，循环请求直至凑够目标，避免单次请求触顶截断丢后半段。
 * - SSE 流式接收 + 增量解析：每收完一个完整题块立即解析/校验/查重/暂存，进度实时可见。
 * - 单题块校验失败只丢弃这一块，绝不连坐其他题块。
 * - 截断（finish_reason=length）自动续写 ≤2 次，续写内容继续进缓冲区增量解析。
 * - 校验通过的题目先进内存队列（题干哈希查重），全部结束后统一写入题包，避免半成品污染。
 */

/** 单批固定题目数 */
export const BATCH_SIZE = 10
/** 单响应触顶后最多续写次数 */
export const MAX_CONTINUATIONS = 2
/** 整次生成的补齐轮上限（含补齐轮，防极端场景无限烧 token） */
export const MAX_BACKFILL_ROUNDS = 15
/**
 * 批次流水线并发数：当前批仍在流式输出时，后续批次请求已并发在飞，
 * 消除「批与批之间」的请求建立 + 首字等待空转（表现为每 10 题卡顿）。
 * 过高易触发厂商限流（429，由网关重试兜底）；过低则流水线收益不明显。
 */
export const BATCH_CONCURRENCY = 8

/**
 * 并发批次的原文串行器：批次可以并发接收 token，但对外展示按 batchSeq 顺序冲刷。
 * 这样实时面板不会把批次 A 的半截题干和批次 B 的选项拼在一起；代价是只延迟到
 * 当前批次结束才展示该批原文，解析/进度仍然保持逐题实时。
 */
export class BatchRawSequencer {
  private readonly pending = new Map<number, { text: string; reasoning: string; done: boolean }>()
  private nextSeq = 0

  push(seq: number, delta: string, reasoning: string, onEmit: (delta: string, reasoning: string) => void): void {
    const item = this.pending.get(seq) ?? { text: '', reasoning: '', done: false }
    item.text += delta
    item.reasoning += reasoning
    this.pending.set(seq, item)
    this.flush(onEmit)
  }

  finish(seq: number, onEmit: (delta: string, reasoning: string) => void): void {
    const item = this.pending.get(seq) ?? { text: '', reasoning: '', done: false }
    item.done = true
    this.pending.set(seq, item)
    this.flush(onEmit)
  }

  private flush(onEmit: (delta: string, reasoning: string) => void): void {
    while (this.pending.get(this.nextSeq)?.done) {
      const item = this.pending.get(this.nextSeq)!
      if (item.text || item.reasoning) {
        onEmit(`\n——— 批次 #${this.nextSeq + 1} ———\n${item.text}`, item.reasoning)
      }
      this.pending.delete(this.nextSeq)
      this.nextSeq++
    }
  }
}

const CONTINUE_PROMPT =
  '你上一条输出被截断了。请从中断处继续生成剩余题目，' +
  '保持与之前完全一致的格式（「=== 第 N 题 ===」与各字段），不要重复已生成的题目，不要输出任何解释。'

/**
 * 流式球块累加器：维护字符串缓冲区，识别到完整题块立即解析校验入库并从缓冲区移除。
 * 续写的后半块自动拼入缓冲区继续增量解析，无需整体重来。
 */
export class MdStreamAccumulator {
  /** 校验 + 题干哈希查重通过的题目（内存队列，最后统一写入题包） */
  accepted: Question[] = []
  /** 被丢弃的题块数（校验不通过 / 重复），用于诊断 */
  rejected = 0
  /** 被过滤题块的按原因统计（语义与 rejected 一致，拆开便于定位缺口成因） */
  stats: RejectStats = { parse: 0, invalid: 0, duplicate: 0, invalidByReason: {} }
  onAccepted?: () => void
  private seen = new Set<string>()
  private buffer = ''

  /** 题干哈希（去重）。去空白后 FNV-1a，稳定且可跨批查重 */
  stemHash(stem: string): string {
    let h = 2166136261
    for (const ch of stem.replace(/\s+/g, '')) {
      h ^= (ch.codePointAt(0) as number) & 0xffff
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(36)
  }

  /** 追加流式增量文本（delta），边收边解析 */
  feed(chunk: string): void {
    this.buffer += chunk
    this.drain(false)
  }

  /** 响应结束：冲刷当前块（不完整尾块会被校验规则自然丢弃） */
  finish(): void {
    this.drain(true)
    this.buffer = ''
  }

  /** 断点续跑种子：预置已生成题目（计入 accepted 并登记查重哈希），后续批次只补缺口 */
  seed(questions: Question[]): void {
    for (const q of questions) {
      this.seen.add(this.stemHash(q.stem))
      this.accepted.push(q)
    }
  }

  /**
   * 流水线并发合并：把批次本地累加器的结果并入本累加器（跨批题干查重）。
   * 并发生成的多条 SSE 流不能写同一缓冲区（增量文本会交错导致块边界错乱），
   * 故每批用独立实例边收边解析，批结束后经此方法合并进全局队列。
   */
  absorb(other: MdStreamAccumulator): void {
    for (const q of other.accepted) {
      const hash = this.stemHash(q.stem)
      if (this.seen.has(hash)) {
        this.rejected++
        this.stats.duplicate++
        continue
      }
      this.seen.add(hash)
      this.accepted.push(q)
      this.onAccepted?.()
    }
    this.rejected += other.rejected
    this.stats.parse += other.stats.parse
    this.stats.invalid += other.stats.invalid
    this.stats.duplicate += other.stats.duplicate
    for (const [k, v] of Object.entries(other.stats.invalidByReason)) {
      this.stats.invalidByReason[k] = (this.stats.invalidByReason[k] ?? 0) + v
    }
  }

  /** 把粘连在上一行末尾的题块起始符补上换行（SSE 分片可能不带前导换行，如「难度：2=== 第 2 题 ===」） */
  private normalizeSeparators(text: string): string {
    return text.replace(/([^\n])(?=(?:={3,}|#{2,})\s*第[\s0-9]*\s*题)/g, '$1\n')
  }

  private drain(atEnd: boolean): void {
    this.buffer = this.normalizeSeparators(this.buffer)
    const starts = this.findStartIndices(this.buffer)
    // 非末尾：消费所有「前后均有后续题块起始」的完整块，仅保留最后一个可能未完块
    for (let k = 0; k < starts.length - 1; k++) this.take(starts[k], starts[k + 1])
    if (atEnd) {
      // 响应结束：末尾残块也按完整块尝试解析（不完整字段被校验规则自然丢弃）
      if (starts.length >= 1) this.take(starts[starts.length - 1], this.buffer.length)
      this.buffer = ''
    } else if (starts.length >= 2) {
      this.buffer = this.buffer.slice(starts[starts.length - 1])
    }
  }

  /** 提取一段完整块并解析；失败/非法/重复只影响本块 */
  private take(from: number, to: number): void {
    const block = this.buffer.slice(from, to)
    if (!block.trim()) return
    let qs: Question[]
    try {
      qs = parseMarkdown(block)
    } catch {
      this.rejected++
      this.stats.parse++
      return
    }
    for (const q of qs) {
      const errs = validateStreamQuestion(q)
      if (errs.length) {
        this.rejected++
        this.stats.invalid++
        for (const e of errs) this.stats.invalidByReason[e] = (this.stats.invalidByReason[e] ?? 0) + 1
        continue
      }
      const hash = this.stemHash(q.stem)
      if (this.seen.has(hash)) {
        this.rejected++
        this.stats.duplicate++
        continue
      }
      this.seen.add(hash)
      q.id = q.id || uid('q_')
      q.kp_ids = q.kp_ids ?? []
      this.accepted.push(q)
      this.onAccepted?.()
    }
  }

  /** 题块起始：优先用「=== 第 N 题 === / ## 第 N 题」作为块分隔（题干格式稳定）；
   *  仅当全段无此类分隔时（模型漏写题头），退化为用「题型：」行切块，保持兼容。 */
  private findStartIndices(text: string): number[] {
    const parts = text.split('\n')
    // F-04：两项都要对文本实际调用 .test()（此前第二项误写成正则对象而恒为真）
    const hard = /^={3,}\s*第/m.test(text) || /^#{2,}\s*第/m.test(text)
    const idx: number[] = []
    let lineStart = 0
    for (const line of parts) {
      const s = line.trim()
      if (/^={3,}\s*第/.test(s) || /^#{2,}\s*第/.test(s) || (!hard && /^题型\s*[:：]/.test(s))) {
        idx.push(lineStart)
      }
      lineStart += line.length + 1
    }
    return idx
  }
}

/**
 * 流式生成期校验（见 PRD）：题干/答案/解析必填；单选项恰 4 个；答案索引在选项范围内。
 * 与入库后的 validateQuestion 规则对齐，保证采纳即合格，入库后无需再逐个剔除。
 */
export function validateStreamQuestion(q: Question): string[] {
  const errs: string[] = []
  if (!q.stem?.trim()) errs.push('题干缺失')
  if (!q.answer?.trim()) errs.push('答案缺失')
  if (!q.explanation?.trim()) errs.push('解析缺失')
  if (q.type === 'single' && (!q.options || q.options.length !== 4)) errs.push('单选题选项须为 4 个')
  // 判断题 hasOptions=true，须给出「A.正确 / B.错误」选项（与入库后 validateStructure 对齐，采纳即合格）
  if (q.type === 'judge' && (!q.options || q.options.length < 2)) errs.push('判断题须有「正确/错误」选项')
  if (q.type === 'single' || q.type === 'multiple') {
    let idx: unknown
    try {
      idx = JSON.parse(q.answer || '[]')
    } catch {
      idx = null
    }
    const optsLen = q.options?.length ?? 0
    if (!Array.isArray(idx) || idx.some((i) => typeof i !== 'number' || i < 0 || i >= optsLen)) {
      errs.push('答案索引超出选项范围')
    }
  }
  if (q.type === 'judge' && !['true', 'false'].includes(q.answer)) errs.push('判断题答案必须为 true/false')
  if (q.type === 'order') errs.push(...validateAnswer(q))
  return errs
}

/** 知识点侧重轮换（每批不同侧重，保证题目分布均匀、覆盖更多角度） */
export function rotationHint(round: number): string {
  const aspects = ['基础概念与核心原理', '细节、边界与特殊情形', '易混淆点辨析', '应用场景与综合运用']
  return aspects[round % aspects.length]
}

export interface StreamBatchCtx {
  acc: MdStreamAccumulator
  /** 按 (count, 侧重) 构建请求消息（去重列表取 acc.accepted，随生成实时增长） */
  buildMessages: (count: number, focus: string) => ChatMessage[]
  cfg: AIConfig
  snapshot: SessionSnapshot
  signal?: AbortSignal
  onToken?: (delta: string, reasoning: string) => void
  /** 跨批次累计的真实网络请求预算（V2-I02）：每 attempt（含续写/网关重试）计数，耗尽即停止 */
  budget?: GenRequestBudget
}

/**
 * 跨批次累计的请求预算（V2-I02）。以「真实网络请求次数」为硬上限（每 batch 内续写与网关重试都计入），
 * 保证最坏请求数上界透明；总 token/预估费用上限因需模型完成后才能精确得出，由调用方在 UI 层以
 * ≥目标题数的预计费用做开启前的二次确认兜底（见 PRD 生成确认）。
 */
export interface GenRequestBudget {
  /** 已累计的真实 request 次数 */
  used: number
  /** 本次生成的请求数硬上限（由调用方按目标题数估算） */
  max: number
  /** 回调：返回 false 表示已超预算，网关立即中止当前调用 */
  onRequest: (attempt: number) => boolean
}

/** 创建预算对象：超过 true 即拒绝后续请求 */
export function createRequestBudget(max: number): GenRequestBudget {
  const b = { used: 0, max }
  const onRequest: GenRequestBudget['onRequest'] = () => {
    const next = b.used + 1
    if (next > b.max) return false
    b.used = next
    return true
  }
  return { ...b, onRequest }
}

function batchWeight(typeId: QuestionTypeId | 'ai'): number {
  return typeId === 'ai' ? AI_BATCH_WEIGHT : QUESTION_WEIGHTS[typeId]
}

/**
 * 生成一批（固定 count 题 ≤ BATCH_SIZE，流式增量解析）。触顶自动续写 ≤MAX_CONTINUATIONS 次。
 * 返回后 acc 即已累积本批校验通过的题目；抛错由调用方按批次隔离跳过。
 */
export async function generateStreamBatch(
  ctx: StreamBatchCtx,
  typeId: QuestionTypeId | 'ai',
  count: number,
  round: number,
): Promise<void> {
  const focus = rotationHint(round)
  const { maxTokens, timeoutMs } = batchParams(count, batchWeight(typeId))
  let prefix = ''
  const onDelta = (delta: string, reasoning: string) => {
    prefix += delta
    ctx.acc.feed(delta)
    ctx.onToken?.(delta, reasoning)
  }
  let base = ctx.buildMessages(count, focus)
  let messages = base
  for (let c = 0; c <= MAX_CONTINUATIONS; c++) {
    const result = await chat(
      messages,
      {
        providerId: ctx.snapshot.providerId,
        model: ctx.snapshot.model,
        temperature: 0.6,
        maxTokens,
        timeoutMs,
        signal: ctx.signal,
        module: 'generate',
        // SSE 流式：首 token 更快，且逐块边收边解析
        stream: true,
        onToken: onDelta,
        // V2-I02：每次 attempt（含本批内续写 + 网关重试）计入跨批请求预算
        onRequest: ctx.budget?.onRequest,
      },
      ctx.cfg,
    )
    if (ctx.signal?.aborted) return
    if (result.finishReason !== 'length' || c === MAX_CONTINUATIONS) break
    // 截断续写：回传全量已生成文本，模型从中断处继续（续写串拼入同一缓冲区）
    messages = [
      ...base,
      { role: 'assistant', content: prefix },
      { role: 'user', content: CONTINUE_PROMPT },
    ]
  }
  ctx.acc.finish()
}
