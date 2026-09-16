import { describe, expect, it } from 'vitest'
import type { Pack, Question } from '../../types'
import { buildQuiz } from './index'

function mkPack(): Pack {
  const q = (id: string, kp: string): Question => ({
    id,
    type: 'single',
    stem: `题 ${id}`,
    options: ['A', 'B'],
    answer: 'A',
    explanation: '',
    kp_ids: [kp],
    difficulty: 1,
  })
  return {
    id: 'p1',
    title: '测试包',
    category: '',
    source: 'ai',
    meta: { difficulty: '简单', objectives: [] },
    chapters: [
      { id: 'ch1', title: '章1', summary: '', knowledge_points: [{ id: 'k1', title: '知识点1', content: '', examples: [], pitfalls: [] }], question_ids: [] },
      { id: 'ch2', title: '章2', summary: '', knowledge_points: [{ id: 'k2', title: '知识点2', content: '', examples: [], pitfalls: [] }], question_ids: [] },
    ],
    questions: [q('a1', 'k1'), q('a2', 'k1'), q('a3', 'k1'), q('b1', 'k2'), q('b2', 'k2')],
    created_at: 0,
  }
}

describe('buildQuiz 章节过滤（章节刷弹窗支持顺序/随机）', () => {
  it('chapter 模式：只取该章题目、保持顺序（原行为不变）', () => {
    const qs = buildQuiz(mkPack(), 'chapter', 'ch1')
    expect(qs.map((q) => q.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('seq + chapterId：章内顺序（章节刷选顺序刷）', () => {
    const qs = buildQuiz(mkPack(), 'seq', 'ch2')
    expect(qs.map((q) => q.id)).toEqual(['b1', 'b2'])
  })

  it('rand + chapterId：章内随机——题目仍全部属于该章', () => {
    const qs = buildQuiz(mkPack(), 'rand', 'ch1')
    expect(qs).toHaveLength(3)
    expect(new Set(qs.map((q) => q.id))).toEqual(new Set(['a1', 'a2', 'a3']))
  })

  it('rand + count 截取：数量生效且不越章', () => {
    const qs = buildQuiz(mkPack(), 'rand', 'ch1')
    const sliced = qs.slice(0, 2)
    expect(sliced.every((q) => q.id.startsWith('a'))).toBe(true)
  })

  it('无 chapterId 时行为不变：seq 全包顺序、rand 全包随机', () => {
    expect(buildQuiz(mkPack(), 'seq').map((q) => q.id)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2'])
    expect(buildQuiz(mkPack(), 'rand')).toHaveLength(5)
  })
})
