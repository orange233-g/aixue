/**
 * draftValidation 纯测试（TASK-02 必测用例）。
 * 给定一个 draft 对象即可离线断言按钮状态；不依赖 Store/IndexedDB/AI。
 */
import { describe, expect, it } from 'vitest'
import type { DraftValue, GenerationCountPlan, GenerationDraft } from '../../types'
import { evaluateGenerationDraft } from './draftValidation'

const explicit = <T,>(value: T): DraftValue<T> => ({ value, basis: 'user_explicit' })
const inferred = <T,>(value: T): DraftValue<T> => ({ value, basis: 'model_inferred' })

function base(over?: Partial<GenerationDraft>): GenerationDraft {
  return {
    ...createSeed(),
    ...over,
  }
}

function createSeed(): GenerationDraft {
  const now = Date.now()
  return {
    schemaVersion: 2,
    id: 'gd_test',
    sessionId: 's1',
    revision: 1,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
    requirements: [],
    source: {},
    appliedTurnIds: [],
    turnIssues: [],
  }
}

function aiDraft(total: number, over?: Partial<GenerationDraft>): GenerationDraft {
  const countPlan: GenerationCountPlan = { mode: 'ai', total: explicit(total) }
  return base({ topic: explicit('海洋知识'), countPlan, ...over })
}

function customDraft(
  counts: Record<string, number>,
  statedTotal?: number,
  over?: Partial<GenerationDraft>,
): GenerationDraft {
  const countPlan = {
    mode: 'custom',
    typeCounts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, explicit(v)])),
    ...(statedTotal !== undefined ? { statedTotal: explicit(statedTotal) } : {}),
  } as GenerationCountPlan
  return base({ topic: explicit('海洋知识'), countPlan, ...over })
}

function sourceOnlyDraft(over?: Partial<GenerationDraft>): GenerationDraft {
  return base({ countPlan: { mode: 'ai', total: explicit(20) }, source: { sourceMessageId: 'm1' }, ...over })
}

describe('evaluateGenerationDraft · 就绪与缺项', () => {
  it('有主题无数量：not ready，下一问只问数量（TASK-02 必测/P0-04 前置）', () => {
    const d = base({ topic: explicit('海洋知识') })
    const e = evaluateGenerationDraft(d)
    expect(e.ready).toBe(false)
    expect(e.missing.map((i) => i.code)).toEqual(['TOTAL_REQUIRED'])
    expect(e.nextQuestion).toContain('多少道题')
    expect(e.nextQuestion).not.toContain('主题')
  })

  it('有资料和数量、无主题：ready（P0-03）', () => {
    const e = evaluateGenerationDraft(sourceOnlyDraft())
    expect(e.ready).toBe(true)
    expect(e.effectiveTotal).toBe(20)
  })

  it('无主题且空 source（{}）：空对象不算资料来源', () => {
    const e = evaluateGenerationDraft(base({ countPlan: { mode: 'ai', total: explicit(20) } }))
    expect(e.ready).toBe(false)
    expect(e.missing[0].code).toBe('TOPIC_OR_SOURCE_REQUIRED')
  })

  it('kbScope 无有效 volume：不算资料来源', () => {
    const e = evaluateGenerationDraft(
      base({
        countPlan: { mode: 'ai', total: explicit(20) },
        source: { kbScope: { volumes: [] } },
      }),
    )
    expect(e.missing[0].code).toBe('TOPIC_OR_SOURCE_REQUIRED')
  })

  it('20 题 AI 推荐：ready，effectiveTotal 20', () => {
    const e = evaluateGenerationDraft(aiDraft(20))
    expect(e.ready).toBe(true)
    expect(e.effectiveTotal).toBe(20)
    expect(e.missing).toHaveLength(0)
    expect(e.conflicts).toHaveLength(0)
  })

  it('单选10 + 多选5：ready，合计派生 15', () => {
    const e = evaluateGenerationDraft(customDraft({ single: 10, multiple: 5 }))
    expect(e.ready).toBe(true)
    expect(e.effectiveTotal).toBe(15)
  })
})

