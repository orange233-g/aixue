import { useEffect, useRef, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useModal } from '../stores/useModalStore'
import { useAI, isProviderReady } from '../stores/useAIStore'
import { listProviders, providerLogo, isPresetProvider } from '../ai/providers'
import { PROVIDER_MANIFEST } from '../ai/providers/manifest'
import { AIError } from '../ai/types'
import { normalizeProviderBaseUrl, resolveBaseUrlOrigin, isCustomProviderHost } from '../ai/baseUrl'
import type { PriceItem, ProviderCfg } from '../types'
import { hasPriceCfg } from '../ai/usage/cost'

/** 厂商品牌信息（参考橘子工作台 ai.ts 的 brand + UsageStats 的 BRAND_STYLE） */
const BRAND: Record<string, { brand: string; color: string }> = {
  deepseek: { brand: '深度求索', color: '#E8654C' },
  zhipu: { brand: 'GLM', color: '#5C7CC4' },
  hunyuan: { brand: 'Hunyuan', color: '#6C8FD8' },
  openai: { brand: 'ChatGPT', color: '#3E8E8E' },
  mimo: { brand: 'Xiaomi', color: '#E8A33D' },
  volc: { brand: '豆包', color: '#7D9B76' },
  qwen: { brand: 'Qwen', color: '#C58BC0' },
}

/** 一天的小时时数（0-23），用于自定义时段的起止选择 */
const HOURS = Array.from({ length: 24 }, (_, k) => k)

interface Draft extends ProviderCfg {
  expanded: boolean
  showKey: boolean
  busy: 'none' | 'fetch' | 'test'
  msg: string
  msgOk: boolean
}

function emptyDraft(): Draft {
  return {
    apiKey: '',
    model: '',
    baseUrl: '',
    fetchedModels: [],
    price: {},
    disableThinking: false,
    expanded: false,
    showKey: false,
    busy: 'none',
    msg: '',
    msgOk: false,
  }
}

function errText(e: unknown): string {
  if (e instanceof AIError) {
    if (e.code === 'AUTH_FAILED') return 'API Key 无效，请检查后重试'
    // OBS-6：代理白名单拒绝等带原始信息，直接展示（比笼统「网络不可达」更能定位问题）
    if (e.code === 'NETWORK') return e.message.startsWith('proxy:') ? e.message : '网络不可达，请检查网络或 API 地址'
    if (e.code === 'MODEL_NOT_FOUND') return '模型不存在或地址错误'
    if (e.code === 'RATE_LIMITED') return '请求过于频繁，请稍后再试'
    if (e.code === 'TIMEOUT') return '连接超时，请检查网络或 API 地址'
    return e.message
  }
  return e instanceof Error ? e.message : '未知错误'
}

