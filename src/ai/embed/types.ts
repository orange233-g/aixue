/**
 * 语义检索 embedding 模型元数据与状态类型（V-EMB 一期）。
 * 模型 = 独立文件托管（GitHub Release / 魔搭），app 内多源清单下载 + SHA256 校验 + 本地缓存，
 * 不进 apk、不进开源仓库（见 docs/embedding-tasks.md 决策速查）。
 */

/** 默认语义索引模型（与 registry.EMBED_MODELS 第一项保持一致） */
export const DEFAULT_EMBED_MODEL = 'bge-small-zh-v1.5'

/** 关键词检索模式（embed.modelId 特殊值：不使用任何向量模型，纯 BM25） */
export const EMBED_MODE_BM25 = 'bm25'

/** 模型单个文件规格（相对 baseUrl 下载） */
export interface EmbedFileSpec {
  name: string
  /** 字节数（可选，下载前可校验 Content-Length） */
  size?: number
  /** SHA256（下载后强校验，不符弃用重下） */
  sha256: string
}

/** 模型下载源（多源换源重试：依次尝试，前一个失败自动切下一个）。
 *  文件模式而非 zip 单包：Qwen3 权重 614MB 单文件直链，避免 zip 解压内存峰值（fflate 整包解压 ~2x 内存）。 */
export interface EmbedModelSource {
  /** 文件目录 URL（各文件 = baseUrl + '/' + name） */
  baseUrl: string
  files: EmbedFileSpec[]
}

/** 本地 embedding 模型元数据（内置注册表，见 registry.ts） */
export interface EmbedModel {
  id: string
  /** 展示名（设置页下拉用） */
  name: string
  /** 开发机构（模型介绍页展示，6.87 内置化） */
  developer: string
  /** 模型特点介绍（模型介绍页展示；基于官方发布的权威事实，6.87 内置化） */
  description: string
  /** 许可证（设置页标注；jina v5 因 CC-BY-NC 否决，勿再引入非商用模型） */
  license: string
  /** 向量维度（bge=512，Qwen3=1024） */
  dim: number
  /** 池化方式：bge 用 cls；Qwen3 用 last_token */
  pooling: 'cls' | 'last_token'
  /** 是否需要归一化（检索相似度用余弦，加载时统一 normalize） */
  normalize: boolean
  /** 最大输入 token（锚点策略 ~110 token，均远低于上限） */
  maxTokens: number
  /** 检索指令模板：Qwen3 需 query 前缀 Instruct（bge 无需，为空串） */
  queryInstruct?: string
  /** 分词器规格：决定读 tokenizer.json 构建哪种分词器（bge=BERT WordPiece；Qwen3=ByteLevel BPE） */
  tokenizer: 'wordpiece' | 'bpe'
  /** 推理权重文件（相对模型目录；Qwen3 用 q8 量化，bge 用 fp32） */
  weight: string
  /** 厂商 logo 图片资源（设置页/建库弹窗头像展示） */
  logo: string
  /** 下载源列表（多源换源；托管后置，URL 由清单/配置提供） */
  sources: EmbedModelSource[]
  /** 备注/建议场景（设置页小字） */
  note: string
}

/** 知识库语义索引状态（KBDoc.embedStatus） */
export type EmbedStatus = 'idle' | 'indexing' | 'ready' | 'error'

/** 模型文件清单 JSON（远程可更新：URL 变动只改清单不动 app） */
export interface EmbedManifest {
  version: number
  /** 模型清单下载源列表（多镜像，如 GitHub raw + 魔搭） */
  mirrors: string[]
  models: EmbedModel[]
}
