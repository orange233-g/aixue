/**
 * 模型文件存储（V-EMB 三期：内置 bge 随 app 分发，其余模型由用户导入）。
 *
 * - 存储：本机 IndexedDB（idb，存 Blob 惰性引用，不整包进内存），键为 `${modelId}/${fileName}`。
 * - 内置模型：首次使用时从 app 内置资产 `/models/<assetDir>/...` 复制到本机缓存（幂等、可重复）；
 *   导出/清理只影响缓存，不影响 app 资产。
 * - 导入模型：由 `importer.ts` 直接写入（导入后即完整），不再有下载/换源逻辑。
 * - 清理：内置模型在「没有任何知识库绑定」时自动释放；导入模型只能由用户显式删除。
 */
import { openDB, type IDBPDatabase } from 'idb'
import { EMBED_MODELS, getEmbedModel } from './registry'

const DB_NAME = 'ai-embed-files'
const DB_VERSION = 1
const STORE = 'files'

interface EmbedFileRow {
  key: string // `${modelId}/${fileName}`
  blob: Blob
}

let dbPromise: Promise<IDBPDatabase<{ files: { key: string; value: EmbedFileRow } }>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<{ files: { key: string; value: EmbedFileRow } }>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

const fileKey = (modelId: string, name: string) => `${modelId}/${name}`

/** 模型需要的全部文件（来自注册表清单；未知模型返回空数组） */
export function modelFileNames(modelId: string): string[] {
  return getEmbedModel(modelId)?.files.map((f) => f.name) ?? []
}

/** 模型文件是否已完整缓存 */
export async function isModelCached(modelId: string): Promise<boolean> {
  const names = modelFileNames(modelId)
  if (names.length === 0) return false
  const db = await getDb()
  const tx = db.transaction(STORE, 'readonly')
  for (const n of names) {
    const row = await tx.store.get(fileKey(modelId, n))
    if (!row?.blob) return false
  }
  return true
}

/** 读取模型文件为 ArrayBuffer；缓存缺失时自动准备（内置模型从 app 资产复制，导入模型报错）。
 *  推理链路零手工操作、自愈。模型文件不可用时抛错，由调用方降级。 */
export async function readModelFile(modelId: string, name: string): Promise<ArrayBuffer> {
  const db = await getDb()
  let row = await db.get(STORE, fileKey(modelId, name))
  if (!row?.blob) {
    await ensureModelFiles(modelId)
    row = await db.get(STORE, fileKey(modelId, name))
    if (!row?.blob) throw new Error(`模型文件不可用: ${modelId}/${name}`)
  }
  return row.blob.arrayBuffer()
}

/** 写入单个模型文件（导入管线用；同 key 覆盖） */
export async function writeModelFile(modelId: string, name: string, blob: Blob): Promise<void> {
  const db = await getDb()
  await db.put(STORE, { key: fileKey(modelId, name), blob } as EmbedFileRow)
}

/**
 * 自动清理（6.90 全自动生命周期）：删除「没有任何知识库绑定」的**内置**模型本机缓存，释放存储空间。
 * 导入模型是用户主动添加的资产，绝不自动清理（只能由用户在设置页显式删除）。
 * boundModelIds = 当前所有知识库绑定的向量模型 id（去重后）。返回被清理的模型 id。
 * 触发时机：删库后 / app 启动（兜底），调用方无需感知。
 */
export async function gcEmbedCaches(boundModelIds: string[]): Promise<string[]> {
  const removed: string[] = []
  for (const model of EMBED_MODELS) {
    if (boundModelIds.includes(model.id)) continue
    if (await isModelCached(model.id)) {
      await deleteModelFiles(model.id)
      removed.push(model.id)
    }
  }
  return removed
}

/** 删除某模型的全部缓存文件（内置模型可被 GC 重备；导入模型删除后需重新导入） */
export async function deleteModelFiles(modelId: string): Promise<void> {
  await deleteModelFilesFor(modelId, modelFileNames(modelId))
}

/** 按显式文件名删除（导入失败回滚时用：此时模型尚未注册，查不到清单） */
export async function deleteModelFilesFor(modelId: string, names: string[]): Promise<void> {
  if (names.length === 0) return
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  await Promise.all(names.map((n) => tx.store.delete(fileKey(modelId, n))))
  await tx.done
}

/** SHA-256 hex（Web Crypto；Uint8Array.from 复制为独立 ArrayBuffer 满足 BufferSource 类型） */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return sha256HexOfBuffer(Uint8Array.from(bytes).buffer)
}

/** SHA-256 hex（直接吃 ArrayBuffer，避免大权重（~585MB）在校验时被多复制一次） */
export async function sha256HexOfBuffer(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface EnsureModelOptions {
  /** 单文件完成回调 (done, total) */
  onProgress?: (done: number, total: number) => void
}

/**
 * 确保模型文件可用：
 * - 已缓存：直接返回。
 * - 内置模型：从 `/models/<assetDir>/<name>` 复制到本机缓存（幂等）。
 * - 导入模型：文件由导入流程写入；缺失说明包不完整/被清理，直接报错提示重新导入。
 */
export async function ensureModelFiles(modelId: string, opts?: EnsureModelOptions): Promise<void> {
  const model = getEmbedModel(modelId)
  if (!model) throw new Error(`未知 embedding 模型: ${modelId}`)
  if (await isModelCached(modelId)) return

  if (model.imported || !model.assetDir) {
    throw new Error(`模型「${model.name}」文件缺失，请重新导入模型包`)
  }

  const total = model.files.length
  let done = 0
  for (const f of model.files) {
    const url = `/models/${model.assetDir}/${f.name}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`内置模型文件缺失：${url}（HTTP ${res.status}）`)
    const blob = await res.blob()
    await writeModelFile(modelId, f.name, blob)
    done++
    opts?.onProgress?.(done, total)
  }
}
