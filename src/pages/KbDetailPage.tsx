/**
 * 知识库详情页（V-EMB 每库绑定检索方式，建库时固定）：
 * 承载库管理所有操作——文件清单/预览、添加数据源、查看资料(阅读器)、聊天引用、
 * 生成/重删语义索引、重命名、删除，以及内置「召回测试」。
 * 列表卡片只展示关键信息，具体内容在此页呈现；空库态引导先添加数据源。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useKB } from '../stores/useKBStore'
import { useModal } from '../stores/useModalStore'
import type { KBDoc } from '../types'
import { fmtChars, fmtLines } from '../services/kb/clean'
import { parseOutline } from '../services/kb/outline'
import { CODE_EXTS, fileExt, SUPPORTED_ACCEPT } from '../services/files/parse'
import { surrogateSafeEnd } from '../services/files/pool'
import { pickFiles } from '../utils'
import { dbKBVectors } from '../db'
import { getEmbedModel } from '../ai/embed/registry'
import type { EmbedModel } from '../ai/embed/types'
import AppIcon from '../components/AppIcon'
import RecallTest from '../components/RecallTest'

/** 向量模型短名 */
function idxShort(id?: string): string {
  if (id === 'bge-small-zh-v1.5') return 'bge'
  if (id === 'qwen3-embedding-0.6b') return 'Qwen3'
  return id || ''
}
/** 完整模型名（去后缀） */
function modelFullName(m: EmbedModel): string {
  return m.name.replace(/\s*（.*?）\s*$/g, '').trim()
}

/** 从文件/笔记取类型标签（仅展示用；笔记显式「笔记」，其余按扩展名） */
function fileKind(name: string, type?: 'file' | 'note'): string {
  if (type === 'note') return '笔记'
  const i = name.lastIndexOf('.')
  const e = i === -1 ? '' : name.slice(i + 1).toLowerCase()
  const office: Record<string, string> = { docx: 'Word', xlsx: 'Excel', odt: 'ODT' }
  return office[e] ?? (e ? e.toUpperCase() : '文件')
}
/** 源文件统计展示：带章节数时显示「N 章节 · xx字」；解析中的占位行显示「解析中…」 */
function fmtFileStat(f: { name: string; chars?: number; lines?: number; words?: number; size: number; pending?: boolean }, fileCh?: number): string {
  if (f.pending) return '解析中…'
  const sizeTxt = fmtChars(f.chars ?? f.size)
  if (fileCh != null) return `${fileCh === 0 ? '' : fileCh + ' 章节 · '}${sizeTxt}`
  if (CODE_EXTS.has(fileExt(f.name))) return f.lines != null ? fmtLines(f.lines) : fmtChars(f.size)
  return sizeTxt
}
/** 把 sourcesText 聚合还原成「文件名 → 全文」 */
function groupFileTexts(kb: KBDoc): Record<string, string> {
  const m: Record<string, string> = {}
  for (const s of kb.sourcesText) m[s.file] = (m[s.file] ?? '') + (s.text ?? '')
  return m
}
const SRC_PAGE_CHARS = 6000

