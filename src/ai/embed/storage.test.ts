import { beforeEach, describe, expect, it } from 'vitest'
import { openDB } from 'idb'
import { MODEL_FILES, gcEmbedCaches } from './storage'

const DB_NAME = 'ai-embed-files'

/** 与 storage.ts 的 getDb 相同的 upgrade 守卫——避免先开出的空库缺 files store */
function openStore() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' })
    },
  })
}

async function seedAll(modelId: string) {
  const db = await openStore()
  for (const n of MODEL_FILES[modelId]) {
    await db.put('files', { key: `${modelId}/${n}`, blob: new Blob(['x']) })
  }
}

async function clearAll() {
  const db = await openStore()
  await db.clear('files')
}

describe('storage：模型缓存自动清理（6.90 全自动生命周期）', () => {
  beforeEach(async () => {
    await clearAll()
  })

  it('无绑定的模型缓存被清理，绑定的保留', async () => {
    await seedAll('bge-small-zh-v1.5')
    await seedAll('qwen3-embedding-0.6b')
    const removed = await gcEmbedCaches(['bge-small-zh-v1.5'])
    expect(removed).toEqual(['qwen3-embedding-0.6b'])
  })

  it('绑定为空：全部缓存清光（都不再被使用）', async () => {
    await seedAll('bge-small-zh-v1.5')
    await seedAll('qwen3-embedding-0.6b')
    const removed = await gcEmbedCaches([])
    expect(removed.sort()).toEqual(['bge-small-zh-v1.5', 'qwen3-embedding-0.6b'])
  })

  it('未缓存的模型跳过（不报错），GC 幂等可重复执行', async () => {
    await seedAll('bge-small-zh-v1.5')
    expect(await gcEmbedCaches([])).toEqual(['bge-small-zh-v1.5'])
    expect(await gcEmbedCaches([])).toEqual([]) // 二次执行无残留可清
  })
})
