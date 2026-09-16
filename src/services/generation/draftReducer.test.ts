/**
 * GenerationDraft reducer 纯测试（TASK-01 必测用例全集）。
 * 不依赖 Zustand、IndexedDB 或 AI；所有输入都是手工构造的领域对象。
 * 对应实施路线 11 节「必测用例」清单 + draftScenarios 中可离线验证的 reducer 级场景。
 */
import { describe, expect, it } from 'vitest'
import type {
  CountPlanPatch,
  DraftIssue,
  DraftPatch,
  DraftSourceAction,
  DraftValue,
  GenerationCountPlan,
  GenerationDraft,
  QuestionTypeId,
} from '../../types'
import {
  applyDraftTurn,
  beginDraftGeneration,
  cancelDraft,
  clearDraftTurnIssues,
  completeDraftGeneration,
  createGenerationDraft,
  failDraftGeneration,
  reopenDraft,
  withDraftTurnIssues,
} from './draftReducer'

/* ---------------- 测试工具 ---------------- */

const explicit = <T,>(value: T, evidence?: string): DraftValue<T> => ({
  value,
  basis: 'user_explicit',
  evidence,
})
const inferred = <T,>(value: T): DraftValue<T> => ({ value, basis: 'model_inferred' })

const KEEP: DraftSourceAction = { kind: 'preserve' }
const CLEAR: DraftSourceAction = { kind: 'clear' }
const SRC_M1: DraftSourceAction = { kind: 'replace', source: { sourceMessageId: 'm1' } }
const SRC_M2: DraftSourceAction = { kind: 'replace', source: { sourceMessageId: 'm2' } }

/** 断言为 custom 模式并收窄类型（避免测试里到处 as） */
function expectCustom(
  cp: GenerationCountPlan | undefined,
): Extract<GenerationCountPlan, { mode: 'custom' }> {
  expect(cp).toBeDefined()
  expect(cp?.mode).toBe('custom')
  if (cp?.mode !== 'custom') throw new Error('expected custom countPlan')
  return cp
}

let turnSeq = 0
function nextTurn(): string {
  turnSeq += 1
  return `t${turnSeq}`
}

function patch(p: Partial<DraftPatch> & { intent: DraftPatch['intent'] }): DraftPatch {
  return {
    schemaVersion: 2,
    turnId: nextTurn(),
    baseRevision: 0,
    appendRequirements: [],
    removeRequirementIds: [],
    ...p,
  }
}

/** 造一份「海洋知识 · ai/20 · rev1」的活动草稿 */
function seedAi20(over?: Partial<GenerationDraft>): GenerationDraft {
  const base = createGenerationDraft('s1', { sourceMessageId: 'm1' })
  const d: GenerationDraft = {
    ...base,
    ...over,
    topic: over?.topic ?? explicit('海洋知识'),
    countPlan:
      over?.countPlan ??
      ({ mode: 'ai', total: explicit(20, '20题') } satisfies GenerationCountPlan),
  }
  return d
}

function seedCustom(
  typeCounts: Record<string, number>,
  statedTotal?: number,
  over?: Partial<GenerationDraft>,
): GenerationDraft {
  const counts: GenerationCountPlan = {
    mode: 'custom',
    typeCounts: Object.fromEntries(
      Object.entries(typeCounts).map(([k, v]) => [k, explicit(v)]),
    ) as Partial<Record<QuestionTypeId, DraftValue<number>>>,
    ...(statedTotal !== undefined ? { statedTotal: explicit(statedTotal) } : {}),
  }
  return {
    ...createGenerationDraft('s1'),
    ...over,
    topic: over?.topic ?? explicit('海洋知识'),
    countPlan: counts,
  }
}

/* ============================ 创建与首轮 ============================ */

