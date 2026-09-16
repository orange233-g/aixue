import { describe, it, expect } from 'vitest'
import { normalizeProviderBaseUrl, resolveBaseUrlOrigin, isCustomProviderHost } from './baseUrl'
import { AIError } from './types'

describe('normalizeProviderBaseUrl（V2-I03 / V2-S07）', () => {
  it('去除尾斜杠，避免与下游 /path 拼出双斜杠', () => {
    expect(normalizeProviderBaseUrl('https://api.openai.com/')).toBe('https://api.openai.com')
    expect(normalizeProviderBaseUrl('https://api.deepseek.com/v1////')).toBe('https://api.deepseek.com/v1')
  })

  it('生产仅允许 https，http 抛错（防止明文发送 Authorization）', () => {
    // import.meta.env.DEV 在测试环境为 false → http 一律拒绝
    expect(() => normalizeProviderBaseUrl('http://evil.example.com')).toThrow(AIError)
  })

  it('拒绝非 http(s) 协议', () => {
    expect(() => normalizeProviderBaseUrl('ftp://x.com')).toThrow(AIError)
    expect(() => normalizeProviderBaseUrl('file:///etc/passwd')).toThrow(AIError)
  })

  it('拒绝 URL 内嵌用户名/密码与 fragment', () => {
    expect(() => normalizeProviderBaseUrl('https://user:pass@api.openai.com')).toThrow(AIError)
    const clean = normalizeProviderBaseUrl('https://api.openai.com/v1#frag')
    expect(clean).toBe('https://api.openai.com/v1')
  })

  it('拒绝保留测试域名，避免把明显无效地址保存成可用提供商', () => {
    expect(() => normalizeProviderBaseUrl('https://example.invalid/v1')).toThrow(AIError)
  })

  it('空字符串视为未配置，返回空串', () => {
    expect(normalizeProviderBaseUrl('')).toBe('')
    expect(normalizeProviderBaseUrl('   ')).toBe('')
    expect(normalizeProviderBaseUrl(undefined)).toBe('')
  })
})

describe('resolveBaseUrlOrigin', () => {
  it('解析目标 origin，便于展示「Key 将发送到哪」', () => {
    expect(resolveBaseUrlOrigin('https://api.openai.com/v1')).toBe('https://api.openai.com')
  })
  it('非法或空返回 null', () => {
    expect(resolveBaseUrlOrigin('')).toBeNull()
    expect(resolveBaseUrlOrigin('not a url')).toBeNull()
    expect(resolveBaseUrlOrigin(undefined)).toBeNull()
  })
})

describe('isCustomProviderHost（V4-I01）', () => {
  const mimo = {
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    allowedHosts: ['token-plan-cn.xiaomimimo.com', 'api.xiaomimimo.com'],
  }
  const hunyuan = {
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    allowedHosts: ['api.tencentcloudapi.com', 'hunyuan.tencentcloudapi.com'],
  }
  const deepseek = { defaultBaseUrl: 'https://api.deepseek.com' }

  it('MiMo 填默认国际版 → 不算自定义', () => {
    expect(isCustomProviderHost('https://api.xiaomimimo.com/v1', mimo)).toBe(false)
  })
  it('MiMo 填国内合法别名（V4-I01 修复前的回归） → 不算自定义', () => {
    expect(isCustomProviderHost('https://token-plan-cn.xiaomimimo.com/v1', mimo)).toBe(false)
  })
  it('MiMo 填第三方中转 → 算自定义', () => {
    expect(isCustomProviderHost('https://proxy.attacker.example.com/v1', mimo)).toBe(true)
  })
  it('腾讯混元填国内别名 → 不算自定义', () => {
    expect(isCustomProviderHost('https://hunyuan.tencentcloudapi.com/', hunyuan)).toBe(false)
  })
  it('腾讯混元填第三方中转 → 算自定义', () => {
    expect(isCustomProviderHost('https://tencent-proxy.example.com/v1', hunyuan)).toBe(true)
  })
  it('DeepSeek 无 allowedHosts，填默认 → 不算自定义', () => {
    expect(isCustomProviderHost('https://api.deepseek.com', deepseek)).toBe(false)
  })
  it('DeepSeek 填同域国际版子路径（按 host 比对） → 不算自定义', () => {
    expect(isCustomProviderHost('https://api.deepseek.com/v1', deepseek)).toBe(false)
  })
  it('DeepSeek 填第三方 → 算自定义', () => {
    expect(isCustomProviderHost('https://api.deep-seek.io/v1', deepseek)).toBe(true)
  })
  it('空 / 非法 baseUrl → 不算自定义（让上层走空值兜底，不误弹）', () => {
    expect(isCustomProviderHost('', mimo)).toBe(false)
    expect(isCustomProviderHost('not a url', mimo)).toBe(false)
  })
})
