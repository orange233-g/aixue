import { beforeEach, describe, expect, it } from 'vitest'
import type { Pack, Question } from '../../types'
import { clearAllStores, dbConfig, dbLearning, dbWrongs, initDB, withQuizSubmissionTransaction } from '../../db'
import { dbAnswers } from '../../db'
import { commitQuizSubmission } from './index'
import { dbCategories } from '../../db'

function mkQuestion(id: string, kpIds: string[]): Question {
  return {
    id,
    type: 'judge',
    stem: `题目 ${id}`,
    answer: 'A',
    explanation: '解析',
    kp_ids: kpIds,
    difficulty: 1,
  }
}

function mkPack(): Pack {
  return {
    id: 'pack-1',
    title: '测试题包',
    category: '测试',
    meta: { difficulty: '简单', objectives: [] },
    chapters: [],
    questions: [mkQuestion('q1', ['kp1']), mkQuestion('q2', ['kp1']), mkQuestion('q3', ['kp2'])],
    created_at: 0,
  }
}

describe('commitQuizSubmission（V2-F02 原子提交 / V2-I01 幂等）', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
  })

  it('答错的题：收录错题本并累计知识点答错次数', async () => {
    const pack = mkPack()
    const q = pack.questions[0]
    await commitQuizSubmission(
      { learned: [{ pack, question: q, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' },
      'sub-1',
    )

    const wrong = await dbWrongs.get(q.id)
    expect(wrong).toBeDefined()
    expect(wrong!.wrongCount).toBe(1)

    const lr = await dbLearning.get('kp1')
    expect(lr).toBeDefined()
    expect(lr!.wrong_count).toBe(1)
    expect(lr!.recent).toHaveLength(1)
    expect(lr!.recent![0]).toBe(false)
  })

  it('不同题包使用相同题目 ID 时，错题本分别保留两条记录', async () => {
    const packA = mkPack()
    const packB = { ...mkPack(), id: 'pack-2', title: '第二个测试题包' }
    const qA = packA.questions[0]
    const qB = packB.questions[0]
    await commitQuizSubmission(
      { learned: [{ pack: packA, question: qA, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' },
      'sub-pack-a',
    )
    await commitQuizSubmission(
      { learned: [{ pack: packB, question: qB, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' },
      'sub-pack-b',
    )

    const wrongs = await dbWrongs.getAll()
    expect(wrongs).toHaveLength(2)
    expect(wrongs.map((w) => w.packId).sort()).toEqual(['pack-1', 'pack-2'])
  })

  it('答对的题：掌握度上升、不入错题本', async () => {
    const pack = mkPack()
    const q = pack.questions[2]
    await commitQuizSubmission(
      { learned: [{ pack, question: q, correct: true }], wrongCorrectIds: [], schedule: false, mode: 'quiz' },
      'sub-2',
    )

    const wrong = await dbWrongs.get(q.id)
    expect(wrong).toBeUndefined()

    const lr = await dbLearning.get('kp2')
    expect(lr).toBeDefined()
    expect(lr!.mastery).toBe(1)
    expect(lr!.state).toBe('已掌握')
  })

  it('同一知识点多题聚合：多次作答进入同一滚动窗口，不逐题覆盖', async () => {
    const pack = mkPack()
    // kp1 两题：一错一对
    await commitQuizSubmission(
      {
        learned: [
          { pack, question: pack.questions[0], correct: false },
          { pack, question: pack.questions[1], correct: true },
        ],
        wrongCorrectIds: [],
        schedule: false,
        mode: 'quiz',
      },
      'sub-agg',
    )

    const lr = await dbLearning.get('kp1')
    expect(lr!.recent).toEqual([false, true])
    expect(lr!.mastery).toBe(0.5)
    expect(lr!.wrong_count).toBe(1)
  })

  it('幂等：同一 submissionId 重放不重复累计', async () => {
    const pack = mkPack()
    const q = pack.questions[0]
    const input = { learned: [{ pack, question: q, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' as const }

    await commitQuizSubmission(input, 'sub-idem')
    await commitQuizSubmission(input, 'sub-idem') // 重放应整体跳过

    const wrong = await dbWrongs.get(q.id)
    expect(wrong!.wrongCount).toBe(1)
    const lr = await dbLearning.get('kp1')
    expect(lr!.wrong_count).toBe(1)
    expect(lr!.recent).toHaveLength(1)

    // 作答记录同样只应写入一次
    const all = await dbAnswers.getAll()
    expect(all).toHaveLength(1)
  })

  it('不同 submissionId 是新的提交，正常累计（幂等只按 id 判重）', async () => {
    const pack = mkPack()
    const q = pack.questions[0]
    const mk = () => ({ learned: [{ pack, question: q, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' as const })

    await commitQuizSubmission(mk(), 'sub-a')
    await commitQuizSubmission(mk(), 'sub-b')

    const wrong = await dbWrongs.get(q.id)
    expect(wrong!.wrongCount).toBe(2)
    const lr = await dbLearning.get('kp1')
    expect(lr!.recent).toHaveLength(2)
  })

  it('错题重练答对：连续答对计数，达标标记已掌握', async () => {
    const pack = mkPack()
    const q = pack.questions[0]
    // 先错一次收录
    await commitQuizSubmission({ learned: [{ pack, question: q, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' }, 'w1')
    // 重练连续答对两次
    await commitQuizSubmission({ learned: [], wrongCorrectIds: [q.id], schedule: false, mode: 'wrong' }, 're-1')
    await commitQuizSubmission({ learned: [], wrongCorrectIds: [q.id], schedule: false, mode: 'wrong' }, 're-2')

    const wrong = await dbWrongs.get(q.id)
    expect(wrong!.correctStreak).toBe(2)
    expect(wrong!.mastered).toBe(true)
  })

  it('answers 与 config 幂等标记写在同一事务：提交后 config 有标记', async () => {
    const pack = mkPack()
    const q = pack.questions[0]
    await commitQuizSubmission({ learned: [{ pack, question: q, correct: true }], wrongCorrectIds: [], schedule: false, mode: 'quiz' }, 'sub-tx')
    const marker = await dbConfig.get('quiz_submission:sub-tx')
    expect(marker).toBeDefined()
  })

  it('不相关的 category 表不受影响', async () => {
    await dbCategories.add('其他')
    const pack = mkPack()
    await commitQuizSubmission({ learned: [{ pack, question: pack.questions[0], correct: true }], wrongCorrectIds: [], schedule: false, mode: 'quiz' }, 'sub-cat')
    const cats = await dbCategories.getAll()
    expect(cats).toEqual(['其他'])
  })

  it('事务故障回滚：任一步 put 抛错则 learning/wrongs/answers/config 全部回滚（V3-F02）', async () => {
    const pack = mkPack()
    // 给题目挂一个无法 structured-clone 的函数属性，使 wrongs put 抛 DataCloneError
    const badQ: Question = {
      ...pack.questions[0],
      // @ts-expect-error 运行时注入不可克隆属性以触发事务中途失败
      evil: () => {},
    }
    await expect(
      commitQuizSubmission(
        { learned: [{ pack, question: badQ, correct: false }], wrongCorrectIds: [], schedule: false, mode: 'quiz' },
        'sub-rollback',
      ),
    ).rejects.toThrow()

    // learning 已在错误发生**前**写入，但事务回滚后应全部不存在（无半提交）
    expect(await dbLearning.get('kp1')).toBeUndefined()
    expect(await dbWrongs.get('q1')).toBeUndefined()
    expect(await dbAnswers.getAll()).toHaveLength(0)
    // 幂等标记随事务一起回滚，重试同一 submissionId 可正常重新提交
    expect(await dbConfig.get('quiz_submission:sub-rollback')).toBeUndefined()
  })

  it('事务辅助函数：fn 内先写后抛，多 store 写入整体回滚（V3-F02）', async () => {
    await expect(
      withQuizSubmissionTransaction(async (tx) => {
        await tx.objectStore('learning').put({ kp_id: 'kp-roll', mastery: 0 } as never)
        await tx.objectStore('wrongs').put({ questionId: 'q-roll' } as never)
        throw new Error('模拟事务中途失败')
      }),
    ).rejects.toThrow('模拟事务中途失败')

    expect(await dbLearning.get('kp-roll')).toBeUndefined()
    expect(await dbWrongs.get('q-roll')).toBeUndefined()
  })
})
