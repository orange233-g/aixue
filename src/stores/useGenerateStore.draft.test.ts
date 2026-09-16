/** useGenerateStore × V2 控制器集成测试（fake IndexedDB + mock gateway）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllStores, initDB } from '../db'
import type { Session } from '../types'

const mocks = vi.hoisted(() => {
  const defaultImpl = async (_messages: unknown, req: { onToken?: (delta: string, reasoning: string) => void }) => {
    req?.onToken?.('普通聊天回复', '')
    return { content: '普通聊天回复', finishReason: 'stop', usage: { outputTokens: 10 } }
  }
  return { chat: vi.fn(defaultImpl), defaultImpl }
})

vi.mock('../ai/gateway', () => ({ chat: mocks.chat }))

import { useGenerate } from './useGenerateStore'
import { loadSession as loadSessionById, saveSession } from '../services/generation/session'
import { zeroStructure } from '../services/generation/structure'
import type { GenerationDraft, KbScope } from '../types'
import { useKB } from './useKBStore'
import { useAI } from './useAIStore'
import { evaluateGenerationDraft } from '../services/generation/draftValidation'

const CFG = { providers: { p1: { apiKey: 'k', model: 'm1' } }, defaultId: 'p1' }
const SNAP = { providerId: 'p1', model: 'm1' }

beforeEach(async () => {
  initDB()
  await clearAllStores()
  mocks.chat.mockClear()
  mocks.chat.mockImplementation(mocks.defaultImpl as never)
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

/* ============================ TASK-07：V2 控制器（rollout=v2） ============================ */

const workerMocks = vi.hoisted(() => ({ start: vi.fn() }))

vi.mock('../workers/generationWorkerClient', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../workers/generationWorkerClient')>()
  return { ...orig, generationStart: workerMocks.start }
})

/** 构造 V2 wire 回复（含流式 onToken 回调） */
function wireReply(content: string) {
  return async (_messages: unknown, req: { onToken?: (d: string, r: string) => void }) => {
    req?.onToken?.(content, '')
    return { content, finishReason: 'stop', usage: { outputTokens: 10 } }
  }
}

function fence(json: string): string {
  return '好的。\n```gen_draft_patch\n' + json + '\n```'
}

