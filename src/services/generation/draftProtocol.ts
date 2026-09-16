/**
 * 协议 V2：DraftPatchWireV2 围栏提取 / 解析 / 校验 / 本地显式合并（实施路线 4.3、4.4、6.1、6.2 / TASK-03）。
 *
 * 职责边界：
 * - 模型只提交「本轮增量」（wire JSON，snake_case），不返回完整草稿，
 *   也不输出 complete/gathering/ready/show_button（白名单外键一律拒绝）。
 * - 本模块把 wire 归一为内部 camelCase DraftPatch；turnId/expectedDraftId/baseRevision
 *   由 App 经 DraftTurnContext 注入，模型伪造这些字段按未知键拒绝。
 * - 解析失败返回稳定错误码对象，绝不抛出到 UI，也绝不改变草稿。
 * - evidence 校验使用唯一规范化函数：NFKC + 小写 + 去空白/标点后必须是用户原文的非空子串；
 *   普通字段未通过降级 model_inferred；count_plan 数值操作直接 COUNT_NOT_EXPLICIT 拒绝；
 *   unset/remove/source_policy 未通过则拒绝该操作。
 * - 本模块不写 Store、不决定 finalIntent（那是 TASK-04 draftTurnPolicy 的门禁职责）。
 */
import type {
  CountPlanPatch,
  DraftPatch,
  DraftValue,
  GenerationDraft,
  QuestionTypeId,
} from '../../types'
import { chineseToInt, normalizeTypeKey, parseTypeStructure } from './intentRules'
import { stripUntrustedMarkers } from './context'

/* ============================ 错误码与结果 ============================ */

/** 稳定协议错误码：调用方据此决定重试/固定提示（实施路线 6.5） */
export type DraftProtocolErrorCode =
  | 'NO_PROTOCOL_BLOCK' // 模型本轮没有输出协议块
  | 'INVALID_JSON' // JSON 损坏/截断/垃圾
  | 'SCHEMA_INVALID' // schema_version 不符 / 结构类型错误 / 字段互斥
  | 'UNKNOWN_KEY' // 未知顶层键 / patch 键 / 操作键 / 题型键
  | 'INTENT_PATCH_CONFLICT' // chat/cancel 却携带非空 patch
  | 'EMPTY_PATCH' // update/replace 无任何有效操作
  | 'DUPLICATE_TYPE_CONFLICT' // 同一题型多个别名值不同
  | 'COUNT_NOT_EXPLICIT' // 数值操作 evidence 不成立 / basis 非法
  | 'COUNT_PLAN_REQUIRED' // patch_custom 在无 custom 方案时使用
  | 'INVALID_COUNT_VALUE' // 负数 / 小数 / 非法数字 / wire 携带 0

export interface DraftProtocolError {
  code: DraftProtocolErrorCode
  message: string
}

export type DraftPatchParseResult =
  | { ok: true; patch: DraftPatch; acknowledgement?: string }
  | { ok: false; error: DraftProtocolError }

/** App 在请求开始前捕获的轮次上下文：协议只信这里，不信模型 */
export interface DraftTurnContext {
  turnId: string
  expectedDraftId?: string
  baseRevision: number
  /** 用户本轮原文（evidence 校验的唯一依据） */
  userText: string
  /** 当前活动草稿（patch_custom 合法性、0→unset 归一判断用）；无草稿传 null */
  currentDraft?: GenerationDraft | null
}

/* ============================ 围栏提取与跨 chunk 过滤 ============================ */

