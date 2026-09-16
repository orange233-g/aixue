/**
 * 文件 → 文本 解析入口（Phase 1 / 知识库共用）。
 * 按扩展名分流（借鉴 Cherry fileExtensions/fileType）：
 *  - 文本类（txt/md/html/csv/代码…）直接读文本，UTF-8 优先 + GBK 兜底解码；
 *  - Office（docx/xlsx/odt）= zip 容器 + 内部 XML：fflate 在 Web Worker 里按条目单挑解压，
 *    主线程 DOMParser 抠文本（DOMParser 不在 Worker 环境，解压与抠文本分两侧执行）；
 *  - 其余格式（pdf/ppt 等）友好拒绝，引导粘贴文本（PRD §5 非目标）。
 * 所有解析路径 try/catch，失败绝不产出空文本静默发送。
 */
import { unzipOfficeEntries } from '../../workers/fileParseWorkerClient'

/** 单文件大小上限（选文件即校验，防超大文件把内存/解析拖崩）。50MB 兼顾 Office 文档与长篇文本；解析按预算分批，不受单文件体积拖累 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/** 知识库单库可导入文件数上限（与生成页引用一致，防一次导入堆积过多文件把库切碎） */
export const KB_MAX_FILES = 10
/** 知识库单库累计源文件总体积上限（字节）。append 追加时把已有 sourceFiles 计入总量 */
export const KB_MAX_TOTAL_BYTES = 100 * 1024 * 1024

/** 纯文本扩展名（15 种） */
const PLAIN_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'conf', 'env',
])
/** 代码扩展名（32 种）：阅读器等宽显示、碎行清洗跳过（clean.ts 共用） */
export const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat',
  'ps1', 'sql', 'css', 'scss', 'less', 'swift', 'kt', 'dart', 'r', 'm', 'lua',
])
const TEXT_EXTS = new Set([...PLAIN_TEXT_EXTS, ...CODE_EXTS])
const HTML_EXTS = new Set(['html', 'htm'])
export const OFFICE_EXTS = new Set(['docx', 'xlsx', 'odt'])

/** 文件选择器 accept（生成页导入与知识库新建共用） */
export const SUPPORTED_ACCEPT = [...TEXT_EXTS, ...HTML_EXTS, ...OFFICE_EXTS]
  .map((e) => '.' + e)
  .join(',')

export interface ParsedFile {
  name: string
  size: number
  text: string
  kind: 'text' | 'office'
}

export interface ParseFailure {
  name: string
  reason: string
}

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

/** 是否为拉丁字母为主文本（英/法/德等西文；中文/日文等非拉丁文本返回 false）。
 *  字母占比 >50% 判拉丁——英文正文占比通常 >60%，中文接近 0，混排各半时按字符数显示。 */
export function isLatinText(text: string): boolean {
  if (!text) return false
  let letters = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++
  }
  return letters / text.length > 0.5
}

/** 英文词数：按空白切分计数（拉丁文本用；词数须导入时记录，无法从字符数反推） */
export function countWords(text: string): number {
  if (!text) return 0
  return text.split(/\s+/).filter(Boolean).length
}

