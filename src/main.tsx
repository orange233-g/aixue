import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './theme-v2.css'
import { log } from './utils/log'
import { usePreferences } from './stores/usePreferenceStore'
import { hydrateImportedModels } from './ai/embed/registry'

// 全局兜底：未捕获异常 / 未处理 Promise 拒绝都落日志，方便改 bug 时直接翻日志定位
window.addEventListener('error', (e) => {
  log('error', 'global', '未捕获异常', {
    message: e.message, source: e.filename, line: e.lineno, col: e.colno,
  })
})
window.addEventListener('unhandledrejection', (e) => {
  log('warn', 'global', '未处理的 Promise 拒绝', {
    reason: e.reason instanceof Error ? e.reason.message : String(e.reason),
    stack: e.reason instanceof Error ? e.reason.stack : undefined,
  })
})

// 存储持久化申请（真机「配置过的 API 隔一段时间丢失」排查）：WebView/浏览器默认 best-effort 存储，
// 存储压力大时（614MB 向量模型缓存入同源 IndexedDB 后尤甚）系统可能整源淘汰——ai-config 与模型
// 缓存同生共死。persist() 授予后本源数据不再被自动回收；结果落日志便于在真机上确认授予情况。
void (async () => {
  try {
    if (!navigator.storage?.persist) return
    const granted = await navigator.storage.persist()
    let usage = ''
    try {
      const est = await navigator.storage.estimate()
      if (est?.usage != null) usage = `，已用 ${(est.usage / 1048576).toFixed(0)}MB`
    } catch {
      /* estimate 不可用忽略 */
    }
    log('info', 'global', `存储持久化申请${granted ? '已授予' : '被拒绝（best-effort，仍有自动淘汰风险）'}${usage}`)
  } catch {
    /* 老环境无该 API，忽略 */
  }
})()

// 首绘前要就绪的两件事：
// - 换肤偏好（6.86）：否则暗色用户每次冷启动都先闪一屏米白再变黑；800ms 兜底，IDB 异常也不会卡住 UI。
// - 导入的向量模型元数据：getEmbedModel 在渲染期同步调用（建库弹窗/知识库详情），必须先读回内存。
const root = createRoot(document.getElementById('root')!)
void Promise.all([
  Promise.race([
    usePreferences.getState().load().catch(() => { /* 偏好读失败按默认色出 UI */ }),
    new Promise((r) => setTimeout(r, 800)),
  ]),
  hydrateImportedModels().catch(() => { /* 导入模型读失败按无导入模型出 UI */ }),
]).then(() => {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})

// 向量模型缓存自动清理兜底（6.90 全自动生命周期）：清理「不再被任何知识库绑定」的**内置**模型缓存，
// 释放存储空间；用户导入的模型是主动资产，不参与自动清理（只能显式删除）。后台执行不阻塞启动。
void (async () => {
  try {
    const { dbKB } = await import('./db')
    const { gcEmbedCaches } = await import('./ai/embed/storage')
    const kbs = await dbKB.getAll()
    const removed = await gcEmbedCaches(kbs.map((k) => k.embedModel).filter((x): x is string => Boolean(x)))
    if (removed.length) log('info', 'global', `已自动释放未使用向量模型缓存: ${removed.join('、')}`)
  } catch {
    /* 清理失败静默，下次启动重试 */
  }
})()
