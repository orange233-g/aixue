import 'fake-indexeddb/auto'
import { dbLearning, dbWrongs, resetDB } from '../src/db'
import {
  recordAnswer,
  recordWrong,
  recordWrongCorrect,
  markWrongMastered,
  packMastery,
  todayStr,
  addDaysStr,
  MASTER_STREAK,
} from '../src/services/learning'
import type { Pack, Question } from '../src/types'

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

const q1: Question = {
  id: 'q1',
  type: 'single',
  stem: 'Python 中用于定义函数的关键字是？',
  options: ['def', 'function', 'func', 'define'],
  answer: '[0]',
  explanation: 'def',
  kp_ids: ['kp1'],
  difficulty: 1,
}
const q2: Question = {
  id: 'q2',
  type: 'judge',
  stem: 'Python 变量使用前必须声明类型',
  options: ['正确', '错误'],
  answer: 'false',
  explanation: '动态类型',
  kp_ids: ['kp1'],
  difficulty: 1,
}
const pack: Pack = {
  id: 'pack1',
  title: 'Python 基础入门',
  category: '编程',
  source: 'ai',
  meta: { difficulty: '入门', objectives: ['变量'] },
  chapters: [
    {
      id: 'ch1',
      title: '变量与类型',
      summary: '',
      knowledge_points: [{ id: 'kp1', title: '变量与赋值', content: '', examples: [], pitfalls: [] }],
      question_ids: ['q1', 'q2'],
    },
  ],
  questions: [q1, q2],
  created_at: Date.now(),
}

async function run() {
  resetDB()

  console.log('—— 答错收录错题本 + 复习队列 ——')
  await recordAnswer(pack, q1, false)
  let wrong = await dbWrongs.get('q1')
  assert(!!wrong, '答错后错题记录存在')
  assert(wrong?.wrongCount === 1, '答错次数 = 1')
  assert(wrong?.mastered === false, '未掌握')
  assert(wrong?.packTitle === 'Python 基础入门', '记录题包标题')
  let ls = await dbLearning.get('kp1')
  assert(!!ls, '知识点学习状态存在')
  assert(ls?.interval_days === 1, '答错间隔重置为 1')
  assert(ls?.next_review === addDaysStr(todayStr(), 1), '答错明天复习')
  assert(ls?.wrong_count === 1, '累计答错 1')
  assert(ls?.last_result === 'wrong', 'last_result = wrong')
  assert(ls?.mastery === 0, '答错掌握度 0')
  assert(ls?.state === '学习中', '掌握度 0 → 学习中')

  console.log('—— 再次答错：次数累加、连续答对清零 ——')
  await recordAnswer(pack, q1, false)
  wrong = await dbWrongs.get('q1')
  assert(wrong?.wrongCount === 2, '答错次数累加为 2')
  assert(wrong?.correctStreak === 0, '连续答对清零')

  console.log('—— 答对：掌握度上升，普通刷题不安排复习 ——')
  await recordAnswer(pack, q1, true, { schedule: false })
  ls = await dbLearning.get('kp1')
  assert(ls?.mastery === 1 / 3, '答对后掌握度 1/3')
  assert(ls?.interval_days === 1, '普通刷题答对不改变间隔')
  assert(ls?.last_result === 'correct', 'last_result = correct')
  wrong = await dbWrongs.get('q1')
  assert(wrong?.wrongCount === 2, '答对不改变答错次数')

  console.log('—— 复习模式答对：间隔翻倍 ——')
  await recordAnswer(pack, q1, true, { schedule: true })
  ls = await dbLearning.get('kp1')
  assert(ls?.interval_days === 3, '复习答对间隔 1→3')
  assert(ls?.next_review === addDaysStr(todayStr(), 3), '下次 3 天后复习')
  assert(ls?.mastery === 2 / 4, '掌握度 2/4')

  console.log('—— 复习答错：间隔重置、题目进错题本 ——')
  await recordAnswer(pack, q2, false, { schedule: true })
  ls = await dbLearning.get('kp1')
  assert(ls?.interval_days === 1, '复习答错间隔重置 1')
  assert(ls?.next_review === addDaysStr(todayStr(), 1), '明天复习')
  wrong = await dbWrongs.get('q2')
  assert(!!wrong && wrong.wrongCount === 1, 'q2 答错进错题本')

  console.log('—— 错题重练：连续答对计数与标记已掌握 ——')
  await recordWrongCorrect('q2')
  wrong = await dbWrongs.get('q2')
  assert(wrong?.correctStreak === 1, '第一次答对连续 1 次')
  assert(wrong?.mastered === false, '未达阈值不标记')
  await recordWrongCorrect('q2')
  wrong = await dbWrongs.get('q2')
  assert(wrong?.mastered === true, `连续答对 ${MASTER_STREAK} 次标记已掌握`)
  const lsAfterMaster = await dbLearning.get('kp1')
  assert(!lsAfterMaster, '标记已掌握后从复习队列移除（学习状态删除）')

  console.log('—— 手动标记已掌握 ——')
  await recordAnswer(pack, q1, false)
  await markWrongMastered((await dbWrongs.get('q1'))!)
  wrong = await dbWrongs.get('q1')
  assert(wrong?.mastered === true, '手动标记已掌握')
  assert(!(await dbLearning.get('kp1')), '复习队列移除')

  console.log('—— 题包掌握度 ——')
  await recordAnswer(pack, q1, true, { schedule: false })
  await recordAnswer(pack, q2, true, { schedule: false })
  const states = await dbLearning.getAll()
  assert(packMastery(pack, states) === 100, '两题全对 → 掌握度 100%')
  await recordAnswer(pack, q1, false, { schedule: false })
  const states2 = await dbLearning.getAll()
  assert(packMastery(pack, states2) === 67, '窗口 [对,对,错] → 掌握度 67%')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
