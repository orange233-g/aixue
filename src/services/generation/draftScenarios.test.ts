/**
 * draftScenarios 数据源自检（TASK-00）：保证这份单一验收数据源本身没有口径问题
 * （ID 完整、无重复、issue code 合法、数值合法），防止后续测试引用时静默漂移。
 */
import { describe, expect, it } from 'vitest'
import {
  GENERATION_SCENARIOS,
  P0_SCENARIOS,
  P1_SCENARIOS,
  SCENARIO_ISSUE_CODES,
  scenariosByPriority,
} from './draftScenarios'

describe('draftScenarios 单一数据源自检（实施路线第 23 节）', () => {
  it('P0 矩阵 30 行全量收录且 ID 无重复', () => {
    expect(P0_SCENARIOS).toHaveLength(30)
    const ids = P0_SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(30)
    for (let i = 1; i <= 30; i++) {
      expect(ids).toContain(`P0-${String(i).padStart(2, '0')}`)
    }
  })

  it('P1 矩阵 16 行全量收录（P1-02 按前置拆 2 个 variant），键唯一', () => {
    const uniqueIds = new Set(P1_SCENARIOS.map((s) => s.id))
    expect(uniqueIds.size).toBe(16)
    expect(P1_SCENARIOS).toHaveLength(17)
    const keys = P1_SCENARIOS.map((s) => `${s.id}::${s.variant ?? ''}`)
    expect(new Set(keys).size).toBe(P1_SCENARIOS.length)
    for (let i = 1; i <= 16; i++) {
      expect(uniqueIds).toContain(`P1-${String(i).padStart(2, '0')}`)
    }
  })

  it('每条场景都有人读标题、合法动作与至少一项期望', () => {
    for (const s of GENERATION_SCENARIOS) {
      expect(s.title.trim().length, `${s.id} 缺标题`).toBeGreaterThan(0)
      expect(['chat', 'chat_sequence', 'quick_generate', 'click_generate', 'double_click_generate',
        'reload', 'clear_session', 'delete_kb', 'attach_source', 'switch_session', 'stop_generation'],
      ).toContain(s.action.kind)
      const expectFields = Object.keys(s.expect).filter((k) => k !== 'note')
      expect(expectFields.length, `${s.id} 期望为空`).toBeGreaterThan(0)
      if (s.action.kind === 'chat') expect((s.action as { text: string }).text.length).toBeGreaterThan(0)
      if (s.action.kind === 'chat_sequence') {
        expect((s.action as { texts: string[] }).texts.length).toBeGreaterThan(0)
      }
    }
  })

  it('issues 字段只引用 4.5 节 DraftIssueCode 全集内的错误码', () => {
    for (const s of GENERATION_SCENARIOS) {
      for (const code of s.expect.issues ?? []) {
        expect(SCENARIO_ISSUE_CODES, `${s.id} 使用了未知 issue code: ${code}`).toContain(code)
      }
    }
  })

  it('countPlan 数值合法：无 0/负数分项，ai 模式不携带 typeCounts', () => {
    const plans = GENERATION_SCENARIOS.flatMap((s) => {
      const out = [] as Array<{ mode: string; typeCounts?: Record<string, number> }>
      if (s.setup.draft?.countPlan) out.push(s.setup.draft.countPlan)
      if (s.expect.countPlan) out.push(s.expect.countPlan)
      return out
    })
    for (const p of plans) {
      if (p.mode === 'ai') {
        expect('typeCounts' in p).toBe(false)
        if ('total' in p && typeof p.total === 'number') expect(p.total).toBeGreaterThan(0)
      } else {
        for (const [type, n] of Object.entries(p.typeCounts ?? {})) {
          expect(Number.isInteger(n) && n > 0, `${type}=${n} 必须为正整数（草稿不存 0）`).toBe(true)
        }
      }
    }
  })

  it('scenariosByPriority 过滤正确', () => {
    expect(scenariosByPriority('P0')).toHaveLength(30)
    expect(scenariosByPriority('P1')).toHaveLength(17)
    expect(GENERATION_SCENARIOS).toHaveLength(47)
  })
})
