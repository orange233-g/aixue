import {
  addDaysStr,
  todayStr,
  masteryState,
  nextInterval,
  REVIEW_INTERVALS,
  MASTER_STREAK,
  RECENT_WINDOW,
} from '../src/services/learning'

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

// ---- 日期工具 ----
console.log('日期工具')
const now = new Date()
const p = (n: number) => String(n).padStart(2, '0')
const localToday = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
assert(todayStr() === localToday, 'todayStr 返回本地 YYYY-MM-DD')
assert(addDaysStr('2026-08-15', 1) === '2026-08-16', 'addDays +1')
assert(addDaysStr('2026-08-31', 1) === '2026-09-01', 'addDays 跨月')
assert(addDaysStr('2026-12-31', 1) === '2027-01-01', 'addDays 跨年')
assert(addDaysStr('2026-08-15', 30) === '2026-09-14', 'addDays +30')

// ---- 掌握度档位 ----
console.log('掌握度档位')
assert(masteryState(0, false) === '未学习', '未答题 → 未学习')
assert(masteryState(0.5, true) === '学习中', '50% → 学习中')
assert(masteryState(0.6, true) === '基本掌握', '60% → 基本掌握')
assert(masteryState(0.79, true) === '基本掌握', '79% → 基本掌握')
assert(masteryState(0.8, true) === '已掌握', '80% → 已掌握')
assert(masteryState(1, true) === '已掌握', '100% → 已掌握')

// ---- 间隔重复 ----
console.log('间隔重复')
assert(nextInterval(0, true) === 1, '首次答对 → 1 天')
assert(nextInterval(1, true) === 3, '1 → 3')
assert(nextInterval(3, true) === 7, '3 → 7')
assert(nextInterval(7, true) === 15, '7 → 15')
assert(nextInterval(15, true) === 30, '15 → 30')
assert(nextInterval(30, true) === 30, '30 封顶')
assert(nextInterval(30, false) === 1, '答错重置为 1')
assert(nextInterval(7, false) === 1, '答错重置为 1（任意间隔）')
assert(REVIEW_INTERVALS.length === 5, '间隔序列 5 档')
assert(MASTER_STREAK === 2, '错题连续答对阈值 2')
assert(RECENT_WINDOW === 10, '掌握度窗口 10')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
