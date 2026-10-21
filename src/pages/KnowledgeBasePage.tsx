import { useEffect, useState, type ReactNode } from 'react'
import { useUI } from '../stores/useUIStore'
import { useKB } from '../stores/useKBStore'
import { useModal } from '../stores/useModalStore'
import type { KBDoc } from '../types'
import { listEmbedModels } from '../ai/embed/registry'
import { modelDisplayName, modelShortName } from '../ai/embed/display'
import AppIcon, { type AppIconName } from '../components/AppIcon'

const STATUS: Record<KBDoc['status'], { text: string; cls: string }> = {
  indexing: { text: '整理中', cls: 'warning' },
  ready: { text: '就绪', cls: 'success' },
  failed: { text: '失败', cls: 'danger' },
}

/** 状态徽章语义色对应的图标（对齐效果图：就绪✓ / 整理中⏱ / 失败⚠） */
const STATE_ICON: Record<string, AppIconName> = {
  success: 'check',
  warning: 'chart',
  danger: 'download',
}

/* ---------------- 卡片外观主题（tone 0-9：书脊色 + 书脊小图标 + 页面插图，建库时随机持久化） ---------------- */
export const KB_TONES = 10

/** 旧库无 tone：按 id 稳定哈希分配，同一库每次渲染一致，不写库迁移 */
function toneOf(kb: { id: string; tone?: number }): number {
  if (typeof kb.tone === 'number') return ((kb.tone % KB_TONES) + KB_TONES) % KB_TONES
  let h = 0
  for (let i = 0; i < kb.id.length; i++) h = (h * 31 + kb.id.charCodeAt(i)) >>> 0
  return h % KB_TONES
}

/** 书脊底部小图标 ×10（24×24 线条，currentColor 金色随书脊） */
const SPINE_ICONS: ReactNode[] = [
  // 0 打开的书
  <svg className="book" key="s0" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5c-2-1.6-5.5-2-8-1.6V19c2.5-.4 6 0 8 1.6 2-1.6 5.5-2 8-1.6V3.4c-2.5-.4-6 0-8 1.6z"/><path d="M12 5v15.6"/></svg>,
  // 1 书签
  <svg className="book" key="s1" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h10v18l-5-4.2L7 21z"/></svg>,
  // 2 波浪
  <svg className="book" key="s2" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 9c2.5-2.4 5-2.4 7.5 0S15.5 11.4 18 9M3 15c2.5-2.4 5-2.4 7.5 0s5 2.4 7.5 0"/></svg>,
  // 3 茶杯
  <svg className="book" key="s3" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 10h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM16 11h2a2 2 0 1 1 0 4h-2M9 7c0-1 .8-1.2.8-2M12.5 7c0-1 .8-1.2.8-2"/></svg>,
  // 4 星月
  <svg className="book" key="s4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 3.5A7.5 7.5 0 1 0 20.5 12 6 6 0 0 1 14 3.5z"/><path d="M17 4.5v3M15.5 6h3M6 16.5v2M5 17.5h2"/></svg>,
  // 5 羽毛笔
  <svg className="book" key="s5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 4c-6 0-10 4-11.5 9L5 20M7.5 13.5C11 13 15 10 17 6M5 20l3.5-2.5"/></svg>,
  // 6 叶子
  <svg className="book" key="s6" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18C6 9 12 4 20 4c0 9-5 14-14 14z"/><path d="M6 18c2-5 6-9 10-11"/></svg>,
  // 7 帆船
  <svg className="book" key="s7" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 17h16l-2.5 3.5h-11zM12 3v14M12 4c4 1.5 6 4.5 6.5 8H12M12 7c-2.5 1.2-4 3.2-4.5 5.5H12"/></svg>,
  // 8 山与日
  <svg className="book" key="s8" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 19L9.5 8l4 6.5L16 11l5 8z"/><circle cx="17.5" cy="5.5" r="2"/></svg>,
  // 9 热气球
  <svg className="book" key="s9" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3a7 7 0 0 1 7 7c0 3-2.5 5.5-5 6.5h-4C7.5 15.5 5 13 5 10a7 7 0 0 1 7-7z"/><path d="M9.5 16.5L10 20h4l.5-3.5M9 10c0-3 1.2-5.5 3-7 1.8 1.5 3 4 3 7 0 1.8-.6 3.4-1.5 4.5h-3C9.6 13.4 9 11.8 9 10z"/></svg>,
]

