/**
 * GenerationDraft 领域 reducer（实施路线 11 节 / TASK-01）。
 *
 * 职责边界：
 * - 只接收「已完成 schema/evidence 归一」的内部 DraftPatch（wire 解析与 evidence
 *   降级是 TASK-03 的边界）和「App 已按 5.4 节规则解析」的 DraftSourceAction，
 *   不解析模型原文、不发网络、不依赖 Store/IndexedDB/AI。
 * - reducer 是唯一按优先级合并需求字段的地方；模型不能覆盖更高优先级事实。
 * - 所有函数返回新对象，禁止修改入参；无状态变化时返回原引用（调用方可据此
 *   判定「本轮未应用」）。
 *
 * revision 语义（实施路线 4.2 约束 1/13）：
 * - 新建/replace 的 revision 从 1 开始；之后每次成功修改需求字段/source/lifecycle 加 1；
 * - 重复 turnId、仅 turnIssues 元数据变化、本轮无任何状态变化都不递增。
 *
 * 合并优先级（实施路线 4.4）：本轮 user_explicit > 旧 user_explicit > app_derived
 * > model_inferred > app_default。模型 inferred / app_default 永远不能覆盖旧
 * user_explicit；新一轮 user_explicit 可以覆盖任何旧值（「不是 20，改成 30」）。
 */
import { uid } from '../../utils'
import type {
  CountPlanPatch,
  DraftIssue,
  DraftPatch,
  DraftSourceAction,
  DraftValue,
  DraftValueBasis,
  GenerationCountPlan,
  GenerationDraft,
  GenerationDraftSource,
  QuestionTypeId,
} from '../../types'

/** appliedTurnIds 只保留最近 20 条，防止会话长期增长（实施路线 4.2 约束 9） */
const MAX_APPLIED_TURN_IDS = 20

const BASIS_RANK: Record<DraftValueBasis, number> = {
  user_explicit: 3,
  app_derived: 2,
  model_inferred: 1,
  app_default: 0,
}

/** 创建一份空白的 active 草稿（revision=1）。countPlan/topic 初始为 undefined——
 *  绝不用「默认 20 题」之类的默认值冒充用户输入（实施路线 11 节步骤 10） */
export function createGenerationDraft(
  sessionId: string,
  source?: GenerationDraftSource,
): GenerationDraft {
  const now = Date.now()
  return {
    schemaVersion: 2,
    id: uid('gd_'),
    sessionId,
    revision: 1,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
    requirements: [],
    source: source ? cloneSource(source) : {},
    appliedTurnIds: [],
    turnIssues: [],
  }
}

/**
 * 应用一轮需求增量。入口统一（实施路线 4.4）：source 的变化只在本函数内完成，
 * 不得在 reducer 外先改一遍 source、再在 Store 里补第二遍。
 *
 * @param draft 当前活动草稿；无活动草稿时传 null
 * @param patch 本轮已归一的内部补丁
 * @param sourceAction App 解析出的来源动作（preserve/replace/clear）
 * @param sessionId 仅在 draft 为空且本轮为 update/replace（首轮创建）时必传；
 *        缺省且无草稿时返回 null（不为空操作创建草稿）
 * @returns 新草稿；以下情形返回入参原引用或 null，表示本轮未应用：
 *          chat 轮、重复 turnId、expectedDraftId/baseRevision 不匹配、
 *          对非 active 草稿的 update/replace、replace/创建落空
 */
