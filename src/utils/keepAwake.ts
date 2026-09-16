import { useEffect } from 'react'

/**
 * 屏幕唤醒锁（Web Wake Lock API）：生成/整理等长任务期间保持设备亮屏，
 * 避免 Android WebView 因屏幕熄灭/熄屏省电而被挂起，导致任务假性停摆。
 * 说明：这只在 App 前台生效；用户主动切到别的 App 属系统后台挂起 WebView，属系统级约束，此锁无法阻止。
 */
export function useKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active) return
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return

    let sentinel: WakeLockSentinel | null = null
    let disposed = false
    // 失败/被释放后于恢复可见时自动补请（如短暂熄屏、通知下拉后回前台）
    const request = async () => {
      if (disposed) return
      try {
        sentinel = await navigator.wakeLock.request('screen')
        sentinel.addEventListener('release', () => {
          if (!disposed && document.visibilityState === 'visible') request()
        })
      } catch {
        /* 浏览器拒绝/后台态则忽略，静默降级 */
      }
    }
    request()

    const onVis = () => {
      if (document.visibilityState === 'visible' && !sentinel) request()
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVis)
      sentinel?.release().catch(() => {})
      sentinel = null
    }
  }, [active])
}