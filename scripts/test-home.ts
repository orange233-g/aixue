import 'fake-indexeddb/auto'
import { resetDB, clearAllStores, dbAnswers, dbPacks, dbLearning, dbWrongs } from '../src/db'
import { useQuiz } from '../src/stores/useQuizStore'
import { useReview } from '../src/stores/useReviewStore'
import { useLearning } from '../src/stores/useLearningStore'
import { todayStr, addDaysStr } from '../src/services/learning'
import { todayAnswerCount, recentLearningPack, recentPacks, startOfToday, greeting, todayText } from '../src/services/home'
import type { Pack, Question, LearningState } from '../src/types'

// mock localStorage（useQuizStore 用 localStorage 持久化会话）
const mem = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
} as Storage

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

function mkQ(id: string, kpId: string): Question {
  return { id, type: 'single', stem: `${id} 题干`, options: ['A', 'B', 'C', 'D'], answer: '[0]', explanation: '解析', kp_ids: [kpId], difficulty: 1 }
}

const packA: Pack = {
  id: 'pa', title: '题包A', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] },
  chapters: [{ id: 'ca', title: '章A', summary: '', knowledge_points: [{ id: 'ka1', title: '点A1', content: '', examples: [], pitfalls: [] }], question_ids: ['qa1'] }],
  questions: [mkQ('qa1', 'ka1')], created_at: Date.now(),
}
const packB: Pack = {
  id: 'pb', title: '题包B', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] },
  chapters: [{ id: 'cb', title: '章B', summary: '', knowledge_points: [{ id: 'kb1', title: '点B1', content: '', examples: [], pitfalls: [] }], question_ids: ['qb1'] }],
  questions: [mkQ('qb1', 'kb1')], created_at: Date.now(),
}
const packC: Pack = {
  id: 'pc', title: '题包C', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] },
  chapters: [{ id: 'cc', title: '章C', summary: '', knowledge_points: [{ id: 'kc1', title: '点C1', content: '', examples: [], pitfalls: [] }], question_ids: ['qc1'] }],
  questions: [mkQ('qc1', 'kc1')], created_at: Date.now(),
}

function resetStores() {
  mem.clear()
  useQuiz.setState({ session: null, packs: [] })
  useReview.setState({ dueCount: 0, list: [], index: 0, done: 0, lastFeedback: null, loaded: false })
  useLearning.setState({ states: [], wrongs: [], loaded: false })
}

async function fresh() {
  resetDB()
  await clearAllStores()
  resetStores()
}

/** 等待 answer() 内部异步学习数据更新完成 */
async function flush() {
  await new Promise((r) => setTimeout(r, 20))
}

