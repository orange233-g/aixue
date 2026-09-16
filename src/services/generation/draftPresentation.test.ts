/**
 * draftPresentation 纯测试（TASK-02 必测用例）。
 * 验证：字段顺序固定、用户要求全保留、inferred 标记不误标、
 * 下一问固定映射、执行 input 为本地模板且不调用模型。
 */
import { describe, expect, it } from 'vitest'
import type { DraftValue, GenerationCountPlan, GenerationDraft, KbScope } from '../../types'
import { evaluateGenerationDraft } from './draftValidation'
import {
  SOURCE_ONLY_INPUT,
  buildDraftNextQuestion,
  buildGenerationInput,
  generationDraftCardHead,
  formatGenerationDraft,
} from './draftPresentation'

const explicit = <T,>(value: T): DraftValue<T> => ({ value, basis: 'user_explicit' })
const inferred = <T,>(value: T): DraftValue<T> => ({ value, basis: 'model_inferred' })

function draft(over?: Partial<GenerationDraft>): GenerationDraft {
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
    ...over,
  }
}

const KB_SCOPE: KbScope = {
  volumes: [
    { index: 0, kbId: 'kb1', kbName: '库1', start: 0, end: 10, charCount: 10, sectionTitles: [] },
    { index: 1, kbId: 'kb2', kbName: '库2', start: 0, end: 10, charCount: 10, sectionTitles: [] },
  ],
}

describe('formatGenerationDraft · 摘要', () => {
  it('字段顺序固定：主题 → 题量 → 题型 → 对账总数 → 要求 → 资料范围（TASK-02 必测）', () => {
    const d = draft({
      topic: explicit('海洋知识'),
      countPlan: {
        mode: 'custom',
        typeCounts: { single: explicit(10), multiple: explicit(5) },
        statedTotal: explicit(20),
      },
      requirements: [{ id: 'r1', value: '难一点', basis: 'user_explicit' }],
      source: { sourceMessageId: 'm1' },
    })
    const view = formatGenerationDraft(d, evaluateGenerationDraft(d))
    expect(Object.keys(view)).toEqual([
      'lifecycle',
      'revision',
      'topic',
      'totalText',
      'aiTypes',
      'typeCounts',
      'statedTotalText',
      'requirements',
      'sourceSummary',
      'ready',
      'missing',
      'conflicts',
      'warnings',
      'nextQuestion',
    ])
  })

  it('用户要求全部保留且顺序不变（TASK-02 必测）', () => {
    const d = draft({
      topic: explicit('海洋知识'),
      countPlan: { mode: 'ai', total: explicit(20) },
      requirements: [
        { id: 'r1', value: '难一点', basis: 'user_explicit' },
        { id: 'r2', value: '全部中文', basis: 'user_explicit' },
        { id: 'r3', value: '偏重概念', basis: 'user_explicit' },
      ],
    })
    const view = formatGenerationDraft(d, evaluateGenerationDraft(d))
    expect(view.requirements!.map((r) => r.text)).toEqual(['难一点', '全部中文', '偏重概念'])
    expect(view.requirements!.every((r) => !r.inferred)).toBe(true)
  })

  it('model_inferred 字段标记「AI 理解」并携带 warning；user_explicit 不误标（TASK-02 必测）', () => {
    const d = draft({
      topic: inferred('海洋知识'),
      countPlan: { mode: 'ai', total: explicit(20) },
      requirements: [{ id: 'r1', value: '难一点', basis: 'model_inferred' }],
    })
    const e = evaluateGenerationDraft(d)
    const view = formatGenerationDraft(d, e)
    expect(view.topic!.inferred).toBe(true)
    expect(view.requirements![0].inferred).toBe(true)
    expect(view.warnings.length).toBe(2)
    expect(view.warnings.every((w) => w.message.includes('AI 理解'))).toBe(true)

    const d2 = draft({ topic: explicit('海洋知识'), countPlan: { mode: 'ai', total: explicit(20) } })
    const view2 = formatGenerationDraft(d2, evaluateGenerationDraft(d2))
    expect(view2.topic!.inferred).toBe(false)
    expect(view2.warnings).toHaveLength(0)
  })

  it('ai 模式：aiTypes=true，无 typeCounts；totalText 为用户原值', () => {
    const d = draft({ topic: explicit('海洋知识'), countPlan: { mode: 'ai', total: explicit(20) } })
    const view = formatGenerationDraft(d, evaluateGenerationDraft(d))
    expect(view.aiTypes).toBe(true)
    expect(view.typeCounts).toBeUndefined()
    expect(view.totalText).toBe('20')
  })

  it('custom 模式：题型按 QUESTION_TYPES 规范顺序、0 值省略；totalText 为分项合计', () => {
    const d = draft({
      topic: explicit('海洋知识'),
      countPlan: {
        mode: 'custom',
        typeCounts: { essay: explicit(2), single: explicit(3), judge: explicit(0) } as never,
      } as GenerationCountPlan,
    })
    const view = formatGenerationDraft(d, evaluateGenerationDraft(d))
    expect(view.typeCounts!.map((t) => t.id)).toEqual(['single', 'essay'])
    expect(view.typeCounts!.map((t) => t.name)).toEqual(['单选题', '论文题'])
    expect(view.totalText).toBe('5')
    expect(view.aiTypes).toBeUndefined()
  })

  it('custom 有 statedTotal：对账总数单独可见（冲突时不隐藏用户明确总数）', () => {
    const d = draft({
      topic: explicit('海洋知识'),
      countPlan: {
        mode: 'custom',
        typeCounts: { single: explicit(10), multiple: explicit(5) },
        statedTotal: explicit(20),
      },
    })
    const view = formatGenerationDraft(d, evaluateGenerationDraft(d))
    expect(view.totalText).toBe('15')
    expect(view.statedTotalText).toBe('20')
    expect(view.conflicts[0].code).toBe('TOTAL_TYPE_SUM_MISMATCH')
  })

  it('资料范围摘要：消息资料 / 知识库 N 卷 / 组合', () => {
    const m = draft({ source: { sourceMessageId: 'm1' } })
    expect(formatGenerationDraft(m, evaluateGenerationDraft(m)).sourceSummary).toBe('引用消息资料')
    const kb = draft({ source: { kbScope: KB_SCOPE } })
    expect(formatGenerationDraft(kb, evaluateGenerationDraft(kb)).sourceSummary).toBe('知识库 2 卷')
    const both = draft({ source: { sourceMessageId: 'm1', kbScope: KB_SCOPE } })
    expect(formatGenerationDraft(both, evaluateGenerationDraft(both)).sourceSummary).toBe(
      '引用消息资料 + 知识库 2 卷',
    )
  })
})

