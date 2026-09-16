import 'fake-indexeddb/auto'
import { resetDB, clearAllStores, dbConfig, dbSessions, dbPacks, dbUsage } from '../src/db'
import { useGenerate } from '../src/stores/useGenerateStore'
import { useAI } from '../src/stores/useAIStore'
import { usePacks } from '../src/stores/usePackStore'
import { useUI } from '../src/stores/useUIStore'
import { defaultStructure, recommendStructure } from '../src/services/generation/structure'
import { validateQuestion } from '../src/services/validation'
import type { AIConfig, Pack, Question, QuestionTypeId, Session } from '../src/types'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

const cfg: AIConfig = {
  defaultId: 'deepseek',
  providers: {
    deepseek: { apiKey: 'test-key', model: 'deepseek-chat' },
  },
}
const snap = { providerId: 'deepseek', model: 'deepseek-chat' }

function mockFetch(handler: (url: string, init?: RequestInit, call?: number) => Promise<Response> | Response) {
  let call = 0
  const fn = async (url: string, init?: RequestInit) => {
    call++
    // 微延迟，避免同一毫秒内多条用量记录 id 冲突
    await new Promise((r) => setTimeout(r, 2))
    return handler(url, init, call)
  }
  ;(fn as unknown as { __calls: () => number }).__calls = () => call
  globalThis.fetch = fn as unknown as typeof fetch
  return fn as unknown as { __calls: () => number }
}

function bodyOf(init?: RequestInit): { messages: { role: string; content: string }[] } {
  return JSON.parse(String(init?.body))
}

function okText(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    }),
  } as unknown as Response
}

/** 构造 SSE 流式响应（按块逐条 delta），供流式生题批次 mock 使用 */
function sseStream(deltas: string[]): Response {
  const encoder = new TextEncoder()
  const parts = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
  parts.push('data: [DONE]\n\n')
  const arrs = parts.map((p) => encoder.encode(p))
  let i = 0
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (; i < arrs.length; i++) c.enqueue(arrs[i])
        c.close()
      },
    }),
    json: async () => ({ choices: [] }),
  } as unknown as Response
}

