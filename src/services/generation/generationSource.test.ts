/**
 * generationSource 纯测试（TASK-02 必测用例）。
 * 覆盖：sourceMessageId 精确解析 / KB 存在性 / SOURCE_MISSING，
 * 以及 5.4 节来源动作表的全部行（preserve/replace/clear/策略冲突）。
 */
import { describe, expect, it } from 'vitest'
import type { KBDoc, KbScope, Message, Session } from '../../types'
import {
  resolveDraftSourceAction,
  resolveGenerationSource,
} from './generationSource'
import type { GenerationDraftSource } from '../../types'

function sessionWith(...messages: Message[]): Session {
  return {
    id: 's1',
    title: '',
    created: 0,
    summary: '',
    messages,
    packages: [],
    provider: '',
  }
}

function userMsg(id: string, refs?: string): Message {
  return { id, role: 'user', content: '正文', tokens: 0, ...(refs ? { refs } : {}) }
}

function kb(id: string): KBDoc {
  const now = 0
  return {
    id,
    name: `库${id}`,
    sourceFiles: [],
    sourcesText: [],
    bodyText: 'x'.repeat(100),
    schema: 2,
    summary: '',
    consolidated: '',
    sections: [],
    charCount: 100,
    source: 'kb',
    status: 'ready',
    created_at: now,
    updated_at: now,
  }
}

const KB_SCOPE: KbScope = {
  volumes: [{ index: 0, kbId: 'kb1', kbName: '库一', start: 0, end: 10, charCount: 10, sectionTitles: [] }],
}

describe('resolveGenerationSource · 精确解析', () => {
  it('sourceMessageId 命中消息 refs：ok 且捕获 refs', () => {
    const r = resolveGenerationSource(
      { source: { sourceMessageId: 'm1' } },
      sessionWith(userMsg('m1', 'REFS_TEXT')),
      [],
    )
    expect(r.ok).toBe(true)
    expect(r.refs).toBe('REFS_TEXT')
  })

  it('sourceMessageId 不存在：SOURCE_MISSING，不构建 spec 的前置（TASK-02 必测）', () => {
    const r = resolveGenerationSource(
      { source: { sourceMessageId: 'm_gone' } },
      sessionWith(userMsg('m1', 'REFS')),
      [],
    )
    expect(r.ok).toBe(false)
    expect(r.issue!.code).toBe('SOURCE_MISSING')
  })

  it('消息存在但 refs 为空：SOURCE_MISSING（无实际资料可用）', () => {
    const r = resolveGenerationSource(
      { source: { sourceMessageId: 'm1' } },
      sessionWith(userMsg('m1')),
      [],
    )
    expect(r.ok).toBe(false)
    expect(r.issue!.code).toBe('SOURCE_MISSING')
  })

  it('kbScope 引用的知识库仍存在：ok（P0-18 前置）', () => {
    const r = resolveGenerationSource(
      { source: { kbScope: KB_SCOPE } },
      sessionWith(),
      [kb('kb1')],
    )
    expect(r.ok).toBe(true)
    expect(r.kbScope).toEqual(KB_SCOPE)
  })

  it('KB 被删除：SOURCE_MISSING（P0-22）', () => {
    const r = resolveGenerationSource(
      { source: { kbScope: KB_SCOPE } },
      sessionWith(),
      [], // kb1 已删除
    )
    expect(r.ok).toBe(false)
    expect(r.issue!.code).toBe('SOURCE_MISSING')
    expect(r.issue!.message).toContain('库一')
  })

  it('空 source（仅主题出题）：ok，无 refs', () => {
    const r = resolveGenerationSource({ source: {} }, sessionWith(), [])
    expect(r.ok).toBe(true)
    expect(r.refs).toBeUndefined()
  })

  it('消息 + KB 组合：二者都必须解析成功', () => {
    const both: GenerationDraftSource = { sourceMessageId: 'm1', kbScope: KB_SCOPE }
    expect(
      resolveGenerationSource({ source: both }, sessionWith(userMsg('m1', 'R')), [kb('kb1')]).ok,
    ).toBe(true)
    expect(
      resolveGenerationSource({ source: both }, sessionWith(userMsg('m1', 'R')), []).ok,
    ).toBe(false)
    expect(
      resolveGenerationSource({ source: both }, sessionWith(), [kb('kb1')]).ok,
    ).toBe(false)
  })
})

describe('resolveDraftSourceAction · 5.4 来源动作表', () => {
  const turnSrc: GenerationDraftSource = { sourceMessageId: 'm_new' }
  const policyKeep = { kind: 'keep_existing', evidence: '沿用' } as const
  const policyClear = { kind: 'clear', evidence: '不要资料' } as const

  it('新建草稿 + 本轮有资料：replace 一次性写入（P0-03）', () => {
    const r = resolveDraftSourceAction(null, 'update', turnSrc)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'replace', source: turnSrc } })
  })

  it('新建草稿 + 无资料：clear（空 source）', () => {
    const r = resolveDraftSourceAction(null, 'update', undefined)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'clear' } })
  })

  it('update 无新资料：preserve 完整保留旧 source（P0-18）', () => {
    const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, 'update', undefined)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'preserve' } })
  })

  it('update 带新资料：整体替换（P0-21）', () => {
    const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, 'update', turnSrc)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'replace', source: turnSrc } })
  })

  it('replace 无新资料且未明确沿用：clear 默认不继承（P0-24）', () => {
    const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, 'replace', undefined)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'clear' } })
  })

  it('replace 无新资料但明确「沿用原资料」：preserve（P0-25）', () => {
    const r = resolveDraftSourceAction(
      { source: { sourceMessageId: 'm_old' } },
      'replace',
      undefined,
      policyKeep,
    )
    expect(r).toEqual({ kind: 'ok', action: { kind: 'preserve' } })
  })

  it('replace 无新资料且明确「不要资料」：clear', () => {
    const r = resolveDraftSourceAction(
      { source: { sourceMessageId: 'm_old' } },
      'replace',
      undefined,
      policyClear,
    )
    expect(r).toEqual({ kind: 'ok', action: { kind: 'clear' } })
  })

  it('replace 带新资料：新资料优先落地为整体替换', () => {
    const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, 'replace', turnSrc)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'replace', source: turnSrc } })
  })

  it('同轮新资料 + source_policy：SOURCE_POLICY_CONFLICT，本轮不改 source（P1-12）', () => {
    for (const intent of ['update', 'replace'] as const) {
      const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, intent, turnSrc, policyKeep)
      expect(r.kind).toBe('conflict')
      if (r.kind === 'conflict') {
        expect(r.action).toEqual({ kind: 'preserve' })
        expect(r.issue.code).toBe('SOURCE_POLICY_CONFLICT')
      }
    }
  })

  it('chat 轮带附件：资料只服务本轮聊天，不改草稿 source（P0-23）', () => {
    const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, 'chat', turnSrc)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'preserve' } })
  })

  it('cancel 轮：不改 source', () => {
    const r = resolveDraftSourceAction({ source: { sourceMessageId: 'm_old' } }, 'cancel', turnSrc)
    expect(r).toEqual({ kind: 'ok', action: { kind: 'preserve' } })
  })
})
