import { beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { openDB } from 'idb'
import { importModelPackage, parseModelManifest } from './importer'
import { __resetImportedModelsForTest, getEmbedModel, getImportedModels } from './registry'
import { isModelCached, readModelFile, sha256Hex } from './storage'
import { dbConfig } from '../../db'

const sha = async (s: string) => sha256Hex(new TextEncoder().encode(s))

interface PkgFile {
  name: string
  content: string
}

const PKG_FILES: PkgFile[] = [
  { name: 'config.json', content: '{"hidden_size":8}' },
  { name: 'tokenizer.json', content: '{"model":{"type":"BPE"}}' },
  { name: 'onnx/model.onnx', content: 'FAKE-ONNX-WEIGHTS' },
]

async function buildManifest(files: PkgFile[] = PKG_FILES) {
  return {
    format: 'aixue-embed-model',
    version: 1,
    model: {
      id: 'test-embed',
      name: '测试向量模型（进阶）',
      developer: '测试机构',
      description: '仅用于单元测试的模型包。',
      license: 'MIT',
      dim: 8,
      pooling: 'last_token',
      normalize: true,
      maxTokens: 128,
      queryInstruct: 'query:',
      tokenizer: 'bpe',
      weight: 'onnx/model.onnx',
      note: '测试用',
    },
    files: await Promise.all(
      files.map(async (f) => ({ name: f.name, size: strToU8(f.content).byteLength, sha256: await sha(f.content) })),
    ),
  }
}

async function buildZip(manifest: unknown, files: PkgFile[] = PKG_FILES, level: 0 | 6 = 0): Promise<Blob> {
  const entries: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(manifest)) }
  for (const f of files) entries[f.name] = strToU8(f.content)
  return new Blob([zipSync(entries, { level })])
}

async function clearStores() {
  __resetImportedModelsForTest()
  await dbConfig.delete('embed:imported-models')
  const db = await openDB('ai-embed-files', 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' })
    },
  })
  await db.clear('files')
}

describe('importer：manifest 校验', () => {
  it('合法 manifest 解析成功', async () => {
    const m = parseModelManifest(JSON.stringify(await buildManifest()))
    expect(m.model.id).toBe('test-embed')
    expect(m.files).toHaveLength(3)
  })

  it('格式/版本不符直接拒绝', async () => {
    const good = await buildManifest()
    expect(() => parseModelManifest(JSON.stringify({ ...good, format: 'x' }))).toThrow(/不是 ai学/)
    expect(() => parseModelManifest(JSON.stringify({ ...good, version: 99 }))).toThrow(/版本不支持/)
    expect(() => parseModelManifest('not json')).toThrow(/不是合法 JSON/)
  })

  it('拒绝路径穿越与非法 id', async () => {
    const good = await buildManifest()
    const traversal = { ...good, files: [{ ...good.files[0], name: '../evil.onnx' }] }
    expect(() => parseModelManifest(JSON.stringify(traversal))).toThrow(/文件名不合法/)
    const badId = { ...good, model: { ...good.model, id: 'Bad/Id' } }
    expect(() => parseModelManifest(JSON.stringify(badId))).toThrow(/模型 id 不合法/)
  })

  it('权重文件必须在文件清单中', async () => {
    const good = await buildManifest()
    const wrong = { ...good, model: { ...good.model, weight: 'onnx/missing.onnx' } }
    expect(() => parseModelManifest(JSON.stringify(wrong))).toThrow(/不在文件清单/)
  })
})

describe('importer：完整导入流程', () => {
  beforeEach(async () => {
    await clearStores()
  })

  it('导入后模型可用、文件写入本机且内容一致', async () => {
    const zip = await buildZip(await buildManifest())
    const model = await importModelPackage(zip)

    expect(model.id).toBe('test-embed')
    expect(model.imported).toBe(true)
    expect(getEmbedModel('test-embed')?.name).toBe('测试向量模型（进阶）')
    expect(getImportedModels()).toHaveLength(1)
    expect(await isModelCached('test-embed')).toBe(true)

    const bytes = new TextDecoder().decode(await readModelFile('test-embed', 'onnx/model.onnx'))
    expect(bytes).toBe('FAKE-ONNX-WEIGHTS')
  })

  it('报告进度：至少经过校验与写入阶段', async () => {
    const phases = new Set<string>()
    await importModelPackage(await buildZip(await buildManifest()), {
      onProgress: (p) => phases.add(p.phase),
    })
    expect(phases.has('read')).toBe(true)
    expect(phases.has('verify')).toBe(true)
    expect(phases.has('save')).toBe(true)
  })

  it('重复导入同一模型被拒绝', async () => {
    const zip = await buildZip(await buildManifest())
    await importModelPackage(zip)
    await expect(importModelPackage(zip)).rejects.toThrow(/已存在/)
  })

  it('SHA256 不符：导入失败且不留半套文件', async () => {
    const manifest = await buildManifest()
    manifest.files[2].sha256 = 'c'.repeat(64)
    await expect(importModelPackage(await buildZip(manifest))).rejects.toThrow(/SHA256 不符/)
    expect(getEmbedModel('test-embed')).toBeUndefined()
  })

  it('文件大小与清单不符：导入前即拒绝', async () => {
    const manifest = await buildManifest()
    manifest.files[0].size = 999
    await expect(importModelPackage(await buildZip(manifest))).rejects.toThrow(/大小不符/)
  })

  it('压缩格式的模型包给出可操作提示', async () => {
    const zip = await buildZip(await buildManifest(), PKG_FILES, 6)
    await expect(importModelPackage(zip)).rejects.toThrow(/压缩格式/)
  })

  it('缺少 manifest.json：拒绝', async () => {
    const zip = new Blob([zipSync({ 'onnx/model.onnx': strToU8('X') }, { level: 0 })])
    await expect(importModelPackage(zip)).rejects.toThrow(/缺少 manifest\.json/)
  })
})
