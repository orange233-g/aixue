/**
 * 调试日志面板（从 GeneratePage 抽出共享组件，供「我的」tab 展示）。
 * 列出最近日志（含模型调用 / 生题 / 知识库 / 操作 / 报错），支持展开详情、复制全部、清空。
 */
import { useState } from 'react'
import type { LogEntry } from '../utils/log'
import { getLogs, clearLogs, exportLogs, formatData, LOG_MAX } from '../utils/log'
import { useUI } from '../stores/useUIStore'

export default function LogPanel({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>(() => getLogs())
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({})
  const refresh = () => setLogs(getLogs())

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(exportLogs())
      useUI.getState().showToast('已复制全部日志')
    } catch {
      useUI.getState().showToast('复制失败')
    }
  }
  const clear = () => {
    if (!window.confirm('确定清空全部运行日志？')) return
    clearLogs()
    refresh()
  }

  return (
    <div className="dlg-mask" onClick={onClose}>
      <div className="log-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="log-title">
          运行日志 <span className="log-count">{logs.length} / {LOG_MAX}</span>
        </div>
        <div className="log-list">
          {logs.length === 0 && <div className="log-empty">暂无日志…</div>}
          {logs.map((it) => (
            <div key={it.id} className={`log-item ${it.level}`}>
              <div className="log-head">
                <span className="log-time">{new Date(it.t).toLocaleTimeString()}</span>
                <span className="log-lv">{it.level}</span>
                <span className="log-scope">{it.scope}</span>
                <span className="log-msg">{it.msg}</span>
              </div>
              {it.data !== undefined && (
                <button
                  className="log-toggle"
                  onClick={() => setOpenRows((v) => ({ ...v, [it.id]: !v[it.id] }))}
                >
                  {openRows[it.id] ? '收起' : '详情'}
                </button>
              )}
              {openRows[it.id] && it.data !== undefined && (
                <pre className="log-data">{formatData(it.data)}</pre>
              )}
            </div>
          ))}
        </div>
        <div className="log-actions">
          <button className="gen-topbtn primary" onClick={copy}>复制全部</button>
          <button className="gen-topbtn danger" onClick={clear}>清空</button>
          <button className="gen-topbtn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}