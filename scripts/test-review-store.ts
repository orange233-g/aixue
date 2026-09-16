import 'fake-indexeddb/auto'
import { resetDB, clearAllStores, dbLearning, dbPacks, dbWrongs } from '../src/db'
import { useReview } from '../src/stores/useReviewStore'
import { useLearning } from '../src/stores/useLearningStore'
import { DAILY_REVIEW_LIMIT, todayStr, addDaysStr } from '../src/services/learning'
import type { Pack, Question, LearningState } from '../src/types'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

function makePack(id: string, title: string, kps: { id: string; title: string; qid: string }[]): Pack {
  const questions: Question[] = kps.map((k) => ({
    id: k.qid,
    type: 'single',
    stem: `${k.qid} 题干`,
    options: ['A', 'B', 'C', 'D'],
    answer: '[0]',
    explanation: '解析',
    kp_ids: [k.id],
    difficulty: 1,
  }))
  return {
    id,
    title,
    category: '',
    source: 'ai',
    meta: { difficulty: 'auto', objectives: [] },
    chapters: [
      {
        id: 'ch1',
        title: '章节',
        summary: '',
        knowledge_points: kps.map((k) => ({ id: k.id, title: k.title, content: '', examples: [], pitfalls: [] })),
        question_ids: questions.map((q) => q.id),
      },
    ],
    questions,
    created_at: Date.now(),
  }
}

function dueState(kpId: string, interval = 1): LearningState {
  return {
    kp_id: kpId,
    mastery: 0.5,
    state: '学习中',
    interval_days: interval,
    next_review: todayStr(),
    wrong_count: 0,
    last_result: 'correct',
    recent: [true, false, true],
  }
}

function resetStores() {
  useReview.setState({ dueCount: 0, list: [], index: 0, done: 0, lastFeedback: null, loaded: false })
  useLearning.setState({ states: [], wrongs: [], loaded: false })
}

async function fresh() {
  resetDB()
  await clearAllStores()
  resetStores()
}

