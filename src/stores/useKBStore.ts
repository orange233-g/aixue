import { create } from 'zustand'
import type { KBDoc } from '../types'
import { dbKB, dbKBVectors } from '../db'
import { parseFiles, KB_MAX_FILES, KB_MAX_TOTAL_BYTES, CODE_EXTS, fileExt, isLatinText, countWords, countLines } from '../services/files/parse'
import { splitSourceText, aggregateSourceTexts } from '../services/kb/sourceSplit'
import { detectFragmented, cleanText, fmtChars } from '../services/kb/clean'
import { buildFileSpans, fileOfOffset } from '../services/kb/process'
import { buildAnchors } from '../services/kb/embed'
import { warmVectorCache, invalidateVectorCache } from '../services/kb/ref'
import { runEmbed } from '../workers/embedWorkerClient'
import { getEmbedModel } from '../ai/embed/registry'
import { ensureModelFiles, gcEmbedCaches } from '../ai/embed/storage'
import { DEFAULT_EMBED_MODEL, EMBED_MODE_BM25 } from '../ai/embed/types'
import { processKBSources } from '../workers/kbProcessWorkerClient'
import { uid } from '../utils'
import { log } from '../utils/log'

/** 默认语义索引模型（re-export 自 ai/embed/types，供历史引用点兼容） */
export { DEFAULT_EMBED_MODEL }

/** 把 sourcesText 还原为清洗后正文 + 结构分块（全本地零 token）。
 *  V2-P04：CPU 重的清洗/分块放 KB Worker 执行，主线程只做字段拼装（大库整理/迁移不卡 UI）。
 *  V4-P01：signal 贯穿到 Worker 客户端，取消时真正终止 Worker。 */
async function buildBody(kb: Pick<KBDoc, 'sourcesText'>, signal?: AbortSignal): Promise<{ bodyText: string; sections: KBDoc['sections'] }> {
  const { bodyText, sections } = await processKBSources(kb.sourcesText ?? [], { signal })
  return { bodyText, sections }
}

/** 源文件统计字段（导入时一次性记录，清单零加载展示，与正文同口径）：
 *  chars=字符数（全部文件）；代码文件 lines=行数；英文文本 words=词数（替代行数） */
function fileStats(f: { name: string; text: string }): { chars: number; lines?: number; words?: number } {
  const out: { chars: number; lines?: number; words?: number } = { chars: f.text.length }
  if (CODE_EXTS.has(fileExt(f.name))) out.lines = countLines(f.text)
  else if (isLatinText(f.text)) out.words = countWords(f.text)
  return out
}

/** 整理结果字段拼装（bodyText / sections / charCount / summary / schema=2） */
function withBody(kb: KBDoc, body: string, sections: KBDoc['sections']): KBDoc {
  return {
    ...kb,
    bodyText: body,
    sections,
    charCount: body.length,
    summary: `${kb.sourceFiles.length} 份资料 · ${sections.length} 节 · ${fmtChars(body.length)}`,
    schema: 2,
  }
}

/**
 * 校验导入限制（V4-P02）：单次文件数 + 累计总体积，超出立即抛错阻止建库/追加。
 * baseBytes 传已有 sourceFiles 体积，append 时把存量计入总量，防止反复追加绕过单库体积上限。
 */
