import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KBDoc } from '../types'
import { initDB, clearAllStores, dbKB } from '../db'
import { useKB } from './useKBStore'
import { KB_MAX_FILES, KB_MAX_TOTAL_BYTES } from '../services/files/parse'

// BUG-10 回归测试用：mock 掉 embedding 外围（worker/模型注册/缓存），只验证 store 的写回时序
const h = vi.hoisted(() => ({
  /** runEmbed 的放行开关：测试中手动 resolve，模拟长跑期间 DB 被并发修改 */
  resolveEmbed: null as ((v: Float32Array[]) => void) | null,
}))
vi.mock('../workers/embedWorkerClient', () => ({
  runEmbed: () =>
    new Promise<Float32Array[]>((res) => {
      h.resolveEmbed = res
    }),
}))
vi.mock('../ai/embed/registry', () => ({
  getEmbedModel: () => ({ id: 'm1', dim: 4, name: 'Mock 向量模型', developer: '', description: '', license: '', sizeMB: 0 }),
}))
vi.mock('../ai/embed/storage', () => ({
  ensureModelFiles: async () => undefined,
  gcEmbedCaches: async () => [] as string[],
}))
vi.mock('../services/kb/ref', () => ({
  warmVectorCache: async () => undefined,
  invalidateVectorCache: () => undefined,
}))

function mkDoc(id: string, sourceFiles: { name: string; size: number }[]): KBDoc {
  return {
    id,
    name: `库 ${id}`,
    sourceFiles,
    sourcesText: [],
    bodyText: '',
    schema: 2,
    summary: '',
    consolidated: '',
    sections: [],
    charCount: 0,
    source: 'kb',
    status: 'indexing',
    created_at: 1,
    updated_at: 1,
  }
}

function tinyFile(name = 'a.txt'): File {
  return new File(['x'], name, { type: 'text/plain' })
}

describe('V4-P02：知识库导入文件数/总体积限制', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
    useKB.setState({ bases: [], task: null, readerId: null, pendingRefIds: [], loaded: false })
  })

  it('单次导入超过文件数上限立即拒绝，不进入解析', async () => {
    const files = Array.from({ length: KB_MAX_FILES + 1 }, () => tinyFile())
    await expect(useKB.getState().create('过量', files)).rejects.toThrow(/最多导入/)
  })

  it('append 追加时计入库内既有 sourceFiles 的总体积，防反复追加绕过上限', async () => {
    // 既有库源文件已占满上限：再追加任意一个文件即超总容量
    const baseSize = KB_MAX_TOTAL_BYTES
    useKB.setState({
      bases: [mkDoc('kb1', [{ name: 'big.txt', size: baseSize }])],
      task: null,
      loaded: true,
    })
    await expect(useKB.getState().appendFiles('kb1', [tinyFile('a.txt')])).rejects.toThrow(/总体积/)
  })

  it('appendNote：笔记体积计入单库累计上限，防无限追加', async () => {
    useKB.setState({
      bases: [mkDoc('kb2', [{ name: 'big.txt', size: KB_MAX_TOTAL_BYTES }])],
      task: null,
      loaded: true,
    })
    await expect(useKB.getState().appendNote('kb2', '好标题', '这是一段笔记正文')).rejects.toThrow(/总体积/)
  })

  it('appendNote：空笔记内容直接拒绝，不进整理管线', async () => {
    useKB.setState({ bases: [mkDoc('kb3', [])], task: null, loaded: true })
    await expect(useKB.getState().appendNote('kb3', '标题', ' \n\t ')).rejects.toThrow(/不能为空/)
  })
})

/** 可生成语义索引的 ready 库（1 源 1 节，embedModel 已绑定向量模型） */
function mkEmbeddableDoc(id: string): KBDoc {
  return {
    id,
    name: `语义库 ${id}`,
    sourceFiles: [{ name: 'a.md', size: 10, chars: 10 }],
    sourcesText: [{ file: 'a.md', span: { start: 0, end: 10 }, text: '# 第一节\n正文内容' }],
    bodyText: '# 第一节\n正文内容',
    schema: 2,
    summary: '1 份资料 · 1 节 · 10 字',
    consolidated: '',
    sections: [{ id: 's1', title: '第一节', start: 0, end: 10, file: 'a.md' }],
    charCount: 10,
    source: 'kb',
    status: 'ready',
    embedModel: 'm1',
    tone: 0,
    created_at: 1,
    updated_at: 1,
  }
}

