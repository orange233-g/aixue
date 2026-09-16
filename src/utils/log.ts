/**
 * 轻量本地日志（临时调试基建）：记录模型调用、题包生成、操作、报错，持久化到 localStorage 环形缓冲，
 * 便于排查 bug 时直接翻日志定位。默认关闭控制台冲刷（避免刷屏），需要时可全局打开。
 *
 * 约定：
 * - scope 宽字符串：'model'（模型调用）｜'pack'（题包生成）｜'gen'（生成过程）｜'ui'（操作）｜'global'（未捕获错误）。
 * - 任何写失败都静默吞掉，绝不影响主流程。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  t: string
  level: LogLevel
  scope: string
  msg: string
  data?: unknown
}

const LOG_KEY = 'aixue.log.v1'
/** 环形缓冲上限：超出丢弃最旧的，防止无限膨胀（存在 localStorage，约 5MB 上限；2000 条为容量/存储平衡点） */
export const LOG_MAX = 2000
/** 单条 data 序列化长度上限，防止超长对象撑爆 storage 与日志面板 */
const DATA_CAP = 4000

/**
 * 敏感字段脱敏（W3b / V3-S03）：Key / Authorization / 密码统一替换成固定 `[REDACTED]`，**不保留任何字符**
 * （不再保留首尾各 4 位）；`msg` 与 `data` 走同一入口；除「整串即凭证」外，也扫描字符串内部内嵌的
 * `Bearer …`、`key=…`、URL 查询参数等片段。对 run.log / run-gen.log 与 localStorage 环形缓冲全链路生效。
 */
const SECRET_KEY_RE = /(authorization|api[_-]?key|secret|access[_-]?key|token|password)/i
const MODEL_KEY_RE = /^(model|modelname|model_name|mid)$/i
const REDACTED = '[REDACTED]'

/** 整串即凭证：常见 api key 形态（sk-…/k 二十位起/随机长串）或 Bearer 令牌开头 → 整体替换，不保留任何字符 */
const WHOLE_CRED_RE =
  /^(?:sk-|k[0-9a-z]{20,}|[a-zA-Z0-9_-]{20,})(?:\.[A-Za-z0-9._~\-+/=]{5,})*$|^Bearer\s+[A-Za-z0-9._~\-+/=]+$/i

/** 内嵌凭证片段扫描：只替换值的部分、保留标签便于定位。每项比配对含标签分组。 */
const INLINE_CRED_RES: RegExp[] = [
  // Authorization: Bearer xxx … / 独立 Bearer xxx …
  /(\bAuthorization\b\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~\-+/=]+/gi,
  /(\bBearer\s+)[A-Za-z0-9._~\-+/=]+/gi,
  // URL 查询参数 key=xxx&…（?|& 开头，值到 & 、空白或引号为止）
  /([?&](?:api[_-]?key|access[_-]?key|token|secret|password|key)=)[^&\s"'`]+/gi,
  // 通用「键 : 值 / 键 = 值」（authorization / api_key / access_key / secret / password / token）
  // 值到空白、引号、反引号、分号、`,` 或 `&` 为止（`&` 参与终止避免吞掉后续查询参数）；
  // 负向前瞻 (?!Bearer\s)：authorization 后跟 Bearer 时交由上面的专用 Bearer 规则掩码，避免把 Bearer 当值吞掉
  /(\b(?:authorization|api[_-]?key|access[_-]?key|secret|password|token)\s*[:=]\s*)(?!Bearer\s)[^\s,;&"'`]+/gi,
]

/** 对文本做整体/内嵌凭证掩码（msg 与字符串字段共用；整串即凭证则完全替换）；导出供测试 */
export function redactText(s: string): string {
  if (!s) return s
  const trimmed = s.trim()
  if (WHOLE_CRED_RE.test(trimmed)) return REDACTED
  let out = s
  for (const re of INLINE_CRED_RES) out = out.replace(re, (_whole, label: string) => label + REDACTED)
  return out
}

function redactValue(value: unknown, depth: number): unknown {
  // V4-S02：深度超过上限时绝不能原样返回，否则七层以上嵌套的 apiKey/authorization/token 会绕过硬掩码。
  // 统一替换为占位符截断，杜绝深层对象/数组整个透传（字符串也一并截断，防内嵌凭证漏出）。
  if (depth > 6) return '[TRUNCATED]'
  if (typeof value === 'string') return redactText(value)
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = typeof v === 'string' && v ? REDACTED : v
    } else if (MODEL_KEY_RE.test(k) && typeof v === 'string' && v) {
      out[k] = redactModel(v)
    } else {
      out[k] = redactValue(v, depth + 1)
    }
  }
  return out
}
function redactModel(name: string): string {
  try {
    const b = new TextEncoder().encode(name)
    let h = 0
    for (const byte of b) h = (h * 31 + byte) >>> 0
    return `${name.slice(0, 2)}_${h.toString(36).slice(0, 4)}`
  } catch {
    return name.slice(0, 2) + '***'
  }
}
/** 入口：对任意日志载荷做结构脱敏（字符串按整体/内嵌凭证扫描，对象按字段名递归）；导出供测试 */
export function redactSensitive(data: unknown): unknown {
  return redactValue(data, 0)
}