export function applyDraftTurn(
  draft: GenerationDraft | null,
  patch: DraftPatch,
  sourceAction: DraftSourceAction,
  sessionId?: string,
): GenerationDraft | null {
  // 普通聊天永不修改草稿：不创建、不改字段、不复活（实施路线 6.3 规则 5/6）
  if (patch.intent === 'chat') return draft

  if (!draft) {
    if (patch.intent === 'cancel') return null // 无草稿时「取消出题」= 普通聊天，不创建 cancelled 空草稿
    // 首轮创建：只有明确生题意图（update/replace）才建，且至少承载一项内容
    if (!sessionId) return null
    const created = createGenerationDraft(sessionId)
    const source = resolveCreatedSource(undefined, sourceAction)
    const changed = applyPatchFields(created, patch, emptyBase(), source)
    if (isEmptyDraft(created)) return null
    if (!changed && sourceAction.kind !== 'replace') return null
    return { ...created, appliedTurnIds: [patch.turnId] }
  }

  // 门禁：防重复应用与迟到覆盖（实施路线 4.4 / 11 节步骤 6）
  if (patch.expectedDraftId !== undefined && patch.expectedDraftId !== draft.id) return draft
  if (patch.baseRevision !== draft.revision) return draft
  if (draft.appliedTurnIds.includes(patch.turnId)) return draft

  if (patch.intent === 'cancel') {
    if (draft.lifecycle !== 'active' && draft.lifecycle !== 'generating') return draft
    return {
      ...draft,
      lifecycle: 'cancelled',
      revision: draft.revision + 1,
      updatedAt: Date.now(),
      appliedTurnIds: pushTurnId(draft.appliedTurnIds, patch.turnId),
      turnIssues: [],
    }
  }

  // update/replace 只作用于 active 草稿：cancelled/completed 不复活，generating 中不改需求
  if (draft.lifecycle !== 'active') return draft

  const replaced = patch.intent === 'replace'
  if (replaced) {
    // replace：创建新 draft id、revision 重新从 1 开始，旧字段一概不继承（实施路线 4.2 约束 1）；
    // 只有 sourceAction=preserve（用户明确「沿用原资料」）才复制旧 source（实施路线 5.4）
    const created = createGenerationDraft(draft.sessionId)
    const source = resolveCreatedSource(draft.source, sourceAction)
    const changed = applyPatchFields(created, patch, emptyBase(), source)
    if (isEmptyDraft(created)) return draft // 空操作不销毁旧方案
    if (!changed && sourceAction.kind !== 'replace' && sourceEquals(source, {})) return draft
    return { ...created, appliedTurnIds: [patch.turnId] }
  }

  // 普通 update：在旧草稿副本上按优先级合并
  const next: GenerationDraft = {
    ...draft,
    requirements: [...draft.requirements],
    appliedTurnIds: [...draft.appliedTurnIds],
  }
  const srcRes = resolveUpdatedSource(draft.source, sourceAction)
  const fieldsChanged = applyPatchFields(next, patch, draft, srcRes.source)
  if (!fieldsChanged && !srcRes.changed) return draft
  return {
    ...next,
    revision: draft.revision + 1,
    updatedAt: Date.now(),
    appliedTurnIds: pushTurnId(draft.appliedTurnIds, patch.turnId),
    turnIssues: [], // 成功更新自动清空上一轮 turnIssues（实施路线 4.2 约束 10）
  }
}

/* ============================ 生命周期动作（实施路线 11 节步骤 4） ============================ */

/** 取消：active/generating → cancelled，revision +1；已完成/已取消保持原样 */
export function cancelDraft(draft: GenerationDraft): GenerationDraft {
  if (draft.lifecycle !== 'active' && draft.lifecycle !== 'generating') return draft
  return {
    ...draft,
    lifecycle: 'cancelled',
    revision: draft.revision + 1,
    updatedAt: Date.now(),
    turnIssues: [],
  }
}

/** 开始生成：active → generating（原子置态防双击）；非 active 返回原引用 */
export function beginDraftGeneration(draft: GenerationDraft): GenerationDraft {
  if (draft.lifecycle !== 'active') return draft
  return { ...draft, lifecycle: 'generating', revision: draft.revision + 1, updatedAt: Date.now() }
}

/** 生成完成：generating → completed；非 generating 返回原引用 */
export function completeDraftGeneration(draft: GenerationDraft): GenerationDraft {
  if (draft.lifecycle !== 'generating') return draft
  return { ...draft, lifecycle: 'completed', revision: draft.revision + 1, updatedAt: Date.now() }
}

