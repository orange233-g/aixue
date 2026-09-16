/**
 * 知识库阅读器（Phase 3 阅读器需求）：
 * 整页阅读模式——按章分页 + 翻页动画（覆盖/上下/平移）、护眼背景/字号/亮度/夜间、
 * 底部工具条（目录/夜间/字号/设置/更多）、目录/书签/想法面板、选中文本添加批注。
 * 双视图（Phase 2 去凝练）：「重排」= 清洗后正文 Markdown 渲染；「原文」= raw 层 pre-wrap 直显原始排版。
 * 无标题纯文本库按 sections 分块分页（每节一页）。
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useUI, type PageId } from '../stores/useUIStore'
import { useModal } from '../stores/useModalStore'
import { useKB } from '../stores/useKBStore'
import { useReader } from '../stores/useReaderStore'
import type { ReaderAnim, ReaderSettings } from '../types'
import { renderMarkdown } from '../utils/markdown'
import { exportResultToast, exportTextFile, sanitizeFileName } from '../utils'
import { parseOutline, splitChapters, hasBody, resolveTocTarget, type OutlineItem, type ReaderChapter } from '../services/kb/outline'
import { aggregateSourceTexts } from '../services/kb/sourceSplit'
import { detectFragmented, cleanText } from '../services/kb/clean'
import { buildFileSpans } from '../services/kb/process'
import { surrogateSafeEnd } from '../services/files/pool'
import { CODE_EXTS, fileExt } from '../services/files/parse'
import AppIcon from '../components/AppIcon'

/** 字号档位（设置面板四档） */
const FONT_SIZES = [14, 16, 18, 20]
const FONT_LABELS: Record<number, string> = { 14: '小', 16: '中', 18: '大', 20: '特大' }
/** 原文模式分页字符数：超长 raw 一次渲染成单文本节点会卡顿，按此切页逐页渲染 */
const RAW_PAGE_CHARS = 6000
/** 目录行高（px，虚拟列表按此行高计算可视窗口；须与 .rdr-toc-win .rdr-toc-item 一致） */
const TOC_ITEM_H = 38
/** 护眼背景 */
const BGS: { id: 'paper' | 'green' | 'yellow' | 'blue'; label: string }[] = [
  { id: 'paper', label: '纸白' },
  { id: 'green', label: '浅绿' },
  { id: 'yellow', label: '浅黄' },
  { id: 'blue', label: '浅蓝' },
]
const ANIMS: { id: ReaderAnim; label: string }[] = [
  { id: 'cover', label: '覆盖' },
  { id: 'vertical', label: '上下' },
  { id: 'horizontal', label: '平移' },
]

function MoonIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

function GearIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
    </svg>
  )
}

/* ============================ 上下（vertical）动画：连续滚动 ============================
 * 需求：上下翻页不再是「一章一屏、切章后跳到最上方重新开始」，而是一条连续的滚动流——
 *  第一章一路往下刷，第二章紧接在下方出现，一滑到底。
 * 实现：把多章静态排布进同一个可滚动容器，用「窗口 + 高度缓存」做懒渲染：
 *  - 只渲染当前章前后一小段（窗口），滚到接近底部再向后追加载、滚到接近顶部再向前补加载；
 *  - 内存里逐章缓存已渲染过的高度，用于顶部占位（定位/进度准确）与跳转定位；
 *  - 已读过的旧章用等高等宽占位替换出 DOM，保证 DOM 常驻规模恒定、长篇不卡。
 */

/** 初始一次加载章数 */
const V_INIT = 10
/** 每次向前/向后追加载增量 */
const V_BATCH = 8
/** 当前章向后（前面）保留多少章，超出即剪枝成占位 */
const V_BACK = 6
/** 窗口规模上限，防前后反复滚动导致 DOM 无限增长 */
const V_MAX_SPAN = 28

export interface VerticalHandle {
  /** 跳转到第 idx 章（chapters 数组下标）：先量出前面所有章高度定位到章首 */
  scrollToChapter: (idx: number) => void
  /** 连续滚动容器（供调用方做批注高亮） */
  getContentEl: () => HTMLDivElement | null
}

/** 将单章 HTML 脱屏渲染一次，量出其像素高度（用于跳转时给未渲染的前序章估算定位） */
function measureBlock(html: string, width: number, isCodeLib: boolean): number {
  const el = document.createElement('div')
  el.className = 'rdr-page rdr-flow-block' + (isCodeLib ? ' rdr-mono' : '')
  el.style.position = 'absolute'
  el.style.left = '-99999px'
  el.style.top = '0'
  el.style.visibility = 'hidden'
  el.style.width = width + 'px'
  el.innerHTML = html
  document.body.appendChild(el)
  const h = el.offsetHeight
  el.remove()
  return h
}