describe('createGenerationDraft', () => {
  it('初始空白：rev=1、active、countPlan/topic 为 undefined、不用默认 20 题冒充', () => {
    const d = createGenerationDraft('s1')
    expect(d.schemaVersion).toBe(2)
    expect(d.sessionId).toBe('s1')
    expect(d.revision).toBe(1)
    expect(d.lifecycle).toBe('active')
    expect(d.topic).toBeUndefined()
    expect(d.countPlan).toBeUndefined()
    expect(d.requirements).toEqual([])
    expect(d.source).toEqual({})
    expect(d.appliedTurnIds).toEqual([])
    expect(d.turnIssues).toEqual([])
  })

  it('可带初始 source（创建时已知资料）', () => {
    const d = createGenerationDraft('s1', { sourceMessageId: 'm1' })
    expect(d.source.sourceMessageId).toBe('m1')
  })
})

describe('reopenDraft · 完成态重新生题', () => {
  it('completed → active，递增 revision 并清理旧轮次问题', () => {
    const d = seedAi20({
      lifecycle: 'completed',
      revision: 4,
      turnIssues: [{ code: 'TURN_UPDATE_NOT_APPLIED', message: '旧问题' }],
    })
    const next = reopenDraft(d)
    expect(next.lifecycle).toBe('active')
    expect(next.revision).toBe(5)
    expect(next.turnIssues).toEqual([])
    expect(reopenDraft(next)).toBe(next)
  })
})

describe('applyDraftTurn · 首轮创建（P0-01/P0-02、必测「首轮」组）', () => {
  it('首轮创建主题和总数：rev=1 active，topic + ai/20', () => {
    const next = applyDraftTurn(
      null,
      patch({
        intent: 'update',
        topic: { kind: 'set', field: explicit('牛顿第二定律', '围绕牛顿第二定律') },
        countPlan: { kind: 'set_ai', total: explicit(20, '20题') },
      }),
      CLEAR,
      's1',
    )
    expect(next).not.toBeNull()
    expect(next!.revision).toBe(1)
    expect(next!.lifecycle).toBe('active')
    expect(next!.topic?.value).toBe('牛顿第二定律')
    expect(next!.topic?.basis).toBe('user_explicit')
    expect(next!.countPlan).toEqual({ mode: 'ai', total: explicit(20, '20题') })
    expect(next!.appliedTurnIds).toEqual([next!.appliedTurnIds[0]])
  })

  it('首轮只有明确生题意图、字段尚缺（只有主题）：仍创建 active rev=1', () => {
    const next = applyDraftTurn(
      null,
      patch({ intent: 'update', topic: { kind: 'set', field: explicit('海洋知识') } }),
      CLEAR,
      's1',
    )
    expect(next).not.toBeNull()
    expect(next!.revision).toBe(1)
    expect(next!.countPlan).toBeUndefined()
  })

  it('首轮空操作不创建草稿（不得只为空操作创建）', () => {
    const next = applyDraftTurn(null, patch({ intent: 'update' }), CLEAR, 's1')
    expect(next).toBeNull()
  })

  it('纯聊天不创建草稿（P0-09/P1-14 reducer 层）', () => {
    const next = applyDraftTurn(
      null,
      patch({ intent: 'chat', topic: { kind: 'set', field: explicit('不该出现') } }),
      CLEAR,
      's1',
    )
    expect(next).toBeNull()
  })

  it('无草稿时「取消」不创建 cancelled 空草稿（实施路线 6.3 规则 7）', () => {
    expect(applyDraftTurn(null, patch({ intent: 'cancel' }), CLEAR, 's1')).toBeNull()
  })

  it('首轮带资料创建：source 一次性写入（P0-03）', () => {
    const next = applyDraftTurn(
      null,
      patch({ intent: 'update', countPlan: { kind: 'set_ai', total: explicit(20) } }),
      SRC_M1,
      's1',
    )
    expect(next!.source).toEqual({ sourceMessageId: 'm1' })
  })
})

/* ============================ 字段合并与优先级 ============================ */

