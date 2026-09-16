import type { AnswerRecord, LearningState, Pack, Question, WrongRecord } from '../../types'
import { dbLearning, dbWrongs, withQuizSubmissionTransaction, wrongKey } from '../../db'

/**
 * 学习数据服务（见 PRD 4.5 / 4.8 / 6.4）：
 * 掌握度计算、间隔重复复习队列、错题本收录与标记已掌握。
 */

/** 错题连续答对阈值：达到后标记已掌握，移出错题本并退出复习队列 */
export const MASTER_STREAK = 2
/** 复习间隔序列：答对翻倍，答错重置为 1 天 */
export const REVIEW_INTERVALS = [1, 3, 7, 15, 30]
/** 掌握度滚动窗口：取最近 N 次作答计算正确率 */
export const RECENT_WINDOW = 10
/** 每日复习上限（见 PRD 4.6 偏好设置，默认 20） */
export const DAILY_REVIEW_LIMIT = 20
/** 刷题幂等标记 `quiz_submission:*` 数量上限，超出删除最旧记录（V4-F03 收敛） */
export const MAX_SUBMISSION_MARKS = 500

/** 今天日期 YYYY-MM-DD */
export function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 日期 + N 天（YYYY-MM-DD） */
export function addDaysStr(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

/** 掌握度档位（见 PRD 6.4）：未学习 → 学习中(<60%) → 基本掌握(60-80%) → 已掌握(≥80%) */
export function masteryState(mastery: number, answered: boolean): LearningState['state'] {
  if (!answered) return '未学习'
  if (mastery < 0.6) return '学习中'
  if (mastery < 0.8) return '基本掌握'
  return '已掌握'
}

/** 复习间隔：答对翻倍（1→3→7→15→30 封顶），答错重置为 1 */
export function nextInterval(current: number, correct: boolean): number {
  if (!correct) return 1
  const idx = REVIEW_INTERVALS.indexOf(current)
  if (idx === -1) return 1
  return REVIEW_INTERVALS[Math.min(idx + 1, REVIEW_INTERVALS.length - 1)]
}

function emptyLearning(kpId: string): LearningState {
  return {
    kp_id: kpId,
    mastery: 0,
    state: '未学习',
    interval_days: 0,
    next_review: todayStr(),
    wrong_count: 0,
    last_result: 'correct',
    recent: [],
  }
}

/** 纯函数：把一批作答结果并入旧学习状态，返回新状态（单事务与常规路径共用同一套算法） */
function mergeLearningOutcomes(
  prev: LearningState,
  outcomes: boolean[],
  schedule: boolean,
  today: string,
): LearningState {
  const recent = [...(prev.recent ?? []), ...outcomes].slice(-RECENT_WINDOW)
  const answered = recent.length > 0
  const mastery = answered ? recent.filter(Boolean).length / recent.length : 0
  const lastResult = outcomes[outcomes.length - 1]
  const wrongDelta = outcomes.filter((c) => !c).length
  // BUG-3 修复：schedule=false（刷题/错题重练）答对时保留既有间隔，但下限 1 天——
  // 此前 prev.interval_days=0（初建态）会写出 next_review=今天+0=今天，知识点当天永久到期、
  // 复习角标怎么刷都不消失（同症状确定性根源）
  const interval =
    lastResult && schedule
      ? nextInterval(prev.interval_days, true)
      : lastResult
        ? Math.max(prev.interval_days, 1)
        : 1
  return {
    ...prev,
    mastery,
    state: masteryState(mastery, answered),
    interval_days: interval,
    next_review: lastResult ? addDaysStr(today, interval) : addDaysStr(today, 1),
    wrong_count: prev.wrong_count + wrongDelta,
    last_result: lastResult ? 'correct' : 'wrong',
    recent,
  }
}

/** 刷题统一提交的落库输入（已判分结果） */
export interface QuizSubmissionInput {
  /** 每道已作答（非空答）题目的判分结果 */
  learned: { pack: Pack; question: Question; correct: boolean }[]
  /** 错题重练模式下答对的题号（连续答对计数 / 达标标已掌握） */
  wrongCorrectIds: (string | WrongQuestionRef)[]
  schedule: boolean
  /** V4-F04：包含 review——复习作答也走同一原子事务，作答记录以 mode 区分来源 */
  mode: 'quiz' | 'wrong' | 'review'
}

export interface WrongQuestionRef {
  packId: string
  questionId: string
}

/**
 * 刷题统一提交（V2-F02 / V2-I01）：learning + wrongs + answers + 幂等标记放进**同一** IndexedDB
 * readwrite 事务，内部读旧值→算新值→写入，任一步失败整体回滚，杜绝多点写的半提交/重复累计。
 * submissionId 幂等：同一 submissionId 已完整提交过则直接跳过，防失败重试重复叠加 wrong_count /
 * 近期答题窗口 / 错题次数。
 */
export async function commitQuizSubmission(input: QuizSubmissionInput, submissionId: string): Promise<void> {
  // 无任何作答结果与错题重练计数时，无需落库（也不写幂等标记）
  if (input.learned.length === 0 && input.wrongCorrectIds.length === 0) return
  const today = todayStr()
  await withQuizSubmissionTransaction(async (tx) => {
    const cfg = tx.objectStore('config')
    const appliedKey = `quiz_submission:${submissionId}`
    if (await cfg.get(appliedKey)) return
    const learnStore = tx.objectStore('learning')
    const wrongStore = tx.objectStore('wrongs_v2')
    const answerStore = tx.objectStore('answers')

    // 1) 学习状态：按知识点聚合本轮作答，事务内读旧值→算新值→写回
    const byKp = new Map<string, boolean[]>()
    const order: string[] = []
    for (const { question, correct } of input.learned) {
      for (const kpId of question.kp_ids) {
        if (!byKp.has(kpId)) {
          byKp.set(kpId, [])
          order.push(kpId)
        }
        byKp.get(kpId)!.push(correct)
      }
    }
    for (const kpId of order) {
      const prev = (await learnStore.get(kpId)) as LearningState | undefined
      await learnStore.put(mergeLearningOutcomes(prev ?? emptyLearning(kpId), byKp.get(kpId)!, input.schedule, today))
    }

    // 2) 错题收录（答错）与错题重练答对计数（同在事务内）
    for (const { pack, question, correct } of input.learned) {
      if (!correct) {
        const key = wrongKey(pack.id, question.id)
        const existing = (await wrongStore.get(key)) as (WrongRecord & { key: string }) | undefined
        if (existing) {
          await wrongStore.put({ ...existing, wrongCount: existing.wrongCount + 1, correctStreak: 0, lastWrongAt: Date.now() })
        } else {
          await wrongStore.put({
            key,
            questionId: question.id,
            packId: pack.id,
            packTitle: pack.title,
            question,
            wrongCount: 1,
            correctStreak: 0,
            mastered: false,
            lastWrongAt: Date.now(),
            createdAt: Date.now(),
          })
        }
      }
    }
    for (const refOrId of input.wrongCorrectIds) {
      const rec = (typeof refOrId === 'string'
        ? (await wrongStore.index('questionId').get(refOrId))
        : await wrongStore.get(wrongKey(refOrId.packId, refOrId.questionId))) as (WrongRecord & { key: string }) | undefined
      if (!rec || rec.mastered) continue
      const streak = rec.correctStreak + 1
      if (streak >= MASTER_STREAK) await wrongStore.put({ ...rec, correctStreak: streak, mastered: true })
      else await wrongStore.put({ ...rec, correctStreak: streak })
    }

    // 3) 作答记录（首页统计）
    for (const { pack, question, correct } of input.learned) {
      // keyPath 自增 id 由 idb 生成，类型上需完整值，运行时省略 key 由 autoIncrement 填充
      await answerStore.add({
        packId: pack.id,
        questionId: question.id,
        correct,
        mode: input.mode,
        timestamp: Date.now(),
      } as AnswerRecord)
    }

    // 4) 幂等标记
    await cfg.put({ key: appliedKey, value: Date.now() })

    // V4-F03：幂等标记按数量收敛——submissionId 带 base36 时间戳前缀，删除最旧的一批，
    // 防止 config 表被一次性提交产生的标记无限撑大（迁移到带 timestamp 专用 store 前的最小收敛）。
    const marks = (await cfg.getAllKeys())
      .filter((k): k is string => typeof k === 'string' && k.startsWith('quiz_submission:'))
      .sort()
    if (marks.length > MAX_SUBMISSION_MARKS) {
      const excess = marks.length - MAX_SUBMISSION_MARKS
      for (let i = 0; i < excess; i++) await cfg.delete(marks[i])
    }
  })
}

/** 把一次作答结果并入所有命中知识点的学习状态（正确提升掌握度、错误降低/重置），写回 learning */
async function recordKpOutcome(kpIds: string[], correct: boolean, schedule: boolean): Promise<void> {
  const today = todayStr()
  for (const kpId of kpIds) {
    const prev = (await dbLearning.get(kpId)) ?? emptyLearning(kpId)
    await dbLearning.put(mergeLearningOutcomes(prev, [correct], schedule, today))
  }
}

/** 记录一次作答并更新学习数据。
 * - 答对：掌握度上升；复习模式（schedule=true）下间隔翻倍并安排下次复习。
 * - 答错：掌握度下降、间隔重置 1 天、明天复习、答错次数 +1，题目收录进错题本。
 */
export async function recordAnswer(
  pack: Pack,
  question: Question,
  correct: boolean,
  opts?: { schedule?: boolean },
): Promise<void> {
  await recordKpOutcome(question.kp_ids, correct, opts?.schedule ?? false)
  if (!correct) {
    await recordWrong(pack, question)
  }
}

/** 答错收录错题本：已存在则答错次数 +1 并清零连续答对 */
export async function recordWrong(pack: Pack, question: Question): Promise<void> {
  const existing = await dbWrongs.getByPackAndQuestion(pack.id, question.id)
  if (existing) {
    await dbWrongs.put({
      ...existing,
      wrongCount: existing.wrongCount + 1,
      correctStreak: 0,
      lastWrongAt: Date.now(),
    })
    return
  }
  await dbWrongs.put({
    questionId: question.id,
    packId: pack.id,
    packTitle: pack.title,
    question,
    wrongCount: 1,
    correctStreak: 0,
    mastered: false,
    lastWrongAt: Date.now(),
    createdAt: Date.now(),
  })
}

/** 错题重练答对：连续答对计数，达到阈值标记已掌握。返回是否已标记 */
export async function recordWrongCorrect(questionId: string, packId?: string): Promise<boolean> {
  const rec = packId ? await dbWrongs.getByPackAndQuestion(packId, questionId) : await dbWrongs.get(questionId)
  if (!rec || rec.mastered) return false
  const streak = rec.correctStreak + 1
  // 本次答对结果并入知识点学习状态（掌握度上升），不因为错题掌握而删除 kp（V2-F06）
  await recordKpOutcome(rec.question.kp_ids, true, false)
  if (streak >= MASTER_STREAK) {
    await markWrongMastered({ ...rec, correctStreak: streak })
    return true
  }
  await dbWrongs.put({ ...rec, correctStreak: streak })
  return false
}

/**
 * 标记错题已掌握：移出错题本（mastered=true）。
 * V2-F06：不再删除关联知识点的学习状态——同一知识点可能挂多道题，删光会连带抹掉其它题的
 * 掌握度与复习安排；知识点状态在答题路径（recordKpOutcome）里按本次结果自然更新，与数据粒度对齐。
 */
export async function markWrongMastered(record: WrongRecord): Promise<void> {
  await dbWrongs.put({ ...record, mastered: true })
}

/** 手动移出错题本（不改变复习队列） */
export async function removeWrong(questionId: string, packId?: string): Promise<void> {
  await dbWrongs.delete(questionId, packId)
}
