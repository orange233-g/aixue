import { useEffect, useRef, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useReview } from '../stores/useReviewStore'
import { useLearning } from '../stores/useLearningStore'
import { usePacks } from '../stores/usePackStore'
import { usePreferences, APP_BG_OPTIONS } from '../stores/usePreferenceStore'
import { greeting, todayText, todayAnswerCount, recentLearningPack, recentPacks, weekStats } from '../services/home'
import { fmtRelative } from '../utils'
import AppIcon from '../components/AppIcon'

export default function HomePage() {
  const navigate = useUI((s) => s.navigate)
  const openPack = useUI((s) => s.openPack)
  const subPage = useUI((s) => s.subPage)
  const { dueCount, loaded, load } = useReview()
  const { loaded: learningLoaded, load: loadLearning } = useLearning()
  const packs = usePacks((s) => s.packs)
  const packsLoaded = usePacks((s) => s.loaded)
  const loadPacks = usePacks((s) => s.load)
  const appBg = usePreferences((s) => s.appBg)
  const setAppBg = usePreferences((s) => s.setAppBg)

  const [bgOpen, setBgOpen] = useState(false)
  const [todayCount, setTodayCount] = useState(0)
  const [recent, setRecent] = useState<{ packId: string; lastAt: number }[]>([])
  const [continuePack, setContinuePack] = useState<{ packId: string; lastAt: number } | null>(null)
  const [week, setWeek] = useState({ answered: 0, streak: 0, mastered: 0 })

  // 首页统计（当日已刷题数 / 最近学习本 / 继续学习）加载
  const refreshHome = async () => {
    const [count, rp, cl, wk] = await Promise.all([todayAnswerCount(), recentPacks(3), recentLearningPack(), weekStats()])
    setTodayCount(count)
    setRecent(rp.map((x) => ({ packId: x.pack.id, lastAt: x.lastAt })))
    setContinuePack(cl ? { packId: cl.pack.id, lastAt: cl.lastAt } : null)
    setWeek(wk)
  }

  useEffect(() => {
    if (!loaded) load()
    if (!learningLoaded) loadLearning()
    if (!packsLoaded) loadPacks()
    void refreshHome()
  }, [loaded, learningLoaded, packsLoaded])

  // 从二级页（复习/刷题/导入等）返回首页时刷新复习到期数、学习本与首页统计，避免陈旧
  const prevSub = useRef(subPage)
  useEffect(() => {
    if (prevSub.current !== null && subPage === null) {
      load()
      loadPacks()
      void refreshHome()
    }
    prevSub.current = subPage
  }, [subPage, load, loadPacks])

  const goPack = (id: string) => {
    navigate('pack-detail', true)
    openPack(id)
  }

  const continueInfo = continuePack ? packs.find((p) => p.id === continuePack.packId) : null
  const recentList = recent
    .map((r) => ({ pack: packs.find((p) => p.id === r.packId), lastAt: r.lastAt }))
    .filter((x): x is { pack: NonNullable<(typeof packs)[number]>; lastAt: number } => Boolean(x.pack))

  const focusPack = continueInfo ?? packs[0]

  return (
    <div className="home-v2">
      <header className="home-v2-hero">
        <div className="home-v2-brand">ai学</div>
        <div className="home-v2-greeting">{greeting()}，<br />今天想学什么？</div>
        <div className="home-v2-date">{todayText()}</div>
        {/* 6.86 换肤入口：圆形按钮显示当前背景色，点开下拉选色（含暗色） */}
        <button
          className="home-bg-btn"
          aria-label="更换背景色"
          onClick={() => setBgOpen((o) => !o)}
        >
          <span
            className="home-bg-dot"
            style={{ background: APP_BG_OPTIONS.find((o) => o.id === appBg)?.color ?? APP_BG_OPTIONS[0].color }}
          />
        </button>
        <svg className="home-v2-sketch" viewBox="0 0 150 125" fill="none" aria-hidden="true">
          <path d="M88 113h51M95 109h36l-3-12H98zM100 97h31l-3-11h-25z" />
          <path d="M118 85V23m0 25c-14-6-19-16-21-25 12 3 18 10 21 18m1 20c11-5 18-14 21-23-11 2-17 8-21 16m-1 23c-11-5-17-12-20-21 10 2 17 8 20 15" />
          <path d="M71 111V72h22v39M74 72c1-9 15-9 17 0M81 72l-3-31m10 31 8-39M77 52l12-3" />
        </svg>
      </header>

      {/* 6.86 弹层挂页面根节点（.app 为定位容器）：hero 有 overflow:hidden，放里面会被裁掉（6.41/6.54 同族）；
          遮罩盖全屏（含 tabbar），点任意处收起，层级低于 Modal(100) */}
      {bgOpen && (
        <>
          <div className="home-bg-mask" onClick={() => setBgOpen(false)} />
          <div className="home-bg-pop" role="menu" aria-label="背景色选择">
            <div className="home-bg-pop-title">背景色</div>
            <div className="home-bg-opts">
              {APP_BG_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  role="menuitemradio"
                  aria-checked={appBg === o.id}
                  className={'home-bg-opt' + (appBg === o.id ? ' active' : '')}
                  onClick={() => { setAppBg(o.id); setBgOpen(false) }}
                >
                  <span className="home-bg-dot" style={{ background: o.color }} />
                  <span className="home-bg-opt-label">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {packs.length === 0 ? (
        <div className="card home-guide home-v2-empty">
          <span className="home-v2-empty-icon"><AppIcon name="book" size={28} /></span>
          <div className="card-title">书架还是空的</div>
          <div className="card-sub mt-8">生成第一个学习本，把想学的内容变成一册练习</div>
          <div className="row mt-12">
            <button className="btn flex-1" onClick={() => navigate('generate')}>
              创建第一册
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="v2-section-title">今日学习</div>
          {focusPack && (
            <section className="home-study-sheet">
              <div className="home-study-cover" aria-hidden="true">
                <span>{focusPack.category || 'Study'}</span>
                <b>{focusPack.title.slice(0, 1)}</b>
              </div>
              <div className="home-study-main">
                <div className="home-study-title">{focusPack.title}</div>
                <div className="home-study-meta">
                  {focusPack.questions.length} 题 · {focusPack.chapters.length} 章节
                  {continuePack && ` · ${fmtRelative(continuePack.lastAt)}`}
                </div>
                <div className="home-study-rule" />
                <div className="home-study-actions">
                  <button className="btn ghost" disabled={dueCount === 0} onClick={() => navigate('review', true)}>今日复习</button>
                  <button className="btn" onClick={() => goPack(focusPack.id)}>继续学习</button>
                </div>
              </div>
            </section>
          )}

          <div className="home-v2-stats">
            <button className="home-v2-stat" disabled={dueCount === 0} onClick={() => navigate('review', true)}>
              <span className="home-v2-stat-icon"><AppIcon name="check" size={21} /></span>
              <span><small>待复习</small><b>{dueCount}</b></span>
            </button>
            <div className="home-v2-stat">
              <span className="home-v2-stat-icon"><AppIcon name="chart" size={21} /></span>
              <span><small>今日已刷</small><b>{todayCount}<em>题</em></b></span>
            </div>
          </div>

          <div className="v2-section-title">最近学习</div>
          <div className="home-recent-list">
            {recentList.length === 0 ? (
              <div className="card-sub">暂无学习记录</div>
            ) : (
              recentList.map(({ pack, lastAt }, i) => (
                <button key={pack.id} className="home-recent-book" onClick={() => goPack(pack.id)}>
                  <span className={'home-recent-cover tone-' + ((i % 3) + 1)}><AppIcon name="book" size={22} /></span>
                  <span className="home-pack-main">
                    <span className="home-pack-title">{pack.title}</span>
                    <span className="home-pack-sub">{pack.questions.length} 题 · {pack.chapters.length} 章节 · {fmtRelative(lastAt)}</span>
                  </span>
                  <span className="home-recent-chevron">›</span>
                </button>
              ))
            )}
          </div>

          <div className="home-week-summary">
            <span>本周已刷 <b>{week.answered}</b> 题</span>
            <span>连续 <b>{week.streak}</b> 天</span>
            <span>已掌握 <b>{week.mastered}</b></span>
          </div>
        </>
      )}
    </div>
  )
}