function makeV2Draft(over?: Partial<GenerationDraft>): GenerationDraft {
  const now = Date.now()
  return {
    schemaVersion: 2,
    id: 'gd_v2',
    sessionId: 's_v2',
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

const KB: KbScope = {
  volumes: [{ index: 0, kbId: 'kb1', kbName: '库一', start: 0, end: 10, charCount: 10, sectionTitles: [] }],
}

/** 以 V2 会话状态跑一轮控制器（用户消息 u1 + 占位 a1 已在会话中，模拟 send() 乐观写入后）。
 *  会话先落库：控制器提交前会 loadSession 做门禁（17 节步骤 8）。 */
async function runV2(
  input: string,
  opts?: { session?: Session; refs?: string; kbScope?: KbScope },
) {
  const session: Session =
    opts?.session ??
    {
      id: 's_v2',
      title: 'v2',
      created: Date.now(),
      summary: '',
      messages: [
        { id: 'u1', role: 'user', content: input, tokens: 2, ...(opts?.refs ? { refs: opts.refs } : {}) },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [],
      provider: JSON.stringify(SNAP),
    }
  await saveSession(session)
  useGenerate.setState({
    session,
    phase: 'chatting',
    error: null,
    pendingChats: [],
    abort: new AbortController(),
  })
  await useGenerate.getState().handleGenerationDraftTurn({
    input,
    cfg: CFG,
    snapshot: SNAP,
    userMsgAdded: true,
    placeholderId: 'a1',
    userMessageId: 'u1',
    refs: opts?.refs,
    kbScope: opts?.kbScope,
  })
  return useGenerate.getState()
}

function v2AiMsg(st: ReturnType<typeof useGenerate.getState>) {
  return st.session!.messages.find((m) => m.id === 'a1')!
}

describe('TASK-07 · V2 控制器接管（rollout=v2）', () => {
  beforeEach(() => {
    mocks.chat.mockImplementation(wireReply(
      fence('{"schema_version":2,"intent":"update","acknowledgement":"已记录。","patch":{"topic":{"op":"set","value":"海洋知识","basis":"user_explicit","evidence":"海洋知识"},"count_plan":{"op":"set_ai","total":20,"basis":"user_explicit","evidence":"出20题"}}}'),
    ) as never)
  })

  it('首轮「围绕海洋知识出20题」：建草稿 rev1 ready，落库含草稿；不再向消息投影按钮（TASK-09 迁移完成）', async () => {
    const st = await runV2('围绕海洋知识出20题')
    const d = st.session!.generationDraft!
    expect(d.revision).toBe(1)
    expect(d.topic).toMatchObject({ value: '海洋知识', basis: 'user_explicit' })
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 20 } })
    const ai = v2AiMsg(st)
    // 生成入口收敛到唯一活动方案卡：消息不再挂 generate/dismiss 按钮
    expect(ai.actions).toBeUndefined()
    expect(ai.proposalRef).toBeUndefined()
    expect(ai.content).toContain('已记录')
    expect(ai.content).toContain('方案卡')
    // 一次串行落库：DB 会话带草稿
    const raw = await loadSessionById('s_v2')
    expect(raw!.generationDraft).toEqual(d)
  })

  it('第二轮只改总数：revision 递增，主题保持（P0-06）', async () => {
    mocks.chat.mockImplementation(wireReply(
      fence('{"schema_version":2,"intent":"update","acknowledgement":"已改成30题。","patch":{"count_plan":{"op":"set_ai","total":30,"basis":"user_explicit","evidence":"改成30题"}}}'),
    ) as never)
    const seed = makeV2Draft({
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      source: { sourceMessageId: 'u0' },
      sessionId: 's_v2',
    })
    const st = await runV2('改成30题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '改成30题', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    const d = st.session!.generationDraft!
    expect(d.revision).toBe(2)
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 30 } })
    expect(d.topic).toMatchObject({ value: '海洋知识' })
    expect(d.source).toEqual({ sourceMessageId: 'u0' }) // update 无新资料：保留
  })

  it('纯取消「先不出了」：不调用模型，草稿 cancelled（P0-08）', async () => {
    mocks.chat.mockClear()
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const session: Session = {
      id: 's_v2',
      title: 'v2',
      created: Date.now(),
      summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '先不出了', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [],
      provider: JSON.stringify(SNAP),
      generationDraft: seed,
    }
    useGenerate.setState({ session, phase: 'chatting', abort: new AbortController() })
    await useGenerate.getState().handleGenerationDraftTurn({
      input: '先不出了',
      cfg: CFG,
      snapshot: SNAP,
      userMsgAdded: true,
      placeholderId: 'a1',
      userMessageId: 'u1',
    })
    expect(mocks.chat).not.toHaveBeenCalled()
    const st = useGenerate.getState()
    expect(st.session!.generationDraft!.lifecycle).toBe('cancelled')
    expect(st.session!.generationDraft!.revision).toBe(2)
    expect(v2AiMsg(st).content).toContain('已取消')
  })

  it('普通闲聊：撤销未完成草稿、回复为模型正文（P0-09）', async () => {
    mocks.chat.mockImplementation(wireReply('今天天气不错，适合散步。') as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const session: Session = {
      id: 's_v2',
      title: 'v2',
      created: Date.now(),
      summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '今天天气怎么样', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [],
      provider: JSON.stringify(SNAP),
      generationDraft: seed,
    }
    useGenerate.setState({ session, phase: 'chatting', abort: new AbortController() })
    await useGenerate.getState().handleGenerationDraftTurn({
      input: '今天天气怎么样',
      cfg: CFG,
      snapshot: SNAP,
      userMsgAdded: true,
      placeholderId: 'a1',
      userMessageId: 'u1',
    })
    const st = useGenerate.getState()
    expect(st.session!.generationDraft!.lifecycle).toBe('cancelled')
    expect(st.session!.generationDraft!.revision).toBe(seed.revision + 1)
    expect(v2AiMsg(st).content).toBe('今天天气不错，适合散步。')
    expect(v2AiMsg(st).actions).toBeUndefined()
  })

  it('模糊增减题量且含错别字时本地澄清，不触发协议重试并保留原方案', async () => {
    const input = '我觉得刚才的题有点上了，还想多出一些'
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const st = await runV2(input, { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: input, tokens: 4 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })

    expect(mocks.chat).not.toHaveBeenCalled()
    expect(v2AiMsg(st).content).toContain('最终需要多少题')
    expect(st.phase).toBe('idle')
    expect(st.session!.generationDraft).toMatchObject({ lifecycle: 'active', revision: seed.revision })
    const persisted = await loadSessionById('s_v2')
    expect(persisted!.generationDraft).toMatchObject({ lifecycle: 'active', revision: seed.revision })
  })

  it('知识库后续补充：只补题数，KB source 保留（P0-18）', async () => {
    mocks.chat.mockImplementation(wireReply(
      fence('{"schema_version":2,"intent":"update","acknowledgement":"好的。","patch":{"count_plan":{"op":"set_ai","total":30,"basis":"user_explicit","evidence":"改成30题"}}}'),
    ) as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      source: { kbScope: KB },
    })
    const st = await runV2('改成30题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '改成30题', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    const d = st.session!.generationDraft!
    expect(d.source).toEqual({ kbScope: KB })
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 30 } })
  })

  it('replace 默认清旧 source / 明确 keep_existing 沿用（P0-24/P0-25）', async () => {
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      source: { sourceMessageId: 'm_old' },
      revision: 2,
    })
    // 默认清空
    mocks.chat.mockImplementation(wireReply(
      fence('{"schema_version":2,"intent":"replace","acknowledgement":"好的，另起一套。","patch":{"topic":{"op":"set","value":"光合作用","basis":"user_explicit","evidence":"光合作用"},"count_plan":{"op":"set_ai","total":15,"basis":"user_explicit","evidence":"15题"}}}'),
    ) as never)
    const st1 = await runV2('另出一套关于光合作用的15题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '另出一套关于光合作用的15题', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    const d1 = st1.session!.generationDraft!
    expect(d1.id).not.toBe(seed.id) // 新 draft id
    expect(d1.revision).toBe(1)
    expect(d1.source).toEqual({})
    // 明确沿用
    mocks.chat.mockImplementation(wireReply(
      fence('{"schema_version":2,"intent":"replace","acknowledgement":"好的，沿用资料。","patch":{"topic":{"op":"set","value":"光合作用","basis":"user_explicit","evidence":"光合作用"},"count_plan":{"op":"set_ai","total":15,"basis":"user_explicit","evidence":"15题"},"source_policy":{"op":"keep_existing","evidence":"沿用这些资料"}}}'),
    ) as never)
    const st2 = await runV2('沿用这些资料另出15题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '沿用这些资料另出15题', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    expect(st2.session!.generationDraft!.source).toEqual({ sourceMessageId: 'm_old' })
  })

  it('普通聊天新附件不换 source（P0-23）', async () => {
    mocks.chat.mockImplementation(wireReply('这个文件讲的是……') as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      source: { sourceMessageId: 'm_old' },
    })
    const st = await runV2('这个文件讲了什么？', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '这个文件讲了什么？', tokens: 2, refs: '新附件内容' },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    }, refs: '新附件内容' })
    expect(st.session!.generationDraft!.source).toEqual({ sourceMessageId: 'm_old' })
  })

  it('同轮新资料 + source_policy：SOURCE_POLICY_CONFLICT，需求字段不动（P1-12）', async () => {
    mocks.chat.mockImplementation(wireReply(
      fence('{"schema_version":2,"intent":"update","acknowledgement":"好的。","patch":{"count_plan":{"op":"set_ai","total":30,"basis":"user_explicit","evidence":"改成30题"},"source_policy":{"op":"clear","evidence":"不要资料"}}}'),
    ) as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      source: { sourceMessageId: 'm_old' },
    })
    const st = await runV2('不要资料了，改成30题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '不要资料了，改成30题', tokens: 2, refs: '新附件' },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    }, refs: '新附件' })
    const d = st.session!.generationDraft!
    expect(d.revision).toBe(1) // 需求字段/revision 不动
    expect(d.source).toEqual({ sourceMessageId: 'm_old' }) // source 保持
    expect(d.turnIssues.map((i) => i.code)).toContain('SOURCE_POLICY_CONFLICT')
    expect(v2AiMsg(st).content).toContain('选择')
    expect(v2AiMsg(st).actions?.map((a) => a.label)).toEqual(['使用新资料', '沿用旧资料', '不使用资料'])
    expect(v2AiMsg(st).actions?.every((a) => a.source?.sourceMessageId === 'u1')).toBe(true)

    useGenerate.getState().updateGenerationDraft({
      kind: 'resolve_source_conflict',
      decision: 'replace',
      source: v2AiMsg(st).actions?.[0]?.source,
    })
    const resolved = useGenerate.getState().session!.generationDraft!
    expect(resolved.source).toEqual({ sourceMessageId: 'u1' })
    expect(resolved.turnIssues).toEqual([])
    expect(resolved.revision).toBe(2)
  })

  it('两次协议硬失败：草稿不变 + turnIssues + 固定提示，重试恰一次（P0-15）', async () => {
    mocks.chat.mockImplementation(wireReply('完全不是 JSON 的输出{{') as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const st = await runV2('调整一下方案，保留当前语义', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '调整一下方案，保留当前语义', tokens: 3 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    expect(mocks.chat).toHaveBeenCalledTimes(2) // 首次 + 重试一次
    const d = st.session!.generationDraft!
    expect(d.revision).toBe(1) // 草稿不变
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 20 } })
    expect(d.turnIssues.map((i) => i.code)).toContain('TURN_UPDATE_NOT_APPLIED')
    expect(v2AiMsg(st).content).toContain('原方案未变')
  })

  it('协议连续失败时，按明确主题/要求本地兜底并保留既有题数、资料和要求', async () => {
    mocks.chat.mockImplementation(wireReply('协议坏了{{') as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '旧主题', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
      requirements: [{ id: 'r_old', value: '保留旧要求', basis: 'user_explicit' }],
      source: { sourceMessageId: 'u_source' },
    })
    const st = await runV2('围绕光合作用出题，高中难度，重点考易错点', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '围绕光合作用出题，高中难度，重点考易错点', tokens: 4 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    const d = st.session!.generationDraft!
    expect(d.topic).toMatchObject({ value: '光合作用', basis: 'user_explicit' })
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 20 } })
    expect(d.source).toEqual({ sourceMessageId: 'u_source' })
    expect(d.requirements.map((r) => r.value)).toEqual(['保留旧要求', '高中难度', '重点考易错点'])
    expect(d.turnIssues).toEqual([])
    expect(v2AiMsg(st).content).toContain('明确指令')
  })

  it('协议连续失败时，题型组合指令仍落为 custom 方案', async () => {
    mocks.chat.mockImplementation(wireReply('协议坏了{{') as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '高中地理板块运动', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const st = await runV2('单选10，多选5，判断5，删除填空题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '单选10，多选5，判断5，删除填空题', tokens: 4 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    const d = st.session!.generationDraft!
    expect(d.countPlan).toMatchObject({ mode: 'custom', typeCounts: { single: { value: 10 }, multiple: { value: 5 }, judge: { value: 5 } } })
    expect(d.countPlan && 'typeCounts' in d.countPlan ? d.countPlan.typeCounts.fill : undefined).toBeUndefined()
    expect(v2AiMsg(st).content).not.toContain('我没能可靠读取')
  })

  it('首次 invalid、二次 valid：只提交一次可见结果（P0-27 buffer）', async () => {
    mocks.chat
      .mockImplementationOnce(wireReply('第一次坏输出{{') as never)
      .mockImplementationOnce(wireReply(
        fence('{"schema_version":2,"intent":"update","acknowledgement":"已改成30题。","patch":{"count_plan":{"op":"set_ai","total":30,"basis":"user_explicit","evidence":"改成30题"}}}'),
      ) as never)
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const st = await runV2('改成30题', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '改成30题', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    const d = st.session!.generationDraft!
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 30 } })
    // 占位最终内容 = 第二次有效回复（首次失败正文从未上屏）
    expect(v2AiMsg(st).content).toContain('已改成30题')
    expect(v2AiMsg(st).content).not.toContain('第一次坏输出')
  })

  it('唯一缺总数时裸答「20」：模型误回纯聊天也用本地可靠字段补齐（P0-26）', async () => {
    mocks.chat.mockImplementation(wireReply('好的，收到你的数字。') as never)
    const seed = makeV2Draft({ sessionId: 's_v2', topic: { value: '海洋知识', basis: 'user_explicit' } })
    const st = await runV2('20', { session: {
      id: 's_v2', title: 'v2', created: Date.now(), summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '20', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [], provider: JSON.stringify(SNAP), generationDraft: seed,
    } })
    const d = st.session!.generationDraft!
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 20 } })
    // ready 后生成入口在方案卡：消息不再挂按钮
    expect(v2AiMsg(st).actions).toBeUndefined()
  })

  it('复合取消「不要出题，只讲概念」：取消草稿 + 一次普通聊天回答（P1-02）', async () => {
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    mocks.chat.mockClear()
    mocks.chat.mockImplementation(wireReply('牛顿第二定律是指……') as never)
    const session: Session = {
      id: 's_v2',
      title: 'v2',
      created: Date.now(),
      summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '不要出题，只讲概念', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [],
      provider: JSON.stringify(SNAP),
      generationDraft: seed,
    }
    useGenerate.setState({ session, phase: 'chatting', abort: new AbortController() })
    await useGenerate.getState().handleGenerationDraftTurn({
      input: '不要出题，只讲概念',
      cfg: CFG,
      snapshot: SNAP,
      userMsgAdded: true,
      placeholderId: 'a1',
      userMessageId: 'u1',
    })
    const st = useGenerate.getState()
    expect(st.session!.generationDraft!.lifecycle).toBe('cancelled')
    expect(v2AiMsg(st).content).toContain('牛顿第二定律')
    expect(mocks.chat).toHaveBeenCalledTimes(1) // 取消本地完成，仅剩余聊天一次调用
  })

  it('假设咨询不建草稿（P1-01）', async () => {
    mocks.chat.mockImplementation(wireReply('可以这样分配：单选10、多选10。') as never)
    const st = await runV2('如果要出20题，应该怎么分配？')
    expect(st.session!.generationDraft).toBeUndefined()
  })

  it('当前 UI 已切走：结果只写回原会话，不闪入当前会话（17 节并发规则）', async () => {
    const seed = makeV2Draft({
      sessionId: 's_v2',
      topic: { value: '海洋知识', basis: 'user_explicit' },
      countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    })
    const sessionA: Session = {
      id: 's_v2',
      title: 'A',
      created: Date.now(),
      summary: '',
      messages: [
        { id: 'u1', role: 'user', content: '改成30题', tokens: 2 },
        { id: 'a1', role: 'assistant', content: '', tokens: 0 },
      ],
      packages: [],
      provider: JSON.stringify(SNAP),
      generationDraft: seed,
    }
    // 先落库 A（loadSession 门禁需要 DB 记录）
    await useGenerate.setState({ session: sessionA, phase: 'chatting', abort: new AbortController() })
    // 先落库 A（控制器提交前会 loadSession 做门禁）
    await saveSession(sessionA)
    // 模型回调期间用户切到会话 B
    mocks.chat.mockImplementationOnce((async (_m: unknown, req: { onToken?: (d: string, r: string) => void }) => {
      useGenerate.setState({ session: { id: 's_b', title: 'B', created: 1, summary: '', messages: [], packages: [], provider: '' } })
      req?.onToken?.(
        fence('{"schema_version":2,"intent":"update","acknowledgement":"好的。","patch":{"count_plan":{"op":"set_ai","total":30,"basis":"user_explicit","evidence":"改成30题"}}}'),
        '',
      )
      return { content: 'fenced', finishReason: 'stop', usage: { outputTokens: 10 } }
    }) as never)
    await useGenerate.getState().handleGenerationDraftTurn({
      input: '改成30题',
      cfg: CFG,
      snapshot: SNAP,
      userMsgAdded: true,
      placeholderId: 'a1',
      userMessageId: 'u1',
    })
    // 原会话 A 落库草稿更新；当前 UI 是 B，未被闪入
    const a = await loadSessionById('s_v2')
    expect(a!.generationDraft!.countPlan).toMatchObject({ mode: 'ai', total: { value: 30 } })
    expect(useGenerate.getState().session!.id).toBe('s_b')
  })

})