/** 重新打开已完成方案：completed → active，供用户编辑后再次生成。 */
export function reopenDraft(draft: GenerationDraft): GenerationDraft {
  if (draft.lifecycle !== 'completed') return draft
  return {
    ...draft,
    lifecycle: 'active',
    revision: draft.revision + 1,
    updatedAt: Date.now(),
    turnIssues: [],
  }
}

/** 生成在首次网络请求前失败：generating → active，保留用户可重试信息（实施路线 18 节步骤 8） */
export function failDraftGeneration(draft: GenerationDraft): GenerationDraft {
  if (draft.lifecycle !== 'generating') return draft
  return { ...draft, lifecycle: 'active', revision: draft.revision + 1, updatedAt: Date.now() }
}

/** 写入本轮未应用问题：只改元数据，不增加需求 revision（实施路线 4.2 约束 10 / 11 节步骤 11） */
export function withDraftTurnIssues(draft: GenerationDraft, issues: DraftIssue[]): GenerationDraft {
  return { ...draft, turnIssues: [...issues], updatedAt: Date.now() }
}

/** 清空 turnIssues（用户「仍按当前方案」/成功更新后）：不增加需求 revision */
export function clearDraftTurnIssues(draft: GenerationDraft): GenerationDraft {
  if (draft.turnIssues.length === 0) return draft
  return { ...draft, turnIssues: [], updatedAt: Date.now() }
}

/* ============================ 内部实现 ============================ */

interface PatchBase {
  topic?: DraftValue<string>
  countPlan?: GenerationCountPlan
  requirements: Array<DraftValue<string> & { id: string }>
}

function emptyBase(): PatchBase {
  return { requirements: [] }
}

/** 把 patch 的字段操作按优先级落到 target 上；返回是否有需求字段变化 */
function applyPatchFields(
  target: GenerationDraft,
  patch: DraftPatch,
  base: PatchBase,
  source: GenerationDraftSource,
): boolean {
  let changed = false

  if (patch.topic?.kind === 'set') {
    const incoming = patch.topic.field
    if (shouldOverride(base.topic, incoming) && !valueEquals(base.topic, incoming)) {
      target.topic = { ...incoming }
      changed = true
    }
  } else if (patch.topic?.kind === 'unset') {
    if (base.topic !== undefined) {
      target.topic = undefined
      changed = true
    }
  }

  const cpRes = applyCountPlanPatch(base.countPlan, patch.countPlan)
  if (cpRes.changed) {
    target.countPlan = cpRes.countPlan
    changed = true
  }

  const reqChanged = applyRequirements(
    target,
    base.requirements,
    patch.appendRequirements,
    patch.removeRequirementIds,
  )
  if (reqChanged) changed = true

  target.source = source
  return changed
}

/** 合并优先级门禁：模型 inferred / app_default 不能覆盖旧 user_explicit；
 *  新一轮 user_explicit 可覆盖任何旧值（实施路线 4.4 额外规则） */
function shouldOverride<T>(
  existing: DraftValue<T> | undefined,
  incoming: DraftValue<T>,
): boolean {
  if (!existing) return true
  if (incoming.basis === 'user_explicit') return true
  return BASIS_RANK[incoming.basis] >= BASIS_RANK[existing.basis]
}

function valueEquals<T>(a: DraftValue<T> | undefined, b: DraftValue<T> | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.value === b.value && a.basis === b.basis
}

function countPlanEquals(
  a: GenerationCountPlan | undefined,
  b: GenerationCountPlan | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b || a.mode !== b.mode) return false
  if (a.mode === 'ai' && b.mode === 'ai') return valueEquals(a.total, b.total)
  if (a.mode === 'custom' && b.mode === 'custom') {
    const keysA = Object.keys(a.typeCounts) as QuestionTypeId[]
    const keysB = Object.keys(b.typeCounts) as QuestionTypeId[]
    if (keysA.length !== keysB.length) return false
    for (const k of keysA) {
      if (!valueEquals(a.typeCounts[k], b.typeCounts[k])) return false
    }
    return valueEquals(a.statedTotal, b.statedTotal)
  }
  return false
}

