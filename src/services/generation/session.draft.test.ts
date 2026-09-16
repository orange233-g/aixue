/**
 * GenerationDraft 会话持久化测试（TASK-05 必测用例，fake IndexedDB）。
 * 验证：草稿随 Session 同生共死、A/B 不串、删除/清空自然清理、
 * source 保持/替换语义经落库往返后仍正确、串行保存失败不被静默吞掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftSourceAction, GenerationDraft, Session } from '../../types'
import { clearAllStores, dbSessions, initDB } from '../../db'
import { applyDraftTurn } from './draftReducer'
import { evaluateGenerationDraft } from './draftValidation'
import {
  createSession,
  deleteSession,
  loadSession,
  normalizeSession,
  saveSession,
  saveSessionSerial,
} from './session'
import type { SessionSnapshot } from './session'

const SNAP: SessionSnapshot = { providerId: 'p1', model: 'm1' }

function draftWith(over?: Partial<GenerationDraft>): GenerationDraft {
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

const KB_SCOPE = {
  volumes: [{ index: 0, kbId: 'kb1', kbName: '库一', start: 0, end: 10, charCount: 10, sectionTitles: [] }],
}

const KEEP: DraftSourceAction = { kind: 'preserve' }
const CLEAR: DraftSourceAction = { kind: 'clear' }

beforeEach(async () => {
  initDB()
  await clearAllStores()
})

describe('草稿随 Session 持久化往返（实施路线 15 节）', () => {
  it('保存并重新 loadSession 后草稿字段一致（含 kbScope/requirements/turnIssues）', async () => {
    const s = createSession('帮我出题', SNAP)
    const d = draftWith({
      id: 'gd_a',
      sessionId: s.id,
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: {
        mode: 'custom',
        typeCounts: { single: { value: 10, basis: 'user_explicit' }, multiple: { value: 5, basis: 'user_explicit' } },
        statedTotal: { value: 20, basis: 'user_explicit' },
      },
      requirements: [{ id: 'r1', value: '难一点', basis: 'user_explicit' }],
      source: { sourceMessageId: 'm1', kbScope: KB_SCOPE },
      revision: 3,
      appliedTurnIds: ['t1', 't2'],
      turnIssues: [{ code: 'TURN_UPDATE_NOT_APPLIED', message: 'x' }],
    })
    const saved: Session = { ...s, generationDraft: d }
    await saveSessionSerial(saved)
    const loaded = await loadSession(s.id)
    expect(loaded).toBeDefined()
    expect(loaded!.generationDraft).toEqual(d) // 深等：结构化字段零丢失
  })

  it('旧 Session 无 generationDraft：正常读取、normalize 不造空草稿', async () => {
    const s = createSession('旧会话', SNAP)
    await saveSession(s)
    const loaded = await loadSession(s.id)
    expect(loaded).toBeDefined()
    expect(loaded!.generationDraft).toBeUndefined()
    // normalizeSession 对无草稿会话返回原对象（无多余默认值）
    expect(normalizeSession(loaded!)).toBe(loaded!)
  })

  it('normalizeSession 只补缺失数组默认值，不伪造业务字段', () => {
    const s = createSession('x', SNAP)
    const broken = draftWith({ requirements: undefined as never, appliedTurnIds: undefined as never, turnIssues: undefined as never, lifecycle: 'weird' as never })
    const out = normalizeSession({ ...s, generationDraft: broken })
    expect(out.generationDraft!.requirements).toEqual([])
    expect(out.generationDraft!.appliedTurnIds).toEqual([])
    expect(out.generationDraft!.turnIssues).toEqual([])
    expect(out.generationDraft!.lifecycle).toBe('active') // 非法 lifecycle 兜底为 active
  })

  it('A/B 两会话各自草稿不串；删除 A 不影响 B（必测）', async () => {
    const a = createSession('A', SNAP)
    const b = createSession('B', SNAP)
    const da = draftWith({ id: 'gd_a', sessionId: a.id, topic: { value: '主题A', basis: 'user_explicit' } })
    const db = draftWith({ id: 'gd_b', sessionId: b.id, topic: { value: '主题B', basis: 'user_explicit' }, countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } } })
    await saveSession({ ...a, generationDraft: da })
    await saveSession({ ...b, generationDraft: db })

    const la = await loadSession(a.id)
    const lb = await loadSession(b.id)
    expect(la!.generationDraft!.id).toBe('gd_a')
    expect(lb!.generationDraft!.id).toBe('gd_b')

    await deleteSession(a.id)
    const lb2 = await loadSession(b.id)
    expect(lb2!.generationDraft!.id).toBe('gd_b')
    expect(await loadSession(a.id)).toBeUndefined()
  })

  it('删除/清空会话后草稿随记录消失，无残留可复活（必测）', async () => {
    const s = createSession('S', SNAP)
    await saveSession({ ...s, generationDraft: draftWith({ id: 'gd_x', sessionId: s.id }) })
    await clearAllStores() // 清空全部会话（clearSessions 的数据层等价动作）
    expect(await loadSession(s.id)).toBeUndefined()
  })
})

describe('source 语义经落库往返仍正确（实施路线 15 节步骤 7/8）', () => {
  function sourceOnlyDraft(sessionId: string): GenerationDraft {
    return draftWith({
      id: 'gd_src',
      sessionId,
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      source: { kbScope: KB_SCOPE }, // 无主题、仅有资料
    })
  }

  it('知识库范围经一轮只补题数后仍保留（P0-18）', async () => {
    const s = createSession('KB', SNAP)
    const d = sourceOnlyDraft(s.id)
    const next = applyDraftTurn(d, {
      schemaVersion: 2,
      turnId: 't2',
      baseRevision: d.revision,
      intent: 'update',
      countPlan: { kind: 'set_ai', total: { value: 20, basis: 'user_explicit' } },
      appendRequirements: [],
      removeRequirementIds: [],
    }, KEEP)
    expect(next!.source).toEqual({ kbScope: KB_SCOPE })
    await saveSessionSerial({ ...s, generationDraft: next! })
    const loaded = (await loadSession(s.id))!.generationDraft!
    expect(loaded.source).toEqual({ kbScope: KB_SCOPE })
    expect(loaded.countPlan).toEqual({ mode: 'ai', total: { value: 20, basis: 'user_explicit' } })
    expect(evaluateGenerationDraft(loaded).ready).toBe(true)
  })

  it('新资料整体替换旧 source（P0-21）', async () => {
    const s = createSession('REP', SNAP)
    const d = draftWith({
      id: 'gd_r',
      sessionId: s.id,
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      source: { sourceMessageId: 'm1' },
      revision: 2,
    })
    const next = applyDraftTurn(d, {
      schemaVersion: 2,
      turnId: 't3',
      baseRevision: d.revision,
      intent: 'update',
      appendRequirements: [],
      removeRequirementIds: [],
    }, { kind: 'replace', source: { sourceMessageId: 'm2' } })
    await saveSessionSerial({ ...s, generationDraft: next! })
    const loaded = (await loadSession(s.id))!.generationDraft!
    expect(loaded.source).toEqual({ sourceMessageId: 'm2' }) // 整体替换，不追加
  })

  it('清除资料后无主题的草稿变为 not ready（P0 前置）', async () => {
    const s = createSession('CLR', SNAP)
    const d = sourceOnlyDraft(s.id) // 无主题，仅资料
    const next = applyDraftTurn(d, {
      schemaVersion: 2,
      turnId: 't4',
      baseRevision: d.revision,
      intent: 'update',
      appendRequirements: [],
      removeRequirementIds: [],
    }, CLEAR)
    await saveSessionSerial({ ...s, generationDraft: next! })
    const loaded = (await loadSession(s.id))!.generationDraft!
    const ev = evaluateGenerationDraft(loaded)
    expect(ev.ready).toBe(false)
    expect(ev.missing[0].code).toBe('TOPIC_OR_SOURCE_REQUIRED')
  })

  it('不复制 Message.refs：draft.source 只持久化 sourceMessageId 与 kbScope（必测）', async () => {
    const s = createSession('NOREFS', SNAP)
    const d = draftWith({ id: 'gd_nr', sessionId: s.id, source: { sourceMessageId: 'm1', kbScope: KB_SCOPE } })
    await saveSession({ ...s, generationDraft: d })
    const raw = await dbSessions.get(s.id)
    const rawDraft = raw!.generationDraft as unknown as Record<string, unknown>
    const rawSource = rawDraft.source as Record<string, unknown>
    expect(Object.keys(rawSource).sort()).toEqual(['kbScope', 'sourceMessageId'])
    expect('refs' in rawSource).toBe(false)
  })
})

describe('saveSessionSerial 串行与失败契约（实施路线 5.3/步骤 9）', () => {
  it('并发调用按顺序落库：最终库态为最后一次（不乱序覆盖）', async () => {
    const s = createSession('ORDER', SNAP)
    const p1 = saveSessionSerial({ ...s, title: '第一版' })
    const p2 = saveSessionSerial({ ...s, title: '第二版' })
    await Promise.all([p1, p2])
    const loaded = await loadSession(s.id)
    expect(loaded!.title).toBe('第二版')
  })

  it('持久化失败向上抛出，不被静默吞掉（必测）；链不断，后续保存仍可用', async () => {
    const s = createSession('FAIL', SNAP)
    const spy = vi.spyOn(dbSessions, 'put').mockRejectedValueOnce(new Error('quota exceeded'))
    await expect(saveSessionSerial({ ...s, title: '会失败' })).rejects.toThrow('quota exceeded')
    spy.mockRestore()
    // 链未断裂：失败之后的保存正常
    await saveSessionSerial({ ...s, title: '恢复成功' })
    expect((await loadSession(s.id))!.title).toBe('恢复成功')
  })

  it('V1 的 saveSession 仍可用（不被本次改动影响）', async () => {
    const s = createSession('LEGACY', SNAP)
    await saveSession(s)
    expect((await loadSession(s.id))!.title).toBe(s.title)
  })
})
