import { describe, expect, it } from 'vitest'
import { getAdapter, isPresetProvider, listProviders, registerCustomProvider, unregisterCustomProvider } from './index'

describe('自定义提供商适配器注册表', () => {
  it('注册后 getAdapter/listProviders 可见，且为 OpenAI 兼容适配器（defaultBaseUrl=登记地址）', () => {
    const meta = { id: 'cp_test_a', name: '测试中转', baseUrl: 'https://api.example.com/v1' }
    registerCustomProvider(meta)
    const a = getAdapter('cp_test_a')
    expect(a).toBeDefined()
    expect(a!.name).toBe('测试中转')
    expect(a!.defaultBaseUrl).toBe('https://api.example.com/v1')
    expect(listProviders().some((p) => p.id === 'cp_test_a')).toBe(true)
    unregisterCustomProvider('cp_test_a')
    expect(getAdapter('cp_test_a')).toBeUndefined()
  })

  it('预置厂商不可被自定义注册覆盖、不可注销', () => {
    registerCustomProvider({ id: 'deepseek', name: '冒牌', baseUrl: 'https://evil.example.com' })
    expect(getAdapter('deepseek')!.name).toBe('DeepSeek')
    expect(getAdapter('deepseek')!.defaultBaseUrl).not.toBe('https://evil.example.com')
    unregisterCustomProvider('deepseek')
    expect(getAdapter('deepseek')).toBeDefined()
    expect(isPresetProvider('deepseek')).toBe(true)
  })

  it('listProviders 幂等补注册（同 id 重复注册不报错不覆盖）', () => {
    const meta = { id: 'cp_test_b', name: '中转B', baseUrl: 'https://b.example.com/v1' }
    registerCustomProvider(meta)
    registerCustomProvider(meta)
    expect(listProviders().filter((p) => p.id === 'cp_test_b')).toHaveLength(1)
    unregisterCustomProvider('cp_test_b')
  })
})