/** 书页中部装饰插图 ×10（110×95 线条，淡棕 currentColor） */
const SKETCHES: ReactNode[] = [
  // 0 笔记本 + 钢笔（原版）
  <svg className="kb-volume-sketch" key="k0" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M12 19h54v62H12zM20 29h35M20 38h28M20 47h33M70 68l24-43 7 4-24 43-10 8zM91 31l7 4"/><path d="m67 80 10-8"/></svg>,
  // 1 山与太阳
  <svg className="kb-volume-sketch" key="k1" viewBox="0 0 110 95" fill="none" aria-hidden="true"><circle cx="78" cy="26" r="11"/><path d="M8 78 38 34l18 28 12-16 30 32M8 78h92"/><path d="M38 34l-6 26h14z"/></svg>,
  // 2 海龟
  <svg className="kb-volume-sketch" key="k2" viewBox="0 0 110 95" fill="none" aria-hidden="true"><ellipse cx="55" cy="50" rx="26" ry="19"/><path d="M33 42c-8-2-13 1-15 6 5 3 11 2 15-1M77 42c8-2 13 1 15 6-5 3-11 2-15-1M40 66c-4 5-4 9-2 12 4-1 7-4 8-8M70 66c4 5 4 9 2 12-4-1-7-4-8-8"/><path d="M55 36v28M43 40l4 20M67 40l-4 20M38 50h34"/></svg>,
  // 3 茶杯热气
  <svg className="kb-volume-sketch" key="k3" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M25 45h48v18a16 16 0 0 1-16 16H41a16 16 0 0 1-16-16zM73 48h8a8 8 0 1 1 0 16h-8M20 85h62"/><path d="M40 34c0-4 4-5 4-9M52 34c0-4 4-5 4-9M64 34c0-4 4-5 4-9"/></svg>,
  // 4 星月夜
  <svg className="kb-volume-sketch" key="k4" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M68 12A26 26 0 1 0 90 47 21 21 0 0 1 68 12z"/><path d="M30 20v6M27 23h6M46 58v5M43.5 60.5h5M22 44v5M19.5 46.5h5M62 74v5M59.5 76.5h5"/><path d="M14 86c8-5 16 5 24 0s16 5 24 0 16 5 24 0"/></svg>,
  // 5 羽毛笔与墨水
  <svg className="kb-volume-sketch" key="k5" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M88 12C60 16 42 34 36 58l-6 24M36 58c18-3 34-16 42-32M30 82l12-10"/><path d="M14 82h20l-3-14H17zM20 68v-6h8v6"/></svg>,
  // 6 盆栽
  <svg className="kb-volume-sketch" key="k6" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M38 60h34l-5 24H43zM55 60V34"/><path d="M55 44c-12 0-20-8-22-20 12 0 20 8 22 20zM55 36c10-2 16-9 17-20-10 2-16 9-17 20z"/></svg>,
  // 7 帆船
  <svg className="kb-volume-sketch" key="k7" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M14 78h82l-10 12H26zM56 14v62"/><path d="M56 16c20 7 30 22 32 40H56zM52 26c-13 6-20 17-22 30h22"/></svg>,
  // 8 书塔与星
  <svg className="kb-volume-sketch" key="k8" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M24 82h56M30 68h44M34 54h38"/><path d="M22 82V68h16v14M38 68V54h16v14M54 54V40h16v14"/><path d="M84 22v8M80 26h8M72 38v5M69.5 40.5h5M90 44v5M87.5 46.5h5"/></svg>,
  // 9 热气球
  <svg className="kb-volume-sketch" key="k9" viewBox="0 0 110 95" fill="none" aria-hidden="true"><path d="M55 8c18 0 30 12 30 27 0 13-10 22-21 26H46C35 57 25 48 25 35c0-15 12-27 30-27z"/><path d="M46 61l3 12h12l3-12M44 34c0-12 5-21 11-26 6 5 11 14 11 26 0 8-2.5 15-6.5 19h-9C46.5 49 44 42 44 34z"/><path d="M49 80h12v8H49z"/></svg>,
]

