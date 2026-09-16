import { beforeEach, describe, expect, it } from 'vitest'
import type { Pack, Question } from '../types'
import { clearAllStores, dbAnswers, dbLearning, dbWrongs, dbPacks, initDB } from '../db'
import { useReview, type ReviewQuestion } from './useReviewStore'

function mkPack(): Pack {
  return {
    id: 'p1',
    title: '测试包',
    category: '测试',
    source: 'manual',
    meta: { difficulty: '简单', objectives: [], tags: [], types: ['judge'], source: '', version: '1.0', formatVersion: '1.0' },
    chapters: [
      { id: 'c1', title: '章', summary: '', knowledge_points: [], question_ids: ['q1'], children: [] },
    ],
    questions: [
      { id: 'q1', type: 'judge', stem: '题干', options: ['正确', '错误'], answer: 'true', explanation: '', kp_ids: ['kp1', 'kp2'], difficulty: 1 },
    ],
    created_at: 0,
  }
}

const q: Question = {
  id: 'q1',
  type: 'judge',
  stem: '题干',
  options: ['正确', '错误'],
  answer: 'true',
  explanation: '解析',
  kp_ids: ['kp1', 'kp2'],
  difficulty: 1,
}

function reviewItem(over?: Partial<ReviewQuestion>): ReviewQuestion {
  return {
    kpId: 'kp1',
    kpTitle: '知识点一',
    packId: 'p1',
    packTitle: '测试包',
    question: q,
    ...over,
  }
}

describe('V4-F04：复习队列去重与原子提交', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
    useReview.setState({ list: [], index: 0, done: 0, lastFeedback: null, saving: false })
  })

  it('多个到期知识点命中同一道题时，列表只出现一次（不重复计账）', async () => {
    const pack = mkPack()
    await dbPacks.put(pack)
    // kp1 与 kp2 都到期
    await dbLearning.put({ kp_id: 'kp1', mastery: 0.4, state: '学习中', interval_days: 1, next_review: '2020-01-01', wrong_count: 0, last_result: 'wrong', recent: [true] })
    await dbLearning.put({ kp_id: 'kp2', mastery: 0.4, state: '学习中', interval_days: 1, next_review: '2020-01-01', wrong_count: 0, last_result: 'wrong', recent: [true] })
    await useReview.getState().start()
    // q1 同时命中 kp1/kp2，应只入列一次
    expect(useReview.getState().list.filter((i) => i.question.id === 'q1')).toHaveLength(1)
    expect(useReview.getState().list.map((i) => i.question.id)).toEqual(['q1'])
  })

  it('复习作答走同一事务：learning 与 answer 引用都更新（schedule=true 推进复习间隔）', async () => {
    await dbPacks.put(mkPack())
    await dbLearning.put({ kp_id: 'kp1', mastery: 0.4, state: '学习中', interval_days: 1, next_review: '2020-01-01', wrong_count: 0, last_result: 'wrong', recent: [true] })
    await useReview.getState().answer(reviewItem(), true)
    const learn = await dbLearning.get('kp1')
    expect(learn?.next_review).toBeDefined()
    expect(learn?.next_review).not.toBe('2020-01-01')
    const answers = await dbAnswers.getAll()
    expect(answers.some((a) => a.questionId === 'q1' && a.mode === 'review')).toBe(true)
    expect(useReview.getState().done).toBe(1)
  })

  it('事务任一点失败则 learning/wrongs/answers 全部回滚，saving 复位', async () => {
    await dbPacks.put(mkPack())
    // 注入含函数属性的题目 → wrongs/answers put 抛 DataCloneError，事务整体回滚
    const badQ: Question = { ...q, fn: () => {} } as Question
    await expect(useReview.getState().answer(reviewItem({ question: badQ }), false)).rejects.toThrow()
    expect(useReview.getState().saving).toBe(false)
    expect(await dbWrongs.getAll()).toHaveLength(0)
    expect(await dbAnswers.getAll()).toHaveLength(0)
  })

  it('提交期间 saving 锁：第二次 answer 立即返回不追加', async () => {
    useReview.setState({ saving: true })
    useReview.getState().answer(reviewItem(), true)
    expect(useReview.getState().done).toBe(0)
    expect(await dbAnswers.getAll()).toHaveLength(0)
  })
})