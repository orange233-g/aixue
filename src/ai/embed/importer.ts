/**
 * 模型包导入（`.aixue-model` = 一个 zip，根目录含 manifest.json + 模型文件）。
 *
 * 流程：读 zip 中央目录 → 解析并校验 manifest → 逐个文件校验大小与 SHA256 → 写入 IndexedDB →
 * 注册模型（持久化到 config）。任一步失败都会回滚已写入的文件，不留下半套模型。
 *
 * 内存：模型包使用 STORE（不压缩），逐文件切片读取；单文件（最大 ~585MB）校验时需要一次
 * arrayBuffer，与推理时加载权重的峰值相当，不做额外整包解压。
 */
import {
  MODEL_PACKAGE_FORMAT,
  MODEL_PACKAGE_VERSION,
  type EmbedFileSpec,
  type EmbedModel,
  type ModelPackageManifest,
  type ModelPackageModel,
} from './types'
import { readZipEntries, readZipEntryBlob } from './zip'
import { addImportedModel, hasEmbedModelId } from './registry'
import { deleteModelFilesFor, sha256HexOfBuffer, writeModelFile } from './storage'

/** 单个模型包体积上限（防御异常文件把内存/存储打爆） */
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
/** 模型 id 规则：小写字母/数字开头，允许 . _ - */
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const SHA_RE = /^[0-9a-f]{64}$/

export interface ImportProgress {
  /** read=解析包目录；verify=校验文件；save=写入本机 */
  phase: 'read' | 'verify' | 'save'
  /** 当前文件（read 阶段为空串） */
  name: string
  /** 已完成文件数 */
  index: number
  /** 文件总数 */
  total: number
}

export interface ImportOptions {
  onProgress?: (p: ImportProgress) => void
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new Error(`模型包 manifest.model.${field} 不能为空`)
  return v
}

/** 文件路径安全校验：禁止绝对路径、上级目录与反斜杠（防 zip 路径穿越） */
function assertSafeFileName(name: unknown): string {
  if (typeof name !== 'string' || !name) throw new Error('模型包文件名为空')
  if (name.startsWith('/') || name.startsWith('\\') || name.includes('\\')) {
    throw new Error(`模型包文件名不合法：${name}`)
  }
  if (name.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error(`模型包文件名不合法：${name}`)
  }
  return name
}

/**
 * 解析并严格校验 manifest.json。错误信息面向用户（用于导入弹窗展示），不吞异常。
 */
export function parseModelManifest(text: string): ModelPackageManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('模型包 manifest.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('模型包 manifest.json 结构不合法')
  const m = raw as Partial<ModelPackageManifest>
  if (m.format !== MODEL_PACKAGE_FORMAT) {
    throw new Error('不是 ai学 模型包（manifest.format 不匹配）')
  }
  if (m.version !== MODEL_PACKAGE_VERSION) {
    throw new Error(`模型包版本不支持：${String(m.version)}（当前支持 ${MODEL_PACKAGE_VERSION}）`)
  }
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('模型包 manifest.files 为空')

  const files: EmbedFileSpec[] = m.files.map((f) => {
    if (!f || typeof f !== 'object') throw new Error('模型包 manifest.files 条目不合法')
    const spec = f as Partial<EmbedFileSpec>
    const name = assertSafeFileName(spec.name)
    if (!Number.isInteger(spec.size) || (spec.size as number) <= 0) {
      throw new Error(`模型包文件大小不合法：${name}`)
    }
    if (typeof spec.sha256 !== 'string' || !SHA_RE.test(spec.sha256.toLowerCase())) {
      throw new Error(`模型包文件缺少合法 SHA256：${name}`)
    }
    return { name, size: spec.size as number, sha256: spec.sha256.toLowerCase() }
  })
  const names = new Set(files.map((f) => f.name))
  if (names.size !== files.length) throw new Error('模型包 manifest.files 存在重复文件名')

  const rawModel = m.model as unknown
  if (!rawModel || typeof rawModel !== 'object') throw new Error('模型包 manifest.model 缺失')
  const mm = rawModel as Record<string, unknown>

  const id = str(mm.id, 'id')
  if (!ID_RE.test(id)) throw new Error('模型 id 不合法（小写字母/数字开头，允许 . _ -）')
  const name = str(mm.name, 'name')
  const developer = str(mm.developer, 'developer')
  const description = str(mm.description, 'description')
  const license = str(mm.license, 'license')
  const weight = str(mm.weight, 'weight')
  const note = str(mm.note, 'note')

  if (typeof mm.dim !== 'number' || !Number.isInteger(mm.dim) || mm.dim <= 0 || mm.dim > 8192) {
    throw new Error('模型包 dim 不合法')
  }
  const dim = mm.dim
  if (mm.pooling !== 'cls' && mm.pooling !== 'last_token') throw new Error('模型包 pooling 不合法')
  const pooling = mm.pooling
  if (mm.tokenizer !== 'wordpiece' && mm.tokenizer !== 'bpe') throw new Error('模型包 tokenizer 不合法')
  const tokenizer = mm.tokenizer
  if (typeof mm.maxTokens !== 'number' || !Number.isInteger(mm.maxTokens) || mm.maxTokens <= 0 || mm.maxTokens > 1_000_000) {
    throw new Error('模型包 maxTokens 不合法')
  }
  const maxTokens = mm.maxTokens
  if (typeof mm.normalize !== 'boolean') throw new Error('模型包 normalize 不合法')
  if (!names.has(weight)) throw new Error(`模型包权重文件 ${weight} 不在文件清单中`)

  const model: ModelPackageModel = {
    id,
    name,
    developer,
    description,
    license,
    dim,
    pooling,
    normalize: mm.normalize,
    maxTokens,
    tokenizer,
    weight,
    note,
    ...(typeof mm.queryInstruct === 'string' && mm.queryInstruct ? { queryInstruct: mm.queryInstruct } : {}),
  }

  return { format: MODEL_PACKAGE_FORMAT, version: MODEL_PACKAGE_VERSION, model, files }
}

