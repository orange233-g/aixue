import type { QuestionTypeId } from '../../types'

/** 默认题型结构（未配置时兜底） */
export function defaultStructure(): Record<QuestionTypeId, number> {
  return {
    single: 10,
    multiple: 0,
    judge: 5,
    fill: 5,
    match: 0,
    order: 0,
    short: 0,
    case: 0,
    essay: 0,
  }
}

/** 空题型结构（自定义模式默认）：用户必须主动设置题数，
 *  避免「以为设了 100、实际是默认 20」的认知落差 */
export function zeroStructure(): Record<QuestionTypeId, number> {
  return {
    single: 0,
    multiple: 0,
    judge: 0,
    fill: 0,
    match: 0,
    order: 0,
    short: 0,
    case: 0,
    essay: 0,
  }
}
