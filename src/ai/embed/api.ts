/**
 * embedding 适配器接口（V-EMB 一期）。
 * 一期只实现本地（Transformers.js）provider；API provider（OpenAI 兼容 /v1/embeddings，
 * 多厂商适配）二期接入——接口先行，检索层只依赖本接口不感知后端。
 */
import { embedTexts } from './loader'

export interface EmbeddingProvider {
  id: string
  /** 批量文本向量化（输入非空数组，输出等长 Float32Array[]，已按模型归一化） */
  embed(texts: string[]): Promise<Float32Array[]>
  dispose?(): void
}

/** 本地模型 provider：模型文件目录 URL 直连加载（未托管/离线时 embed 抛错，由调用方降级 BM25） */
export function createLocalProvider(modelId: string): EmbeddingProvider {
  return {
    id: modelId,
    async embed(texts) {
      return embedTexts(modelId, texts)
    },
  }
}

/**
 * API embedding provider（二期实现，类型先行）：
 * OpenAI 兼容 POST {baseUrl}/embeddings，body { model, input }，返回 data[].embedding。
 * 约束：一库一模型——该库建索引与检索必须走同一个 provider，向量空间不可混用。
 */
export interface ApiEmbeddingConfig {
  baseUrl: string
  model: string
  apiKey: string
  dim: number
}
export class ApiEmbeddingProvider implements EmbeddingProvider {
  id: string
  constructor(public cfg: ApiEmbeddingConfig) {
    this.id = `api:${cfg.model}`
  }
  // TODO(V-EMB 二期): 实现 OpenAI 兼容 embeddings 调用 + 多厂商适配器（对齐铁律 2，不写死单家）
  async embed(_texts: string[]): Promise<Float32Array[]> {
    throw new Error('API embedding 二期实现')
  }
}
