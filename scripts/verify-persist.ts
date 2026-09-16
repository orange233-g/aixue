import 'fake-indexeddb/auto'
import { getDB, dbSessions, dbConfig } from '../src/db'
import { createSession, saveSession, listSessions } from '../src/services/generation/session'
import type { QuestionTypeId } from '../src/types'

/**
 * 验证 generate 流程中的持久化链路：
 * 1. saveSession 是否把草稿引用的 result(status=draft) 真正写入 IndexedDB
 * 2. load() 恢复逻辑能否从持久化数据正确还原草稿
 * 这是 bug（生成题包切页后消失 / 编辑空页）的决定性环节。
 */
const DRAFT_KEY_PREFIX = 'gen-draft:'

async function main() {
  await getDB()

  // ── 模拟 generate() 的保存流程 ──
  const s = createSession('机器学习基础', { providerId: 'zhipu', model: 'glm-4.5-air' })
  s.messages.push({ id: 'm1', role: 'user', content: 'hi', tokens: 0 })
  s.messages.push({
    id: 'm2',
    role: 'assistant',
    content: '已生成 1 道题',
    tokens: 0,
    // 与真实 generate 相同：assistant 消息挂 result，status=draft
    result: { id: 'p_persist', title: '机器学习基础', questionCount: 1, status: 'draft' },
  })
  await saveSession(s)

  // 与真实 generate 相同：草稿写入 config store
  const draft = {
    id: 'p_persist',
    title: '机器学习基础',
    category: '',
    source: 'ai' as const,
    meta: { difficulty: 'auto' as const, objectives: [] },
    chapters: [],
    questions: [
      { id: 'q1', type: 'single' as QuestionTypeId, stem: '题目', options: ['A', 'B'], answer: 'A', explanation: '', kp_ids: [], difficulty: 1 as const },
    ],
    created_at: Date.now(),
  }
  await dbConfig.set(`${DRAFT_KEY_PREFIX}${draft.id}`, draft)

  // ── 模拟 load() 的恢复逻辑（与 useGenerateStore.load 一致） ──
  const sessions = await listSessions()
  const session = sessions[0] ?? null
  const recovered: string[] = []
  if (session) {
    for (const m of session.messages) {
      if (m.result?.status === 'draft') {
        const pack = await dbConfig.get(`${DRAFT_KEY_PREFIX}${m.result.id}`)
        if (pack) recovered.push(m.result.id)
      }
    }
  }

  console.log('持久化后 session 消息 result:', JSON.stringify(session?.messages[1]?.result))
  console.log('恢复的草稿 keys:', JSON.stringify(recovered))

  const resultPersisted = session?.messages[1]?.result?.status === 'draft'
  const draftRecovered = recovered.length === 1 && recovered[0] === 'p_persist'
  console.log(resultPersisted && draftRecovered ? 'PASS: result 已持久化且 load() 能恢复草稿' : 'FAIL: 持久化/恢复链路存在缺陷')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})