describe('evaluateGenerationDraft · 冲突（绝不静默夹取）', () => {
  it('总数 20 与分项合计 15 冲突：TOTAL_TYPE_SUM_MISMATCH，提示含两个值与差额和两个选择（P1-05/P1-06）', () => {
    const e = evaluateGenerationDraft(customDraft({ single: 10, multiple: 5 }, 20))
    expect(e.ready).toBe(false)
    expect(e.conflicts).toHaveLength(1)
    expect(e.conflicts[0].code).toBe('TOTAL_TYPE_SUM_MISMATCH')
    expect(e.conflicts[0].message).toContain('20')
    expect(e.conflicts[0].message).toContain('15')
    expect(e.conflicts[0].message).toContain('5')
    expect(e.conflicts[0].message).toContain('全部题型由 AI 安排')
    expect(e.conflicts[0].message).toContain('补齐')
  })

  it('1001 题：TOTAL_OUT_OF_RANGE，effectiveTotal 保留原值 1001，不夹成 1000（P0-16）', () => {
    const e = evaluateGenerationDraft(aiDraft(1001))
    expect(e.ready).toBe(false)
    expect(e.conflicts[0].code).toBe('TOTAL_OUT_OF_RANGE')
    expect(e.effectiveTotal).toBe(1001)
    expect(e.conflicts[0].message).toContain('1001')
  })

  it('单题型 101：TYPE_COUNT_OUT_OF_RANGE（MAX_PER_TYPE=100）', () => {
    const e = evaluateGenerationDraft(customDraft({ single: 101 }))
    expect(e.ready).toBe(false)
    expect(e.conflicts[0].code).toBe('TYPE_COUNT_OUT_OF_RANGE')
    expect(e.conflicts[0].message).toContain('101')
  })

  it('statedTotal 1001：TOTAL_OUT_OF_RANGE，分项合计仍作为 effectiveTotal', () => {
    const e = evaluateGenerationDraft(customDraft({ single: 10 }, 1001))
    expect(e.ready).toBe(false)
    expect(e.conflicts[0].code).toBe('TOTAL_OUT_OF_RANGE')
    expect(e.effectiveTotal).toBe(10)
  })

  it('ai 总数非整数：TOTAL_OUT_OF_RANGE，不产出 effectiveTotal', () => {
    const d = aiDraft(20)
    d.countPlan = { mode: 'ai', total: { value: 20.5, basis: 'user_explicit' } }
    const e = evaluateGenerationDraft(d)
    expect(e.ready).toBe(false)
    expect(e.conflicts[0].code).toBe('TOTAL_OUT_OF_RANGE')
    expect(e.effectiveTotal).toBeUndefined()
  })

  it('数量 basis 为 model_inferred：COUNT_NOT_EXPLICIT 阻断（规则 10）', () => {
    const d = aiDraft(20)
    d.countPlan = { mode: 'ai', total: inferred(20) }
    expect(evaluateGenerationDraft(d).conflicts[0].code).toBe('COUNT_NOT_EXPLICIT')

    const d2 = customDraft({ single: 10 })
    d2.countPlan = { mode: 'custom', typeCounts: { single: inferred(10) } }
    expect(evaluateGenerationDraft(d2).conflicts[0].code).toBe('COUNT_NOT_EXPLICIT')
  })
})

describe('evaluateGenerationDraft · 生命周期与未应用问题', () => {
  it('cancelled / generating：DRAFT_NOT_ACTIVE，不允许重复启动（TASK-02 必测）', () => {
    expect(evaluateGenerationDraft(aiDraft(20, { lifecycle: 'cancelled' })).ready).toBe(false)
    expect(evaluateGenerationDraft(aiDraft(20, { lifecycle: 'cancelled' })).conflicts[0].code).toBe('DRAFT_NOT_ACTIVE')
    expect(evaluateGenerationDraft(aiDraft(20, { lifecycle: 'generating' })).conflicts[0].code).toBe('DRAFT_NOT_ACTIVE')
  })

  it('turnIssues 非空：TURN_UPDATE_NOT_APPLIED 阻断（规则 11，P0-15）', () => {
    const d = aiDraft(20, {
      turnIssues: [{ code: 'TURN_UPDATE_NOT_APPLIED', message: '本轮修改未应用' }],
    })
    const e = evaluateGenerationDraft(d)
    expect(e.ready).toBe(false)
    expect(e.conflicts.map((c) => c.code)).toContain('TURN_UPDATE_NOT_APPLIED')
  })
})

describe('evaluateGenerationDraft · warnings（规则 12）', () => {
  it('model_inferred 主题/要求：进 warnings 不阻断，ready 不受影响', () => {
    const d = base({
      topic: inferred('海洋知识'),
      countPlan: { mode: 'ai', total: explicit(20) },
      requirements: [
        { id: 'r1', value: '难一点', basis: 'model_inferred' },
        { id: 'r2', value: '全部中文', basis: 'user_explicit' },
      ],
    })
    const e = evaluateGenerationDraft(d)
    expect(e.ready).toBe(true)
    expect(e.warnings).toHaveLength(2)
    expect(e.warnings.every((w) => w.message.includes('AI 理解'))).toBe(true)
  })
})

describe('nextQuestion 优先级（冲突修正 > 缺主题/资料 > 缺总题数 > 缺自定义题型）', () => {
  it('同时缺主题和总数：先问主题/资料', () => {
    const e = evaluateGenerationDraft(base())
    expect(e.nextQuestion).toContain('主题')
  })

  it('有主题缺题型分项：问自定义题型', () => {
    const d = base({ topic: explicit('海洋知识'), countPlan: { mode: 'custom', typeCounts: {} } })
    const e = evaluateGenerationDraft(d)
    expect(e.missing[0].code).toBe('CUSTOM_TYPES_REQUIRED')
    expect(e.nextQuestion).toContain('题型')
  })

  it('有冲突时冲突提示优先于缺项', () => {
    const d = customDraft({ single: 10, multiple: 5 }, 20, { lifecycle: 'cancelled' })
    const e = evaluateGenerationDraft(d)
    expect(e.conflicts.length).toBeGreaterThan(0)
    expect(e.nextQuestion).toBe(e.conflicts[0].message)
  })
})
