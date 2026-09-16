/**
 * GenerationDraft 确定性校验（实施路线 4.5 / TASK-02）。
 *
 * 这是「是否可以生成」的唯一判定者：按钮显隐只读 evaluateGenerationDraft()，
 * 模型输出的 complete/gathering/ready/show_button 一律不参与判断。
 * 纯函数：不依赖 Store、网络、IndexedDB；给定一个 draft 即可离线断言按钮状态。
 *
 * 规则要点（4.5）：
 * - 超限是 conflict，绝不 Math.min 静默夹取，显示用户原值；
 * - 数量 basis 只允许 user_explicit / app_derived，发现 model_inferred/app_default
 *   数量即 COUNT_NOT_EXPLICIT 阻断；
 * - turnIssues 有未应用问题时禁止生成，直到成功更新或用户「仍按当前方案」；
 * - topic/requirements 的 model_inferred 不阻断，进 warnings（卡片标「AI 理解，请确认」）。
 */
import type {
  DraftEvaluation,
  DraftIssue,
  DraftIssueCode,
  DraftValue,
  GenerationCountPlan,
  GenerationDraft,
  QuestionTypeId,
} from '../../types'
import { MAX_PER_TYPE, MAX_QUESTIONS_PER_GENERATION } from '../../types'

/* ---------------- 下一问固定映射（实施路线 4.5：不要让模型自由决定下一轮问什么） ---------------- */

/** 优先级：冲突修正 > 缺主题/资料 > 缺总题数 > 缺自定义题型 > 其他 */
const MISSING_PRIORITY: DraftIssueCode[] = [
  'TOPIC_OR_SOURCE_REQUIRED',
  'TOTAL_REQUIRED',
  'CUSTOM_TYPES_REQUIRED',
]

/** 由问题码映射固定中文提示；TOTAL_TYPE_SUM_MISMATCH 等带数字的冲突直接用其固定 message */
export function nextQuestionFromIssues(
  conflicts: DraftIssue[],
  missing: DraftIssue[],
): string | undefined {
  if (conflicts.length > 0) return conflicts[0].message
  for (const code of MISSING_PRIORITY) {
    const hit = missing.find((i) => i.code === code)
    if (hit) return hit.message
  }
  return missing[0]?.message
}

function issue(code: DraftIssueCode, message: string, field?: string): DraftIssue {
  return { code, message, ...(field ? { field } : {}) }
}

/* ---------------- 评估 ---------------- */

export function evaluateGenerationDraft(draft: GenerationDraft): DraftEvaluation {
  const missing: DraftIssue[] = []
  const conflicts: DraftIssue[] = []
  const warnings: DraftIssue[] = []
  let effectiveTotal: number | undefined

  // 规则 1：lifecycle 必须为 active
  if (draft.lifecycle !== 'active') {
    conflicts.push(
      issue('DRAFT_NOT_ACTIVE', `当前方案${lifecycleText(draft.lifecycle)}，不能再次启动生成`),
    )
  }

  // 规则 2：主题或资料来源至少其一（空对象不算资料来源）
  if (!hasTopic(draft) && !hasSource(draft)) {
    missing.push(issue('TOPIC_OR_SOURCE_REQUIRED', '请告诉我出题主题，或选择知识库/文件资料', 'topic'))
  }

  // 规则 12：topic/requirements 的 model_inferred 不阻断，进 warnings
  if (draft.topic && isInferredBasis(draft.topic.basis)) {
    warnings.push(
      issue('TOPIC_OR_SOURCE_REQUIRED', `主题「${draft.topic.value}」为 AI 理解，请确认`, 'topic'),
    )
  }
  for (const r of draft.requirements) {
    if (isInferredBasis(r.basis)) {
      warnings.push(
        issue('TOPIC_OR_SOURCE_REQUIRED', `附加要求「${r.value}」为 AI 理解，请确认`, 'requirements'),
      )
    }
  }

  // 规则 3/4/5/6/10：题数计划
  evaluateCountPlan(draft.countPlan, missing, conflicts, (total) => {
    effectiveTotal = total
  })

  // 规则 11：turnIssues 有未应用问题时禁止生成
  if (draft.turnIssues.length > 0) {
    conflicts.push(
      issue(
        'TURN_UPDATE_NOT_APPLIED',
        '上一轮修改未应用：请换一种说法重试，或点「仍按当前方案」继续',
      ),
    )
  }

  const ready = missing.length === 0 && conflicts.length === 0
  return {
    ready,
    effectiveTotal,
    missing,
    conflicts,
    warnings,
    nextQuestion: nextQuestionFromIssues(conflicts, missing),
  }
}

