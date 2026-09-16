import 'fake-indexeddb/auto'
import { resetDB, clearAllStores, dbWrongs, dbLearning } from '../src/db'
import { useQuiz } from '../src/stores/useQuizStore'
import { useLearning } from '../src/stores/useLearningStore'
import { MASTER_STREAK } from '../src/services/learning'
import type { Pack, Question, WrongRecord } from '../src/types'

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
  chapters: [{ id: 'ca', title: '章A', summary: '', knowledge_points: [{ id: 'ka1', title: '点A1', content: '', examples: [], pitfalls: [] }, { id: 'ka2', title: '点A2', content: '', examples: [], pitfalls: [] }], question_ids: ['qa1', 'qa2'] }],
  questions: [mkQ('qa1', 'ka1'), mkQ('qa2', 'ka2')], created_at: Date.now(),
}
const packB: Pack = {
  id: 'pb', title: '题包B', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] },
  chapters: [{ id: 'cb', title: '章B', summary: '', knowledge_points: [{ id: 'kb1', title: '点B1', content: '', examples: [], pitfalls: [] }], question_ids: ['qb1'] }],
  questions: [mkQ('qb1', 'kb1')], created_at: Date.now(),
}

function wrongRec(questionId: string, packId: string, packTitle: string, wrongCount = 1, correctStreak = 0): WrongRecord {
  const q = [packA, packB].flatMap((p) => p.questions).find((x) => x.id === questionId)!
  return { questionId, packId, packTitle, question: q, wrongCount, correctStreak, mastered: false, lastWrongAt: Date.now(), createdAt: Date.now() }
}

function resetStores() {
  mem.clear()
  useQuiz.setState({ session: null, packs: [] })
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
  console.log('—— start 新建刷题会话 ——')
  await fresh()
  useQuiz.getState().start(packA, 'seq')
  let s = useQuiz.getState().session!
  assert(s.mode === 'seq' && s.packId === 'pa' && s.packTitle === '题包A', '会话初始化正确')
  assert(s.questionIds.length === 2 && s.questionIds[0] === 'qa1', '顺序模式取全部题目')
  assert(s.index === 0 && s.correct === 0, '初始进度为 0')

  console.log('—— start 中途退出续刷 ——')
  useQuiz.getState().answer(packA.questions[0], '[0]')
  useQuiz.getState().next()
  assert(useQuiz.getState().session!.index === 1, '答完一题后 index=1')
  useQuiz.getState().start(packA, 'seq')
  s = useQuiz.getState().session!
  assert(s.index === 1, '同包同模式未完成恢复进度')
  useQuiz.getState().finish()

  console.log('—— startWrong 错题重练（跨题包） ——')
  await fresh()
  const wa1 = wrongRec('qa1', 'pa', '题包A')
  const wb1 = wrongRec('qb1', 'pb', '题包B', 2)
  await dbWrongs.put(wa1)
  await dbWrongs.put(wb1)
  useQuiz.getState().startWrong([wa1, wb1], [packA, packB])
  s = useQuiz.getState().session!
  assert(s.mode === 'wrong' && s.packTitle === '错题重练', '错题重练会话标记 wrong 模式')
  assert(s.questionIds.length === 2 && s.questionIds.includes('qa1') && s.questionIds.includes('qb1'), '跨题包抽取错题')

  console.log('—— startWrong 中途退出续刷 ——')
  useQuiz.getState().answer(packA.questions[0], '[0]')
  useQuiz.getState().next()
  assert(useQuiz.getState().session!.index === 1, '重练答完一题后 index=1')
  useQuiz.getState().startWrong([wa1, wb1], [packA, packB])
  assert(useQuiz.getState().session!.index === 1, '错题重练未完成恢复进度')
  useQuiz.getState().finish()

  console.log('—— answer 答对 / 答错 ——')
  await fresh()
  useQuiz.getState().start(packA, 'seq')
  const r1 = useQuiz.getState().answer(packA.questions[0], '[0]')
  assert(r1.correct === true, '答对判分正确')
  s = useQuiz.getState().session!
  assert(s.correct === 1 && s.results['qa1'] === true, '答对记录 correct+1')
  const r2 = useQuiz.getState().answer(packA.questions[1], '[1]')
  assert(r2.correct === false, '答错判分正确')
  s = useQuiz.getState().session!
  assert(s.correct === 1 && s.results['qa2'] === false, '答错不增加 correct')
  await flush()
  const wrong = await dbWrongs.get('qa2')
  assert(!!wrong && wrong.wrongCount === 1, '答错自动进错题本')
  const ls = await dbLearning.get('ka2')
  assert(ls?.interval_days === 1, '答错知识点进复习队列（间隔 1）')
  useQuiz.getState().finish()

  console.log('—— 错题重练答对：连续答对标记掌握 ——')
  await fresh()
  const w1 = wrongRec('qa1', 'pa', '题包A')
  await dbWrongs.put(w1)
  useQuiz.getState().startWrong([w1], [packA])
  useQuiz.getState().answer(packA.questions[0], '[0]')
  await flush()
  let rec = await dbWrongs.get('qa1')
  assert(rec?.correctStreak === 1 && rec?.mastered === false, `第 1 次答对连续 1 次未标记`)
  useQuiz.getState().answer(packA.questions[0], '[0]')
  await flush()
  rec = await dbWrongs.get('qa1')
  assert(rec?.mastered === true, `连续答对 ${MASTER_STREAK} 次标记已掌握`)
  const lsAfter = await dbLearning.get('ka1')
  assert(!lsAfter, '标记掌握后从复习队列移除')
  useQuiz.getState().finish()

  console.log('—— next 完成清理 / finish / exit ——')
  await fresh()
  useQuiz.getState().start(packA, 'seq')
  useQuiz.getState().answer(packA.questions[0], '[0]')
  let done = useQuiz.getState().next()
  assert(done === false && useQuiz.getState().session!.index === 1, '未完成 next 返回 false')
  useQuiz.getState().answer(packA.questions[1], '[0]')
  done = useQuiz.getState().next()
  assert(done === true, '最后一题 next 返回 true')
  assert(useQuiz.getState().session!.index === 2, 'index 到末尾')
  assert(!mem.has('ai-xue-quiz-session'), '完成后会话从 localStorage 清理')
  useQuiz.getState().exit()
  assert(useQuiz.getState().session !== null, 'exit 保留会话进度')
  useQuiz.getState().finish()
  assert(useQuiz.getState().session === null && useQuiz.getState().packs.length === 0, 'finish 清空会话')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