/** 连续滚动组件：见文件头部注释。chapters 由调用方恒定为重排模式下的章列表。 */
const VerticalFlow = forwardRef<VerticalHandle, {
  chapters: ReaderChapter[]
  fontSize: number
  isCodeLib: boolean
  onMouseUp: () => void
  /** 视口当前章变化回调（驱动顶层 idx / 进度条 / 批注） */
  onCurrentChange: (idx: number) => void
}>(function VerticalFlow({ chapters, fontSize, isCodeLib, onMouseUp, onCurrentChange }, ref) {
  const [range, setRange] = useState({ lo: 0, hi: Math.min(V_INIT, chapters.length) })
  const rangeRef = useRef(range)
  const elRef = useRef<HTMLDivElement>(null)
  /** 每章像素高度缓存（chapters 下标 → 高度） */
  const heightsRef = useRef<number[]>(new Array(chapters.length).fill(NaN))
  const currentRef = useRef(onCurrentChange)
  currentRef.current = onCurrentChange

  const setBoth = (r: { lo: number; hi: number }) => {
    rangeRef.current = r
    setRange(r)
  }

  // 换库（chapters 变化）时重置窗口与高度缓存
  useEffect(() => {
    heightsRef.current = new Array(chapters.length).fill(NaN)
    setBoth({ lo: 0, hi: Math.min(V_INIT, chapters.length) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters])

  /** 顶部占位高度 = 窗口前所有已量章节高度之和（保证未渲染前文也能准确定位/计进度） */
  const topSpacer = () => {
    let s = 0
    for (let i = 0; i < rangeRef.current.lo; i++) s += heightsRef.current[i] || 0
    return s
  }

  /** 由滚动偏移推当前章：窗口内全已量，逐章累计找第一个盖过滚动位置的章 */
  const computeCurrent = (scrollTop: number): number => {
    const { lo, hi } = rangeRef.current
    let acc = topSpacer()
    for (let k = lo; k < hi; k++) {
      const h = heightsRef.current[k]
      if (!Number.isFinite(h)) return k
      if (scrollTop < acc + h) return k
      acc += h
    }
    return hi - 1
  }

  // 渲染/窗口变化后：量窗口内各章实际高度，并把当前章同步出去
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    for (const block of Array.from(el.querySelectorAll<HTMLElement>('.rdr-flow-block'))) {
      const k = Number(block.getAttribute('data-cidx'))
      if (Number.isFinite(k)) heightsRef.current[k] = block.offsetHeight
    }
    currentRef.current(computeCurrent(el.scrollTop))
  })

  // 滚动：更新当前章 + 按滚动位置向适当方向追加载/剪枝，保证 DOM 常驻规模恒定
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const onScroll = () => {
      const st = el.scrollTop
      const r = rangeRef.current
      const cur = computeCurrent(st)
      currentRef.current(cur)

      let lo = r.lo
      let hi = r.hi
      const top = topSpacer()
      // 剪枝：当前章已超出窗口前端 → 只保留其后 V_BACK 章，其余替换为等高位占位
      if (cur - lo > V_BACK) {
        lo = cur - V_BACK
      } else if (st - top < 300 && lo > 0) {
        // 滚到贴近窗口顶部 → 向前补加载更早章节（占位缩回，等效高度互换，滚动位置不变）
        lo = Math.max(0, lo - V_BATCH)
      }
      // 滚到贴近窗口底部 → 向后追加载后续章节
      if (st > el.scrollHeight - el.clientHeight - 300 && hi < chapters.length) {
        hi = Math.min(chapters.length, hi + V_BATCH)
      }
      // 规模上限：前后反复滚动导致窗口过大时收敛到当前章附近，避免 DOM 无限增长（后续滚动可再追回）
      if (hi - lo > V_MAX_SPAN) {
        lo = Math.max(0, cur - V_BACK)
        hi = Math.min(chapters.length, lo + 24)
      }
      if (lo !== r.lo || hi !== r.hi) setBoth({ lo, hi })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [chapters.length])

  // 跳转：量出 0..idx 前全部章高度 → 定位到 idx 章首；窗口迁到目标附近
  useImperativeHandle(ref, () => ({
    scrollToChapter(idx) {
      const el = elRef.current
      if (!el || chapters.length === 0) return
      const target = Math.max(0, Math.min(chapters.length - 1, idx))
      const refBlock = el.querySelector<HTMLElement>('.rdr-flow-block')
      const width = refBlock ? refBlock.clientWidth : el.clientWidth - 44
      const htmlFor = (k: number) => renderMarkdown(chapters[k].markdown, { headingId: () => '' })
      const missing = 0 // 从 0 起扫描缺失高度，逐个量
      for (let i = missing; i < target; i++) {
        if (!Number.isFinite(heightsRef.current[i])) {
          heightsRef.current[i] = measureBlock(htmlFor(i), width, isCodeLib)
        }
      }
      let acc = 0
      for (let i = 0; i < target; i++) acc += heightsRef.current[i] || 0
      setBoth({ lo: Math.max(0, target - V_BACK), hi: Math.min(chapters.length, target + V_INIT) })
      requestAnimationFrame(() => {
        const e = elRef.current
        if (e) e.scrollTop = acc
      })
    },
    getContentEl() {
      return elRef.current
    },
  }), [chapters, isCodeLib])

  const blocks: ReactNode[] = []
  for (let k = range.lo; k < range.hi; k++) {
    blocks.push(
      <div
        key={k}
        data-cidx={k}
        className={'rdr-page rdr-flow-block' + (isCodeLib ? ' rdr-mono' : '')}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(chapters[k].markdown, { headingId: (i) => `h-${k}-${i}` }) }}
      />,
    )
  }

  return (
    <div
      ref={(n) => {
        elRef.current = n
      }}
      className={'rdr-page rdr-flow' + (isCodeLib ? ' rdr-mono' : '')}
      style={{ fontSize }}
      onMouseUp={onMouseUp}
    >
      <div aria-hidden data-spacer style={{ height: topSpacer() }} />
      {blocks}
    </div>
  )
})