describe('applyDraftTurn · 字段合并', () => {
  it('第二轮只改总数，主题保持（P0-06）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(30, '改成30题') } }),
      KEEP,
    )
    expect(next!.revision).toBe(2)
    expect(next!.topic).toEqual(explicit('海洋知识'))
    expect(next!.countPlan).toEqual({ mode: 'ai', total: explicit(30, '改成30题') })
    expect(next!.source).toEqual({ sourceMessageId: 'm1' })
  })

  it('第二轮只加难度要求，数量保持（P1-03 reducer 层）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, appendRequirements: [explicit('难一点')] }),
      KEEP,
    )
    expect(next!.revision).toBe(2)
    expect(next!.countPlan).toEqual({ mode: 'ai', total: explicit(20, '20题') })
    expect(next!.requirements).toHaveLength(1)
    expect(next!.requirements[0].value).toBe('难一点')
    expect(next!.requirements[0].id).toBeTruthy()
  })

  it('「删掉判断题」能 unset 指定题型，其余保持（P0-07）', () => {
    const d = seedCustom({ single: 10, multiple: 5, judge: 5 }, undefined, { revision: 2 })
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'patch_custom', set: {}, unset: ['judge'] } }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({
      mode: 'custom',
      typeCounts: { single: explicit(10), multiple: explicit(5) },
    })
  })

  it('patch_custom 局部 set 覆盖一项、未提到的题型保持（P0-07 合并面）', () => {
    const d = seedCustom({ single: 10, multiple: 5, judge: 5 }, undefined, { revision: 2 })
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 2,
        countPlan: { kind: 'patch_custom', set: { multiple: explicit(8) }, unset: ['judge'] },
      }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({
      mode: 'custom',
      typeCounts: { single: explicit(10), multiple: explicit(8) },
    })
  })

  it('set_custom 完整替换：未列出的旧题型不保留（实施路线 4.3）', () => {
    const d = seedCustom({ single: 10, judge: 5 }, undefined, { revision: 2 })
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'set_custom', typeCounts: { multiple: explicit(8) } } }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({ mode: 'custom', typeCounts: { multiple: explicit(8) } })
  })

  it('patch_custom 在非 custom 草稿上为无操作（防越界，上游应已拦）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'patch_custom', set: { single: explicit(5) }, unset: [] } }),
      KEEP,
    )
    expect(next).toBe(d)
  })

  it('模型 inferred 不能覆盖旧 user_explicit 主题（实施路线 4.4）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, topic: { kind: 'set', field: inferred('数学难题') } }),
      KEEP,
    )
    expect(next).toBe(d)
  })

  it('当前用户明确「改成 30」可覆盖旧 user_explicit 20（实施路线 4.4）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(30) } }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({ mode: 'ai', total: explicit(30) })
  })

  it('草稿不保存 0 题型数量：0 值分项被过滤（实施路线 4.4，P1-13 前置）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 1,
        countPlan: { kind: 'set_custom', typeCounts: { single: explicit(10), multiple: explicit(0) } },
      }),
      KEEP,
    )
    // ai → custom 时旧明确 total 20 自动转为 statedTotal 对账（4.2 题数模式切换表）
    expect(next!.countPlan).toEqual({
      mode: 'custom',
      typeCounts: { single: explicit(10) },
      statedTotal: explicit(20, '20题'),
    })
  })

  it('topic unset 删除主题字段', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, topic: { kind: 'unset' } }),
      KEEP,
    )
    expect(next!.topic).toBeUndefined()
    expect(next!.revision).toBe(2)
  })
})

/* ============================ 题数模式切换表（实施路线 4.2） ============================ */