/**
 * 导入模型包：校验 → 写文件 → 注册。
 * 失败时清掉本次已写入的文件并抛出可展示的错误信息。
 */
export async function importModelPackage(file: File | Blob, opts?: ImportOptions): Promise<EmbedModel> {
  if (file.size <= 0) throw new Error('模型包为空')
  if (file.size > MAX_PACKAGE_BYTES) throw new Error('模型包超过 2GB，无法导入')

  opts?.onProgress?.({ phase: 'read', name: '', index: 0, total: 0 })
  const entries = await readZipEntries(file)

  // manifest.json 可能在任意位置（打包脚本放在第一个，但这里不依赖顺序）
  const manifestName =
    entries.has('manifest.json') ? 'manifest.json' : [...entries.keys()].find((n) => n.toLowerCase() === 'manifest.json')
  if (!manifestName) throw new Error('模型包缺少 manifest.json')
  const manifestBlob = await readZipEntryBlob(file, entries.get(manifestName)!)
  if (manifestBlob.size > 1024 * 1024) throw new Error('模型包 manifest.json 过大')
  const manifest = parseModelManifest(await manifestBlob.text())

  if (hasEmbedModelId(manifest.model.id)) {
    throw new Error(`模型「${manifest.model.id}」已存在，无需重复导入（如需重装请先删除旧模型）`)
  }

  // 先整体校验条目存在且大小一致，避免写了几个文件才发现缺文件
  for (const spec of manifest.files) {
    const entry = entries.get(spec.name)
    if (!entry) throw new Error(`模型包缺少文件：${spec.name}`)
    if (entry.size !== spec.size) {
      throw new Error(`模型包文件大小不符：${spec.name}（应为 ${spec.size}，实际 ${entry.size}）`)
    }
  }

  const total = manifest.files.length
  const written: string[] = []
  try {
    for (let i = 0; i < manifest.files.length; i++) {
      const spec = manifest.files[i]
      opts?.onProgress?.({ phase: 'verify', name: spec.name, index: i, total })
      const blob = await readZipEntryBlob(file, entries.get(spec.name)!)
      const hash = await sha256HexOfBuffer(await blob.arrayBuffer())
      if (hash !== spec.sha256) {
        throw new Error(`模型包文件校验失败：${spec.name}（SHA256 不符，文件可能损坏）`)
      }
      await writeModelFile(manifest.model.id, spec.name, blob)
      written.push(spec.name)
      opts?.onProgress?.({ phase: 'save', name: spec.name, index: i + 1, total })
    }

    const model: EmbedModel = { ...manifest.model, files: manifest.files, imported: true }
    await addImportedModel(model)
    return model
  } catch (e) {
    await deleteModelFilesFor(manifest.model.id, written).catch(() => {})
    throw e
  }
}
