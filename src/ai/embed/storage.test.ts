import { beforeEach, describe, expect, it } from 'vitest'
import { openDB } from 'idb'
import { gcEmbedCaches, isModelCached, modelFileNames, writeModelFile } from './storage'
import { __resetImportedModelsForTest, addImportedModel } from './registry'
import type { EmbedModel } from './types'

const DB_NAME = 'ai-embed-files'

/** 与 storage.ts 的 getDb 相同的 upgrade 守卫——避免先开出的空库缺 files store */
function openStore() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' })
    },
  })
}

async function clearAll() {
  const db = await openStore()
  await db.clear('files')
}

async function seed(modelId: string) {
  for (const n of modelFileNames(modelId)) {
    await writeModelFile(modelId, n, new Blob(['x']))
  }
}

const importedModel = (id = 'imported-embed'): EmbedModel => ({
  id,
  name: '导入模型',
  developer: '测试',
  description: '测试用',
  license: 'MIT',
  dim: 8,
  pooling: 'cls',
  normalize: true,
  maxTokens: 64,
  tokenizer: 'wordpiece',
  weight: 'onnx/model.onnx',
  files: [{ name: 'onnx/model.onnx', size: 1, sha256: 'b'.repeat(64) }],
  note: '测试',
  imported: true,
})

describe('storage：模型缓存自动清理', () => {
  beforeEach(async () => {
    __resetImportedModelsForTest()
    await clearAll()
  })

  it('无绑定的内置模型缓存被清理，绑定的保留', async () => {
    await seed('bge-small-zh-v1.5')
    expect(await isModelCached('bge-small-zh-v1.5')).toBe(true)
    const removed = await gcEmbedCaches(['bge-small-zh-v1.5'])
    expect(removed).toEqual([])
    expect(await isModelCached('bge-small-zh-v1.5')).toBe(true)

    const removed2 = await gcEmbedCaches([])
    expect(removed2).toEqual(['bge-small-zh-v1.5'])
    expect(await isModelCached('bge-small-zh-v1.5')).toBe(false)
  })

  it('GC 幂等：二次执行无残留可清', async () => {
    await seed('bge-small-zh-v1.5')
    expect(await gcEmbedCaches([])).toEqual(['bge-small-zh-v1.5'])
    expect(await gcEmbedCaches([])).toEqual([])
  })

  it('导入模型是用户主动资产：即使没有知识库绑定也不被自动清理', async () => {
    await addImportedModel(importedModel())
    await seed('imported-embed')
    const removed = await gcEmbedCaches([])
    expect(removed).toEqual([])
    expect(await isModelCached('imported-embed')).toBe(true)
  })

  it('未知模型没有文件清单，不参与缓存判断', async () => {
    expect(modelFileNames('not-exist')).toEqual([])
    expect(await isModelCached('not-exist')).toBe(false)
  })
})
