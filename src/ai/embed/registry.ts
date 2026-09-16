/**
 * 内置 embedding 模型注册表 + 远程清单解析（V-EMB 一期）。
 * 模型元数据内置一份兜底；远程清单（多镜像）可覆盖源 URL/大小/SHA256——
 * 托管地址变动只更新清单文件，不发新版 app（见 docs/embedding-tasks.md 任务 1.2）。
 */
import type { EmbedManifest, EmbedModel } from './types'
// 厂商 logo（Vite 资源管线打包，设置页/建库弹窗头像用）
import qwenLogo from '../../assets/providers/qwen.svg'
import baaiLogo from '../../assets/providers/baai.svg'

/** 内置默认模型（已随 APK 内置：sources.baseUrl 指向 app 自带资产 /models/*，无网络下载；6.87 内置化） */
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
    sources: [
      // 指向 app 自带资产（public/models 打包进 APK，经本地服务器读取），无网络依赖
      {
        baseUrl: '/models/bge',
        files: [
          { name: 'config.json', size: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
          { name: 'onnx/model.onnx', size: 94851877, sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a' },
          { name: 'tokenizer_config.json', size: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
          { name: 'tokenizer.json', size: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
        ],
      },
    ],
    note: '小而快，手机友好，中文场景开箱即用；默认推荐',
  },
  {
    id: 'qwen3-embedding-0.6b',
    name: 'Qwen3-Embedding-0.6B（进阶）',
    developer: '阿里巴巴通义千问团队',
    description:
      '通义千问 2025 年开源的新一代文本表征模型，发布时登顶 MTEB 多语言检索权威榜单（系列 70.58 分）。支持 100+ 语言、32K 长上下文、1024 维向量，召回能力强，适合多语言与长文档知识库；体积较大，建索引较慢。',
    license: 'Apache 2.0',
    logo: qwenLogo,
    dim: 1024,
    pooling: 'last_token',
    normalize: true,
    maxTokens: 32768,
    queryInstruct: 'Given a web search query, retrieve relevant passages that answer the query',
    tokenizer: 'bpe',
    weight: 'onnx/model_quantized.onnx',
    sources: [
      // 指向 app 自带资产（public/models 打包进 APK，经本地服务器读取），无网络依赖
      {
        baseUrl: '/models/qwen3',
        files: [
          { name: 'config.json', size: 1576, sha256: '66a10929782f3c9a3cd5dec90e2a95c60e05736134a63cd54479eeae80bed175' },
          { name: 'onnx/model_quantized.onnx', size: 613527631, sha256: '87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f' },
          { name: 'tokenizer_config.json', size: 9731, sha256: '977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1' },
          { name: 'tokenizer.json', size: 11423705, sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a' },
        ],
      },
    ],
    note: '能力强、多语言、32K 上下文；体积大（约 614MB），手机端较慢，建议桌面/进阶用户',
  },
]

/** 按 id 取模型元数据（未知 id 返回 undefined） */
export function getEmbedModel(id: string): EmbedModel | undefined {
  return EMBED_MODELS.find((m) => m.id === id)
}

/** 解析远程清单 JSON（结构校验失败抛错，调用方捕获后回退内置默认） */
export function parseManifest(json: string): EmbedManifest {
  const raw = JSON.parse(json) as Partial<EmbedManifest>
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error('embed manifest 缺少 models')
  }
  const models: EmbedModel[] = []
  for (const m of raw.models) {
    if (!m.id || !Array.isArray(m.sources) || m.sources.length === 0) {
      throw new Error(`embed manifest 模型条目不合法: ${m?.id ?? 'unknown'}`)
    }
    models.push({
      // 用内置元数据兜底缺失字段（dim/pooling 等模型能力字段以内置为准，防清单被篡改）
      ...(getEmbedModel(m.id) ?? {}),
      ...m,
    } as EmbedModel)
  }
  return { version: raw.version ?? 1, mirrors: raw.mirrors ?? [], models }
}

/** 应用清单覆盖：按 id 替换内置模型的下载源等运行时字段（能力字段已在上层合并） */
export function applyManifest(models: EmbedModel[]): void {
  for (const m of models) {
    const i = EMBED_MODELS.findIndex((x) => x.id === m.id)
    if (i >= 0) EMBED_MODELS[i] = { ...EMBED_MODELS[i], ...m }
  }
}