const FENCE_OPEN = '```gen_draft_patch'
const WIRE_FENCE_RE = /```gen_draft_patch[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g

/** 提取全部协议块（容忍未闭合——流截断场景）；多个块时调用方取最后一个 */
export function extractWireBlocks(reply: string): { raw: string; start: number; end: number }[] {
  const out: { raw: string; start: number; end: number }[] = []
  WIRE_FENCE_RE.lastIndex = 0
  for (const m of reply.matchAll(WIRE_FENCE_RE)) {
    out.push({ raw: m[1] ?? '', start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** 从模型回复剥离全部协议块，得到用户可见正文（实施路线 6.2 规则 1） */
export function stripWireFences(reply: string): string {
  const blocks = extractWireBlocks(reply)
  if (!blocks.length) return reply.trim()
  let content = reply
  for (let i = blocks.length - 1; i >= 0; i--) {
    content = content.slice(0, blocks[i].start) + content.slice(blocks[i].end)
  }
  return content.replace(/\n{3,}$/g, '\n\n').trim()
}

/**
 * 跨 chunk 安全的协议尾部过滤器（实施路线 6.5 规则 7）：
 * 流式上屏时只释放「不可能属于起始标记」的安全前缀；命中 `gen_draft_patch`
 * 后缓存整个协议尾部（含未闭合残尾），任何协议 JSON 与围栏标记都不会闪进消息区。
 * 只做文本隔离：不写 Store、不决定 intent、不校验 JSON。
 */
export class ProtocolTailFilter {
  private buf = ''
  private inFence = false

  /** 送入一个流式 chunk，返回可安全上屏的文本 */
  push(chunk: string): string {
    this.buf += chunk
    let out = ''
    for (;;) {
      if (!this.inFence) {
        const idx = this.buf.indexOf(FENCE_OPEN)
        if (idx >= 0) {
          out += this.buf.slice(0, idx)
          this.buf = this.buf.slice(idx)
          this.inFence = true
          const close = this.buf.indexOf('```', FENCE_OPEN.length)
          if (close >= 0) {
            this.inFence = false
            this.buf = this.buf.slice(close + 3)
            continue
          }
          break // 协议未闭合：缓存全部剩余，一个字符都不上屏
        }
        // 未命中起始标记：保留「可能是被切开的标记前缀」的尾部窗口
        const keep = Math.min(this.buf.length, FENCE_OPEN.length - 1)
        if (this.buf.length > keep) {
          out += this.buf.slice(0, this.buf.length - keep)
          this.buf = this.buf.slice(this.buf.length - keep)
        }
        break
      }
      // 协议中：找闭合围栏
      const close = this.buf.indexOf('```', FENCE_OPEN.length)
      if (close >= 0) {
        this.inFence = false
        this.buf = this.buf.slice(close + 3)
        continue
      }
      break
    }
    return out
  }

  /** 流结束：普通尾部正常释放；未闭合的协议残尾直接丢弃（协议内容绝不闪现） */
  flush(): string {
    const rest = this.inFence ? '' : this.buf
    this.buf = ''
    this.inFence = false
    return rest
  }
}

/* ============================ evidence 校验（唯一规范化函数） ============================ */

/** NFKC + 英文小写 + 移除空白与中英文标点/符号（实施路线 6.2 末段的唯一实现） */
export function normalizeEvidenceText(text: string): string {
  return (text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 规范化 evidence 必须是规范化用户原文的非空子串 */
export function evidenceHolds(evidence: string | undefined, userText: string): boolean {
  if (!evidence) return false
  const e = normalizeEvidenceText(evidence)
  if (!e) return false
  return normalizeEvidenceText(userText).includes(e)
}

function makeValue<T>(
  value: T,
  basis: 'user_explicit' | 'model_inferred',
  evidence: string | undefined,
  userText: string,
  turnId: string,
): DraftValue<T> {
  // 普通语义字段：user_explicit 的 evidence 不成立时降级 model_inferred（实施路线 6.2）
  const ok = basis === 'user_explicit' && evidenceHolds(evidence, userText)
  return {
    value,
    basis: ok ? 'user_explicit' : 'model_inferred',
    messageId: turnId,
    ...(ok && evidence ? { evidence } : {}),
  }
}

/* ============================ JSON 容错解析 ============================ */

/** 容错 JSON：直接 parse → 平衡扫描 {...} → 去尾逗号重试（6.73 JSON 修复经验；拒绝截断与垃圾） */
function parseLooseJson(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [raw]
  const s = raw.indexOf('{')
  if (s >= 0) {
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let i = s; i < raw.length; i++) {
      const ch = raw[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end > s) candidates.push(raw.slice(s, end))
  }
  for (const c of candidates.map((x) => x.replace(/,\s*([}\]])/g, '$1'))) {
    try {
      const obj = JSON.parse(c) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null
}

/* ============================ 白名单 schema 校验 ============================ */

type Obj = Record<string, unknown>

function fail(code: DraftProtocolErrorCode, message: string): DraftPatchParseResult {
  return { ok: false, error: { code, message } }
}

function isPlainObject(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 未知键一律拒绝，绝不静默丢弃（实施路线 6.2 规则 3；模型伪造 turnId/draftId 在此被拦） */
function checkKeys(obj: Obj, allowed: string[], where: string): DraftProtocolError | null {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      return { code: 'UNKNOWN_KEY', message: `${where} 含未知键「${k}」` }
    }
  }
  return null
}

/** 数字只能转为正整数（负数/小数/字符串垃圾拒绝）；不夹取上限——超限整数放行给 validator 报冲突（P0-16） */
function toPositiveInt(v: unknown, where: string): { n?: number; err?: DraftProtocolError } {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    return { err: { code: 'INVALID_COUNT_VALUE', message: `${where} 数值「${String(v)}」非法（须为正整数）` } }
  }
  return { n: v }
}

