/**
 * 语义检索 embedding 模型元数据与模型包格式（V-EMB 三期：内置 + 本地导入）。
 *
 * 两种来源：
 * - 内置（bge-small-zh-v1.5）：随 app 分发（public/models/<assetDir>），首次使用时复制到本机缓存。
 * - 导入（如 Qwen3-Embedding-0.6B）：用户从发布页下载 `.aixue-model` 包后，在「我的 → 向量模型 →
 *   添加模型」本地导入；模型文件存本机 IndexedDB，不随 app 分发、不会被自动清理。
 */

/** 默认语义索引模型（内置，与 registry.EMBED_MODELS 第一项保持一致） */
export const DEFAULT_EMBED_MODEL = 'bge-small-zh-v1.5'

/** 关键词检索模式（embed.modelId 特殊值：不使用任何向量模型，纯 BM25） */
export const EMBED_MODE_BM25 = 'bm25'

/** 模型包格式标识（manifest.json 的 format 字段） */
export const MODEL_PACKAGE_FORMAT = 'aixue-embed-model'
/** 当前支持的模型包格式版本 */
export const MODEL_PACKAGE_VERSION = 1

/** 模型单个文件规格（大小 + SHA256 用于导入时校验完整性） */
export interface EmbedFileSpec {
  name: string
  /** 字节数 */
  size: number
  /** SHA256（小写十六进制） */
  sha256: string
}

/** 本地 embedding 模型元数据 */
export interface EmbedModel {
  id: string
  /** 展示名 */
  name: string
  /** 开发机构 */
  developer: string
  /** 模型特点介绍 */
  description: string
  /** 许可证 */
  license: string
  /** 向量维度（bge=512，Qwen3=1024） */
  dim: number
  /** 池化方式：bge 用 cls；Qwen3 用 last_token */
  pooling: 'cls' | 'last_token'
  /** 是否 L2 归一化（检索相似度用余弦） */
  normalize: boolean
  /** 最大输入 token */
  maxTokens: number
  /** 检索指令模板：Qwen3 需 query 前缀 Instruct（bge 无需，为空串） */
  queryInstruct?: string
  /** 分词器规格：wordpiece（BERT 系）/ bpe（Qwen 系） */
  tokenizer: 'wordpiece' | 'bpe'
  /** 推理权重文件（相对模型目录） */
  weight: string
  /** 模型文件清单（含大小与 SHA256） */
  files: EmbedFileSpec[]
  /** 备注/建议场景（设置页小字） */
  note: string
  /** 内置模型：随 app 分发的资产目录（public/models/<assetDir>）；导入模型没有该字段 */
  assetDir?: string
  /** 用户导入的模型：缓存不会被自动清理，只能由用户显式删除 */
  imported?: boolean
  /** 头像图片（内置模型用资源图；导入模型没有，UI 用首字母兜底） */
  logo?: string
}

/** 知识库语义索引状态（KBDoc.embedStatus） */
export type EmbedStatus = 'idle' | 'indexing' | 'ready' | 'error'

/** 模型包 manifest 里的模型元数据（不含文件清单与内置/导入运行时字段） */
export interface ModelPackageModel {
  id: string
  name: string
  developer: string
  description: string
  license: string
  dim: number
  pooling: 'cls' | 'last_token'
  normalize: boolean
  maxTokens: number
  queryInstruct?: string
  tokenizer: 'wordpiece' | 'bpe'
  weight: string
  note: string
}

/** 模型包内的 manifest.json 结构（压缩包根目录） */
export interface ModelPackageManifest {
  format: string
  version: number
  model: ModelPackageModel
  files: EmbedFileSpec[]
}