describe('applyDraftTurn · 题数模式切换', () => {
  it('ai → custom：旧明确 total 转为 statedTotal 对账（P1-05 reducer 层）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 1,
        countPlan: { kind: 'set_custom', typeCounts: { single: explicit(10), multiple: explicit(5) } },
      }),
      KEEP,
    )
    const cp = expectCustom(next!.countPlan)
    expect(cp.statedTotal).toEqual(explicit(20, '20题'))
  })

  it('ai → custom：本轮重述总数则覆盖 statedTotal', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 1,
        countPlan: { kind: 'set_custom', typeCounts: { single: explicit(10) }, statedTotal: explicit(25) },
      }),
      KEEP,
    )
    expect(next!.countPlan).toMatchObject({ statedTotal: explicit(25) })
  })

  it('ai → custom：明确「不再限定总数」才清除（unsetStatedTotal）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 1,
        countPlan: { kind: 'set_custom', typeCounts: { single: explicit(10) }, unsetStatedTotal: true },
      }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({ mode: 'custom', typeCounts: { single: explicit(10) } })
  })

  it('custom → ai 未重述总数：取分项合计并标 app_derived（P1-04）', () => {
    const d = seedCustom({ single: 10, multiple: 5 }, undefined, { revision: 2 })
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'set_ai' } }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({ mode: 'ai', total: { value: 15, basis: 'app_derived' } })
  })

  it('custom → ai 后，后续 user_explicit 总数可覆盖 app_derived（实施路线 11 节必测）', () => {
    const d = seedCustom({ single: 10, multiple: 5 }, undefined, { revision: 2 })
    const first = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'set_ai' } }),
      KEEP,
    )
    const second = applyDraftTurn(
      first!,
      patch({ intent: 'update', baseRevision: 3, countPlan: { kind: 'set_ai', total: explicit(20) } }),
      KEEP,
    )
    expect(second!.countPlan).toEqual({ mode: 'ai', total: explicit(20) })
  })

  it('custom 的 statedTotal 与分项冲突时保留两者，不静默选一边（validator 报错由 TASK-02）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 1,
        countPlan: {
          kind: 'set_custom',
          typeCounts: { single: explicit(10), multiple: explicit(5) },
          statedTotal: explicit(20),
        },
      }),
      KEEP,
    )
    const cp = expectCustom(next!.countPlan)
    expect(cp.statedTotal).toEqual(explicit(20))
    expect(cp.typeCounts.single).toEqual(explicit(10))
    expect(cp.typeCounts.multiple).toEqual(explicit(5))
  })

  it('custom 重新分配（set_custom）保留旧 statedTotal 对账约束（用户未修改的字段不丢）', () => {
    const d = seedCustom({ single: 10, multiple: 5 }, 20, { revision: 2 })
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'set_custom', typeCounts: { single: explicit(10), judge: explicit(10) } } }),
      KEEP,
    )
    expect(next!.countPlan).toMatchObject({
      mode: 'custom',
      statedTotal: explicit(20),
      typeCounts: { single: explicit(10), judge: explicit(10) },
    })
  })

  it('patch_custom.unsetStatedTotal 清除 statedTotal，分项保持（P1-11）', () => {
    const d = seedCustom({ single: 10, multiple: 5 }, 20, { revision: 2 })
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 2,
        countPlan: { kind: 'patch_custom', set: {}, unset: [], unsetStatedTotal: true },
      }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({ mode: 'custom', typeCounts: { single: explicit(10), multiple: explicit(5) } })
  })

  it('无 countPlan 时「题型你安排」（set_ai 无 total）：countPlan 保持未完成，不编造总数', () => {
    const d = createGenerationDraft('s1')
    const withTopic = applyDraftTurn(
      d,
      patch({ intent: 'update', topic: { kind: 'set', field: explicit('海洋') } }),
      CLEAR,
      's1',
    )
    const next = applyDraftTurn(
      withTopic!,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai' } }),
      KEEP,
    )
    expect(next!.countPlan).toBeUndefined()
  })
})

/* ============================ requirements 去重与删除 ============================ */