describe('BUG-10：语义索引长跑完成写回不得覆盖期间变更（读-改-写 + 内容指纹）', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
    h.resolveEmbed = null
    useKB.setState({ bases: [], task: null, embedTask: null, readerId: null, pendingRefIds: [], loaded: false })
  })

  it('索引期间添加了新数据源（重整完成）→ 索引结果作废置 idle，不回滚追加的源', async () => {
    const doc = mkEmbeddableDoc('kbx')
    await dbKB.put(doc)
    useKB.setState({ bases: [doc], task: null, embedTask: null, loaded: true })
    const p = useKB.getState().generateEmbed('kbx')
    // 等 runEmbed 启动（中间隔着 mergeKBDoc put + dbKBVectors.get）
    await vi.waitFor(() => expect(h.resolveEmbed).not.toBeNull())
    // 模拟长跑期间「添加文件 → 重整完成」：DB 已写入带新源的 doc（sourceFiles/sourcesText/sections/bodyText 均变）
    const rebuilt: KBDoc = {
      ...doc,
      sourceFiles: [...doc.sourceFiles, { name: '新笔记.md', size: 8, chars: 8, type: 'note' as const }],
      sourcesText: [...doc.sourcesText, { file: '新笔记.md', span: { start: 0, end: 8 }, text: '新增的笔记内容' }],
      bodyText: `${doc.bodyText}\n\n新增的笔记内容`,
      sections: [...doc.sections, { id: 's2', title: '', start: 14, end: 22, file: '新笔记.md' }],
      charCount: doc.charCount + 10,
      status: 'ready',
      embedStatus: 'idle',
      updated_at: doc.updated_at + 1,
    }
    await dbKB.put(rebuilt)
    useKB.setState({ bases: [rebuilt] })
    // 放行索引完成：旧内容算出的向量写回时不得覆盖 rebuilt
    h.resolveEmbed!([])
    const elapsed = await p
    expect(elapsed).toBe(0) // 内容已变更 → 结果作废
    const latest = await dbKB.get('kbx')
    expect(latest?.sourceFiles).toHaveLength(2) // 新笔记未被静默丢弃
    expect(latest?.sourcesText).toHaveLength(2)
    expect(latest?.sections).toHaveLength(2)
    expect(latest?.status).toBe('ready')
    expect(latest?.embedStatus).toBe('idle') // 向量与正文失配 → 复位待重建，而非错误地标 ready
  })

  it('内容未变更时索引正常完成 → 置 ready（正常路径不受影响）', async () => {
    const doc = mkEmbeddableDoc('kby')
    await dbKB.put(doc)
    useKB.setState({ bases: [doc], task: null, embedTask: null, loaded: true })
    const p = useKB.getState().generateEmbed('kby')
    await vi.waitFor(() => expect(h.resolveEmbed).not.toBeNull())
    h.resolveEmbed!([])
    const elapsed = await p
    expect(elapsed).toBeGreaterThanOrEqual(0)
    const latest = await dbKB.get('kby')
    expect(latest?.embedStatus).toBe('ready')
    expect(latest?.embedModel).toBe('m1')
    expect(latest?.embedDim).toBe(4)
  })

  it('索引长跑期间库被删除 → 完成写回放弃（不复活已删库）', async () => {
    const doc = mkEmbeddableDoc('kbz')
    await dbKB.put(doc)
    useKB.setState({ bases: [doc], task: null, embedTask: null, loaded: true })
    const p = useKB.getState().generateEmbed('kbz')
    await vi.waitFor(() => expect(h.resolveEmbed).not.toBeNull())
    await dbKB.delete('kbz')
    useKB.setState({ bases: [] })
    h.resolveEmbed!([])
    await expect(p).resolves.toBe(0)
    expect(await dbKB.get('kbz')).toBeUndefined() // 未被旧快照复活
  })
})

describe('删库清孤儿索引任务：不再阻塞其他库生成索引', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
    h.resolveEmbed = null
    useKB.setState({ bases: [], task: null, embedTask: null, readerId: null, pendingRefIds: [], loaded: false })
  })

  it('索引进行中删除该库 → embedTask 立即清空；另一库生成索引不再报「已有任务进行中」', async () => {
    const a = mkEmbeddableDoc('kba')
    const b = mkEmbeddableDoc('kbb')
    await dbKB.put(a)
    await dbKB.put(b)
    useKB.setState({ bases: [a, b], task: null, embedTask: null, loaded: true })
    // 索引长跑启动（p1 不 await 不放行——后台弃置路径自有既有测试覆盖）
    useKB.getState().generateEmbed('kba')
    await vi.waitFor(() => expect(h.resolveEmbed).not.toBeNull())
    expect(useKB.getState().embedTask?.kbId).toBe('kba')
    // 删除正在生成索引的库
    await useKB.getState().remove('kba')
    expect(useKB.getState().embedTask).toBeNull()
    // 孤儿任务已清：另一库可正常发起生成索引（p1 不 await 不放行——后台弃置路径自有既有测试覆盖）。
    // 注意等「prepare 结束、进入索引阶段」（runEmbed 已被调用）再放行，否则 resolve 的是 kba 的旧悬挂 promise
    const p2 = useKB.getState().generateEmbed('kbb')
    await vi.waitFor(() => {
      const t = useKB.getState().embedTask
      expect(t?.kbId).toBe('kbb')
      expect(t?.prepare).toBeUndefined()
    })
    h.resolveEmbed!([])
    await p2
    const latest = await dbKB.get('kbb')
    expect(latest?.embedStatus).toBe('ready')
  })

  it('孤儿任务防御：embedTask 指向不存在的库时 generateEmbed 自动清障放行', async () => {
    const b = mkEmbeddableDoc('kbc')
    await dbKB.put(b)
    useKB.setState({
      bases: [b],
      task: null,
      // 模拟历史遗留：任务指向已不存在的库
      embedTask: { kbId: 'kb-gone', done: 1, total: 9 },
      loaded: true,
    })
    const p = useKB.getState().generateEmbed('kbc')
    // 等到真正进入索引阶段（prepare 结束、runEmbed 已调用）再放行
    await vi.waitFor(() => expect(h.resolveEmbed).not.toBeNull())
    expect(useKB.getState().embedTask?.kbId).toBe('kbc')
    h.resolveEmbed!([])
    await p
  })
})