/**
 * 向量相似度检索纯函数（V-EMB 一期）。
 * 余弦相似度 + topK；向量缺失/维度不齐跳过，供 RRF 融合与纯向量通道使用。
 */

/** 余弦相似度（两向量等长；任一侧全零返回 0） */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 与 query 向量最相似的 topK 个向量下标（按相似度降序；不足 topK 返回全部） */
export function searchVectors(query: Float32Array, vectors: Float32Array[], topK = 4): number[] {
  const scored: { i: number; s: number }[] = []
  for (let i = 0; i < vectors.length; i++) {
    const s = cosine(query, vectors[i])
    if (s > 0) scored.push({ i, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, topK).map((x) => x.i)
}

/** RRF 融合：对若干排名列表（每项为 section 下标）取 Reciprocal Rank Fusion（k=60），返回融合后下标降序 */
export function rrfFusion(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const idx = list[rank]
      score.set(idx, (score.get(idx) ?? 0) + 1 / (k + rank + 1))
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([idx]) => idx)
}