describe('generationDraftCardHead · 生命周期标题', () => {
  it('completed 优先显示已完成，不被 validator 的 ready=false 误判为整理中', () => {
    expect(generationDraftCardHead('completed', false)).toBe('已完成')
    expect(generationDraftCardHead('generating', false)).toBe('生成中…')
    expect(generationDraftCardHead('active', true)).toBe('准备生成')
    expect(generationDraftCardHead('active', false)).toBe('正在整理生题需求')
  })
})

describe('buildDraftNextQuestion · 固定映射', () => {
  it('冲突优先：返回冲突修正提示', () => {
    const d = draft({
      topic: explicit('海洋知识'),
      countPlan: {
        mode: 'custom',
        typeCounts: { single: explicit(10), multiple: explicit(5) },
        statedTotal: explicit(20),
      },
    })
    const e = evaluateGenerationDraft(d)
    expect(buildDraftNextQuestion(e)).toBe(e.conflicts[0].message)
  })

  it('缺主题/资料 > 缺总数 > 缺题型的固定顺序', () => {
    expect(buildDraftNextQuestion(evaluateGenerationDraft(draft()))).toContain('主题')
    expect(
      buildDraftNextQuestion(evaluateGenerationDraft(draft({ topic: explicit('X') }))),
    ).toContain('多少道题')
    expect(
      buildDraftNextQuestion(
        evaluateGenerationDraft(
          draft({ topic: explicit('X'), countPlan: { mode: 'custom', typeCounts: {} } }),
        ),
      ),
    ).toContain('题型')
  })
})

describe('buildGenerationInput · 本地模板', () => {
  it('主题 + 附加要求稳定拼接，逐条编号（不调用模型）', () => {
    const d = draft({
      topic: explicit('海洋知识'),
      countPlan: { mode: 'ai', total: explicit(20) },
      requirements: [
        { id: 'r1', value: '难一点', basis: 'user_explicit' },
        { id: 'r2', value: '全部中文', basis: 'user_explicit' },
      ],
    })
    expect(buildGenerationInput(d)).toBe('围绕海洋知识出题\n附加要求：\n1. 难一点\n2. 全部中文')
  })

  it('无主题但有资料：使用固定资料主句（P0-03，实施路线 4.6）', () => {
    const d = draft({ countPlan: { mode: 'ai', total: explicit(20) }, source: { sourceMessageId: 'm1' } })
    expect(buildGenerationInput(d)).toBe(SOURCE_ONLY_INPUT)
  })

  it('只有主题无要求：仅主句', () => {
    const d = draft({ topic: explicit('海洋知识'), countPlan: { mode: 'ai', total: explicit(20) } })
    expect(buildGenerationInput(d)).toBe('围绕海洋知识出题')
  })
})
