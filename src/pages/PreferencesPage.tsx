import { useEffect, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useModal } from '../stores/useModalStore'
import { usePreferences } from '../stores/usePreferenceStore'
import { useGenerate } from '../stores/useGenerateStore'
import { QUESTION_TYPES, type QuestionTypeId } from '../types'

function structureSummary(s: Record<QuestionTypeId, number>): string {
  return Object.entries(s)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${QUESTION_TYPES.find((x) => x.id === t)?.name ?? t} ${n}`)
    .join(' · ')
}

/**
 * 数字步进输入框（6.88 用户反馈：偏好设置只能加减太麻烦）：可直接键入，
 * 键入中过滤非数字并实时夹取范围；清空后失焦回落到 min。± 按钮不变。
 */
function NumInput(props: {
  value: number
  min: number
  max: number
  className: string
  ariaLabel: string
  onChange: (n: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="text"
      inputMode="numeric"
      className={props.className}
      aria-label={props.ariaLabel}
      value={draft ?? String(props.value)}
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, '').slice(0, 3)
        setDraft(raw)
        if (raw !== '') props.onChange(Math.max(props.min, Math.min(props.max, Number(raw))))
      }}
      onBlur={() => {
        if (draft === null) return
        props.onChange(Math.max(props.min, Math.min(props.max, Number(draft || props.min))))
        setDraft(null)
      }}
    />
  )
}

/** 偏好设置页（见 PRD 4.6）：每日复习上限 + 题型模板统一管理；默认题型 = 选中的模板 */
export default function PreferencesPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const modal = useModal()
  const { dailyReviewLimit, setDailyReviewLimit } = usePreferences()
  const templates = useGenerate((s) => s.templates)
  const defaultTemplate = useGenerate((s) => s.defaultTemplate)
  const saveTemplate = useGenerate((s) => s.saveTemplate)
  const deleteTemplate = useGenerate((s) => s.deleteTemplate)
  const setDefaultTemplate = useGenerate((s) => s.setDefaultTemplate)

  const [limit, setLimit] = useState(dailyReviewLimit)
  const [types, setTypes] = useState<Record<QuestionTypeId, number>>(
    useGenerate.getState().getDefaultStructure()
  )
  const [tplName, setTplName] = useState('')
  const [sourceTpl, setSourceTpl] = useState<string | null>(null)

  useEffect(() => {
    useGenerate.getState().load()
  }, [])

  const clampLimit = (n: number) => Math.max(1, Math.min(200, n))

  const setType = (id: QuestionTypeId, n: number) => {
    setTypes((t) => ({ ...t, [id]: Math.max(0, Math.min(100, n)) }))
  }

  const total = Object.values(types).reduce((a, b) => a + b, 0)

  const handleSave = () => {
    setDailyReviewLimit(clampLimit(limit))
    showToast('偏好设置已保存')
    navigate('me')
  }

  const handleSaveTemplate = async () => {
    const name = tplName.trim()
    if (!name) {
      showToast('请输入模板名称')
      return
    }
    if (Object.values(types).every((n) => n <= 0)) {
      showToast('请先设置至少一种题型')
      return
    }
    await saveTemplate(name, types)
    // 编辑改名时，删除原模板避免残留
    if (sourceTpl && sourceTpl !== name) deleteTemplate(sourceTpl)
    setSourceTpl(null)
    setTplName('')
    showToast(`已${sourceTpl && sourceTpl === name ? '更新' : '保存'}模板「${name}」`)
  }

  const handleEditTemplate = (name: string, s: Record<QuestionTypeId, number>) => {
    setTypes({ ...s })
    setTplName(name)
    setSourceTpl(name)
    showToast(`正在编辑模板「${name}」`)
    document.querySelector('.pref-tpl-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleDeleteTemplate = (name: string) => {
    modal.confirm('删除题型模板', `确定删除模板「${name}」？此操作不可恢复。`, () => {
      deleteTemplate(name)
      if (sourceTpl === name) {
        setSourceTpl(null)
        setTplName('')
      }
      showToast(`已删除模板「${name}」`)
    })
  }

  const handleSetDefault = async (name: string) => {
    await setDefaultTemplate(name)
    showToast(`已设「${name}」为默认题型`)
  }

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => navigate('me')}>‹</button>
        <span className="subhead-title">偏好设置</span>
      </div>

      <div className="card">
        <div className="card-title mb-8">每日复习上限</div>
        <div className="pref-row">
          <span className="card-sub">每天最多复习的知识点数量</span>
          <div className="gen-stepper-ctrl">
            <button
              type="button"
              aria-label="减少每日复习上限"
              onClick={() => setLimit(clampLimit(limit - 1))}
              disabled={limit <= 1}
            >
              −
            </button>
            <NumInput
              value={limit}
              min={1}
              max={200}
              className="gen-stepper-num"
              ariaLabel="每日复习上限"
              onChange={(n) => setLimit(clampLimit(n))}
            />
            <button
              type="button"
              aria-label="增加每日复习上限"
              onClick={() => setLimit(clampLimit(limit + 1))}
              disabled={limit >= 200}
            >
              ＋
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row mb-8">
          <div className="card-title">题型模板</div>
          <span className="card-sub">合计 {total} 题</span>
        </div>
        <div className="type-list">
          {QUESTION_TYPES.map((t) => (
            <div className="type-row" key={t.id}>
              <span className="tname">
                {t.name}
                <span className="tcat">{t.category === 'objective' ? '客观' : '主观'}</span>
              </span>
              <div className="stepper">
                <button
                  className="st-btn"
                  type="button"
                  aria-label={`减少${t.name}`}
                  onClick={() => setType(t.id, types[t.id] - 1)}
                  disabled={types[t.id] <= 0}
                >
                  −
                </button>
                <NumInput
                  value={types[t.id]}
                  min={0}
                  max={100}
                  className={'st-val' + (types[t.id] === 0 ? ' zero' : '')}
                  ariaLabel={`${t.name}数量`}
                  onChange={(n) => setType(t.id, n)}
                />
                <button
                  className="st-btn"
                  type="button"
                  aria-label={`增加${t.name}`}
                  onClick={() => setType(t.id, types[t.id] + 1)}
                  disabled={types[t.id] >= 100}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="pref-tpl-anchor" />
        <div className="pref-tplsave">
          <input
            className="input flex-1"
            placeholder="模板名称，如：软考模拟卷"
            value={tplName}
            maxLength={12}
            onChange={(e) => setTplName(e.target.value)}
          />
          <button className="btn sm" onClick={() => void handleSaveTemplate()}>
            {sourceTpl ? '更新模板' : '存为模板'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title mb-8">我的模板</div>
        {Object.entries(templates).length === 0 ? (
          <div className="card-sub">暂无模板。可在上方设置题型结构后命名保存，或到生成页「存为模板」。</div>
        ) : (
          Object.entries(templates).map(([name, s]) => {
            const isDefault = defaultTemplate === name
            return (
              <div key={name} className="tpl-item">
                <div className="flex-1">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="card-title">{name}</span>
                    {isDefault && <span className="tag primary">默认</span>}
                  </div>
                  <div className="card-sub" style={{ marginTop: 2 }}>
                    {structureSummary(s)} · 共 {Object.values(s).reduce((a, b) => a + b, 0)} 题
                  </div>
                </div>
                {!isDefault && (
                  <button className="btn ghost sm" onClick={() => void handleSetDefault(name)}>
                    设为默认
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => handleEditTemplate(name, s)}>
                  编辑
                </button>
                <button
                  className="btn ghost sm"
                  style={{ color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)' }}
                  onClick={() => handleDeleteTemplate(name)}
                >
                  删除
                </button>
              </div>
            )
          })
        )}
      </div>

      <button className="btn block" onClick={handleSave}>
        保存
      </button>
    </div>
  )
}