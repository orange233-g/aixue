/**
 * TASK-10：Store 集成时序矩阵。
 * 使用 fake IndexedDB + gateway/worker mock，不依赖 React Testing Library 或 jsdom。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllStores, initDB } from '../db'
import type { GenerationDraft, Session } from '../types'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  generationStart: vi.fn(),
}))

vi.mock('../ai/gateway', () => ({ chat: mocks.chat }))
vi.mock('../workers/generationWorkerClient', () => ({ generationStart: mocks.generationStart }))

import { loadSession, saveSession } from '../services/generation/session'
import { useAI } from './useAIStore'
import { useGenerate } from './useGenerateStore'

const CFG = { providers: { p1: { apiKey: 'test-key', model: 'test-model' } }, defaultId: 'p1' }
const SNAP = { providerId: 'p1', model: 'test-model' }

function draft(over: Partial<GenerationDraft> = {}): GenerationDraft {
  const now = Date.now()
  return {
    schemaVersion: 2,
    id: 'gd_task10',
    sessionId: 's_task10',
    revision: 1,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
    topic: { value: '牛顿第二定律', basis: 'user_explicit' },
    countPlan: { mode: 'ai', total: { value: 20, basis: 'user_explicit' } },
    requirements: [],
    source: {},
    appliedTurnIds: [],
    turnIssues: [],
    ...over,
  }
}

function session(d: GenerationDraft | undefined = draft(), input = '改成30题'): Session {
  return {
    id: 's_task10',
    title: 'TASK-10',
    created: Date.now(),
    summary: '',
    messages: [
      { id: 'u_task10', role: 'user', content: input, tokens: 2 },
      { id: 'a_task10', role: 'assistant', content: '', tokens: 0 },
    ],
    packages: [],
    provider: JSON.stringify(SNAP),
    ...(d ? { generationDraft: d } : {}),
  }
}

function wire(content: string) {
  return async (_messages: unknown, req: { onToken?: (delta: string, reasoning: string) => void }) => {
    req.onToken?.(content, '')
    return { content, finishReason: 'stop', usage: { outputTokens: 10 } }
  }
}

function updatePatch(acknowledgement: string, patch: Record<string, unknown>) {
  return `好的。\n\`\`\`gen_draft_patch\n${JSON.stringify({
    schema_version: 2,
    intent: 'update',
    acknowledgement,
    patch,
  })}\n\`\`\``
}

async function seed(d = draft(), input = '改成30题') {
  const s = session(d, input)
  await saveSession(s)
  useGenerate.setState({
    session: s,
    phase: 'chatting',
    error: null,
    abort: new AbortController(),
    pendingChats: [],
  })
  return s
}

async function runTurn(input: string, d: GenerationDraft, ids = { user: 'u_task10', assistant: 'a_task10' }) {
  const s = await seed(d, input)
  s.messages = [
    { id: ids.user, role: 'user', content: input, tokens: 2 },
    { id: ids.assistant, role: 'assistant', content: '', tokens: 0 },
  ]
  await saveSession(s)
  useGenerate.setState({ session: s, phase: 'chatting', abort: new AbortController() })
  await useGenerate.getState().handleGenerationDraftTurn({
    input,
    cfg: CFG,
    snapshot: SNAP,
    userMsgAdded: true,
    placeholderId: ids.assistant,
    userMessageId: ids.user,
  })
  return useGenerate.getState()
}

function generationResult(s: Session) {
  return {
    questions: [
      {
        id: 'q_task10',
        type: 'single' as const,
        stem: '下列说法正确的是？',
        options: ['A', 'B'],
        answer: 'A',
        explanation: '测试题',
        kp_ids: [],
        difficulty: 1 as const,
      },
    ],
    session: s,
    failedBatches: 0,
    deficitByType: {},
    rejects: { parse: 0, invalid: 0, duplicate: 0, invalidByReason: {} },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function aiTotal(d: GenerationDraft) {
  return d.countPlan?.mode === 'ai' ? d.countPlan.total.value : undefined
}

describe('TASK-10 · Store 集成时序矩阵（9 条必测时序）', () => {
  beforeEach(async () => {
    initDB()
    await clearAllStores()
    mocks.chat.mockReset()
    mocks.generationStart.mockReset()
    useAI.setState({ providers: CFG.providers, defaultId: 'p1' } as never)
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('1. A pending → cancel；A 返回后不能复活已取消草稿', async () => {
    const d = draft()
    await seed(d, '改成30题')
    const gate = deferred<ReturnType<typeof wire> extends (...a: never[]) => infer R ? Awaited<R> : never>()
    mocks.chat.mockImplementation(() => gate.promise)
    const pending = useGenerate.getState().handleGenerationDraftTurn({
      input: '改成30题', cfg: CFG, snapshot: SNAP, userMsgAdded: true,
      placeholderId: 'a_task10', userMessageId: 'u_task10',
    })
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1))
    useGenerate.getState().cancelGenerationDraft('card')
    await new Promise((r) => setTimeout(r, 10))
    gate.resolve({ content: updatePatch('已改成30题。', { count_plan: { op: 'set_ai', total: 30, basis: 'user_explicit', evidence: '改成30题' } }), finishReason: 'stop', usage: { outputTokens: 10 } })
    await pending
    expect(useGenerate.getState().session!.generationDraft!.lifecycle).toBe('cancelled')
    expect(aiTotal(useGenerate.getState().session!.generationDraft!)).toBe(20)
  })

  it('2. A pending → switch session；结果只写原会话，不闪入当前会话', async () => {
    const a = await seed(draft(), '改成30题')
    const gate = deferred<{ content: string; finishReason: string; usage: { outputTokens: number } }>()
    mocks.chat.mockImplementation(() => gate.promise)
    const pending = useGenerate.getState().handleGenerationDraftTurn({
      input: '改成30题', cfg: CFG, snapshot: SNAP, userMsgAdded: true,
      placeholderId: 'a_task10', userMessageId: 'u_task10',
    })
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1))
    const b: Session = { id: 's_other', title: 'B', created: 1, summary: '', messages: [], packages: [], provider: JSON.stringify(SNAP) }
    useGenerate.setState({ session: b })
    gate.resolve({ content: updatePatch('已改成30题。', { count_plan: { op: 'set_ai', total: 30, basis: 'user_explicit', evidence: '改成30题' } }), finishReason: 'stop', usage: { outputTokens: 10 } })
    await pending
    expect(useGenerate.getState().session!.id).toBe('s_other')
    expect(aiTotal((await loadSession(a.id))!.generationDraft!)).toBe(30)
  })

  it('3. 两次补充按顺序提交 revision +1 / +2', async () => {
    const first = updatePatch('已加难度。', { requirements: { append: [{ text: '难一点', basis: 'user_explicit', evidence: '难一点' }] } })
    const second = updatePatch('已聚焦实验。', { requirements: { append: [{ text: '聚焦实验', basis: 'user_explicit', evidence: '聚焦实验' }] } })
    mocks.chat.mockImplementationOnce(wire(first)).mockImplementationOnce(wire(second))
    const st1 = await runTurn('难一点', draft(), { user: 'u1', assistant: 'a1' })
    const s2 = st1.session!
    s2.messages = [...s2.messages, { id: 'u2', role: 'user', content: '聚焦实验', tokens: 2 }, { id: 'a2', role: 'assistant', content: '', tokens: 0 }]
    await saveSession(s2)
    useGenerate.setState({ session: s2, phase: 'chatting', abort: new AbortController() })
    await useGenerate.getState().handleGenerationDraftTurn({ input: '聚焦实验', cfg: CFG, snapshot: SNAP, userMsgAdded: true, placeholderId: 'a2', userMessageId: 'u2' })
    const d = useGenerate.getState().session!.generationDraft!
    expect(d.revision).toBe(3)
    expect(d.requirements.map((r) => r.value)).toEqual(['难一点', '聚焦实验'])
  })

  it('4. 首次协议无效、第二次有效：只应用一次', async () => {
    mocks.chat.mockImplementationOnce(wire('坏输出')).mockImplementationOnce(wire(updatePatch('已改成30题。', { count_plan: { op: 'set_ai', total: 30, basis: 'user_explicit', evidence: '改成30题' } })))
    const st = await runTurn('改成30题', draft())
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(st.session!.generationDraft!.revision).toBe(2)
    expect(aiTotal(st.session!.generationDraft!)).toBe(30)
  })

  it('5. 两次协议无效且无明确字段：草稿保持不变', async () => {
    mocks.chat.mockImplementation(wire('坏输出'))
    const st = await runTurn('调整一下方案，保留当前语义', draft())
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(st.session!.generationDraft!.revision).toBe(1)
    expect(aiTotal(st.session!.generationDraft!)).toBe(20)
    expect(st.session!.generationDraft!.turnIssues.length).toBeGreaterThan(0)
  })

  it('6. 生成按钮双击：只发出一次 generation request', async () => {
    const d = draft({ id: 'gd_double', sessionId: 's_task10' })
    const s = await seed(d, '围绕牛顿第二定律出20题')
    const gate = deferred<ReturnType<typeof generationResult>>()
    let startedSession: Session | undefined
    mocks.chat.mockResolvedValue({ content: '', finishReason: 'stop', usage: { outputTokens: 1 } })
    mocks.generationStart.mockImplementation(async (args: { session: Session }) => {
      startedSession = args.session
      return gate.promise
    })
    const p1 = useGenerate.getState().startGenerationFromDraft(d.id, 1)
    await vi.waitFor(() => expect(mocks.generationStart).toHaveBeenCalledTimes(1))
    const p2 = useGenerate.getState().startGenerationFromDraft(d.id, 1)
    expect(mocks.generationStart).toHaveBeenCalledTimes(1)
    gate.resolve(generationResult(startedSession ?? s))
    await Promise.all([p1, p2])
  })

  it('7. spec 在生成前冻结：编辑草稿不改变执行输入', async () => {
    const d = draft({ id: 'gd_spec', sessionId: 's_task10' })
    await seed(d, '围绕牛顿第二定律出20题')
    const gate = deferred<ReturnType<typeof generationResult>>()
    let call: { input: string; req: { content: string; structure: Record<string, number> } } | undefined
    mocks.chat.mockResolvedValue({ content: '', finishReason: 'stop', usage: { outputTokens: 1 } })
    mocks.generationStart.mockImplementation(async (args: typeof call & { session: Session }) => {
      call = args
      return gate.promise
    })
    const pending = useGenerate.getState().startGenerationFromDraft(d.id, 1)
    await vi.waitFor(() => expect(mocks.generationStart).toHaveBeenCalledTimes(1))
    useGenerate.getState().updateGenerationDraft({ kind: 'set_ai_total', total: 30 })
    expect(call!.req.content).toBe('围绕牛顿第二定律出题')
    expect(call!.req.structure.single).toBe(20)
    gate.resolve(generationResult(useGenerate.getState().session!))
    await pending
  })

  it('8. 刷新后继续：保留 source 与历史字段', async () => {
    const d = draft({ source: { sourceMessageId: 'source_old' } })
    const s = await seed(d, '改成30题')
    s.summary = '历史摘要'
    s.messages.unshift({ id: 'old', role: 'user', content: '旧问题', tokens: 1 })
    await saveSession(s)
    useGenerate.setState({ session: null })
    const restored = await loadSession(s.id)
    useGenerate.setState({ session: restored, phase: 'chatting', abort: new AbortController() })
    mocks.chat.mockImplementation(wire(updatePatch('已改成30题。', { count_plan: { op: 'set_ai', total: 30, basis: 'user_explicit', evidence: '改成30题' } })))
    await useGenerate.getState().handleGenerationDraftTurn({ input: '改成30题', cfg: CFG, snapshot: SNAP, userMsgAdded: true, placeholderId: 'a_task10', userMessageId: 'u_task10' })
    const current = useGenerate.getState().session!
    expect(current.summary).toBe('历史摘要')
    expect(current.messages.some((m) => m.id === 'old')).toBe(true)
    expect(current.generationDraft!.source).toEqual({ sourceMessageId: 'source_old' })
  })

  it('9. 清空会话后迟到响应：不得重新创建已删除 Session', async () => {
    await seed(draft(), '改成30题')
    const gate = deferred<{ content: string; finishReason: string; usage: { outputTokens: number } }>()
    mocks.chat.mockImplementation(() => gate.promise)
    const pending = useGenerate.getState().handleGenerationDraftTurn({ input: '改成30题', cfg: CFG, snapshot: SNAP, userMsgAdded: true, placeholderId: 'a_task10', userMessageId: 'u_task10' })
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1))
    await useGenerate.getState().clearSessions()
    gate.resolve({ content: updatePatch('已改成30题。', { count_plan: { op: 'set_ai', total: 30, basis: 'user_explicit', evidence: '改成30题' } }), finishReason: 'stop', usage: { outputTokens: 10 } })
    await pending
    expect(useGenerate.getState().session).toBeNull()
    expect(await loadSession('s_task10')).toBeUndefined()
  })
})