async function run() {
  console.log('—— 今日已刷题数（空） ——')
  await fresh()
  assert((await todayAnswerCount()) === 0, '无作答记录时今日已刷题数 = 0')

  console.log('—— 作答记录写入（刷题模式） ——')
  await fresh()
  await dbPacks.put(packA)
  useQuiz.getState().start(packA, 'seq')
  useQuiz.getState().answer(packA.questions[0], '[0]')
  await flush()
  let records = await dbAnswers.getAll()
  assert(records.length === 1, '刷题作答写入 1 条作答记录')
  assert(records[0].mode === 'quiz' && records[0].packId === 'pa' && records[0].questionId === 'qa1', '记录 mode=quiz / packId / questionId 正确')
  assert(records[0].correct === true, '记录判分结果正确')
  assert((await todayAnswerCount()) === 1, '今日已刷题数 = 1')

  console.log('—— 作答记录写入（错题重练模式） ——')
  await fresh()
  await dbPacks.put(packA)
  await dbWrongs.put({
    questionId: 'qa1', packId: 'pa', packTitle: '题包A', question: packA.questions[0],
    wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: Date.now(), createdAt: Date.now(),
  })
  useQuiz.getState().startWrong([{ questionId: 'qa1', packId: 'pa', packTitle: '题包A', question: packA.questions[0], wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: Date.now(), createdAt: Date.now() }], [packA])
  useQuiz.getState().answer(packA.questions[0], '[0]')
  await flush()
  records = await dbAnswers.getAll()
  assert(records.length === 1 && records[0].mode === 'wrong', '错题重练记录 mode=wrong')

  console.log('—— 作答记录写入（复习模式） ——')
  await fresh()
  await dbPacks.put(packA)
  await dbLearning.put({
    kp_id: 'ka1', mastery: 0.5, state: '学习中', interval_days: 1, next_review: todayStr(),
    wrong_count: 0, last_result: 'correct', recent: [true],
  } as LearningState)
  await useReview.getState().load()
  await useReview.getState().start()
  assert(useReview.getState().list.length === 1, '复习序列构建 1 项')
  await useReview.getState().answer(useReview.getState().list[0], true)
  records = await dbAnswers.getAll()
  assert(records.length === 1 && records[0].mode === 'review', '复习作答记录 mode=review')
  assert(records[0].packId === 'pa' && records[0].correct === true, '复习记录 packId / 判分正确')

  console.log('—— 今日统计只计当日 ——')
  await fresh()
  const yesterday = startOfToday() - 24 * 3600 * 1000
  await dbAnswers.add({ packId: 'pa', questionId: 'qa1', correct: true, mode: 'quiz', timestamp: yesterday })
  await dbAnswers.add({ packId: 'pa', questionId: 'qa1', correct: true, mode: 'quiz', timestamp: Date.now() })
  assert((await todayAnswerCount()) === 1, '昨日记录不计入今日已刷题数')

  console.log('—— 最近题包（空） ——')
  await fresh()
  assert((await recentLearningPack()) === null, '无作答记录时继续学习 = null')
  assert((await recentPacks()).length === 0, '无作答记录时最近题包为空')

  console.log('—— 最近题包按最近学习时间倒序 ——')
  await fresh()
  await dbPacks.put(packA)
  await dbPacks.put(packB)
  await dbPacks.put(packC)
  const t0 = Date.now()
  await dbAnswers.add({ packId: 'pa', questionId: 'qa1', correct: true, mode: 'quiz', timestamp: t0 })
  await dbAnswers.add({ packId: 'pb', questionId: 'qb1', correct: true, mode: 'quiz', timestamp: t0 + 1000 })
  await dbAnswers.add({ packId: 'pc', questionId: 'qc1', correct: true, mode: 'quiz', timestamp: t0 + 2000 })
  await dbAnswers.add({ packId: 'pa', questionId: 'qa1', correct: true, mode: 'quiz', timestamp: t0 + 3000 })
  let rp = await recentPacks()
  assert(rp.length === 3, '最近题包最多 3 个')
  assert(rp[0].pack.id === 'pa' && rp[1].pack.id === 'pc' && rp[2].pack.id === 'pb', '按最近学习时间倒序（pa 最新）')
  const cl = await recentLearningPack()
  assert(cl?.pack.id === 'pa', '继续学习取最近作答的题包')

  console.log('—— 最近题包截断与缺失题包 ——')
  await fresh()
  await dbPacks.put(packA)
  await dbPacks.put(packB)
  await dbAnswers.add({ packId: 'pa', questionId: 'qa1', correct: true, mode: 'quiz', timestamp: t0 })
  await dbAnswers.add({ packId: 'pb', questionId: 'qb1', correct: true, mode: 'quiz', timestamp: t0 + 1000 })
  await dbAnswers.add({ packId: 'deleted', questionId: 'qx', correct: true, mode: 'quiz', timestamp: t0 + 2000 })
  rp = await recentPacks()
  assert(rp.length === 2, '已删除题包的作答记录被过滤')
  assert(rp[0].pack.id === 'pb', '倒序排列正确')

  console.log('—— 问候语 / 日期 ——')
  assert(typeof greeting() === 'string' && greeting().length > 0, '问候语非空')
  assert(/月\d+日 星期[一二三四五六日]/.test(todayText()), '日期文案格式正确')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
