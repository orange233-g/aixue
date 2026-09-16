/** 生成唯一 id（时间戳 + 随机后缀） */
export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 格式化日期：YYYY-MM-DD */
export function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return fmtDate(ts)
}

/** 下载文本文件（Web 端），支持任意 MIME/扩展名 */
export function downloadText(filename: string, content: string, mime = 'application/octet-stream'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Windows 保留设备名（无论有无扩展名都不可用） */
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 净化导出文件名：去掉 Windows 非法字符/控制字符与双向文本控制符，收尾清理「…」、点、空格等，
 *  避免标题里的截断省略号或特殊符号让生成的文件名异常（普通用户处理不了）。
 *  S-06：命中 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名情况）时加前缀兜底；
 *  限制最大长度。空名回退默认值。 */
export function sanitizeFileName(name: string): string {
  const s = (name ?? '')
    .trim()
    // 双向文本控制符 / 隐形方向符会制造「文件名看起来很安全、落盘却不同」的欺骗性表达，直接移除
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. …\s]+$/g, '')
    .replace(/^[. ]+/g, '')
    // 保留设备名：无论是否带扩展名都不可用，加前缀使其可正常落盘
    .replace(/^([^.]*\.)?(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i, '$1_$2$3')
    .slice(0, 60)
  return s || '未命名学习本'
}

/** 是否命中 Windows 保留设备名（供 S-06 在导出流程里复核，通常 sanitizeFileName 已处理） */
export function isReservedBase(name: string): boolean {
  const base = name.replace(/[.].*$/, '')
  return RESERVED_BASE.test(base)
}

/** 下载 JSON 文件（Web 端） */
export function downloadJSON(filename: string, content: string): void {
  downloadText(filename, content, 'application/json')
}

/** 导出通道：native-share=原生端（写盘+分享面板）；browser=浏览器下载 */
export type ExportChannel = 'native-share' | 'browser'

/** 导出结果（供调用方如实提示） */
export interface ExportResult {
  channel: ExportChannel
  fileName: string
  /** 公共目录副本相对路径（相对内部存储根），native 且写成功时有值（6.85） */
  savedPath?: string
  /** 公共目录副本写入失败原因（native；此时仍会走分享面板，6.85） */
  saveError?: string
}

/** 按导出结果生成出口 toast 文案（browserText 为 Web 端沿用文案） */
export function exportResultToast(r: ExportResult, browserText: string): string {
  if (r.channel === 'browser') return browserText
  if (r.savedPath) return `已保存到 Documents/ai学/${r.fileName}，可在文件管理查看`
  if (r.saveError) return `已打开分享面板（保存到本机失败：${r.saveError}）`
  return '已打开系统分享面板'
}

/**
 * 平台感知的文本导出（6.82/6.85）：原生端（Capacitor Android WebView）没有浏览器下载管线，
 * blob + a.download 点击是无效操作。原生流程：
 * ① 写公共副本到 Documents/ai学/<文件名>（Android 11+ 应用自建文件无需权限）——MIUI 等 ROM 的
 *    分享面板可能没有「保存到文件」目标，落盘确定性必须自己保证；写失败不阻断分享，saveError 如实带回；
 * ② 写缓存 + Share 调系统分享面板（发给微信/网盘等），面板关闭或用户取消后 resolve。
 * Web 端保持浏览器下载。文件名净化由调用方完成（sanitizeFileName）。
 * 用户取消分享面板不算失败（静默返回）；写缓存/调起失败如实抛给调用方。
 */
export async function exportTextFile(filename: string, content: string, mime = 'application/octet-stream'): Promise<ExportResult> {
  const { Capacitor } = await import('@capacitor/core')
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
    ])
    let savedPath: string | undefined
    let saveError: string | undefined
    try {
      await Filesystem.writeFile({
        path: `ai学/${filename}`,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      savedPath = `Documents/ai学/${filename}`
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e)
    }
    const written = await Filesystem.writeFile({
      path: filename,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    try {
      await Share.share({ title: filename, files: [written.uri] })
    } catch (e) {
      if (e instanceof Error && /cancel/i.test(e.message)) return { channel: 'native-share', fileName: filename, savedPath, saveError }
      throw e
    }
    return { channel: 'native-share', fileName: filename, savedPath, saveError }
  }
  downloadText(filename, content, mime)
  return { channel: 'browser', fileName: filename }
}

/** 导出 JSON 文件（平台感知） */
export function exportJSONFile(filename: string, content: string): Promise<ExportResult> {
  return exportTextFile(filename, content, 'application/json')
}

/** 选择并读取文本文件（Web 端），返回文件文本；取消返回 null */
export function pickTextFile(accept = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    }
    input.click()
  })
}

/** 导入文件选择结果（V2-S05：先检查体积上限再读入，超大直接拒绝不入 reader，防校验前 OOM） */
export type PickImportResult = { ok: true; text: string } | { ok: false; reason: 'cancel' | 'too-large' }

/** 选择 JSON 导入文件：先校验 file.size 上限返回 'too-large'，超限不读内容；取消返回 'cancel' */
export function pickImportFile(maxBytes: number): Promise<PickImportResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve({ ok: false, reason: 'cancel' })
      // V2-S05：选文件后先检查体积，超过直接拒绝，避免 JSON.parse/validate 前已在内存爆掉
      if (file.size > maxBytes) return resolve({ ok: false, reason: 'too-large' })
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? { ok: true, text: reader.result } : { ok: false, reason: 'cancel' })
      reader.onerror = () => resolve({ ok: false, reason: 'cancel' })
      reader.readAsText(file)
    }
    input.click()
  })
}

/** 选择并读取 JSON 文件（Web 端），返回文件文本；取消返回 null */
export function pickJSONFile(): Promise<string | null> {
  return pickTextFile('.json,application/json')
}

/** 选择多个文件（Web 端），返回 File[]；取消或未选返回空数组（不读内容，解析交给调用方） */
export function pickFiles(accept = ''): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (accept) input.accept = accept
    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : []
      resolve(files)
    }
    input.click()
  })
}
