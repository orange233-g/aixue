import { describe, expect, it } from 'vitest'
import { normalizeCountDraft } from './countInput'

describe('normalizeCountDraft', () => {
  it.each([
    ['', ''],
    ['0', '0'],
    ['000', '0'],
    ['010', '10'],
    ['0.1', '1'],
    ['1.0', '10'],
  ])('将 %s 规范化为 %s', (raw, expected) => {
    expect(normalizeCountDraft(raw)).toBe(expected)
  })
})