/** 向量模型短名（卡片状态 tag 用） */
function idxShort(id?: string): string {
  return modelShortName(id)
}

/** 卡状态：就绪细分 语义·模型 / 待生成索引 / 关键词检索。
 *  整理/建索引进度不再塞进徽标（长文本挤占 ⋮ 菜单空间、把书名顶偏，真机 6.x）——
 *  徽标只留短状态，进度统一在列表上方任务条展示（含 N/M 与秒表）。 */
function cardState(
  kb: { id: string; status: KBDoc['status']; embedStatus?: KBDoc['embedStatus']; embedModel?: string },
  embedTask: { kbId: string; done: number; total: number; elapsed?: number; prepare?: string } | null,
  task: { id: string; startedAt: number } | null,
): { text: string; cls: string } {
  if (embedTask && embedTask.kbId === kb.id) {
    return { text: '建索引…', cls: 'warning' }
  }
  if (kb.status === 'ready') {
    if (kb.embedStatus === 'ready') return { text: `语义·${idxShort(kb.embedModel)}`, cls: 'success' }
    if (kb.embedModel) return { text: `${idxShort(kb.embedModel)} · 待生成索引`, cls: 'warning' }
    return { text: '关键词检索', cls: 'success' }
  }
  if (kb.status === 'indexing' && task && task.id === kb.id) {
    return { text: '整理中…', cls: 'warning' }
  }
  const st = STATUS[kb.status]
  return { text: st.text, cls: st.cls }
}

/** 模型展示名（去掉「（内置默认）」等后缀，显示完整型号） */
const modelFullName = modelDisplayName

