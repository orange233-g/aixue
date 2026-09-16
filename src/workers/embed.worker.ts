/**
 * 语义索引向量化 Worker（V-EMB 一期，仿 kbProcess.worker.ts 模式）：
 * Transformers.js 推理在 WASM 内同步阻塞所在线程，必须放 Worker 避免卡主线程（滚动/点击）。
 * 模型在 worker 生命周期内单例缓存（多批次/多库共用，只加载一次）；模型文件目录 URL 由
 * registry 提供（dev 本地 / 生产托管），fetch 加载失败（离线等）抛错由客户端降级 BM25。
 */
import { embedTexts } from '../ai/embed/loader'

let cachedModelId = ''

self.onmessage = async (e: MessageEvent<{ id: number; modelId: string; texts: string[] }>) => {
  const { id, modelId, texts } = e.data
  try {
    // 触发一次加载（缓存单例），模型不可用（未托管/离线）在此抛错
    if (cachedModelId !== modelId) {
      cachedModelId = modelId
    }
    const vectors = await embedTexts(modelId, texts)
    self.postMessage({
      id,
      ok: true,
      vectors: vectors.map((v) => Array.from(v)),
    } satisfies { id: number; ok: boolean; vectors: number[][] })
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : 'embedding 失败',
    })
  }
}
