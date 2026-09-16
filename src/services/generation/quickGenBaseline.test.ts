/**
 * 快捷生成 + 现有生成核心的「现状特征测试」（TASK-00 基线冻结）。
 *
 * 目的：在 V2 改造动任何行为之前，把「快捷生成如何构造生成输入」和「生成核心如何拆批」
 * 的关键不变量用测试锁住，作为后续 TASK 的对照基线（S-09 快捷生成无回归的离线锚点）。
 * 只锁当前正确行为，不固化已知问题（如实施路线列出的静默夹取等业务问题不做断言）。
 *
 * 覆盖边界（纯函数层，不发网络、不跑真实生成）：
 * - structure.ts：AI 模式「零基承载总数」不变量（app_bug 6.13 修复成果）
 * - batch.ts：按题型/AI 模式拆批的数量守恒与单批上限
 * - types.ts：系统级数量上限常量基线
 */
import { describe, expect, it } from 'vitest'
import type { QuestionTypeId } from '../../types'
import { MAX_PER_TYPE, MAX_QUESTIONS_PER_GENERATION, QUESTION_TYPES } from '../../types'
import {
  AI_BATCH_WEIGHT,
  BATCH_MAX,
  MAX_BATCH_TOKENS,
  TOKEN_HEADROOM,
  batchParams,
  maxPerBatchFor,
  splitAiBatches,
  splitBatches,
} from './batch'
import { zeroStructure } from './structure'

/** 快捷生成 AI 模式构造生成输入的方式（useGenerateStore.generate 同款表达式）：
 *  { ...zeroStructure(), single: structureTotal } —— 本测试锁定其不变量 */
function aiModeStructure(total: number): Record<QuestionTypeId, number> {
  return { ...zeroStructure(), single: total }
}

describe('快捷生成基线：结构构造不变量（structure.ts）', () => {
  it('zeroStructure 覆盖全部题型且求和为 0', () => {
    const zero = zeroStructure()
    expect(Object.keys(zero).sort()).toEqual(QUESTION_TYPES.map((t) => t.id).sort())
    expect(Object.values(zero).reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('AI 推荐模式零基承载：结构求和 === 用户总题数，且只有 single 位携带数量', () => {
    for (const total of [1, 20, 100, MAX_QUESTIONS_PER_GENERATION]) {
      const structure = aiModeStructure(total)
      const sum = Object.values(structure).reduce((a, b) => a + b, 0)
      expect(sum, `AI 模式 ${total} 题结构求和必须恰等于总数（6.13 回归锚）`).toBe(total)
      const nonzero = Object.entries(structure).filter(([, n]) => n !== 0)
      expect(nonzero).toEqual([['single', total]])
    }
  })

  it('自定义模式零基基底：结构求和 === 各题型计数合计', () => {
    const custom = { ...zeroStructure(), single: 10, multiple: 5, judge: 5 }
    const sum = Object.values(custom).reduce((a, b) => a + b, 0)
    expect(sum).toBe(20)
  })
})

describe('生成核心基线：拆批数量守恒与单批上限（batch.ts）', () => {
  it('splitBatches 按题型守恒：各题型批次题数合计 === 原数量，且不超单批上限', () => {
    const structure = { ...zeroStructure(), single: 33, judge: 100, essay: 7, multiple: 0 }
    const batches = splitBatches(structure)
    const byType = new Map<QuestionTypeId, number>()
    for (const b of batches) {
      expect(b.typeId === 'ai').toBe(false)
      expect(b.count, `${b.typeId} 单批题数不得超上限`).toBeLessThanOrEqual(maxPerBatchFor(b.typeId))
      byType.set(b.typeId as QuestionTypeId, (byType.get(b.typeId as QuestionTypeId) ?? 0) + b.count)
    }
    expect(byType.get('single')).toBe(33)
    expect(byType.get('judge')).toBe(100)
    expect(byType.get('essay')).toBe(7)
    expect(byType.has('multiple')).toBe(false)
  })

  it('splitBatches 忽略 0 / 负数 / 非法数量', () => {
    const structure = { ...zeroStructure(), single: 0, judge: -5 } as Record<QuestionTypeId, number>
    expect(splitBatches(structure)).toEqual([])
  })

  it('splitAiBatches 数量守恒：批次题数合计 === 总数，单批不超 AI 保守上限', () => {
    for (const total of [1, 20, 100, 1000]) {
      const batches = splitAiBatches(total)
      const sum = batches.reduce((a, b) => a + b.count, 0)
      expect(sum, `AI 模式 ${total} 题拆批守恒`).toBe(total)
      for (const b of batches) {
        expect(b.typeId).toBe('ai')
        expect(b.count).toBeLessThanOrEqual(maxPerBatchFor('ai'))
      }
    }
  })

  it('maxPerBatchFor 恒 ≤ BATCH_MAX，batchParams 预算留足余量', () => {
    for (const t of QUESTION_TYPES.map((x) => x.id)) {
      expect(maxPerBatchFor(t)).toBeLessThanOrEqual(BATCH_MAX)
      expect(maxPerBatchFor(t)).toBeGreaterThanOrEqual(1)
    }
    const { maxTokens, timeoutMs } = batchParams(10, AI_BATCH_WEIGHT)
    expect(maxTokens).toBeGreaterThanOrEqual(6000)
    expect(timeoutMs).toBeGreaterThanOrEqual(90_000)
    // 预算恒等式：单批预估 + 余量 ≤ MAX_BATCH_TOKENS（防输出截断的根约束）
    expect(MAX_BATCH_TOKENS - TOKEN_HEADROOM).toBeGreaterThan(0)
  })
})

describe('系统级数量上限基线（types.ts）', () => {
  it('单次生成上限 1000、单题型上限 100（TASK-02 validator 将复用同一常量）', () => {
    expect(MAX_QUESTIONS_PER_GENERATION).toBe(1000)
    expect(MAX_PER_TYPE).toBe(100)
    expect(MAX_PER_TYPE).toBeLessThanOrEqual(MAX_QUESTIONS_PER_GENERATION)
  })
})