/** 代码行数（\n 计数；代码文件展示用，比字符数直观） */
export function countLines(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

export function isSupportedFile(name: string): boolean {
  const e = fileExt(name)
  return TEXT_EXTS.has(e) || HTML_EXTS.has(e) || OFFICE_EXTS.has(e)
}

/** 文件头 BOM → TextDecoder 编码名（含 BOM 字节偏移；无 BOM 返回 null）。
 *  Windows 记事本导出的 txt 常带 BOM，遇 UTF-16/UTF-8 时 BOM 是唯一可靠信号。 */
function detectBom(bytes: Uint8Array): { enc: string; offset: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { enc: 'utf-8', offset: 3 }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { enc: 'utf-16be', offset: 2 }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { enc: 'utf-16le', offset: 2 }
  return null
}

/** U+FFFD 乱码字符数（解码失败信号，越低越好） */
function badCount(text: string): number {
  return (text.match(/\uFFFD/g) || []).length
}

/** BOM 缺失时识别 UTF-16LE：偶数字节数、utf-16le 能无乱码解出、且出现 NUL 字节（ASCII 段/换行占位）。
 *  GBK 是"贪婪解码"几乎总能"无错"输出，故用 NUL 占比把假装干净的 GBK 识别纠正为更可能的 UTF-16。 */
function looksUtf16Le(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return false
  let utf16: string
  try {
    utf16 = new TextDecoder('utf-16le').decode(bytes)
  } catch {
    return false
  }
  if (badCount(utf16) > 0) return false
  let nul = 0
  let sample = 0
  const step = Math.max(1, Math.floor(bytes.length / 200000))
  for (let i = 0; i < bytes.length; i += step) {
    sample++
    if (bytes[i] === 0) nul++
  }
  return nul / Math.max(1, sample) > 0.004
}

/** UTF-8 优先解码；支持 UTF-16/BOM/GBK 兜底（中文 Windows 导出 txt 常见），取乱码更少的一版 */
function decodeBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const bom = detectBom(bytes)
  if (bom) {
    try {
      return new TextDecoder(bom.enc).decode(bytes.subarray(bom.offset))
    } catch {
      /* 兼容部分老 WebView 不支持该编码：继续启发式 */
    }
  }
  let utf8: string
  let bad8: number
  try {
    utf8 = new TextDecoder('utf-8').decode(bytes)
    bad8 = badCount(utf8)
  } catch {
    utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    bad8 = badCount(utf8)
  }
  if (bad8 === 0 || bad8 / Math.max(1, utf8.length) < 0.002) return utf8
  // BOM 缺失的 UTF-16LE：网络小说 txt / Windows「Unicode」常见
  if (looksUtf16Le(bytes)) {
    try {
      return new TextDecoder('utf-16le').decode(bytes)
    } catch {
      /* 忽略，走 GBK 兜底 */
    }
  }
  try {
    const gbk = new TextDecoder('gbk').decode(bytes)
    const badG = badCount(gbk)
    if (badG < bad8) return gbk
  } catch {
    /* 部分老 WebView 不支持 gbk 编码：保留 UTF-8 结果 */
  }
  return utf8
}

/** HTML → 纯文本：丢 script/style/noscript 与标签，压缩空白（html 当资料用时标签只是噪音） */
function htmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    for (const t of [...doc.querySelectorAll('script,style,noscript,template')]) t.remove()
    return (doc.body?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return html
  }
}

function parseXml(xml: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) return null
    return doc
  } catch {
    return null
  }
}

/** 压缩连续空行：段落结构保留但不出大段空白 */
function squeeze(lines: string[]): string {
  const out: string[] = []
  for (const l of lines) {
    if (!l.trim() && (out.length === 0 || !out[out.length - 1].trim())) continue
    out.push(l)
  }
  return out.join('\n').trim()
}

/** docx：word/document.xml 的 w:p 段落 → 每段拼接其 w:t 文本 */
function docxToText(xml: string): string {
  const doc = parseXml(xml)
  if (!doc) throw new Error('docx 结构解析失败')
  const paras = doc.getElementsByTagName('w:p')
  const lines: string[] = []
  for (let i = 0; i < paras.length; i++) {
    const ts = paras[i].getElementsByTagName('w:t')
    let line = ''
    for (let j = 0; j < ts.length; j++) line += ts[j].textContent ?? ''
    lines.push(line)
  }
  return squeeze(lines)
}

/** xlsx：sharedStrings + 各 sheet 的行/单元格 → 行文本（单元格以制表符分隔，sheet 间加标注行） */
function xlsxToText(entries: Record<string, string>): string {
  const shared: string[] = []
  if (entries['xl/sharedStrings.xml']) {
    const doc = parseXml(entries['xl/sharedStrings.xml'])
    if (doc) {
      const ts = doc.getElementsByTagName('t')
      for (let i = 0; i < ts.length; i++) shared.push(ts[i].textContent ?? '')
    }
  }
  const sheetNames = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const blocks: string[] = []
  for (const name of sheetNames) {
    const doc = parseXml(entries[name])
    if (!doc) continue
    const rows = doc.getElementsByTagName('row')
    const lines: string[] = []
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].getElementsByTagName('c')
      const parts: string[] = []
      for (let j = 0; j < cells.length; j++) {
        const c = cells[j]
        const type = c.getAttribute('t')
        let val = ''
        if (type === 's') {
          const v = c.getElementsByTagName('v')[0]?.textContent ?? ''
          const idx = Number(v)
          val = Number.isFinite(idx) ? shared[idx] ?? '' : ''
        } else if (type === 'inlineStr') {
          const ts = c.getElementsByTagName('t')
          for (let k = 0; k < ts.length; k++) val += ts[k].textContent ?? ''
        } else {
          val = c.getElementsByTagName('v')[0]?.textContent ?? ''
        }
        parts.push(val)
      }
      const line = parts.join('\t')
      if (line.trim()) lines.push(line)
    }
    if (lines.length) {
      const m = name.match(/sheet(\d+)\.xml$/)
      blocks.push(`【工作表 ${m ? m[1] : '?'}】\n${lines.join('\n')}`)
    }
  }
  return blocks.join('\n\n').trim()
}

