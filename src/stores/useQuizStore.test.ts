import { beforeEach, describe, expect, it } from 'vitest'
import type { Pack } from '../types'
import { clearAllStores, dbConfig, dbWrongs, initDB } from '../db'
import { useQuiz } from './useQuizStore'
import { isEntrySubmitted } from '../services/quiz'

function mkPack(): Pack {
  return {
    id: 'p1',
    title: '测试包',
    category: '测试',
    source: 'manual',
    meta: { difficulty: '简单', objectives: [], tags: [], types: ['judge'], source: '', version: '1.0', formatVersion: '1.0' },
    chapters: [{ id: 'c1', title: '章', summary: '', knowledge_points: [], question_ids: ['q1'], children: [] }],
    questions: [
      { id: 'q1', type: 'judge', stem: '题干', options: ['正确', '错误'], answer: 'true', explanation: '', kp_ids: ['kp1'], difficulty: 1 },
    ],
    created_at: 0,
  }
}

/** 主观题包（简答）：BUG-1/2 回归用——统一「已答」口径后，主观题计分只认自评结果 */
function mkSubjectivePack(): Pack {
  return {
    id: 'p2',
    title: '主观题包',
    category: '测试',
    source: 'manual',
    meta: { difficulty: '简单', objectives: [], tags: [], types: ['short'], source: '', version: '1.0', formatVersion: '1.0' },
    chapters: [{ id: 'c1', title: '章', summary: '', knowledge_points: [], question_ids: ['q1'], children: [] }],
    questions: [
      { id: 'q1', type: 'short', stem: '简述', options: [], answer: '参考答案', explanation: '', kp_ids: ['kp1'], difficulty: 1 },
    ],
    created_at: 0,
  }
}

interface LSLike {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

/** 可控失败的 localStorage：quota 模式下 setItem 抛错（模拟配额满） */
function installLS() {
  const store = new Map<string, string>()
  let quota = false
  const mock: LSLike & { setQuota: (v: boolean) => void } & { store: Map<string, string> } = Object.assign(
    {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        if (quota) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
        store.set(k, v)
      },
      removeItem: (k: string) => {
        store.delete(k)
      },
      setQuota: (v: boolean) => {
        quota = v
      },
      store,
    },
    {} as LSLike,
  )
  ;(globalThis as Record<string, unknown>).localStorage = mock
  return mock
}

