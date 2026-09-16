import 'fake-indexeddb/auto'
import { resetDB, dbUsage, clearAllStores, dbSessions } from '../src/db'
import {
  createSession,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  encodeSnapshot,
  decodeSnapshot,
  autoTitle,
  estimateTokens,
  buildSystemPrompt,
  buildContext,
  buildBatchPrompt,
  buildBatchMessages,
  trimWindow,
  MAX_INPUT_TOKENS,
  SLIDING_ROUNDS,
  compressSummary,
  runGeneration,
  describeGenerated,
} from '../src/services/generation'
import {
  MdStreamAccumulator,
  generateStreamBatch,
  validateStreamQuestion,
  rotationHint,
  BATCH_SIZE,
  MAX_CONTINUATIONS,
} from '../src/services/generation/stream'
import type { AIConfig, GenerateRequest, Question, Session } from '../src/types'

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
  defaultId: 'zhipu',
  providers: {
    zhipu: { apiKey: 'test-key', model: 'glm-4.5-air' },
  },
}
const snap = { providerId: 'zhipu', model: 'glm-4.5-air' }

/** 构造 SSE 流式响应：deltas 逐块发送，可选触顶，末段 [DONE] */
function sseStream(deltas: string[], finish: 'stop' | 'length' = 'stop'): Response {
  const encoder = new TextEncoder()
  const parts: string[] = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
  if (finish === 'length') parts.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`)
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

function mockFetch(handler: (url: string, init?: RequestInit, call?: number) => Promise<Response> | Response) {
  let call = 0
  const fn = async (url: string, init?: RequestInit) => {
    call++
    await new Promise((r) => setTimeout(r, 1))
    return handler(url, init, call)
  }
  ;(fn as unknown as { __calls: () => number }).__calls = () => call
  globalThis.fetch = fn as unknown as typeof fetch
  return fn as unknown as { __calls: () => number }
}

function bodyOf(init?: RequestInit): { model: string; messages: { role: string; content: string }[] } {
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

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's_test',
    title: '测试会话',
    created: 0,
    summary: '',
    messages: [],
    packages: [],
    provider: encodeSnapshot(snap),
    ...over,
  }
}

/** 构造可被流式解析的 md 题块 */
function mdQuestion(typeName: string, stem: string, opts?: string[]): string {
  const lines: string[] = []
  lines.push('=== 第题 ===')
  lines.push(`题型：${typeName}`)
  lines.push(`题干：${stem}`)
  if (opts && opts.length) {
    lines.push('选项：')
    opts.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}. ${o}`))
  }
  if (typeName === '判断题') lines.push('答案：正确')
  else lines.push('答案：A')
  lines.push(`解析：这道题的解析说明`)
  lines.push('知识点：测试')
  lines.push('难度：2')
  return lines.join('\n')
}