/** odt：content.xml 的 text:p / text:h 段落（按文档序遍历，避免两个 tag 集合并集乱序） */
function odtToText(xml: string): string {
  const doc = parseXml(xml)
  if (!doc) throw new Error('odt 结构解析失败')
  const lines: string[] = []
  const walk = (node: Node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const c = node.childNodes[i]
      if (c.nodeType !== 1) continue
      const el = c as Element
      if (el.tagName === 'text:p' || el.tagName === 'text:h') {
        lines.push(el.textContent ?? '')
      } else {
        walk(el)
      }
    }
  }
  walk(doc.documentElement)
  return squeeze(lines)
}

/** Office zip → 文本：Worker 按条目解压（只取需要的 entry），主线程抠 XML 文本。
 *  V4-P01：signal 贯穿到 Worker 客户端，Office 大文件解压可被中断。 */
async function officeToText(file: File, ext: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const buf = await file.arrayBuffer()
  const raw = await unzipOfficeEntries(buf, ext as 'docx' | 'xlsx' | 'odt', { signal })
  const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b)
  if (ext === 'docx') {
    const xml = raw['word/document.xml']
    if (!xml) throw new Error('docx 内缺少 word/document.xml（可能是 .doc 改名的文件）')
    return docxToText(decode(xml))
  }
  if (ext === 'xlsx') {
    const entries: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) entries[k] = decode(v)
    return xlsxToText(entries)
  }
  if (ext === 'odt') {
    const xml = raw['content.xml']
    if (!xml) throw new Error('odt 内缺少 content.xml')
    return odtToText(decode(xml))
  }
  throw new Error('不支持的 Office 格式')
}

/** 解析单文件为纯文本；不支持/失败时抛错（调用方收集为失败项给友好提示）。
 *  V4-P01：signal 供调用方取消/中断超长解析。 */
export async function parseFileToText(file: File, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`)
  }
  const ext = fileExt(file.name)
  if (OFFICE_EXTS.has(ext)) {
    const text = await officeToText(file, ext, signal)
    if (!text.trim()) throw new Error('未从文件中提取到文本（可能只含图片/图形）')
    return text
  }
  if (HTML_EXTS.has(ext)) {
    const text = htmlToText(decodeBuffer(await file.arrayBuffer()))
    if (!text.trim()) throw new Error('HTML 中无可提取文本')
    return text
  }
  if (TEXT_EXTS.has(ext)) {
    const text = decodeBuffer(await file.arrayBuffer())
    if (!text.trim()) throw new Error('文件内容为空')
    return text
  }
  throw new Error('暂不支持该格式（支持 txt/md/html/csv/代码/docx/xlsx/odt），可直接粘贴文本内容')
}

/** 批量解析：逐份解析，失败不中断其余，返回成功/失败两组（失败项给友好提示，不生成 chip）。
 *  V4-P01：signal 中断时剩余文件按失败项计入（reason=已取消），并停止继续解析。 */
export async function parseFiles(
  files: File[],
  signal?: AbortSignal,
): Promise<{ ok: ParsedFile[]; failed: ParseFailure[] }> {
  const ok: ParsedFile[] = []
  const failed: ParseFailure[] = []
  for (const f of files) {
    if (signal?.aborted) {
      failed.push({ name: f.name, reason: '已取消' })
      break
    }
    try {
      const text = await parseFileToText(f, signal)
      ok.push({
        name: f.name,
        size: f.size,
        text,
        kind: OFFICE_EXTS.has(fileExt(f.name)) ? 'office' : 'text',
      })
    } catch (e) {
      failed.push({ name: f.name, reason: e instanceof Error ? e.message : '解析失败' })
    }
  }
  return { ok, failed }
}
