import { describe, expect, it } from 'vitest'
import type { Question } from '../../types'
import { validateAnswer } from './index'

function q(partial: Partial<Question> & { type: Question['type']; answer: string }): Question {
  return {
    id: 'q1',
    stem: '题干',
    options: [],
    explanation: '解析',
    kp_ids: ['kp1'],
    difficulty: 1,
    ...partial,
  } as Question
}

describe('BUG-6：匹配/排序/填空/简答答案参与校验（此前完全不校验，坏题静默入库）', () => {
  it('匹配题：越界配对索引报「配对索引越界」', () => {
    const bad = q({
      type: 'match',
      answer: JSON.stringify({ right: ['甲', '乙'], pairs: [[0, 9]] }),
      options: ['左一', '左二'],
    })
    expect(validateAnswer(bad)).toContain('匹配题配对索引越界')
  })

  it('匹配题：缺右列/配对（如只存了 "A-1,B-2" 文本）报「缺少右列或配对」', () => {
    const bad = q({ type: 'match', answer: 'A-1,B-2', options: ['左一', '左二'] })
    expect(validateAnswer(bad)).toContain('匹配题答案缺少右列或配对')
  })

  it('匹配题：结构完整的答案不报错', () => {
    const ok = q({
      type: 'match',
      answer: JSON.stringify({ right: ['甲', '乙'], pairs: [[0, 0], [1, 1]] }),
      options: ['左一', '左二'],
    })
    expect(validateAnswer(ok)).toHaveLength(0)
  })

  it('排序题：越界索引/重复索引/缺项报「完整排列」', () => {
    const o = ['甲', '乙', '丙']
    expect(validateAnswer(q({ type: 'order', answer: '[0,1,9]', options: o }))).toContain('排序题答案必须是选项的完整排列')
    expect(validateAnswer(q({ type: 'order', answer: '[0,0,1]', options: o }))).toContain('排序题答案必须是选项的完整排列')
    expect(validateAnswer(q({ type: 'order', answer: '[0,1]', options: o }))).toContain('排序题答案必须是选项的完整排列')
    expect(validateAnswer(q({ type: 'order', answer: '[2,0,1]', options: o }))).toHaveLength(0)
  })

  it('多选题：空答案 [] 报「答案不能为空」（此前通过）', () => {
    expect(validateAnswer(q({ type: 'multiple', answer: '[]', options: ['甲', '乙'] }))).toContain('多选题答案不能为空')
    expect(validateAnswer(q({ type: 'multiple', answer: '[0]', options: ['甲', '乙'] }))).toHaveLength(0)
  })

  it('填空题/主观题：空参考答案报错，非空通过', () => {
    expect(validateAnswer(q({ type: 'fill', answer: '  ' }))).toContain('填空题答案不能为空')
    expect(validateAnswer(q({ type: 'short', answer: '' }))).toContain('主观题参考答案不能为空')
    expect(validateAnswer(q({ type: 'essay', answer: '参考答案要点' }))).toHaveLength(0)
  })
})
