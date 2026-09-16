/**
 * draftTurnPolicy 纯测试（TASK-04 必测，实施路线 6.3 门禁 + 14 节验收项）。
 */
import { describe, expect, it } from 'vitest'
import type { GenerationDraft } from '../../types'
import { evaluateGenerationDraft } from './draftValidation'
import {
  extractExplicitDraftPatch,
  parseDraftPatchWire,
} from './draftProtocol'
import {
  isBareAnswerToNextQuestion,
  requiresDraftProtocol,
  resolveFinalIntent,
  resolveLocalCancel,
} from './draftTurnPolicy'
import { isAdjustment } from './intentRules'

function draft(over?: Partial<GenerationDraft>): GenerationDraft {
  const now = 0
  return {
    schemaVersion: 2,
    id: 'gd_1',
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

const topicOnly = draft({ topic: { value: '海洋知识', basis: 'user_explicit' } })
const aiReady = draft({
  topic: { value: '海洋知识', basis: 'user_explicit' },
  countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
})

/* ============================ 本地取消解析 ============================ */

describe('resolveLocalCancel（实施路线 6.3 首步）', () => {
  it('无活动草稿：否定句只是拒绝生题，不取消', () => {
    expect(resolveLocalCancel('不要出题', false)).toEqual({ action: 'none' })
    expect(resolveLocalCancel('先不出了', false)).toEqual({ action: 'none' })
  })

  it('纯取消短句：本地 cancel，不调用模型（P0-08）', () => {
    expect(resolveLocalCancel('先不出了', true)).toEqual({ action: 'cancel' })
    expect(resolveLocalCancel('算了不出了', true)).toEqual({ action: 'cancel' })
    expect(resolveLocalCancel('不出了，太麻烦', true)).toEqual({ action: 'cancel' })
    expect(resolveLocalCancel('不要出题', true)).toEqual({ action: 'cancel' })
  })

  it('复合取消 + 聊天请求：先取消再回答剩余内容（P1-02）', () => {
    const r = resolveLocalCancel('不要出题，只给我讲概念', true)
    expect(r).toEqual({ action: 'cancel_and_chat', remainder: '只给我讲概念' })
  })

  it('疑问/假设开头不是取消指令', () => {
    expect(resolveLocalCancel('怎么不出题了？', true)).toEqual({ action: 'none' })
    expect(resolveLocalCancel('如果不想出题了呢，讲讲概念吧', true)).toEqual({ action: 'none' })
  })
})

/* ============================ 协议需求判定 ============================ */

describe('requiresDraftProtocol（实施路线 6.3）', () => {
  it('无草稿：明确生题/承接规格 → true；闲聊/假设/讲解 → false', () => {
    expect(requiresDraftProtocol('帮我出20道海洋知识单选题', null, null)).toBe(true)
    expect(requiresDraftProtocol('来五十道不用太难', null, null)).toBe(true)
    expect(requiresDraftProtocol('今天天气怎么样', null, null)).toBe(false)
    expect(requiresDraftProtocol('如果要出20题该怎么分配？', null, null)).toBe(false) // NOT_A_REQUEST
    expect(requiresDraftProtocol('请给我讲解20个Python概念', null, null)).toBe(false) // P1-14
    expect(requiresDraftProtocol('我有20个Python问题', null, null)).toBe(false)
  })

  it('active 草稿：修改词/资料操作/新生题信号 → true；明显闲聊 → false（P0-30）', () => {
    const ev = evaluateGenerationDraft(aiReady)
    expect(requiresDraftProtocol('再难一点', aiReady, ev)).toBe(true)
    expect(requiresDraftProtocol('改成30题', aiReady, ev)).toBe(true)
    expect(requiresDraftProtocol('沿用这些资料', aiReady, ev)).toBe(true)
    expect(requiresDraftProtocol('再出一套20题', aiReady, ev)).toBe(true)
    expect(requiresDraftProtocol('给我讲个冷笑话', aiReady, ev)).toBe(false)
    expect(requiresDraftProtocol('怎么出题？', aiReady, ev)).toBe(false)
  })

  it('active 且唯一缺总数：裸数字是直接回答 → true', () => {
    const ev = evaluateGenerationDraft(topicOnly)
    expect(ev.missing.map((i) => i.code)).toEqual(['TOTAL_REQUIRED'])
    expect(requiresDraftProtocol('20', topicOnly, ev)).toBe(true)
  })
})

/* ============================ finalIntent 门禁 ============================ */

describe('resolveFinalIntent（实施路线 6.3 唯一门禁顺序）', () => {
  it('模型 update 采纳；replace 无明确「另出一套」措辞降级 update', () => {
    expect(resolveFinalIntent({ input: '改成30题', modelIntent: 'update', hasActiveDraft: true, evaluation: null, localPatch: null })).toEqual({ kind: 'update' })
    expect(resolveFinalIntent({ input: '改成30题', modelIntent: 'replace', hasActiveDraft: true, evaluation: null, localPatch: null })).toEqual({ kind: 'update' })
    expect(resolveFinalIntent({ input: '另出一套光合作用的15题', modelIntent: 'replace', hasActiveDraft: true, evaluation: null, localPatch: null })).toEqual({ kind: 'replace' })
  })

  it('模型 cancel 需本地佐证；无活动草稿时 cancel 当普通聊天（P1-01/02 前置）', () => {
    expect(resolveFinalIntent({ input: '先不出了', modelIntent: 'cancel', hasActiveDraft: true, evaluation: null, localPatch: null })).toEqual({ kind: 'cancel' })
    expect(resolveFinalIntent({ input: '随便聊聊', modelIntent: 'cancel', hasActiveDraft: true, evaluation: null, localPatch: null })).toEqual({ kind: 'chat', dropLocal: true })
    expect(resolveFinalIntent({ input: '先不出了', modelIntent: 'cancel', hasActiveDraft: false, evaluation: null, localPatch: null })).toEqual({ kind: 'chat', dropLocal: true })
  })

  it('模型 chat 且无高置信信号：本地数字 patch 被丢弃（必测）', () => {
    const local = extractExplicitDraftPatch('出20题', { turnId: 't1', baseRevision: 0, userText: '出20题', currentDraft: null })
    const r = resolveFinalIntent({ input: '我有20个Python问题', modelIntent: 'chat', hasActiveDraft: false, evaluation: null, localPatch: local })
    expect(r).toEqual({ kind: 'chat', dropLocal: true })
  })

  it('「如果要出20题该怎么分配」不会因本地提取 20 而建草稿（必测/P1-01）', () => {
    const input = '如果要出20题，应该怎么分配？'
    const local = extractExplicitDraftPatch(input, { turnId: 't1', baseRevision: 0, userText: input, currentDraft: null })
    // 本地确实能提取到 20，但输入是假设咨询：明确生题动词门禁（hasExplicitGenIntent）不通过
    expect(local).not.toBeNull()
    const r = resolveFinalIntent({ input, modelIntent: 'chat', hasActiveDraft: false, evaluation: null, localPatch: local })
    expect(r.kind).toBe('chat')
  })

  it('active 且唯一缺总数、系统刚追问：裸答「20」即使模型误回 chat 也提升为 update（P0-26）', () => {
    const ev = evaluateGenerationDraft(topicOnly)
    const local = extractExplicitDraftPatch('20', { turnId: 't1', baseRevision: 1, userText: '20', currentDraft: topicOnly })
    expect(local).not.toBeNull()
    const r = resolveFinalIntent({ input: '20', modelIntent: 'chat', hasActiveDraft: true, evaluation: ev, localPatch: local })
    expect(r).toEqual({ kind: 'update', promoteReason: 'bare_answer' })
  })

  it('ready 草稿下无上下文裸数字不乱改：非唯一缺项时不提升', () => {
    const ev = evaluateGenerationDraft(aiReady)
    expect(ev.missing).toHaveLength(0)
    const local = extractExplicitDraftPatch('20', { turnId: 't1', baseRevision: 1, userText: '20', currentDraft: aiReady })
    const r = resolveFinalIntent({ input: '20', modelIntent: 'chat', hasActiveDraft: true, evaluation: ev, localPatch: local })
    expect(r).toEqual({ kind: 'chat', dropLocal: true })
  })

  it('模型 chat + 明确生题动词 + 可靠数字：提升为 update（门禁 3①）', () => {
    const input = '帮我出20道海洋知识单选题'
    const local = extractExplicitDraftPatch(input, { turnId: 't1', baseRevision: 0, userText: input, currentDraft: null })
    const r = resolveFinalIntent({ input, modelIntent: 'chat', hasActiveDraft: false, evaluation: null, localPatch: local })
    expect(r).toEqual({ kind: 'update', promoteReason: 'explicit_signal' })
  })

  it('active 草稿下明确要求即使模型误回 chat 也提升为 update', () => {
    const input = '高中难度，重点考易错点'
    const local = extractExplicitDraftPatch(input, { turnId: 't1', baseRevision: 1, userText: input, currentDraft: topicOnly })
    const r = resolveFinalIntent({ input, modelIntent: 'chat', hasActiveDraft: true, evaluation: evaluateGenerationDraft(topicOnly), localPatch: local })
    expect(r).toEqual({ kind: 'update', promoteReason: 'explicit_signal' })
  })

  it('题型分配原始口语是明确调整', () => {
    const input = '单选10，多选5，判断5，删除填空题'
    expect(isAdjustment(input)).toBe(true)
    expect(extractExplicitDraftPatch(input, { turnId: 't1', baseRevision: 1, userText: input, currentDraft: topicOnly })).not.toBeNull()
  })

  it('协议解析失败（modelIntent=null）按 chat 门禁处理：闲聊不提升', () => {
    const r = resolveFinalIntent({ input: '继续讲讲', modelIntent: null, hasActiveDraft: true, evaluation: null, localPatch: null })
    expect(r).toEqual({ kind: 'chat', dropLocal: true })
  })
})

/* ============================ 裸回答判定细节 ============================ */

describe('isBareAnswerToNextQuestion', () => {
  it('唯一缺总数：裸数字/带量词/「随便」命中', () => {
    const ev = evaluateGenerationDraft(topicOnly)
    expect(isBareAnswerToNextQuestion('20', ev)).toBe(true)
    expect(isBareAnswerToNextQuestion('20道', ev)).toBe(true)
    expect(isBareAnswerToNextQuestion('随便', ev)).toBe(true)
    expect(isBareAnswerToNextQuestion('什么是判断题？', ev)).toBe(false)
  })

  it('缺项不唯一（还缺主题）时不命中', () => {
    const ev = evaluateGenerationDraft(draft())
    expect(isBareAnswerToNextQuestion('20', ev)).toBe(false)
  })
})

/* ============================ 协议重试契约的输入准备 ============================ */

describe('与协议层的衔接', () => {
  it('本地提取 → 模型协议 → 合并链路可用（P0-26 补齐路径的原料）', () => {
    const input = '20'
    const local = extractExplicitDraftPatch(input, { turnId: 't1', baseRevision: 1, userText: input, currentDraft: topicOnly })
    expect(local!.countPlan).toEqual({
      kind: 'set_ai',
      total: { value: 20, basis: 'user_explicit', messageId: 't1', evidence: input },
    })
    // 模型误回 chat（无协议块）时 modelIntent=null → 门禁兜底提升，本地 patch 直接入 reducer
    const model = parseDraftPatchWire('抱歉，我没有理解你的意思。', { turnId: 't1', baseRevision: 1, userText: input, currentDraft: topicOnly })
    expect(model.ok).toBe(false)
    if (!model.ok) expect(model.error.code).toBe('NO_PROTOCOL_BLOCK')
  })
})
