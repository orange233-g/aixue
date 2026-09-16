import { describe, expect, it } from 'vitest'
import { redactSensitive, redactText } from './log'

describe('V3-S03：日志脱敏——key/authorization/密码完全掩码，不再保留任何字符', () => {
  it('整串即凭证：sk- 前缀 api key 整体替换为 [REDACTED]', () => {
    expect(redactSensitive('sk-abcdef1234567890abcdef')).toBe('[REDACTED]')
  })

  it('整串即凭证：JWT（三段点分隔）整体替换，不保留任何字符', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFghiJKLmnoPQRstuVWXyZ0123456'
    expect(redactSensitive(jwt)).toBe('[REDACTED]')
  })

  it('整串即凭证：Bearer 令牌整体替换', () => {
    expect(redactSensitive('Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456')).toBe('[REDACTED]')
  })

  it('对象字段名命中 secret 键：值整体替换为 [REDACTED]（不再保留首尾 4 位）', () => {
    const out = redactSensitive({ apiKey: 'sk-abc-should-fully-hide', providerId: 'openai' }) as Record<string, unknown>
    expect(out.apiKey).toBe('[REDACTED]')
    expect(out.providerId).toBe('openai')
  })

  it('多厂商 Key 形态统一掩码（authorization / api_key / access_key / token / password）', () => {
    const out = redactSensitive({
      authorization: 'Bearer xyz',
      api_key: 'volc-key-1',
      access_key: 'qwen-secret',
      token: 'k1234567890123456789012',
      password: 'p@ssw0rd',
    }) as Record<string, unknown>
    expect(out.authorization).toBe('[REDACTED]')
    expect(out.api_key).toBe('[REDACTED]')
    expect(out.access_key).toBe('[REDACTED]')
    expect(out.token).toBe('[REDACTED]')
    expect(out.password).toBe('[REDACTED]')
  })

  it('msg 中内嵌 Authorization: Bearer …：只把值替换，标签保留', () => {
    const msg = '上游 401，请求头 Authorization: Bearer sk-verysecretkey123，请重新配置'
    const out = redactText(msg)
    expect(out).toContain('Authorization: Bearer [REDACTED]')
    expect(out).not.toContain('sk-verysecretkey123')
  })

  it('msg 中内嵌 URL 查询参数 api_key=… 被掩码', () => {
    const msg = '调用失败详情 https://gw.example.com/v1?deployment=x&api_key=deadbeefsecret&other=1'
    const out = redactText(msg)
    expect(out).toContain('api_key=[REDACTED]')
    expect(out).not.toContain('deadbeefsecret')
    expect(out).toContain('other=1') // 无关参数保留
  })

  it('data 字符串内嵌 key=… 同样被掩码', () => {
    const out = redactSensitive('report token=abcDEF0123456789 completed') as string
    expect(out).toContain('token=[REDACTED]')
    expect(out).not.toContain('abcDEF0123456789')
  })

  it('普通长字符串（错误消息/生成计划）原样保留，便于排查', () => {
    const normal = 'HTTP 400: 结构解析失败，缺少选项字段（判断题第 3 题）'
    expect(redactText(normal)).toBe(normal)
  })

  it('嵌套对象数组递归脱敏', () => {
    const out = redactSensitive({ arr: [{ secret: 's3cret', name: 'a' }] }) as { arr: { secret: string; name: string }[] }
    expect(out.arr[0].secret).toBe('[REDACTED]')
    expect(out.arr[0].name).toBe('a')
  })

  it('模型名字段仍做定长哈希，不暴露可读明文', () => {
    const a = redactSensitive({ model: 'gpt-4o-mini' }) as Record<string, unknown>
    const b = redactSensitive({ model: 'gpt-4o-mini' }) as Record<string, unknown>
    expect(a.model).toBe(b.model)
    expect(String(a.model)).not.toContain('gpt')
  })
})

describe('V4-S02：深层对象超过深度上限截断，杜绝深层 Key 透传', () => {
  function deepNest(levels: number, leaf: unknown): unknown {
    let node: unknown = leaf
    for (let i = 0; i < levels; i++) node = { next: node }
    return node
  }

  it('七层以上嵌套的 apiKey 被截断为 [TRUNCATED]，不含明文', () => {
    const nested = deepNest(8, { apiKey: 'sk-super-secret-deeply-nested-value-123456' })
    const out = JSON.stringify(redactSensitive(nested))
    expect(out).toContain('[TRUNCATED]')
    expect(out).not.toContain('sk-super-secret-deeply-nested-value-123456')
  })

  it('在深度上限内的 Key 仍被掩码为 [REDACTED]（deepNest(5) 使值位于第 6 层，未触发截断）', () => {
    const nested = deepNest(5, { apiKey: 'sk-not-too-deep-12345678' })
    const out = JSON.stringify(redactSensitive(nested))
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('sk-not-too-deep-12345678')
    expect(out).not.toContain('[TRUNCATED]')
    expect(out).toContain('next')
  })

  it('深层数组中的 token 也被截断，不泄露', () => {
    // 数组本身占 1 层；deepNest(7) 使整个含数组的子结构位于第 7 层，命中截断，杜绝数组中 secret 透传
    const nested = deepNest(7, { arr: ['Bearer abcdefghijk12345', 'k-raw-token-000000000000'] })
    const out = JSON.stringify(redactSensitive(nested))
    expect(out).toContain('[TRUNCATED]')
    expect(out).not.toContain('Bearer abcdefghijk12345')
    expect(out).not.toContain('k-raw-token-000000000000')
  })

  it('深层 authorization 查询串不泄露', () => {
    // a.b/c 各 4 层，进入对象体遍历 keys；authorization 位于第 8 层，命中截断
    const nested = deepNest(4, { b: { c: { authorization: 'Bearer zyx-very-long-secret-0000' } } })
    const out = JSON.stringify(redactSensitive(nested))
    expect(out).not.toContain('zyx-very-long-secret-0000')
  })
})