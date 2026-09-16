/**
 * draftContext 纯测试（TASK-04：prompt 契约）。
 * 验证：系统提示不存在流程宣告指令、AI 推荐示例不伪造题型、
 * 上下文注入结构化事实源（不回注 gen_intent 历史）、重试提示不拼半成品。
 */
import { describe, expect, it } from 'vitest'
import type { GenerationDraft, Session } from '../../types'
import { evaluateGenerationDraft } from './draftValidation'
import { buildDraftMessages, buildDraftRetryMessages, buildDraftSystemPrompt, MAX_PROTOCOL_ATTEMPTS } from './draftContext'
import type { DraftProtocolErrorCode } from './draftProtocol'

function sessionWith(...messages: Session['messages']): Session {
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

describe('buildDraftSystemPrompt（实施路线 14 节 11 条）', () => {
  const prompt = buildDraftSystemPrompt()

  it('不存在 complete/gathering/ready/show_button 等流程宣告指令（必测）', () => {
    expect(prompt.toLowerCase()).not.toContain('complete')
    expect(prompt.toLowerCase()).not.toContain('gathering')
    expect(prompt).not.toContain('show_button')
    // 「ready」作为英文词不得出现（中文「可以生成由应用计算」是合法表述）
    expect(prompt).not.toMatch(/\bready\b/)
    expect(prompt).toContain('由应用自行计算')
    expect(prompt).toContain('自动生成下一问')
  })

  it('AI 推荐示例不伪造 type_counts（必测）', () => {
    expect(prompt).toContain('"op":"set_ai","total":20')
    expect(prompt).not.toContain('"op":"set_ai","total":20,"type_counts"')
    expect(prompt).toContain('不要替用户编造各题型数量')
  })

  it('包含取消示例、聊天示例、unset 指引与 source_policy 约束', () => {
    expect(prompt).toContain('"intent":"cancel"')
    expect(prompt).toContain('"intent":"chat"')
    expect(prompt).toContain('["multiple"]')
    expect(prompt).toContain('绝不能把 0 写进 set')
    expect(prompt).toContain('禁止输出任何资料 id/正文')
  })
})

describe('buildDraftMessages（上下文注入）', () => {
  it('注入结构化草稿状态 + 缺项 + 本轮输入；不回注历史 gen_intent 围栏（实施路线 14 节）', () => {
    const s = sessionWith(
      { id: 'm1', role: 'user', content: '帮我出题', tokens: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '好的，想要什么主题？',
        tokens: 1,
      },
    )
    const draft = {
      schemaVersion: 2 as const,
      id: 'gd_1',
      sessionId: 's1',
      revision: 1,
      lifecycle: 'active' as const,
      createdAt: 0,
      updatedAt: 0,
      topic: { value: '海洋知识', basis: 'user_explicit' as const },
      requirements: [],
      source: {},
      appliedTurnIds: [],
      turnIssues: [],
    }
    const ev = evaluateGenerationDraft(draft)
    const msgs = buildDraftMessages({ session: s, draft, evaluation: ev, userInput: '20题' })
    const all = msgs.map((m) => m.content).join('\n')
    expect(all).toContain('[当前生题方案]')
    expect(all).toContain('海洋知识')
    expect(all).toContain('还缺')
    expect(all).toContain('[本轮用户输入]')
    expect(all).toContain('20题')
    expect(all).not.toContain('gen_intent')
    expect(all).not.toContain('"status":"gathering"')
    // 系统提示在首位
    expect(msgs[0].role).toBe('system')
    // 最后一条 user 含本轮输入
    expect(msgs[msgs.length - 1].role).toBe('user')
  })

  it('无草稿时注入「尚无进行中的方案」', () => {
    const msgs = buildDraftMessages({
      session: sessionWith(),
      draft: null,
      evaluation: null,
      userInput: '帮我出题',
    })
    expect(msgs.map((m) => m.content).join('\n')).toContain('尚无进行中的方案')
  })

  it('资料范围只注入来源标识，不注入正文', () => {
    const msgs = buildDraftMessages({
      session: sessionWith(),
      draft: null,
      evaluation: null,
      userInput: '根据资料出题',
      refs: '【知识库·脉海宇宙】正文正文正文……（大段内容）',
      kbScope: { volumes: [{ index: 0, kbId: 'kb1', kbName: '脉海宇宙', start: 0, end: 9, charCount: 9, sectionTitles: [] }] },
    })
    const all = msgs.map((m) => m.content).join('\n')
    expect(all).toContain('参考资料来源：知识库·脉海宇宙')
    expect(all).toContain('知识库范围：脉海宇宙')
    expect(all).not.toContain('大段内容')
  })
})

describe('buildDraftRetryMessages（重试契约）', () => {
  it('包含错误码提示与 schema 要求，不拼接半成品 JSON', () => {
    for (const code of [
      'INVALID_JSON',
      'COUNT_NOT_EXPLICIT',
      'UNKNOWN_KEY',
      'INTENT_PATCH_CONFLICT',
      'COUNT_PLAN_REQUIRED',
    ] as DraftProtocolErrorCode[]) {
      const msgs = buildDraftRetryMessages(code)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].role).toBe('user')
      const c = msgs[0].content
      expect(c).toContain('[协议重试]')
      expect(c).toContain('gen_draft_patch')
      expect(c).toContain('schema_version=2')
      // 半成品污染防护：不包含任何具体被错误解析的内容占位
      expect(c).not.toContain('上一条回复的原文如下')
    }
  })

  it('协议尝试次数上限为 2（首次 + 一次重试，实施路线 6.5）', () => {
    expect(MAX_PROTOCOL_ATTEMPTS).toBe(2)
  })

  it('定向重试携带当前草稿、缺项与本轮原文，但不回注失败半成品', () => {
    const draft: GenerationDraft = {
      schemaVersion: 2,
      id: 'gd_retry',
      sessionId: 's1',
      revision: 3,
      lifecycle: 'active',
      createdAt: 0,
      updatedAt: 0,
      topic: { value: '海洋知识', basis: 'user_explicit' },
      requirements: [],
      source: {},
      appliedTurnIds: [],
      turnIssues: [],
    }
    const c = buildDraftRetryMessages('SCHEMA_INVALID', {
      draft,
      evaluation: evaluateGenerationDraft(draft),
      userInput: '改成30题',
    })[0].content
    expect(c).toContain('海洋知识')
    expect(c).toContain('改成30题')
    expect(c).toContain('还缺')
    expect(c).toContain('未提到的字段保持不变')
    expect(c).not.toContain('上一条回复的原文如下')
    expect(c).not.toContain('失败半成品')
  })
})
