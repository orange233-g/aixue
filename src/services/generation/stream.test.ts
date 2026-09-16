import { describe, expect, it } from 'vitest'
import { BatchRawSequencer, MdStreamAccumulator } from './stream'

describe('BatchRawSequencer：并发批次原文按序冲刷', () => {
  it('后完成的批次先到也不能插到前一批中间', () => {
    const seq = new BatchRawSequencer()
    const out: string[] = []
    const emit = (delta: string) => out.push(delta)

    seq.push(1, 'B-题干', '', emit)
    seq.finish(1, emit)
    expect(out).toEqual([])

    seq.push(0, 'A-题干', '', emit)
    seq.finish(0, emit)
    expect(out.join('')).toBe('\n——— 批次 #1 ———\nA-题干\n——— 批次 #2 ———\nB-题干')
  })

  it('同批次多个 token 保持原顺序并合并 reasoning', () => {
    const seq = new BatchRawSequencer()
    const out: Array<[string, string]> = []
    const emit = (delta: string, reasoning: string) => out.push([delta, reasoning])

    seq.push(0, 'A', 'r1', emit)
    seq.push(0, 'B', 'r2', emit)
    expect(out).toEqual([])
    seq.finish(0, emit)
    expect(out).toEqual([['\n——— 批次 #1 ———\nAB', 'r1r2']])
  })
})

describe('MdStreamAccumulator：排序题按统一选项契约采纳', () => {
  const orderBlock = (answer: string, withOptions = true) =>
    [
      '=== 第 1 题 ===',
      '题型：排序题',
      '题干：请按时间先后顺序排列以下事件。',
      ...(withOptions ? ['选项：', 'A. 事件甲', 'B. 事件乙', 'C. 事件丙', 'D. 事件丁'] : []),
      `答案：${answer}`,
      '解析：说明各事件的先后依据。',
      '知识点：历史',
      '难度：2',
    ].join('\n')

  it('把规范排序题完整采纳为 0-based 排列', () => {
    const acc = new MdStreamAccumulator()
    acc.feed(orderBlock('C,A,D,B'))
    acc.finish()

    expect(acc.rejected).toBe(0)
    expect(acc.accepted).toHaveLength(1)
    expect(acc.accepted[0].options).toEqual(['事件甲', '事件乙', '事件丙', '事件丁'])
    expect(acc.accepted[0].answer).toBe('[2,0,3,1]')
  })

  it('在流式阶段拒绝缺少选项的排序题，而不是等到结果页才报错', () => {
    const acc = new MdStreamAccumulator()
    acc.feed(orderBlock('C,A,D,B', false))
    acc.finish()

    expect(acc.accepted).toHaveLength(0)
    expect(acc.stats.invalidByReason['排序题答案必须是选项的完整排列']).toBe(1)
  })
})
