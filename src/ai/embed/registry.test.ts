import { describe, expect, it } from 'vitest'
import { EMBED_MODELS, getEmbedModel, parseManifest, applyManifest } from './registry'
import { sha256Hex } from './storage'

describe('registry：内置模型注册表', () => {
  it('内置两个模型（bge 默认 + Qwen3 进阶），字段齐备', () => {
    expect(EMBED_MODELS.length).toBe(2)
    const bge = getEmbedModel('bge-small-zh-v1.5')
    const qwen = getEmbedModel('qwen3-embedding-0.6b')
    expect(bge).toBeDefined()
    expect(qwen).toBeDefined()
    expect(bge?.dim).toBe(512)
    expect(bge?.pooling).toBe('cls')
    expect(qwen?.dim).toBe(1024)
    expect(qwen?.pooling).toBe('last_token')
    expect(qwen?.queryInstruct).toBeTruthy()
  })

  it('未知 id 返回 undefined', () => {
    expect(getEmbedModel('not-exist')).toBeUndefined()
  })

  it('模型介绍元数据齐备（6.87 内置化：开发商 + 特点介绍）', () => {
    for (const m of EMBED_MODELS) {
      expect(m.developer.length).toBeGreaterThan(4)
      expect(m.description.length).toBeGreaterThan(30)
      expect(m.license).toBeTruthy()
      expect(m.note).toBeTruthy()
    }
    expect(getEmbedModel('bge-small-zh-v1.5')?.developer).toContain('智源')
    expect(getEmbedModel('qwen3-embedding-0.6b')?.developer).toContain('通义')
  })

  it('模型已随 APK 内置：sources 指向本地资产路径，无远程 URL（6.87）', () => {
    for (const m of EMBED_MODELS) {
      for (const s of m.sources) {
        expect(s.baseUrl.startsWith('/models/')).toBe(true)
      }
    }
  })
})

describe('registry：远程清单解析', () => {
  it('合法清单解析并合并内置能力字段', () => {
    const json = JSON.stringify({
      version: 2,
      mirrors: ['https://a.example/manifest.json', 'https://b.example/manifest.json'],
      models: [
        { id: 'bge-small-zh-v1.5', sources: [{ baseUrl: 'https://cdn.example.com/bge', files: [{ name: 'model.onnx', sha256: 'abc' }] }] },
      ],
    })
    const manifest = parseManifest(json)
    expect(manifest.version).toBe(2)
    expect(manifest.mirrors.length).toBe(2)
    expect(manifest.models[0].id).toBe('bge-small-zh-v1.5')
    // 能力字段（dim/pooling）由内置兜底合并
    expect(manifest.models[0].dim).toBe(512)
    expect(manifest.models[0].sources[0].baseUrl).toBe('https://cdn.example.com/bge')
  })

  it('缺 models 抛错', () => {
    expect(() => parseManifest('{"version":1}')).toThrow()
  })

  it('模型条目缺 sources 抛错', () => {
    expect(() => parseManifest('{"models":[{"id":"bge-small-zh-v1.5"}]}')).toThrow()
  })
})

describe('storage：SHA256 校验（纯逻辑）', () => {
  it('已知输入输出匹配（Web Crypto）', async () => {
    // 'abc' 的 SHA256
    const hex = await sha256Hex(new TextEncoder().encode('abc'))
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('空输入有确定输出', async () => {
    const hex = await sha256Hex(new Uint8Array(0))
    expect(hex).toHaveLength(64)
  })
})

describe('registry：applyManifest 覆盖运行时字段', () => {
  it('覆盖下载源后内置元数据更新', () => {
    const before = getEmbedModel('bge-small-zh-v1.5')!.sources[0].baseUrl
    applyManifest([
      { ...getEmbedModel('bge-small-zh-v1.5')!, sources: [{ baseUrl: 'https://new.example.com', files: [] }] },
    ])
    expect(getEmbedModel('bge-small-zh-v1.5')!.sources[0].baseUrl).toBe('https://new.example.com')
    // 能力字段不被破坏
    expect(getEmbedModel('bge-small-zh-v1.5')!.dim).toBe(512)
    expect(before).not.toBe('https://new.example.com')
  })
})
