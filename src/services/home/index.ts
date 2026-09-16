import type { Pack } from '../../types'
import { dbAnswers, dbLearning, dbPacks } from '../../db'
import { windowRange } from '../usage'

/**
 * 首页统计服务（见 PRD 4.2）：
 * 当日已刷题数、最近学习题包（继续学习）、最近题包列表。
 * 数据来源为 answers 作答记录（useQuizStore / useReviewStore 写入）。
 */

/** 今日 0 点时间戳 */
export function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 当日已刷题数：今日 0 点至现在的作答次数（复习卡片副标题） */
export async function todayAnswerCount(): Promise<number> {
  const records = await dbAnswers.getByRange(startOfToday(), Date.now())
  return records.length
}

/** 最近一次有作答记录的题包（继续学习卡片） */
export async function recentLearningPack(): Promise<{ pack: Pack; lastAt: number } | null> {
  const records = await dbAnswers.getAll()
  if (records.length === 0) return null
  const sorted = records.sort((a, b) => b.timestamp - a.timestamp)
  const packs = await dbPacks.getAll()
  for (const r of sorted) {
    const pack = packs.find((p) => p.id === r.packId)
    if (pack) return { pack, lastAt: r.timestamp }
  }
  return null
}

/** 本周学习统计（见 PRD 4.2 本周学习卡片）：本周已刷题数 / 连续学习天数 / 已掌握知识点数 */
export async function weekStats(now = Date.now()): Promise<{ answered: number; streak: number; mastered: number }> {
  const { from } = windowRange('week', now)
  const records = await dbAnswers.getAll()
  const weekAnswered = records.filter((r) => r.timestamp >= from).length

  // 连续学习天数：从今天（或昨天）起向前数，有作答记录的天连续计
  const daysWithAnswers = new Set(records.map((r) => dayKey(r.timestamp)))
  const today = new Date(now)
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let streak = 0
  while (daysWithAnswers.has(dayKey(cursor.getTime()))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  const states = await dbLearning.getAll()
  const mastered = states.filter((s) => s.state === '已掌握').length

  return { answered: weekAnswered, streak, mastered }
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** 最近题包列表：按最近学习时间倒序，最多 limit 个 */
export async function recentPacks(limit = 3): Promise<{ pack: Pack; lastAt: number }[]> {
  const records = await dbAnswers.getAll()
  const packs = await dbPacks.getAll()
  const lastByPack = new Map<string, number>()
  for (const r of records) {
    const prev = lastByPack.get(r.packId)
    if (prev === undefined || r.timestamp > prev) lastByPack.set(r.packId, r.timestamp)
  }
  return [...lastByPack.entries()]
    .map(([packId, lastAt]) => ({ pack: packs.find((p) => p.id === packId), lastAt }))
    .filter((x): x is { pack: Pack; lastAt: number } => Boolean(x.pack))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
}

/** 问候语（按时段） */
export function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了，注意休息'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 今天日期文案，如「8月15日 星期六」 */
export function todayText(): string {
  const d = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`
}
