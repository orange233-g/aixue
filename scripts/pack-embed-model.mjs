/**
 * 打包 `.aixue-model` 模型包（供「我的 → 向量模型 → 添加模型」本地导入）。
 *
 * 用法：
 *   node scripts/pack-embed-model.mjs                 # 默认：model-packages/qwen3-embedding-0.6b（元数据）+ model-pack/qwen3-embedding-0.6b（权重）
 *   node scripts/pack-embed-model.mjs --meta <目录> --weights <目录> --out <目录>
 *
 * 元数据目录（入库）需含 model.json（模型元数据 + 文件清单），可含 LICENSE / NOTICE（会一并打进包）。
 * 权重目录（不入库）需含 files 里列出的模型文件。
 *
 * 输出：<out>/<model-id>.aixue-model（zip，全部条目 STORE 不压缩）+ <out>/<model-id>.aixue-model.sha256
 * 注意：zip 体积接近模型本体（~585MB），**不要提交进 git**（GitHub 单文件 100MB 上限）；
 * 发布时作为 GitHub Release 资产上传，仓库里只保留 model.json 与小体积校验文件。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const metaDir = resolve(ROOT, flag('--meta', 'model-packages/qwen3-embedding-0.6b'))
const weightsDir = resolve(ROOT, flag('--weights', 'model-pack/qwen3-embedding-0.6b'))
const outDir = resolve(ROOT, flag('--out', 'release'))

/** CRC32（zip 必需；标准多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32Update(crc, buf) {
  let c = crc
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

/** 固定时间戳（DOS 时间），保证同样输入产出同样 zip，便于校验 */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const CHUNK = 8 * 1024 * 1024

/** 写 zip 的流式封装（带背压 + 整体 SHA256） */
class ZipWriter {
  constructor(outPath) {
    this.outPath = outPath
    this.fd = null
    this.stream = null
    this.offset = 0
    this.hash = createHash('sha256')
    this.entries = []
  }

  async open() {
    this.stream = createWriteStream(this.outPath)
    await new Promise((res, rej) => {
      this.stream.once('open', res)
      this.stream.once('error', rej)
    })
  }

  async write(buf) {
    if (!this.stream.write(buf)) await new Promise((res) => this.stream.once('drain', res))
    this.hash.update(buf)
    this.offset += buf.length
  }

