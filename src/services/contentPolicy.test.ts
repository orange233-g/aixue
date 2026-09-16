import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { containsSensitive, readBlockPolicy, writeBlockPolicy } from './contentPolicy'

/** node 测试环境无 localStorage，注入内存 mock */
function installLocalStorageMock() {
  const store = new Map<string, string>()
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  ;(globalThis as Record<string, unknown>).localStorage = mock
  return store
}

describe('contentPolicy（W3d 敏感词可配置）', () => {
  beforeAll(() => installLocalStorageMock())
  afterAll(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('默认基线：控制字符 / 乱码被拦截', () => {
    expect(containsSensitive('正常题目内容')).toBe(false)
    expect(containsSensitive('带\u0000控制符')).toBe(true)
    expect(containsSensitive('乱码\uFFFD\uFFFD\uFFFD内容')).toBe(true)
  })

  it('默认无用户词时不误伤正常内容', () => {
    writeBlockPolicy({ words: [] })
    expect(containsSensitive('初二勾股定理的证明过程')).toBe(false)
  })

  it('配置普通敏感词后命中，反之不命中', () => {
    writeBlockPolicy({ words: ['绝密考卷'] })
    expect(containsSensitive('这里提到绝密考卷')).toBe(true)
    expect(containsSensitive('普通模拟试卷')).toBe(false)
  })

  it('/re/ 前缀按正则字面量匹配', () => {
    writeBlockPolicy({ words: ['/\\d{6}/'] })
    expect(containsSensitive('答案编号123456')).toBe(true)
    expect(containsSensitive('没有数字编号')).toBe(false)
  })

  it('非法正则按普通词处理，不抛错', () => {
    writeBlockPolicy({ words: ['/[a-z/'] })
    expect(containsSensitive('普通文本')).toBe(false)
  })

  it('写后读回一致', () => {
    writeBlockPolicy({ words: ['甲', '乙'] })
    const p = readBlockPolicy()
    expect(p.words).toEqual(['甲', '乙'])
  })
})