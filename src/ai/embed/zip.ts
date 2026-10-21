/**
 * 最小 ZIP 读取器（只读中央目录 + 按条目取数据切片，不做解压）。
 *
 * 为什么不用 fflate 的 unzipSync：Qwen3 模型包 ~585MB，整包解压会让 WebView 峰值内存翻倍；
 * 模型包在打包时对所有权重使用 STORE（不压缩），因此这里只需按偏移切片即可，内存占用是
 * 「一次一个文件」而不是「压缩包 + 解压结果」两份。
 *
 * 限制（与打包脚本 scripts/pack-embed-model.mjs 对齐）：
 * - 只支持单 ZIP（不支持分卷）；
 * - 不支持 ZIP64（模型包 < 4GB）；
 * - 只接受 STORE（compression method 0）条目，遇到压缩条目直接报错，提示重新打包。
 */

export interface ZipEntry {
  /** 条目名（UTF-8；模型包内均为 ASCII 相对路径） */
  name: string
  /** 解压后大小（STORE 时等于压缩后大小） */
  size: number
  /** 压缩方式：0 = STORE */
  method: number
  /** 数据区起点（已跳过本地文件头） */
  dataOffset: number
  /** 压缩后大小 */
  compressedSize: number
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function u16(dv: DataView, off: number): number {
  return dv.getUint16(off, true)
}
function u32(dv: DataView, off: number): number {
  return dv.getUint32(off, true)
}

/** 在文件尾部 64KB 内定位 EOCD（结束记录），返回它在 tail 缓冲中的偏移 */
function findEocd(tail: DataView): number {
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 读取 zip 中央目录。返回条目表（name → entry）。
 * 抛错信息面向用户：不是合法 zip / 需要重新打包。
 */
export async function readZipEntries(file: Blob): Promise<Map<string, ZipEntry>> {
  if (file.size < 22) throw new Error('不是有效的模型包（文件太小）')
  const tailLen = Math.min(file.size, 65557)
  const tailBuf = await file.slice(file.size - tailLen).arrayBuffer()
  const tail = new DataView(tailBuf)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('不是有效的模型包（找不到 zip 结束记录）')

  const totalEntries = u16(tail, eocd + 10)
  const cdSize = u32(tail, eocd + 12)
  const cdOffset = u32(tail, eocd + 16)
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('模型包过大（ZIP64 不支持），请用打包脚本重新生成')
  }
  if (cdOffset + cdSize > file.size) throw new Error('模型包已损坏（中央目录越界）')

  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer()
  const cd = new DataView(cdBuf)
  const entries = new Map<string, ZipEntry>()
  let p = 0
  const dec = new TextDecoder('utf-8')

  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== SIG_CENTRAL) {
      throw new Error('模型包已损坏（中央目录条目非法）')
    }
    const method = u16(cd, p + 10)
    const compressedSize = u32(cd, p + 20)
    const size = u32(cd, p + 24)
    const nameLen = u16(cd, p + 28)
    const extraLen = u16(cd, p + 30)
    const commentLen = u16(cd, p + 32)
    const localOffset = u32(cd, p + 42)
    const name = dec.decode(new Uint8Array(cdBuf, p + 46, nameLen))

    // 读本地文件头，算出真实数据起点（本地头可能带额外字段，长度未必与中央目录一致）
    const localBuf = await file.slice(localOffset, localOffset + 30).arrayBuffer()
    if (localBuf.byteLength < 30) throw new Error('模型包已损坏（本地文件头缺失）')
    const local = new DataView(localBuf)
    if (u32(local, 0) !== SIG_LOCAL) throw new Error('模型包已损坏（本地文件头非法）')
    const localNameLen = u16(local, 26)
    const localExtraLen = u16(local, 28)
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen

    entries.set(name, { name, size, method, dataOffset, compressedSize })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 取出条目的原始数据（STORE 条目直接切片；压缩条目报错） */
export async function readZipEntryBlob(file: Blob, entry: ZipEntry): Promise<Blob> {
  if (entry.method !== 0) {
    throw new Error(`模型包文件 ${entry.name} 使用了压缩格式（不支持），请用打包脚本重新生成`)
  }
  if (entry.compressedSize !== entry.size) {
    throw new Error(`模型包文件 ${entry.name} 大小异常（STORE 条目压缩后大小应等于原始大小）`)
  }
  if (entry.dataOffset + entry.size > file.size) {
    throw new Error(`模型包已损坏（${entry.name} 数据越界）`)
  }
  return file.slice(entry.dataOffset, entry.dataOffset + entry.size)
}