/* ============================ TASK-08：不可变 spec 执行与统一生命周期 ============================ */

const readyV2Draft = (over?: Partial<GenerationDraft>): GenerationDraft =>
  makeV2Draft({
    sessionId: 's_v2',
    topic: { value: '海洋知识', basis: 'user_explicit' },
    countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    ...over,
  })

async function seedV2Session(draft: GenerationDraft): Promise<Session> {
  const session: Session = {
    id: 's_v2',
    title: 'v2',
    created: Date.now(),
    summary: '',
    messages: [
      { id: 'u1', role: 'user', content: '围绕海洋知识出20题', tokens: 2 },
      { id: 'a1', role: 'assistant', content: '', tokens: 0 },
    ],
    packages: [],
    provider: JSON.stringify(SNAP),
    generationDraft: draft,
  }
  await saveSession(session)
  useGenerate.setState({ session, phase: 'idle', abort: null })
  return session
}

const mkQuestion = (i: number) => ({
  id: `q_${i}`,
  type: 'single' as const,
  stem: `题干${i}`,
  options: ['A', 'B'],
  answer: 'A',
  explanation: 'E',
  kp_ids: [],
  difficulty: 1 as const,
})

describe('TASK-08 · 不可变 spec 执行与统一生命周期', () => {
  beforeEach(() => {
    useAI.setState({
      providers: { p1: { apiKey: 'k', model: 'm1' } },
      defaultId: 'p1',
    } as never)
    workerMocks.start.mockReset()
    workerMocks.start.mockImplementation(async () => ({
      questions: [mkQuestion(1)],
      session: useGenerate.getState().session!,
      failedBatches: 0,
      deficitByType: {},
      rejects: { parse: 0, invalid: 0, duplicate: 0, invalidByReason: {} },
    }))
  })

  it('成功启动：生成核心输入与 spec 完全一致，完成后草稿置 completed 并落库（18 节步骤 6/7）', async () => {
    await seedV2Session(readyV2Draft())
    await useGenerate.getState().startGenerationFromDraft('gd_v2', 1)
    expect(workerMocks.start).toHaveBeenCalledTimes(1)
    const call = workerMocks.start.mock.calls[0][0] as {
      input: string
      req: { content: string; structure: Record<string, number>; source: string }
      mode?: never
    }
    // spec 显式参数直达生成核心：input=本地模板、结构零基承载 single=20
    expect(call.input).toBe('围绕海洋知识出题')
    expect(call.req.content).toBe('围绕海洋知识出题')
    expect(call.req.structure).toEqual({ ...zeroStructure(), single: 20 })
    expect(call.req.source).toBe('ai')
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.lifecycle).toBe('completed')
    expect(d.topic).toMatchObject({ value: '海洋知识' })
    const raw = await loadSessionById('s_v2')
    expect(raw!.generationDraft!.lifecycle).toBe('completed')
  })

  it('完成态方案可重新打开并编辑，编辑结果仍落库为 active（支持再次生成）', async () => {
    await seedV2Session(readyV2Draft({ lifecycle: 'completed', revision: 3 }))

    await expect(useGenerate.getState().reopenGenerationDraft()).resolves.toBe(true)
    expect(useGenerate.getState().session!.generationDraft).toMatchObject({ lifecycle: 'active', revision: 4 })

    useGenerate.getState().updateGenerationDraft({ kind: 'set_ai_total', total: 25 })
    expect(useGenerate.getState().session!.generationDraft!.countPlan).toMatchObject({
      mode: 'ai',
      total: { value: 25, basis: 'user_explicit' },
    })
    await new Promise((r) => setTimeout(r, 20))
    const raw = await loadSessionById('s_v2')
    expect(raw!.generationDraft).toMatchObject({ lifecycle: 'active', countPlan: { total: { value: 25 } } })
  })

  it('同一 id/revision 连点两次只启动一次（双击防抖，18 节验收）', async () => {
    await seedV2Session(readyV2Draft())
    const p1 = useGenerate.getState().startGenerationFromDraft('gd_v2', 1)
    const p2 = useGenerate.getState().startGenerationFromDraft('gd_v2', 1)
    await Promise.all([p1, p2])
    expect(workerMocks.start).toHaveBeenCalledTimes(1)
  })

  it('旧 revision：提示「方案已更新」，不生成，草稿不受影响（18 节验收）', async () => {
    await seedV2Session(readyV2Draft())
    await useGenerate.getState().startGenerationFromDraft('gd_v2', 0)
    expect(workerMocks.start).not.toHaveBeenCalled()
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.lifecycle).toBe('active')
    expect(d.revision).toBe(1)
  })

  it('跨标签陈旧草稿：IndexedDB 已推进 revision 时旧标签不得启动生成（P0-12）', async () => {
    const stale = readyV2Draft()
    await seedV2Session(stale)
    const latest: Session = {
      ...useGenerate.getState().session!,
      generationDraft: {
        ...stale,
        revision: 2,
        updatedAt: stale.updatedAt + 1,
        requirements: [{ id: 'r_latest', value: '更贴近生活', basis: 'user_explicit' }],
      },
    }
    await saveSession(latest)

    await useGenerate.getState().startGenerationFromDraft(stale.id, stale.revision)

    expect(workerMocks.start).not.toHaveBeenCalled()
    expect(useGenerate.getState().session!.generationDraft).toMatchObject({
      revision: 2,
      requirements: [{ id: 'r_latest', value: '更贴近生活' }],
      lifecycle: 'active',
    })
  })

  it('跨标签陈旧草稿取消：不得用旧快照覆盖 IndexedDB 最新方案（P0-12 竞态补充）', async () => {
    const stale = readyV2Draft()
    await seedV2Session(stale)
    const latest: Session = {
      ...useGenerate.getState().session!,
      generationDraft: {
        ...stale,
        revision: 2,
        updatedAt: stale.updatedAt + 1,
        requirements: [{ id: 'r_latest', value: '更贴近生活', basis: 'user_explicit' }],
      },
    }
    await saveSession(latest)

    await useGenerate.getState().cancelGenerationDraft('card')

    expect(useGenerate.getState().session!.generationDraft).toMatchObject({
      revision: 2,
      requirements: [{ id: 'r_latest', value: '更贴近生活' }],
      lifecycle: 'active',
    })
    expect((await loadSessionById(stale.sessionId))!.generationDraft!.lifecycle).toBe('active')
  })

  it('KB 被删除后点击生成：SOURCE_MISSING 阻断，草稿保持 active（P0-22）', async () => {
    useKB.setState({ bases: [] })
    await seedV2Session(readyV2Draft({ source: { kbScope: KB } }))
    await useGenerate.getState().startGenerationFromDraft('gd_v2', 1)
    expect(workerMocks.start).not.toHaveBeenCalled()
    expect(useGenerate.getState().session!.generationDraft!.lifecycle).toBe('active')
  })

  it('首次请求前失败（0 产出）：恢复 active 并保留可重试信息（18 节步骤 8）', async () => {
    workerMocks.start.mockRejectedValueOnce(new Error('network down'))
    await seedV2Session(readyV2Draft())
    await useGenerate.getState().startGenerationFromDraft('gd_v2', 1)
    expect(workerMocks.start).toHaveBeenCalledTimes(1)
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.lifecycle).toBe('active')
    expect(d.topic).toMatchObject({ value: '海洋知识' })
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 20 } })
  })

  it('updateGenerationDraft：本地编辑走同一 reducer（ui: turnId、user_explicit、落库一致）', async () => {
    await seedV2Session(readyV2Draft())
    useGenerate.getState().updateGenerationDraft({ kind: 'set_ai_total', total: 30 })
    let d = useGenerate.getState().session!.generationDraft!
    expect(d.revision).toBe(2)
    expect(d.countPlan).toMatchObject({ mode: 'ai', total: { value: 30, basis: 'user_explicit' } })
    useGenerate.getState().updateGenerationDraft({ kind: 'append_requirement', text: '难一点' })
    d = useGenerate.getState().session!.generationDraft!
    expect(d.requirements).toHaveLength(1)
    expect(d.requirements[0].basis).toBe('user_explicit')
    useGenerate.getState().updateGenerationDraft({ kind: 'remove_requirement', id: d.requirements[0].id })
    d = useGenerate.getState().session!.generationDraft!
    expect(d.requirements).toHaveLength(0)
    // 落库是 fire-and-forget 串行链：给链路时间完成再断言 DB
    await new Promise((r) => setTimeout(r, 20))
    const raw = await loadSessionById('s_v2')
    expect(raw!.generationDraft!.revision).toBe(4)
  })

  it('updateGenerationDraft：自定义题型保存后以分项合计为最终题数，清除旧 AI 对账总数', async () => {
    const seed = readyV2Draft({
      countPlan: {
        mode: 'custom',
        typeCounts: {
          single: { value: 15, basis: 'user_explicit' },
          multiple: { value: 3, basis: 'user_explicit' },
          judge: { value: 1, basis: 'user_explicit' },
          fill: { value: 1, basis: 'user_explicit' },
          match: { value: 1, basis: 'user_explicit' },
          order: { value: 1, basis: 'user_explicit' },
          short: { value: 1, basis: 'user_explicit' },
          case: { value: 1, basis: 'user_explicit' },
          essay: { value: 1, basis: 'user_explicit' },
        },
        statedTotal: { value: 20, basis: 'user_explicit' },
      },
    })
    await seedV2Session(seed)

    useGenerate.getState().updateGenerationDraft({
      kind: 'set_custom_counts',
      typeCounts: {
        single: 15,
        multiple: 3,
        judge: 1,
        fill: 1,
        match: 1,
        order: 1,
        short: 1,
        case: 1,
        essay: 1,
      },
      unsetStatedTotal: true,
    })

    const next = useGenerate.getState().session!.generationDraft!
    expect(next.countPlan).toMatchObject({ mode: 'custom', typeCounts: { single: { value: 15 } } })
    expect(next.countPlan && 'statedTotal' in next.countPlan ? next.countPlan.statedTotal : undefined).toBeUndefined()
    expect(evaluateGenerationDraft(next)).toMatchObject({ ready: true, effectiveTotal: 25 })
  })

  it('updateGenerationDraft accept_current：只清 turnIssues 不加 revision（7.6）', async () => {
    const seed = readyV2Draft({
      turnIssues: [{ code: 'TURN_UPDATE_NOT_APPLIED', message: '上一轮修改未能应用' }],
    })
    await seedV2Session(seed)
    useGenerate.getState().updateGenerationDraft({ kind: 'accept_current' })
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.turnIssues).toEqual([])
    expect(d.revision).toBe(seed.revision)
  })

  it('updateGenerationDraft clear_source：source 清空、topic 保留（5.4）', async () => {
    await seedV2Session(readyV2Draft({ source: { sourceMessageId: 'm1' } }))
    useGenerate.getState().updateGenerationDraft({ kind: 'clear_source' })
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.source).toEqual({})
    expect(d.topic).toMatchObject({ value: '海洋知识' })
    expect(d.revision).toBe(2)
  })

  it('cancelGenerationDraft（card）：active → cancelled，revision +1（P0-08/7.5）', async () => {
    await seedV2Session(readyV2Draft())
    await useGenerate.getState().cancelGenerationDraft('card')
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.lifecycle).toBe('cancelled')
    expect(d.revision).toBe(2)
    // 落库 fire-and-forget：等待后断言 DB
    await new Promise((r) => setTimeout(r, 20))
    const raw = await loadSessionById('s_v2')
    expect(raw!.generationDraft!.lifecycle).toBe('cancelled')
  })

  it('快捷生成回归：generate() 经 quick spec 直达生成核心，结构与模式不变（S-09/18 节验收）', async () => {
    useGenerate.setState({
      session: { id: 's_q', title: 'q', created: 1, summary: '', messages: [], packages: [], provider: JSON.stringify(SNAP) },
      phase: 'idle',
      structureMode: 'ai',
      structureTotal: 5,
      structure: { ...zeroStructure(), single: 5 },
    })
    await useGenerate.getState().generate('海洋知识', {})
    expect(workerMocks.start).toHaveBeenCalledTimes(1)
    const call = workerMocks.start.mock.calls[0][0] as {
      input: string
      req: { structure: Record<string, number>; source: string }
      mode?: never
    }
    expect(call.input).toBe('海洋知识')
    expect(call.req.structure).toEqual({ ...zeroStructure(), single: 5 })
    expect(call.req.source).toBe('ai')
  })
})