export default function KnowledgeBasePage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const modal = useModal()
  const { bases, loaded, task, load, create, openDetail, embedTask, rename, remove } = useKB()

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  // 卡片右上角三点菜单：当前展开的库 id
  const [menuId, setMenuId] = useState<string | null>(null)
  // 建库弹窗：检索方式下拉（默认 BM25；向量模型全量列出，模型文件在生成索引时按需准备——创建只做选择，不阻塞弹窗）
  const [modeId, setModeId] = useState('bm25')
  const [modeOpen, setModeOpen] = useState(false)

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

  useEffect(() => {
    if (!createOpen) {
      // BUG-8 修复：关闭（✕/取消/遮罩任一路径）一律重置表单，重开不再残留上次输入的库名
      setName('')
      setModeId('bm25')
      setModeOpen(false)
    }
  }, [createOpen])

  // 整理/索引进行中：每 100ms 重渲染一次，让卡片「整理中 · X.XS」实时跳秒
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!embedTask && !task) return
    const iv = window.setInterval(() => setTick((n) => n + 1), 100)
    return () => window.clearInterval(iv)
  }, [embedTask?.kbId, task?.id])

  // ⋮ 菜单「点其他区域收起」：document 捕获监听 + closest 判断。
  // 不用卡内 fixed mask——卡片 filter:drop-shadow 会让 fixed 后代以卡片为包含块（mask 盖不满视口）；
  // 也不用页面级 mask——命中时序与层叠易出边角问题。捕获阶段拦 mousedown/touchstart 最可靠。
  useEffect(() => {
    if (!menuId) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('.kb-volume-menu-open')) return // 菜单/所在卡内部交由各自 handler
      setMenuId(null)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
    }
  }, [menuId])

  /** 新建知识库：先选检索方式，不强制导文件 → 建空库并进详情页，再从详情导入数据源（借鉴 Cherry） */
  const handleCreate = async () => {
    if (creating) return
    const n = name.trim()
    if (!n) return showToast('请先给知识库起个名字')
    setCreating(true)
    try {
      // 向量模型文件不在建库时准备：创建只选择检索方式（秒开秒关）；文件准备（本地复制）延迟到
      // 详情页点「生成索引」时进行——那里才有真实的进度展示场景，避免建库弹窗卡十几秒
      const id = await create(n, [], modeId === 'bm25' ? undefined : modeId)
      setName('')
      setCreateOpen(false)
      if (id) {
        openDetail(id)
        navigate('kb-detail', true)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '创建知识库失败')
    } finally {
      setCreating(false)
    }
  }

  const openKb = (kb: KBDoc) => {
    // 先收 ⋮ 菜单：菜单开着直接点卡片进详情，卡片/菜单会浮在详情层上（真机 bug 6.x）
    setMenuId(null)
    openDetail(kb.id)
    navigate('kb-detail', true)
  }

  const handleRename = (kb: KBDoc) => {
    setMenuId(null)
    modal.prompt('重命名知识库', '输入新名称', (val) => {
      if (val?.trim()) rename(kb.id, val.trim())
    })
  }

  const handleRemove = (kb: KBDoc) => {
    setMenuId(null)
    modal.confirm('删除知识库', `确定删除「${kb.name}」？库内整理产物与源文件证据将被清除，且无法恢复。`, () => {
      remove(kb.id)
      showToast('已删除知识库')
    })
  }

  const optionRow = (id: string, icon: ReactNode, label: ReactNode, sub?: string) => (
    <button
      type="button"
      className={'kb-mode-opt' + (modeId === id ? ' on' : '')}
      onClick={(e) => { e.stopPropagation(); setModeId(id); setModeOpen(false) }}
    >
      {icon}
      <span className="flex-1">
        <span className="kb-mode-label">{label}</span>
        {sub && <span className="kb-mode-sub">{sub}</span>}
      </span>
      {modeId === id && <AppIcon name="check" size={16} />}
    </button>
  )

  const selectedMode = modeId === 'bm25' ? null : listEmbedModels().find((m) => m.id === modeId)

  return (
    <div className="kb-v2-page">
      <header className="kb-v2-head">
        <div className="flex-1">
          <div className="page-title">知识库</div>
          <div className="kb-v2-subtitle">把资料变成可复习、可出题的知识</div>
        </div>
        <button className="btn ghost sm kb-v2-create" onClick={() => setCreateOpen(true)}><AppIcon name="plus" size={16} /> 新建资料库</button>
      </header>

      {task && (
        <div className="kb-task">
          <div className="kb-task-head">
            <span className="kb-task-dot" />
            <span className="kb-task-msg flex-1">正在整理「{task.name}」…（本地处理，不耗 token）</span>
          </div>
        </div>
      )}

      {/* 语义索引生成进度条：从卡片徽标移到任务条（徽标只留短状态，避免挤占 ⋮ 菜单与书名，真机 6.x） */}
      {embedTask && (
        <div className="kb-task">
          <div className="kb-task-head">
            <span className="kb-task-dot" />
            <span className="kb-task-msg flex-1">
              {/* 准备阶段显示文件复制进度；生成索引进度+计时（RC-02：无括号补充提示） */}
              {embedTask.prepare ??
                `正在生成语义索引 ${embedTask.done}/${embedTask.total} 段 · ${((embedTask.elapsed ?? 0) / 1000).toFixed(1)}S`}
            </span>
          </div>
        </div>
      )}

      {!loaded && <div className="empty"><div className="em">⏳</div><div className="es">加载中...</div></div>}

      {loaded && bases.length === 0 && !task && (
        <div className="empty kb-v2-empty">
          <div className="em"><AppIcon name="archive" size={34} /></div>
          <div className="et">还没有资料库</div>
          <div className="es">先选择检索方式创建资料库，再导入资料文件；本地清洗分块不耗 token，出题时可引用</div>
          <button className="btn mt-12" onClick={() => setCreateOpen(true)}>新建资料库</button>
        </div>
      )}

      <div className="bookshelf">
        {bases.map((kb) => {
          const state = cardState(kb, embedTask, task)
          const tone = toneOf(kb)
          return (
            <div key={kb.id} className="kb-cell">
              <article className={'kb-volume tone-' + tone + (menuId === kb.id ? ' kb-volume-menu-open' : '')} onClick={() => openKb(kb)} role="button" tabIndex={0}>
                <div className="kb-volume-spine">
                  {SPINE_ICONS[tone]}
                </div>
                <div className="kb-volume-page">
                  <div className="kb-volume-top">
                    <div className={'kb-volume-state ' + state.cls}>
                      <AppIcon name={STATE_ICON[state.cls] ?? 'check'} size={10} />
                      {/* 文字必须包 span：text-overflow 对 flex 容器无效，直接放容器里省略号不生效
                          （真机 bug 6.x：整理中长文本挤爆卡片、把 ⋮ 菜单挤出裁掉） */}
                      <span className="kbvs-text">{state.text}</span>
                    </div>
                    <span className="pack-menu-wrap" onClick={(e) => e.stopPropagation()}>
                      <button className="pack-menu" aria-label="知识库操作" onClick={(e) => { e.stopPropagation(); setMenuId(menuId === kb.id ? null : kb.id) }}>
                        <AppIcon name="more" size={18} />
                      </button>
                      {menuId === kb.id && (
                        <div className="pack-menu-pop">
                          <button onClick={() => handleRename(kb)}>重命名</button>
                          <button className="danger" onClick={() => handleRemove(kb)}>删除知识库</button>
                        </div>
                      )}
                    </span>
                  </div>
                  <div className="kb-volume-mid">
                    <div className="kb-volume-title">{kb.name}</div>
                    {kb.status === 'failed' && <div className="kb-volume-err">{kb.error || '整理失败'}</div>}
                    {SKETCHES[tone]}
                  </div>
                </div>
              </article>
            </div>
          )
        })}
        {/* RC-01/真机反馈：取消「奇数本补虚位」设计——补位空框观感突兀（单本/成排均不补） */}
      </div>

      {loaded && bases.length > 0 && <div className="kb-local-note"><AppIcon name="database" size={15} /> 所有资料仅保存在本机</div>}

      {/* 新建知识库弹窗：名称 + 检索方式（默认 BM25，仅列已配置向量模型，带头像）→ 建空库进详情 */}
      {createOpen && (
        <div className="dlg-mask" onClick={() => setCreateOpen(false)}>
          <div className="kb-dlg" onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head">
              <span className="dlg-title">新建知识库</span>
              <button className="dlg-close" aria-label="关闭" onClick={() => setCreateOpen(false)}>✕</button>
            </div>
            <div className="dlg-body">
              <div className="field">
                <label className="fl">知识库名称</label>
                <input
                  className="input"
                  placeholder="如：海洋知识、Python 面试题库"
                  value={name}
                  maxLength={20}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
              </div>
              <div className="field">
                <label className="fl">检索方式</label>
                <div className="kb-mode-dd" onClick={() => setModeOpen((o) => !o)}>
                  <span className="flex-1 kb-mode-dd-val">
                    {selectedMode ? (
                      <>
                        <img className="avatar-logo sm" src={selectedMode.logo} alt={selectedMode.name} />
                        <span>{modelFullName(selectedMode)}</span>
                      </>
                    ) : (
                      <><span className="kb-mode-emoji">🔍</span><span>关键词检索（BM25）</span></>
                    )}
                  </span>
                  <span className="kb-mode-caret">▾</span>
                  {modeOpen && (
                    <div className="kb-mode-pop" onClick={(e) => e.stopPropagation()}>
                      {optionRow('bm25', <span className="kb-mode-emoji">🔍</span>, '关键词检索（BM25）', '按关键词匹配，速度最快，无模型开销')}
                      {listEmbedModels().map((m) =>
                        optionRow(
                          m.id,
                          <img className="avatar-logo sm" src={m.logo} alt={m.name} />,
                          modelFullName(m),
                          m.note,
                        ),
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="kb-dlg-hint">
                支持导入：txt / md / csv / 代码 / docx / xlsx / odt
              </div>
            </div>
            <div className="dlg-foot">
              <button className="btn plain" onClick={() => setCreateOpen(false)}>取消</button>
              <button className="btn primary" disabled={creating} onClick={handleCreate}>
                {creating ? '创建中…' : '创建知识库'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}