export default function AISettingsPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const confirm = useModal((s) => s.confirm)
  const { providers, defaultId, setProvider, setDefault, clearProvider, fetchModels, testConnection } = useAI()
  const customProviders = useAI((s) => s.customProviders)
  const addCustomProvider = useAI((s) => s.addCustomProvider)
  const removeCustomProvider = useAI((s) => s.removeCustomProvider)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  // 在飞连接/测试的取消句柄，key=providerId；重复点击与卸载时统一 abort，避免悬挂 loading
  const abortRefs = useRef<Record<string, AbortController>>({})
  // 「添加自定义提供商」内联表单态
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addUrl, setAddUrl] = useState('')

  // 预置 + 自定义合并列表（listProviders 幂等补注册，保证网关/列表两处一致）
  const providerList = listProviders(customProviders)

  useEffect(() => {
    return () => {
      for (const c of Object.values(abortRefs.current)) c.abort()
      abortRefs.current = {}
    }
  }, [])

  useEffect(() => {
    const init: Record<string, Draft> = {}
    for (const p of providerList) {
      const saved = providers[p.id]
      init[p.id] = { ...emptyDraft(), ...saved, expanded: false, showKey: false, busy: 'none', msg: '', msgOk: false }
    }
    setDrafts(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 自定义提供商补齐草稿（只补缺，不覆盖在编辑的草稿）：新建后 / 挂载晚于配置加载时兜底
  useEffect(() => {
    setDrafts((d) => {
      let changed = false
      const next = { ...d }
      for (const p of providerList) {
        if (!next[p.id]) {
          next[p.id] = { ...emptyDraft(), ...(providers[p.id] ?? {}), expanded: false, showKey: false, busy: 'none', msg: '', msgOk: false }
          changed = true
        }
      }
      return changed ? next : d
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerList, providers])

  const patch = (id: string, p: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...p } }))

  const configured = providerList.filter((p) => (drafts[p.id]?.apiKey ?? '').trim() !== '')

  const handleFetch = async (id: string) => {
    const d = drafts[id]
    patch(id, { busy: 'fetch', msg: '' })
    // V2-I04：上次请求若仍在飞则先取消；用每次新建的 controller 供重试/卸载时中断，避免悬挂 loading
    abortRefs.current[id]?.abort()
    const ctrl = new AbortController()
    abortRefs.current[id] = ctrl
    try {
      const models = await fetchModels(id, d, ctrl.signal)
      if (ctrl.signal.aborted || abortRefs.current[id] !== ctrl) return
      patch(id, { fetchedModels: models, busy: 'none', msg: `已获取 ${models.length} 个模型`, msgOk: true })
      if (models.length && !d.model) patch(id, { model: models[0] })
    } catch (e) {
      if (ctrl.signal.aborted || abortRefs.current[id] !== ctrl) return
      patch(id, { busy: 'none', msg: `获取失败：${errText(e)}`, msgOk: false })
    } finally {
      if (abortRefs.current[id] === ctrl) delete abortRefs.current[id]
    }
  }

  const handleTest = async (id: string) => {
    const d = drafts[id]
    patch(id, { busy: 'test', msg: '' })
    abortRefs.current[id]?.abort()
    const ctrl = new AbortController()
    abortRefs.current[id] = ctrl
    try {
      const r = await testConnection(id, d, ctrl.signal)
      if (ctrl.signal.aborted || abortRefs.current[id] !== ctrl) return
      patch(id, { busy: 'none', msg: r.message, msgOk: true })
    } catch (e) {
      if (ctrl.signal.aborted || abortRefs.current[id] !== ctrl) return
      patch(id, { busy: 'none', msg: `连接失败：${errText(e)}`, msgOk: false })
    } finally {
      if (abortRefs.current[id] === ctrl) delete abortRefs.current[id]
    }
  }

  const handleClear = (id: string) => {
    confirm('清除配置', '将删除已填写的 API Key 与模型列表，确定清除？', async () => {
      try {
        await clearProvider(id)
        patch(id, { ...emptyDraft(), expanded: true })
        showToast('已清除配置')
      } catch (e) {
        showToast(e instanceof Error ? e.message : '清除配置失败，请重试')
      }
    })
  }

  // 逐个服务商保存（填完一个即可保存；不跳转，便于继续填其他服务商）
  const handleSaveOne = (id: string) => {
    const d = drafts[id]
    if (!d) return
    // V2-I03/S07：保存前归一化并校验 baseUrl（去尾斜杠、生产仅 https、禁内嵌凭据/fragment），非法则就地提示不落库
    let baseUrl = ''
    try {
      baseUrl = normalizeProviderBaseUrl(d.baseUrl)
    } catch (e) {
      showToast(e instanceof AIError ? e.message : 'API 地址无效')
      return
    }
    const { expanded, showKey, busy, msg, msgOk, ...cfg } = d
    const apply = async () => {
      try {
        // V4-F02：等待真实落库成功才提示「已保存」，失败给出明确错误
        await setProvider(id, { ...cfg, baseUrl })
        showToast(`已保存 ${BRAND[id]?.brand ?? id}`)
      } catch (e) {
        showToast(e instanceof Error ? e.message : '保存失败，请重试')
      }
    }
    // 切换到非预置 host：明示「Key 将发送到该域名」，防止用户把长期 Key 误交给自定义中转站。
    // V4-I01：合法别名由 provider.allowedHosts（manifest）登记，「自定义」= 不在 defaultBaseUrl + allowedHosts 域集内。
    const provider = PROVIDER_MANIFEST.find((p) => p.id === id)
    const isCustomHost = !!baseUrl && !!provider && isCustomProviderHost(baseUrl, provider)
    if (isCustomHost) {
      confirm(
        '确认自定义 API 地址',
        `API Key 将发送到 ${resolveBaseUrlOrigin(baseUrl)}，确认继续使用该地址？`,
        apply,
      )
    } else {
      apply()
    }
  }

  // ---- 自定义提供商：添加 / 删除 ----
  const handleAddCustom = async () => {
    const name = addName.trim()
    if (!name) {
      showToast('请填写提供商名称')
      return
    }
    let baseUrl = ''
    try {
      baseUrl = normalizeProviderBaseUrl(addUrl)
    } catch (e) {
      showToast(e instanceof AIError ? e.message : 'API 地址无效')
      return
    }
    try {
      const meta = await addCustomProvider(name, baseUrl)
      // 地址同步写入该厂商配置（落库）：卡片草稿无论从哪条路径重建都带得上，不依赖创建时的临时草稿
      await setProvider(meta.id, { baseUrl })
      setDrafts((d) => ({ ...d, [meta.id]: { ...emptyDraft(), baseUrl, expanded: true } }))
      setAdding(false)
      setAddName('')
      setAddUrl('')
      showToast(`已添加 ${name}`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加失败，请重试')
    }
  }

  const handleRemoveCustom = (id: string, name: string) => {
    confirm('删除自定义提供商', `将删除「${name}」及其已填写的 API Key 配置，确定删除？`, async () => {
      try {
        await removeCustomProvider(id)
        setDrafts((d) => {
          const next = { ...d }
          delete next[id]
          return next
        })
        showToast('已删除自定义提供商')
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删除失败，请重试')
      }
    })
  }

  // ---- 服务商级单份定价 ----
  const setPrice = (id: string, key: keyof PriceItem, val: number | string | undefined) => {
    const d = drafts[id]
    patch(id, { price: { ...(d.price ?? {}), [key]: val } })
  }

  // 高峰时段预设：数组（[s,e,...]）与下拉选中 key 互转。本期仅保留双高峰，其余用「自定义…」
  const DEFAULT_PEAK_TIMES = [9, 12, 14, 18]
  const PEAK_PRESETS: { key: string; label: string; times: number[] }[] = [
    { key: '9,12,14,18', label: '双高峰 9:00-12:00、14:00-18:00', times: [9, 12, 14, 18] },
  ]
  const peakTimesKey = (t?: number[], custom?: boolean): string => {
    if (custom) return 'custom'
    const key = (t ?? DEFAULT_PEAK_TIMES).join(',')
    return PEAK_PRESETS.some((pr) => pr.times.join(',') === key) ? key : 'custom'
  }
  const peakPreset = (key: string): number[] =>
    PEAK_PRESETS.find((pr) => pr.key === key)?.times ?? DEFAULT_PEAK_TIMES

  // 自定义段：peakTimes 数组与「开始-结束」段列表互转
  const timesToSegs = (t?: number[]): { start: number; end: number }[] => {
    const w = t ?? DEFAULT_PEAK_TIMES
    const out: { start: number; end: number }[] = []
    for (let i = 0; i + 1 < w.length; i += 2) out.push({ start: w[i], end: w[i + 1] })
    return out
  }
  const segsToTimes = (segs: { start: number; end: number }[]): number[] =>
    segs.flatMap((s) => [s.start, s.end])
  const onPeakSelect = (id: string, key: string) => {
    if (key === 'custom') patch(id, { peakCustom: true })
    else patch(id, { peakTimes: peakPreset(key), peakCustom: false })
  }
  const setSeg = (id: string, idx: number, key: 'start' | 'end', val: string) => {
    const segs = timesToSegs(drafts[id].peakTimes)
    const n = Number(val)
    if (key === 'start') {
      segs[idx].start = Math.min(n, 22) // 预留至少 1 小时给结束
      if (segs[idx].end <= segs[idx].start) segs[idx].end = segs[idx].start + 1
    } else {
      segs[idx].end = Math.max(n, segs[idx].start + 1) // 结束必须严格晚于开始
    }
    patch(id, { peakTimes: segsToTimes(segs) })
  }
  const addSeg = (id: string) => {
    const segs = timesToSegs(drafts[id].peakTimes)
    segs.push({ start: 9, end: 12 })
    patch(id, { peakTimes: segsToTimes(segs) })
  }
  const delSeg = (id: string, idx: number) => {
    const segs = timesToSegs(drafts[id].peakTimes)
    patch(id, { peakTimes: segsToTimes(segs.filter((_, i) => i !== idx)) })
  }

  return (
    <div>
      <div className="row" style={{ margin: '6px 0 12px' }}>
        <button className="btn ghost sm" onClick={() => navigate('me')}>
          ‹ 返回
        </button>
        <div className="page-title" style={{ margin: 0 }}>AI 设置</div>
      </div>

      <div className="card">
        <div className="card-title mb-8">默认模型</div>
        {configured.length === 0 ? (
          <div className="card-sub">暂无可用模型，请先在下面对应厂商填写 API Key。</div>
        ) : (
          <div className="ait-defaults">
            {configured.map((p) => {
              const b = BRAND[p.id] ?? { brand: p.name, color: 'var(--primary)' }
              return (
                <button
                  key={p.id}
                  className={'def-pill' + (defaultId === p.id ? ' on' : '')}
                  onClick={async () => {
                    try {
                      await setDefault(p.id)
                      showToast(`已设为默认：${p.name}`)
                    } catch (e) {
                      showToast(e instanceof Error ? e.message : '保存失败，请重试')
                    }
                  }}
                >
                  <span className="dp-brand" style={{ color: b.color }}>
                    {b.brand}
                  </span>
                  <span className="dp-model" title={drafts[p.id]?.model || p.name}>
                    {drafts[p.id]?.model || '未选模型'}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title mb-8">模型服务</div>
        {providerList.map((p) => {
          const d = drafts[p.id] ?? emptyDraft()
          const isCustom = !isPresetProvider(p.id)
          // 配置状态分级（与生成页 isProviderReady 口径一致，避免「配置页显示已配置、生成页却提示未配置」）：
          // hasKey=仅填了 Key；isCfg=Key+模型齐全（真正可用）
          const hasKey = (d.apiKey ?? '').trim() !== ''
          const isCfg = isProviderReady({ apiKey: d.apiKey, model: d.model })
          const hasPrice = hasPriceCfg(d.price)
          const isDefault = defaultId === p.id && isCfg
          return (
            <div key={p.id} className={'provider' + (d.expanded ? ' open' : '')}>
              <button type="button" className="phead" onClick={() => patch(p.id, { expanded: !d.expanded })}>
                <div className="avatar">
                  <img className="avatar-logo" src={providerLogo(p.id)} alt={p.name} />
                </div>
                <div className="flex-1">
                  <div className="pname">
                    {p.name}
                    {isDefault && <span className="ap-default">默认</span>}
                  </div>
                  <div className="card-sub">
                    {!hasKey ? '未填写 API Key' : isCfg && !hasPrice ? '未填写模型价格，预计花费无法计算' : '已填写 API Key'}
                  </div>
                </div>
                <span className={'tag ' + (isCfg ? 'success' : hasKey ? 'warning' : '')}>
                  {isCfg ? '已配置' : hasKey ? '待选模型' : '未配置'}
                </span>
              </button>

              {d.expanded && (
                <div className="pbody">
                  <div className="field">
                    <div className="fl">API Key</div>
                    <div className="row gap-6">
                      <input
                        className="input flex-1"
                        type={d.showKey ? 'text' : 'password'}
                        placeholder={`填写 ${p.name} 的 API Key`}
                        value={d.apiKey}
                        onChange={(e) => patch(p.id, { apiKey: e.target.value, msg: '' })}
                      />
                      <button className="btn ghost sm" onClick={() => patch(p.id, { showKey: !d.showKey })}>
                        {d.showKey ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>

                  <div className="field">
                    <div className="fl">模型</div>
                    {(d.apiKey ?? '').trim() && (d.fetchedModels ?? []).length ? (
                      <select
                        className="input"
                        value={d.model}
                        onChange={(e) => patch(p.id, { model: e.target.value, msg: '' })}
                      >
                        {(d.fetchedModels ?? []).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="ait-model-empty">尚未获取模型</div>
                    )}
                    <div className="row gap-6 mt-8 ait-actions">
                      <button
                        className="btn ghost sm flex-1"
                        disabled={d.busy === 'fetch' || !(d.apiKey ?? '').trim()}
                        onClick={() => handleFetch(p.id)}
                      >
                        {d.busy === 'fetch' ? '获取中…' : '获取模型列表'}
                      </button>
                      <button
                        className="btn ghost sm flex-1"
                        disabled={d.busy === 'test' || !(d.apiKey ?? '').trim() || !d.model}
                        onClick={() => handleTest(p.id)}
                      >
                        {d.busy === 'test' ? '检测中…' : '测试连通'}
                      </button>
                      <button
                        type="button"
                        className={'btn ghost sm flex-1' + (d.disableThinking ? ' on' : '')}
                        onClick={() => patch(p.id, { disableThinking: !d.disableThinking })}
                      >
                        {d.disableThinking ? '开启思考' : '关闭思考'}
                      </button>
                      <button
                        type="button"
                        className={'btn ghost sm flex-1' + (d.peakEnabled ? ' on' : '')}
                        onClick={() => patch(p.id, { peakEnabled: !d.peakEnabled })}
                      >
                        峰谷计价
                      </button>
                    </div>
                    {d.msg && (
                      <div className={'ai-msg ' + (d.msgOk ? 'ok' : 'err')}>{d.msg}</div>
                    )}
                  </div>

                  <div className="field">
                    <div className="fl">API 地址</div>
                    <input
                      className="input"
                      placeholder={p.defaultBaseUrl}
                      value={d.baseUrl ?? ''}
                      onChange={(e) => patch(p.id, { baseUrl: e.target.value })}
                    />
                    {/* V4-I01：开发代理按 manifest 精确白名单转发，仅放行预置网关；
                        自定义地址须在启动前配置 AI_PROXY_ALLOW_HOSTS 并重启 dev server，否则会 403 */}
                  </div>

                  <div className="field">
                    <div className="fl">模型定价（元/百万token）</div>
                    {d.peakEnabled && (
                      <>
                        <div className="peak-time-row">
                          <span className="peak-time-label">高峰时段</span>
                          <select
                            className="input"
                            value={peakTimesKey(d.peakTimes, d.peakCustom)}
                            onChange={(e) => onPeakSelect(p.id, e.target.value)}
                          >
                            {PEAK_PRESETS.map((pr) => (
                              <option key={pr.key} value={pr.key}>
                                {pr.label}
                              </option>
                            ))}
                            <option value="custom">自定义…</option>
                          </select>
                        </div>
                        {peakTimesKey(d.peakTimes, d.peakCustom) === 'custom' && (
                          <div className="peak-custom">
                            {timesToSegs(d.peakTimes).map((seg, i) => (
                              <div key={i} className="peak-seg">
                                <span className="peak-seg-idx" title="该时段按 [开始, 结束) 计为峰价">
                                  时段 {i + 1}
                                </span>
                                <select className="input" value={seg.start} onChange={(e) => setSeg(p.id, i, 'start', e.target.value)}>
                                  {HOURS.filter((h) => h <= 22).map((h) => (
                                    <option key={h} value={h}>
                                      {h}:00
                                    </option>
                                  ))}
                                </select>
                                <span className="peak-seg-dash">–</span>
                                <select className="input" value={seg.end > seg.start ? seg.end : seg.start + 1} onChange={(e) => setSeg(p.id, i, 'end', e.target.value)}>
                                  {HOURS.filter((h) => h > seg.start).map((h) => (
                                    <option key={h} value={h}>
                                      {h}:00
                                    </option>
                                  ))}
                                </select>
                                <button className="peak-seg-del" aria-label="删除该时段" onClick={() => delSeg(p.id, i)}>
                                  ×
                                </button>
                              </div>
                            ))}
                            <button className="peak-add" onClick={() => addSeg(p.id)}>
                              + 添加时段
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    {d.peakEnabled ? (
                      <>
                        <div className="price-row peak-row">
                          <span className="pr-label peak">峰</span>
                          <input
                            className="pr-input"
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder="输入(命中缓存)"
                            value={d.price?.cacheRead ?? ''}
                            onChange={(e) => setPrice(p.id, 'cacheRead', e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                          <input
                            className="pr-input"
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder="输入(未命中缓存)"
                            value={d.price?.input ?? ''}
                            onChange={(e) => setPrice(p.id, 'input', e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                          <input
                            className="pr-input"
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder="输出"
                            value={d.price?.output ?? ''}
                            onChange={(e) => setPrice(p.id, 'output', e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                        </div>
                        <div className="price-row off-row">
                          <span className="pr-label off">谷</span>
                          <input
                            className="pr-input"
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder="输入(命中缓存)"
                            value={d.price?.cacheReadOff ?? ''}
                            onChange={(e) => setPrice(p.id, 'cacheReadOff', e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                          <input
                            className="pr-input"
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder="输入(未命中缓存)"
                            value={d.price?.inputOff ?? ''}
                            onChange={(e) => setPrice(p.id, 'inputOff', e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                          <input
                            className="pr-input"
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder="输出"
                            value={d.price?.outputOff ?? ''}
                            onChange={(e) => setPrice(p.id, 'outputOff', e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="price-row flat">
                        <input
                          className="input"
                          type="number"
                          min="0"
                          step="0.001"
                          placeholder="输入(命中缓存)"
                          value={d.price?.cacheRead ?? ''}
                          onChange={(e) => setPrice(p.id, 'cacheRead', e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                        <input
                          className="input"
                          type="number"
                          min="0"
                          step="0.001"
                          placeholder="输入(未命中缓存)"
                          value={d.price?.input ?? ''}
                          onChange={(e) => setPrice(p.id, 'input', e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                        <input
                          className="input"
                          type="number"
                          min="0"
                          step="0.001"
                          placeholder="输出"
                          value={d.price?.output ?? ''}
                          onChange={(e) => setPrice(p.id, 'output', e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                      </div>
                    )}
                  </div>

                  <div className="ait-clear">
                    <button className="ait-clear-btn save" onClick={() => handleSaveOne(p.id)}>
                      保存
                    </button>
                    <button className="ait-clear-btn" onClick={() => handleClear(p.id)}>
                      清除配置
                    </button>
                    {isCustom && (
                      <button className="ait-clear-btn" onClick={() => handleRemoveCustom(p.id, p.name)}>
                        删除提供商
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {/* 添加自定义提供商：内联小表单（名称 + API 地址），创建后与其他厂商完全同权 */}
        {!adding ? (
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
            + 添加自定义提供商
          </button>
        ) : (
          <div className="pbody" style={{ marginTop: 10 }}>
            <div className="field">
              <div className="fl">提供商名称</div>
              <input
                className="input"
                placeholder="如：我的中转站 / 硅基流动"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </div>
            <div className="field">
              <div className="fl">API 地址（OpenAI 兼容）</div>
              <input
                className="input"
                placeholder="https://api.example.com/v1"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
              />
            </div>
            <div className="row gap-8">
              <button className="btn ghost sm flex-1" onClick={() => { setAdding(false); setAddName(''); setAddUrl('') }}>
                取消
              </button>
              <button className="btn sm flex-1" onClick={handleAddCustom}>
                创建
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