/** 构造可被流式增量解析的 md 题块 */
function mdQuestion(typeName: string, stem: string, opts?: string[]): string {
  const lines: string[] = ['=== 第题 ===', `题型：${typeName}`, `题干：${stem}`]
  if (opts?.length) {
    lines.push('选项：')
    opts.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}. ${o}`))
  }
  if (typeName === '判断题') lines.push('答案：正确')
  else if (typeName === '单选题') lines.push('答案：A')
  else lines.push('答案：参考答案要点')
  lines.push('解析：这道题的解析说明', '知识点：测试', '难度：2')
  return lines.join('\n')
}

/** 生成流程 mock：按系统提示区分 structure / summary / 生题批次（生题为 SSE 流式 md） */
function genMock() {
  return mockFetch((_url, init) => {
    const body = bodyOf(init)
    const sys = body.messages[0].content
    if (sys.includes('出题规划助手')) return okText('{"single":8,"judge":2}')
    if (sys.includes('对话记录整理助手')) return okText('用户想学 Python 基础，已生成 3 道题。')
    const userMsg = body.messages[body.messages.length - 1].content
    const batchLine = userMsg.match(/本批请生成 (\d+) 道「(.+?)」题/) ?? []
    const n = Number(batchLine[1] ?? 1)
    const typeName = batchLine[2] ?? '单选题'
    const blocks = Array.from({ length: n }, (_, i) => {
      if (typeName === '单选题') return mdQuestion('单选题', `${typeName}题 ${i + 1}`, ['A', 'B', 'C', 'D'])
      if (typeName === '判断题') return mdQuestion('判断题', `${typeName}题 ${i + 1}`, ['正确', '错误'])
      return mdQuestion(typeName, `${typeName}题 ${i + 1}`)
    })
    return sseStream(blocks.map((b, idx) => (idx === 0 ? b : '\n' + b)))
  })
}

function resetStores() {
  useGenerate.setState({
    session: null,
    loaded: false,
    structure: defaultStructure(),
    structureMode: 'custom',
    templates: {},
    phase: 'idle',
    progress: null,
    validation: null,
    error: null,
    abort: null,
    drafts: {},
    lastInput: '',
  })
  usePacks.setState({ packs: [], categories: [''], loaded: false })
  useUI.setState({ toast: null })
}

async function run() {
  resetDB()
  await clearAllStores()
  resetStores()

  console.log('—— 默认结构 ——')
  const def = defaultStructure()
  assert(def.single === 10 && def.judge === 5 && def.fill === 5, '默认结构 single10/judge5/fill5')
  assert(def.multiple === 0 && def.match === 0 && def.short === 0 && def.essay === 0, '其余题型默认 0')

  console.log('—— 结构推荐（服务层） ——')
  const okMock = mockFetch(() => okText('{"single":8,"judge":2}'))
  const s1 = await recommendStructure('Python 基础', cfg, snap)
  assert(s1.single === 8 && s1.judge === 2 && s1.fill === 5, '解析推荐结构并保留未指定题型默认值')
  assert(okMock.__calls() === 1, '推荐只调 1 次')

  const badMock = mockFetch(() => okText('这不是 JSON'))
  const s2 = await recommendStructure('Python 基础', cfg, snap)
  assert(s2.single === 10, '解析失败回退默认结构')
  assert(badMock.__calls() === 1, '失败不重试')

  const partialMock = mockFetch(() => okText('{"single":3,"nope":5}'))
  const s3 = await recommendStructure('x', cfg, snap)
  assert(s3.single === 3 && s3.judge === 5, '非法题型键忽略，合法键生效')

  console.log('—— 会话管理 ——')
  await useGenerate.getState().load()
  assert(useGenerate.getState().loaded === true, 'load 标记完成')
  assert(useGenerate.getState().session === null, '空库无会话')
  assert(Object.keys(useGenerate.getState().drafts).length === 0, '空库无草稿')

  console.log('—— 结构配置 ——')
  const g = useGenerate.getState()
  g.setStructure('single', 15)
  assert(useGenerate.getState().structure.single === 15, 'setStructure 更新数量')
  assert(useGenerate.getState().structureMode === 'custom', '手动调整切回自定义')
  g.setStructure('single', -5)
  assert(useGenerate.getState().structure.single === 0, '数量下限 0')
  g.setStructure('single', 999)
  assert(useGenerate.getState().structure.single === 100, '数量上限 100')
  g.applyStructure({ single: 3, judge: 4 }, 'ai')
  assert(useGenerate.getState().structure.single === 3 && useGenerate.getState().structure.judge === 4, 'applyStructure 应用结构')
  assert(useGenerate.getState().structureMode === 'ai', 'applyStructure 标记 AI 模式')
  await useGenerate.getState().saveTemplate('考试')
  const savedTpl = (await dbConfig.get('gen-templates')) as Record<string, Record<QuestionTypeId, number>>
  assert(!!savedTpl?.考试 && savedTpl.考试.single === 3, '模板保存并持久化')

  console.log('—— 生成流程：前置校验 ——')
  useAI.setState({ providers: { deepseek: { apiKey: '', model: '' } }, defaultId: 'deepseek', loaded: true })
  resetStores()
  await useGenerate.getState().generate('Python 基础')
  assert(useGenerate.getState().phase === 'idle', '未配 Key 不进入生成')
  assert(useUI.getState().toast?.includes('请先配置 AI 模型'), '未配 Key 提示去配置')

  useAI.setState({ providers: { deepseek: { apiKey: 'k', model: 'm' } }, defaultId: 'deepseek', loaded: true })
  resetStores()
  useGenerate.setState({ structure: { ...defaultStructure(), single: 0, judge: 0, fill: 0 } })
  await useGenerate.getState().generate('Python 基础')
  assert(useGenerate.getState().phase === 'idle', '全零结构不进入生成')
  assert(useUI.getState().toast?.includes('至少选择一种题型'), '全零结构提示')

  resetStores()
  await useGenerate.getState().generate('  ')
  assert(useGenerate.getState().phase === 'idle', '空输入不进入生成')
  assert(useUI.getState().toast?.includes('请输入学习内容'), '空输入提示')

  console.log('—— 生成流程：成功 ——')
  useAI.setState({ providers: { deepseek: { apiKey: 'k', model: 'm' } }, defaultId: 'deepseek', loaded: true })
  resetStores()
  useGenerate.setState({ structure: { ...defaultStructure(), single: 2, judge: 1, fill: 0 }, structureMode: 'custom' })
  const mock = genMock()
  const progressQuestions: number[] = []
  useGenerate.subscribe((s, prev) => {
    if (s.progress && s.progress !== prev.progress && s.progress.questions !== prev.progress?.questions) {
      progressQuestions.push(s.progress.questions)
    }
  })
  await useGenerate.getState().generate('Python 基础')
  const st = useGenerate.getState()
  assert(st.phase === 'done', '生成完成进入 done')
  assert(st.session !== null && st.session.title === 'Python 基础', '会话已创建并自动命名')
  assert(st.session.messages.length === 2, '会话含用户 + AI 两条消息')
  assert(st.session.messages[0].role === 'user' && st.session.messages[0].content === 'Python 基础', '用户消息')
  const aiMsg = st.session.messages[1]
  assert(aiMsg.role === 'assistant' && aiMsg.result?.status === 'draft', 'AI 消息挂草稿题包')
  assert(aiMsg.result?.questionCount === 3, '题包计数 3 题')
  const packIds = Object.keys(st.drafts)
  assert(packIds.length === 1, '草稿题包已保存')
  const pack = st.drafts[packIds[0]]
  assert(pack.questions.length === 3, '草稿含 3 题')
  assert(pack.questions.filter((q) => q.type === 'single').length === 2, '单选 2 题')
  assert(pack.questions.filter((q) => q.type === 'judge').length === 1, '判断 1 题')
  assert(st.validation?.total === 3 && st.validation.passed === 3 && st.validation.issueCount === 0, '校验全部通过')
  assert(st.lastInput === 'Python 基础', '记录上次输入')
  assert(progressQuestions.some((n) => n > 0 && n < 3), `流式进度实时递增（${progressQuestions.join(',')}）`)
  assert(progressQuestions[progressQuestions.length - 1] === 3, '最终进度 3/3')
  assert(mock.__calls() === 3, '共 3 次请求（2 批 + 1 摘要）')

  const persisted = await dbSessions.get(st.session.id)
  assert(persisted?.messages.length === 2 && persisted.messages[1].result?.status === 'draft', '会话已持久化')
  const usage = await dbUsage.getAll()
  assert(usage.filter((u) => u.module === 'generate').length === 2, '生成批次记入用量')
  assert(usage.filter((u) => u.module === 'summary').length === 1, '摘要记入用量')

  console.log('—— 会话恢复（load 草稿） ——')
  resetStores()
  await useGenerate.getState().load()
  const restored = useGenerate.getState()
  assert(restored.session?.id === st.session.id, 'load 恢复最近会话')
  assert(Object.keys(restored.drafts).length === 1, 'load 恢复草稿题包')

  console.log('—— 入库 ——')
  const packId = packIds[0]
  await useGenerate.getState().addToBank(packId)
  const afterBank = useGenerate.getState()
  assert(Object.keys(afterBank.drafts).length === 0, '入库后草稿移除')
  assert(usePacks.getState().packs.length === 1 && usePacks.getState().packs[0].id === packId, '题包进入题库')
  const bankMsg = afterBank.session?.messages.find((m) => m.result?.id === packId)
  assert(bankMsg?.result?.status === 'in_bank', '消息状态更新为 in_bank')
  const bankPersisted = await dbSessions.get(afterBank.session!.id)
  assert(bankPersisted?.messages.find((m) => m.result?.id === packId)?.result?.status === 'in_bank', '入库状态已持久化')
  assert((await dbPacks.get(packId)) !== undefined, '题包持久化到 packs')

  console.log('—— 删除草稿 ——')
  resetStores()
  await usePacks.getState().load()
  await useGenerate.getState().load()
  const delPackId = Object.keys(useGenerate.getState().drafts)[0]
  await useGenerate.getState().deleteDraft(delPackId)
  const afterDel = useGenerate.getState()
  assert(Object.keys(afterDel.drafts).length === 0, '删除后草稿移除')
  assert(!afterDel.session?.messages.some((m) => m.result?.id === delPackId), '删除后消息移除')
  const delPersisted = await dbSessions.get(afterDel.session!.id)
  assert(!delPersisted?.messages.some((m) => m.result?.id === delPackId), '删除状态已持久化')
  assert(usePacks.getState().packs.length === 1, '题库题包不受影响')

  console.log('—— 新建会话 ——')
  useGenerate.getState().newSession()
  const ns = useGenerate.getState()
  assert(ns.session === null && ns.phase === 'idle' && Object.keys(ns.drafts).length === 0, 'newSession 清空会话与草稿')
  assert(ns.structure.single === 10, 'newSession 保留结构配置')

  console.log('—— 编辑 / 删除 / 批量处理 ——')
  const pidE = 'p_edit'
  const eq1: Question = { id: 'eq1', type: 'single', stem: '原题干', answer: '[0]', explanation: '解', options: ['A', 'B', 'C', 'D'], kp_ids: [], difficulty: 1 }
  const eq2: Question = { id: 'eq2', type: 'single', stem: '第二题', answer: '[1]', explanation: '解', options: ['A', 'B', 'C', 'D'], kp_ids: [], difficulty: 1 }
  const eq3: Question = { id: 'eq3', type: 'judge', stem: '判断', answer: 'true', explanation: '解', options: ['正确', '错误'], kp_ids: [], difficulty: 1 }
  const packE: Pack = { id: pidE, title: '编辑测试', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] }, chapters: [], questions: [eq1, eq2, eq3], created_at: Date.now() }
  useGenerate.setState({ drafts: { [pidE]: packE }, session: null })
  await useGenerate.getState().updateQuestion(pidE, 'eq1', { stem: '修改后的题干' })
  let dE = useGenerate.getState().drafts[pidE]
  assert(dE.questions.find((q) => q.id === 'eq1')?.stem === '修改后的题干', 'updateQuestion 修改题干')
  assert(dE.questions.length === 3, '编辑不改题数')
  const persistedE = (await dbConfig.get('gen-draft:p_edit')) as Pack
  assert(persistedE?.questions.find((q) => q.id === 'eq1')?.stem === '修改后的题干', '编辑已持久化')

  await useGenerate.getState().removeQuestion(pidE, 'eq2')
  dE = useGenerate.getState().drafts[pidE]
  assert(dE.questions.length === 2, 'removeQuestion 删除单题')

  await useGenerate.getState().updateQuestion(pidE, 'eq1', { stem: '' })
  dE = useGenerate.getState().drafts[pidE]
  assert(validateQuestion(dE.questions[0]).length > 0, '清空题干制造异常题')
  await useGenerate.getState().removeIssues(pidE)
  dE = useGenerate.getState().drafts[pidE]
  assert(dE.questions.length === 1 && dE.questions[0].id === 'eq3', 'removeIssues 批量删除异常题')
  assert(validateQuestion(dE.questions[0]).length === 0, '剩余题目均通过校验')

  console.log('—— 入库过滤异常题 ——')
  const pidF = 'p_filter'
  const fBad: Question = { id: 'f_bad', type: 'single', stem: '', answer: '[0]', explanation: '解', options: ['A', 'B'], kp_ids: [], difficulty: 1 }
  const fGood: Question = { id: 'f_good', type: 'single', stem: '好题', answer: '[0]', explanation: '解', options: ['A', 'B'], kp_ids: [], difficulty: 1 }
  const packF: Pack = { id: pidF, title: '过滤测试', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] }, chapters: [], questions: [fBad, fGood], created_at: Date.now() }
  useGenerate.setState({ drafts: { [pidF]: packF }, session: null })
  await useGenerate.getState().addToBank(pidF)
  const packsAfter = usePacks.getState().packs
  assert(packsAfter.length === 2, '入库后题库 +1')
  const bankedF = packsAfter[packsAfter.length - 1]
  assert(bankedF.id === pidF && bankedF.questions.length === 1 && bankedF.questions[0].id === 'f_good', '只入库通过题')
  assert(Object.keys(useGenerate.getState().drafts).length === 0, '入库后草稿移除')

  const pidAll = 'p_allbad'
  const allBad: Pack = { id: pidAll, title: '全异常', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] }, chapters: [], questions: [{ ...fBad, id: 'a1' }], created_at: Date.now() }
  useGenerate.setState({ drafts: { [pidAll]: allBad } })
  await useGenerate.getState().addToBank(pidAll)
  assert(usePacks.getState().packs.length === 2, '全异常不入库')
  assert(useUI.getState().toast?.includes('没有可通过校验'), '提示无通过题')
  assert(useGenerate.getState().drafts[pidAll] !== undefined, '全异常草稿保留')

  console.log('—— 草稿 24 小时过期 ——')
  const expNow = Date.now()
  const freshPack: Pack = { id: 'p_fresh', title: '新草稿', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] }, chapters: [], questions: [], created_at: expNow }
  const oldPack: Pack = { id: 'p_old', title: '旧草稿', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] }, chapters: [], questions: [], created_at: expNow - 25 * 60 * 60 * 1000 }
  const orphanPack: Pack = { id: 'p_orphan', title: '孤儿草稿', category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] }, chapters: [], questions: [], created_at: expNow - 26 * 60 * 60 * 1000 }
  const expSession: Session = {
    id: 's_exp', title: '过期测试', created: expNow, summary: '',
    messages: [
      { id: 'em1', role: 'user', content: '测试', tokens: 0 },
      { id: 'em2', role: 'assistant', content: '新草稿', tokens: 0, result: { id: 'p_fresh', title: '新草稿', questionCount: 0, status: 'draft' } },
      { id: 'em3', role: 'assistant', content: '旧草稿', tokens: 0, result: { id: 'p_old', title: '旧草稿', questionCount: 0, status: 'draft' } },
    ],
    packages: [], provider: '{"providerId":"deepseek","model":"deepseek-chat"}',
  }
  await dbSessions.put(expSession)
  await dbConfig.set('gen-draft:p_fresh', freshPack)
  await dbConfig.set('gen-draft:p_old', oldPack)
  await dbConfig.set('gen-draft:p_orphan', orphanPack)
  resetStores()
  await useGenerate.getState().load()
  const expState = useGenerate.getState()
  assert(Object.keys(expState.drafts).length === 1 && expState.drafts.p_fresh !== undefined, '未过期草稿保留')
  assert(expState.drafts.p_old === undefined, '过期草稿不加载')
  assert(!expState.session?.messages.some((m) => m.result?.id === 'p_old'), '过期草稿消息从会话移除')
  assert(expState.session?.messages.some((m) => m.result?.id === 'p_fresh'), '未过期草稿消息保留')
  assert((await dbConfig.get('gen-draft:p_old')) === null, '过期草稿 config 已清理')
  assert((await dbConfig.get('gen-draft:p_orphan')) === null, '孤儿过期草稿 config 已清理')
  assert((await dbConfig.get('gen-draft:p_fresh')) !== null, '未过期草稿 config 保留')
  const expPersisted = await dbSessions.get('s_exp')
  assert(!expPersisted?.messages.some((m) => m.result?.id === 'p_old'), '会话清理已持久化')

  console.log('—— store.recommend ——')
  resetStores()
  useAI.setState({ providers: { deepseek: { apiKey: 'k', model: 'm' } }, defaultId: 'deepseek', loaded: true })
  const recMock = mockFetch(() => okText('{"single":6,"fill":4}'))
  await useGenerate.getState().recommend('Python 基础')
  const rec = useGenerate.getState()
  assert(rec.structure.single === 6 && rec.structure.fill === 4, 'store.recommend 应用结构')
  assert(rec.structureMode === 'ai', 'store.recommend 标记 AI 模式')
  assert(recMock.__calls() === 1, 'recommend 只调 1 次')

  console.log('—— answer 归一化（模型返回数组/布尔） ——')
  resetStores()
  useAI.setState({ providers: { deepseek: { apiKey: 'k', model: 'm' } }, defaultId: 'deepseek', loaded: true })
  useGenerate.setState({ structure: { ...defaultStructure(), single: 1, judge: 1, fill: 0 }, structureMode: 'custom' })
  mockFetch((_url, init) => {
    const body = bodyOf(init)
    const sys = body.messages[0].content
    if (sys.includes('对话记录整理助手')) return okText('已生成 2 道题。')
    const userMsg = body.messages[body.messages.length - 1].content
    const batchLine = userMsg.match(/本批请生成 (\d+) 道「(.+?)」题/) ?? []
    const n = Number(batchLine[1] ?? 1)
    const typeName = batchLine[2] ?? '单选题'
    const blocks = Array.from({ length: n }, (_, i) =>
      typeName === '单选题'
        ? mdQuestion('单选题', `单选 ${i + 1}`, ['A', 'B', 'C', 'D'])
        : mdQuestion('判断题', `判断 ${i + 1}`, ['正确', '错误']),
    )
    return sseStream(blocks)
  })
  await useGenerate.getState().generate('Python 基础')
  const norm = useGenerate.getState()
  const normPack = Object.values(norm.drafts)[0]
  const singleQ = normPack.questions.find((q) => q.type === 'single')
  const judgeQ = normPack.questions.find((q) => q.type === 'judge')
  assert(typeof singleQ?.answer === 'string' && singleQ.answer === '[0]', '单选数组 answer 归一化为 "[0]"')
  assert(typeof judgeQ?.answer === 'string' && judgeQ.answer === 'true', '判断布尔 answer 归一化为 "true"')
  assert(norm.validation?.issueCount === 0, '归一化后校验全部通过')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
