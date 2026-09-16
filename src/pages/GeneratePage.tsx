import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useGenerate } from '../stores/useGenerateStore'
import type { GenPackRecord } from '../stores/useGenerateStore'
import { useUI } from '../stores/useUIStore'
import { useAI, resolveActiveId, isProviderReady } from '../stores/useAIStore'
import { usePacks } from '../stores/usePackStore'
import { useModal } from '../stores/useModalStore'
import { QUESTION_TYPES, MAX_QUESTIONS_PER_GENERATION, MAX_PER_TYPE } from '../types'
import type { Message, Pack, QuestionTypeId, RejectStats, ChatAction, KBDoc } from '../types'
import { validateQuestion } from '../services/validation'
import { filterValidQuestions } from '../services/generation/resultStats'
import { pickCount } from '../services/generation/intentRules'
import { GenerationDraftCard } from '../components/GenerationDraftCard'
import { renderMarkdown } from '../utils/markdown'
import { stripUntrustedMarkers } from '../services/generation/context'
import { canEditMessage, copyMessageText, getMessageCopyText } from '../services/generation/messageActions'
import { pickFiles } from '../utils'
import { parseFileToText, MAX_FILE_BYTES, SUPPORTED_ACCEPT } from '../services/files/parse'
import { buildFilesRef, toChips, seedParsed, mapWithConcurrency, totalBytesOf, MAX_FILE_COUNT, MAX_TOTAL_BYTES, type FileChip } from '../services/files/pool'
import { useKB } from '../stores/useKBStore'
import { buildMultiKbRef, warmVectorCache } from '../services/kb/ref'
import { planVolumes } from '../services/kb/scope'
import type { KbScope, KBVolume } from '../types'
import { useKeepAwake } from '../utils/keepAwake'
import { closeQuickDialogState } from '../services/generation/quickDialog'
import { normalizeCountDraft } from '../services/generation/countInput'

function typeName(id: QuestionTypeId): string {
  return QUESTION_TYPES.find((t) => t.id === id)?.name ?? id
}

/** V2-P05：长会话渲染窗口大小（条），超出部分折叠为「加载更早」按需分页加载 */
const MESSAGE_WINDOW = 200