  async addFileStream(entryName, filePath) {
    const nameBuf = Buffer.from(entryName, 'utf8')
    const size = statSync(filePath).size
    if (size > 0xffffffff) throw new Error(`文件超过 4GB（ZIP64 不支持）：${entryName}`)
    const localOffset = this.offset

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // 本地文件头
    header.writeUInt16LE(20, 4) // 解压所需版本
    header.writeUInt16LE(0x0808, 6) // UTF-8 名 + data descriptor
    header.writeUInt16LE(0, 8) // STORE
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(0, 14) // crc（在 descriptor 里）
    header.writeUInt32LE(0, 18)
    header.writeUInt32LE(0, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    await this.write(header)
    await this.write(nameBuf)

    const dataOffset = this.offset
    const fd = openSync(filePath, 'r')
    let written = 0
    let crc = 0xffffffff
    const fileHash = createHash('sha256')
    const buf = Buffer.allocUnsafe(CHUNK)
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, CHUNK, written)
        if (n <= 0) break
        const chunk = buf.subarray(0, n)
        crc = crc32Update(crc, chunk)
        fileHash.update(chunk)
        await this.write(Buffer.from(chunk)) // 复制一份，避免 stream 未消费时被复用
        written += n
      }
    } finally {
      closeSync(fd)
    }
    if (written !== size) throw new Error(`读取文件长度不符：${entryName}（${written} != ${size}）`)
    crc = (crc ^ 0xffffffff) >>> 0

    const desc = Buffer.alloc(16)
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(crc, 4)
    desc.writeUInt32LE(size, 8)
    desc.writeUInt32LE(size, 12)
    await this.write(desc)

    this.entries.push({
      nameBuf,
      crc,
      size,
      localOffset,
      dataOffset,
      sha256: fileHash.digest('hex'),
    })
    return { size, sha256: this.entries[this.entries.length - 1].sha256 }
  }

  async addBuffer(entryName, buf) {
    const nameBuf = Buffer.from(entryName, 'utf8')
    const localOffset = this.offset
    const crc = (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 名，无 data descriptor
    header.writeUInt16LE(0, 8) // STORE
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(buf.length, 18)
    header.writeUInt32LE(buf.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    await this.write(header)
    await this.write(nameBuf)
    const dataOffset = this.offset
    await this.write(buf)

    this.entries.push({ nameBuf, crc, size: buf.length, localOffset, dataOffset })
  }

  async close() {
    const cdStart = this.offset
    for (const e of this.entries) {
      const rec = Buffer.alloc(46)
      rec.writeUInt32LE(0x02014b50, 0) // 中央目录
      rec.writeUInt16LE(20, 4) // version made by
      rec.writeUInt16LE(20, 6) // version needed
      rec.writeUInt16LE(0x0808, 8) // flags（与本地头一致）
      rec.writeUInt16LE(0, 10) // STORE
      rec.writeUInt16LE(DOS_TIME, 12)
      rec.writeUInt16LE(DOS_DATE, 14)
      rec.writeUInt32LE(e.crc, 16)
      rec.writeUInt32LE(e.size, 20)
      rec.writeUInt32LE(e.size, 24)
      rec.writeUInt16LE(e.nameBuf.length, 28)
      rec.writeUInt16LE(0, 30) // extra
      rec.writeUInt16LE(0, 32) // comment
      rec.writeUInt16LE(0, 34) // disk
      rec.writeUInt16LE(0, 36) // internal attrs
      rec.writeUInt32LE(0, 38) // external attrs
      rec.writeUInt32LE(e.localOffset, 42)
      await this.write(rec)
      await this.write(e.nameBuf)
    }
    const cdSize = this.offset - cdStart

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    await this.write(eocd)

    await new Promise((res, rej) => this.stream.end((err) => (err ? rej(err) : res())))
    return this.hash.digest('hex')
  }
}

async function main() {
  const metaPath = join(metaDir, 'model.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const model = meta.model
  const fileNames = meta.files
  if (!model?.id || !Array.isArray(fileNames) || fileNames.length === 0) {
    throw new Error('model.json 需要 model.id 与 files 列表')
  }
  for (const name of fileNames) {
    if (!name || name.includes('..') || name.startsWith('/')) throw new Error(`非法文件名：${name}`)
  }

  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${model.id}.aixue-model`)
  const tmpPath = `${outPath}.tmp`
  rmSync(tmpPath, { force: true })

  console.log(`[pack-model] 模型：${model.id}`)
  console.log(`[pack-model] 输出：${outPath}`)

  const writer = new ZipWriter(tmpPath)
  await writer.open()
  const files = []
  const t0 = Date.now()
  for (const name of fileNames) {
    const abs = join(weightsDir, name)
    const st = statSync(abs)
    process.stdout.write(`[pack-model] + ${name} (${(st.size / 1048576).toFixed(1)} MB)\n`)
    const { size, sha256 } = await writer.addFileStream(name, abs)
    files.push({ name, size, sha256 })
  }

  // 许可证/声明文件随包分发（不属于模型文件，不进 manifest.files）
  for (const extra of ['LICENSE', 'NOTICE']) {
    const extraPath = join(metaDir, extra)
    if (existsSync(extraPath)) {
      await writer.addBuffer(extra, readFileSync(extraPath))
      console.log('[pack-model] + ' + extra + '（许可证/声明）')
    }
  }

  const manifest = { format: 'aixue-embed-model', version: 1, model, files }
  await writer.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  const zipSha = await writer.close()

  renameSync(tmpPath, outPath)
  const zipSize = statSync(outPath).size
  const shaPath = `${outPath}.sha256`
  writeFileSync(shaPath, `${zipSha}  ${model.id}.aixue-model\n`)

  console.log(`[pack-model] 完成：${(zipSize / 1048576).toFixed(1)} MB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`[pack-model] SHA256：${zipSha}`)
  console.log(`[pack-model] 校验文件：${shaPath}`)
  console.log('[pack-model] 提示：该文件不要提交进 git，上传到 GitHub Release 作为附件即可。')
}

main().catch((e) => {
  console.error('[pack-model] 失败：', e.message)
  process.exit(1)
})
