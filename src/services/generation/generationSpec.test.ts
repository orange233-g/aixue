/**
 * generationSpec 纯测试（TASK-02 必测用例）。
 * 验证：ready/revision/资料三重门禁、quick 与 conversation origin 的差异、
 * ai/custom 结构规范化、浅冻结、构建后与原 draft 解耦。
 */
import { describe, expect, it } from 'vitest'
import type { DraftValue, GenerationCountPlan, GenerationDraft, KbScope } from '../../types'
import { zeroStructure } from './structure'
import { evaluateGenerationDraft } from './draftValidation'
import { SOURCE_ONLY_INPUT } from './draftPresentation'
import type { ResolvedGenerationSource } from './generationSource'
import {
  buildGenerationExecutionSpec,
  buildQuickExecutionSpec,
} from './generationSpec'

const explicit = <T,>(value: T): DraftValue<T> => ({ value, basis: 'user_explicit' })

function draft(over?: Partial<GenerationDraft>): GenerationDraft {
  const now = Date.now()
  return {
    schemaVersion: 2,
    id: 'gd_test',
    sessionId: 's1',
    revision: 3,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
    requirements: [],
    source: { sourceMessageId: 'm1' },
    appliedTurnIds: [],
    turnIssues: [],
    ...over,
  }
}

function aiDraft(total: number, over?: Partial<GenerationDraft>): GenerationDraft {
  return draft({
    topic: explicit('海洋知识'),
    countPlan: { mode: 'ai', total: explicit(total) },
    ...over,
  })
}

function customDraft(counts: Record<string, number>, over?: Partial<GenerationDraft>): GenerationDraft {
  return draft({
    topic: explicit('海洋知识'),
    countPlan: {
      mode: 'custom',
      typeCounts: Object.fromEntries(
        Object.entries(counts).map(([k, v]) => [k, explicit(v)]),
      ),
    } as GenerationCountPlan,
    ...over,
  })
}

const OK_SRC: ResolvedGenerationSource = { ok: true, refs: 'REFS_TEXT' }
const BAD_SRC: ResolvedGenerationSource = {
  ok: false,
  issue: { code: 'SOURCE_MISSING', message: '原参考资料已不存在' },
}

describe('buildGenerationExecutionSpec · conversation', () => {
  it('20 题 AI 推荐：ready → spec 总数 20，structure 在 single 位承载总数（TASK-02 必测）', () => {
    const d = aiDraft(20)
    const spec = buildGenerationExecutionSpec(d, 3, OK_SRC)!
    expect(spec).not.toBeNull()
    expect(spec.origin).toEqual({ kind: 'conversation', draftId: 'gd_test', draftRevision: 3, sessionId: 's1' })
    expect(spec.mode).toBe('ai')
    expect(spec.total).toBe(20)
    expect(spec.structure).toEqual({ ...zeroStructure(), single: 20 })
    expect(spec.refs).toBe('REFS_TEXT')
    expect(spec.input).toBe('围绕海洋知识出题')
  })

  it('单选 10 + 多选 5：ready → spec 总数 15，结构精确一致（TASK-02 必测）', () => {
    const d = customDraft({ single: 10, multiple: 5 })
    const spec = buildGenerationExecutionSpec(d, 3, OK_SRC)!
    expect(spec.mode).toBe('custom')
    expect(spec.total).toBe(15)
    expect(spec.structure).toEqual({ ...zeroStructure(), single: 10, multiple: 5 })
  })

  it('总数 20 与分项 15 冲突：not ready → 不构建 spec（TASK-02 必测/P1-05）', () => {
    const d = customDraft({ single: 10, multiple: 5 })
    d.countPlan = {
      mode: 'custom',
      typeCounts: { single: explicit(10), multiple: explicit(5) },
      statedTotal: explicit(20),
    }
    expect(evaluateGenerationDraft(d).ready).toBe(false)
    expect(buildGenerationExecutionSpec(d, 3, OK_SRC)).toBeNull()
  })

  it('1001 题：冲突 → 不构建 spec（P0-16）', () => {
    expect(buildGenerationExecutionSpec(aiDraft(1001), 3, OK_SRC)).toBeNull()
  })

  it('旧 revision 请求：拒绝构建，不启动生成（P0-12）', () => {
    expect(buildGenerationExecutionSpec(aiDraft(20), 2, OK_SRC)).toBeNull()
  })

  it('cancelled / generating：不允许重复启动（TASK-02 必测）', () => {
    expect(buildGenerationExecutionSpec(aiDraft(20, { lifecycle: 'cancelled' }), 3, OK_SRC)).toBeNull()
    expect(buildGenerationExecutionSpec(aiDraft(20, { lifecycle: 'generating' }), 3, OK_SRC)).toBeNull()
  })

  it('资料解析失败（SOURCE_MISSING）：不构建 spec（P0-22）', () => {
    expect(buildGenerationExecutionSpec(aiDraft(20), 3, BAD_SRC)).toBeNull()
  })

  it('turnIssues 未应用：不构建 spec（P0-15）', () => {
    const d = aiDraft(20, { turnIssues: [{ code: 'TURN_UPDATE_NOT_APPLIED', message: 'x' }] })
    expect(buildGenerationExecutionSpec(d, 3, OK_SRC)).toBeNull()
  })

  it('spec 浅冻结：origin 与 structure 均不可变（实施路线 4.6）', () => {
    const spec = buildGenerationExecutionSpec(aiDraft(20), 3, OK_SRC)!
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec.origin)).toBe(true)
    expect(Object.isFrozen(spec.structure)).toBe(true)
  })

  it('构建后修改原 draft 不影响已返回 spec（TASK-02 必测）', () => {
    const d = aiDraft(20)
    const spec = buildGenerationExecutionSpec(d, 3, OK_SRC)!
    d.topic = explicit('数学')
    d.countPlan = { mode: 'ai', total: explicit(99) }
    d.source = {}
    expect(spec.total).toBe(20)
    expect(spec.input).toBe('围绕海洋知识出题')
    expect(spec.refs).toBe('REFS_TEXT')
  })

  it('无主题但有资料：input 使用固定资料主句（P0-03）', () => {
    const d = draft({ countPlan: { mode: 'ai', total: explicit(20) } })
    const spec = buildGenerationExecutionSpec(d, 3, OK_SRC)!
    expect(spec.input).toBe(SOURCE_ONLY_INPUT)
  })

  it('带附加要求：input 拼接用户要求；kbScope 透传', () => {
    const KB: KbScope = {
      volumes: [{ index: 0, kbId: 'kb1', kbName: '库一', start: 0, end: 10, charCount: 10, sectionTitles: [] }],
    }
    const d = aiDraft(20, {
      requirements: [{ id: 'r1', value: '难一点', basis: 'user_explicit' }],
      source: { kbScope: KB },
    })
    const spec = buildGenerationExecutionSpec(d, 3, { ok: true, kbScope: KB })!
    expect(spec.input).toBe('围绕海洋知识出题\n附加要求：\n1. 难一点')
    expect(spec.kbScope).toEqual(KB)
  })
})