/** 题数模式切换（严格按实施路线 4.2 题数模式切换表）。
 *  数量只原样保存，绝不 Math.min 静默夹取——超限由 validator（TASK-02）报 conflict */
function applyCountPlanPatch(
  current: GenerationCountPlan | undefined,
  cp: CountPlanPatch | undefined,
): { countPlan?: GenerationCountPlan; changed: boolean } {
  if (!cp) return { countPlan: current, changed: false }

  switch (cp.kind) {
    case 'unset':
      return current
        ? { countPlan: undefined, changed: true }
        : { countPlan: current, changed: false }

    case 'set_ai': {
      let total = cp.total ? { ...cp.total } : undefined
      if (!total) {
        // 「题型你安排」未重述总数（实施路线 4.3）：
        // custom → 取切换前分项合计并标 app_derived；ai 已有总数 → 保持；否则 countPlan 保持未完成
        if (current?.mode === 'custom') {
          const sum = sumTypeCounts(current.typeCounts)
          if (sum > 0) total = { value: sum, basis: 'app_derived' }
        } else if (current?.mode === 'ai') {
          return { countPlan: current, changed: false }
        }
        if (!total) return { countPlan: current, changed: false }
      }
      const plan: GenerationCountPlan = { mode: 'ai', total }
      return { countPlan: plan, changed: !countPlanEquals(current, plan) }
    }

    case 'set_custom': {
      // 完整替换题型分布：未列出的旧题型不保留（实施路线 4.3）
      const typeCounts = sanitizeTypeCounts(cp.typeCounts)
      const statedTotal = resolveStatedTotal(cp, current)
      const plan: GenerationCountPlan = statedTotal
        ? { mode: 'custom', typeCounts, statedTotal }
        : { mode: 'custom', typeCounts }
      return { countPlan: plan, changed: !countPlanEquals(current, plan) }
    }

    case 'patch_custom': {
      // 局部修改只允许在已有 custom 方案上执行（否则上游应返回 COUNT_PLAN_REQUIRED）
      if (current?.mode !== 'custom') return { countPlan: current, changed: false }
      const typeCounts: Partial<Record<QuestionTypeId, DraftValue<number>>> = {}
      for (const [k, v] of Object.entries(current.typeCounts)) {
        if (v) typeCounts[k as QuestionTypeId] = { ...v }
      }
      for (const [k, v] of Object.entries(cp.set ?? {})) {
        if (v && v.value > 0) typeCounts[k as QuestionTypeId] = { ...v }
      }
      for (const k of cp.unset ?? []) delete typeCounts[k]
      const statedTotal = resolveStatedTotal(cp, current)
      const plan: GenerationCountPlan = statedTotal
        ? { mode: 'custom', typeCounts, statedTotal }
        : { mode: 'custom', typeCounts }
      return { countPlan: plan, changed: !countPlanEquals(current, plan) }
    }
    default:
      return { countPlan: current, changed: false }
  }
}

/** statedTotal 解析：patch 明确给出则用之；unsetStatedTotal=true 则清除；
 *  未重述时保持旧值——custom 保留旧 statedTotal；从 ai 切入时旧明确总数
 *  转为可见对账约束（实施路线 4.2 题数模式切换表，不静默丢失用户上一轮明确总数） */
function resolveStatedTotal(
  cp: Extract<CountPlanPatch, { kind: 'set_custom' | 'patch_custom' }>,
  current: GenerationCountPlan | undefined,
): DraftValue<number> | undefined {
  if (cp.unsetStatedTotal) return undefined
  if (cp.statedTotal) return { ...cp.statedTotal }
  if (current?.mode === 'custom') return current.statedTotal ? { ...current.statedTotal } : undefined
  if (current?.mode === 'ai') return { ...current.total }
  return undefined
}

