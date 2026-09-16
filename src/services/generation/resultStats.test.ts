import { describe, expect, it } from 'vitest'
import type { Question } from '../../types'
import { countValidQuestions } from './resultStats'

const q = (id: string, stem: string): Question => ({
  id,
  type: 'judge',
  stem,
  options: ['正确', '错误'],
  answer: 'true',
  explanation: '说明',
  kp_ids: [],
  difficulty: 1,
})

describe('生成结果统计', () => {
  it('有效题数与生成总数分开统计', () => {
    expect(countValidQuestions([q('ok', '有效题'), q('bad', '')])).toBe(1)
  })
})