function assertImportLimits(files: readonly { name: string; size: number }[], baseBytes = 0): void {
  if (files.length > KB_MAX_FILES) {
    throw new Error(`一次最多导入 ${KB_MAX_FILES} 个文件（当前 ${files.length} 个）`)
  }
  const total = baseBytes + files.reduce((s, f) => s + f.size, 0)
  if (total > KB_MAX_TOTAL_BYTES) {
    throw new Error(`库源文件总体积超过 ${Math.round(KB_MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
  }
}

/** 整理中任务条所需的最小状态（Reasonix 式显式任务态，见可行性分析 §6.2）；
 *  startedAt 记录任务启动时刻，UI 据此显示已耗时（对齐生题的耗时统计）。
 *  去凝练后整理全本地毫秒级完成，进度不再分批更新，UI 短暂显示即过。 */
export interface KBTask {
  id: string
  name: string
  done: number
  total: number
  startedAt: number
}

interface KBStore {
  bases: KBDoc[]
  loaded: boolean
  /** 当前进行/待续的整理任务（同一时刻最多一个，避免资源竞争） */
  task: KBTask | null
  /** 从知识库卡片「引用」进入生成页时预选的库 id（GeneratePage 读取后清空） */
  pendingRefIds: string[]
  /** 阅读器当前打开的库 id（KnowledgeBasePage「查看资料」设置，KbReaderPage 读取后关闭） */
  readerId: string | null
  /** 知识库详情页当前打开的库 id（点卡片设置，KbDetailPage 读取；closeDetail 关闭） */
  detailId: string | null
  /** 语义索引生成进度（V-EMB 一期；语义检索子页读取，完成/失败置 null） */
  embedTask: { kbId: string; done: number; total: number; elapsed?: number; /** 模型文件准备阶段文案（非空=在准备而非生成索引） */ prepare?: string } | null
  load: () => Promise<void>
  /** 新建知识库：files 为空则建「空库」(status=ready，绑定 embedModelId 作该库检索方式)，非空则解析整理；返回新库 id（进详情页用） */
  create: (name: string, files?: File[], embedModelId?: string) => Promise<string>
  /** 续跑一个 indexing 的知识库（中断后重新整理；本地毫秒级，整体重跑无需进度记忆） */
  resume: (id: string) => Promise<void>
  /** 向已存在的知识库追加源文件并重新整理（清空旧正文，追加后整库重算） */
  appendFiles: (id: string, files: File[]) => Promise<void>
  /** 追加一条文字笔记（标题 + 粘贴正文）作为数据源并重新整理（借鉴 Cherry Studio note 数据源：不走文件解析，纯文本直入 sourcesText） */
  appendNote: (id: string, title: string, content: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setPendingRefIds: (ids: string[]) => void
  openReader: (id: string) => void
  closeReader: () => void
  /** 打开/关闭知识库详情页 */
  openDetail: (id: string) => void
  closeDetail: () => void
  /** 更换库的检索方式（模型 id 或 null=BM25）；变更后旧索引复位为 idle，需重建 */
  setKbModel: (id: string, modelId: string | null) => void
  /** V4-P01：中断当前整理任务（abort Worker + parse），库保持 indexing 可续跑 */
  cancelTask: () => void
  /** V-EMB：为库生成语义索引（锚点向量化；需模型已下载；成功原子替换，失败置 error 不丢旧索引） */
  generateEmbed: (id: string) => Promise<number>
  /** V-EMB：删除库的语义索引（回到未启用语义检索状态） */
  removeEmbed: (id: string) => Promise<void>
}

export const useKB = create<KBStore>((set, get) => {
  /** 当前任务的取消控制器（同一时刻最多一个整理任务，其生命周期对应当前 task） */
  let taskAbort: AbortController | null = null

  /** 把某个 doc 从 indexing 推进到 ready/failed（本地清洗 + 切分 + 落库），失败置 failed 不静默 */
  async function taskToReady(doc: KBDoc, signal?: AbortSignal): Promise<void> {
    try {
      const { bodyText, sections } = await buildBody(doc, signal)
      // BUG-10 修复：以 DB 最新记录为基底合并整理结果（不用旧快照整条覆盖，
      // 保住整理/索引长跑期间的并发变更；库被删除则放弃写回）
      const ready = await mergeKBDoc(doc.id, (latest) => ({
        ...withBody(latest, bodyText, sections),
        status: 'ready',
        error: undefined,
        updated_at: Date.now(),
      }))
      set({ task: null })
      if (!ready) return
      log('info', 'kb', `知识库整理完成 ${ready.name}`, { id: ready.id, chars: ready.charCount, sections: ready.sections.length })
    } catch (e) {
      // V4-P01：主动取消不标 failed，库保持 indexing（可经 resume 续跑），避免「已取消」显示成整理失败
      if (signal?.aborted) {
        set({ task: null })
        log('info', 'kb', `知识库整理已取消 ${doc.name}`, { id: doc.id })
        return
      }
      const failed = await mergeKBDoc(doc.id, {
        status: 'failed',
        error: e instanceof Error ? e.message : '整理失败',
        updated_at: Date.now(),
      })
      set({ task: null })
      log('error', 'kb', `知识库整理失败 ${doc.name}`, { id: doc.id, message: failed?.error ?? '整理失败' })
    } finally {
      if (signal === taskAbort?.signal) taskAbort = null
    }
  }

  /** 开始一个新任务：中止上一个未完成任务的控制器，新建当前任务控制器并贯穿 parse + 整理 */
  function beginTask(): AbortController {
    taskAbort?.abort()
    taskAbort = new AbortController()
    return taskAbort
  }

  /** 读-改-写（BUG-10 修复）：以 DB 最新记录为基底合并补丁再整条写回，并同步内存 bases。
   *  此前所有任务完成/失败路径都用「任务启动时的旧快照」整条 put 覆盖——语义索引长跑
   *  （大库可达小时级）期间添加的文件/笔记会被完成写回静默回滚（用户数据丢失）。
   *  DB 记录已不存在（库被删除）时放弃写入并返回 null，避免把已删库复活。 */
  async function mergeKBDoc(id: string, patch: Partial<KBDoc> | ((latest: KBDoc) => Partial<KBDoc>)): Promise<KBDoc | null> {
    const latest = await dbKB.get(id)
    if (!latest) return null
    const extra = typeof patch === 'function' ? patch(latest) : patch
    const merged: KBDoc = { ...latest, ...extra }
    await dbKB.put(merged)
    set({ bases: get().bases.map((b) => (b.id === id ? merged : b)) })
    return merged
  }

  return {
    bases: [],
    loaded: false,
    task: null,
    pendingRefIds: [],
    readerId: null,
    detailId: null,
    embedTask: null,

    async load() {
      try {
        const all = await dbKB.getAll()
        // 旧库自动迁移：schema !== 2 的本地重算 bodyText+sections 写回（毫秒级，用户无感，不丢数据）；
        // schema === 2 但 sections 缺 file 字段的多文件库：按 sourcesText 偏移反推补全 file（不重建正文）
        const migrated: KBDoc[] = []
        for (const kb of all) {
          if (kb.schema !== 2) {
            const { bodyText, sections } = await buildBody(kb)
            const updated = withBody(kb, bodyText, sections)
            await dbKB.put(updated)
            migrated.push(updated)
            log('info', 'kb', `旧知识库已迁移至 schema 2 ${kb.name}`, { id: kb.id, chars: updated.charCount })
            continue
          }
          // V8-KB：多文件 file 标注补全（幂等：只补缺 file 的 section；sections 为空/单文件库无副作用）
          const needFile = (kb.sourcesText ?? []).length > 0 && kb.sections.some((s) => !s.file)
          if (needFile) {
            const files = aggregateSourceTexts(kb.sourcesText ?? [])
            const cleaned = files.map((f) => (detectFragmented(f.text, f.name) ? cleanText(f.text) : f.text))
            const spans = buildFileSpans(files.map((f) => f.name), cleaned)
            const sections = kb.sections.map((s) => ({ ...s, file: fileOfOffset(spans, s.start) }))
            const updated = { ...kb, sections }
            await dbKB.put(updated)
            migrated.push(updated)
            log('info', 'kb', `知识库章节已标注来源文件 ${kb.name}`, { id: kb.id, files: files.length })
            continue
          }
          // 源文件清单统计口径统一：旧库缺 chars（此前显示 f.size 字节数，与卡片 charCount 字符数口径不一致，GBK 下差近一倍）
          // 或代码文件缺 lines / 英文文本缺 words → 从 sourcesText 聚合反推补齐（与正文同口径；幂等，写回后字段齐了不再触发）
          const needStats =
            (kb.sourcesText ?? []).length > 0 &&
            kb.sourceFiles.some(
              (f) => f.chars == null || (CODE_EXTS.has(fileExt(f.name)) && f.lines == null),
            )
          if (needStats) {
            const files = aggregateSourceTexts(kb.sourcesText ?? [])
            const byName = new Map(files.map((f) => [f.name, f.text]))
            const sourceFiles = kb.sourceFiles.map((f) => {
              const out = { ...f }
              const text = byName.get(f.name)
              if (text == null) return out
              if (out.chars == null) out.chars = text.length
              if (CODE_EXTS.has(fileExt(f.name))) {
                if (out.lines == null) out.lines = countLines(text)
              } else if (out.words == null && isLatinText(text)) {
                out.words = countWords(text)
              }
              return out
            })
            const updated = { ...kb, sourceFiles }
            await dbKB.put(updated)
            migrated.push(updated)
            log('info', 'kb', `源文件清单已补统计 ${kb.name}`, { id: kb.id })
            continue
          }
          migrated.push(kb)
        }
        migrated.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
        set({ bases: migrated, loaded: true })
      } catch (e) {
        console.error('[kb] load failed:', e)
        set({ bases: [], loaded: true })
      }
    },

    async create(name, files = [], embedModelId) {
      // 空库：只建实体并绑定检索方式（embedModelId 缺省=BM25 关键词），不解析文件；数据源后续经 appendFiles 添加
      if (files.length === 0) {
        const empty: KBDoc = {
          id: uid('kb_'),
          name: name.trim() || '未命名知识库',
          sourceFiles: [],
          sourcesText: [],
          bodyText: '',
          schema: 2,
          summary: '',
          consolidated: '',
          sections: [],
          charCount: 0,
          source: 'kb',
          status: 'ready',
          embedModel: embedModelId || undefined,
          tone: Math.floor(Math.random() * 10),
          created_at: Date.now(),
          updated_at: Date.now(),
        }
        await dbKB.put(empty)
        set({ bases: [empty, ...get().bases.filter((b) => b.id !== empty.id)] })
        log('info', 'kb', `创建空知识库 ${empty.name}`, { id: empty.id, model: embedModelId ?? 'bm25' })
        return empty.id
      }
      // V4-P02：建库前先卡数量/体积限制，超限直接报错，不进入解析
      assertImportLimits(files)
      const ctl = beginTask()
      const { ok, failed } = await parseFiles(files, ctl.signal)
      if (ok.length === 0) {
        if (ctl.signal.aborted) {
          set({ task: null })
          return ''
        }
        throw new Error(failed[0]?.reason ?? '没有可解析的文件')
      }
      const now = Date.now()
      const doc: KBDoc = {
        id: uid('kb_'),
        name: name.trim() || '未命名知识库',
        sourceFiles: ok.map((f) => ({ name: f.name, size: f.size, ...fileStats(f) })),
        // raw 原始层：源文件按段落切片存 span（片段按 span.start 有序，可聚合还原全文）
        sourcesText: ok.flatMap((f) => splitSourceText(f.text).map((s) => ({ file: f.name, span: s.span, text: s.text }))),
        bodyText: '',
        schema: 2,
        summary: '',
        consolidated: '',
        sections: [],
        charCount: 0,
        source: 'kb',
        status: 'indexing',
        embedModel: embedModelId || undefined,
        tone: Math.floor(Math.random() * 10),
        created_at: now,
        updated_at: now,
      }
      await dbKB.put(doc)
      set({
        bases: [doc, ...get().bases.filter((b) => b.id !== doc.id)],
        task: { id: doc.id, name: doc.name, done: 0, total: ok.length, startedAt: Date.now() },
      })
      if (failed.length > 0) {
        log('warn', 'kb', `部分文件解析失败 ${doc.name}`, { failed: failed.map((f) => f.name) })
      }
      log('info', 'kb', `创建知识库并开始整理 ${doc.name}`, { id: doc.id, files: ok.length })
      void taskToReady(doc, ctl.signal)
      return doc.id
    },

    async appendFiles(id, files) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) return
      if (get().task) throw new Error('已有整理任务进行中，请先完成或中断当前任务')
      // V4-P02：append 要计入库内既有 sourceFiles 的文件数与总体积，防反复追加绕过上限
      assertImportLimits(files, doc.sourceFiles.reduce((s, f) => s + f.size, 0))
      // 乐观上屏：占位行（pending=true → 列表显示「解析中…」）+ 任务计时立即出现。
      // 此前要等 parseFiles + 统计 + 切片全部完成（15MB txt 主线程可卡数秒）才更新 store，
      // 期间列表无新文件、无进行中提示，用户以为点了没反应（真机 bug 6.x）。解析失败整体回滚。
      const rollback = () => set({ bases: get().bases.map((b) => (b.id === id ? doc : b)), task: null })
      set({
        bases: get().bases.map((b) =>
          b.id === id
            ? { ...doc, sourceFiles: [...doc.sourceFiles, ...files.map((f) => ({ name: f.name, size: f.size, pending: true }))] }
            : b,
        ),
        task: { id, name: doc.name, done: 0, total: files.length, startedAt: Date.now() },
      })
      const ctl = beginTask()
      try {
        const { ok, failed } = await parseFiles(files, ctl.signal)
        if (ok.length === 0) {
          rollback()
          if (ctl.signal.aborted) return
          throw new Error(failed[0]?.reason ?? '没有可解析的文件')
        }
        // 让出一帧：占位行/「解析中」先真正上屏，再进同步重活（大文本切片/统计）
        await new Promise((r) => setTimeout(r, 0))
        // BUG-10 修复：以 DB 最新记录为基底合并新文件（解析期间语义索引等并发任务可能已写回，
        // 用内存旧快照覆盖会回滚那些变更——笔记被静默丢弃的根因之一）
        const base = (await dbKB.get(id)) ?? doc
        const merged: KBDoc = {
          ...base,
          sourceFiles: [...base.sourceFiles, ...ok.map((f) => ({ name: f.name, size: f.size, ...fileStats(f) }))],
          sourcesText: [
            ...base.sourcesText,
            ...ok.flatMap((f) => splitSourceText(f.text).map((s) => ({ file: f.name, span: s.span, text: s.text }))),
          ],
          // 追加后旧正文已失配新源文件，清空并整库重算；语义索引随内容失效，复位需重建
          bodyText: '',
          consolidated: '',
          sections: [],
          summary: '',
          charCount: 0,
          schema: 2,
          status: 'indexing',
          embedStatus: 'idle',
          embedDim: undefined,
          error: undefined,
          updated_at: Date.now(),
        }
        await dbKB.put(merged)
        set({
          bases: get().bases.map((b) => (b.id === id ? merged : b)),
          task: { id: merged.id, name: merged.name, done: 0, total: ok.length, startedAt: Date.now() },
        })
        if (failed.length > 0) {
          log('warn', 'kb', `追加文件部分解析失败 ${merged.name}`, { failed: failed.map((f) => f.name) })
        }
        log('info', 'kb', `追加文件并重新整理 ${merged.name}`, {
          id: merged.id,
          added: ok.length,
          files: ok.map((f) => f.name),
          total: merged.sourceFiles.length,
        })
        void taskToReady(merged, ctl.signal)
      } catch (e) {
        if (get().task?.id === id) rollback()
        throw e
      }
    },

    async appendNote(id, title, content) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) return
      if (get().task) throw new Error('已有整理任务进行中，请先完成或中断当前任务')
      const name = title.trim() || '未命名笔记'
      const body = content.trim()
      if (!body) throw new Error('笔记内容不能为空')
      // 限制口径：笔记按字符数记为文本体积，与文件大小同列计入单库累计上限，防无限追加
      assertImportLimits([{ name, size: body.length }], doc.sourceFiles.reduce((s, f) => s + f.size, 0))
      const slices = splitSourceText(body)
      if (slices.length === 0) throw new Error('笔记内容不能为空')
      const ctl = beginTask()
      // BUG-10 修复：以 DB 最新记录为基底合并（同 appendFiles，防旧快照覆盖并发写回）
      const base = (await dbKB.get(id)) ?? doc
      const merged: KBDoc = {
        ...base,
        sourceFiles: [...base.sourceFiles, { name, size: body.length, ...fileStats({ name, text: body }), type: 'note' }],
        // 笔记纯文本直接切片入 sourcesText（同文件管线：file=标题、span 可回源；检索/分块零改动生效）
        sourcesText: [...base.sourcesText, ...slices.map((s) => ({ file: name, span: s.span, text: s.text }))],
        bodyText: '',
        consolidated: '',
        sections: [],
        summary: '',
        charCount: 0,
        schema: 2,
        status: 'indexing',
        embedStatus: 'idle',
        embedDim: undefined,
        error: undefined,
        updated_at: Date.now(),
      }
      await dbKB.put(merged)
      set({
        bases: get().bases.map((b) => (b.id === id ? merged : b)),
        task: { id: merged.id, name: merged.name, done: 0, total: 1, startedAt: Date.now() },
      })
      log('info', 'kb', `添加文字笔记 ${merged.name}`, { id, note: name, chars: body.length })
      void taskToReady(merged, ctl.signal)
    },

    async resume(id) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) return
      if (get().task) throw new Error('已有整理任务进行中，请先完成或中断当前任务')
      const ctl = beginTask()
      // BUG-10 修复：以 DB 最新记录为基底（防旧快照覆盖并发写回）
      const base = (await dbKB.get(id)) ?? doc
      const relaunch: KBDoc = { ...base, status: 'indexing', error: undefined, updated_at: Date.now() }
      await dbKB.put(relaunch)
      set({
        bases: get().bases.map((b) => (b.id === relaunch.id ? relaunch : b)),
        task: { id: relaunch.id, name: relaunch.name, done: 0, total: relaunch.sourceFiles.length, startedAt: Date.now() },
      })
      log('info', 'kb', `继续整理知识库 ${relaunch.name}`, { id: relaunch.id })
      void taskToReady(relaunch, ctl.signal)
    },

    async rename(id, name) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) return
      // BUG-10 修复：读-改-写合并，不用旧快照整条覆盖
      const updated = await mergeKBDoc(id, { name: name.trim() || doc.name, updated_at: Date.now() })
      if (updated) log('info', 'kb', `重命名知识库 ${updated.name}`, { id })
    },

    async remove(id) {
      const doc = get().bases.find((b) => b.id === id)
      await dbKB.delete(id)
      // V-EMB：连带删除语义索引向量（与库同生命周期）
      await dbKBVectors.delete(id)
      set({
        bases: get().bases.filter((b) => b.id !== id),
        pendingRefIds: get().pendingRefIds.filter((x) => x !== id),
        // 删库时若该库的语义索引任务在跑：立即清任务条，防孤儿任务挡住其他库「生成索引」。
        // runEmbed 无中断信号，后台剩余计算跑完后由完成路径 mergeKBDoc 判定库已删除→弃置结果（已有兜底）
        ...(get().embedTask?.kbId === id ? { embedTask: null } : {}),
      })
      log('info', 'kb', `删除知识库 ${doc?.name ?? id}`, { id })
      // 6.90 自动清理：删除「不再被任何知识库绑定」的向量模型缓存，释放存储空间
      const bound = get().bases.map((b) => b.embedModel).filter(Boolean) as string[]
      void gcEmbedCaches(bound)
        .then((removed) => { if (removed.length) log('info', 'kb', `已自动释放未使用向量模型缓存: ${removed.join('、')}`) })
        .catch(() => { /* 清理失败不影响删除，下次启动兜底重试 */ })
    },

    setPendingRefIds(ids) {
      set({ pendingRefIds: ids })
    },

    openReader(id) {
      set({ readerId: id })
    },

    closeReader() {
      set({ readerId: null })
    },

    openDetail(id) {
      set({ detailId: id })
    },

    closeDetail() {
      set({ detailId: null })
    },

    setKbModel(id, modelId) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) return
      // BUG-10 修复：读-改-写合并（不用旧快照整条覆盖）
      void mergeKBDoc(id, {
        embedModel: modelId || undefined,
        // 检索方式变更后旧索引与新模型错位，复位为未启用，需重建
        embedStatus: 'idle',
        embedDim: undefined,
        updated_at: Date.now(),
      }).then((m) => { if (m) log('info', 'kb', `切换检索方式 ${m.name} → ${modelId ?? 'BM25'}`, { id }) })
    },

    cancelTask() {
      // V4-P01：abort 会触发 Worker 终止与 parse 中断，taskToReady 捕获 aborted 后清 task 且不标 failed
      taskAbort?.abort()
      taskAbort = null
      set({ task: null })
    },

    async generateEmbed(id) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) throw new Error('知识库不存在')
      if (doc.status !== 'ready') throw new Error('知识库尚未整理完成，请先整理')
      if (get().embedTask) {
        // 孤儿任务防御：任务所属库已被删除（如索引进行中删库）→ 清掉后放行本次；否则才是真实并发冲突
        if (!get().bases.some((b) => b.id === get().embedTask!.kbId)) set({ embedTask: null })
        else throw new Error('已有语义索引生成任务进行中')
      }
      if (doc.sourceFiles.length === 0 || !doc.bodyText) throw new Error('该库暂无内容，请先添加数据源再生成索引')

      const modelId = doc.embedModel
      if (!modelId || modelId === EMBED_MODE_BM25) throw new Error('该知识库为关键词检索方式，无需生成语义索引；请先在详情中更换为向量模型')
      const model = getEmbedModel(modelId)
      if (!model) throw new Error(`未知 embedding 模型: ${modelId}`)
      // 6.90 全自动化：模型缓存缺失时自动从 app 内置资产准备（本地复制，幂等——已就绪时零开销）。
      // 准备阶段固定文案（用户拍板：不加文件名/字节等多余信息）；缓存已就绪时瞬间跳过
      set({ embedTask: { kbId: id, done: 0, total: 0, prepare: '正在准备模型' } })
      await ensureModelFiles(modelId)

      // 置 indexing（不丢旧 embedStatus/旧向量：失败保留，成功原子替换）；
      // BUG-10 修复：读-改-写合并，不用旧快照整条覆盖
      const t0 = Date.now()
      const tick = (done: number, total: number) =>
        set({ embedTask: { kbId: id, done, total, elapsed: Date.now() - t0 } })
      const indexing = await mergeKBDoc(id, { embedStatus: 'indexing' })
      if (!indexing) throw new Error('知识库不存在')
      // OBS-11：先取断点前缀再初始化任务条——断点续建启动瞬间即显示「已完成 N/总 段」，
      // 不再先显示「0/N 段 · 0s」与「断点续建不从头重算」文案矛盾（随后 buildAnchors 同步重算会短暂冻结 UI）
      const prev = await dbKBVectors.get(id)
      let resumeStart = 0
      if (
        prev && prev.modelId === modelId && prev.dim === model.dim &&
        prev.partialDone != null && prev.partialDone > 0
      ) {
        resumeStart = prev.partialDone
      }
      set({ embedTask: { kbId: id, done: resumeStart, total: doc.sections.length, elapsed: Date.now() - t0 } })
      log('info', 'kb', `生成语义索引 ${doc.name}`, { id, modelId, sections: doc.sections.length })

      try {
        const { anchors, anchorSectionIdx } = buildAnchors(doc)
        // 断点续建（真机 6.x：大库 8180 段中断后从零重算不可接受）：上次中断的「部分完成」前缀
        // 暂存在 kb_vectors（partialDone 标记），模型/维度/锚点集一致时跳过前缀只算剩余
        let acc: Float32Array[] = []
        let startIdx = resumeStart
        if (
          !(
            prev && prev.modelId === modelId && prev.dim === model.dim &&
            prev.partialDone != null && prev.partialDone > 0 &&
            prev.anchorSectionIdx?.length === anchorSectionIdx.length
          )
        ) {
          // 锚点集/模型/维度有变 → 前缀不可复用，从零开始（tickAbs 会把进度条拨回真实值）
          acc = []
          startIdx = 0
        } else {
          acc = prev.vectors.slice(0, startIdx)
          log('info', 'kb', `语义索引断点续建 ${doc.name}`, { id, from: startIdx, total: anchors.length })
        }
        const remaining = anchors.slice(startIdx)
        const tickAbs = (doneAbs: number) => tick(doneAbs, anchors.length)
        tickAbs(startIdx)
        let doneRel = 0
        const vectors = await runEmbed(modelId, remaining, {
          onProgress: (done) => {
            doneRel = done
            tickAbs(startIdx + done)
          },
          onBatch: (_batchFirstIdx, batchVectors) => {
            // 每批增量持久化（批=8 段）：中断后最多重算一批
            acc = acc.concat(batchVectors)
            void dbKBVectors.putPartial(id, acc, model.dim, modelId, anchorSectionIdx, acc.length).catch(() => undefined)
          },
        })
        void doneRel
        const all = startIdx > 0 ? acc.concat(vectors) : vectors
        // 原子替换：向量 + 锚点→节映射 + 元数据同一批写库，成功才切 ready
        await dbKBVectors.put(id, all, model.dim, modelId, anchorSectionIdx)
        // BUG-10 修复：完成写回改为读-改-写 + 内容指纹校验——
        // 长跑期间库内容若已变更（添加文件/笔记触发重整），旧内容算出的向量已失配，
        // 不再标记 ready（复位 idle 待重建），更不能用旧快照整条覆盖回滚期间的追加
        const contentUnchanged = (l: KBDoc) =>
          l.sourcesText.length === doc.sourcesText.length &&
          l.sections.length === doc.sections.length &&
          l.bodyText.length === doc.bodyText.length &&
          l.charCount === doc.charCount
        const merged = await mergeKBDoc(id, (latest) =>
          contentUnchanged(latest)
            ? { embedModel: modelId, embedDim: model.dim, embedStatus: 'ready', updated_at: Date.now() }
            : { embedStatus: 'idle', embedDim: undefined, updated_at: Date.now() },
        )
        set({ embedTask: null })
        if (!merged) {
          // 库在长跑期间被删除：mergeKBDoc 已放弃写回（不会复活），清掉孤儿向量
          await dbKBVectors.delete(id).catch(() => undefined)
          log('info', 'kb', `知识库已删除，语义索引结果弃置`, { id })
          return 0
        }
        if (merged.embedStatus !== 'ready') {
          invalidateVectorCache(id)
          log('warn', 'kb', `语义索引完成但库内容已变更，结果作废待重建 ${merged.name}`, { id, sections: doc.sections.length })
          return 0
        }
        await warmVectorCache(merged)
        const elapsed = Date.now() - t0
        log('info', 'kb', `语义索引完成 ${merged.name}`, { id, chars: all.length, elapsed, resumed: startIdx })
        return elapsed // 返回耗时（毫秒），由 UI 层展示
      } catch (e) {
        const raw = e instanceof Error ? e.message : 'embedding 失败'
        // V-EMB 已知浏览器端限制（见 docs/app_bug.md）：transformers.js 内嵌 ort.webgpu.bundle 在无 WebGPU
        // 沙箱（预览/旧版 WebView）解析 fp32 模型 protobuf 失败。把技术错误转友好提示，方便用户排查。
        const friendly = /protobuf|onnxruntime|webgpu|wasm|backend/i.test(raw)
          ? `本地推理引擎加载失败（可能当前环境不支持 WebGPU/wasm 后端）。建议在真机 Chrome/Edge 或桌面端重试。详情：${raw.slice(0, 120)}`
          : raw
        // BUG-10 修复：失败标记同样走读-改-写（库可能已被删除——不复活）
        const failed = await mergeKBDoc(id, { embedStatus: 'error' })
        set({ embedTask: null })
        log('error', 'kb', `语义索引失败 ${failed?.name ?? doc.name}`, { id, message: raw })
        throw new Error(friendly)
      }
    },

    async removeEmbed(id) {
      const doc = get().bases.find((b) => b.id === id)
      if (!doc) return
      await dbKBVectors.delete(id)
      invalidateVectorCache(id)
      // 只删生成的索引向量，保留该库绑定的检索模型（置为待生成，可随时重建）；换回关键词需在详情「更换检索方式」
      // BUG-10 修复：读-改-写合并，不用旧快照整条覆盖
      const updated = await mergeKBDoc(id, { embedDim: undefined, embedStatus: 'idle', updated_at: Date.now() })
      if (updated) log('info', 'kb', `删除语义索引 ${updated.name}`, { id })
    },
  }
})
