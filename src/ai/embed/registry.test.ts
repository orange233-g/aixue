import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMBED_MODELS,
  __resetImportedModelsForTest,
  addImportedModel,
  getEmbedModel,
  getImportedModels,
  hasEmbedModelId,
  hydrateImportedModels,
  isBuiltinEmbedModel,
  listEmbedModels,
  removeImportedModel,
} from './registry'
import { dbConfig } from '../../db'
import type { EmbedModel } from './types'

const CONFIG_KEY = 'embed:imported-models'

const fakeModel = (id = 'test-embed'): EmbedModel => ({
  id,
  name: '测试模型（进阶）',
  developer: '测试机构',
  description: '仅用于单元测试的假模型元数据。',
  license: 'MIT',
  dim: 8,
  pooling: 'last_token',
  normalize: true,
  maxTokens: 128,
  tokenizer: 'bpe',
  weight: 'onnx/model.onnx',
  files: [{ name: 'onnx/model.onnx', size: 4, sha256: 'a'.repeat(64) }],
  note: '测试用',
})

describe('registry：内置模型注册表', () => {
  beforeEach(async () => {
    __resetImportedModelsForTest()
    await dbConfig.delete(CONFIG_KEY)
  })

  it('内置只有 bge 一个模型，字段齐备', () => {
    expect(EMBED_MODELS).toHaveLength(1)
    const bge = getEmbedModel('bge-small-zh-v1.5')
    expect(bge).toBeDefined()
    expect(bge?.dim).toBe(512)
    expect(bge?.pooling).toBe('cls')
    expect(bge?.tokenizer).toBe('wordpiece')
    expect(bge?.assetDir).toBe('bge')
    expect(bge?.files.length).toBeGreaterThan(0)
    expect(bge?.files.some((f) => f.name === bge.weight)).toBe(true)
  })

  it('内置模型不包含 Qwen3（改为用户在设置页导入）', () => {
    expect(getEmbedModel('qwen3-embedding-0.6b')).toBeUndefined()
    expect(EMBED_MODELS.some((m) => m.id.includes('qwen'))).toBe(false)
  })

  it('未知 id 返回 undefined；内置/导入判定正确', () => {
    expect(getEmbedModel('not-exist')).toBeUndefined()
    expect(isBuiltinEmbedModel('bge-small-zh-v1.5')).toBe(true)
    expect(isBuiltinEmbedModel('test-embed')).toBe(false)
  })

  it('内置模型元数据齐备（开发商/介绍/许可/备注/文件清单）', () => {
    for (const m of EMBED_MODELS) {
      expect(m.developer.length).toBeGreaterThan(4)
      expect(m.description.length).toBeGreaterThan(30)
      expect(m.license).toBeTruthy()
      expect(m.note).toBeTruthy()
      expect(m.files.length).toBeGreaterThan(0)
      for (const f of m.files) {
        expect(f.size).toBeGreaterThan(0)
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
    }
    expect(getEmbedModel('bge-small-zh-v1.5')?.developer).toContain('智源')
  })
})

describe('registry：导入模型的注册与持久化', () => {
  beforeEach(async () => {
    __resetImportedModelsForTest()
    await dbConfig.delete(CONFIG_KEY)
  })

  it('添加后立即进入可用列表，且排在导入区', async () => {
    await addImportedModel(fakeModel())
    expect(listEmbedModels().map((m) => m.id)).toEqual(['bge-small-zh-v1.5', 'test-embed'])
    expect(getEmbedModel('test-embed')?.imported).toBe(true)
    expect(getImportedModels()).toHaveLength(1)
    expect(hasEmbedModelId('test-embed')).toBe(true)
  })

  it('持久化后可在“重启”（清内存 + hydrate）时恢复', async () => {
    await addImportedModel(fakeModel())
    __resetImportedModelsForTest()
    expect(getEmbedModel('test-embed')).toBeUndefined()
    await hydrateImportedModels()
    expect(getEmbedModel('test-embed')?.name).toBe('测试模型（进阶）')
    expect(getEmbedModel('test-embed')?.files).toHaveLength(1)
  })

  it('删除后从列表与持久化中移除', async () => {
    await addImportedModel(fakeModel())
    await removeImportedModel('test-embed')
    expect(getEmbedModel('test-embed')).toBeUndefined()
    __resetImportedModelsForTest()
    await hydrateImportedModels()
    expect(getEmbedModel('test-embed')).toBeUndefined()
  })

  it('id 冲突（内置或已导入）拒绝重复注册', async () => {
    await expect(addImportedModel(fakeModel('bge-small-zh-v1.5'))).rejects.toThrow(/已存在/)
    await addImportedModel(fakeModel('dup'))
    await expect(addImportedModel(fakeModel('dup'))).rejects.toThrow(/已存在/)
  })

  it('损坏的持久化数据被忽略，不影响启动', async () => {
    await dbConfig.set(CONFIG_KEY, [{ id: 'broken' }, null, 'x'])
    await hydrateImportedModels()
    expect(getImportedModels()).toHaveLength(0)
  })
})