/** 毫秒 → 人类可读耗时（实时用 0.1s 精度，>=1 分钟用 分秒） */
function fmtElapsed(ms: number): string {
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

/** 可编辑题型数量：支持直接输入，回车/失焦提交，Esc 取消 */
function EditableCount({
  value,
  disabled,
  onChange,
  label,
}: {
  value: number
  disabled?: boolean
  onChange: (n: number) => void
  label: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    const n = Number(draft)
    setDraft(null)
    if (!Number.isFinite(n)) return
    onChange(n)
  }
  return (
    <input
      className={'st-val' + (value === 0 ? ' zero' : '')}
      type="text"
      inputMode="numeric"
      aria-label={`${label}数量`}
      value={draft ?? value}
      disabled={disabled}
       onChange={(e) => setDraft(normalizeCountDraft(e.target.value))}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

export default function GeneratePage() {
  const store = useGenerate()
  const ai = useAI()
  const ui = useUI()
  const modal = useModal()
  const [input, setInput] = useState('')
  /** V2-P05：长会话窗口化——当前渲染最近 messages 条数，超出部分折叠为「加载更早」按钮 */
  const [visibleMessages, setVisibleMessages] = useState(MESSAGE_WINDOW)
  /** 已导入的文件 chips（选中仅挂引用，发送时才解析成参考资料块 refs） */
  const [chips, setChips] = useState<FileChip[]>([])
  /** 输入框左侧「+」工具栏菜单是否展开：内含「上传附件 / 引用知识库」两项（对齐 Cherry Studio 的 ComposerToolMenu） */
  const [toolOpen, setToolOpen] = useState(false)
  /** 菜单纯贴输入框上方展开，不用整屏遮罩拦截点击；改为点击菜单／附件钮之外处自动收起 */
  useEffect(() => {
    if (!toolOpen) return
    const onDown = (e: Event) => {
      const t = e.target as Node
      const insideMenu = toolMenuRef.current?.contains(t)
      const insideAttach = attachRef.current?.contains(t)
      if (!insideMenu && !insideAttach) setToolOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setToolOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolOpen])
  /** 知识库引用：当前选中的就绪库 id 集合（发送时合成知识库引用块 refs），弹窗选择器开关 */
  const kbBases = useKB((s) => s.bases)
  const kbPendingRefIds = useKB((s) => s.pendingRefIds)
  const [kbRefIds, setKbRefIds] = useState<string[]>([])
  const [kbPickOpen, setKbPickOpen] = useState(false)
  /** 范围选择（Phase 3）：每库已勾选的 sectionIds（空=全部内容）；发送时逐库切卷拼成统一卷序列 */
  const [scopes, setScopes] = useState<Record<string, string[]>>({})
  /** 当前打开范围选择二级弹层的库（null=关闭） */
  const [scopeKbId, setScopeKbId] = useState<string | null>(null)
  /** 生成弹窗状态：content=输入框预填内容（对话确认态为模型总结，否则留空），count=预填总题数（>0 时按 AI 推荐种子），msgId=来源确认消息（生成成功后清除其按钮） */
  const [quickDlg, setQuickDlg] = useState<{ content: string; count: number; msgId?: string } | null>(null)
  const [quickContent, setQuickContent] = useState('')
  /** 生成弹窗内容输入框：随内容自适应高度（max-height 由 CSS 限制，不超过下方题型结构区） */
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 主输入框：起始一条线，随内容自动增高（CSS max-height 封顶后内滚） */
  const mainInputRef = useRef<HTMLTextAreaElement>(null)
  const attachRef = useRef<HTMLButtonElement>(null)
  const toolMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = mainInputRef.current
    if (!el) return
    el.style.height = 'auto'
    // 至少 3px 底内边距，保证光标不会贴近下边缘
    el.style.height = Math.max(el.scrollHeight, 22) + 'px'
  }, [input])
  const flowRef = useRef<HTMLDivElement>(null)
  // 滚动跟随状态机（对齐 Cherry Studio following/reading）：
  // followRef=true 表示贴底/紧跟新内容；用户上翻时置 false 停止打扰，滚回底部重新跟随。
  const followRef = useRef(true)
  // 已渲染的「消息流整体」数量（当前会话消息 + 历史会话数）：仅当整体高度增长（新消息/历史并入）时
  // 强制贴底并「立即跳转」到最后对话，保证进入页面/发送内容即时可见。
  const lastFlowCountRef = useRef(0)
  const [now, setNow] = useState(0)
  // 「学习本生成历史」弹窗
  const [histOpen, setHistOpen] = useState(false)
  const [records, setRecords] = useState<GenPackRecord[]>([])
  const [selPackId, setSelPackId] = useState<string | null>(null)
  // 顶部 ⋮ 更多菜单（学习本生成历史 / 清空历史）
  const [moreOpen, setMoreOpen] = useState(false)

  const closeQuickDlg = useCallback(() => {
    const closed = closeQuickDialogState(quickDlg)
    setQuickDlg(closed.quickDlg)
    setQuickContent(closed.quickContent)
  }, [quickDlg])

  // 生成弹窗内容框自适应高度：随内容增长，CSS max-height 兜底封顶
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [quickContent, quickDlg?.content])

  // 历史同步（W4b）：若「打开弹窗的那条消息」因清空历史/删除被移除，弹窗随之关闭，
  // 避免引用一个已不存在的 msgId 造成确认后 dismissActions 无对象可撤（残留按钮高亮）。
  useEffect(() => {
    if (!quickDlg?.msgId) return
    const all = [store.session, ...store.sessionList]
    const exists = all.some((s) => s?.messages.some((m) => m.id === quickDlg.msgId))
    if (!exists) closeQuickDlg()
  }, [store.session, store.sessionList, quickDlg?.msgId, closeQuickDlg])

  // 生成/校验期间实时刷新计时
  useEffect(() => {
    if (store.phase === 'generating' || store.phase === 'validating') {
      setNow(Date.now())
      const t = setInterval(() => setNow(Date.now()), 200)
      return () => clearInterval(t)
    }
  }, [store.phase])

  // 长任务期间保持亮屏唤醒，避免熄屏/省电把 WebView 挂起导致生题假停（注：切到别的 App 属系统后台挂起，无法阻止）
  useKeepAwake(store.phase === 'generating' || store.phase === 'validating' || store.phase === 'chatting')

  const liveElapsed = store.startAt ? now - store.startAt : 0

  useEffect(() => {
    useGenerate.getState().load()
  }, [])

  // 知识库：进入页面加载一次；从知识库卡「引用」跳转来时，把预选库并入当前选中并清空 pendingRefIds
  useEffect(() => {
    if (!useKB.getState().loaded) useKB.getState().load()
  }, [])
  useEffect(() => {
    if (kbPendingRefIds.length === 0) return
    setKbRefIds((prev) => {
      const s = new Set(prev)
      for (const id of kbPendingRefIds) s.add(id)
      return [...s]
    })
    useKB.getState().setPendingRefIds([])
  }, [kbPendingRefIds])

  const readyKBs = useMemo(() => kbBases.filter((b) => b.status === 'ready'), [kbBases])
  const selectedKBs = useMemo(() => readyKBs.filter((b) => kbRefIds.includes(b.id)), [readyKBs, kbRefIds])
  /** 当前打开范围选择弹层的库 */
  const scopeKb = scopeKbId ? readyKBs.find((kb) => kb.id === scopeKbId) : undefined
  const toggleKb = (id: string) =>
    setKbRefIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const removeKb = (id: string) => setKbRefIds((prev) => prev.filter((x) => x !== id))

  // 填充历史会话列表 + 把跨会话草稿并入 drafts（聊天记录流会展示所有历史会话的学习本卡片）
  useEffect(() => {
    useGenerate.getState().refreshSessions()
  }, [])
  useEffect(() => {
    useGenerate.getState().hydrateDrafts()
  }, [store.sessionList])

  // 贴底信号：只看「当前会话消息数」会在历史会话异步并入前就贴底，导致进入页面停在最早的历史位置。
  // 改为统计「当前会话消息 + 全部历史会话」，只要消息流整体高度增长（含历史并入）就强制贴底。
  const flowCount = (store.session?.messages.length ?? 0) + store.sessionList.length
  // 生成页是否可见：所有页面常驻挂载（App.tsx 里非激活页 display:none），隐藏态 scrollHeight 为 0、
  // scrollTop 贴底无效且切回可见时归零——所以必须「每次进入可见」都强制贴底，而不是只在数据变化时。
  const pageActive = useUI((s) => s.page === 'generate')
  // ① 每次切回生成页（可见）：无条件跳到最后对话（用户要求：进入页面直接是最新对话）
  useEffect(() => {
    if (!pageActive) return
    const el = flowRef.current
    if (!el) return
    followRef.current = true
    const raf = requestAnimationFrame(() => {
      // 双帧：首次 rAF 时 display 刚置为 block、合并的历史会话可能未完全布局，再等一帧确保高度准确
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [pageActive])
  // ② 消息流整体增长（新消息/历史并入，且当前可见）：忽略用户滚动位置，强制贴底即时跳转
  useEffect(() => {
    const el = flowRef.current
    if (!el || !pageActive || flowCount === lastFlowCountRef.current) return
    lastFlowCountRef.current = flowCount
    followRef.current = true
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [flowCount])

  // 流式内容增长：仅在正处于跟随（贴底）状态时平滑贴底，上滑翻历史时不打扰
  useEffect(() => {
    const el = flowRef.current
    if (!el || !followRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [store.session?.messages[store.session.messages.length - 1]?.content])

  // BUG-4 修复：「已停止回复/失败」提示条渲染在消息流末尾——用户上翻看历史时出现提示条在视口外，
  // 看起来像「点了停止没有任何提示」。提示条出现时强制贴底让它可见
  useEffect(() => {
    const el = flowRef.current
    if (!el || !pageActive || !store.error) return
    followRef.current = true
    el.scrollTop = el.scrollHeight
  }, [store.error, pageActive])

  // 用户手动滚动：上翻则放弃跟随；滚回底部自动恢复
  const handleFlowScroll = () => {
    const el = flowRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // 默认厂商未配置时回退到已配置厂商（默认 = 优先调用，非绑定）
  const apiReady = isProviderReady(ai.providers[resolveActiveId(ai.providers, ai.defaultId)])
  const totalStructure = Object.values(store.structure).reduce((a, b) => a + b, 0)
  const historyCount = store.sessionList.length

  // 打开生成弹窗：count>0 时先把结构种子为 AI 推荐 + 该题数（弹窗内可切「自定义」改题型结构）。
  // RC-07：对话生题解析出题型结构时，按结构预填「自定义」模式——生成严格按用户指定的题型分布。
  const openQuickDlg = useCallback(
    (preload: { content: string; count: number; structure?: { type: QuestionTypeId; count: number }[] }, msgId?: string) => {
      const st = useGenerate.getState()
      if (preload.structure?.length) {
        st.setMode('custom')
        const s: Record<QuestionTypeId, number> = { ...st.structure }
        for (const t of QUESTION_TYPES) s[t.id] = 0
        for (const e of preload.structure) s[e.type] = e.count
        st.applyStructure(s, 'custom')
      } else if (preload.count > 0) {
        st.setMode('ai')
        st.setAiTotal(preload.count)
      }
      setQuickContent(preload.content)
      setQuickDlg({ content: preload.content, count: preload.count, msgId })
    },
    [],
  )

  /** 生成中取消（19 节步骤 7）：V2 需求草稿处于 generating 时统一走 cancelGenerationDraft('taskbar')
   *  （停执行 + 需求草稿收敛 cancelled）；无 V2 草稿走既有 cancel()（纯执行中止）。 */
  const cancelGenerating = useCallback(() => {
    const d = useGenerate.getState().session?.generationDraft
    if (d && d.lifecycle === 'generating') useGenerate.getState().cancelGenerationDraft('taskbar')
    else useGenerate.getState().cancel()
  }, [])

  // 建议操作按钮（Trae 式）：生成 → 打开生成弹窗（预填，可改题型结构）；取消 → 移除这些按钮。
  // 用 getState() 读取最新状态而非闭包外层 store，保证回调引用恒定（依赖空数组），
  // 否则每次 store 变化都重建回调 → MessageBubble 的 memo 失去跳过重渲染的意义，长对话流式会退化成整列表重建。
  const handleAction = useCallback(
    (msg: Message, act: ChatAction) => {
      const st = useGenerate.getState()
      if (act.kind === 'dismiss') {
        st.dismissActions(msg.id)
      } else if (act.kind === 'continue') {
        // 续写被截断的聊天回复（finish_reason=length）：让模型从该消息末尾继续生成
        void st.continueReply(msg)
      } else if (act.kind === 'resume') {
        // 多卷中断续跑：从草稿学习本携带的卷序列继续生成剩余卷
        void st.resume(act.packId ?? '')
      } else if (act.kind === 'source_new' || act.kind === 'source_keep' || act.kind === 'source_clear') {
        // P1-12：来源冲突动作也必须校验动作所属的草稿版本，避免历史按钮改写新方案
        const d = st.session?.generationDraft
        const ref = msg.proposalRef
        if (!d || !ref || d.id !== ref.draftId || d.revision !== ref.revision || d.lifecycle !== 'active') {
          useUI.getState().showToast('方案已更新，请使用最新方案')
          st.dismissActions(msg.id)
          return
        }
        st.updateGenerationDraft({
          kind: 'resolve_source_conflict',
          decision: act.kind === 'source_new' ? 'replace' : act.kind === 'source_clear' ? 'clear' : 'preserve',
          source: act.source,
        })
        st.dismissActions(msg.id)
      }
    },
    [],
  )

  /** 消息复制：只复制正文，不把用户消息携带的 refs 注入剪贴板。 */
  const handleCopyMessage = useCallback(async (message: Message) => {
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText || !getMessageCopyText(message).trim()) {
      useUI.getState().showToast('复制失败')
      return
    }
    try {
      await copyMessageText(message, (text) => clipboard.writeText(text))
      useUI.getState().showToast('已复制')
    } catch {
      useUI.getState().showToast('复制失败')
    }
  }, [])

  /** 用户消息修改：先回填输入框，不原地修改历史，发送后才开始新一轮。 */
  const handleEditMessage = useCallback((message: Message) => {
    if (!canEditMessage(message)) return
    setInput(message.content)
    requestAnimationFrame(() => {
      mainInputRef.current?.focus()
      mainInputRef.current?.select()
    })
  }, [])

  // 聊天记录流：合并所有历史会话（旧在上、新在下），向上滚动即可翻找历史记录。
  // 关键：当前活跃会话必须优先用 store.session（含乐观写入的最新消息）——
  // 若先遍历 sessionList，会命中上一轮 refreshSessions() 写入的旧快照（同 id），
  // 导致本轮新消息/流式回复被旧快照遮挡，直到本轮结束才一次性出现（「第二轮内容很久才显示」）。
  const flowBlocks = useMemo(() => {
    const seen = new Set<string>()
    const sessions: typeof store.sessionList = []
    if (store.session && !seen.has(store.session.id)) {
      seen.add(store.session.id)
      sessions.push(store.session)
    }
    for (const s of store.sessionList) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      sessions.push(s)
    }
    sessions.sort((a, b) => a.created - b.created)
    const allBlocks: ReactNode[] = []
    for (const s of sessions) {
      for (const m of s.messages) {
        allBlocks.push(
          m.result ? (
            <PackCard key={m.id} message={m} />
          ) : (
            // 用户气泡 / 空助手思考占位 / 助手文本留痕统一走 memo 组件：
            // 每帧流式更新只重建被更新的那条消息，其余气泡引用不变 → React.memo 跳过重渲染
            <MessageBubble
              key={m.id}
              message={m}
              chatting={store.phase === 'chatting'}
              onAction={handleAction}
              onCopy={handleCopyMessage}
              onEdit={handleEditMessage}
            />
          ),
        )
      }
    }
    // V2-P05：长会话窗口化——默认只渲染最近 visibleMessages 条，超出部分折叠为「加载更早」，
    // 避免 50 个会话的全部消息一次性构造并常驻 DOM（隐藏信息仍可从 store/IndexedDB 恢复）。
    const total = allBlocks.length
    const keep = Math.min(visibleMessages, total)
    return { blocks: allBlocks.slice(total - keep), hidden: total - keep }
  }, [store.sessionList, store.session, store.drafts, store.phase, visibleMessages])

  const openHistory = async () => {
    const recs = await store.listGeneratedPacks()
    setRecords(recs)
    setSelPackId(null)
    setHistOpen(true)
  }

  const clearHistory = () => {
    modal.confirm(
      '清空历史会话',
      '将删除全部历史会话及未入库的草稿学习本。学习库中已入库的学习本会保留。此操作不可恢复。',
      () => store.clearSessions(),
    )
  }

  /** 导入文件：选中只挂引用（对齐 Cherry/Reasonix —— 不在此刻读取文件内容），解析推迟到发送时。
   *  V2-P01：同时限制单次文件数与总体积，防多份大文件在发送时并发解析造成内存峰值。 */
  const handleImportFiles = async () => {
    try {
      const files = await pickFiles(SUPPORTED_ACCEPT)
      if (files.length === 0) return
      const next = totalBytesOf([...chips, ...files])
      const oversized = files.filter((f) => f.size > MAX_FILE_BYTES)
      if (oversized.length > 0) {
        ui.showToast(oversized.map((f) => `${f.name}：超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`).join('；'))
      }
      const ok = files.filter((f) => f.size <= MAX_FILE_BYTES)
      if (ok.length + chips.length > MAX_FILE_COUNT) {
        ui.showToast(`一次最多引用 ${MAX_FILE_COUNT} 个文件`)
        return
      }
      if (next > MAX_TOTAL_BYTES) {
        ui.showToast(`引用文件总体积超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
        return
      }
      if (ok.length > 0) setChips((prev) => [...prev, ...toChips(ok)])
    } catch (e) {
      ui.showToast(e instanceof Error ? e.message : '导入文件失败')
    }
  }

  const removeChip = (id: string) => setChips((prev) => prev.filter((c) => c.id !== id))

  /** 发送：首次发送才对已引用文件做解析（对齐 Cherry/Reasonix —— 选中不读，发送才读），
   *  按 water-filling 分配预算后合成参考资料注入；解析失败项就地对用户提示并跳过，不静默。 */
  const handleSend = async () => {
    const content = input.trim()
    if (!content) return
    let next = chips
    const pending = next.filter((c) => c.text === undefined)
    if (pending.length > 0) {
      // V2-P01：解析并发固定为 2，避免多份大文件同时 readAsText/解压/DOMParser 造成内存峰值
      const results = await mapWithConcurrency(pending, 2, (c) => parseFileToText(c.file))
      const texts = new Map<string, string>()
      const failed: string[] = []
      results.forEach((r, i) => {
        const c = pending[i]
        if (r.status === 'fulfilled') texts.set(c.id, r.value)
        else failed.push(`${c.name}：${r.reason instanceof Error ? r.reason.message : '解析失败'}`)
      })
      if (failed.length > 0) ui.showToast(failed.join('；'))
      next = seedParsed(next, Object.fromEntries(texts))
      setChips(next)
    }
    const fileRef = buildFilesRef(next)
    // V-EMB：向量缓存预热（库已生成语义索引时），buildMultiKbRef 内走向量+BM25 融合通道
    await Promise.all(selectedKBs.map((kb) => warmVectorCache(kb)))
    const kbRef = await buildMultiKbRef(selectedKBs, content)
    const refs = [fileRef, kbRef].filter(Boolean).join('\n\n') || undefined
    // 生题范围（Phase 3）：引用了知识库即按勾选章节切卷（未勾选=全部内容，D7），逐库拼接统一卷序列。
    // 闲聊路径不受影响（refs 检索块照旧注入）；生题路径由 store 用整卷正文取代检索块（volumeRunRefs 剥离）。
    let kbScope: KbScope | undefined
    if (selectedKBs.length > 0) {
      const volumes: KBVolume[] = []
      for (const kb of selectedKBs) {
        const plan = planVolumes(kb.bodyText || kb.consolidated, kb.sections ?? [], scopes[kb.id] ?? [])
        for (const v of plan.volumes) volumes.push({ ...v, kbName: kb.name, kbId: kb.id })
      }
      kbScope = volumes.length > 0 ? { volumes, kbRef: kbRef || undefined } : undefined
    }
    store.send(content, refs, kbScope)
    setInput('')
    setChips([])
    setKbRefIds([])
  }

  /** 题型结构编辑器（生成弹窗内）：模式切换 + 自定义各题型计数 + 合计 + 模板保存 */
  const renderStructureEditor = () => (
    <>
      <div className="seg mb-8">
        <button
          className={'seg-item' + (store.structureMode === 'ai' ? ' active' : '')}
          onClick={() => store.setMode('ai')}
        >
          AI 推荐
        </button>
        <button
          className={'seg-item' + (store.structureMode === 'custom' ? ' active' : '')}
          onClick={() => store.setMode('custom')}
        >
          自定义
        </button>
      </div>

      {store.structureMode === 'ai' ? (
        <div className="gen-stepper ai-total">
          <span className="gen-stepper-name">总题数</span>
          <div className="gen-stepper-ctrl">
            <button
              type="button"
              aria-label="减少总题数"
              onClick={() => store.setAiTotal(store.structureTotal - 1)}
              disabled={store.structureTotal <= 1}
            >
              −
            </button>
            <span className="gen-stepper-num">{store.structureTotal}</span>
            <button
              type="button"
              aria-label="增加总题数"
              onClick={() => store.setAiTotal(store.structureTotal + 1)}
              disabled={store.structureTotal >= MAX_QUESTIONS_PER_GENERATION}
            >
              ＋
            </button>
          </div>
          {store.structureTotal >= MAX_QUESTIONS_PER_GENERATION && (
            <div className="struct-limit-hint">已达单次上限 {MAX_QUESTIONS_PER_GENERATION} 题，如需更多请分批生成</div>
          )}
        </div>
      ) : (
        <div className="type-list">
          {QUESTION_TYPES.map((t) => (
            <div className="type-row" key={t.id}>
              <span className="tname">
                {t.name}
                <span className="tcat">{t.category === 'objective' ? '客观' : '主观'}</span>
              </span>
              <div className="stepper">
                <button
                  className="st-btn"
                  type="button"
                  aria-label={`减少${t.name}`}
                  onClick={() => store.setStructure(t.id, store.structure[t.id] - 1)}
                  disabled={store.structure[t.id] <= 0}
                >
                  −
                </button>
                <EditableCount
                  value={store.structure[t.id]}
                  label={t.name}
                  onChange={(n) => store.setStructure(t.id, n)}
                />
                <button
                  className="st-btn"
                  type="button"
                  aria-label={`增加${t.name}`}
                  onClick={() => store.setStructure(t.id, store.structure[t.id] + 1)}
                  disabled={
                    store.structure[t.id] >=
                    Math.min(MAX_PER_TYPE, MAX_QUESTIONS_PER_GENERATION - (store.structureTotal - store.structure[t.id]))
                  }
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {store.structureMode === 'custom' && (
        <div className="struct-total">
          <span className="tt">
            合计 <b>{totalStructure}</b> 题
          </span>
          {totalStructure >= MAX_QUESTIONS_PER_GENERATION && (
            <span className="struct-limit-hint">已达单次上限 {MAX_QUESTIONS_PER_GENERATION} 题</span>
          )}
        </div>
      )}
      {store.structureMode === 'custom' && <TemplateBar />}
    </>
  )

  return (
    <div className="gen-page">
      {/* ① 顶部操作栏：快捷生成（主按钮）+ ⋮ 更多（学习本生成历史 / 清空历史） */}
      <div className="gen-topbar">
        <button className="gen-topbtn primary" onClick={() => openQuickDlg({ content: '', count: 0 })}>
          <span className="gen-topbtn-ic">＋</span>快捷生成
        </button>
        <button className="gen-more" aria-label="更多" onClick={() => setMoreOpen((v) => !v)}>
          ⋮
        </button>
      </div>

      {/* ⋮ 更多菜单：历史查看 / 清空 */}
      {moreOpen && (
        <>
          <div className="gen-more-mask" onClick={() => setMoreOpen(false)} />
          <div className="gen-more-menu">
            <button
              className="gen-more-item"
              onClick={() => {
                setMoreOpen(false)
                openHistory()
              }}
            >
              学习本生成历史
            </button>
            <button
              className="gen-more-item danger"
              onClick={() => {
                setMoreOpen(false)
                if (historyCount === 0) {
                  ui.showToast('暂无历史会话')
                  return
                }
                clearHistory()
              }}
            >
              清空历史
            </button>
          </div>
        </>
      )}

      {/* 生成弹窗：内容 + 题型结构（AI 推荐预填或自定义可改），点「开始生成」直接生题 */}
      {quickDlg && (
        <div className="dlg-mask" onClick={closeQuickDlg}>
          <div className="gen-config-dlg" onClick={(e) => e.stopPropagation()}>
            <div className="dlg-body">
              <textarea
                ref={inputRef}
                className="quick-input"
                placeholder="输入想生成的题目内容，如：初二的三角函数应用"
                value={quickContent}
                maxLength={100}
                rows={2}
                autoFocus
                onChange={(e) => setQuickContent(e.target.value)}
              />
              <div className="quick-struct">{renderStructureEditor()}</div>
            </div>
            <div className="dlg-foot">
              <button className="btn plain" type="button" onClick={closeQuickDlg}>
                取消
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!quickContent.trim()}
                onClick={() => {
                  const c = quickContent.trim()
                  if (quickDlg.msgId) store.dismissActions(quickDlg.msgId)
                   closeQuickDlg()
                  // 内容里明确写了题数（如「100道」）时以内容为准（app_bug 6.63：快捷生成弹窗的
                  // 结构遗留 20 题，用户在内容里写的「100道」被当材料忽略，实际只出 20 题）。
                  // 切 AI 推荐模式按该总数分配题型；与结构不一致时 toast 说明，消除认知落差。
                  // RC-07：已按对话解析的题型结构预填自定义模式时跳过该覆盖——结构合计才是权威题数。
                  const n = pickCount(c)
                  if (store.structureMode === 'ai' && n != null && n !== store.structureTotal) {
                    store.setAiTotal(n)
                    ui.showToast(`已按内容中的题数生成 ${n} 题`)
                  }
                  store.generate(c)
                }}
              >
                开始生成{' '}
                {store.structureMode === 'ai'
                  ? store.structureTotal
                  : Object.values(store.structure).reduce((a, b) => a + b, 0)}{' '}
                题
              </button>
            </div>
            <div className="dlg-hint">题数以你在此设置的为准，点「开始生成」立即生题。</div>
          </div>
        </div>
      )}

      {/* API 未配置提示 */}
      {!apiReady && (
        <div className="gen-api-banner">
          <span>未配置 AI 模型，无法生成题目</span>
          <button className="btn sm" onClick={() => ui.navigate('ai-settings', true)}>
            去配置
          </button>
        </div>
      )}

      {/* ② 消息流（聊天记录：合并全部历史会话，向上可翻找旧记录） */}
      <div className="gen-flow" ref={flowRef} onScroll={handleFlowScroll}>
        {flowBlocks.hidden > 0 && (
          <button
            className="gen-load-earlier"
            onClick={() => setVisibleMessages((v) => v + MESSAGE_WINDOW)}
          >
            ↑ 加载更早的 {flowBlocks.hidden} 条消息
          </button>
        )}
        {flowBlocks.blocks}

        {store.phase === 'done' && store.lastElapsed != null && (
          <div className="gen-progress gen-progress-done">
            {/* 缺口快照：后台被系统挂起/多批失败后会「不足额结束」，不能谎称生成完成（真机 6.x） */}
            <div className="gen-progress-info">
              {store.lastDeficit > 0
                ? `⚠ 部分完成，差 ${store.lastDeficit} 题 · 共耗时 ${fmtElapsed(store.lastElapsed)}——点下方「继续补齐 · 差 ${store.lastDeficit} 题」续跑`
                : `✓ 生成完成 · 共耗时 ${fmtElapsed(store.lastElapsed)}`}
            </div>
          </div>
        )}

        {store.error && (
          <div className="gen-error">
            <span className="gen-error-msg">{store.error}</span>
            {store.error === '已停止回复' ? (
              <button className="btn sm" onClick={() => store.regenerateLast()}>
                重新回复
              </button>
            ) : (
              store.error !== '已取消生成' && (
                <button className="btn sm" onClick={() => store.retryLast()}>
                  重试
                </button>
              )
            )}
          </div>
        )}
      </div>

      {/* ②b 唯一活动方案卡（V2 / TASK-09）：固定在消息滚动区与输入区之间，不进 flowBlocks。
          仅当会话存在 V2 需求草稿时渲染（legacy 下恒为 undefined，不渲染）；cancelled 自动撤下。
          ready 时主按钮直接 startGenerationFromDraft 一键生成，不再打开 quickDlg 二次确认。 */}
      <GenerationDraftCard elapsedMs={liveElapsed} onCancel={cancelGenerating} />

      {/* ③ 输入区：发送/停止按钮嵌在输入框右下角（对齐 Cherry Studio 等 agent 的圆钮布局） */}
      <div className="gen-bottom">
        {/* 已导入文件 chips + 已引用知识库 chips：发送时合成参考资料块 refs，一并带给模型 */}
        {(chips.length > 0 || selectedKBs.length > 0) && (
          <div className="gen-files">
            {selectedKBs.map((kb) => {
              // OBS-3 修复：默认全选时 scopes 里没有该库条目、scopeN=0 导致 chip 不显示节数
              //（用例预期「已选 N 节」）——无显式范围时按库全部节数显示「全部 N 节」
              const explicit = scopes[kb.id]
              const scopeN = explicit?.length ?? kb.sections?.length ?? 0
              // 检索方式已绑定到单个库：仅当该库语义索引就绪才是「语义检索」，否则关键词检索
              const semanticOn = kb.embedStatus === 'ready'
              return (
                <div className="gen-file" key={kb.id} style={semanticOn ? { borderColor: 'var(--primary, #185FA5)', background: 'rgba(24,95,165,.06)' } : undefined}>
                  <span className="gen-file-name" title={kb.name}>🗂 {kb.name}</span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 8,
                      background: semanticOn ? 'rgba(24,95,165,.18)' : 'rgba(0,0,0,.06)',
                      color: semanticOn ? 'var(--primary, #185FA5)' : 'var(--color-text-secondary, #888)',
                      fontWeight: 600,
                    }}
                  >
                    {semanticOn ? '语义检索' : '关键词检索'}
                  </span>
                  {scopeN > 0 && (
                    <span className="gen-file-meta">{explicit ? `已选 ${scopeN} 节` : `全部 ${scopeN} 节`}</span>
                  )}
                  <button className="gen-file-del" onClick={() => removeKb(kb.id)} aria-label={`移除知识库 ${kb.name}`}>
                    ×
                  </button>
                </div>
              )
            })}
            {chips.map((c) => {
              const len = c.text !== undefined ? c.text.length : null
              const truncated = len !== null && c.cursor != null && c.cursor < len
              const sizeLabel =
                c.size >= 1024 * 1024
                  ? `${(c.size / 1024 / 1024).toFixed(1)} MB`
                  : `${Math.max(1, Math.round(c.size / 1024))} KB`
              return (
                <div className="gen-file" key={c.id}>
                  <span className="gen-file-name" title={c.name}>{c.name}</span>
                  <span className="gen-file-meta">{len !== null ? (truncated ? `已读 ${c.cursor}/${len} 字` : `${len} 字`) : sizeLabel}</span>
                  <button className="gen-file-del" onClick={() => removeChip(c.id)} aria-label={`移除 ${c.name}`}>
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="gen-input-box">
          <button
            ref={attachRef}
            className="gen-attach"
            onClick={() => setToolOpen((v) => !v)}
            aria-label="添加附件或引用知识库"
            title="上传附件 / 引用知识库"
          >
            {toolOpen ? (
              <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                <path fill="currentColor" d="M6.4 6.4l11.2 11.2 1.4-1.4L7.8 5 6.4 6.4zm-.9 10.8L16.8 6l1.4 1.4L6.9 18.6l-1.4-1.4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                <path fill="currentColor" d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </button>

          {toolOpen && (
              <div ref={toolMenuRef} className="gen-tool-menu">
                <button
                  className="gen-tool-item"
                  onClick={() => {
                    setToolOpen(false)
                    handleImportFiles()
                  }}
                >
                  上传附件
                </button>
                <button
                  className="gen-tool-item"
                  onClick={() => {
                    setToolOpen(false)
                    setKbPickOpen(true)
                  }}
                >
                  引用知识库
                </button>
              </div>
          )}

          {/* 圆角输入框：单行紧凑（对齐豆包，随内容自动增高一至多行，空态即一条） */}
          <div className="gen-input-wrap">
            <textarea
              ref={mainInputRef}
              className="gen-input"
              value={input}
              maxLength={100}
              rows={1}
              placeholder=""
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
          </div>

          {/* 流式回复 / 生成 / 校验进行中：发送钮变「停止」圆形钮，可随时中断卡住的模型 */}
          {store.phase === 'chatting' || store.phase === 'generating' || store.phase === 'validating' ? (
            <button className="gen-send stop" onClick={() => store.cancel()} aria-label="停止当前回复" title="停止当前回复">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              className="gen-send"
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="发送"
              title="发送"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12 4l5 5-1.4 1.4L13 8.8V19h-2V8.8l-2.6 2.6L7 9z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ④ 引用知识库选择器弹窗 + 范围选择二级弹层（Phase 3 范围选题） */}
      <KbPicker
        open={kbPickOpen}
        bases={readyKBs}
        selected={kbRefIds}
        scopes={scopes}
        onToggle={toggleKb}
        onOpenScope={(id) => setScopeKbId(id)}
        onClose={() => setKbPickOpen(false)}
      />
      {scopeKb && (
        <ScopePicker
          kb={scopeKb}
          initial={scopes[scopeKb.id] ?? []}
          onConfirm={(ids) =>
            setScopes((prev) => {
              const next = { ...prev }
              // 空数组 = 全部内容（D7 规范型），删键保持 record 干净
              if (ids.length === 0) delete next[scopeKb.id]
              else next[scopeKb.id] = ids
              return next
            })
          }
          onClose={() => setScopeKbId(null)}
        />
      )}

      {/* ⑤ 学习本生成历史弹窗 */}
      <HistorySheet
        open={histOpen}
        records={records}
        selPackId={selPackId}
        onSelect={setSelPackId}
        onClose={() => setHistOpen(false)}
        onRefresh={openHistory}
      />

      {/* ⑥ 调试日志弹窗（已迁移到「我的」tab，见 MePage） */}
    </div>
  )
}

/** 引用知识库选择器：多选就绪知识库，发送时按主题检索并注入相关内容（Phase 3 F6，见 ref.ts）；
 *  选中库卡片内渲染「范围」子行（D11），点开 ScopePicker 二级弹层勾选章节（Phase 3 范围选题） */
function KbPicker({
  open,
  bases,
  selected,
  scopes,
  onToggle,
  onOpenScope,
  onClose,
}: {
  open: boolean
  bases: KBDoc[]
  selected: string[]
  /** 每库已勾选的 sectionIds（空/缺省 = 全部内容） */
  scopes: Record<string, string[]>
  onToggle: (id: string) => void
  onOpenScope: (kbId: string) => void
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div className="dlg-mask" onClick={onClose}>
      <div className="kb-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <span className="dlg-title flex-1">引用知识库</span>
          <button className="gen-hist-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="dlg-body">
          {bases.length === 0 ? (
            <div className="kb-dlg-empty">还没有就绪的知识库，请先到「知识库」页导入资料并整理</div>
          ) : (
            bases.map((kb) => {
              const on = selected.includes(kb.id)
              const scopeCount = scopes[kb.id]?.length ?? 0
              const hasSections = (kb.sections?.length ?? 0) > 0
              return (
                <label key={kb.id} className={'kb-pick-row' + (on ? ' on' : '')}>
                  <input type="checkbox" checked={on} onChange={() => onToggle(kb.id)} />
                    <span className="flex-1 kb-pick-main">
                    <span className="kb-pick-name">🗂 {kb.name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        marginLeft: 6,
                        borderRadius: 8,
                        verticalAlign: 2,
                        background: kb.embedStatus === 'ready' ? 'rgba(24,95,165,.12)' : 'rgba(0,0,0,.06)',
                        color: kb.embedStatus === 'ready' ? 'var(--primary, #185FA5)' : 'var(--color-text-secondary, #888)',
                      }}
                    >
                      {kb.embedStatus === 'ready' ? '语义检索' : '关键词检索'}
                    </span>
                    {kb.summary && <span className="card-sub">{kb.summary}</span>}
                    {on && hasSections && (
                      <button
                        type="button"
                        className="kb-pick-scope"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onOpenScope(kb.id)
                        }}
                      >
                        范围：{scopeCount > 0 ? `已选 ${scopeCount} 节` : '全部内容'} ›
                      </button>
                    )}
                  </span>
                </label>
              )
            })
          )}
        </div>
        <div className="dlg-foot">
          <button className="btn primary" onClick={onClose}>确定（{selected.length}）</button>
        </div>
      </div>
    </div>
  )
}

/** 范围选择二级弹层（Phase 3）：扁平章节列表勾选 + 全选/清空 + 底部实时汇总条
 *  （字数/预计卷数与 handleSend 的 planVolumes 同源计算）。本地草稿确认制：
 *  勾选只改本地态，点「确定」才提交（全选提交为空 = 全部内容，D7 规范型；0 节不可确定）。 */
function ScopePicker({
  kb,
  initial,
  onConfirm,
  onClose,
}: {
  kb: KBDoc
  initial: string[]
  onConfirm: (sectionIds: string[]) => void
  onClose: () => void
}) {
  const sections = kb.sections ?? []
  const allIds = useMemo(() => sections.map((s) => s.id), [sections])
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.length > 0 ? initial : allIds))
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const plan = useMemo(
    () => planVolumes(kb.bodyText || kb.consolidated, sections, [...picked]),
    [kb.bodyText, kb.consolidated, sections, picked],
  )
  const fmtChars = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`)
  return (
    <div className="dlg-mask dlg-mask-top" onClick={onClose}>
      <div className="kb-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <span className="dlg-title flex-1">选择范围 · {kb.name}</span>
          <button className="gen-hist-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="scope-toolbar">
          <span className="scope-count">章节 {picked.size}/{sections.length}</span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() =>
              setPicked((prev) => (prev.size === sections.length ? new Set() : new Set(allIds)))
            }
          >
            {picked.size === sections.length ? '取消全选' : '全选'}
          </button>
        </div>
        <div className="dlg-body">
          {sections.map((sec) => {
            const on = picked.has(sec.id)
            return (
              <label key={sec.id} className={'scope-row' + (on ? ' on' : '')}>
                <input type="checkbox" checked={on} onChange={() => toggle(sec.id)} />
                <span className="scope-row-title">{sec.title || '（无标题）'}</span>
                <span className="scope-row-chars">{fmtChars(sec.end - sec.start)}</span>
              </label>
            )
          })}
        </div>
        <div className="scope-summary">
          {picked.size === 0
            ? '已选 0 节 · 勾选节或点「全选」后再确定'
            : `已选 ${picked.size}/${sections.length} 节 · ${fmtChars(plan.totalChars)} · 预计分 ${plan.volumes.length} 卷`}
        </div>
        <div className="dlg-foot">
          <button className="btn plain" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={picked.size === 0}
            title={picked.size === 0 ? '至少选择 1 节' : undefined}
            onClick={() => {
              onConfirm(picked.size >= sections.length ? [] : [...picked])
              onClose()
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

function TemplateBar() {
  const store = useGenerate()
  const [name, setName] = useState('')
  return (
    <div className="gen-templates">
      <div className="gen-tpl-row">
        <input
          className="input"
          placeholder="保存当前结构为模板，如：软考模拟卷"
          value={name}
          maxLength={12}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn sm ghost"
          onClick={() => {
            if (name.trim()) {
              store.saveTemplate(name.trim())
              setName('')
            }
          }}
        >
          保存
        </button>
      </div>
      {Object.entries(store.templates).length > 0 && (
        <div className="gen-tpl-list">
          {Object.entries(store.templates).map(([n, s]) => (
            <button key={n} className="gen-tpl-chip" onClick={() => store.applyStructure(s)}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 剥除模型回复中可能泄露的 <untrusted_user_content> 边界标签（V3-S05 数据边界不应回显到回复里——
 * prompt 已有指令，但模型偶尔仍把 wrapper 当作格式输出，含转义形态 <\u002F...> / \u003C...，
 * 真机 6.x：本地旧实现只剥标准形态导致气泡顶部残留 untrusted 字样）。前后空白一并 trim。
 */
function stripUntrusted(s: string): string {
  return stripUntrustedMarkers(s).trim()
}

/**
 * 聊天气泡（memo 化，对齐 Cherry Studio）：流式更新时 store 只替换被更新那条消息的新对象引用，
 * 其它消息对象引用不变，React.memo 按引用比对自动跳过它们的重渲染——长对话增量更新不再整列表重建。
 * assistant 文本内容经 renderMarkdown 渲染（escape 后安全转 HTML），用户内容按纯文本展示。
 */
const MessageBubble = memo(function MessageBubble({
  message,
  chatting,
  onAction,
  onCopy,
  onEdit,
}: {
  message: Message
  /** 当前是否正处于流式回复中：只有此时空助手占位才显示「正在思考」，避免孤儿占位永远转圈 */
  chatting: boolean
  /** 点击「建议操作」按钮（生题确认回复下的 chips）：引用需恒定，否则 memo 失去跳过重渲染的意义 */
  onAction?: (msg: Message, act: ChatAction) => void
  /** 复制消息正文 */
  onCopy?: (msg: Message) => void
  /** 将用户消息回填到主输入框 */
  onEdit?: (msg: Message) => void
}) {
  // 思考占位：实时显示已等待秒数（C 方案：慢可感知为在工作），超过 6s 追加「响应较慢」提示
  const [slow, setSlow] = useState(false)
  const [elapsedS, setElapsedS] = useState(0)
  const arming = !message.content && chatting
  useEffect(() => {
    if (!arming) {
      setSlow(false)
      setElapsedS(0)
      return
    }
    const t0 = Date.now()
    const iv = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000)
      setElapsedS(s)
      if (s >= 6) setSlow(true)
    }, 1000)
    return () => clearInterval(iv)
  }, [arming])

  // 固定模板回复（message.reveal）逐字显示，模拟 AI 打字节奏，每次挂载只跑一次
  const [shown, setShown] = useState<number | null>(null)
  useEffect(() => {
    if (!message.reveal || !message.content) return
    setShown(0)
    const total = message.content.length
    let i = 0
    const t = setInterval(() => {
      i++
      if (i >= total) {
        clearInterval(t)
        setShown(null) // 显完置 null，走完整渲染（避免中途 markdown 未闭合残留）
        return
      }
      setShown(i)
    }, 16)
    return () => clearInterval(t)
  }, [message.id, message.reveal, message.content.length])

  const cleanContent = useMemo(
    () => stripUntrusted(message.content),
    [message.content],
  )
  const display = shown != null ? cleanContent.slice(0, shown) : cleanContent
  const html = useMemo(
    () => (message.role === 'assistant' && display ? renderMarkdown(display) : ''),
    [message.role, display],
  )
  const showMessageActions = message.content.length > 0 && getMessageCopyText(message).trim().length > 0
  const messageActions = showMessageActions ? (
    <div className={'gen-message-actions ' + message.role}>
      <button type="button" className="gen-message-action" onClick={() => onCopy?.(message)} aria-label="复制消息" title="复制">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      {canEditMessage(message) && (
        <button type="button" className="gen-message-action" onClick={() => onEdit?.(message)} aria-label="修改消息" title="修改">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 16.5-.8 3.3 3.3-.8L18.8 6.7a2 2 0 0 0-2.8-2.8L3.7 15.2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="m14.6 5.4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  ) : null

  if (message.role === 'user') {
    return (
      <div className="gen-message-item user">
        <div className="gen-bubble user">
          {message.content}
          {message.refs && <div className="gen-bubble-refs">📎 已附参考资料</div>}
        </div>
        {messageActions}
      </div>
    )
  }
  if (!message.content) {
    // 空助手占位：回复进行中显示思考指示器；否则是中断遗留的空占位（load 已清理，兜底显示）
    return (
      <div className="gen-bubble ai thinking">
        <span className="gen-thinking">{chatting ? (slow ? `模型响应较慢，已等 ${elapsedS}s，请稍候…` : `正在思考… ${elapsedS}s`) : '（已中断）'}</span>
      </div>
    )
  }
  // 无 result 的助手消息（取消/中断且一题未出的留痕/普通聊天回复/生题确认回复）：渲染 markdown 文本气泡，
  // 交给 PackCard 会因无 ref 直接 return null，记录就「消失」了。
  // 生题确认回复额外在气泡下方渲染「建议操作」chips（Trae 式），用户点击后才开始后续流程。
  return (
    <div className="gen-message-item ai">
      <div className="gen-bubble ai md" dangerouslySetInnerHTML={{ __html: html }} />
      {message.truncated && (
        <div className="gen-truncated">
          *（回复较长，已达本次输出上限被截断）如需完整内容，可点下方「继续生成」续写。
        </div>
      )}
      {message.actions && message.actions.length > 0 && (
        <div className="gen-actions">
          {message.actions.map((act) => (
            <button
              key={act.id}
              type="button"
              className="gen-act"
              onClick={() => onAction?.(message, act)}
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
      {messageActions}
    </div>
  )
})

function PackCard({ message }: { message: Message }) {
  const store = useGenerate()
  const ui = useUI()
  const modal = useModal()
  const packs = usePacks((s) => s.packs)
  const ref = message.result

  // F-06 真实存在性：in_bank 但学习本已从学习库删除、或 ref 已被标记失效 → 按失效态展示
  const inBank = ref?.status === 'in_bank'
  const pack = ref && ref.status !== 'removed' ? (inBank ? packs.find((p) => p.id === ref.id) : store.drafts[ref.id]) : undefined
  const removed = (ref != null && ref.status === 'removed') || (inBank && !pack)
  // 生成/校验进行中：所有草稿卡的「继续补齐」禁用（防与进行中的补齐流式组件并存误操作）
  const genBusy = store.phase === 'generating' || store.phase === 'validating'

  const summary = useMemo(() => {
    if (!pack) return ''
    const byType = new Map<QuestionTypeId, number>()
    for (const q of filterValidQuestions(pack.questions)) byType.set(q.type, (byType.get(q.type) ?? 0) + 1)
    return [...byType.entries()].map(([t, n]) => `${typeName(t)} ${n}`).join(' · ')
  }, [pack])

  const issues = useMemo(() => {
    if (!pack) return 0
    return pack.questions.filter((q) => validateQuestion(q).length > 0).length
  }, [pack])
  const validCount = pack ? pack.questions.length - issues : (ref?.validCount ?? ref?.questionCount ?? 0)

  /** 继续补齐：未入库草稿携带有生成目标且尚未达标时展示（中断/不足交付后续跑） */
  const deficit = useMemo(() => {
    const t = pack?.genTarget
    if (!t || inBank) return 0
    const target = Object.values(t.structure).reduce((a, b) => a + b, 0)
    return Math.max(0, target - pack.questions.length)
  }, [pack, inBank])

  if (!ref) return null

  return (
    <div className="gen-card">
      <div className="gen-card-head">
        <span className="gen-card-title">学习本 · {ref.title}</span>
        <span className={'gen-chip' + (removed ? ' removed' : inBank ? ' bank' : ' draft')}>
          {removed ? '已失效' : inBank ? `已入库 · ${ref.validCount ?? ref.questionCount} 题` : `未入库 · 有效 ${validCount}/${ref.questionCount} 题`}
        </span>
      </div>
      {summary && <div className="gen-card-sub">{summary}</div>}
      {!inBank && !removed && issues > 0 && (
        <div className="gen-card-warn">
          校验通过 {validCount} 题 · {issues} 题需处理
        </div>
      )}
      {ref.rejects &&
        ref.rejects.parse + ref.rejects.invalid + ref.rejects.duplicate > 0 && (
          <RejectDiag stats={ref.rejects} />
        )}
      <div className="gen-card-actions">
        {/* 生成进行中禁用「继续补齐」：避免补齐流式组件与旧草稿卡并存时误点二次启动（真机 6.x） */}
        {deficit > 0 && !removed && !genBusy && (
          <button className="btn sm" onClick={() => store.resume(ref.id)}>
            继续补齐 · 差 {deficit} 题
          </button>
        )}
        {deficit > 0 && !removed && genBusy && (
          <span className="gen-chip draft">补齐进行中…</span>
        )}
        {!inBank && !removed && (
          <button
            className="btn sm"
            onClick={() => {
              if (issues > 0) {
                modal.confirm(
                  '确认入库',
                  `有 ${issues} 题未通过校验，将只入库通过的 ${ref.questionCount - issues} 题。`,
                  () => store.addToBank(ref.id),
                )
              } else {
                store.addToBank(ref.id)
              }
            }}
          >
            入库
          </button>
        )}
        {!removed && (
          <button
            className="btn ghost sm"
            onClick={() => {
              ui.openPack(ref.id)
              ui.navigate('preview', true)
            }}
          >
            编辑
          </button>
        )}
        <button
          className="btn ghost sm danger"
          onClick={() =>
            modal.confirm(
              '删除学习本',
              // V2-F07：区分 in_bank（学习库仍保留）与 removed（学习本/草稿都不在）的说明文案
              removed
                ? `该学习本已失效，学习库中已没有「${ref.title}」，删除仅清理此条失效记录。`
                : inBank
                  ? `学习本已入库，删除仅移除该条生成记录与草稿，学习库中的「${ref.title}」仍保留。`
                  : `学习本未入库，删除后无法恢复，学习库中也没有它。确定删除「${ref.title}」？`,
              () => store.deleteDraft(ref.id),
            )
          }
        >
          删除
        </button>
      </div>
    </div>
  )
}

/** 生题阶段被过滤（rejected）的按原因统计展示：帮助定位「实际题数 < 请求数」的缺口成因 */
function RejectDiag({ stats }: { stats: RejectStats }) {
  const { parse, invalid, duplicate, invalidByReason } = stats
  const total = parse + invalid + duplicate
  if (total <= 0) return null
  const reasons = Object.entries(invalidByReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${k}×${n}`)
    .join('、')
  return (
    <div className="gen-card-diag">
      <div>
        生题过滤共 <b>{total}</b> 块：解析失败 {parse} · 校验不过 {invalid} · 重复 {duplicate}
      </div>
      {reasons && <div className="gen-card-diag-sub">校验原因：{reasons}</div>}
    </div>
  )
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function deriveTypes(p: Pack): string {
  const by = new Map<QuestionTypeId, number>()
  for (const q of p.questions) by.set(q.type, (by.get(q.type) ?? 0) + 1)
  return [...by.entries()].map(([t, n]) => `${typeName(t)} ${n}`).join('、')
}

/** 生成历史/记录通用的状态标签 chip（F-06：以真实存在性判定「已入库/已失效」） */
function ItemChip({ status, hasPack }: { status: string; hasPack: boolean }) {
  const removed = status === 'removed' || (status === 'in_bank' && !hasPack)
  const cls = removed ? ' removed' : status === 'in_bank' ? ' bank' : ' draft'
  return (
    <span className={'gen-chip' + cls}>{removed ? '已失效' : status === 'in_bank' ? '已入库' : '未入库'}</span>
  )
}

/** 「学习本生成历史」弹窗：列表 → 点击学习本看详情（简介/题型/目录），带入库状态标签与按状态的删除确认 */
function HistorySheet({
  open,
  records,
  selPackId,
  onSelect,
  onClose,
  onRefresh,
}: {
  open: boolean
  records: GenPackRecord[]
  selPackId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
  onRefresh: () => void
}) {
  const store = useGenerate()
  const ui = useUI()
  const modal = useModal()
  if (!open) return null

  const rec = records.find((r) => r.ref.id === selPackId) ?? null
  const status = rec?.ref.status ?? 'draft'
  const inBank = status === 'in_bank'
  // F-06：in_bank 但学习本已从学习库删除 → 同样视为失效（以真实存在性为准）
  const removed = status === 'removed' || (status === 'in_bank' && !rec?.pack)

  const doDelete = () => {
    const title = rec!.title || '未命名学习本'
    modal.confirm(
      '删除学习本记录',
      inBank
        ? `学习本已入库，删除仅移除该条生成记录与草稿，学习库中的「${title}」仍保留。`
        : `学习本未入库，删除后无法恢复，学习库中也没有它。确定删除「${title}」？`,
      async () => {
        await store.deleteDraft(rec!.ref.id)
        onRefresh()
      },
    )
  }

  const openRecord = () => {
    if (!rec) return
    if (removed) {
      useUI.getState().showToast('该学习本已失效（原学习本已删除）')
      return
    }
    onClose()
    ui.openPack(rec.ref.id)
    if (status === 'in_bank') ui.navigate('packs')
    else ui.navigate('preview', true)
  }

  return (
    <div className="gen-hist-mask" onClick={onClose}>
      <div className="gen-hist-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="gen-hist-head">
          <button
            className={'gen-hist-back' + (rec ? ' show' : '')}
            aria-label="返回列表"
            onClick={() => onSelect(null)}
          >
            ‹
          </button>
          <span className="gen-hist-title">{rec ? '学习本详情' : '学习本生成历史'}</span>
          <div className="gen-hist-head-actions">
            <button className="gen-hist-close" aria-label="关闭" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="gen-hist-body">
          {rec ? (
            <HistDetail rec={rec} onOpen={openRecord} onDelete={doDelete} />
          ) : records.length === 0 ? (
            <div className="gen-hist-empty">暂无学习本生成记录</div>
          ) : (
            records.map((r) => (
              <div key={r.ref.id} className="gen-hist-item" onClick={() => onSelect(r.ref.id)}>
                <div className="gen-hist-item-main">
                  <span className="gen-hist-item-title">{r.title || '未命名学习本'}</span>
                  <ItemChip status={r.ref.status} hasPack={!!r.pack} />
                </div>
                <div className="gen-hist-item-sub">
                  {r.ref.questionCount} 题 · {fmtDateTime(r.created)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function HistDetail({
  rec,
  onOpen,
  onDelete,
}: {
  rec: GenPackRecord
  onOpen: () => void
  onDelete: () => void
}) {
  const p = rec.pack
  const meta = p?.meta
  const typesText = meta?.types && meta.types.length ? meta.types.join('、') : p ? deriveTypes(p) : ''
  const chapterTitles = p?.chapters?.map((c) => c.title) ?? []
  const objectives = meta?.objectives && meta.objectives.length ? meta.objectives : chapterTitles
  const inBank = rec.ref.status === 'in_bank'
  const removed = inBank && !p
  const icon = removed ? '❔' : inBank ? '🗂️' : '✍️'
  return (
    <div className="gen-hist-detail">
      <div className="gen-hist-detail-head">
        <span className="gen-hist-detail-icon">{icon}</span>
        <div className="gen-hist-detail-title-main">
          <span className="gen-hist-detail-title">{rec.title || '未命名学习本'}</span>
          <ItemChip status={rec.ref.status} hasPack={!!p} />
        </div>
      </div>
      <div className="gen-hist-detail-sub">
        {rec.ref.questionCount} 题 · {fmtDateTime(rec.created)}
      </div>

      {p?.description && <div className="gen-hist-detail-desc">{p.description}</div>}
      {p?.category && (
        <div className="gen-hist-detail-row">
          <span>分类</span>
          <b>{p?.category || '未分类'}</b>
        </div>
      )}
      {meta?.difficulty && (
        <div className="gen-hist-detail-row">
          <span>难度</span>
          <b>{meta.difficulty}</b>
        </div>
      )}
      {typesText && (
        <div className="gen-hist-detail-row">
          <span>题型</span>
          <b>{typesText}</b>
        </div>
      )}
      {objectives.length > 0 && (
        <div className="gen-hist-detail-row">
          <span>目录</span>
          <b>{objectives.join('、')}</b>
        </div>
      )}
      {meta?.source && (
        <div className="gen-hist-detail-row">
          <span>来源</span>
          <b>{meta.source}</b>
        </div>
      )}
      {!p && <div className="gen-hist-detail-void">（学习本原始数据已清理，仅保留记录信息）</div>}

      <div className="gen-hist-detail-actions">
        <button className="btn sm flex-1" onClick={onOpen}>
          {removed ? '学习本已失效' : rec.ref.status === 'in_bank' ? '去学习库查看' : '查看 / 入库'}
        </button>
        <button className="btn sm danger flex-1" onClick={onDelete}>
          删除记录
        </button>
      </div>
    </div>
  )
}