/** 题型数量表归一：键 → 标准 id（共用 intentRules.normalizeTypeKey）；
 *  同题型同值合并、不同值 DUPLICATE_TYPE_CONFLICT；0/负数/小数拒绝（wire 不得携带 0） */
function normalizeTypeCounts(
  raw: Obj,
): { counts?: Partial<Record<QuestionTypeId, DraftValue<number>>>; err?: DraftProtocolError } {
  const counts: Partial<Record<QuestionTypeId, number>> = {}
  for (const [k, v] of Object.entries(raw)) {
    const type = normalizeTypeKey(k)
    if (type === 'choice' || type === null) {
      return { err: { code: 'UNKNOWN_KEY', message: `未知题型键「${k}」` } }
    }
    const { n, err } = toPositiveInt(v, `type_counts.${k}`)
    if (err) return { err }
    const prev = counts[type]
    if (prev !== undefined && prev !== n) {
      return { err: { code: 'DUPLICATE_TYPE_CONFLICT', message: `题型「${k}」出现多个不同数量（${prev} 与 ${n}）` } }
    }
    counts[type] = n!
  }
  return {
    counts: Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [k, { value: v, basis: 'user_explicit' }]),
    ) as Partial<Record<QuestionTypeId, DraftValue<number>>>,
  }
}

/* ============================ count_plan 转换 ============================ */

function convertCountPlan(
  cp: Obj,
  ctx: DraftTurnContext,
): { patch?: CountPlanPatch; err?: DraftProtocolError } {
  const op = cp.op
  if (op === 'set_ai') {
    const err = checkKeys(cp, ['op', 'total', 'basis', 'evidence'], 'count_plan(set_ai)')
    if (err) return { err }
    if (cp.basis !== 'user_explicit' || !evidenceHolds(cp.evidence as string | undefined, ctx.userText)) {
      return { err: { code: 'COUNT_NOT_EXPLICIT', message: 'set_ai 的 evidence 在用户原文中不成立' } }
    }
    if (cp.total === undefined || cp.total === null) {
      return { patch: { kind: 'set_ai' } } // 「题型你安排」：total 缺省，可否继承由 reducer 决定
    }
    const { n, err: nErr } = toPositiveInt(cp.total, 'set_ai.total')
    if (nErr) return { err: nErr }
    return {
      patch: {
        kind: 'set_ai',
        total: { value: n!, basis: 'user_explicit', messageId: ctx.turnId, evidence: cp.evidence as string },
      },
    }
  }

  if (op === 'set_custom') {
    const err = checkKeys(cp, ['op', 'type_counts', 'stated_total', 'unset_stated_total', 'basis', 'evidence'], 'count_plan(set_custom)')
    if (err) return { err }
    if (cp.basis !== 'user_explicit' || !evidenceHolds(cp.evidence as string | undefined, ctx.userText)) {
      return { err: { code: 'COUNT_NOT_EXPLICIT', message: 'set_custom 的 evidence 在用户原文中不成立' } }
    }
    if (cp.unset_stated_total === true && cp.stated_total !== undefined) {
      return { err: { code: 'SCHEMA_INVALID', message: 'stated_total 与 unset_stated_total 不能同时出现' } }
    }
    if (!isPlainObject(cp.type_counts)) {
      return { err: { code: 'SCHEMA_INVALID', message: 'set_custom.type_counts 必须是对象' } }
    }
    const { counts, err: cErr } = normalizeTypeCounts(cp.type_counts)
    if (cErr) return { err: cErr }
    if (!counts || Object.keys(counts).length === 0) {
      return { err: { code: 'EMPTY_PATCH', message: 'set_custom.type_counts 为空' } }
    }
    let statedTotal: DraftValue<number> | undefined
    if (cp.stated_total !== undefined && cp.stated_total !== null) {
      const { n, err: sErr } = toPositiveInt(cp.stated_total, 'stated_total')
      if (sErr) return { err: sErr }
      statedTotal = { value: n!, basis: 'user_explicit', messageId: ctx.turnId, evidence: cp.evidence as string }
    }
    return {
      patch: {
        kind: 'set_custom',
        typeCounts: counts,
        ...(statedTotal ? { statedTotal } : {}),
        ...(cp.unset_stated_total === true ? { unsetStatedTotal: true } : {}),
      },
    }
  }

  if (op === 'patch_custom') {
    const err = checkKeys(cp, ['op', 'set', 'unset', 'stated_total', 'unset_stated_total', 'basis', 'evidence'], 'count_plan(patch_custom)')
    if (err) return { err }
    // 只允许在已有 custom 方案上局部修改，否则要求模型改用完整 set_custom（实施路线 4.3）
    if (ctx.currentDraft?.countPlan?.mode !== 'custom') {
      return { err: { code: 'COUNT_PLAN_REQUIRED', message: 'patch_custom 需要已有自定义题型方案，请改用 set_custom' } }
    }
    if (cp.basis !== 'user_explicit' || !evidenceHolds(cp.evidence as string | undefined, ctx.userText)) {
      return { err: { code: 'COUNT_NOT_EXPLICIT', message: 'patch_custom 的 evidence 在用户原文中不成立' } }
    }
    if (cp.unset_stated_total === true && cp.stated_total !== undefined) {
      return { err: { code: 'SCHEMA_INVALID', message: 'stated_total 与 unset_stated_total 不能同时出现' } }
    }
    const set: Partial<Record<QuestionTypeId, DraftValue<number>>> = {}
    if (cp.set !== undefined) {
      if (!isPlainObject(cp.set)) return { err: { code: 'SCHEMA_INVALID', message: 'patch_custom.set 必须是对象' } }
      const { counts, err: cErr } = normalizeTypeCounts(cp.set)
      if (cErr) return { err: cErr }
      Object.assign(set, counts)
    }
    const unset: QuestionTypeId[] = []
    if (cp.unset !== undefined) {
      if (!Array.isArray(cp.unset)) return { err: { code: 'SCHEMA_INVALID', message: 'patch_custom.unset 必须是数组' } }
      for (const k of cp.unset) {
        const type = normalizeTypeKey(String(k))
        if (type === 'choice' || type === null) {
          return { err: { code: 'UNKNOWN_KEY', message: `未知题型键「${String(k)}」` } }
        }
        unset.push(type)
      }
    }
    if (
      Object.keys(set).length === 0 &&
      unset.length === 0 &&
      cp.stated_total === undefined &&
      cp.unset_stated_total !== true
    ) {
      return { err: { code: 'EMPTY_PATCH', message: 'patch_custom 无任何操作' } }
    }
    let statedTotal: DraftValue<number> | undefined
    if (cp.stated_total !== undefined && cp.stated_total !== null) {
      const { n, err: sErr } = toPositiveInt(cp.stated_total, 'stated_total')
      if (sErr) return { err: sErr }
      statedTotal = { value: n!, basis: 'user_explicit', messageId: ctx.turnId, evidence: cp.evidence as string }
    }
    return {
      patch: {
        kind: 'patch_custom',
        set,
        unset,
        ...(statedTotal ? { statedTotal } : {}),
        ...(cp.unset_stated_total === true ? { unsetStatedTotal: true } : {}),
      },
    }
  }

  return { err: { code: 'SCHEMA_INVALID', message: `count_plan.op「${String(op)}」未知` } }
}