async function run() {
  resetDB()
  await clearAllStores()

  console.log('—— token 估算 ——')
  assert(estimateTokens('你好世界') === 4, 'CJK 1 字 1 token')
  assert(estimateTokens('hello world') === 3, '英文约 1 token/4 字符')
  assert(estimateTokens('') === 0, '空文本 0 token')

  console.log('—— 会话管理 ——')
  assert(autoTitle('我想学 Python') === '我想学 Python', '短标题原样')
  assert(autoTitle('字'.repeat(25)) === '字'.repeat(20) + '…', '长标题截断 20 字')
  assert(decodeSnapshot(encodeSnapshot(snap)).providerId === 'zhipu', '快照编解码往返')
  assert(decodeSnapshot('zhipu').providerId === 'zhipu', '兼容旧格式纯厂商 id')
  assert(decodeSnapshot('zhipu').model === '', '旧格式 model 为空')
  assert(decodeSnapshot('').providerId === '', '空快照回退空对象')

  const s = createSession('我想学 Python', snap)
  assert(s.title === '我想学 Python', '标题自动生成')
  await clearAllStores()
  await saveSession(s)
  const loaded = await loadSession(s.id)
  assert(loaded?.title === '我想学 Python', '保存后可加载')
  const list = await listSessions()
  assert(list.length === 1 && list[0].id === s.id, '列表按创建时间倒序')
  await deleteSession(s.id)
  assert((await loadSession(s.id)) === undefined, '删除后不可加载')

  console.log('—— 上下文组装 ——')
  const ctxSession = makeSession({
    summary: '用户想学 Python',
    messages: [
      { id: 'm1', role: 'user', content: '你好', tokens: 2 },
      { id: 'm2', role: 'assistant', content: '好的', tokens: 2 },
    ],
  })
  const ctx = buildContext(ctxSession)
  assert(ctx[0].role === 'system' && ctx[0].content.includes('资深出题专家'), '首条为系统提示')
  assert(ctx[1].role === 'system' && ctx[1].content.includes('会话摘要'), '含会话摘要')
  assert(ctx.length === 4, '系统+摘要+2 条滑动窗口')
  const noSum = buildContext(makeSession({ messages: [{ id: 'm1', role: 'user', content: 'hi', tokens: 1 }] }))
  assert(noSum.length === 2, '无摘要时省略摘要消息')

  const many = makeSession({
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '短',
      tokens: 1,
    })),
  })
  const win = trimWindow(many, 0)
  assert(win.length === SLIDING_ROUNDS * 2, `滑动窗口最多保留 ${SLIDING_ROUNDS} 轮`)

  const req: GenerateRequest = { content: 'Python 基础', structure: { single: 5, judge: 3 }, source: 'custom' }
  const bp = buildBatchPrompt(req, 'single', 5, [])
  assert(bp.includes('生成 5 道「单选题」题'), '本批要求含题型与数量')
  assert(bp.includes('整体题型结构：single:5, judge:3'), '含整体结构')
  const bp2 = buildBatchPrompt(req, 'single', 5, [
    { id: 'q1', type: 'single', stem: '已有题', answer: '[0]', explanation: '解', kp_ids: [], difficulty: 1 },
  ])
  assert(bp2.includes('已生成题目'), '分批携带已生成题干去重')
  const bpFocus = buildBatchPrompt(req, 'single', 5, [], '应用场景与综合运用')
  assert(bpFocus.includes('本批侧重'), '侧重轮换写入提示词')
  assert(rotationHint(0) !== rotationHint(1), '每批侧重轮换不同')

  console.log('—— 流式增量解析（MdStreamAccumulator） ——')
  // 单题按行切成多块流式接收：未完成前不采纳，下一题分隔符到达后上一题确认
  const acc = new MdStreamAccumulator()
  const q1 = mdQuestion('单选题', '第一题', ['A', 'B', 'C', 'D'])
  const q1Lines = q1.split('\n')
  acc.feed(q1Lines.slice(0, 3).join('\n')) // 仅题头+题型+题干行
  assert(acc.accepted.length === 0, '题块未完成不采纳')
  acc.feed('\n' + q1Lines.slice(3).join('\n')) // 补全选项/答案/解析
  assert(acc.accepted.length === 0, '首题完成但未到下一分隔符，暂待确认')
  acc.feed(mdQuestion('单选题', '第二题', ['A', 'B', 'C', 'D'])) // 下一题起始到达
  assert(acc.accepted.length === 1 && acc.accepted[0].stem === '第一题', '下一分隔符到达，上一题确认采纳')
  assert(acc.accepted[0].id && acc.accepted[0].kp_ids.length === 1, '采纳即补 id 与知识点')
  acc.finish() // 末尾题在收尾时确认
  assert(acc.accepted.length === 2, '末尾题 finish 时确认')
  // 单题块校验失败只丢该块，不影响其他题块（连坐隔离）
  const acc2 = new MdStreamAccumulator()
  acc2.feed('=== 第 1 题 ===\n题型：单选题\n选项：\nA. a\nB. b\nC. c\nD. d\n答案：A\n解析：x\n知识点：t\n难度：2\n') // 缺题干
  acc2.feed(mdQuestion('单选题', '正常题', ['A', 'B', 'C', 'D']))
  acc2.finish()
  assert(acc2.accepted.length === 1 && acc2.accepted[0].stem === '正常题', '坏块丢弃、好块保留')
  assert(acc2.rejected === 1, '坏块计入 rejected')
  // 题干哈希查重
  const acc3 = new MdStreamAccumulator()
  acc3.feed(mdQuestion('单选题', '重复题', ['A', 'B', 'C', 'D']))
  acc3.feed(mdQuestion('单选题', '重复题', ['A', 'B', 'C', 'D']))
  acc3.finish()
  assert(acc3.accepted.length === 1, '题干哈希查重，重复题只采纳一次')

  console.log('—— 流式校验规则 ——')
  const goodSingle: Question = {
    id: 'x',
    type: 'single',
    stem: 's',
    options: ['a', 'b', 'c', 'd'],
    answer: '[0]',
    explanation: 'e',
    kp_ids: [],
    difficulty: 2,
  }
  assert(validateStreamQuestion(goodSingle).length === 0, '合规单选通过')
  assert(validateStreamQuestion({ ...goodSingle, options: ['a', 'b', 'c'] }).length > 0, '单选非 4 选项被拒')
  assert(validateStreamQuestion({ ...goodSingle, answer: '[9]' }).length > 0, '答案超出选项范围被拒')
  assert(validateStreamQuestion({ ...goodSingle, explanation: '' }).length > 0, '缺解析被拒')
  const goodJudge: Question = {
    id: 'j',
    type: 'judge',
    stem: 's',
    options: ['正确', '错误'],
    answer: 'true',
    explanation: 'e',
    kp_ids: [],
    difficulty: 1,
  }
  assert(validateStreamQuestion(goodJudge).length === 0, '合规判断题通过')

  console.log('—— 单批流式生成 ——')
  const okMock = mockFetch(() => sseStream([mdQuestion('单选题', '流式题', ['A', 'B', 'C', 'D'])]))
  const acc4 = new MdStreamAccumulator()
  await generateStreamBatch(
    { acc: acc4, buildMessages: () => [{ role: 'user', content: 'x' }], cfg, snapshot: snap },
    'single',
    1,
    0,
  )
  assert(acc4.accepted.length === 1 && acc4.accepted[0].stem === '流式题', '流式批采纳 1 题')
  assert(okMock.__calls() === 1, '成功只调 1 次')

  console.log('—— 截断自动续写 ——')
  let contCalls = 0
  const contMock = mockFetch((_url, init) => {
    const body = bodyOf(init)
    const isContinuation = body.messages.some((m) => m.role === 'assistant')
    if (!isContinuation) return sseStream([mdQuestion('单选题', '截断前的题', ['A', 'B', 'C', 'D'])], 'length')
    contCalls++
    return sseStream([mdQuestion('单选题', '续写后的题', ['A', 'B', 'C', 'D'])])
  })
  const acc5 = new MdStreamAccumulator()
  await generateStreamBatch(
    { acc: acc5, buildMessages: () => [{ role: 'user', content: 'x' }], cfg, snapshot: snap },
    'single',
    2,
    0,
  )
  assert(acc5.accepted.length === 2, '截断后续写补齐 2 题')
  assert(contCalls === 1, `触顶续写 1 次（实际 ${contCalls}）`)
  assert(contCalls <= MAX_CONTINUATIONS, '续写不超上限')

  console.log('—— 摘要压缩 ——')
  await clearAllStores()
  const sumMock = mockFetch(() => okText('  用户想学 Python，已生成 8 道题。  '))
  const sumSession = makeSession({ messages: [{ id: 'm1', role: 'user', content: '你好', tokens: 2 }] })
  const summary = await compressSummary(sumSession, cfg, snap)
  assert(summary === '用户想学 Python，已生成 8 道题。', '摘要返回并去空白')
  const sumUsage = await dbUsage.getAll()
  assert(sumUsage.length === 1 && sumUsage[0].module === 'summary', '摘要调用记入 module=summary')
  assert(sumMock.__calls() === 1, '摘要只调 1 次')

  console.log('—— runGeneration 全流程（流式分批） ——')
  await clearAllStores()
  const calls: string[] = []
  const progressCounts: number[] = []
  const genMock = mockFetch((_url, init) => {
    const body = bodyOf(init)
    if (body.messages[0].content.includes('对话记录整理助手')) {
      calls.push('summary')
      return okText('用户想学 Python 基础，已生成 8 道题（单选 5 + 判断 3）。')
    }
    const last = body.messages[body.messages.length - 1].content
    const batchLine = last.match(/本批请生成 (\d+) 道「(.+?)」题/) ?? []
    const n = Number(batchLine[1] ?? 1)
    const typeName = batchLine[2] ?? '单选题'
    calls.push(`generate:${typeName}`)
    if (typeName === '判断题') {
      assert(last.includes('已生成题目'), '第二批携带已生成题干去重')
    }
    const blocks = Array.from({ length: n }, (_, i) =>
      typeName === '单选题'
        ? mdQuestion('单选题', `${typeName}题 ${i + 1}`, ['A', 'B', 'C', 'D'])
        : mdQuestion('判断题', `${typeName}题 ${i + 1}`, ['正确', '错误']),
    )
    return sseStream(blocks)
  })

  const session = makeSession()
  const fullReq: GenerateRequest = { content: 'Python 基础', structure: { single: 5, judge: 3 }, source: 'custom' }
  const { questions, session: updated, deficitByType, rejects } = await runGeneration(
    session,
    '生成 Python 基础题',
    fullReq,
    cfg,
    (p) => progressCounts.push(p.questions),
  )
  assert(questions.length === 8, '生成 8 道题')
  assert(typeof rejects.parse === 'number' && typeof rejects.invalid === 'number' && typeof rejects.duplicate === 'number', 'rejects 按原因统计字段齐全')
  assert(rejects.parse + rejects.invalid + rejects.duplicate === 0, '全通过场景无过滤')
  assert(questions.filter((q) => q.type === 'single').length === 5, '单选 5 道')
  assert(questions.filter((q) => q.type === 'judge').length === 3, '判断 3 道')
  assert(questions.every((q) => !!q.id), '每题都有 id')
  assert(calls.join(',') === 'generate:单选题,generate:判断题,summary', `调用顺序正确（${calls.join(',')}）`)
  assert(progressCounts.some((n) => n > 0 && n < 8), '流式进度实时递增到 8')
  assert(progressCounts[progressCounts.length - 1] === 8, '最终进度 8/8')
  assert(Object.keys(deficitByType).length === 0, '无缺口')
  assert(updated.messages.length === 2, '会话追加 2 条消息')
  assert(updated.messages[0].role === 'user' && updated.messages[0].content === '生成 Python 基础题', '用户消息')
  assert(updated.messages[1].role === 'assistant' && updated.messages[1].content.includes('已生成 8 道题'), 'AI 消息')
  assert(updated.summary.includes('Python'), '摘要已更新')
  assert(describeGenerated(questions).includes('单选题 5 道'), 'describeGenerated 描述')

  const persisted = await loadSession(updated.id)
  assert(persisted?.summary.includes('Python') && persisted?.messages.length === 2, '会话已持久化')

  const usage = await dbUsage.getAll()
  const genUsage = usage.filter((u) => u.module === 'generate')
  const sumUsage2 = usage.filter((u) => u.module === 'summary')
  assert(genUsage.length === 2, `生成批次记入用量（${genUsage.length} 条）`)
  assert(sumUsage2.length === 1, '摘要记入用量')
  assert(genMock.__calls() === 3, '共 3 次请求（2 批 + 1 摘要）')

  // 优雅收尾：部分成功（如 92/100）不报错，交付已有题目
  console.log('—— 不足目标优雅收尾 ——')
  await clearAllStores()
  const partialMock = mockFetch((_url, init) => {
    const body = bodyOf(init)
    if (body.messages[0].content.includes('对话记录整理助手')) {
      return okText('部分生成完成。')
    }
    return sseStream([mdQuestion('单选题', '部分题 1', ['A', 'B', 'C', 'D'])])
  })
  const pReq: GenerateRequest = { content: 'x', structure: { single: 2 }, source: 'custom' }
  const { questions: pq, deficitByType: pd } = await runGeneration(makeSession(), 'g', pReq, cfg)
  assert(pq.length === 1, '只成功 1 题也正常交付，不抛错')
  assert(pd.single === 1, '缺口如实报告 1 题')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})