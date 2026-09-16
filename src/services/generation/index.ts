import type { AIConfig, GenerateRequest, Question, QuestionTypeId, RejectStats, Session } from '../../types'
import { QUESTION_TYPES } from '../../types'
import { AIError } from '../../ai/types'
import { uid } from '../../utils'
import { estimateTokens } from './context'
import { buildBatchMessages } from './context'
import {
  MdStreamAccumulator,
  BatchRawSequencer,
  generateStreamBatch,
  createRequestBudget,
  BATCH_SIZE,
  BATCH_CONCURRENCY,
  MAX_BACKFILL_ROUNDS,
} from './stream'
import { maxPerBatchFor } from './batch'
import type { Batch } from './batch'
import { compressSummary } from './summary'
import { decodeSnapshot, saveSession } from './session'

/**
 * 生成服务（见 PRD：流式小批量分批生成，解决「指定 100 题实际只成功一半」）。
 * - 固定每批 10 题小批量，循环直至凑够目标；每批请求携带已生成题干 + 知识点侧重轮换，避免批次间重复。
 * - 批次流水线并发（BATCH_CONCURRENCY）：多批同时流式在飞，消除批间「请求建立 + 首字等待」空转；
 *   各批使用独立累加器解析（避免并发流文本交错错乱），批结束统一合并进全局队列并跨批查重。
 * - SSE 流式接收 + 增量解析：单题块校验失败只丢该块，绝不影响其他题块。
 * - 截断续写 ≤2 次；缺口补齐循环直至目标或达 MAX_BACKFILL_ROUNDS / 请求预算上限（V2-I02）。
 * - 校验/查重通过后才统一写入题包；不足目标时正常交付已有题目（不报错中断）。
 * 只依赖 AI 网关统一接口，不关心底层厂商，切换模型零改动。
 */

export interface GenerateProgress {
  typeId: QuestionTypeId | 'working' | 'ai'
  done: number
  total: number
  questions: number
  status: 'running' | 'done'
  /** 数量保障补齐轮（初始批次跑完后按缺口自动补生成，UI 据此展示「补齐缺失题目」） */
  backfill?: boolean
  /** 目标总题数（含续跑种子）：进度分母以此为准，续跑时不依赖页面当前结构设置 */
  targetTotal?: number
}

export interface GenerateResult {
  questions: Question[]
  session: Session
  /** 失败并被跳过的批次数（部分成功，不中断全局，见失败隔离策略） */
  failedBatches: number
  /** 补齐循环后仍未达标的缺口（按题型；最终不足目标时正常交付已有题目） */
  deficitByType: Partial<Record<QuestionTypeId, number>>
  /** 生题阶段被过滤题块的按原因统计（解析失败/校验不过/重复，诊断缺口成因） */
  rejects: RejectStats
}

/** 生成结果描述（写入 AI 消息，供滑动窗口携带） */
export function describeGenerated(questions: Question[]): string {
  const byType = new Map<QuestionTypeId, number>()
  for (const q of questions) byType.set(q.type, (byType.get(q.type) ?? 0) + 1)
  const parts = [...byType.entries()].map(
    ([t, n]) => `${QUESTION_TYPES.find((x) => x.id === t)?.name ?? t} ${n} 道`,
  )
  return `已生成 ${questions.length} 道题：${parts.join('、')}。`
}

/** 补齐连续零进展轮数达到该值即停止（模型/配置层面失败，再试无意义） */
export const MAX_STALLED_ROUNDS = 3

function countByType(questions: Question[]): Map<QuestionTypeId, number> {
  const m = new Map<QuestionTypeId, number>()
  for (const q of questions) m.set(q.type, (m.get(q.type) ?? 0) + 1)
  return m
}

/** 按缺口构建本轮小批量队列（AI 模式仅按总数；自定义模式按题型余量），已耗竭题型跳过。
 *  自定义模式批大小按题型权重动态推导（token 预算 ÷ 权重，见 maxPerBatchFor）：
 *  低权重客观题大批量（单选 33/批、判断 40/批）摊薄每批「思考 + 首字等待」固定开销；
 *  AI 模式题型未知，维持保守 BATCH_SIZE。 */
