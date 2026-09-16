import { describe, expect, it } from 'vitest'
import { cosine, searchVectors, rrfFusion } from './searchVec'

describe('cosine：余弦相似度', () => {
  it('同向为 1，反向为 -1', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1)
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1)
  })

  it('垂直为 0', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0)
  })

  it('维度不等返回 0，全零返回 0', () => {
    expect(cosine(Float32Array.from([1]), Float32Array.from([1, 2]))).toBe(0)
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0)
  })
})

describe('searchVectors：向量 topK', () => {
  const query = Float32Array.from([1, 0])
  const vectors = [
    Float32Array.from([0, 1]), // 垂直
    Float32Array.from([3, 0]), // 最相似
    Float32Array.from([0.5, 0.5]), // 中等
  ]

  it('返回按相似度降序的下标', () => {
    expect(searchVectors(query, vectors, 2)).toEqual([1, 2])
  })

  it('topK 不足返回全部（垂直向量 cosine=0 被过滤）', () => {
    // vectors[0]=[0,1] 与 query=[1,0] 垂直 cosine=0，被 s>0 过滤 → 命中 2 条
    expect(searchVectors(query, vectors, 10)).toEqual([1, 2])
  })
})

describe('rrfFusion：多列表融合', () => {
  it('两列表融合排序（k=60 保底第一名）', () => {
    const fused = rrfFusion([
      [0, 1, 2], // BM25 排名
      [2, 0], // 向量排名
    ])
    // 0: 1/61 + 1/62；2: 1/63 + 1/61 → 2 略高；1: 1/62
    expect(fused[0]).toBe(0)
    expect(fused).toContain(1)
    expect(fused).toContain(2)
  })

  it('单列表原序', () => {
    expect(rrfFusion([[3, 1, 2]])).toEqual([3, 1, 2])
  })

  it('空列表返回空', () => {
    expect(rrfFusion([[], []])).toEqual([])
  })
})
