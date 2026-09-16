import { useEffect, useState } from 'react'

function fmt(now: Date) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * 开发期预览用模拟手机状态栏。
 * - 仅 `import.meta.env.DEV` 时渲染，生产构建（导出/打包）会被剔除，不进入产物。
 * - 以普通文档流占位（flex:none 放在 .app 顶部），把页面内容整体向下让开，
 *   模拟真机状态栏避让，避免像旧工作台那样内容被遮到状态栏下方。
 * - 真机安全区避让由 .app 的 env(safe-area-inset-top) 承担，二者不叠加。
 */
export default function PhoneStatusBar() {
  const [time, setTime] = useState(() => fmt(new Date()))
  useEffect(() => {
    const t = setInterval(() => setTime(fmt(new Date())), 30000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="phone-statusbar">
      <span className="psb-time">{time}</span>
      <span className="psb-right">
        <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor" aria-hidden="true">
          <rect x="0" y="7" width="2.4" height="4" rx="1" />
          <rect x="4.6" y="5" width="2.4" height="6" rx="1" />
          <rect x="9.2" y="3" width="2.4" height="8" rx="1" />
          <rect x="13.8" y="1" width="2.4" height="10" rx="1" />
        </svg>
        <svg width="15" height="11" viewBox="0 0 15 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <path d="M1 4.6a9.2 9.2 0 0 1 13 0" />
          <path d="M3.8 7.6a5 5 0 0 1 7.4 0" />
          <circle cx="7.5" cy="9.6" r="1.1" fill="currentColor" stroke="none" />
        </svg>
        <svg width="23" height="11" viewBox="0 0 23 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <rect x="0.6" y="0.6" width="17.4" height="9.8" rx="2.6" />
          <rect x="20" y="3.2" width="2" height="4.6" rx="1" />
          <rect x="2.4" y="2.4" width="11" height="6.2" rx="1.4" fill="currentColor" stroke="none" />
        </svg>
      </span>
    </div>
  )
}