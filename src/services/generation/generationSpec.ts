/**
 * GenerationExecutionSpec 构建器（实施路线 4.6 / TASK-02）。
 *
 * spec 是最终生成的唯一参数来源：模型正文和消息按钮都不再直接
 * 决定生成参数。快捷生成（origin.kind='quick'）与对话生成（origin.kind=
 * 'conversation'）共用本模块，后者必须通过 ready + revision + 资料三重门禁。
 * 返回对象做浅冻结；构建后修改原 draft 不影响已返回的 spec。
 */
import type {
  DraftIssue,
  GenerationDraft,
  GenerationExecutionSpec,
  KbScope,
  QuestionTypeId,
} from '../../types'
import { zeroStructure } from './structure'
import type { ResolvedGenerationSource } from './generationSource'
import { evaluateGenerationDraft } from './draftValidation'
import { buildGenerationInput } from './draftPresentation'

/** 对话模式：只有 ready 且 revision 匹配且资料解析成功才能构建（实施路线 4.6） */
export function buildGenerationExecutionSpec(
  draft: GenerationDraft,
  expectedRevision: number,
  resolvedSource: ResolvedGenerationSource,
): GenerationExecutionSpec | null {
  // 门禁 1：确定性就绪（含 lifecycle active、无 missing/conflicts、turnIssues 为空）
  const evaluation = evaluateGenerationDraft(draft)
  if (!evaluation.ready) return null
  // 门禁 2：旧 revision 一律拒绝（P0-12）
  if (draft.revision !== expectedRevision) return null
  // 门禁 3：资料解析成功（SOURCE_MISSING 禁止启动，P0-22）
  if (!resolvedSource.ok) return null

  const total = evaluation.effectiveTotal
  if (total === undefined || !Number.isInteger(total) || total < 1) return null

  const mode = draft.countPlan!.mode
  const structure = normalizeStructure(mode, total, draft)
  const spec: GenerationExecutionSpec = {
    origin: {
      kind: 'conversation',
      draftId: draft.id,
      draftRevision: draft.revision,
      sessionId: draft.sessionId,
    },
    input: buildGenerationInput(draft),
    mode,
    structure,
    total,
    ...(resolvedSource.refs ? { refs: resolvedSource.refs } : {}),
    ...(resolvedSource.kbScope ? { kbScope: resolvedSource.kbScope as KbScope } : {}),
  }
  return freezeSpec(spec)
}

/** 快捷生成：独立工厂，origin 不伪造 draftId/revision（实施路线 4.6/12 节必测） */
export function buildQuickExecutionSpec(
  input: string,
  mode: 'ai' | 'custom',
  structure: Record<QuestionTypeId, number>,
  refs?: string,
  kbScope?: KbScope,
): GenerationExecutionSpec {
  const total = Object.values(structure).reduce((a, b) => a + b, 0)
  const spec: GenerationExecutionSpec = {
    origin: { kind: 'quick' },
    input,
    mode,
    structure: mode === 'ai' ? { ...zeroStructure(), single: total } : { ...structure },
    total,
    ...(refs ? { refs } : {}),
    ...(kbScope ? { kbScope } : {}),
  }
  return freezeSpec(spec)
}

/** ai 模式沿用现有引擎兼容表示：structure 仅在 single 位承载总数，题型由 AI 决定（实施路线 4.6） */
function normalizeStructure(
  mode: 'ai' | 'custom',
  total: number,
  draft: GenerationDraft,
): Record<QuestionTypeId, number> {
  if (mode === 'ai') return { ...zeroStructure(), single: total }
  const structure = zeroStructure()
  const typeCounts = draft.countPlan!.mode === 'custom' ? draft.countPlan!.typeCounts : {}
  for (const [k, v] of Object.entries(typeCounts)) {
    if (v && v.value > 0) structure[k as QuestionTypeId] = v.value
  }
  return structure
}

function freezeSpec(spec: GenerationExecutionSpec): GenerationExecutionSpec {
  Object.freeze(spec)
  Object.freeze(spec.origin)
  Object.freeze(spec.structure)
  return spec
}

/** 供 Store 在点击时聚合使用：结构校验 + 资料解析的合并视图（SOURCE_MISSING 在此透出） */
export function resolveSourceIssues(resolved: ResolvedGenerationSource): DraftIssue[] {
  return resolved.ok ? [] : [resolved.issue!]
}
