/**
 * GenerationDraft 固定展示层（实施路线 8.1 draftPresentation / TASK-02）。
 *
 * 职责：唯一把 draft + evaluation 变成「卡片摘要 / 下一问 / 执行 input」的地方。
 * 全部为确定性模板拼装，不调用模型；字段顺序固定，用户要求逐条保留不丢失。
 */
import type {
  DraftEvaluation,
  DraftIssue,
  GenerationCountPlan,
  GenerationDraft,
  QuestionTypeId,
} from '../../types'
import { QUESTION_TYPES } from '../../types'
import { nextQuestionFromIssues } from './draftValidation'

/* ---------------- 下一问 ---------------- */

/** 用 evaluation 里的问题码映射固定中文提示（固定优先级：冲突 > 缺主题/资料 > 缺总数 > 缺题型） */
export function buildDraftNextQuestion(evaluation: DraftEvaluation): string | undefined {
  return evaluation.nextQuestion ?? nextQuestionFromIssues(evaluation.conflicts, evaluation.missing)
}

/* ---------------- 卡片摘要（UI 展示模型，不是模型正文） ---------------- */

export interface GenerationDraftView {
  /** 字段顺序固定：主题 → 题量 → 题型 → 附加要求 → 资料范围（实施路线 12 节必测） */
  lifecycle: GenerationDraft['lifecycle']
  revision: number
  topic?: { value: string; /** true = AI 理解，请确认 */ inferred: boolean }
  /** 题量展示文本：ai → 原值；custom → 分项合计；缺失/冲突时 undefined */
  totalText?: string
  /** ai 模式：true（卡片显示「AI 推荐题型」）；custom 模式走 typeCounts */
  aiTypes?: boolean
  /** custom 题型分布：按 QUESTION_TYPES 规范顺序，省略 0 值 */
  typeCounts?: Array<{ id: QuestionTypeId; name: string; count: number }>
  /** custom 模式的对账总数（与分项冲突时卡片需同时可见） */
  statedTotalText?: string
  requirements?: Array<{ id: string; text: string; inferred: boolean }>
  /** 资料范围摘要（如「引用消息资料」「知识库 2 卷」） */
  sourceSummary?: string
  ready: boolean
  missing: DraftIssue[]
  conflicts: DraftIssue[]
  warnings: DraftIssue[]
  nextQuestion?: string
}

/** 方案卡标题只按生命周期优先，再用校验结果区分 active 的就绪状态。 */
export function generationDraftCardHead(
  lifecycle: GenerationDraft['lifecycle'],
  ready: boolean,
): string {
  if (lifecycle === 'generating') return '生成中…'
  if (lifecycle === 'completed') return '已完成'
  return ready ? '准备生成' : '正在整理生题需求'
}

export function formatGenerationDraft(
  draft: GenerationDraft,
  evaluation: DraftEvaluation,
): GenerationDraftView {
  // 字段顺序固定（实施路线 12 节必测）：主题 → 题量 → 题型 → 对账总数 → 要求 → 资料范围

  let topic: GenerationDraftView['topic']
  if (draft.topic) {
    topic = {
      value: draft.topic.value,
      inferred: draft.topic.basis === 'model_inferred' || draft.topic.basis === 'app_default',
    }
  }

  let aiTypes: true | undefined
  let typeCounts: GenerationDraftView['typeCounts']
  let totalText: string | undefined
  let statedTotalText: string | undefined
  const cp = draft.countPlan
  if (cp) {
    if (cp.mode === 'ai') {
      aiTypes = true
      totalText = String(cp.total.value)
    } else {
      typeCounts = orderedTypeCounts(cp)
      const sum = typeCounts.reduce((a, b) => a + b.count, 0)
      totalText = String(sum)
      if (cp.statedTotal) statedTotalText = String(cp.statedTotal.value)
    }
  }

  const requirements =
    draft.requirements.length > 0
      ? draft.requirements.map((r) => ({
          id: r.id,
          text: r.value,
          inferred: r.basis === 'model_inferred' || r.basis === 'app_default',
        }))
      : undefined

  const source = sourceSummary(draft)

  return {
    lifecycle: draft.lifecycle,
    revision: draft.revision,
    topic,
    totalText,
    aiTypes,
    typeCounts,
    statedTotalText,
    requirements,
    sourceSummary: source,
    ready: evaluation.ready,
    missing: evaluation.missing,
    conflicts: evaluation.conflicts,
    warnings: evaluation.warnings,
    nextQuestion: buildDraftNextQuestion(evaluation),
  }
}

/** 按 QUESTION_TYPES 规范顺序排列题型分布，省略 0 值（不依赖 Object.keys 顺序） */
function orderedTypeCounts(cp: Extract<GenerationCountPlan, { mode: 'custom' }>) {
  const out: Array<{ id: QuestionTypeId; name: string; count: number }> = []
  for (const t of QUESTION_TYPES) {
    const v = cp.typeCounts[t.id]
    if (v && v.value > 0) out.push({ id: t.id, name: t.name, count: v.value })
  }
  return out
}

function sourceSummary(draft: GenerationDraft): string | undefined {
  const parts: string[] = []
  if (draft.source.sourceMessageId) parts.push('引用消息资料')
  const volumes = draft.source.kbScope?.volumes.length ?? 0
  if (volumes > 0) parts.push(`知识库 ${volumes} 卷`)
  return parts.length > 0 ? parts.join(' + ') : undefined
}

/* ---------------- 执行 input（本地模板，不使用模型自然语言总结） ---------------- */

/** 无主题但有资料时的固定主句（实施路线 4.6/5.4） */
export const SOURCE_ONLY_INPUT = '请严格依据所选参考资料生成题目'

/** 稳定拼接主题与附加要求；不调用模型、不受模型正文影响（实施路线 4.6） */
export function buildGenerationInput(draft: GenerationDraft): string {
  const topic = draft.topic?.value.trim()
  const main = topic ? `围绕${topic}出题` : SOURCE_ONLY_INPUT
  if (draft.requirements.length === 0) return main
  const lines = draft.requirements.map((r, i) => `${i + 1}. ${r.value.trim()}`).join('\n')
  return `${main}\n附加要求：\n${lines}`
}