export default function KbDetailPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const modal = useModal()
  const { bases, detailId, closeDetail, appendFiles, appendNote, openReader, embedTask, generateEmbed, removeEmbed, setPendingRefIds, task } = useKB()

  const kb: KBDoc | undefined = bases.find((b) => b.id === detailId)

  // 添加文字笔记的面板状态（标题 + 粘贴正文；借鉴 Cherry Studio note 数据源）
  const [noteDraft, setNoteDraft] = useState<{ open: boolean; title: string; content: string }>({
    open: false, title: '', content: '',
  })

  // 「添加数据源」下拉：借鉴 Cherry Studio 的折叠式来源选择（文件 / 文字笔记），点击后才展开
  const [srcMenuOpen, setSrcMenuOpen] = useState(false)
  const srcMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (srcMenuRef.current && !srcMenuRef.current.contains(e.target as Node)) setSrcMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  // 源文件预览：仅点进具体文件时才异步拼接 + 分页
  const [srcPreview, setSrcPreview] = useState<{ name: string; page: number } | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewReady, setPreviewReady] = useState(false)

  useEffect(() => {
    if (!kb || !srcPreview) {
      setPreviewText('')
      setPreviewReady(false)
      return
    }
    setPreviewReady(false)
    const t = window.setTimeout(() => {
      setPreviewText(groupFileTexts(kb)[srcPreview.name] ?? '')
      setPreviewReady(true)
    }, 0)
    return () => window.clearTimeout(t)
  }, [kb, srcPreview?.name])

  const srcPreviewPages = useMemo(() => {
    if (!previewText) return []
    const out: string[] = []
    let from = 0
    while (from < previewText.length) {
      const rel = surrogateSafeEnd(previewText.slice(from), SRC_PAGE_CHARS)
      out.push(previewText.slice(from, from + rel))
      from += rel
    }
    return out
  }, [previewText])

  // BUG-11 修复：汇总行章节数与数据层同口径——直接取 sections.length（检索分块数，
  // 与 withBody summary「N 份资料 · M 节」一致）。此前用 parseOutline 一级标题数，
  // 大文件「DB 10813 节 vs UI 5 章节」两口径悬殊易误读为数据丢失。
  const chapters = kb?.sections?.length ?? 0

  // 各源文件章节数：按 outline Level-1 归属文件统计（sections 已按源文件标注 file，二分推断 offset 所属文件）
  const fileChapters = useMemo(() => {
    const m: Record<string, number> = {}
    if (!kb || kb.status !== 'ready' || !kb.bodyText) return m
    const secs = kb.sections ?? []
    if (secs.length === 0) return m
    const fileOf = (offset: number): string | undefined => {
      let lo = 0
      let hi = secs.length - 1
      let found: string | undefined
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (secs[mid].start <= offset) { found = secs[mid].file; lo = mid + 1 }
        else hi = mid - 1
      }
      return found
    }
    for (const o of parseOutline(kb.bodyText, secs, fileOf)) {
      if (o.level !== 1 || !o.file) continue
      m[o.file] = (m[o.file] ?? 0) + 1
    }
    return m
  }, [kb])

  // BUG-15 修复：本组件的 useState/useEffect 必须在「kb 不存在」的条件早返回**之前**全部执行——
  // 此前早返回挂在 hooks 中间，详情页打开状态下删除该库 → kb 变 undefined 触发早返回 →
  // 本轮渲染 hook 数量少于上一轮 → React「Rendered fewer hooks than expected」整树白屏。
  const currentModel = kb?.embedModel ? getEmbedModel(kb.embedModel) : undefined
  const isVector = !!kb?.embedModel && kb.embedModel !== 'bm25'
  const busy = !!kb && embedTask?.kbId === kb.id
  // 整理任务进行中（含本库解析阶段）：禁用「添加数据源」，防止并发追加
  const taskBusy = !!task

  // 索引生成秒表：1s 心跳 + 以 embedTask.elapsed 为基点（重进页面/中断续跑时计时不归零，真机 bug 6.x）
  const [busyTick, setBusyTick] = useState(0)
  const [busyStart, setBusyStart] = useState(0)
  useEffect(() => {
    if (!busy) return
    setBusyStart(Date.now() - (embedTask?.elapsed ?? 0))
    const iv = window.setInterval(() => setBusyTick((n) => n + 1), 1000)
    return () => window.clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])
  const embedElapsedS = busy && busyStart ? Math.floor((Date.now() - busyStart) / 1000) : (embedTask?.elapsed ?? 0) / 1000
  // 触碰 tick 依赖避免 lint 误报（busy 变化时重渲染即可）
  void busyTick

  // 预载阅读器 chunk：进入详情页即拉取，「查看资料」切换时不再出现懒加载空窗
  // （配合 App.tsx 的不透明 fallback，双保险消除「闪现知识库首页」，真机 bug 6.x）
  useEffect(() => {
    void import('./KbReaderPage')
  }, [])

  // 索引中断续建：embeddingStatus=indexing 且存在部分完成前缀时，展示已完成的段数，
  // 「继续生成索引」走 generateEmbed 的断点续建（跳过已算完前缀，真机 bug 6.x）
  const [partialDone, setPartialDone] = useState<number | null>(null)
  useEffect(() => {
    if (!kb || kb.embedStatus !== 'indexing') {
      setPartialDone(null)
      return
    }
    void dbKBVectors
      .get(kb.id)
      .then((row) => setPartialDone(row?.partialDone ?? 0))
      .catch(() => setPartialDone(null))
  }, [kb?.id, kb?.embedStatus, kb?.updated_at])

  if (!kb) {
    return (
      <div>
        <div className="row" style={{ margin: '6px 0 12px' }}>
          <button className="btn ghost sm" onClick={() => navigate('kb')}>‹ 返回</button>
          <div className="page-title" style={{ margin: 0 }}>知识库</div>
        </div>
        <div className="empty"><div className="em">🏷️</div><div className="es">知识库不存在或已删除</div></div>
      </div>
    )
  }

  const handleAppend = async () => {
    const files = await pickFiles(SUPPORTED_ACCEPT)
    if (files.length === 0) return
    try {
      await appendFiles(kb.id, files)
      showToast('已添加数据源，开始整理')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加数据源失败')
    }
  }

  /** 添加数据源入口：点击展开来源下拉（文件 / 文字笔记，借鉴 Cherry Studio），具体选中在 JSX 菜单内处理 */
  const handleAddSource = () => {
    setSrcMenuOpen((o) => !o)
  }

  const confirmNote = async () => {
    const title = noteDraft.title.trim()
    const content = noteDraft.content.trim()
    if (!title) return showToast('请填写笔记标题')
    if (!content) return showToast('笔记内容不能为空')
    try {
      await appendNote(kb.id, title, content)
      showToast('已添加文字笔记，开始整理')
      setNoteDraft({ open: false, title: '', content: '' })
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加笔记失败')
    }
  }

  const regenerate = () => {
    if (busy || !isVector || !kb.embedModel) return
    const model = getEmbedModel(kb.embedModel)
    if (!model) return showToast('未知向量模型，请在「我的 → 向量模型」中确认')
    generateEmbed(kb.id)
      .then((elapsed) => showToast(`语义索引生成完成，用时 ${Math.round((elapsed ?? 0) / 1000)} 秒`))
      .catch((e) => showToast(e instanceof Error ? e.message : '语义索引生成失败'))
  }

  const handleRemoveEmbed = () => {
    if (!isVector || busy) return
    modal.confirm('删除语义索引', `删除「${kb.name}」已生成的语义索引后，该库检索会降级为关键词；仍保留 ${idxShort(kb.embedModel)} 绑定，可随时重新生成。`, () => {
      removeEmbed(kb.id).catch((e) => showToast(e instanceof Error ? e.message : '删除失败'))
    })
  }

  const back = () => {
    closeDetail()
    navigate('kb')
  }

  /** 聊天引用：预置引用后跳生成页（原列表卡按钮迁入详情） */
  const handleRef = () => {
    if (kb.status !== 'ready') return
    setPendingRefIds([kb.id])
    navigate('generate')
  }

  /** 查看资料：进阅读器（原列表卡按钮迁入详情） */
  const handleView = () => {
    if (kb.status !== 'ready' || !kb.sourceFiles.length) return
    openReader(kb.id)
    navigate('kb-reader', true)
  }

  return (
    <div className="kb-detail-page">
      <div className="kb-detail-head">
        <button className="btn ghost sm kb-detail-back" onClick={back}>‹ 返回</button>
        <div className="kb-detail-title-wrap">
          <div className="page-title kb-detail-title">{kb.name}</div>
        </div>
      </div>

      {/* 操作行：原列表卡「聊天引用/查看资料」迁入详情，列表卡更简洁 */}
      <div className="kb-detail-actions">
        <button
          className="btn primary"
          onClick={handleRef}
          disabled={kb.status !== 'ready' || !kb.sourceFiles.length}
        >
          聊天引用
        </button>
        <button
          className="btn ghost"
          onClick={handleView}
          disabled={kb.status !== 'ready' || !kb.sourceFiles.length}
        >
          查看资料
        </button>
      </div>

      {/* 数据源 + 操作 */}
      <div className="card kb-src-card">
        <div className="kb-src-head">
          <div className="card-title">数据源</div>
          <div className="kb-src-actions">
            <div ref={srcMenuRef} className="kb-src-menu-ct" style={{ position: 'relative' }}>
              <button className="btn sm" onClick={handleAddSource} disabled={taskBusy} title={taskBusy ? '整理任务进行中' : undefined}>
                <AppIcon name="plus" size={15} /> {taskBusy ? '整理中…' : '添加数据源'}
              </button>
              {srcMenuOpen && (
                <div className="kb-idx-menu">
                  <button className="kb-idx-item" onClick={() => { setSrcMenuOpen(false); void handleAppend() }}>添加文件</button>
                  <button className="kb-idx-item" onClick={() => { setSrcMenuOpen(false); setNoteDraft({ open: true, title: '', content: '' }) }}>添加文字笔记</button>
                </div>
              )}
            </div>
            {kb.status === 'ready' && kb.sourceFiles.length > 0 && (
              <button className="btn ghost sm" onClick={() => { openReader(kb.id); navigate('kb-reader', true) }}><AppIcon name="file" size={15} /> 查看资料</button>
            )}
          </div>
        </div>
        {kb.sourceFiles.length === 0 ? (
          <div className="kb-empty-src">
            <div className="card-sub">还没有数据源。空库需先添加资料文件，才能整理成分块供检索与出题。</div>
          </div>
        ) : (
          <div className="kb-src-list">
            {kb.status === 'ready' || kb.status === 'indexing' ? (
              kb.sourceFiles.map((f) => (
                <button key={f.name} className="kb-src-row kb-src-item" onClick={() => setSrcPreview({ name: f.name, page: 0 })}>
                  <span className="kb-src-kind">{fileKind(f.name, f.type)}</span>
                  <span className="flex-1 kb-src-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span className="kb-src-stat">{fmtFileStat(f, fileChapters[f.name])}</span>
                </button>
              ))
            ) : (
              <div className="kb-error">{kb.status === 'failed' ? (kb.error || '整理失败') : '整理未完成'}</div>
            )}
            <div className="kb-src-summary">{kb.sourceFiles.length} 份资料 · {chapters} 节 · {fmtChars(kb.charCount)}</div>
          </div>
        )}
      </div>

      {/* 源文件预览 */}
      {srcPreview && (
        <div className="card">
          <div className="kb-src-row" style={{ marginBottom: 8 }}>
            <button className="btn plain sm" onClick={() => setSrcPreview(null)}>← 返回列表</button>
            <span className="card-sub" style={{ marginLeft: 'auto' }}>
              {srcPreview.name} · {fmtFileStat(kb.sourceFiles.find((f) => f.name === srcPreview.name) ?? { name: srcPreview.name, size: 0 })}
              {srcPreviewPages.length > 1 && ` · ${srcPreview.page + 1}/${srcPreviewPages.length}`}
            </span>
          </div>
          <pre className="kb-src-pre">
            {previewReady ? (srcPreviewPages[srcPreview.page] ?? '(该文件无文本内容)') : '加载中…'}
          </pre>
          {previewReady && srcPreviewPages.length > 1 && (
            <div className="kb-src-nav">
              <button className="btn plain sm" disabled={srcPreview.page <= 0} onClick={() => setSrcPreview({ name: srcPreview.name, page: srcPreview.page - 1 })}>上一页</button>
              <button className="btn plain sm" disabled={srcPreview.page >= srcPreviewPages.length - 1} onClick={() => setSrcPreview({ name: srcPreview.name, page: srcPreview.page + 1 })}>下一页</button>
            </div>
          )}
        </div>
      )}

      {/* 检索方式（建库时已固定，仅展示；模型名同行右侧为索引操作） */}
      <div className="card">
        <div className="card-title mb-8">检索方式</div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {currentModel && isVector ? (
            <>
              <img className="avatar-logo sm" src={currentModel.logo} alt={currentModel.name} />
              <span className="flex-1" style={{ fontWeight: 600 }}>{modelFullName(currentModel)}</span>
            </>
          ) : (
            <><span className="kb-mode-emoji">🔍</span><span className="flex-1" style={{ fontWeight: 600 }}>关键词检索（BM25）</span></>
          )}
          {isVector && (
            <div className="row" style={{ gap: 6, margin: 0, flex: 'none' }}>
              {kb.embedStatus === 'ready' ? (
                <>
                  <button className="btn sm" onClick={regenerate} disabled={busy}>{busy ? '生成中…' : '重新生成'}</button>
                  <button className="btn plain sm" onClick={handleRemoveEmbed} disabled={busy}>删除索引</button>
                </>
              ) : (
                <button className="btn sm" onClick={regenerate} disabled={busy || kb.status !== 'ready' || kb.sourceFiles.length === 0}>
                  {busy ? '生成中…' : kb.embedStatus === 'indexing' ? '继续生成索引' : kb.embedStatus === 'error' ? '重试生成' : '生成索引'}
                </button>
              )}
            </div>
          )}
        </div>
        {/* 生成中进度条：段数 + 秒表实时走动（此前只置灰按钮无任何提示，用户以为卡死）。
            RC-03 真机反馈：去掉「大库约需几分钟，可离开本页」补充，进度+计时已足够 */}
        {busy && embedTask && (
          <div className="card-sub" style={{ marginTop: 8 }}>
            {embedTask.prepare
              ? embedTask.prepare
              : `语义索引生成中 ${embedTask.done}/${embedTask.total} 段 · 已用 ${embedElapsedS}s`}
          </div>
        )}
        {/* 中断续建提示：上次生成中断的库显示已完成段数，点「继续生成索引」跳过已完成部分 */}
        {!busy && kb.embedStatus === 'indexing' && (
          <div className="card-sub" style={{ marginTop: 8 }}>
            上次索引生成中断{partialDone != null && partialDone > 0 ? `，已完成 ${partialDone} 段` : ''}——点「继续生成索引」将断点续建，不会从头重算
          </div>
        )}
      </div>

      {/* 召回测试（内置在本库） */}
      <div className="card kb-recall-wrap">
        <div className="card-title mb-8">召回测试</div>
        <RecallTest kb={kb} />
      </div>

      {/* 添加文字笔记面板（借鉴 Cherry Studio note：标题 + 粘贴正文直入知识库） */}
      {noteDraft.open && (
        <div className="mask" onClick={() => setNoteDraft((d) => ({ ...d, open: false }))}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">添加文字笔记</div>
            <input
              className="input"
              autoFocus
              placeholder="笔记标题（如「产品命名规范」）"
              value={noteDraft.title}
              onChange={(e) => setNoteDraft((d) => ({ ...d, title: e.target.value }))}
            />
            <textarea
              className="input kb-note-input"
              rows={8}
              placeholder="在这里粘贴笔记正文…"
              value={noteDraft.content}
              onChange={(e) => setNoteDraft((d) => ({ ...d, content: e.target.value }))}
              style={{ resize: 'vertical', minHeight: 160, fontFamily: 'inherit', lineHeight: 1.6 }}
            />
            <div className="modal-desc" style={{ fontSize: 12 }}>正文将作为纯文本进入知识库，参与切分、检索与出题。</div>
            <div className="modal-btns">
              <button className="btn ghost flex-1" onClick={() => setNoteDraft((d) => ({ ...d, open: false }))}>取消</button>
              <button className="btn flex-1" onClick={confirmNote}>添加</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}