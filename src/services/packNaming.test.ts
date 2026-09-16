import { describe, it, expect } from 'vitest'
import { pickUniqueTitle } from './packNaming'

describe('pickUniqueTitle（W4i 学习本唯一命名）', () => {
  it('空标题回退「未命名学习本」', () => {
    expect(pickUniqueTitle('', [])).toBe('未命名学习本')
    expect(pickUniqueTitle('   ', ['未命名学习本'])).toBe('未命名学习本 (2)')
  })

  it('无同名时原样返回', () => {
    expect(pickUniqueTitle('海洋知识', ['历史', '生物'])).toBe('海洋知识')
  })

  it('第一个同名追加 (2)', () => {
    expect(pickUniqueTitle('海洋知识', ['历史', '海洋知识'])).toBe('海洋知识 (2)')
  })

  it('连续同名递增到不冲突为止', () => {
    const existing = ['海洋知识', '海洋知识 (2)', '海洋知识 (3)']
    expect(pickUniqueTitle('海洋知识', existing)).toBe('海洋知识 (4)')
  })

  it('库里仅有序号残留但无本体时，直接返回本体（不冲突即不复用序号）', () => {
    expect(pickUniqueTitle('海洋知识', ['海洋知识 (2)'])).toBe('海洋知识')
  })
})