export default function KbReaderPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const modal = useModal()
  const { bases, loaded, readerId, closeReader, resume, load } = useKB()
  const reader = useReader()
  const { settings, bookmarks, notes, setSettings, addBookmark, removeBookmark, addNote, removeNote } = reader

  const kb = bases.find((b) => b.id === readerId)
  // 阅读源：清洗后正文（bodyText）；旧库个别未迁移时回退 consolidated
  const body = kb?.bodyText || kb?.consolidated || ''

  // 重新整理完成反馈：kb.status 从 indexing → ready 时 toast 结果（resume 不关阅读器，完成由这里提示）
  const prevKbStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (kb && prevKbStatus.current === 'indexing' && kb.status === 'ready') {
      showToast(`重新整理完成：${kb.summary}`)
    }
    prevKbStatus.current = kb?.status
  }, [kb, showToast])

  // 偏移 → 所属文件（V8-KB：sections 已按源文件标注 file，多文件库阅读器按文件分组/横幅用）
  const fileOf = useMemo(() => {
    if (!kb) return undefined
    const secs = kb.sections ?? []
    if (secs.length === 0) return undefined
    return (offset: number) => {
      // sections 按 start 有序，二分找「最后一个 start <= offset」的 section，取其 file
      let lo = 0
      let hi = secs.length - 1
      let found: string | undefined
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (secs[mid].start <= offset) {
          found = secs[mid].file
          lo = mid + 1
        } else hi = mid - 1
      }
      return found
    }
  }, [kb])

  const outline = useMemo<OutlineItem[]>(() => (kb ? parseOutline(body, kb.sections, fileOf) : []), [body, kb, fileOf])
  // BUG-14 修复：多源库的章边界除「一级标题」外，还要加入每个源内容的起点——
  // 无标题文字笔记没有标题行，正文会被并入前源的末章（file 标注仍是前源），该源没有归属章，
  // 顶部多源下拉 fileList.length===1 不渲染、「按源切换」失效。源起点由 sections 的 file 标注推导
  // （每源第一个 section 的 start），保证每个源至少一个独立章；有标题的源仍按标题切章、
  // outline index 原样保留（书签/想法存的 chapter 号不变）。单源库行为与原 splitChapters 完全一致。
  const chapters = useMemo((): ReaderChapter[] => {
    if (!kb || !body) return []
    const base = splitChapters(body, outline)
    if ((kb.sourcesText ?? []).length <= 1) return base
    // 源起点用与正文同一套聚合/清洗规则（aggregateSourceTexts + buildFileSpans）重算：
    // 此前想从 sections 的 file 标注推导「每源第一个 section」，但小库可能整库只有 1 个
    // section（起点 0、file=首源），推导不出后继源；buildFileSpans 的偏移与 body 拼接规则一致，恒可靠
    const files = aggregateSourceTexts(kb.sourcesText ?? [])
    const cleaned = files.map((f) => (detectFragmented(f.text, f.name) ? cleanText(f.text) : f.text))
    const spans = buildFileSpans(
      files.map((f) => f.name),
      cleaned,
    )
    if (files.length <= 1) return base
    // 防御：正文与源聚合不一致（旧库迁移残留等）时不强切，避免切出乱码章
    const maxEnd = spans[spans.length - 1]?.end ?? 0
    if (Math.abs(maxEnd - body.length) > 2) return base
    const srcStarts = spans.map((sp) => ({ file: sp.name, start: sp.start }))
    const tops = outline.filter((o) => o.level === 1)
    const bounds: { file?: string; start: number; title: string; index: number }[] = tops.map((t) => ({
      file: t.file,
      start: t.offset,
      title: t.title,
      index: t.index,
    }))
    let synthetic = 0
    for (const ss of srcStarts) {
      // 源起点与既有标题边界重合（该源自带开篇标题）则不重复切
      if (bounds.some((b) => Math.abs(b.start - ss.start) <= 1)) continue
      synthetic++
      bounds.push({ file: ss.file, start: ss.start, title: '', index: -synthetic })
    }
    bounds.sort((a, b) => a.start - b.start)
    const out: ReaderChapter[] = []
    for (let i = 0; i < bounds.length; i++) {
      const end = i + 1 < bounds.length ? bounds[i + 1].start : body.length
      const markdown = body.slice(bounds[i].start, end)
      // 与 splitChapters 同规则：只有标题没有正文的段剔除（避免空白首页）
      if (!hasBody(markdown)) continue
      out.push({ index: bounds[i].index, title: bounds[i].title, markdown, file: bounds[i].file })
    }
    return out.length ? out : base
  }, [kb, body, outline])

  // 多文件：文件列表（按正文出现顺序去重）与「当前只看哪个文件」（null = 全部）
  const fileList = useMemo(() => {
    const seen: string[] = []
    for (const c of chapters) if (c.file && !seen.includes(c.file)) seen.push(c.file)
    return seen
  }, [chapters])
  const [curFile, setCurFile] = useState<string | null>(null)
  /** 当前文件视角下的章列表（全部文件时 = 全部） */
  const viewChapters = useMemo(
    () => (curFile ? chapters.filter((c) => c.file === curFile) : chapters),
    [chapters, curFile],
  )
  /** 当前文件视角下的目录树（保持层级结构） */
  const viewOutline = useMemo(
    () => (curFile ? outline.filter((o) => o.file === curFile) : outline),
    [outline, curFile],
  )

  // 视图模式：重排（默认，Markdown 渲染）/ 原文（raw 层 pre-wrap 直显）
  const [viewMode, setViewMode] = useState<'reflow' | 'raw'>('reflow')
  // 原始排版文本：raw 层按文件聚合还原（多文件加文件名标注；无 sourcesText 旧库回退正文）。
  // 单文件视角时只聚合该文件的切片，避免切文件触发全库聚合（大库几百万字拼接开销）
  const rawText = useMemo(() => {
    if (!kb) return ''
    const all = kb.sourcesText ?? []
    if (all.length === 0) return body
    const pickedSrc = curFile ? all.filter((s) => s.file === curFile) : all
    if (pickedSrc.length === 0) return body
    const files = aggregateSourceTexts(pickedSrc)
    if (files.length === 0) return body
    return files.map((f) => `【${f.name}】\n${f.text}`).join('\n\n')
  }, [kb, body, curFile])
  /** 原文分页：整篇 raw 超长（大书可达数百万字），一次性渲染成单个文本节点会卡顿/滚动卡死，按 ~6000 字/页切分，逐页渲染 */
  const rawPages = useMemo(() => {
    if (!rawText) return []
    const out: string[] = []
    let from = 0
    while (from < rawText.length) {
      const rel = surrogateSafeEnd(rawText.slice(from), RAW_PAGE_CHARS)
      out.push(rawText.slice(from, from + rel))
      from += rel
    }
    return out
  }, [rawText])
  // 代码库：全部源文件为代码类扩展名 → 正文等宽显示
  const isCodeLib = !!kb && kb.sourceFiles.length > 0 && kb.sourceFiles.every((f) => CODE_EXTS.has(fileExt(f.name)))

  // 当前章（viewChapters 下标）
  const [idx, setIdx] = useState(0)
  // 切文件后索引钳制（新文件章节数可能更少）
  useEffect(() => {
    if (idx >= viewChapters.length) setIdx(0)
  }, [viewChapters.length, idx])
  // 原文模式当前页（rawPages 下标）
  const [rawIdx, setRawIdx] = useState(0)
  useEffect(() => {
    if (rawIdx >= rawPages.length) setRawIdx(0)
  }, [rawPages.length, rawIdx])
  // 翻页动画状态
  const [anim, setAnim] = useState<{ dir: 1 | -1 } | null>(null)
  // 底部工具条：默认收起，点击阅读区切换显隐
  const [toolbar, setToolbar] = useState(false)
  // 左侧抽屉（目录/书签/想法）
  const [left, setLeft] = useState(false)
  // 底部弹层（设置/更多）
  const [sheet, setSheet] = useState<'settings' | 'more' | null>(null)
  const [noteSel, setNoteSel] = useState<{ quote: string; x: number; y: number } | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteInput, setNoteInput] = useState('')
  const [bmNote, setBmNote] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  // 「上下」连续滚动：命令式跳转/取容器句柄
  const vertRef = useRef<VerticalHandle>(null)
  /** 是否为「上下」动画的重排连续滚动（区别于 cover/horizontal 的一章一屏分页） */
  const vertContinuous = viewMode === 'reflow' && settings.animation === 'vertical'
  const touchX = useRef<number | null>(null)
  const touchY = useRef<number | null>(null)
  // 记录本次触摸是否发生滑动（滑动翻页后不再把该次点击当作「切换工具条」）
  const slid = useRef(false)

  // 数据未加载时主动加载一次，避免进入即误判「知识库不存在」
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded])

  // 非本库内容：回退
  // 阅读器返回目标：从知识库详情页打开（detailId 未清除）则回到详情页，否则回知识库首页
  const backTarget = useKB.getState().detailId === readerId ? ('kb-detail' as PageId) : ('kb' as PageId)

  useEffect(() => {
    if (readerId && bases.length > 0 && !kb) {
      closeReader()
      navigate('kb')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerId, bases.length])

  const close = () => {
    closeReader()
    navigate(backTarget, backTarget === 'kb-detail')
  }

  const ANIM_MS = 320
  const go = (dir: 1 | -1) => {
    // 原文模式：rawPages 分页直接切换（无动画，避免超长文渲染卡顿）
    if (viewMode === 'raw') {
      const next = rawIdx + dir
      if (next < 0 || next >= rawPages.length) return
      setRawIdx(next)
      return
    }
    if (viewMode !== 'reflow') return
    const next = idx + dir
    if (next < 0 || next >= viewChapters.length || anim) return
    setAnim({ dir })
    window.setTimeout(() => {
      setIdx(next)
      setAnim(null)
    }, ANIM_MS)
  }
  /** 跳转到某 outline 标题对应的章（原文模式下自动切回重排）。
   *  RC-06：非章边界标题（二级目录项/被剔除的标题行）按所在章或下一章解析，不再静默不跳 */
  const jumpTo = (outlineIndex: number) => {
    setViewMode('reflow')
    const target = resolveTocTarget(viewOutline, viewChapters, outlineIndex)
    if (target < 0 || target === idx) {
      setLeft(false)
      setSheet(null)
      return
    }
    // 连续滚动模式：让垂直流自己量高度并滚动到目标章首
    if (vertContinuous) {
      vertRef.current?.scrollToChapter(target)
      setLeft(false)
      setSheet(null)
      return
    }
    setAnim({ dir: target > idx ? 1 : -1 })
    window.setTimeout(() => {
      setIdx(target)
      setAnim(null)
      setLeft(false)
      setSheet(null)
    }, ANIM_MS)
  }

  // 夜间判断：独立开关或跟随系统深色
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isNight = settings.night || (settings.followSystem && sysDark)
  const effBrightness = settings.followSystem ? 100 : settings.brightness
  const bgClass = isNight ? 'bg-night' : `bg-${settings.bg}`

  // 当前页 HTML（标题带锚点 id，供目录定位）。
  // BUG-12 修复：想法高亮直接做进渲染 HTML（字符串层替换首个纯文本命中）——
  // 此前只靠渲染后的 DOM 后处理（markQuote effect），读者页在某些重渲染路径下 .rdr-page
  // 被整体重建，DOM 级 <mark> 随之丢失（表现为「保存后高亮不出现，翻章往返才渲染」）。
  // 字符串层标记随渲染走，重挂/切章都天然保留；跨节点选区（quote 被行内标签切开）仍由
  // 下方 DOM 级 markQuote 兜底。notes 依赖：想法增删后本页 HTML 即时带上/去掉高亮
  const chapterNotes = (notes[kb?.id ?? ''] ?? []).filter((n) => n.chapter === (viewChapters[idx]?.index ?? idx))
  const pageHtml = viewChapters[idx]
    ? highlightQuotesInHtml(
        renderMarkdown(viewChapters[idx].markdown, { headingId: (i) => `h-${i}` }),
        chapterNotes.map((n) => n.quote),
      )
    : ''
  // 文件横幅：当前章与上一章不同文件（或首章）时显示「📄 文件名」，多文件切换处一眼可见来源
  const fileBanner = (() => {
    const cur = viewChapters[idx]
    if (!cur?.file) return null
    if (idx === 0 || viewChapters[idx - 1]?.file !== cur.file) return cur.file
    return null
  })()

  // 想法正文高亮：渲染完成后为本章的想法 quote 加 <mark>（原文模式无章节模型，跳过）。
  // BUG-12 兜底层：pageHtml 字符串层标记（主路径，见 highlightQuotesInHtml）只覆盖
  // 「整段纯文本命中」的 quote；跨行内节点选区（quote 被 mark/行内标签切开）由本 DOM 级
  // 归一化匹配补挂。清理→重挂保证幂等（重复保存同一 quote 不会嵌套 <mark>）。
  useEffect(() => {
    const el = vertContinuous ? (vertRef.current?.getContentEl() ?? null) : contentRef.current
    if (!el || viewMode !== 'reflow') return
    // 清理旧高亮（含字符串层标记），再统一按归一化+跨节点规则重挂
    el.querySelectorAll('mark.rdr-mark').forEach((m) => {
      const t = document.createTextNode(m.textContent ?? '')
      m.replaceWith(t)
    })
    const mine = (notes[kb?.id ?? ''] ?? []).filter((n) => n.chapter === (viewChapters[idx]?.index ?? idx))
    for (const n of mine) markQuote(el, n.quote)
  }, [idx, anim, notes, kb?.id, chapters, pageHtml, viewMode, vertContinuous])

  // 选中文本 → 显示「添加想法」浮动按钮（仅重排模式；原文模式章节模型不同，禁用批注）
  const handleSelect = () => {
    if (noteOpen || viewMode !== 'reflow') return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      setNoteSel(null)
      return
    }
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) {
      setNoteSel(null)
      return
    }
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      setNoteSel(null)
      return
    }
    const stage = document.querySelector('.rdr-stage')
    const sr = stage?.getBoundingClientRect()
    setNoteSel({
      quote: text.slice(0, 120),
      x: rect.left + rect.width / 2 - (sr?.left ?? 0),
      y: rect.top - (sr?.top ?? 0),
    })
  }

  const saveNote = () => {
    if (!noteSel || !noteInput.trim()) return
    addNote({ kbId: kb!.id, chapter: viewChapters[idx]?.index ?? idx, quote: noteSel.quote, note: noteInput.trim() })
    setNoteOpen(false)
    setNoteSel(null)
    setNoteInput('')
    showToast('已添加想法')
  }

  const addBm = () => {
    if (!kb) return
    addBookmark({ kbId: kb.id, chapter: viewChapters[idx]?.index ?? idx, chapterTitle: viewChapters[idx]?.title || kb.name, note: bmNote ? '「' + (viewChapters[idx]?.title || kb.name) + '」' : undefined })
    setBmNote(false)
    showToast('已添加书签')
  }

  const exportMd = async () => {
    if (!kb) return
    try {
      const r = await exportTextFile(`${sanitizeFileName(kb.name)}.md`, body, 'text/markdown;charset=utf-8')
      // 6.85：原生端已落 Documents/ai学/ 副本（或如实报错），Web 端浏览器下载已开始才提示成功
      showToast(exportResultToast(r, '已导出资料'))
    } catch (e) {
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 「更多」里重新整理资料：本地重跑清洗分块（零 token、内容不变）。先确认防误点；
   *  确认后不关闭阅读器，整理完成经下方 useEffect 监听 kb.status 变化 toast 结果 */
  const reConsolidate = () => {
    if (!kb) return
    modal.confirm('重新整理资料', '将重新清洗分块（内容不变），通常无需执行；仅在数据异常时使用。确定继续？', () => {
      setSheet(null)
      resume(kb.id)
        .then(() => showToast('正在重新整理…'))
        .catch((e) => showToast(e instanceof Error ? e.message : '重新整理失败'))
    })
  }

  /** 「更多」里切换原文/重排视图（顶部已去掉直观的视图切换；原文是高级选项，进更多里切）。
   *  切换后保持面板打开：按钮就地变为「切换到重排/原文视图」，用户可直接点回，避免面板消失找不到入口 */
  const toggleRaw = () => {
    setViewMode((v) => (v === 'raw' ? 'reflow' : 'raw'))
  }

  // 无内容空态：区分加载中 / 库不存在 / 可读内容为空
  if (!loaded) {
    return (
      <div className="rdr-root rdr-empty">
        <div className="card-sub">加载中…</div>
      </div>
    )
  }
  if (!kb) {
    return (
      <div className="rdr-root rdr-empty">
        <div className="card-sub">知识库不存在或已删除</div>
        <button className="btn mt-12" onClick={close}>返回知识库</button>
      </div>
    )
  }
  if (!body.trim()) {
    return (
      <div className="rdr-root rdr-empty">
        <div className="card-sub">该资料库暂无可阅读内容，请先完成整理</div>
        <button className="btn mt-12" onClick={close}>返回知识库</button>
      </div>
    )
  }

  return (
    <div className={'rdr-root ' + bgClass}>
      {/* 顶部栏 */}
      <div className="rdr-top">
        <button className="back-btn" onClick={close} aria-label="返回">‹</button>
        <div className="rdr-top-title">{kb.name}</div>
        {/* V8-KB 多文件书籍选择器：下拉，放原「原始排版/页码」说明位；完整显示文件名不截断。视图切换（重排/原文）已移到「更多」 */}
        <span className="rdr-top-pos">
          {fileList.length > 1 && (
            <select
              className="rdr-file-select"
              value={curFile ?? ''}
              onChange={(e) => { setCurFile(e.target.value || null); setIdx(0); setRawIdx(0) }}
              aria-label="选择文件"
            >
              <option value="">全部文件</option>
              {fileList.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          )}
          {viewMode === 'raw'
            ? (rawPages.length > 1 ? `${rawIdx + 1}/${rawPages.length}` : (fileList.length > 1 ? '' : '原始排版'))
            : viewChapters.length ? `${idx + 1}/${viewChapters.length}` : ''}
        </span>
      </div>

      {/* 阅读舞台（分页 + 动画 + 亮度遮罩） */}
      <div
        className={'rdr-stage anim-' + settings.animation}
        onClick={() => {
          // 横向滑动翻页完成后忽略该次 click，避免误切换工具条
          if (slid.current) {
            slid.current = false
            return
          }
          setToolbar((v) => !v)
        }}
        onTouchStart={(e) => {
          touchX.current = e.touches[0]?.clientX ?? null
          touchY.current = e.touches[0]?.clientY ?? null
        }}
        onTouchMove={(e) => {
          if (touchX.current === null || touchY.current === null) return
          const dx = (e.touches[0]?.clientX ?? touchX.current) - touchX.current
          const dy = (e.touches[0]?.clientY ?? touchY.current) - touchY.current
          if (Math.abs(dx) > 18 || Math.abs(dy) > 18) slid.current = true
        }}
        onTouchEnd={(e) => {
          // 连续滚动模式：不做手势翻章，交给浏览器原生纵向滚动（原文分页/重排分页都走手势翻页）
          if (vertContinuous) {
            touchX.current = null
            touchY.current = null
            return
          }
          if (touchX.current === null || touchY.current === null) return
          const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current
          const dy = (e.changedTouches[0]?.clientY ?? touchY.current) - touchY.current
          touchX.current = null
          touchY.current = null
          // 非连续滚动下的手势翻章：横向滑动 → 上一章/下一页（连续滚动已在上方 return，纵向交给原生滚动）
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
        }}
        // 不监听 onWheel：覆盖/平移分页模式滚轮只在章内滚动（翻章靠左右滑/点边缘热区），
        // vertical 连续滚动由浏览器原生滚动自然进入下一章——滚到页底触发翻章是错误逻辑（用户反馈）
      >
        {viewMode === 'raw' ? (
          <div
            className={'rdr-page rdr-raw' + (isCodeLib ? ' rdr-mono' : '')}
            ref={contentRef}
            style={{ fontSize: settings.fontSize }}
          >
            {rawPages[rawIdx] ?? ''}
          </div>
        ) : vertContinuous ? (
          <VerticalFlow
            ref={vertRef}
            chapters={viewChapters}
            fontSize={settings.fontSize}
            isCodeLib={isCodeLib}
            onMouseUp={handleSelect}
            onCurrentChange={setIdx}
          />
        ) : anim ? (
          <>
            <div
              className={'rdr-page rdr-page-old' + (isCodeLib ? ' rdr-mono' : '')}
              style={{ fontSize: settings.fontSize }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(viewChapters[idx].markdown, { headingId: (i) => `h-${i}` }) }}
            />
            <div
              className={'rdr-page rdr-page-next' + (isCodeLib ? ' rdr-mono' : '')}
              style={{ fontSize: settings.fontSize }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(viewChapters[idx + anim.dir].markdown, { headingId: (i) => `h-${i}` }) }}
            />
          </>
        ) : (
          <div
            className={'rdr-page' + (isCodeLib ? ' rdr-mono' : '')}
            ref={contentRef}
            style={{ fontSize: settings.fontSize }}
            onMouseUp={handleSelect}
          >
            {fileBanner && <div className="rdr-file-banner">📄 {fileBanner}</div>}
            <div dangerouslySetInnerHTML={{ __html: pageHtml }} />
          </div>
        )}

        {/* 翻页热区（桌面/慢速点击；连续滚动是整页滚动，无翻页）——重排分页与原文分页共用 */}
        {((viewMode === 'reflow' && viewChapters.length > 1) || (viewMode === 'raw' && rawPages.length > 1)) && !vertContinuous && (
          <>
            <button className="rdr-edge rdr-edge-l" onClick={(e) => { e.stopPropagation(); go(-1) }} aria-label="上一章" tabIndex={-1} />
            <button className="rdr-edge rdr-edge-r" onClick={(e) => { e.stopPropagation(); go(1) }} aria-label="下一章" tabIndex={-1} />
          </>
        )}

        {/* 亮度遮罩（夜间不叠加） */}
        {!isNight && <div className="rdr-dim" style={{ opacity: ((100 - effBrightness) / 100) * 0.55 }} />}

        {/* 选中文本浮动「添加想法」 */}
        {noteSel && !noteOpen && (
          <button
            className="rdr-addnote"
            style={{ left: Math.min(Math.max(noteSel.x - 44, 12), 9999), top: Math.max(noteSel.y - 46, 8) }}
            onClick={() => {
              setNoteOpen(true)
              setNoteInput('')
            }}
          >
            ＋ 添加想法
          </button>
        )}
      </div>

      {/* 章进度条（重排章节 / 原文分页；单页不显示） */}
      {viewMode === 'reflow' && viewChapters.length > 1 && (
        <div className="rdr-progress">
          <i style={{ width: `${((idx + 1) / viewChapters.length) * 100}%` }} />
        </div>
      )}
      {viewMode === 'raw' && rawPages.length > 1 && (
        <div className="rdr-progress">
          <i style={{ width: `${((rawIdx + 1) / rawPages.length) * 100}%` }} />
        </div>
      )}

      {/* 底部工具条：目录 / 夜间 / 设置 / 更多（默认收起，点击阅读区切换显隐，带 slide-up + fade 过渡；字号在「设置」sheet 里） */}
      <div className={'rdr-toolbar' + (toolbar ? ' show' : '')}>
        <button className={left ? 'on' : ''} onClick={() => { setLeft((v) => !v); setSheet(null) }}>
          <AppIcon name="library" size={19} />目录
        </button>
        <button className={isNight ? 'on' : ''} onClick={() => setSettings({ night: !settings.night })}>
          <MoonIcon />夜间
        </button>
        <button className={sheet === 'settings' ? 'on' : ''} onClick={() => { setSheet(sheet === 'settings' ? null : 'settings'); setLeft(false) }}>
          <GearIcon />设置
        </button>
        <button className={sheet === 'more' ? 'on' : ''} onClick={() => { setSheet(sheet === 'more' ? null : 'more'); setLeft(false) }}>
          <AppIcon name="more" size={19} />更多
        </button>
      </div>

      {/* 左侧抽屉：目录 / 书签 / 想法 */}
      {left && (
        <div className="rdr-mask rdr-mask-left" onClick={() => setLeft(false)}>
          <div className="rdr-drawer" onClick={(e) => e.stopPropagation()}>
            <TocSheet
              outline={viewOutline}
              bookmarks={bookmarks[kb.id] ?? []}
              notes={notes[kb.id] ?? []}
              current={viewChapters[idx]?.index ?? idx}
              onJump={jumpTo}
              onAddBm={addBm}
              onRemoveBm={(id) => removeBookmark(kb.id, id)}
              onRemoveNote={(id) => removeNote(kb.id, id)}
              onClose={() => setLeft(false)}
            />
          </div>
        </div>
      )}

      {/* 底部面板（bottom sheet） */}
      {sheet && (
        <div className="rdr-mask" onClick={() => setSheet(null)}>
          <div className="rdr-sheet" onClick={(e) => e.stopPropagation()}>
            {sheet === 'settings' && (
              <SettingsSheet
                settings={settings}
                setSettings={setSettings}
                disabled={isNight}
              />
            )}
            {sheet === 'more' && (
              <div className="rdr-sheet-body">
                <div className="rdr-sheet-title">更多</div>
                <button className="rdr-more-item" onClick={() => { setSheet(null); jumpTo(viewChapters[0]?.index ?? 0) }}>
                  <AppIcon name="book" size={18} /> 回到顶部
                </button>
                <button className="rdr-more-item" onClick={toggleRaw}>
                  <AppIcon name={viewMode === 'raw' ? 'book' : 'file'} size={18} />
                  {viewMode === 'raw' ? ' 切换到重排视图' : ' 切换到原文视图'}
                </button>
                <button className="rdr-more-item" onClick={() => { setSheet(null); exportMd() }}>
                  <AppIcon name="download" size={18} /> 导出资料（Markdown）
                </button>
                <button className="rdr-more-item" onClick={() => { setSheet(null); void reConsolidate() }}>
                  <AppIcon name="database" size={18} /> 重新整理资料
                </button>
                <div className="rdr-sheet-foot">
                  <button className="btn ghost flex-1" onClick={() => setSheet(null)}>关闭</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 添加想法输入层 */}
      {noteOpen && noteSel && (
        <div className="rdr-mask rdr-note-mask" onClick={() => setNoteOpen(false)}>
          <div className="rdr-note-card" onClick={(e) => e.stopPropagation()}>
            <div className="rdr-sheet-title">添加想法</div>
            <div className="rdr-note-quote">“{noteSel.quote}”</div>
            <textarea
              className="input"
              autoFocus
              rows={3}
              placeholder="写下你的想法或批注…"
              value={noteInput}
              maxLength={300}
              onChange={(e) => setNoteInput(e.target.value)}
            />
            <div className="row mt-12">
              <button className="btn ghost flex-1" onClick={() => setNoteOpen(false)}>取消</button>
              <button className="btn flex-1" disabled={!noteInput.trim()} onClick={saveNote}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 目录 / 书签 / 想法 面板（左侧抽屉内容） */
function TocSheet(props: {
  outline: OutlineItem[]
  bookmarks: { id: string; chapter: number; chapterTitle: string; note?: string }[]
  notes: { id: string; chapter: number; quote: string; note: string }[]
  current: number
  onJump: (outlineIndex: number) => void
  onAddBm: () => void
  onRemoveBm: (id: string) => void
  onRemoveNote: (id: string) => void
  onClose: () => void
}) {
  const { outline, bookmarks, notes, current, onJump, onAddBm, onRemoveBm, onRemoveNote, onClose } = props
  const [tab, setTab] = useState<'toc' | 'bookmarks' | 'notes'>('toc')

  return (
    <div className="rdr-sheet-body">
      <div className="rdr-sheet-tabs">
        <button className={tab === 'toc' ? 'on' : ''} onClick={() => setTab('toc')}>目录</button>
        <button className={tab === 'bookmarks' ? 'on' : ''} onClick={() => setTab('bookmarks')}>书签{bookmarks.length > 0 ? ` ${bookmarks.length}` : ''}</button>
        <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>想法{notes.length > 0 ? ` ${notes.length}` : ''}</button>
      </div>

      {tab === 'toc' && (
        outline.length === 0 ? (
          <div className="rdr-sheet-empty">该知识库没有可用的标题结构</div>
        ) : (
          <VirtToc outline={outline} current={current} onJump={onJump} />
        )
      )}

      {tab === 'bookmarks' && (
        <div className="rdr-list">
          <button className="rdr-addrow" onClick={onAddBm}><AppIcon name="plus" size={16} /> 添加当前页书签</button>
          {bookmarks.length === 0 ? (
            <div className="rdr-sheet-empty">还没有书签，点上方按钮添加</div>
          ) : (
            bookmarks.map((b) => (
              <div key={b.id} className="rdr-row">
                <button className="rdr-row-main" onClick={() => onJump(b.chapter)}>
                  <span className="rdr-row-title">{b.chapterTitle}</span>
                  {b.note && <span className="rdr-row-sub">{b.note}</span>}
                </button>
                <button className="rdr-row-del" onClick={() => onRemoveBm(b.id)} aria-label="删除书签">×</button>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="rdr-list">
          {notes.length === 0 ? (
            <div className="rdr-sheet-empty">阅读时选中文字即可添加想法批注</div>
          ) : (
            notes.map((n) => (
              <div key={n.id} className="rdr-row">
                <button className="rdr-row-main" onClick={() => onJump(n.chapter)}>
                  <span className="rdr-row-quote">“{n.quote}”</span>
                  <span className="rdr-row-sub">{n.note}</span>
                </button>
                <button className="rdr-row-del" onClick={() => onRemoveNote(n.id)} aria-label="删除想法">×</button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="rdr-sheet-foot">
        <button className="btn ghost flex-1" onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}

/** 虚拟化目录：只渲染可视窗口内的一小簇行 + 上下占位，保证上千章节也能瞬间打开、流畅滚动 */
function VirtToc({ outline, current, onJump }: { outline: OutlineItem[]; current: number; onJump: (idx: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState(() => ({ start: 0, end: Math.min(outline.length, 40) }))

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = () => {
      const sh = el.scrollTop
      const hh = el.clientHeight || 0
      const start = Math.max(0, Math.floor(sh / TOC_ITEM_H) - 8)
      const end = Math.min(outline.length, Math.ceil((sh + hh) / TOC_ITEM_H) + 8)
      setWin(start === win.start && end === win.end ? win : { start, end })
    }
    apply()
    const onScroll = () => apply()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    // 打开时把当前阅读章节滚入可视区
    if (current >= 0) el.scrollTop = Math.max(0, current * TOC_ITEM_H - (el.clientHeight || 240) / 2)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline.length])

  const rows: ReactNode[] = []
  for (let i = win.start; i < win.end; i++) {
    const o = outline[i]
    // RC-06：标红按 index 匹配当前章，不限定一级——降级切章后当前章是二级标题也要高亮
    rows.push(
      <button
        key={o.index}
        className={'rdr-toc-item rdr-toc-win-item lv-' + o.level + (o.index === current ? ' on' : '')}
        style={{ height: TOC_ITEM_H }}
        onClick={() => onJump(o.index)}
      >
        <span className="rdr-toc-dot" />
        <span className="rdr-toc-txt">{o.title}</span>
      </button>,
    )
  }
  return (
    <div ref={ref} className="rdr-toc rdr-toc-win">
      <div aria-hidden style={{ height: win.start * TOC_ITEM_H }} />
      {rows}
      <div aria-hidden style={{ height: Math.max(0, outline.length - win.end) * TOC_ITEM_H }} />
    </div>
  )
}

/** 设置面板：亮度 / 跟随系统 / 字号 / 背景色 / 翻页动画 */
function SettingsSheet(props: {
  settings: ReaderSettings
  setSettings: (patch: Partial<ReaderSettings>) => void
  disabled: boolean
}) {
  const { settings, setSettings, disabled } = props

  return (
    <div className="rdr-sheet-body">
      <div className="rdr-sheet-title">阅读设置</div>

      <div className="rdr-set-row">
        <span className="rdr-set-label">亮度</span>
        <input
          type="range"
          className="rdr-range"
          min={30}
          max={100}
          step={5}
          value={settings.brightness}
          disabled={settings.followSystem}
          onChange={(e) => setSettings({ brightness: Number(e.target.value) })}
        />
        <span className="rdr-set-val">{settings.followSystem ? '自动' : `${settings.brightness}%`}</span>
      </div>
      <label className="rdr-check">
        <input
          type="checkbox"
          checked={settings.followSystem}
          onChange={(e) => setSettings({ followSystem: e.target.checked })}
        />
        亮度跟随系统（系统深色时自动夜间）
      </label>

      <div className="rdr-set-row">
        <span className="rdr-set-label">字号</span>
        <div className="rdr-seg">
          {FONT_SIZES.map((s) => (
            <button
              key={s}
              className={settings.fontSize === s ? 'on' : ''}
              onClick={() => setSettings({ fontSize: s })}
            >
              {FONT_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="rdr-set-row">
        <span className="rdr-set-label">背景</span>
        <div className={'rdr-bgs' + (disabled ? ' off' : '')}>
          {BGS.map((b) => (
            <button
              key={b.id}
              title={b.label}
              className={'rdr-swatch sw-' + b.id + (settings.bg === b.id ? ' on' : '')}
              disabled={disabled}
              onClick={() => setSettings({ bg: b.id })}
            >
              {settings.bg === b.id && <AppIcon name="check" size={14} />}
            </button>
          ))}
        </div>
      </div>

      <div className="rdr-set-row">
        <span className="rdr-set-label">翻页动画</span>
        <div className="rdr-seg">
          {ANIMS.map((a) => (
            <button
              key={a.id}
              className={settings.animation === a.id ? 'on' : ''}
              onClick={() => setSettings({ animation: a.id })}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rdr-sheet-foot">
        <button className="btn ghost flex-1" onClick={() => useReader.getState().setSettings({ night: false, brightness: 100, followSystem: false, bg: 'paper', fontSize: 16, animation: 'cover' })}>
          恢复默认
        </button>
      </div>
    </div>
  )
}

/**
 * BUG-12：把本章想法 quote 直接标记进渲染 HTML（字符串层，随渲染走、重挂免疫）。
 * 只替换「>quote<」形态的首个纯文本命中（避免误伤标签与属性）；quote 含折叠空白或
 * HTML 转义差异时静默跳过，交由 DOM 级 markQuote 兜底处理。
 */
function highlightQuotesInHtml(html: string, quotes: string[]): string {
  let out = html
  for (const raw of quotes) {
    const target = raw.replace(/\s+/g, ' ').trim()
    if (target.length < 2) continue
    const needle = '>' + target + '<'
    const idx = out.indexOf(needle)
    if (idx === -1) continue
    out =
      out.slice(0, idx + 1) +
      '<mark class="rdr-mark">' + target + '</mark>' +
      out.slice(idx + needle.length)
  }
  return out
}

/**
 * 想法正文高亮匹配（BUG-12/13 修复重写）：
 * ① 归一化比较——存档 quote 是「空白折叠后的选区文本」（handleSelect 用 replace(/\s+/g,' ') 规整），
 *    而正文文本节点里可能含换行/连续空白，旧实现用原始 indexOf 会漏配（高亮不出现，翻章后才偶然命中）；
 * ② 跨文本节点支持——跨块选区（含标题/跨 BR/跨段落）的 quote 不在任何单个文本节点里，
 *    旧实现「单节点 indexOf」永不命中且静默失败。现把容器内全部文本节点拼成归一化全文 + 逐字符
 *    映射回 (节点, 偏移)，命中后按节点分组，把每段命中区间分别包上 <mark.rdr-mark>。
 */
function markQuote(el: HTMLElement, quote: string): boolean {
  const target = quote.replace(/\s+/g, ' ').trim()
  if (!target) return false
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const texts: string[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    // 跳过已包裹在高亮里的文本，防重复嵌套
    if ((node.parentElement as HTMLElement | null)?.closest('mark.rdr-mark')) continue
    const t = node.textContent ?? ''
    if (!t) continue
    nodes.push(node as Text)
    texts.push(t)
  }
  if (!nodes.length) return false
  // 归一化全文（空白折叠为单空格，节点边界也补空格，与选区文本折叠行为一致）+ 逐字符映射
  let full = ''
  const map: { node: Text; start: number; end: number }[] = []
  for (let i = 0; i < nodes.length; i++) {
    const raw = texts[i]
    for (let j = 0; j < raw.length; j++) {
      if (/\s/.test(raw[j])) {
        if (full.length > 0 && full[full.length - 1] !== ' ') {
          full += ' '
          map.push({ node: nodes[i], start: j, end: j + 1 })
        }
        continue
      }
      full += raw[j]
      map.push({ node: nodes[i], start: j, end: j + 1 })
    }
    if (i < nodes.length - 1 && full.length > 0 && full[full.length - 1] !== ' ') {
      full += ' '
      // 节点边界空格：映射到零长区间（无原文可包裹，命中区间计算时跳过）
      map.push({ node: nodes[i], start: raw.length, end: raw.length })
    }
  }
  const pos = full.indexOf(target)
  if (pos === -1) return false
  // 命中区间映射回各文本节点的原始区间（同节点相邻段合并）
  const ranges: { node: Text; start: number; end: number }[] = []
  for (let i = pos; i < pos + target.length; i++) {
    const m = map[i]
    if (!m || m.end <= m.start) continue
    const last = ranges[ranges.length - 1]
    if (last && last.node === m.node && last.end === m.start) last.end = m.end
    else ranges.push({ node: m.node, start: m.start, end: m.end })
  }
  if (!ranges.length) return false
  let ok = false
  for (const r of ranges) {
    try {
      const range = document.createRange()
      range.setStart(r.node, r.start)
      range.setEnd(r.node, r.end)
      const mark = document.createElement('mark')
      mark.className = 'rdr-mark'
      range.surroundContents(mark)
      ok = true
    } catch {
      // 单段包裹失败（节点被并发操作改动）不阻断其余段
    }
  }
  return ok
}
