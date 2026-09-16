import type { Question } from '../../types'
import { validateQuestion } from '../validation'

/** 生成历史/预览共用：异常题不计入有效题数，但保留生成总数供诊断。 */
export function filterValidQuestions(questions: Question[]): Question[] {
  return questions.filter((q) => validateQuestion(q).length === 0)
}

export function countValidQuestions(questions: Question[]): number {
  return filterValidQuestions(questions).length
}
