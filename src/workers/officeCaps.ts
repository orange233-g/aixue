/**
 * Office zip 解压安全上限（V2-S06）：
 * 防护必须覆盖「Worker 路径」与「主线程回退路径」两个入口，否则 Worker 异常时回退主线程直解会绕过限制
 * （fail-open）。此前主线程 unzipSync 无上限，恶意 docx/xlsx/odt 可展开成巨量 XML 打爆内存。
 * 在解压前（central directory filter，携带 originalSize/compressedSize）逐条拦截：
 * 单条目展开体积、总展开体积、压缩比任一超限即抛错。合法 Office XML 常见压缩比约 2-50，
 * zip bomb 通常上千倍，给足合法余量又不放行炸弹。
 */
export const PER_ENTRY_CAP = 8 * 1024 * 1024 // 单条目解压后上限 8MB
export const TOTAL_CAP = 24 * 1024 * 1024 // 本次解压全部目标条目合计上限 24MB
export const MAX_RATIO = 200 // 压缩比上限（compressed:uncompressed ≤ 1:200）

/** 各格式需要的 zip 条目（正则匹配 entry 名） */
export const ENTRY_FILTERS: Record<'docx' | 'xlsx' | 'odt', RegExp> = {
  docx: /^word\/document\.xml$/,
  xlsx: /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/,
  odt: /^content\.xml$/,
}

/**
 * 构造带防护的 fflate filter：命中所需条目且通过全部上限才解压，否则抛错（fail-closed）。
 * 两入口（Worker / 主线程回退）必须共用同一份防护。
 */
export function guardedFilter(ext: keyof typeof ENTRY_FILTERS): (f: { name: string; size?: number; originalSize?: number }) => boolean {
  const filter = ENTRY_FILTERS[ext]
  let total = 0
  return (f) => {
    if (!filter.test(f.name)) return false
    const raw = f.originalSize ?? 0
    if (raw > PER_ENTRY_CAP) {
      throw new Error(`解压后文件过大：${f.name}（${raw} 字节）超过 8MB 上限`)
    }
    const compressed = f.size ?? 0
    if (raw > 0 && compressed > 0 && raw / compressed > MAX_RATIO) {
      throw new Error('Office 文件压缩比异常，已拒绝解压（疑似 zip bomb）')
    }
    total += raw
    if (total > TOTAL_CAP) throw new Error('Office 解压后总体积超过上限（24MB）')
    return true
  }
}