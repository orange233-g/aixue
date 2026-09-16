/**
 * 模型文件存储与下载（V-EMB 一期）。
 * - 下载：多源换源（依次尝试 baseUrl）→ SHA256 强校验 → 缓存
 * - 缓存：Web 用 IndexedDB（idb 库，存 Blob 惰性引用，不整包进内存）；
 *   Capacitor 原生预留 Filesystem 动态分支（非原生环境跳过，Android 联调时补）
 * - 文件模式下载（非 zip）：每个文件独立 URL（baseUrl + '/' + name），
 *   避免大权重 zip 解压的内存峰值（Qwen3 614MB）
 */
import { openDB, type IDBPDatabase } from 'idb'
import { getEmbedModel } from './registry'
import type { EmbedModel } from './types'

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

/** 模型需要的关键文件（config + tokenizer + 权重；权重 q8 优先） */
export const MODEL_FILES: Record<string, string[]> = {
  'bge-small-zh-v1.5': ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'],
  'qwen3-embedding-0.6b': [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
  ],
}

/** 模型文件是否已完整缓存 */
export async function isModelCached(modelId: string): Promise<boolean> {
  const names = MODEL_FILES[modelId]
  if (!names) return false
  const db = await getDb()
  const tx = db.transaction(STORE, 'readonly')
  for (const n of names) {
    const row = await tx.store.get(fileKey(modelId, n))
    if (!row?.blob) return false
  }
  return true
}

/** 读取模型文件为 ArrayBuffer；缓存缺失时自动从 app 内置资产准备后再读（6.90 全自动生命周期，
 *  推理链路零手工操作、自愈）。模型文件不可用时抛错，由调用方降级。 */
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

/**
 * 自动清理（6.90 全自动生命周期）：删除「没有任何知识库绑定」的模型本机缓存，
 * 释放存储空间；正在被库使用的模型永远保留（语义召回的查询向量随时要用它）。
 * boundModelIds = 当前所有知识库绑定的向量模型 id（去重后）。返回被清理的模型 id。
 * 触发时机：删库后 / app 启动（兜底），调用方无需感知。
 */
export async function gcEmbedCaches(boundModelIds: string[]): Promise<string[]> {
  const removed: string[] = []
  for (const id of Object.keys(MODEL_FILES)) {
    if (boundModelIds.includes(id)) continue
    if (await isModelCached(id)) {
      await deleteModelFiles(id)
      removed.push(id)
    }
  }
  return removed
}

/** 删除某模型的全部缓存文件 */
export async function deleteModelFiles(modelId: string): Promise<void> {
  const names = MODEL_FILES[modelId]
  if (!names) return
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  await Promise.all(names.map((n) => tx.store.delete(fileKey(modelId, n))))
  await tx.done
}

/** 单文件下载（返回字节，失败抛错） */
async function fetchBytes(url: string, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) {
    return new Uint8Array(await res.arrayBuffer())
  }
  // 流式累计 + 进度
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let done = 0
  for (;;) {
    const { done: d, value } = await reader.read()
    if (d) break
    chunks.push(value)
    done += value.length
    onProgress?.(done, total)
  }
  const out = new Uint8Array(done)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** SHA-256 hex（Web Crypto；Uint8Array.from 复制为独立 ArrayBuffer 满足 BufferSource 类型） */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 确保模型文件已下载并校验缓存（多源换源 + SHA256 校验）。
 * onProgress 每文件完成回调 (doneFiles, totalFiles)；onFile 单文件进度。
 * 全部源失败抛错，调用方提示并保持 BM25 降级。
 */
export async function ensureModelFiles(
  modelId: string,
  opts?: { onProgress?: (done: number, total: number) => void; onFileProgress?: (name: string, done: number, total: number) => void },
): Promise<void> {
  const model: EmbedModel | undefined = getEmbedModel(modelId)
  if (!model) throw new Error(`未知 embedding 模型: ${modelId}`)
  if (await isModelCached(modelId)) return

  const names = MODEL_FILES[modelId]
  if (!names) throw new Error(`模型文件清单缺失: ${modelId}`)
  const total = names.length
  let doneCount = 0
  const db = await getDb()

  // 逐文件下载；某源失败整体换下一个 baseUrl（文件间独立，但为简单起见源粒度换）
  let lastErr: unknown = null
  for (const source of model.sources) {
    if (source.files.length === 0) continue // 托管后置占位，跳过
    lastErr = null
    try {
      for (const f of source.files) {
        const key = fileKey(modelId, f.name)
        const existing = await db.get(STORE, key)
        if (existing?.blob) {
          doneCount++
          opts?.onProgress?.(doneCount, total)
          continue
        }
        const url = source.baseUrl.replace(/\/$/, '') + '/' + f.name
        const bytes = await fetchBytes(url, (d, t) => opts?.onFileProgress?.(f.name, d, t))
        // SHA-256 强校验仅对远端源：内置资产（baseUrl 为 app 内相对路径）随 APK 分发、不可被篡改，
        // 对 614MB 权重做哈希是「准备模型」等待的大头，跳过后本地复制提速明显
        if (!source.baseUrl.startsWith('/')) {
          const hash = await sha256Hex(bytes)
          if (f.sha256 && hash !== f.sha256.toLowerCase()) {
            throw new Error(`校验失败 ${f.name}（sha256 不符，可能文件被替换或下载损坏）`)
          }
        }
        await db.put(STORE, { key, blob: new Blob([Uint8Array.from(bytes)]) } as EmbedFileRow)
        doneCount++
        opts?.onProgress?.(doneCount, total)
      }
      if (await isModelCached(modelId)) return // 全部文件齐，成功
    } catch (e) {
      lastErr = e
      // 当前源失败：清理已写部分，换下一个源重来
      await deleteModelFiles(modelId)
      doneCount = 0
    }
  }
  throw new Error(lastErr instanceof Error ? lastErr.message : '模型准备失败，请重试')
}