function buildStreamBatches(
  req: GenerateRequest,
  questions: Question[],
  exhausted: ReadonlySet<QuestionTypeId | 'ai'>,
): Batch[] {
  if (req.source === 'ai') {
    if (exhausted.has('ai')) return []
    const deficit = Math.max(0, Object.values(req.structure).reduce((a, b) => a + b, 0) - questions.length)
    const out: Batch[] = []
    for (let s = 0; s < deficit; s += BATCH_SIZE) {
      out.push({ typeId: 'ai', count: Math.min(BATCH_SIZE, deficit - s) })
    }
    return out
  }
  const byType = countByType(questions)
  const out: Batch[] = []
  for (const [t, nRaw] of Object.entries(req.structure)) {
    const id = t as QuestionTypeId
    if (exhausted.has(id)) continue
    const remaining = Number(nRaw) - (byType.get(id) ?? 0)
    if (remaining <= 0) continue
    const per = maxPerBatchFor(id)
    for (let s = 0; s < remaining; s += per) {
      out.push({ typeId: id, count: Math.min(per, remaining - s) })
    }
  }
  return out
}

/** 初始批次总数估算（进度分母）：自定义按各题型动态批大小累加，AI 模式按保守 BATCH_SIZE；
 *  断点续跑（seed）时只估算缺口部分，进度从已完成题数起算 */
function estimateBatches(req: GenerateRequest, seed?: Question[]): number {
  if (req.source === 'ai') {
    const total = Object.values(req.structure).reduce((a, b) => a + b, 0)
    return Math.max(1, Math.ceil(Math.max(0, total - (seed?.length ?? 0)) / BATCH_SIZE))
  }
  const byType = countByType(seed ?? [])
  let n = 0
  for (const [t, c] of Object.entries(req.structure)) {
    const count = Number(c)
    if (!Number.isFinite(count) || count <= 0) continue
    n += Math.ceil(Math.max(0, count - (byType.get(t as QuestionTypeId) ?? 0)) / maxPerBatchFor(t as QuestionTypeId))
  }
  return Math.max(1, n)
}

/**
 * 一次完整生成流程：流式分批 → 缺口补齐 → 更新会话 → 保存。
 * @param onProgress 每批/每块进度回调（questions = 实时已入库数，UI 展示「已生成 X/目标」）
 * @param onDraft    每批结束后回调当前已校验题目，调用方可持久化工作草稿（断网/停止不丢）
 * @param signal     用户中断生成（中止时抛 ABORTED，已生成部分已通过 onDraft 保留）
 * @param seedQuestions 断点续跑种子：已生成题目预置进累加器（计入进度与查重），本流程只生成缺口部分
 * @param skipUserMsg 用户消息已由调用方（send 乐观写入）追加进会话，这里只补助手消息
 * @param skipSessionUpdate 多卷流水线的中间卷：不追加会话消息、不压缩摘要、不保存会话
 *  （整轮只由末卷/收尾方写一次会话，避免每卷各写一条「已生成 X 道题」刷屏；蕴含跳过用户消息）
 */
