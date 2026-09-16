import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { useUI, type PageId } from './stores/useUIStore'
import { useAI } from './stores/useAIStore'
import { usePreferences } from './stores/usePreferenceStore'
import Tabbar from './components/Tabbar'
import Modal from './components/Modal'
import PhoneStatusBar from './components/PhoneStatusBar'
import HomePage from './pages/HomePage'
import PacksPage from './pages/PacksPage'
import GeneratePage from './pages/GeneratePage'
import KnowledgeBasePage from './pages/KnowledgeBasePage'
import MePage from './pages/MePage'

// E-07：低频子页采用 React.lazy 延迟加载，避免首屏打包进主 chunk（主包 510kB 预警）
const CatManagePage = lazy(() => import('./pages/CatManagePage'))
const PackDetailPage = lazy(() => import('./pages/PackDetailPage'))
const QuizPage = lazy(() => import('./pages/QuizPage'))
const ReviewPage = lazy(() => import('./pages/ReviewPage'))
const WrongPage = lazy(() => import('./pages/WrongPage'))
const AISettingsPage = lazy(() => import('./pages/AISettingsPage'))
const UsagePage = lazy(() => import('./pages/UsagePage'))
const PreviewPage = lazy(() => import('./pages/PreviewPage'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const PreferencesPage = lazy(() => import('./pages/PreferencesPage'))
const KbReaderPage = lazy(() => import('./pages/KbReaderPage'))
const EmbedSettingsPage = lazy(() => import('./pages/EmbedSettingsPage'))
const KbDetailPage = lazy(() => import('./pages/KbDetailPage'))

export default function App() {
  const page = useUI((s) => s.page)
  const subPage = useUI((s) => s.subPage)
  const toast = useUI((s) => s.toast)
  const appBg = usePreferences((s) => s.appBg)

  // 启动时从 IndexedDB 恢复 AI 配置（API Key / 默认模型），否则刷新后配置丢失
  useEffect(() => {
    useAI.getState().load()
  }, [])

  // 换肤（6.86）：背景色偏好写到 html data 属性，CSS 变量级生效——tab 常驻页不重挂也全局即时变化
  useEffect(() => {
    const root = document.documentElement
    if (appBg === 'default') delete root.dataset.appBg
    else root.dataset.appBg = appBg
  }, [appBg])

  // Android 返回手势/返回键接管（仅 Capacitor 原生环境生效，Web 端跳过）：
  // 子页 → 返回宿主主 tab；主 tab → 2 秒内再按一次退出，避免误触直接回桌面。
  // 未接管时系统默认 super.onBackPressed() 会直接 finish 根 Activity（手势滑 = 闪退到桌面的根因）
  useEffect(() => {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    if (!cap?.isNativePlatform?.()) return
    let remove: (() => void) | undefined
    let lastBack = 0
    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('backButton', () => {
          const ui = useUI.getState()
          if (ui.subPage && ui.goBack()) return
          const now = Date.now()
          if (now - lastBack < 2000) {
            void App.exitApp()
          } else {
            lastBack = now
            useUI.getState().showToast('再按一次退出')
          }
        }),
      )
      .then((handle) => { remove = () => void handle.remove() })
      .catch(() => { /* Web 环境或插件缺失：忽略 */ })
    return () => remove?.()
  }, [])

  const pages: { id: PageId; el: ReactNode }[] = [
    { id: 'home', el: <HomePage /> },
    { id: 'packs', el: <PacksPage /> },
    { id: 'generate', el: <GeneratePage /> },
    { id: 'kb', el: <KnowledgeBasePage /> },
    { id: 'me', el: <MePage /> },
  ]

  const subPages: Record<string, ReactNode> = {
    'cat-manage': <CatManagePage />,
    'pack-detail': <PackDetailPage />,
    'quiz': <QuizPage />,
    'review': <ReviewPage />,
    'wrong': <WrongPage />,
    'ai-settings': <AISettingsPage />,
    'usage': <UsagePage />,
    'preview': <PreviewPage />,
    'import': <ImportPage />,
    'preferences': <PreferencesPage />,
    'kb-reader': <KbReaderPage />,
    'embed-settings': <EmbedSettingsPage />,
    'kb-detail': <KbDetailPage />,
  }

  return (
    <div className={'app' + (import.meta.env.DEV ? ' dev-frame' : '')}>
      {import.meta.env.DEV && <PhoneStatusBar />}
      <div className="pages">
        {pages.map((p) => (
          <div key={p.id} className={'page' + (page === p.id ? ' active' : '') + (p.id === 'generate' ? ' page-gen' : '')}>
            {p.el}
          </div>
        ))}
        {subPage && (
          <div key={subPage} className={'page active' + (subPage === 'kb-reader' ? ' page-full' : '') + (subPage === 'kb-detail' ? ' page-detail' : '')}>
            {/* 兜底必须不透明：.page-full 是透明沉浸设计，lazy chunk 加载期间（fallback null）
                透明空壳会透出下层 active 的主 tab 页——表现为「进阅读器前闪现知识库首页」（真机 bug 6.x） */}
            <Suspense fallback={<div className="page-loading-fallback" />}>{subPages[subPage]}</Suspense>
          </div>
        )}
      </div>
      {!subPage && <Tabbar />}
      <Modal />
      <div className={'toast' + (toast ? ' show' : '')}>{toast}</div>
    </div>
  )
}