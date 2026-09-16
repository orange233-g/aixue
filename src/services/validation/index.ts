import type { Question, QuestionTypeId } from '../../types'
import { QUESTION_TYPES } from '../../types'
import { containsSensitive } from '../contentPolicy'
import { parseIndexArray, parseMatchAnswer, SUBJECTIVE_TYPES } from '../quiz'

/**
 * 校验服务（见 PRD 第 5 章）：结构 / 答案合法性 / 题型数量 / 去重 / 内容安全。
 * 生成题包与考试试卷共用同一校验引擎。
 */

export type ValidationIssue = 'missing_field' | 'bad_answer' | 'duplicate' | 'unsafe' | 'type_mismatch'

export interface ValidationResult {
  ok: boolean
  issues: { qid: string; code: ValidationIssue; message: string }[]
}

/** 结构校验：题干 / 答案 / 解析必填，选择题必须有选项 */
export function validateStructure(q: Question): string[] {
  const errs: string[] = []
  if (!q.stem?.trim()) errs.push('题干缺失')
  if (!q.answer?.trim()) errs.push('答案缺失')
  if (!q.explanation?.trim()) errs.push('解析缺失')
  const type = QUESTION_TYPES.find((t) => t.id === q.type)
  if (type?.hasOptions && (!q.options || q.options.length < 2)) errs.push('选择题缺少选项')
  return errs
}

/** 答案合法性：选择题索引在选项范围内且非空、判断题只能 true/false；
 *  BUG-6 修复：匹配/排序/填空/主观题的答案此前完全不校验（越界索引/非法 JSON/空答案静默入库），
 *  现按各题型答案结构校验，与判分引擎（gradeAnswer）同口径 */
export function validateAnswer(q: Question): string[] {
  const errs: string[] = []
  if (q.type === 'single' || q.type === 'multiple') {
    let idx: unknown
    try {
      idx = JSON.parse(q.answer || '[]')
    } catch {
      idx = null
    }
    if (!Array.isArray(idx) || idx.some((i) => i < 0 || i >= (q.options?.length ?? 0))) {
      errs.push('答案索引超出选项范围')
    } else if (q.type === 'multiple' && idx.length === 0) {
      errs.push('多选题答案不能为空')
    }
  }
  if (q.type === 'judge' && !['true', 'false'].includes(q.answer)) {
    errs.push('判断题答案必须为 true/false')
  }
  if (q.type === 'match') {
    // 答案结构 {"right":[...],"pairs":[[左,右],...]}：右列/配对缺失、索引越界均为坏题
    const m = parseMatchAnswer(q.answer || '')
    const leftN = q.options?.length ?? 0
    if (!m.right.length || !m.pairs.length) {
      errs.push('匹配题答案缺少右列或配对')
    } else if (m.pairs.some(([l, r]) => l < 0 || l >= leftN || r < 0 || r >= m.right.length)) {
      errs.push('匹配题配对索引越界')
    }
  }
  if (q.type === 'order') {
    // 答案必须是选项索引的完整排列（0..n-1 无重复无越界）
    const seq = parseIndexArray(q.answer || '')
    const n = q.options?.length ?? 0
    if (
      !seq.length ||
      seq.length !== n ||
      seq.some((i) => i < 0 || i >= n) ||
      new Set(seq).size !== seq.length
    ) {
      errs.push('排序题答案必须是选项的完整排列')
    }
  }
  if (q.type === 'fill' && !q.answer?.trim()) {
    errs.push('填空题答案不能为空')
  }
  if (SUBJECTIVE_TYPES.includes(q.type) && !q.answer?.trim()) {
    errs.push('主观题参考答案不能为空')
  }
  return errs
}

/** 题型数量核对：实际生成数量与题型结构一致 */
export function validateCount(structure: Record<QuestionTypeId, number>, questions: Question[]): string[] {
  const errs: string[] = []
  for (const [typeId, expected] of Object.entries(structure)) {
    if (expected <= 0) continue
    const actual = questions.filter((q) => q.type === typeId).length
    if (actual !== expected) errs.push(`题型 ${typeId} 期望 ${expected} 题，实际 ${actual} 题`)
  }
  return errs
}

/** 去重：题干相似度过高判为重复 */
export function validateDuplicate(questions: Question[]): string[] {
  const errs: string[] = []
  const seen = new Set<string>()
  for (const q of questions) {
    const key = q.stem.trim().replace(/\s+/g, '')
    if (seen.has(key)) errs.push(`与已有题目重复：${q.stem.slice(0, 20)}…`)
    seen.add(key)
  }
  return errs
}

/** 内容安全：敏感词 / 乱码 / 空内容拦截（默认基线 + 用户可配词，见 contentPolicy，兼容敏感词做成可配置项） */
export function validateSafety(q: Question): string[] {
  const errs: string[] = []
  if (containsSensitive(q.stem + q.explanation)) errs.push('内容包含异常或违规字符')
  return errs
}

/** 综合校验入口 */
export function validateQuestion(q: Question): string[] {
  return [
    ...validateStructure(q),
    ...validateAnswer(q),
    ...validateSafety(q),
  ]
}
