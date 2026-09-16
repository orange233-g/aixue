import { useUI } from '../stores/useUIStore'
import AppIcon, { type AppIconName } from './AppIcon'

type TabDef =
  | { id: 'home' | 'packs' | 'kb' | 'me'; icon: AppIconName; label: string }
  | { id: 'generate'; icon: AppIconName; label: string; center: true }

const TABS: TabDef[] = [
  { id: 'home', icon: 'home', label: '首页' },
  { id: 'packs', icon: 'library', label: '学习库' },
  { id: 'generate', icon: 'plus', label: '生成', center: true },
  { id: 'kb', icon: 'archive', label: '知识库' },
  { id: 'me', icon: 'user', label: '我的' },
]

export default function Tabbar() {
  const page = useUI((s) => s.page)
  const navigate = useUI((s) => s.navigate)

  return (
    <div className="tabbar" role="tablist">
      {TABS.map((t) =>
        'center' in t ? (
          <button
            key={t.id}
            type="button"
            className="tab-center"
            aria-label={t.label}
            onClick={() => navigate(t.id)}
          >
            <span className="plus"><AppIcon name={t.icon} size={23} /></span>
          </button>
        ) : (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={page === t.id}
            className={'tab' + (page === t.id ? ' active' : '')}
            onClick={() => navigate(t.id)}
          >
            <span className="ic"><AppIcon name={t.icon} size={21} /></span>
            {t.label}
          </button>
        ),
      )}
    </div>
  )
}
