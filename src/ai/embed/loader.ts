/**
 * embedding 加载器（V-EMB 二期，通用多模型直连版）。
 * 按 registry 元数据分发到通用引擎 runEmbedDirect（onnxruntime-web wasm 变体直连 + 手写
 * WordPiece/BPE tokenizer，模型文件从 IDB 读，离线可用，浏览器/Android WebView/Node 通用）
 * ——bge-small-zh-v1.5 与 Qwen3-Embedding-0.6B 同引擎。不依赖 transformers.js。
 */
import { getEmbedModel } from './registry'
import { runEmbedDirect } from './embedDirect'

/** 模型文件目录 URL（registry sources 第一个源；未配置抛错）。baseUrl 目前仅用于「模型已下载」
 *  判断与下载链路（storage.ensureModelFiles），推理已直接读 IDB。 */
export function modelBaseUrl(modelId: string): string {
  const model = getEmbedModel(modelId)
  const base = model?.sources?.[0]?.baseUrl
  if (!base || base.startsWith('PLACEHOLDER')) {
    throw new Error(`模型下载源未配置（托管后置）：${modelId}`)
  }
  return base.replace(/\/$/, '')
}

/**
 * 批量文本向量化：返回与输入等长的 Float32Array[]，每项为模型的 pooled 向量（已归一化）。
 * 失败（模型缺失/推理异常/网络不可达）向上抛，由调用方决定降级 BM25。
 */
export async function embedTexts(modelId: string, texts: string[]): Promise<Float32Array[]> {
  const model = getEmbedModel(modelId)
  if (!model) throw new Error(`未知 embedding 模型: ${modelId}`)
  if (texts.length === 0) return []
  return runEmbedDirect(model, texts)
}