describe('applyDraftTurn · 附加要求', () => {
  it('规范化去重：空白差异的重复要求不重复追加，语义不同的要求保留（实施路线 11 节步骤 9）', () => {
    const d = seedAi20()
    const first = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, appendRequirements: [explicit('难度偏难')] }),
      KEEP,
    )
    const second = applyDraftTurn(
      first!,
      patch({ intent: 'update', baseRevision: 2, appendRequirements: [explicit('难度  偏难 ')] }),
      KEEP,
    )
    // 重复要求被去重 → 本轮无状态变化 → 返回原引用且 revision 不递增（11 节步骤 13）
    expect(second).toBe(first)
    expect(first!.requirements).toHaveLength(1)
    const third = applyDraftTurn(
      second!,
      patch({ intent: 'update', baseRevision: second!.revision, appendRequirements: [explicit('全部中文')] }),
      KEEP,
    )
    expect(third!.requirements).toHaveLength(2)
  })

  it('撤销某条附加要求：精确删除，不清空全部（P1-07）', () => {
    const d = seedAi20()
    const first = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, appendRequirements: [explicit('难度偏难'), explicit('全部中文')] }),
      KEEP,
    )
    const targetId = first!.requirements.find((r) => r.value === '难度偏难')!.id
    const second = applyDraftTurn(
      first!,
      patch({ intent: 'update', baseRevision: 2, removeRequirementIds: [targetId] }),
      KEEP,
    )
    expect(second!.requirements.map((r) => r.value)).toEqual(['全部中文'])
  })

  it('删除不存在的 requirement id：无状态变化，返回原引用', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, removeRequirementIds: ['req_nonexistent'] }),
      KEEP,
    )
    expect(next).toBe(d)
  })
})

/* ============================ source 合并（实施路线 5.4） ============================ */

describe('applyDraftTurn · source', () => {
  it('update 无新资料（preserve）：完整保留旧 source（P0-18）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(30) } }),
      KEEP,
    )
    expect(next!.source).toEqual({ sourceMessageId: 'm1' })
  })

  it('update 带新资料：整体替换旧 source（P0-21）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(30) } }),
      SRC_M2,
    )
    expect(next!.source).toEqual({ sourceMessageId: 'm2' })
    expect(next!.revision).toBe(2)
  })

  it('update 明确清除资料：source 变空', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1 }),
      CLEAR,
    )
    expect(next!.source).toEqual({})
    expect(next!.revision).toBe(2)
  })

  it('replace 默认不继承旧 source（P0-24）', () => {
    const d = seedAi20({ revision: 3 })
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'replace',
        baseRevision: 3,
        topic: { kind: 'set', field: explicit('光合作用') },
        countPlan: { kind: 'set_ai', total: explicit(15) },
      }),
      CLEAR,
    )
    expect(next!.id).not.toBe(d.id)
    expect(next!.revision).toBe(1)
    expect(next!.topic?.value).toBe('光合作用')
    expect(next!.source).toEqual({})
  })

  it('replace 明确「沿用原资料」（preserve）：复制旧 source（P0-25）', () => {
    const d = seedAi20({ revision: 3 })
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'replace',
        baseRevision: 3,
        topic: { kind: 'set', field: explicit('光合作用') },
        countPlan: { kind: 'set_ai', total: explicit(15) },
      }),
      KEEP,
    )
    expect(next!.source).toEqual(d.source)
  })

  it('replace 空操作不销毁旧方案', () => {
    const d = seedAi20({ revision: 3 })
    const next = applyDraftTurn(d, patch({ intent: 'replace', baseRevision: 3 }), CLEAR)
    expect(next).toBe(d)
  })

  it('replace 后旧 draft 对象保持原样（不可变）', () => {
    const d = seedAi20({ revision: 3 })
    const snapshot = JSON.stringify(d)
    applyDraftTurn(
      d,
      patch({
        intent: 'replace',
        baseRevision: 3,
        topic: { kind: 'set', field: explicit('光合作用') },
        countPlan: { kind: 'set_ai', total: explicit(15) },
      }),
      CLEAR,
    )
    expect(JSON.stringify(d)).toBe(snapshot)
  })
})

