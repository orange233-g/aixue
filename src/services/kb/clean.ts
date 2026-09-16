/**
 * 碎行检测 + 清洗（去凝练架构工作层，见改造方案 §4.1）。
 * PDF/OCR 复制出的文本常见「每行一句、硬换行」碎行，直接渲染段落零散；
 * 清洗只动换行不动字（字数守恒，单测强校验），不做 AI 排版整理——那是轻量版凝练，同样有损。
 * 纯本地零 token。
 */
import { CODE_EXTS, fileExt } from '../files/parse'

/** 数字 → 人类可读字数（如 120000 → 12.0w 字） */
export function fmtChars(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w 字`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k 字`
  return `${n} 字`
}

/** 数字 → 人类可读行数（代码文件清单展示用，如 12345 → 1.2w 行） */
export function fmtLines(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w 行`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k 行`
  return `${n} 行`
}

/** 数字 → 人类可读词数（英文文档清单展示用，如 42000 → 4.2w 词） */
export function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w 词`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k 词`
  return `${n} 词`
}

/** 碎行检测的行长门槛：非空行平均长度低于该值才可能判碎行 */
const AVG_LINE_LEN = 42
/** 连续非空折行段的最少行数门槛 */
const MIN_FOLD_RUN = 5

/** Markdown 标题行（存在即视为规整文档，不清洗） */
const MD_HEADING = /^#{1,6}\s+\S/

/** 碎行检测（判定顺序即优先级，先命中先返回）：
 *  ① 代码文件 → false（清洗跳过，折行是代码的常态）；
 *  ② 含 Markdown 标题 → false（规整文档）；
 *  ③ 非空行平均长度 < 42 字符 且 存在连续 ≥ 5 行非空折行段 → true。
 *  调用口径：逐文件检测（每份文件各自判定再清洗），不能对多文件聚合后的整串判定。 */
export function detectFragmented(text: string, fileName?: string): boolean {
  if (!text) return false
  if (fileName && CODE_EXTS.has(fileExt(fileName))) return false
  const lines = text.split('\n')
  let hasHeading = false
  for (const l of lines) {
    if (MD_HEADING.test(l)) {
      hasHeading = true
      break
    }
  }
  if (hasHeading) return false
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length === 0) return false
  const avgLen = nonEmpty.reduce((s, l) => s + l.length, 0) / nonEmpty.length
  if (avgLen >= AVG_LINE_LEN) return false
  let run = 0
  for (const l of lines) {
    if (l.trim()) {
      run++
      if (run >= MIN_FOLD_RUN) return true
    } else {
      run = 0
    }
  }
  return false
}

/** 句末标点（行尾命中则断段，否则与下一行拼接） */
const SENT_END = /[。！？；.!?)）]$/

/** 碎行清洗：逐行扫描合并折行、压缩空行；只动换行/空行，字数守恒（守恒口径：除 \n 与 \r 外字符集不变）。
 *  - 入口统一把 \r\n / \r 规范为 \n（Windows 换行不算内容字符）；
 *  - 空行 → flush 缓冲 + 保留一个空行；
 *  - 行尾句末标点 → flush 缓冲（断段）；
 *  - 其余非空行追加缓冲与下一行拼接；
 *  - 结束 flush 余量；`\n{3,}` 压缩为 `\n\n`；首尾 trim。 */
export function cleanText(text: string): string {
  if (!text) return ''
  const normalized = text.replace(/\r\n?/g, '\n')
  const out: string[] = []
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      out.push(buf.join(''))
      buf = []
    }
  }
  for (const line of normalized.split('\n')) {
    if (!line.trim()) {
      flush()
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    buf.push(line)
    if (SENT_END.test(line.trim())) flush()
  }
  flush()
  // 只剥首尾换行不 trim 空格（空格属内容字符，字数守恒强校验）
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}
