import { describe, expect, it } from 'vitest'
import { extractInlineMatch, resolveMatchCols } from './index'
import type { Question } from '../../types'

/** 匹配题展示兜底：旧数据/异常导入把左右列全塞进题干时的自愈拆分（截图「生活英语词汇」匹配题） */
describe('extractInlineMatch 结合 splitInlineMatch 从题干拆分左右列', () => {
  it('数字序号左项 + 字母序号右项（中英混合、英文内部含空格）', () => {
    const stem = '请将左侧的英文购物用语与右侧对应的中文意思进行匹配。1. On sale 2. Fitting room 3. Cash register 4. Receipt A. 试衣间 B. 收银机 C. 打折出售 D. 收据'
    const r = extractInlineMatch(stem)
    expect(r).not.toBeNull()
    expect(r!.left).toEqual(['On sale', 'Fitting room', 'Cash register', 'Receipt'])
    expect(r!.right).toEqual(['试衣间', '收银机', '打折出售', '收据'])
    expect(r!.head).toBe('请将左侧的英文购物用语与右侧对应的中文意思进行匹配。')
  })

  it('完整中文左右列（数字序号 + 字母序号）', () => {
    const stem = '将左侧与右侧含义匹配。1. 路由 2. 交换 3. 网关 A. 跨网转发 B. 局域网转发 C. 连接网络'
    const r = extractInlineMatch(stem)
    expect(r!.left).toEqual(['路由', '交换', '网关'])
    expect(r!.right).toEqual(['跨网转发', '局域网转发', '连接网络'])
  })

  it('有结构化 options/right 时不做题干拆分，题干原样返回', () => {
    const q: Question = {
      id: 'q1', type: 'match',
      stem: '将左侧术语与右侧含义匹配。',
      options: ['路由', '交换', '网关'],
      answer: JSON.stringify({ right: ['跨网转发', '局域网转发', '连接网络'], pairs: [[0, 0], [1, 1], [2, 2]] }),
    } as Question
    const mc = resolveMatchCols(q)
    expect(mc.left).toEqual(['路由', '交换', '网关'])
    expect(mc.right).toEqual(['跨网转发', '局域网转发', '连接网络'])
    expect(mc.stem).toBe('将左侧术语与右侧含义匹配。')
  })

  it('空 options 题干内嵌列表时兜底拆分，并剥离题干中的列表段', () => {
    const q: Question = {
      id: 'q1', type: 'match',
      stem: '请将左侧的英文购物用语与右侧对应的中文意思进行匹配。1. On sale 2. Fitting room A. 试衣间 B. 收银机',
      answer: JSON.stringify({ pairs: [[0, 0], [1, 1]] }),
    } as Question
    const mc = resolveMatchCols(q)
    expect(mc.left).toEqual(['On sale', 'Fitting room'])
    expect(mc.right).toEqual(['试衣间', '收银机'])
    expect(mc.stem).toBe('请将左侧的英文购物用语与右侧对应的中文意思进行匹配。')
  })

  it('无法识别结构时返回 null，避免误拆正常题干', () => {
    expect(extractInlineMatch('请简述路由与交换的区别。')).toBeNull()
    expect(extractInlineMatch('')).toBeNull()
  })

  it('options 混排左右两列（后半段带数字前缀）时拆成两列', () => {
    const q: Question = {
      id: 'q1', type: 'match',
      stem: '请将左侧的英文医疗症状描述与右侧对应的中文意思进行匹配。',
      options: [
        'I have a headache.'.replace('a headache.', 'a headache'),
        'I feel dizzy.',
        'I have a sore throat.',
        'I have a stomachache.',
        '1. 我喉咙痛。',
        '2. 我头晕。',
        '3. 我胃痛。',
        '4. 我头痛。',
      ],
      answer: JSON.stringify({ pairs: [[0, 3], [1, 1], [2, 0], [3, 2]] }),
    } as Question
    const mc = resolveMatchCols(q)
    expect(mc.left).toEqual(['I have a headache', 'I feel dizzy.', 'I have a sore throat.', 'I have a stomachache.'])
    expect(mc.right).toEqual(['我喉咙痛。', '我头晕。', '我胃痛。', '我头痛。'])
    expect(mc.incomplete).toBeUndefined()
  })

  it('options 只有一列且右列缺失 → 标记 incomplete，不误拆', () => {
    const q: Question = {
      id: 'q1', type: 'match',
      stem: '请将左侧的英文问候语与右侧对应的中文意思进行匹配。',
      options: ['你好吗？', '谢谢你。', '早上好。', '回头见。'],
      answer: '1-C, 2-A, 3-D, 4-B',
    } as Question
    const mc = resolveMatchCols(q)
    expect(mc.incomplete).toBe(true)
  })

  it('options 与 right 全空 → 标记 incomplete', () => {
    const q: Question = { id: 'q1', type: 'match', stem: '匹配题题干', options: undefined, answer: '1-C,2-D' } as Question
    expect(resolveMatchCols(q).incomplete).toBe(true)
  })
})