/* ============================ 门禁：防重 / 迟到 / 复活 ============================ */

describe('applyDraftTurn · 门禁', () => {
  it('重复 turnId 幂等：第二次返回原引用、revision 不变（实施路线 11 节必测）', () => {
    const d = seedAi20()
    const p = patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(30) } })
    const first = applyDraftTurn(d, p, KEEP)
    expect(first!.revision).toBe(2)
    const second = applyDraftTurn(first!, p, KEEP)
    expect(second).toBe(first)
  })

  it('旧 baseRevision 补丁被拒绝（迟到响应）', () => {
    const d = seedAi20({ revision: 3 })
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'set_ai', total: explicit(99) } }),
      KEEP,
    )
    expect(next).toBe(d)
  })

  it('expectedDraftId 不匹配被拒绝（防异草稿串写）', () => {
    const d = seedAi20({ revision: 3 })
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'update',
        baseRevision: 3,
        expectedDraftId: 'gd_other',
        countPlan: { kind: 'set_ai', total: explicit(99) },
      }),
      KEEP,
    )
    expect(next).toBe(d)
  })

  it('取消后迟到 patch 不能复活（P0-13 reducer 层）', () => {
    const d = seedAi20({ revision: 2 })
    const cancelled = cancelDraft(d)
    expect(cancelled.revision).toBe(3)
    const late = applyDraftTurn(
      cancelled,
      patch({ intent: 'update', baseRevision: 3, countPlan: { kind: 'set_ai', total: explicit(30) } }),
      KEEP,
    )
    expect(late).toBe(cancelled)
    expect(late!.lifecycle).toBe('cancelled')
  })

  it('generating 中的 update/replace 不生效（生成中不改需求）', () => {
    const d = seedAi20()
    const generating = beginDraftGeneration(d)
    const next = applyDraftTurn(
      generating,
      patch({ intent: 'update', baseRevision: 2, countPlan: { kind: 'set_ai', total: explicit(30) } }),
      KEEP,
    )
    expect(next).toBe(generating)
  })

  it('普通聊天 patch 不改变 draft（P0-09 reducer 层）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({
        intent: 'chat',
        baseRevision: 1,
        topic: { kind: 'set', field: explicit('不该改') },
        countPlan: { kind: 'set_ai', total: explicit(99) } as CountPlanPatch,
      }),
      SRC_M2,
    )
    expect(next).toBe(d)
  })

  it('无草稿且未提供 sessionId 时 update 返回 null（防悬空创建）', () => {
    const next = applyDraftTurn(
      null,
      patch({ intent: 'update', topic: { kind: 'set', field: explicit('X') } }),
      CLEAR,
    )
    expect(next).toBeNull()
  })
})

/* ============================ 生命周期动作 ============================ */

describe('生命周期动作（实施路线 11 节步骤 4）', () => {
  it('cancelDraft：active → cancelled，revision +1', () => {
    const d = seedAi20()
    const next = cancelDraft(d)
    expect(next.lifecycle).toBe('cancelled')
    expect(next.revision).toBe(2)
    expect(d.lifecycle).toBe('active')
  })

  it('cancelDraft：cancelled/completed 保持原引用', () => {
    const done = completeDraftGeneration(beginDraftGeneration(seedAi20()))
    expect(cancelDraft(done)).toBe(done)
  })

  it('begin → complete → 正常收尾链', () => {
    const d = seedAi20()
    const generating = beginDraftGeneration(d)
    expect(generating.lifecycle).toBe('generating')
    expect(generating.revision).toBe(2)
    const done = completeDraftGeneration(generating)
    expect(done.lifecycle).toBe('completed')
    expect(done.revision).toBe(3)
  })

  it('beginDraftGeneration 防双击：generating 上再次 begin 返回原引用（P0-14 reducer 层）', () => {
    const d = seedAi20()
    const g1 = beginDraftGeneration(d)
    const g2 = beginDraftGeneration(g1)
    expect(g2).toBe(g1)
  })

  it('failDraftGeneration：首次请求前失败恢复 active 保留可重试信息（TASK-08 契约）', () => {
    const d = seedAi20()
    const generating = beginDraftGeneration(d)
    const restored = failDraftGeneration(generating)
    expect(restored.lifecycle).toBe('active')
    expect(restored.revision).toBe(3)
    expect(restored.topic).toEqual(d.topic)
    expect(restored.countPlan).toEqual(d.countPlan)
    expect(failDraftGeneration(d)).toBe(d) // 非 generating 无操作
  })
})