function evaluateCountPlan(
  countPlan: GenerationCountPlan | undefined,
  missing: DraftIssue[],
  conflicts: DraftIssue[],
  setTotal: (total: number) => void,
): void {
  if (!countPlan) {
    missing.push(issue('TOTAL_REQUIRED', '请问一共要多少道题？', 'countPlan'))
    return
  }

  if (countPlan.mode === 'ai') {
    const total = countPlan.total
    // 规则 10：数量 basis 只能 user_explicit / app_derived
    if (isInferredBasis(total.basis)) {
      conflicts.push(issue('COUNT_NOT_EXPLICIT', '总题数必须是用户明确说出的数字，不能由 AI 推测', 'countPlan'))
      return
    }
    // 规则 3：必须有范围内整数总数（防御：reducer 不会产出缺 total 的 ai 计划）
    if (typeof total.value !== 'number' || !Number.isInteger(total.value)) {
      conflicts.push(issue('TOTAL_OUT_OF_RANGE', `总题数「${String(total.value)}」不是有效整数，请重新说明`, 'countPlan'))
      return
    }
    if (total.value < 1 || total.value > MAX_QUESTIONS_PER_GENERATION) {
      // 规则 7：超限是 conflict，显示原值，不夹取
      conflicts.push(
        issue(
          'TOTAL_OUT_OF_RANGE',
          `${total.value} 超出单次生成上限（1～${MAX_QUESTIONS_PER_GENERATION} 题），请修正后重试`,
          'countPlan',
        ),
      )
      setTotal(total.value)
      return
    }
    setTotal(total.value)
    return
  }

  // custom 模式
  const entries = Object.entries(countPlan.typeCounts) as Array<
    [QuestionTypeId, DraftValue<number> | undefined]
  >
  let sum = 0
  let hasValid = false
  for (const [, v] of entries) {
    if (!v) continue
    // 规则 10：数量 basis 只能 user_explicit / app_derived
    if (isInferredBasis(v.basis)) {
      conflicts.push(issue('COUNT_NOT_EXPLICIT', '题型数量必须是用户明确说出的数字，不能由 AI 推测', 'countPlan'))
      return
    }
  }
  for (const [, v] of entries) {
    if (!v) continue
    if (!Number.isInteger(v.value) || v.value < 0) {
      conflicts.push(issue('TYPE_COUNT_OUT_OF_RANGE', `题型数量「${String(v.value)}」无效`, 'countPlan'))
      return
    }
    if (v.value > MAX_PER_TYPE) {
      // 规则 7：显示原值，不夹取
      conflicts.push(
        issue('TYPE_COUNT_OUT_OF_RANGE', `单个题型最多 ${MAX_PER_TYPE} 题（当前为 ${v.value}），请修正`, 'countPlan'),
      )
      return
    }
    if (v.value > 0) {
      hasValid = true
      sum += v.value
    }
  }

  // 规则 4：至少一个受支持题型的整数数量 > 0
  if (!hasValid) {
    missing.push(issue('CUSTOM_TYPES_REQUIRED', '请指定各题型的数量（或说「题型你安排」由 AI 分配）', 'countPlan'))
    return
  }

  // 规则 4：合计上限
  if (sum > MAX_QUESTIONS_PER_GENERATION) {
    conflicts.push(
      issue(
        'TOTAL_OUT_OF_RANGE',
        `合计 ${sum} 题超出单次生成上限（1～${MAX_QUESTIONS_PER_GENERATION} 题），请修正`,
        'countPlan',
      ),
    )
    setTotal(sum)
    return
  }

  // 规则 5/6：statedTotal 对账
  const stated = countPlan.statedTotal
  if (stated) {
    if (isInferredBasis(stated.basis)) {
      conflicts.push(issue('COUNT_NOT_EXPLICIT', '总题数必须是用户明确说出的数字，不能由 AI 推测', 'countPlan'))
      return
    }
    if (!Number.isInteger(stated.value) || stated.value < 1 || stated.value > MAX_QUESTIONS_PER_GENERATION) {
      conflicts.push(
        issue('TOTAL_OUT_OF_RANGE', `总题数 ${String(stated.value)} 超出范围（1～${MAX_QUESTIONS_PER_GENERATION}），请修正`, 'countPlan'),
      )
      setTotal(sum)
      return
    }
    if (stated.value !== sum) {
      // 固定提示：同时显示 statedTotal、分项合计和差额，并给两个明确选择（实施路线 4.5）
      const diff = Math.abs(stated.value - sum)
      conflicts.push(
        issue(
          'TOTAL_TYPE_SUM_MISMATCH',
          `总数 ${stated.value} 与分项合计 ${sum} 不一致（差 ${diff}）：可选「全部题型由 AI 安排」，或补齐/修改分项。`,
          'countPlan',
        ),
      )
      setTotal(sum)
      return
    }
  }

  setTotal(sum)
}

/* ---------------- 工具 ---------------- */

function hasTopic(draft: GenerationDraft): boolean {
  return !!draft.topic && draft.topic.value.trim().length > 0
}

/** 空对象不算资料来源：sourceMessageId 非空，或 kbScope 含有效 volume（实施路线 4.5 规则 2） */
function hasSource(draft: GenerationDraft): boolean {
  const s = draft.source
  if (s.sourceMessageId && s.sourceMessageId.trim().length > 0) return true
  if (s.kbScope && s.kbScope.volumes.length > 0) return true
  return false
}

function isInferredBasis(basis: string): boolean {
  return basis === 'model_inferred' || basis === 'app_default'
}

function lifecycleText(lifecycle: GenerationDraft['lifecycle']): string {
  switch (lifecycle) {
    case 'generating':
      return '正在生成中'
    case 'completed':
      return '已完成'
    case 'cancelled':
      return '已取消'
    default:
      return '不可用'
  }
}