async function run() {
  console.log('—— 空队列 ——')
  await fresh()
  await useReview.getState().load()
  assert(useReview.getState().dueCount === 0, '空队列 dueCount = 0')
  await useReview.getState().start()
  assert(useReview.getState().list.length === 0, '空队列序列为空')

  console.log('—— 到期队列构建序列 ——')
  await fresh()
  const pack = makePack('pack_r', '复习测试包', [
    { id: 'kp1', title: '知识点一', qid: 'rq1' },
    { id: 'kp2', title: '知识点二', qid: 'rq2' },
    { id: 'kp3', title: '知识点三', qid: 'rq3' },
  ])
  await dbPacks.put(pack)
  await dbLearning.put(dueState('kp1'))
  await dbLearning.put(dueState('kp2'))
  await dbLearning.put(dueState('kp3'))
  await useReview.getState().load()
  assert(useReview.getState().dueCount === 3, 'dueCount = 3')
  await useReview.getState().start()
  const st = useReview.getState()
  assert(st.list.length === 3, '序列 3 项')
  assert(st.list[0].kpId === 'kp1' && st.list[0].question.id === 'rq1', '每知识点抽取 1 题')
  assert(st.list[0].kpTitle === '知识点一', '携带知识点标题')
  assert(st.list[0].packTitle === '复习测试包', '携带题包标题')

  console.log('—— 无关联题目的到期知识点跳过 ——')
  await fresh()
  await dbPacks.put(pack)
  await dbLearning.put(dueState('kp1'))
  await dbLearning.put(dueState('kp2'))
  await dbLearning.put(dueState('kp3'))
  await dbLearning.put(dueState('kp_orphan'))
  await useReview.getState().start()
  assert(useReview.getState().list.length === 3, '孤儿知识点被跳过')

  console.log('—— 每日复习上限截断 ——')
  await fresh()
  const bigPack = makePack('pack_big', '大批量包', Array.from({ length: 25 }, (_, i) => ({ id: `bk${i}`, title: `知识点${i}`, qid: `bq${i}` })))
  await dbPacks.put(bigPack)
  for (let i = 0; i < 25; i++) await dbLearning.put(dueState(`bk${i}`))
  await useReview.getState().start()
  assert(useReview.getState().list.length === DAILY_REVIEW_LIMIT, `超过上限截断为 ${DAILY_REVIEW_LIMIT}`)

  console.log('—— 答对：间隔翻倍 + 学习状态更新 ——')
  await fresh()
  await dbPacks.put(pack)
  await dbLearning.put(dueState('kp1'))
  await dbLearning.put(dueState('kp2'))
  await dbLearning.put(dueState('kp3'))
  await useReview.getState().load()
  await useReview.getState().start()
  const item = useReview.getState().list[0]
  assert(item.kpId === 'kp1', '序列首项为 kp1')
  await useReview.getState().answer(item, true)
  let s = useReview.getState()
  assert(s.done === 1, '答对后 done +1')
  assert(s.lastFeedback?.correct === true && s.lastFeedback?.interval === 3, '答对反馈：下次 3 天后')
  let ls = await dbLearning.get(item.kpId)
  assert(ls?.interval_days === 3, '间隔 1→3')
  assert(ls?.next_review === addDaysStr(todayStr(), 3), '下次 3 天后复习')
  assert(ls && ls.mastery > 0.5, '掌握度上升')

  console.log('—— 答错：间隔重置 + 错题本收录 ——')
  const item2 = useReview.getState().list[1]
  assert(item2.kpId === 'kp2', '序列次项为 kp2')
  await useReview.getState().answer(item2, false)
  s = useReview.getState()
  assert(s.done === 2, '答错后 done +1')
  assert(s.lastFeedback?.correct === false && s.lastFeedback?.interval === 1, '答错反馈：明天再复习')
  ls = await dbLearning.get(item2.kpId)
  assert(ls?.interval_days === 1, '答错间隔重置 1')
  assert(ls?.next_review === addDaysStr(todayStr(), 1), '明天复习')
  const wrong = await dbWrongs.get(item2.question.id)
  assert(!!wrong, '答错题目进错题本')

  console.log('—— next / finish ——')
  useReview.setState({ list: [item, item2], index: 0, done: 0 })
  let doneFlag = useReview.getState().next()
  assert(doneFlag === false && useReview.getState().index === 1, 'next 前进，未完成')
  doneFlag = useReview.getState().next()
  assert(doneFlag === true && useReview.getState().index === 2, '最后一题 next 返回完成')
  useReview.getState().finish()
  const fin = useReview.getState()
  assert(fin.list.length === 0 && fin.index === 0 && fin.done === 0 && fin.lastFeedback === null, 'finish 清空状态')

  console.log('—— 中途退出恢复 ——')
  await fresh()
  await dbPacks.put(pack)
  await dbLearning.put(dueState('kp1'))
  await dbLearning.put(dueState('kp2'))
  await dbLearning.put(dueState('kp3'))
  await useReview.getState().load()
  await useReview.getState().start()
  const first = useReview.getState().list[0]
  await useReview.getState().answer(first, true)
  useReview.getState().next()
  const mid = useReview.getState()
  assert(mid.list.length > 0 && mid.index === 1 && mid.done === 1, '中途状态保留（list/index/done）')
  // 重新挂载：loaded 已 true 且 list 非空 → 不重建序列（对应 ReviewPage useEffect 守卫）
  await useReview.getState().load()
  assert(useReview.getState().loaded === true && useReview.getState().list.length === mid.list.length, '重挂载不重建序列')
  // 已答知识点学习状态已持久化（已完成部分计入进度）
  ls = await dbLearning.get(first.kpId)
  assert(ls?.interval_days === 3, '中途退出已答部分已持久化')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