/** 草稿不保存 0/负数题型数量（实施路线 4.4：「多选改成 0」应在上游归一为 unset） */
function sanitizeTypeCounts(
  raw: Partial<Record<QuestionTypeId, DraftValue<number>>>,
): Partial<Record<QuestionTypeId, DraftValue<number>>> {
  const out: Partial<Record<QuestionTypeId, DraftValue<number>>> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v && v.value > 0) out[k as QuestionTypeId] = { ...v }
  }
  return out
}

function sumTypeCounts(typeCounts: Partial<Record<QuestionTypeId, DraftValue<number>>>): number {
  let sum = 0
  for (const v of Object.values(typeCounts)) {
    if (v && Number.isFinite(v.value) && v.value > 0) sum += v.value
  }
  return sum
}

/** 附加要求规范化去重，但不吞掉语义不同的要求（实施路线 11 节步骤 9） */
function applyRequirements(
  target: GenerationDraft,
  base: Array<DraftValue<string> & { id: string }>,
  append: Array<DraftValue<string>>,
  removeIds: string[],
): boolean {
  let changed = false
  const list = base.map((r) => ({ ...r }))
  const seen = new Set(list.map((r) => normalizeRequirementText(r.value)))

  for (const item of append ?? []) {
    const text = item.value.trim()
    if (!text) continue
    const key = normalizeRequirementText(text)
    if (seen.has(key)) continue // 语义相同的重复要求不再追加
    seen.add(key)
    list.push({ id: uid('req_'), value: text, basis: item.basis, evidence: item.evidence, messageId: item.messageId })
    changed = true
  }

  if (removeIds && removeIds.length > 0) {
    const removeSet = new Set(removeIds)
    const filtered = list.filter((r) => !removeSet.has(r.id))
    if (filtered.length !== list.length) {
      list.length = 0
      list.push(...filtered)
      changed = true
    }
  }

  if (changed) target.requirements = list
  return changed
}

/** 去重比较键：忽略全部空白差异（「难度偏难」与「难度 偏难」视为同一要求）；
 *  仅用于去重判定，存储值仍保留用户原文（trim 后） */
function normalizeRequirementText(text: string): string {
  return text.replace(/\s+/g, '')
}

/* ---------- source 解析（实施路线 5.4：资料合并的唯一入口在 reducer） ---------- */

function resolveCreatedSource(
  oldSource: GenerationDraftSource | undefined,
  action: DraftSourceAction,
): GenerationDraftSource {
  switch (action.kind) {
    case 'preserve':
      // replace 明确「沿用原资料」：复制旧 source；首轮创建无旧值则保持空
      return oldSource ? cloneSource(oldSource) : {}
    case 'clear':
      return {}
    case 'replace':
      return cloneSource(action.source)
  }
}

function resolveUpdatedSource(
  current: GenerationDraftSource,
  action: DraftSourceAction,
): { source: GenerationDraftSource; changed: boolean } {
  switch (action.kind) {
    case 'preserve':
      return { source: current, changed: false } // update 无新资料：完整保留旧 source
    case 'clear':
      return sourceEquals(current, {})
        ? { source: current, changed: false }
        : { source: {}, changed: true }
    case 'replace': {
      const next = cloneSource(action.source)
      return sourceEquals(current, next)
        ? { source: current, changed: false }
        : { source: next, changed: true }
    }
  }
}

function cloneSource(source: GenerationDraftSource): GenerationDraftSource {
  return {
    sourceMessageId: source.sourceMessageId,
    kbScope: source.kbScope ? JSON.parse(JSON.stringify(source.kbScope)) : undefined,
  }
}

function sourceEquals(a: GenerationDraftSource, b: GenerationDraftSource): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

function isEmptyDraft(draft: GenerationDraft): boolean {
  return (
    draft.topic === undefined &&
    draft.countPlan === undefined &&
    draft.requirements.length === 0 &&
    sourceEquals(draft.source, {})
  )
}

function pushTurnId(ids: string[], turnId: string): string[] {
  const next = [...ids, turnId]
  return next.length > MAX_APPLIED_TURN_IDS ? next.slice(next.length - MAX_APPLIED_TURN_IDS) : next
}