/** 是否把日志实时打到 DevTools 控制台（默认关，避免刷屏；排查时可手动置 true） */
let verbose = false
export function setLogVerbose(v: boolean): void {
  verbose = v
}

function read(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function write(entries: LogEntry[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries))
  } catch {
    /* storage 满 / 隐私模式等，忽略 */
  }
}

let seq = Date.now()

/** 开发期自动落盘：把日志同步到 Vite 中间件 /__log（写进项目 run.log），后台可直接读文件排查。
 *  仅 import.meta.env.DEV 生效；生产(打包 WebView)静默跳过，靠 localStorage + 一键导出兜底。
 *  带 60ms 去抖 + 批量合并，避免每条都发一个请求。 */
let sinkQueue: unknown[] = []
let sinkTimer: ReturnType<typeof setTimeout> | null = null
function syncToSink(entry: LogEntry): void {
  if (import.meta.env.DEV !== true) return
  sinkQueue.push(entry)
  if (sinkTimer) return
  sinkTimer = setTimeout(() => {
    sinkTimer = null
    const batch = sinkQueue
    sinkQueue = []
    try {
      fetch('/__log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      }).catch(() => { /* dev server 未起/已关等：忽略，本地存储兜底 */ })
    } catch { /* 忽略 */ }
  }, 60)
}

/* ---- V2-P06：localStorage 批量写入，避免长生题/多批错误时每条 get/parse/set 同步卡住 UI ---- */

/** 待刷盘缓存：log() 只改内存，定时一次性合并写 local，最多 2000 条留尾部 */
let pendingLogs: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
function flushLocal(): void {
  flushTimer = null
  if (pendingLogs.length === 0) return
  const merged = [...read(), ...pendingLogs]
  pendingLogs = []
  write(merged.length > LOG_MAX ? merged.slice(merged.length - LOG_MAX) : merged)
}
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushLocal, 500)
}

/** 追加一条日志 */
export function log(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  try {
    const safe = redactSensitive(data)
    // V3-S03：msg 与 data 走同一脱敏入口，避免错误消息里嵌凭证明文（如 Authorization/URL 参数）
    const safeMsg = redactText(msg)
    const entry: LogEntry = { id: ++seq, t: new Date().toISOString(), level, scope, msg: safeMsg, data: safe }
    pendingLogs.push(entry)
    scheduleFlush()
    syncToSink(entry)
    if (verbose) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
      // V2-P06 / V3-S03：控制台打印已脱敏的 data/safe 与 safeMsg，避免原始数据残留敏感内容
      fn(`[${scope}] ${level} ${safeMsg}`, safe ?? '')
    }
  } catch {
    /* 日志自身绝不抛错 */
  }
}

/** 读取全部日志（最新的在最前）。先冲刷内存缓存再读，保证读到的就是最新（读取是低频操作） */
export function getLogs(): LogEntry[] {
  try {
    const rest = pendingLogs
    pendingLogs = []
    const merged = [...read(), ...rest]
    write(merged.length > LOG_MAX ? merged.slice(merged.length - LOG_MAX) : merged)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    return merged.reverse()
  } catch {
    return []
  }
}

/** 导出为可复制/可直接贴给排查的 JSON 文本 */
export function exportLogs(): string {
  try {
    const rest = pendingLogs
    pendingLogs = []
    const merged = [...read(), ...rest]
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    return JSON.stringify(merged, null, 2)
  } catch {
    return ''
  }
}

/** 清空日志（含未刷盘缓存） */
export function clearLogs(): void {
  try {
    pendingLogs = []
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    localStorage.removeItem(LOG_KEY)
  } catch {
    /* ignore */
  }
}

/** 截断便于入库/日志面板展示的 data 序列化 */
function safeData(data: unknown): string {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data)
    return s && s.length > DATA_CAP ? s.slice(0, DATA_CAP) + '…(截断)' : s
  } catch {
    return String(data)
  }
}

/** 供日志面板复述单条 data（无需入 store，直接求值） */
export function formatData(data: unknown): string {
  return safeData(data)
}

/**
 * 生题原文记录：把「每次生题的模型输出原文 + 结构/拒绝/缺口」同步到 Vite 中间件 /__genlog
 * （写进独立项目文件 run-gen.log，JSONL），便于后台直接读模型原文分析质量问题（如判断题漏选项）。
 * 注意：原文可能很大，**只走文件、不写 localStorage**（避免撑爆存储/面板）；日志面板里那条
 * 紧凑汇总由调用方另行 `log('info','gen',…)` 补齐。仅 DEV 生效；带 300ms 去抖 + 批量合并。
 */
let genQueue: Record<string, unknown>[] = []
let genTimer: ReturnType<typeof setTimeout> | null = null
export function logGenOutput(record: Record<string, unknown>): void {
  try {
    if (import.meta.env.DEV !== true) return
    genQueue.push(redactSensitive(record) as Record<string, unknown>)
    if (genTimer) return
    genTimer = setTimeout(() => {
      genTimer = null
      const batch = genQueue
      genQueue = []
      if (!batch.length) return
      fetch('/__genlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      }).catch(() => { /* dev server 未起/已关：忽略 */ })
    }, 300)
  } catch {
    /* 日志自身绝不抛错 */
  }
}