export async function runGeneration(
  session: Session,
  input: string,
  req: GenerateRequest,
  cfg: AIConfig,
  onProgress?: (p: GenerateProgress) => void,
  signal?: AbortSignal,
  onToken?: (delta: string, reasoning: string) => void,
  onDraft?: (questions: Question[]) => Promise<void> | void,
  seedQuestions?: Question[],
  skipUserMsg?: boolean,
  skipSessionUpdate?: boolean,
): Promise<GenerateResult> {
  const snapshot = decodeSnapshot(session.provider)
  const targetTotal = Object.values(req.structure).reduce((a, b) => a + b, 0)
  const acc = new MdStreamAccumulator()
  if (seedQuestions?.length) acc.seed(seedQuestions)
  let failedBatches = 0
  let done = 0
  let total = estimateBatches(req, seedQuestions)

  onProgress?.({
    typeId: 'working',
    done: 0,
    total,
    questions: acc.accepted.length,
    status: 'running',
    targetTotal,
    ...(seedQuestions?.length ? { backfill: true } : {}),
  })
  // 在飞批次本地已解析题数（进度 = 已合并 + 在飞，批内逐题实时跳动）
  const inflight = new Map<number, number>()
  // 进度必须全程统一口径「已合并 + 在飞」：曾出现流式期报「已合并+在飞」、批结束时报「仅已合并」
  // 两种口径交替，批合并瞬间其他在飞批次的题数被剔除，显示回跳几十题（60→30→70）
  const emit = () =>
    onProgress?.({
      typeId: 'working',
      done,
      total,
      questions: acc.accepted.length + [...inflight.values()].reduce((a, b) => a + b, 0),
      status: 'running',
      targetTotal,
    })
  acc.onAccepted = emit

  let round = 0
  let stalled = 0
  let batchSeq = 0
  const rawSequencer = new BatchRawSequencer()
  // V2-I02：跨轮累计的真实请求预算（每批内续写 + 网关重试都计入）。以“目标题数/单批”为基数，
  // 向上留出补齐全批与部分重试的余量，作为最坏请求数的硬上界；耗尽即停止追加请求、交付已有题目。
  const budget = createRequestBudget(Math.max(12, Math.ceil(Math.max(targetTotal, 1) / BATCH_SIZE) * 5))
  // 拥塞控制的并发额度与冷却截止跨补齐轮保留：限流降速的「学费」不因新一轮从低并发重新交一遍
  // （低额度厂商每轮重置都会再撞一次 429 才降速，表现为限流提示反复出现）。
  // 初始 4 路（原 2）：120 题拆 12 批时首批只有 2 路在飞、批间等待明显；限流自适应减半机制保留，风险可控
  let limit = Math.min(4, BATCH_CONCURRENCY)
  let cooldownUntil = 0
  const exhausted = new Set<QuestionTypeId | 'ai'>()
  const lowYield = new Map<QuestionTypeId | 'ai', number>()
  /** 最近一次批次失败的真实错误（全失败时据此给出针对性提示；holder 避免闭包赋值被 CFA 收窄成 null） */
  const batchErrBox: { err: AIError | null } = { err: null }
  // 草稿持久化串行链：并发批次完成时机不定，链式排队保证 IndexedDB 写入顺序与数据新近性
  let draftChain: Promise<void> = Promise.resolve()
  const queueDraft = (qs: Question[]) => {
    draftChain = draftChain
      .then(() => onDraft?.(qs))
      .catch((err) => console.warn('[gen] 草稿落盘失败', err))
  }
  while (round < MAX_BACKFILL_ROUNDS && !signal?.aborted && budget.used < budget.max) {
    if (acc.accepted.length >= targetTotal) break
    const queue = buildStreamBatches(req, acc.accepted, exhausted)
    if (!queue.length) break
    // 批次总数随补齐轮动态更新：total 初值只是首轮估算，补齐轮会新增批次（done 持续增长），
    // 不更新会出现「批次 15/14」——当前批次号超过总批次数的矛盾显示
    total = done + queue.length
    const before = acc.accepted.length
    // 拥塞控制（TCP 式：低起步 + 加性升 + 乘性降）：多批同时流式在飞消除批间空转。
    // 厂商并发额度差异极大（air 档实测 ~2 路，更高档可 8+），且超额请求多被厂商**排队而非立即 429**——
    // 「先少发、稳了再升」才能两头兼顾：低额度厂商不遭排队，高额度厂商数批内自动爬满上限。
    // （limit / cooldownUntil 声明在轮循环外：学到的额度跨补齐轮保留）
    let cursor = 0
    let active = 0
    // P-04：在飞批次名义题数预留。调度停止条件 = 已合并(accepted) + 在飞预留(reserved) ≥ 目标，
    // 并发批次已足够填满缺口时停止继续发请求，避免超额发起后再被截断（浪费 token/时间/解析开销）。
    let reserved = 0
    const runBatch = async (b: Batch): Promise<'ok' | 'limited' | 'fail'> => {
      const seq = batchSeq++
      // 每批独立累加器：并发流式文本互不混写；结束时 absorb 合并进全局（跨批题干查重）
      const local = new MdStreamAccumulator()
      local.onAccepted = () => {
        inflight.set(seq, local.accepted.length)
        emit()
      }
      // DEV 实时面板：并发流交错，批首插入分隔标记便于肉眼区分
      let marked = false
      const emitRaw = onToken
      const onTokenBatch: typeof onToken = emitRaw
        ? (delta: string, reasoning: string) => {
            const onToken = emitRaw!
            rawSequencer.push(seq, delta, reasoning, emitRaw)
            return
            if (!marked && delta) {
              marked = true
              onToken(`\n——— 批次 #${seq + 1} ———\n`, '')
            }
            onToken(delta, reasoning)
          }
        : undefined
      let batchResult: 'ok' | 'limited' | 'fail' = 'ok'
      try {
        await generateStreamBatch(
          {
            acc: local,
            buildMessages: (count, focus) =>
              buildBatchMessages(session, req, b.typeId, count, acc.accepted, focus),
            cfg,
            snapshot,
            signal,
            onToken: onTokenBatch,
            budget,
          },
          b.typeId,
          b.count,
          // 侧重按全局批次序轮换：并发同题型批次拿到不同侧重，降低跨批重复率
          seq,
        )
      } catch (e) {
        // 预算耗尽属于「受控收尾」而非批次失败：不计数、不报错，缺口已自解释交由后续判断
        const budgetExhausted = e instanceof AIError && e.code === 'ABORTED' && budget.used >= budget.max
        if (!signal?.aborted && !budgetExhausted) {
          failedBatches++
          if (e instanceof AIError) batchErrBox.err = e
          console.warn(`[gen] 批次 #${seq + 1} 失败:`, e)
          // DEV 实时面板同步展示失败原因，测试期直接可见（换模型/换 Key 后的 401/404 一眼定位）
          onToken?.(`\n[批次 #${seq + 1} 失败] ${e instanceof Error ? e.message : String(e)}\n`, '')
        }
        batchResult = e instanceof AIError && e.code === 'RATE_LIMITED' ? 'limited' : signal?.aborted || budgetExhausted ? 'ok' : 'fail'
      }
      if (emitRaw) rawSequencer.finish(seq, emitRaw)
      // 无论成败都合并：批中途超时/失败时已解析出的部分题目不丢弃（对齐旧串行共享累加器行为）
      inflight.delete(seq)
      acc.absorb(local)
      emit()
      queueDraft(acc.accepted)
      // 题型耗竭检测：本批自身产出（local 口径）连续两批 ≤1 即认为该题型已被模型榨干
      if (local.accepted.length <= 1 && batchResult === 'ok') {
        lowYield.set(b.typeId, (lowYield.get(b.typeId) ?? 0) + 1)
        if ((lowYield.get(b.typeId) ?? 0) >= 2) exhausted.add(b.typeId)
      } else if (batchResult === 'ok') {
        lowYield.set(b.typeId, 0)
      }
      done++
      emit()
      return batchResult
    }
    const running = new Set<Promise<void>>()
    // 连续失败熔断（真机 6.x：网络不稳时批次 32~36 连环失败仍无限重发）：
    // 连续 3 批失败 → 降并发 + 冷却；连续 5 批失败 → 本轮暂停（草稿保留，可「继续补齐」续跑）
    let consecFails = 0
    let circuitBroken = false
    while (
      running.size > 0 ||
      (cursor < queue.length &&
        !signal?.aborted &&
        !circuitBroken &&
        budget.used < budget.max &&
        acc.accepted.length + reserved < targetTotal)
    ) {
      if (
        cursor < queue.length &&
        active < limit &&
        Date.now() >= cooldownUntil &&
        !signal?.aborted &&
        !circuitBroken &&
        budget.used < budget.max &&
        acc.accepted.length + reserved < targetTotal
      ) {
        const b = queue[cursor++]
        if (exhausted.has(b.typeId)) continue // 已耗竭题型跳过：不占并发名额、不计批次
        reserved += b.count // 预留本批名义题数，纳入填坑判断
        active++
        const p = runBatch(b)
          .then((result) => {
            if (result === 'limited') {
              limit = Math.max(1, Math.floor(limit / 2))
              cooldownUntil = Date.now() + 15_000
              onToken?.(`\n[调度] 限流：并发降至 ${limit}，冷却 15s\n`, '')
            } else if (result === 'fail') {
              consecFails++
              if (consecFails >= 3) {
                limit = Math.max(1, Math.floor(limit / 2))
                cooldownUntil = Date.now() + 15_000
                onToken?.(`\n[调度] 连续 ${consecFails} 批失败：并发降至 ${limit}，冷却 15s\n`, '')
              }
              if (consecFails >= 5) {
                circuitBroken = true
                onToken?.(`\n[调度] 连续 ${consecFails} 批失败，已暂停生成（网络/服务不稳）——已生成 ${acc.accepted.length} 题已保留，网络恢复后点「继续补齐」续跑\n`, '')
              }
            } else {
              consecFails = 0
              if (limit < BATCH_CONCURRENCY && Date.now() >= cooldownUntil) {
                // 加性升：每成功一批 +1，直到上限（冷却期不升）
                limit++
              }
            }
          })
          .finally(() => {
            // 释放预留：本批已产出并入 accepted，未产出即放弃该额度；已合并 + 预留回落 → 未达目标则继续补齐
            reserved -= b.count
            active--
            running.delete(p)
          })
        running.add(p)
        // 错峰启动（300ms）：避免新批次瞬时齐发触发厂商 RPM 类限流
        await new Promise((r) => setTimeout(r, 300))
      } else {
        await new Promise((r) => setTimeout(r, 120))
      }
    }
    await Promise.all([...running])
    round++
    // 熔断暂停：保留草稿按「不足额结束」收尾（缺口标注 + 继续补齐），不再空转烧批次
    if (circuitBroken) break
    if (acc.accepted.length === before) {
      if (++stalled >= MAX_STALLED_ROUNDS) break
    } else {
      stalled = 0
    }
  }

  // 冲刷残留的草稿持久化，避免链上迟到写入覆盖调用方随后的最终保存
  await draftChain

  if (signal?.aborted) {
    // 中止：把内存中已生成题目随异常带回（调用方优先用内存数据兜底，避免草稿写盘失败导致已生成题目丢失）
    throw Object.assign(new Error('ABORTED'), { partial: acc.accepted })
  }

  // 全部失败：无内容可保存，直接报错（否则空会话入库）
  if (acc.accepted.length === 0) {
    // 优先给出真实失败原因（按错误码归类，通用提示不绑厂商），帮助换模型/换 Key 后快速定位
    const lastBatchErr = batchErrBox.err
    if (failedBatches > 0 && lastBatchErr) {
      const hints: Record<string, string> = {
        AUTH_FAILED: '鉴权失败，请检查该厂商的 API Key',
        MODEL_NOT_FOUND: '模型或接口地址不存在，请检查模型名与 baseUrl',
        RATE_LIMITED: '触发厂商限流，请稍后重试或降低并发',
        TIMEOUT: '响应超时，模型过慢（可关闭思考或减少单批题数）',
        NETWORK: '网络/请求被拒绝，请检查网络与厂商参数兼容性',
        PARSE_FAILED: '模型返回内容异常',
      }
      throw new AIError(
        lastBatchErr.code,
        `所有批次请求失败（${failedBatches} 批）：${lastBatchErr.message}。${hints[lastBatchErr.code] ?? '请检查模型配置后重试'}`,
      )
    }
    if (acc.stats.parse + acc.stats.invalid > 0) {
      throw new Error(
        `模型有返回但未解析出有效题目（解析失败 ${acc.stats.parse} 块、校验不通过 ${acc.stats.invalid} 块），` +
          '该模型输出格式可能不符，建议换回已验证模型或关闭思考后重试',
      )
    }
    throw new Error('所有批次生成均失败，请检查模型配置（或关闭思考）后重试')
  }

  // 超量截断到目标：模型不严格遵守 count 时可能多输出（如要求 20 题实际 22 题），
  // 全采纳会造成「显示 20、实际 22」不一致且校验报数量不符。AI 模式题型自由搭配按总数全局截断；
  // 自定义模式按题型分别截断，保证各题型不超结构设定（保留生成顺序，多出的丢弃）。
  let questions = acc.accepted
  if (req.source === 'ai') {
    questions = acc.accepted.slice(0, targetTotal)
  } else {
    const capped: Question[] = []
    const byTypeCount = new Map<QuestionTypeId, number>()
    for (const q of acc.accepted) {
      const target = req.structure[q.type] ?? 0
      const cur = byTypeCount.get(q.type) ?? 0
      if (cur >= target) continue
      byTypeCount.set(q.type, cur + 1)
      capped.push(q)
    }
    questions = capped
  }

  // 更新会话：追加用户 / AI 消息 + 摘要压缩 + 保存（多卷中间卷 skipSessionUpdate 跳过整段，
  // 由末卷一次性写入合并结果；用户消息已由 send() 乐观写入时跳过）
  if (!skipSessionUpdate) {
    if (!skipUserMsg) {
      session.messages.push({ id: uid('m_'), role: 'user', content: input, tokens: estimateTokens(input) })
    }
    const reply = describeGenerated(questions)
    session.messages.push({ id: uid('m_'), role: 'assistant', content: reply, tokens: estimateTokens(reply) })
    // 摘要压缩失败绝不可阻断结果交付：推理模型未关思考/额度耗尽时该调用可能超时，
    // 若抛错会把「已生成部分题目」整体判成 error，导致已生成题目无法通过「继续补齐」恢复（只能重试从头来）。
    try {
      session.summary = await compressSummary(session, cfg, snapshot)
    } catch (e) {
      console.warn('[gen] 摘要压缩失败，降级保留旧摘要', e)
    }
    await saveSession(session)
  }

  // 最终缺口（AI 模式题型自由搭配，仅按总数口径报告）
  const deficitByType: Partial<Record<QuestionTypeId, number>> = {}
  if (req.source === 'ai') {
    const deficit = targetTotal - questions.length
    if (deficit > 0) deficitByType.single = deficit
  } else {
    const byType = countByType(questions)
    for (const [t, nRaw] of Object.entries(req.structure)) {
      const deficit = Number(nRaw) - (byType.get(t as QuestionTypeId) ?? 0)
      if (deficit > 0) deficitByType[t as QuestionTypeId] = deficit
    }
  }

  return { questions, session, failedBatches, deficitByType, rejects: acc.stats }
}

export * from './session'
export * from './context'
export * from './summary'
export * from './structure'
export * from './stream'
export * from './pack'
export * from './genTexts'