describe('V3-F02 / V4-F03：刷题提交幂等与提交期间锁', () => {
  let ls: ReturnType<typeof installLS>

  beforeEach(async () => {
    ls = installLS()
    await initDB()
    await clearAllStores()
    useQuiz.setState({ session: null, packs: [], submitting: false })
  })

  it('submitId 保存失败不得开始正式提交：submitting 复位且不写幂等标记', async () => {
    const pack = mkPack()
    await useQuiz.getState().start(pack, 'seq')
    useQuiz.getState().answer(pack.questions[0], 'true')
    // 进入提交前开启配额满：staged（含 submitId）持久化必失败
    ls.setQuota(true)
    await expect(useQuiz.getState().submit()).rejects.toThrow('提交 ID 保存失败')
    // 锁已复位，未卡在 submitting
    expect(useQuiz.getState().submitting).toBe(false)
    // 未进入事务：config 中不应残留任何 quiz_submission:* 幂等标记
    const cfg = await dbConfig.getAll()
    const marks = cfg.filter((r) => typeof r.key === 'string' && r.key.startsWith('quiz_submission:'))
    expect(marks).toHaveLength(0)
  })

  it('提交期间 answer/go/finish 被 store 层拦截', async () => {
    const pack = mkPack()
    await useQuiz.getState().start(pack, 'seq')
    useQuiz.setState({ submitting: true })
    useQuiz.getState().answer(pack.questions[0], 'true')
    expect(useQuiz.getState().session!.answers['q1']).toBeUndefined()
    useQuiz.getState().go(1)
    expect(useQuiz.getState().session!.index).toBe(0)
    useQuiz.getState().finish()
    expect(useQuiz.getState().session).not.toBeNull()
  })

  it('拦阻作答不影响持久化的会话内容', () => {
    useQuiz.setState({
      session: {
        packId: 'p1',
        packTitle: '测试包',
        mode: 'seq',
        questionIds: ['q1'],
        packIds: ['p1'],
        index: 0,
        answers: {},
        results: {},
        submitted: false,
        correct: 0,
        startedAt: 0,
      },
      packs: [mkPack()],
    })
    useQuiz.setState({ submitting: true })
    const s = useQuiz.getState().session
    expect(s).not.toBeNull()
  })

  it('错题重练用题包+题目定位，两个题包同题号不会串题', async () => {
    const packA = mkPack()
    const packB = { ...mkPack(), id: 'p2', title: '第二包' }
    await dbWrongs.put({ questionId: 'q1', packId: packA.id, packTitle: packA.title, question: packA.questions[0], wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: 0, createdAt: 0 })
    await dbWrongs.put({ questionId: 'q1', packId: packB.id, packTitle: packB.title, question: packB.questions[0], wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: 0, createdAt: 0 })
    await useQuiz.getState().startWrong(await dbWrongs.getAll(), [packA, packB])
    useQuiz.getState().answer(packA.questions[0], 'false')
    useQuiz.getState().go(1)
    useQuiz.getState().answer(packB.questions[0], 'true')
    await useQuiz.getState().submit()

    const wrongs = await dbWrongs.getAll()
    expect(wrongs).toHaveLength(2)
    expect(wrongs.find((w) => w.packId === packB.id)?.correctStreak).toBe(1)
  })
})

describe('BUG-1/2：主观题「已答」口径统一（计数/弹窗/计分共用 isEntryAnswered）', () => {
  beforeEach(async () => {
    installLS()
    await initDB()
    await clearAllStores()
    useQuiz.setState({ session: null, packs: [], submitting: false })
  })

  it('主观题写了文本但未自评 → 提交为待自评：不计分、不入错题本', async () => {
    const pack = mkSubjectivePack()
    await useQuiz.getState().start(pack, 'seq')
    useQuiz.getState().answer(pack.questions[0], '我写了答案但没自评')
    const r = await useQuiz.getState().submit()
    // 待自评不计分，但结果页仍能识别出用户已经填写过文本
    expect(r).toEqual({ total: 0, correct: 0 })
    const s = useQuiz.getState().session!
    expect(s.results['q1']?.pendingSelfReview).toBe(true)
    expect(s.submitted).toBe(true)
  })

  it('主观题有文本但未自评 → 识别为待自评，而不是未作答', () => {
    expect(isEntrySubmitted({ type: 'short' }, { ua: '我写了答案但没自评' })).toBe(true)
    expect(isEntrySubmitted({ type: 'short' }, { ua: '   ' })).toBe(false)
  })

  it('主观题文本 + 自评「答对」→ 判对计分（自评结果不丢失）', async () => {
    const pack = mkSubjectivePack()
    await useQuiz.getState().start(pack, 'seq')
    useQuiz.getState().answer(pack.questions[0], '我的作答', true)
    const r = await useQuiz.getState().submit()
    expect(r).toEqual({ total: 1, correct: 1 })
    const s = useQuiz.getState().session!
    expect(s.results['q1']?.correct).toBe(true)
  })

  it('主观题文本 + 自评「答错」→ 判错计分', async () => {
    const pack = mkSubjectivePack()
    await useQuiz.getState().start(pack, 'seq')
    useQuiz.getState().answer(pack.questions[0], '我的作答', false)
    const r = await useQuiz.getState().submit()
    expect(r).toEqual({ total: 1, correct: 0 })
    const s = useQuiz.getState().session!
    expect(s.results['q1']?.correct).toBe(false)
  })
})
