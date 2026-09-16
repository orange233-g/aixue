/**
 * 内容安全策略（W3d）：敏感词 / 违规内容拦截做成「默认基线 + 用户可配词」的通用机制，不写死。
 * - 默认基线：控制字符 / 乱码（这些永远该拦，无论用户配了没有）。
 * - 用户可配：额外敏感词（localStorage 持久化，设置页提供编辑入口），与基线叠加。
 * 生成的题目 / 聊天内容在入库前经 validateSafety 调用本模块裁决，命中的题块被剔除。
 */

const POLICY_KEY = 'aixue.blockedwords.v1'

/** 默认不可变基线：控制字符、乱码（不带 g，避免 test() 的 lastIndex 状态残留） */
const BASE_UNSAFE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|\uFFFD{2,}/

/** 用户在设置页配置的额外敏感词（每行一个；/reg/ 前缀表示把它当正则字面量处理） */
export interface BlockPolicy {
  words: string[]
}

const DEFAULT_POLICY: BlockPolicy = { words: [] }

export function readBlockPolicy(): BlockPolicy {
  try {
    const raw = localStorage.getItem(POLICY_KEY)
    if (!raw) return DEFAULT_POLICY
    const parsed = JSON.parse(raw) as BlockPolicy
    const words = Array.isArray(parsed?.words) ? parsed.words.filter((w) => typeof w === 'string' && w.trim()) : []
    return { words }
  } catch {
    return DEFAULT_POLICY
  }
}

export function writeBlockPolicy(p: BlockPolicy): void {
  try {
    localStorage.setItem(POLICY_KEY, JSON.stringify({ words: (p?.words ?? []).filter((w) => typeof w === 'string' && w.trim()) }))
  } catch {
    /* storage 不可用则忽略 */
  }
}

/** 在 text 命中默认基线或用（默认+用户可配）词时返回 true */
export function containsSensitive(text: string): boolean {
  if (!text) return false
  if (BASE_UNSAFE_RE.test(text)) return true
  const { words } = readBlockPolicy()
  if (!words.length) return false
  for (const raw of words) {
    const w = raw.trim()
    if (!w) continue
    if (w.startsWith('/') && w.endsWith('/')) {
      try {
        const re = new RegExp(w.slice(1, -1), 'i')
        if (re.test(text)) return true
      } catch {
        /* 非法正则按普通词处理 */
      }
    } else if (text.includes(w)) {
      return true
    }
  }
  return false
}