describe('buildQuickExecutionSpec · quick', () => {
  it('origin 不伪造 draftId/revision（TASK-02 必测）', () => {
    const spec = buildQuickExecutionSpec('出 20 题', 'ai', { ...zeroStructure(), single: 20 })
    expect(spec.origin).toEqual({ kind: 'quick' })
    expect('draftId' in spec.origin).toBe(false)
    expect(spec.total).toBe(20)
    expect(spec.mode).toBe('ai')
  })

  it('ai 模式恒为零基承载：无论传入结构如何，输出 sum(structure) === total（6.13 回归锚）', () => {
    const spec = buildQuickExecutionSpec('出 20 题', 'ai', { ...zeroStructure(), single: 20 })
    expect(spec.structure).toEqual({ ...zeroStructure(), single: 20 })
    expect(spec.total).toBe(20)
    // 调用方传入带默认残留的结构时：total 以结构合计为准（30），输出仍保持零基+single 不变量；
    // 「不得残留默认值」由 Store 的结构构造负责（6.13 修复点），工厂只保证快照自洽
    const dirty = { ...zeroStructure(), single: 20, judge: 5, fill: 5 }
    const spec2 = buildQuickExecutionSpec('出题', 'ai', dirty)
    const sum = Object.values(spec2.structure).reduce((a, b) => a + b, 0)
    expect(sum).toBe(spec2.total)
    expect(spec2.structure).toEqual({ ...zeroStructure(), single: spec2.total })
  })

  it('custom 模式：结构按用户设置原样承载，总数为合计', () => {
    const structure = { ...zeroStructure(), single: 10, multiple: 5 }
    const spec = buildQuickExecutionSpec('出 15 题', 'custom', structure)
    expect(spec.structure).toEqual(structure)
    expect(spec.total).toBe(15)
  })

  it('refs / kbScope 透传', () => {
    const KB: KbScope = {
      volumes: [{ index: 0, kbId: 'kb1', kbName: '库一', start: 0, end: 10, charCount: 10, sectionTitles: [] }],
    }
    const spec = buildQuickExecutionSpec('x', 'ai', { ...zeroStructure(), single: 20 }, 'R', KB)
    expect(spec.refs).toBe('R')
    expect(spec.kbScope).toEqual(KB)
  })
})