/* ============================ 主入口 ============================ */

/**
 * 模型回复 → 内部 DraftPatch（实施路线 6.2 全部规则）。
 * 失败返回稳定错误码；任何失败都不会产出可执行的草稿变更。
 */
export function parseDraftPatchWire(reply: string, ctx: DraftTurnContext): DraftPatchParseResult {
  const blocks = extractWireBlocks(reply)
  if (!blocks.length) {
    return fail('NO_PROTOCOL_BLOCK', '本轮回复没有 gen_draft_patch 协议块')
  }
  const raw = blocks[blocks.length - 1].raw.trim()
  const obj = parseLooseJson(raw)
  if (!obj) return fail('INVALID_JSON', '协议 JSON 解析失败（截断或格式损坏）')

  let err = checkKeys(obj, ['schema_version', 'intent', 'acknowledgement', 'patch'], '顶层')
  if (err) return fail(err.code, err.message)
  if (obj.schema_version !== 2) {
    return fail('SCHEMA_INVALID', `schema_version 必须为 2（收到「${String(obj.schema_version)}」）`)
  }
  const intent = obj.intent
  if (intent !== 'chat' && intent !== 'update' && intent !== 'replace' && intent !== 'cancel') {
    return fail('SCHEMA_INVALID', `intent「${String(intent)}」未知`)
  }

  // patch：缺省或空对象 = 无 patch；带任何字段则 chat/cancel 一律冲突（实施路线 6.2 规则 10）
  const rawPatch = obj.patch
  if (rawPatch !== undefined && rawPatch !== null && !isPlainObject(rawPatch)) {
    return fail('SCHEMA_INVALID', 'patch 必须是对象')
  }
  const patchObj = isPlainObject(rawPatch) && Object.keys(rawPatch).length > 0 ? rawPatch : undefined
  if ((intent === 'chat' || intent === 'cancel') && patchObj) {
    return fail('INTENT_PATCH_CONFLICT', `intent=${intent} 不允许携带 patch`)
  }

  // acknowledgement：短文本展示，清洗不可信标记，不进入最终生成 input（实施路线 6.2 规则 11）
  let acknowledgement: string | undefined
  if (obj.acknowledgement !== undefined) {
    if (typeof obj.acknowledgement !== 'string') {
      return fail('SCHEMA_INVALID', 'acknowledgement 必须是字符串')
    }
    acknowledgement =
      stripUntrustedMarkers(obj.acknowledgement)
        .replace(/```[a-z]*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || undefined
  }

  if (!patchObj) {
    if (intent === 'update' || intent === 'replace') {
      return fail('EMPTY_PATCH', `intent=${intent} 但没有任何操作`)
    }
    return { ok: true, acknowledgement, patch: emptyPatch(intent, ctx) }
  }

  err = checkKeys(patchObj, ['topic', 'count_plan', 'source_policy', 'requirements'], 'patch')
  if (err) return fail(err.code, err.message)

  let topic: DraftPatch['topic']
  let countPlan: CountPlanPatch | undefined
  let sourcePolicy: DraftPatch['sourcePolicy']
  const appendRequirements: DraftPatch['appendRequirements'] = []
  const removeRequirementIds: string[] = []

  // ---- topic ----
  if (patchObj.topic !== undefined) {
    const t = patchObj.topic
    if (!isPlainObject(t)) return fail('SCHEMA_INVALID', 'topic 必须是对象')
    if (t.op === 'set') {
      err = checkKeys(t, ['op', 'value', 'basis', 'evidence'], 'topic(set)')
      if (err) return fail(err.code, err.message)
      if (t.basis !== 'user_explicit' && t.basis !== 'model_inferred') {
        return fail('SCHEMA_INVALID', 'topic.basis 只允许 user_explicit / model_inferred')
      }
      if (typeof t.value !== 'string' || !t.value.trim()) {
        return fail('SCHEMA_INVALID', 'topic.value 必须是非空字符串')
      }
      topic = {
        kind: 'set',
        field: makeValue(t.value.trim(), t.basis, t.evidence as string | undefined, ctx.userText, ctx.turnId),
      }
    } else if (t.op === 'unset') {
      err = checkKeys(t, ['op', 'evidence'], 'topic(unset)')
      if (err) return fail(err.code, err.message)
      // unset 只接受用户明确删除语义且 evidence 成立；否则拒绝该操作（实施路线 4.4/6.2）
      if (evidenceHolds(t.evidence as string | undefined, ctx.userText)) topic = { kind: 'unset' }
    } else {
      return fail('SCHEMA_INVALID', `topic.op「${String(t.op)}」未知`)
    }
  }

  // ---- count_plan ----
  if (patchObj.count_plan !== undefined) {
    const cp = patchObj.count_plan
    if (!isPlainObject(cp)) return fail('SCHEMA_INVALID', 'count_plan 必须是对象')
    if (cp.op === 'unset') {
      err = checkKeys(cp, ['op', 'evidence'], 'count_plan(unset)')
      if (err) return fail(err.code, err.message)
      // evidence 不成立 → 拒绝删除（不整体失败，保留旧 countPlan）
      if (evidenceHolds(cp.evidence as string | undefined, ctx.userText)) countPlan = { kind: 'unset' }
    } else {
      const res = convertCountPlan(cp, ctx)
      if (res.err) return fail(res.err.code, res.err.message)
      countPlan = res.patch
    }
  }

  // ---- source_policy ----
  if (patchObj.source_policy !== undefined) {
    const sp = patchObj.source_policy
    if (!isPlainObject(sp)) return fail('SCHEMA_INVALID', 'source_policy 必须是对象')
    err = checkKeys(sp, ['op', 'evidence'], 'source_policy')
    if (err) return fail(err.code, err.message) // 模型塞进来的 message_id/refs/kb_id 在此按未知键拒绝
    if (sp.op !== 'keep_existing' && sp.op !== 'clear') {
      return fail('SCHEMA_INVALID', `source_policy.op「${String(sp.op)}」未知`)
    }
    if (evidenceHolds(sp.evidence as string | undefined, ctx.userText)) {
      sourcePolicy = { kind: sp.op, evidence: sp.evidence as string }
    }
    // evidence 不成立 → 拒绝该策略（source 保持旧值）
  }

  // ---- requirements ----
  if (patchObj.requirements !== undefined) {
    const rq = patchObj.requirements
    if (!isPlainObject(rq)) return fail('SCHEMA_INVALID', 'requirements 必须是对象')
    err = checkKeys(rq, ['append', 'remove'], 'requirements')
    if (err) return fail(err.code, err.message)
    if (rq.append !== undefined) {
      if (!Array.isArray(rq.append)) return fail('SCHEMA_INVALID', 'requirements.append 必须是数组')
      for (const item of rq.append) {
        if (!isPlainObject(item)) return fail('SCHEMA_INVALID', 'requirements.append 项必须是对象')
        err = checkKeys(item, ['text', 'basis', 'evidence'], 'requirements.append 项')
        if (err) return fail(err.code, err.message)
        if (typeof item.text !== 'string' || !item.text.trim()) continue // 空文本跳过
        if (item.basis !== 'user_explicit' && item.basis !== 'model_inferred') {
          return fail('SCHEMA_INVALID', 'requirements.append.basis 只允许 user_explicit / model_inferred')
        }
        appendRequirements.push(
          makeValue(item.text.trim(), item.basis, item.evidence as string | undefined, ctx.userText, ctx.turnId),
        )
      }
    }
    if (rq.remove !== undefined) {
      if (!Array.isArray(rq.remove)) return fail('SCHEMA_INVALID', 'requirements.remove 必须是数组')
      for (const item of rq.remove) {
        if (!isPlainObject(item)) return fail('SCHEMA_INVALID', 'requirements.remove 项必须是对象')
        err = checkKeys(item, ['id', 'evidence'], 'requirements.remove 项')
        if (err) return fail(err.code, err.message)
        if (typeof item.id !== 'string' || !item.id) {
          return fail('SCHEMA_INVALID', 'requirements.remove.id 必须是非空字符串')
        }
        // evidence 不成立 → 拒绝删除该条（实施路线 6.2）
        if (!evidenceHolds(item.evidence as string | undefined, ctx.userText)) continue
        removeRequirementIds.push(item.id)
      }
    }
  }

  // ---- 有效操作汇总（实施路线 6.2 规则 10）----
  const hasOps =
    topic !== undefined ||
    countPlan !== undefined ||
    sourcePolicy !== undefined ||
    appendRequirements.length > 0 ||
    removeRequirementIds.length > 0
  if ((intent === 'update' || intent === 'replace') && !hasOps) {
    return fail('EMPTY_PATCH', `intent=${intent} 但所有操作均无效或为空`)
  }

  return {
    ok: true,
    acknowledgement,
    patch: {
      schemaVersion: 2,
      turnId: ctx.turnId,
      ...(ctx.expectedDraftId !== undefined ? { expectedDraftId: ctx.expectedDraftId } : {}),
      baseRevision: ctx.baseRevision,
      intent,
      ...(topic !== undefined ? { topic } : {}),
      ...(countPlan !== undefined ? { countPlan } : {}),
      ...(sourcePolicy !== undefined ? { sourcePolicy } : {}),
      appendRequirements,
      removeRequirementIds,
    },
  }
}

function emptyPatch(intent: DraftPatch['intent'], ctx: DraftTurnContext): DraftPatch {
  return {
    schemaVersion: 2,
    turnId: ctx.turnId,
    ...(ctx.expectedDraftId !== undefined ? { expectedDraftId: ctx.expectedDraftId } : {}),
    baseRevision: ctx.baseRevision,
    intent,
    appendRequirements: [],
    removeRequirementIds: [],
  }
}

/* ============================ 本地显式提取与合并（实施路线 6.4） ============================ */

/** 从用户原文提取明确总数：阿拉伯/中文数字 + 题/道（排除「第 N 题」指代），**不夹取上限**——
 *  超限由 validator 报 TOTAL_OUT_OF_RANGE 显示原值（P0-16）；复用 chineseToInt，避免两套数字解析 */
export function extractExplicitTotal(text: string): number | null {
  const t = text || ''
  const m = t.match(/(\d{1,5})\s*[题道]/) ?? t.match(/^\s*(\d{1,5})\s*$/)
  if (m) {
    const v = parseInt(m[1] ?? m[2] ?? '', 10)
    if (Number.isFinite(v) && v > 0) return v
  }
  const c = t.match(/([零一二两三四五六七八九十百]{1,6})\s*(?:道\s*)?(?:题|道)/)
  if (c) {
    const before = c.index && c.index > 0 ? t[c.index - 1] : ''
    if (!/[第这那哪]/.test(before ?? '')) return chineseToInt(c[1])
  }
  return null
}

/** 「多选改成0 / 不要多选」→ 归一为该题型 unset；「多选改成8」→ 修改型 set；
 *  与 parseTypeStructure（别名后紧跟数字）互补，覆盖「多选改成8题」「判断题改成5」句式 */
export function extractTypeUnsets(text: string): QuestionTypeId[] {
  const out: QuestionTypeId[] = []
  const t = text || ''
  for (const alias of ['单项选择', '多项选择', '单选', '多选', '判断', '填空', '匹配', '排序', '简答', '案例分析', '案例', '论文', '论述']) {
    const type = normalizeTypeKey(alias)
    if (!type || type === 'choice') continue
    // 「不要/删掉/去掉/移除/取消 + 别名」或「别名 + 改成/为 0」
    if (new RegExp(`(?:不要|删掉|去掉|移除|取消|别要|别来)\\s*[这个些]?\\s*${alias}`).test(t)) {
      out.push(type)
      continue
    }
    if (new RegExp(`${alias}题?\\s*(?:改成|改为|变成|改|[:：=])\\s*0\\s*[题道个]?`).test(t)) {
      out.push(type)
    }
  }
  return out
}

/** 修改型题型数量：「多选改成8题」「判断题改为5」→ 该题型明确 set 值（0 归 unset，不在此返回） */
function extractTypeSets(text: string): { type: QuestionTypeId; count: number }[] {
  const out: { type: QuestionTypeId; count: number }[] = []
  const t = text || ''
  for (const alias of ['单项选择', '多项选择', '单选', '多选', '判断', '填空', '匹配', '排序', '简答', '案例分析', '案例', '论文', '论述']) {
    const type = normalizeTypeKey(alias)
    if (!type || type === 'choice') continue
    const m = t.match(new RegExp(`${alias}题?\\s*(?:改成|改为|变成|改|[:：=])\\s*(\\d{1,4})\\s*[题道个]?`))
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > 0) out.push({ type, count: n })
    }
  }
  return out
}

/** 只识别句式明确的主题指令，避免把普通聊天中的「关于……」误当成生题方案。 */
function extractExplicitTopic(text: string): DraftValue<string> | undefined {
  const t = text.trim()
  const patterns = [
    /(?:围绕|关于)\s*(.{1,80}?)\s*(?=(?:出|生成|做|编写?|设计)\s*(?:\d{1,4}|[零一二两三四五六七八九十百]{1,6})?\s*(?:道|题|练习|测试|试卷|题库)?(?:[，,。；;！!]|$))/,
    /主题\s*(?:是|为)\s*[:：]?\s*([^，,。；;！!\n]{1,80})/,
    /以\s*([^，,。；;！!\n]{1,80}?)\s*为主题/,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    const value = m?.[1]?.trim().replace(/[，,。；;！!]+$/, '')
    if (value && value.length >= 2) {
      const evidence = m?.[0]?.trim() || value
      return { value, basis: 'user_explicit', messageId: '', evidence }
    }
  }
  return undefined
}

/** 只抽取高置信、短句式的要求；复杂语义仍交给模型，避免本地规则过度猜测。 */
function extractExplicitRequirements(text: string): string[] {
  const out: string[] = []
  const push = (value: string) => {
    const v = value.trim().replace(/[，,。；;！!]+$/, '')
    if (v.length >= 2 && !out.includes(v)) out.push(v)
  }
  for (const m of text.matchAll(/(?:小学|初中|高中|大学|基础|简单|中等|困难|高难|偏难|容易)\s*难度/g)) push(m[0])
  for (const m of text.matchAll(/重点(?:考查|考|覆盖|关注|放在|突出)?\s*[^，,。；;！!\n]{1,30}/g)) push(m[0])
  return out
}

/**
 * 本地确定性提取「可靠的题数/题型显式值」（实施路线 6.4 / 步骤 6）。
 * 只做字段解析，不做意图门禁（finalIntent 门禁属 TASK-04）；无可靠显式值返回 null。
 * 同时给出总数与分项时（P1-15 混合表达）：分项为执行事实、总数进 statedTotal 对账，
 * 由 validator 以 TOTAL_TYPE_SUM_MISMATCH 阻断，绝不假装支持混合执行。
 */
export function extractExplicitDraftPatch(userInput: string, ctx: DraftTurnContext): DraftPatch | null {
  const total = extractExplicitTotal(userInput)
  const topic = extractExplicitTopic(userInput)
  const requirements = extractExplicitRequirements(userInput)
  const localTopic = topic ? { ...topic, messageId: ctx.turnId } : undefined
  const appendRequirements = requirements.map((value) => ({ value, basis: 'user_explicit' as const, messageId: ctx.turnId }))
  const isCustom = ctx.currentDraft?.countPlan?.mode === 'custom'
  // 「别名紧跟数字」与「别名改成数字」两种句式合并；修改型优先覆盖同题型
  const merged = new Map<QuestionTypeId, { type: QuestionTypeId; count: number }>()
  for (const e of parseTypeStructure(userInput).entries) merged.set(e.type, e)
  if (isCustom) {
    for (const e of extractTypeSets(userInput)) merged.set(e.type, e)
  }
  const structure = [...merged.values()]
  const unsets = isCustom ? extractTypeUnsets(userInput) : []

  let countPlan: CountPlanPatch | undefined
  if (structure.length > 0 || (isCustom && unsets.length > 0)) {
    const typeCounts = Object.fromEntries(
      structure.map((e) => [e.type, { value: e.count, basis: 'user_explicit', messageId: ctx.turnId }]),
    ) as Partial<Record<QuestionTypeId, DraftValue<number>>>
    const statedTotal: DraftValue<number> | undefined =
      total !== null ? { value: total, basis: 'user_explicit', messageId: ctx.turnId, evidence: userInput } : undefined
    if (isCustom) {
      countPlan = { kind: 'patch_custom', set: typeCounts, unset: unsets, ...(statedTotal ? { statedTotal } : {}) }
    } else {
      countPlan = { kind: 'set_custom', typeCounts, ...(statedTotal ? { statedTotal } : {}) }
    }
  } else if (total !== null) {
    countPlan = {
      kind: 'set_ai',
      total: { value: total, basis: 'user_explicit', messageId: ctx.turnId, evidence: userInput },
    }
  }
  if (!countPlan && !localTopic && appendRequirements.length === 0) return null

  return {
    schemaVersion: 2,
    turnId: ctx.turnId,
    ...(ctx.expectedDraftId !== undefined ? { expectedDraftId: ctx.expectedDraftId } : {}),
    baseRevision: ctx.baseRevision,
    intent: 'update',
    ...(localTopic ? { topic: { kind: 'set' as const, field: localTopic } } : {}),
    countPlan,
    appendRequirements,
    removeRequirementIds: [],
  }
}

/**
 * 合并本地显式补丁与模型补丁：本地确定性提取结果优先（实施路线 6.4 / 步骤 7）。
 * 记录差异供脱敏日志（如「模型说 25、本地 20 → 采用本地 20」）。
 */
export function mergeLocalAndModelPatch(
  local: DraftPatch | null,
  model: DraftPatch | null,
): { patch: DraftPatch | null; diffs: string[] } {
  const diffs: string[] = []
  if (!local) return { patch: model, diffs }
  if (!model) return { patch: local, diffs }

  const merged: DraftPatch = { ...model }
  if (local.countPlan) {
    if (model.countPlan) {
      diffs.push(
        `count_plan: 本地 ${describeCountPlan(local.countPlan)} vs 模型 ${describeCountPlan(model.countPlan)} → 采用本地显式值`,
      )
    }
    merged.countPlan = local.countPlan
  }
  if (local.topic) {
    if (model.topic) diffs.push('topic: 本地明确值优先于模型值')
    merged.topic = local.topic
  }
  if (local.appendRequirements.length > 0) {
    merged.appendRequirements = [...merged.appendRequirements, ...local.appendRequirements]
  }
  if (local.removeRequirementIds.length > 0) {
    merged.removeRequirementIds = [...new Set([...merged.removeRequirementIds, ...local.removeRequirementIds])]
  }
  return { patch: merged, diffs }
}

function describeCountPlan(cp: CountPlanPatch): string {
  switch (cp.kind) {
    case 'set_ai':
      return cp.total ? `set_ai/${cp.total.value}` : 'set_ai/未定总数'
    case 'set_custom':
      return `set_custom(${describeCounts(cp.typeCounts)}${cp.statedTotal ? `，总数${cp.statedTotal.value}` : ''})`
    case 'patch_custom':
      return `patch_custom(set ${describeCounts(cp.set)}，unset [${cp.unset.join(',')}])`
    default:
      return 'unset'
  }
}

function describeCounts(counts: Partial<Record<QuestionTypeId, DraftValue<number>>>): string {
  const s = Object.entries(counts)
    .map(([k, v]) => `${k}:${v?.value ?? 0}`)
    .join('、')
  return s || '空'
}
