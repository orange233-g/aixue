/**
 * embedding 模型注册表（V-EMB 三期：内置只保留 bge，其余模型由用户导入）。
 *
 * - 内置模型：`EMBED_MODELS`（随 app 分发，bge-small-zh-v1.5）。
 * - 导入模型：用户从发布页下载 `.aixue-model` 包后本地导入；元数据持久化在 IndexedDB `config`
 *   的 `embed:imported-models`，启动时 `hydrateImportedModels()` 读回内存。
 * - `getEmbedModel` 保持同步（大量展示/推理代码在渲染期同步取模型元数据），因此导入模型必须在
 *   首屏渲染前 hydrate（见 main.tsx）。
 */
import type { EmbedModel } from './types'
import { dbConfig } from '../../db'
// 内置模型头像（Vite 资源管线打包）
import baaiLogo from '../../assets/providers/baai.svg'

/** IndexedDB 中持久化导入模型的 config key */
const IMPORTED_CONFIG_KEY = 'embed:imported-models'

/** 内置默认模型（仅 bge：Qwen3 体积大，改为发布页下载 + 用户本地导入） */
export const EMBED_MODELS: EmbedModel[] = [
  {
    id: 'bge-small-zh-v1.5',
    name: 'bge-small-zh-v1.5（内置默认）',
    developer: '北京智源人工智能研究院（BAAI）',
    description:
      '智源研究院 BGE（BAAI General Embedding）系列的中文特化小模型：约 2400 万参数、512 维向量，在中文语义检索权威基准 C-MTEB 上表现出色。小而快、内存占用低，手机端运行顺畅，中文知识库的首选。',
    license: 'MIT',
    logo: baaiLogo,
    dim: 512,
    pooling: 'cls',
    normalize: true,
    maxTokens: 512,
    queryInstruct: '',
    tokenizer: 'wordpiece',
    weight: 'onnx/model.onnx',
    assetDir: 'bge',
    files: [
      { name: 'config.json', size: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
      { name: 'onnx/model.onnx', size: 94851877, sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a' },
      { name: 'tokenizer_config.json', size: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
      { name: 'tokenizer.json', size: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
    ],
    note: '小而快，手机友好，中文场景开箱即用；内置默认',
  },
]

/** 用户导入的模型（内存态，启动时从 IndexedDB hydrate） */
let importedModels: EmbedModel[] = []

/** 当前可用的全部模型：内置在前，导入在后 */
export function listEmbedModels(): EmbedModel[] {
  return [...EMBED_MODELS, ...importedModels]
}

/** 已导入的模型（副本，供设置页展示/删除） */
export function getImportedModels(): EmbedModel[] {
  return importedModels.map((m) => ({ ...m }))
}

/** 按 id 取模型元数据（未知 id 返回 undefined） */
export function getEmbedModel(id: string): EmbedModel | undefined {
  return EMBED_MODELS.find((m) => m.id === id) ?? importedModels.find((m) => m.id === id)
}

/** 是否内置模型（内置模型不允许删除；自动 GC 只针对内置模型） */
export function isBuiltinEmbedModel(id: string): boolean {
  return EMBED_MODELS.some((m) => m.id === id)
}

/** 导入模型 id 是否已存在（内置或已导入） */
export function hasEmbedModelId(id: string): boolean {
  return !!getEmbedModel(id)
}

/** 校验从 IndexedDB 读回的模型元数据（防旧版本/损坏数据把 UI 带崩） */
function isValidStoredModel(v: unknown): v is EmbedModel {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<EmbedModel>
  return (
    typeof m.id === 'string' && m.id.length > 0 &&
    typeof m.name === 'string' &&
    typeof m.developer === 'string' &&
    typeof m.description === 'string' &&
    typeof m.license === 'string' &&
    typeof m.dim === 'number' && m.dim > 0 &&
    (m.pooling === 'cls' || m.pooling === 'last_token') &&
    typeof m.maxTokens === 'number' && m.maxTokens > 0 &&
    (m.tokenizer === 'wordpiece' || m.tokenizer === 'bpe') &&
    typeof m.weight === 'string' && m.weight.length > 0 &&
    Array.isArray(m.files) && m.files.length > 0 &&
    m.files.every(
      (f) => !!f && typeof f.name === 'string' && typeof f.size === 'number' && typeof f.sha256 === 'string',
    )
  )
}

/** 启动时把导入模型读回内存（失败不影响启动，按无导入模型处理） */
export async function hydrateImportedModels(): Promise<void> {
  try {
    const raw = await dbConfig.get(IMPORTED_CONFIG_KEY)
    if (!Array.isArray(raw)) {
      importedModels = []
      return
    }
    importedModels = raw.filter(isValidStoredModel).map((m) => ({ ...m, imported: true, logo: undefined }))
  } catch {
    importedModels = []
  }
}

/** 持久化当前导入模型列表（内部用） */
async function persistImportedModels(): Promise<void> {
  await dbConfig.set(IMPORTED_CONFIG_KEY, importedModels)
}

/** 注册一个导入模型（id 冲突抛错；成功即持久化并立即可用） */
export async function addImportedModel(model: EmbedModel): Promise<void> {
  if (hasEmbedModelId(model.id)) throw new Error(`模型 id 已存在：${model.id}`)
  importedModels = [...importedModels, { ...model, imported: true, logo: undefined }]
  await persistImportedModels()
}

/** 移除一个导入模型（只移除元数据；模型文件由调用方清理） */
export async function removeImportedModel(id: string): Promise<void> {
  importedModels = importedModels.filter((m) => m.id !== id)
  await persistImportedModels()
}

/** 测试/重置用：清空内存态（不写库） */
export function __resetImportedModelsForTest(): void {
  importedModels = []
}
