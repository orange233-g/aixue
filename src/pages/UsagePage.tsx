import { useEffect, useMemo, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { dbUsage } from '../db'
import { providerLogo } from '../ai/providers'
import {
  WINDOW_OPTIONS,
  windowRange,
  calcKPI,
  byGroup,
  byModel,
  dailySeriesByWindow,
  formatTokens,
  formatCost,
  formatCostPlain,
  type TimeWindow,
} from '../services/usage'
import type { UsageRecord } from '../types'

/** 厂商品牌色（参考橘子工作台 UsageStats BRAND_STYLE） */
const BRAND_STYLE: Record<string, string> = {
  deepseek: '#E8654C',
  zhipu: '#5C7CC4',
  hunyuan: '#6C8FD8',
  openai: '#3E8E8E',
  mimo: '#E8A33D',
  volc: '#7D9B76',
  qwen: '#C58BC0',
}

export default function UsagePage() {
  const navigate = useUI((s) => s.navigate)
  const [win, setWin] = useState<TimeWindow>('all')
  const [records, setRecords] = useState<UsageRecord[]>([])

  useEffect(() => {
    dbUsage.getAll().then(setRecords)
  }, [])

  const filtered = useMemo(() => {
    const { from, to } = windowRange(win)
    return records.filter((r) => r.timestamp >= from && r.timestamp <= to)
  }, [records, win])

  const kpi = useMemo(() => calcKPI(filtered), [filtered])
  // 两级视图：大板块（生题/知识库/闲聊/其他）→ 消耗子类；按大板块折叠展示
  const groups = useMemo(() => byGroup(filtered), [filtered])
  const models = useMemo(() => byModel(filtered), [filtered])
  const series = useMemo(() => dailySeriesByWindow(filtered, win), [filtered, win])
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({})

  const maxTokens = Math.max(...series.map((s) => s.tokens), 1)
  const maxCost = Math.max(...series.map((s) => s.cost ?? 0), 0.000001)

  return (
    <div>
      <div className="row" style={{ margin: '6px 0 12px' }}>
        <button className="btn ghost sm" onClick={() => navigate('me')}>
          ‹ 返回
        </button>
        <div className="page-title" style={{ margin: 0 }}>用量统计</div>
      </div>

      <div className="usage-wins">
        {WINDOW_OPTIONS.map((w) => (
          <button
            key={w.id}
            className={'usage-win' + (win === w.id ? ' on' : '')}
            onClick={() => setWin(w.id)}
          >
            {w.label}
          </button>
        ))}
      </div>

      <div className="usage-kpis">
        <div className="usage-kpi">
          <span className="uk-label">预计花费</span>
          <b className="uk-cost">{kpi.calls ? formatCost(kpi.cost) : '—'}</b>
          <span className="uk-sub">
            {kpi.calls} 次调用 · 缓存命中 {kpi.calls ? `${Math.round(kpi.cacheHitRate * 100)}%` : '—'}
          </span>
        </div>
        <div className="usage-kpi">
          <span className="uk-label">总 Token</span>
          <b>{kpi.calls ? formatTokens(kpi.totalTokens) : '—'}</b>
          <span className="uk-sub">
            输入 {formatTokens(kpi.inputTokens)} · 输出 {formatTokens(kpi.outputTokens)}
          </span>
        </div>
        <div className="usage-kpi">
          <span className="uk-label">缓存命中率</span>
          <b>{kpi.calls ? `${Math.round(kpi.cacheHitRate * 100)}%` : '—'}</b>
          <span className="uk-sub">
            命中 {formatTokens(kpi.cacheReadTokens)} · 未命中 {formatTokens(kpi.cacheMissTokens)}
          </span>
        </div>
      </div>

      {kpi.calls === 0 ? (
        <div className="empty-note">
          <div className="empty-orange">🤖</div>
          <p>暂无用量，去生成学习本试试吧</p>
        </div>
      ) : (
        <>
          <div className="usage-sec">
            <div className="usage-sec-t">按板块 · 大板块 → 子类</div>
            {groups.map((g) => {
              const gpct = kpi.totalTokens ? Math.round((g.totalTokens / kpi.totalTokens) * 100) : 0
              const open = groupsOpen[g.id] !== false // 默认展开
              return (
                <div className="ugp" key={g.id}>
                  <button className="ugp-head" onClick={() => setGroupsOpen((v) => ({ ...v, [g.id]: !(v[g.id] !== false) }))}>
                    <span className="ugp-name">{g.label}</span>
                    <span className="ugp-meta">
                      <span className="ugp-meta-item">{formatTokens(g.totalTokens)} token</span>
                      <span className="ugp-meta-item ugp-cost">{formatCost(g.cost)}</span>
                      <span className="ugp-meta-item">{gpct}%</span>
                    </span>
                    <span className={`ugp-arrow${open ? ' open' : ''}`}>›</span>
                  </button>
                  {open && (
                    <div className="ugp-body">
                      {g.modules.map((m) => {
                        const mpct = kpi.totalTokens ? Math.round((m.totalTokens / kpi.totalTokens) * 100) : 0
                        return (
                          <div className="ur-card" key={m.module}>
                            <div className="ur-head">
                              <span className="ur-name">{m.label}</span>
                            </div>
                            <div className="ur-body">
                              <span className="ur-bar">
                                <i style={{ width: `${mpct}%` }} />
                              </span>
                              <div className="ur-nums">
                                <span className="ur-tok">{formatTokens(m.totalTokens)} token</span>
                                <span className="ur-cost">{formatCost(m.cost)}</span>
                                <span className="ur-pct">{mpct}%</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="usage-sec usage-models">
            <div className="usage-sec-t">按模型</div>
            {models.map((md) => {
              const pct = kpi.totalTokens ? Math.round((md.totalTokens / kpi.totalTokens) * 100) : 0
              return (
                <div className="ur-card" key={`${md.providerId}:${md.model}`}>
                  <div className="ur-head">
                    <span className="ur-logo-wrap">
                      <img className="ur-logo" src={providerLogo(md.providerId)} alt={md.providerId} />
                    </span>
                    <span className="ur-name ur-model">{md.model}</span>
                  </div>
                  <div className="ur-body">
                    <span className="ur-bar" style={{ background: 'var(--primary-soft)' }}>
                      <i style={{ width: `${pct}%`, background: BRAND_STYLE[md.providerId] || 'var(--primary)' }} />
                    </span>
                    <div className="ur-nums">
                      <span className="ur-tok">{formatTokens(md.totalTokens)} token</span>
                      <span className="ur-cost">{formatCost(md.cost)}</span>
                      <span className="ur-pct">{pct}%</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="usage-sec">
            <div className="usage-sec-t">按天用量（token）</div>
            <div className="usage-days">
              {series.map((s) => (
                <div className={'ud-col' + (s.tokens ? ' has' : '')} key={'t' + s.date}>
                  <span className="ud-val">{s.tokens ? formatTokens(s.tokens) : ''}</span>
                  <div className="ud-bar-wrap">
                    <i
                      className="ud-bar"
                      style={{ height: `${Math.max((s.tokens / maxTokens) * 100, s.tokens ? 6 : 2)}%` }}
                    />
                  </div>
                  <span className="ud-lab">{s.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="usage-sec">
            <div className="usage-sec-t">按天花费（元）</div>
            {/* OBS-7：按天图按当前配价实时计算，与上方 KPI/板块/模型的「记录内 cost 快照」口径不同——
                改价后两处数字会不一致，属预期行为；加一行说明避免误读 */}
            <div className="usage-sec-t" style={{ fontSize: 11, fontWeight: 400, opacity: 0.7, marginTop: -4 }}>
              按当前模型配价实时计算 · 汇总口径取记录时快照，改价后两处会有差异
            </div>
            <div className="usage-days">
              {series.map((s) => (
                <div className={'ud-col' + (s.cost != null && s.cost > 0 ? ' has' : '')} key={'c' + s.date}>
                  <span className="ud-val">{s.cost != null ? formatCostPlain(s.cost) : s.tokens ? '无法计算' : ''}</span>
                  <div className="ud-bar-wrap">
                    <i
                      className="ud-bar ud-bar-cost"
                      style={{ height: `${Math.max((s.cost ?? 0) ? ((s.cost ?? 0) / maxCost) * 100 : 0, s.cost != null && s.cost > 0 ? 6 : 2)}%` }}
                    />
                  </div>
                  <span className="ud-lab">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