/* ============================ turnIssues 元数据 ============================ */

describe('turnIssues（实施路线 4.2 约束 10 / 11 节步骤 11）', () => {
  const issue: DraftIssue = { code: 'TURN_UPDATE_NOT_APPLIED', message: '本轮修改未应用' }

  it('withDraftTurnIssues 写入问题但不增加 revision', () => {
    const d = seedAi20()
    const next = withDraftTurnIssues(d, [issue])
    expect(next.turnIssues).toEqual([issue])
    expect(next.revision).toBe(d.revision)
  })

  it('clearDraftTurnIssues 清空且不增加 revision；空时返回原引用', () => {
    const d = withDraftTurnIssues(seedAi20(), [issue])
    const cleared = clearDraftTurnIssues(d)
    expect(cleared.turnIssues).toEqual([])
    expect(cleared.revision).toBe(d.revision)
    expect(clearDraftTurnIssues(cleared)).toBe(cleared)
  })

  it('成功更新自动清空上一轮 turnIssues（实施路线 4.2 约束 10）', () => {
    const d = withDraftTurnIssues(seedAi20(), [issue])
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(30) } }),
      KEEP,
    )
    expect(next!.turnIssues).toEqual([])
    expect(next!.revision).toBe(2)
  })

  it('本轮未应用（无变化）时 turnIssues 保留', () => {
    const d = withDraftTurnIssues(seedAi20(), [issue])
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(20) } }),
      KEEP,
    )
    expect(next).toBe(d)
    expect(next!.turnIssues).toEqual([issue])
  })
})

/* ============================ 审计与边界 ============================ */

describe('审计与边界', () => {
  it('appliedTurnIds 只保留最近 20 条（实施路线 4.2 约束 9）', () => {
    let d: GenerationDraft | null = applyDraftTurn(
      null,
      patch({ intent: 'update', topic: { kind: 'set', field: explicit('海洋') }, countPlan: { kind: 'set_ai', total: explicit(1) } }),
      CLEAR,
      's1',
    )
    for (let i = 0; i < 25; i++) {
      d = applyDraftTurn(
        d,
        patch({ intent: 'update', baseRevision: d!.revision, countPlan: { kind: 'set_ai', total: explicit(i + 2) } }),
        KEEP,
      )
    }
    expect(d!.appliedTurnIds).toHaveLength(20)
  })

  it('无状态变化的 update 返回原引用且 revision 不变（实施路线 11 节步骤 13）', () => {
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(20, '20题') } }),
      KEEP,
    )
    expect(next).toBe(d)
  })

  it('reducer 无 Math.min/Math.max 静默夹取用户数量（实施路线验收）', () => {
    // 1001 超限值必须原样保存，validator（TASK-02）才有机可报 TOTAL_OUT_OF_RANGE（P0-16）
    const d = seedAi20()
    const next = applyDraftTurn(
      d,
      patch({ intent: 'update', baseRevision: 1, countPlan: { kind: 'set_ai', total: explicit(1001) } }),
      KEEP,
    )
    expect(next!.countPlan).toEqual({ mode: 'ai', total: explicit(1001) })
  })
})
