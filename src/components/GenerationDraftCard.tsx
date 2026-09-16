/**
 * 唯一活动方案卡（实施路线 7.1/19 节 / TASK-09）。
 *
 * - 数据全部来自 session.generationDraft + evaluateGenerationDraft + formatGenerationDraft，
 *   不接受模型正文作为事实源。
 * - 固定渲染在消息滚动区与输入区之间（由 GeneratePage 摆位），不进 flowBlocks；
 *   移动端不遮输入框（普通文档流），支持手动折叠（纯 React 本地状态，不持久化）。
 * - ready 时主按钮「生成 N 题」直接 startGenerationFromDraft（不再打开 quickDlg 二次确认）；
 *   取消统一走 cancelGenerationDraft('card')；编辑为 edit-only 模式（保存方案生成
 *   DraftUserAction，编辑面板内不启动生成）。
 * - hooks 全部前置：无草稿/cancelled 的「不渲染」判断放在所有 hook 之后（React 规则）。
 */
import { useEffect, useState } from 'react'
import type { DraftUserAction, GenerationDraft, QuestionTypeId } from '../types'
import { QUESTION_TYPES } from '../types'
import { useGenerate } from '../stores/useGenerateStore'
import { evaluateGenerationDraft } from '../services/generation/draftValidation'
import { formatGenerationDraft, generationDraftCardHead } from '../services/generation/draftPresentation'
import { zeroStructure } from '../services/generation/structure'

interface GenerationDraftCardProps {
  /** 页面层实时刷新该值，卡片不把计时器写入业务状态。 */
  elapsedMs?: number
  /** 生成中的取消动作由页面统一处理，确保草稿和执行状态一起收敛。 */
  onCancel?: () => void
}

function formatElapsed(ms: number): string {
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

export function GenerationDraftCard({ elapsedMs = 0, onCancel }: GenerationDraftCardProps) {
  const session = useGenerate((s) => s.session)
  const phase = useGenerate((s) => s.phase)
  const progress = useGenerate((s) => s.progress)
  const parsed = useGenerate((s) => s.parsed)
  const parseTotal = useGenerate((s) => s.parseTotal)
  const volumeProgress = useGenerate((s) => s.volumeProgress)
  const draft: GenerationDraft | undefined = session?.generationDraft
  const [folded, setFolded] = useState(() => draft?.lifecycle === 'completed')
  const [editing, setEditing] = useState(false)
  const [regenerateMode, setRegenerateMode] = useState(false)
  const cp = draft?.countPlan
  const [topic, setTopic] = useState<string | null>(null)
  const [mode, setMode] = useState<'ai' | 'custom'>(cp?.mode === 'custom' ? 'custom' : 'ai')
  const [aiTotal, setAiTotal] = useState<number>(cp?.mode === 'ai' ? cp.total.value : 20)
  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const base = zeroStructure()
    if (cp?.mode === 'custom') {
      for (const [k, v] of Object.entries(cp.typeCounts)) base[k as QuestionTypeId] = v?.value ?? 0
    }
    return base
  })
  const [reqDrafts, setReqDrafts] = useState<Array<{ id: string; text: string }>>(
    draft ? draft.requirements.map((r) => ({ id: r.id, text: r.value })) : [],
  )
  const [newReq, setNewReq] = useState('')

  // 生成完成后默认收起；用户手动展开后仍可查看并编辑当前方案。
  useEffect(() => {
    if (draft?.lifecycle === 'completed') setFolded(true)
  }, [draft?.lifecycle])

  // cancelled 即撤下活动卡（历史留文字记录）；无草稿不渲染（legacy 模式恒为此态）
  if (!draft || draft.lifecycle === 'cancelled') return null

  const ev = evaluateGenerationDraft(draft)
  const view = formatGenerationDraft(draft, ev)
  const generating = draft.lifecycle === 'generating' || phase === 'generating' || phase === 'validating'
  const canStart = ev.ready && draft.lifecycle === 'active' && phase !== 'chatting' && phase !== 'generating' && phase !== 'validating'
  const hasTurnIssue = draft.turnIssues.length > 0
  const visibleConflicts = view.conflicts.filter(
    (conflict) =>
      !(conflict.code === 'DRAFT_NOT_ACTIVE' && (draft.lifecycle === 'completed' || draft.lifecycle === 'generating')),
  )
  const visibleWarnings = view.warnings.filter(
    (warning) => !(warning.field === 'topic' && view.topic?.inferred),
  )

  const startEdit = () => {
    setFolded(false)
    setTopic(view.topic?.value ?? '')
    setMode(cp?.mode === 'custom' ? 'custom' : 'ai')
    setAiTotal(cp?.mode === 'ai' ? cp.total.value : 20)
    const base = zeroStructure()
    if (cp?.mode === 'custom') {
      for (const [k, v] of Object.entries(cp.typeCounts)) base[k as QuestionTypeId] = v?.value ?? 0
    }
    setCounts(base)
    setReqDrafts(draft.requirements.map((r) => ({ id: r.id, text: r.value })))
    setEditing(true)
  }

  /** 保存方案：按 diff 生成明确 DraftUserAction（edit-only，不在编辑面板内启动生成） */
  const saveEdit = async () => {
    const g = useGenerate.getState()
    if (draft.lifecycle === 'completed') {
      if (!(await g.reopenGenerationDraft())) return
      setRegenerateMode(true)
    }
    const acts: DraftUserAction[] = []
    const nextTopic = (topic ?? '').trim()
    if (nextTopic && nextTopic !== (view.topic?.value ?? '')) {
      acts.push({ kind: 'set_topic', value: nextTopic })
    }
    if (mode === 'ai') {
      if (draft.countPlan?.mode !== 'ai' || draft.countPlan.total.value !== aiTotal) {
        acts.push({ kind: 'set_ai_total', total: aiTotal })
      }
    } else {
      const nextCounts: Partial<Record<QuestionTypeId, number>> = {}
      for (const [k, v] of Object.entries(counts)) if (v > 0) nextCounts[k as QuestionTypeId] = v
      const curCounts =
        draft.countPlan?.mode === 'custom'
          ? Object.fromEntries(
              Object.entries(draft.countPlan.typeCounts).map(([k, v]) => [k, v?.value ?? 0]),
            )
          : {}
      if (
        draft.countPlan?.mode !== 'custom' ||
        JSON.stringify(curCounts) !== JSON.stringify(nextCounts) ||
        draft.countPlan.statedTotal !== undefined
      ) {
        // 进入自定义题型并保存 = 用户确认分项合计为最终总数，清除 AI 阶段遗留的对账总数。
        acts.push({ kind: 'set_custom_counts', typeCounts: nextCounts, unsetStatedTotal: true })
      }
    }
    const curTexts = new Set(draft.requirements.map((r) => r.value))
    const nextTexts = new Set(reqDrafts.map((r) => r.text.trim()).filter(Boolean))
    for (const r of draft.requirements) {
      if (!nextTexts.has(r.value)) acts.push({ kind: 'remove_requirement', id: r.id })
    }
    for (const r of reqDrafts) {
      const t = r.text.trim()
      if (t && !curTexts.has(t)) acts.push({ kind: 'append_requirement', text: t })
    }
    for (const a of acts) g.updateGenerationDraft(a)
    setEditing(false)
  }

  const head = generationDraftCardHead(draft.lifecycle, ev.ready)
  const progressTotal = progress?.targetTotal ?? ev.effectiveTotal ?? 0
  const generatingQuestions = progress?.questions ?? 0
  const progressRatio =
    phase === 'validating'
      ? parseTotal > 0
        ? parsed / parseTotal
        : 0
      : progressTotal > 0
        ? generatingQuestions / progressTotal
        : 0
  const progressInfo =
    phase === 'validating'
      ? `已解析 ${parsed}/${parseTotal} 题`
      : `已生成 ${generatingQuestions} 题 / 共 ${progressTotal} 题${
          volumeProgress ? ` · 第 ${volumeProgress.cur}/${volumeProgress.total} 卷` : ''
        }${progress ? ` · 批次 ${Math.min(progress.done + 1, progress.total)}/${progress.total}` : ''}`
  const handleCancel = onCancel ?? (() => useGenerate.getState().cancelGenerationDraft('card'))

  return (
    <div className="gdcard" data-state={draft.lifecycle}>
      <div className="gdcard-head">
        <span className="gdcard-badge">{head}</span>
        {ev.ready && <span className="gdcard-rev">v{draft.revision}</span>}
        <button className="gdcard-fold" onClick={() => setFolded((f) => !f)}>
          {folded ? '展开 ▾' : '收起 ▴'}
        </button>
      </div>

      {!folded && !editing && (
        <div className="gdcard-body">
          {view.topic && (
            <div className="gdcard-row">
              <span className="gdcard-k">主题</span>
              <span className="gdcard-v">
                {view.topic.value}
              </span>
            </div>
          )}
          {view.totalText && (
            <div className="gdcard-row">
              <span className="gdcard-k">题量</span>
              <span className="gdcard-v">{view.totalText} 题</span>
            </div>
          )}
          <div className="gdcard-row">
            <span className="gdcard-k">题型</span>
            <span className="gdcard-v">
              {view.aiTypes
                ? 'AI 推荐'
                : view.typeCounts?.map((t) => `${t.name} ${t.count}`).join('、')}
              {view.statedTotalText && <em className="gdcard-infer">原总数 {view.statedTotalText}</em>}
            </span>
          </div>
          {view.requirements && view.requirements.length > 0 && (
            <div className="gdcard-row">
              <span className="gdcard-k">要求</span>
              <span className="gdcard-v">{view.requirements.map((r) => r.text).join('；')}</span>
            </div>
          )}
          {view.sourceSummary && (
            <div className="gdcard-row">
              <span className="gdcard-k">资料</span>
              <span className="gdcard-v">{view.sourceSummary}</span>
            </div>
          )}

          {/* 冲突 > 缺项 > 建议的固定顺序（presentation 已按 issue 排布） */}
          {visibleConflicts.length > 0 && (
            <div className="gdcard-issues gdcard-conflicts">
              {visibleConflicts.map((c, i) => (
                <div key={i}>⚠ {c.message}</div>
              ))}
            </div>
          )}
          {view.missing.length > 0 && (
            <div className="gdcard-issues">
              {view.missing.map((m, i) => (
                <div key={i}>缺：{m.message}</div>
              ))}
            </div>
          )}
          {visibleWarnings.length > 0 && (
            <div className="gdcard-warn">
              {visibleWarnings.map((w, i) => (
                <div key={i}>{w.message}</div>
              ))}
            </div>
          )}
           {hasTurnIssue && (
            <div className="gdcard-issues gdcard-conflicts">
              <div>
                上一轮修改未应用——可重试，或
                <button
                  className="gdcard-linkbtn"
                  onClick={() => useGenerate.getState().updateGenerationDraft({ kind: 'accept_current' })}
                >
                  仍按当前方案
                </button>
              </div>
            </div>
           )}

          {generating && (
            <div className="gdcard-progress">
              <div className="gen-progress-head">
                <span className="gen-progress-title">
                  {phase === 'validating' ? '解析校验阶段' : progress?.backfill ? 'AI 生题 · 补齐缺失题目' : 'AI 生题阶段'}
                </span>
                <span className="gen-timer">⏱ {formatElapsed(elapsedMs)}</span>
              </div>
              <div className="progress">
                <i style={{ width: `${Math.max(0, Math.min(100, progressRatio * 100))}%` }} />
              </div>
              <div className="gen-progress-info">{progressInfo}</div>
            </div>
          )}

          <div className="gdcard-acts">
            {!generating && ev.ready ? (
              <button
                className="gdcard-btn primary"
                disabled={!canStart}
                onClick={() => useGenerate.getState().startGenerationFromDraft(draft.id, draft.revision)}
              >
                {regenerateMode ? '重新生成' : '生成'} {ev.effectiveTotal} 题
              </button>
            ) : ev.conflicts.length > 0 ? null : (
              !generating && <span className="gdcard-next">{view.nextQuestion ?? '请补充生题需求'}</span>
            )}
            <button className="gdcard-btn" onClick={startEdit} disabled={generating}>
              编辑
            </button>
            {draft.lifecycle === 'completed' ? (
              <button className="gdcard-btn ghost" onClick={() => setFolded(true)}>
                收起
              </button>
            ) : (
              <button
                className="gdcard-btn ghost"
                onClick={handleCancel}
              >
                取消
              </button>
            )}
          </div>
        </div>
      )}

      {!folded && editing && (
        <div className="gdcard-body gdcard-edit">
          <label className="gdcard-row">
            <span className="gdcard-k">主题</span>
            <input
              className="gdcard-input"
              value={topic ?? ''}
              maxLength={60}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="出题主题"
            />
          </label>
          <div className="gdcard-row">
            <span className="gdcard-k">模式</span>
            <span className="gdcard-modes">
              <button
                className={'gdcard-chip' + (mode === 'ai' ? ' on' : '')}
                onClick={() => setMode('ai')}
              >
                AI 推荐
              </button>
              <button
                className={'gdcard-chip' + (mode === 'custom' ? ' on' : '')}
                onClick={() => setMode('custom')}
              >
                自定义题型
              </button>
            </span>
          </div>
          {mode === 'ai' ? (
            <div className="gdcard-row">
              <span className="gdcard-k">总题数</span>
              <span className="gdcard-stepper">
                <button onClick={() => setAiTotal((n) => Math.max(1, n - 5))}>−</button>
                <b>{aiTotal}</b>
                <button onClick={() => setAiTotal((n) => Math.min(1000, n + 5))}>＋</button>
              </span>
            </div>
          ) : (
            <div className="gdcard-types">
              {QUESTION_TYPES.map((t) => (
                <label className="gdcard-type" key={t.id}>
                  <span>{t.name}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={counts[t.id] ?? 0}
                    onChange={(e) =>
                      setCounts((c) => ({ ...c, [t.id]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))
                    }
                  />
                </label>
              ))}
              <div className="gdcard-types-sum">合计 {Object.values(counts).reduce((a, b) => a + b, 0)} 题</div>
            </div>
          )}
          <div className="gdcard-reqs">
            {reqDrafts.map((r) => (
              <div className="gdcard-req" key={r.id}>
                <span>{r.text}</span>
                <button onClick={() => setReqDrafts((rs) => rs.filter((x) => x.id !== r.id))}>删</button>
              </div>
            ))}
            <div className="gdcard-req-add">
              <input
                value={newReq}
                placeholder="添加附加要求（如：难一点）"
                onChange={(e) => setNewReq(e.target.value)}
              />
              <button
                onClick={() => {
                  const t = newReq.trim()
                  if (!t) return
                  setReqDrafts((rs) => [...rs, { id: `tmp_${Date.now()}`, text: t }])
                  setNewReq('')
                }}
              >
                添加
              </button>
            </div>
          </div>
          {view.sourceSummary && (
            <div className="gdcard-row">
              <span className="gdcard-k">资料</span>
              <span className="gdcard-v">
                {view.sourceSummary}
                <button
                  className="gdcard-linkbtn"
                  onClick={() => useGenerate.getState().updateGenerationDraft({ kind: 'clear_source' })}
                >
                  清除
                </button>
              </span>
            </div>
          )}
          <div className="gdcard-acts">
            <button className="gdcard-btn primary" onClick={saveEdit}>
              保存方案
            </button>
            <button className="gdcard-btn ghost" onClick={() => setEditing(false)}>
              取消编辑
            </button>
          </div>
          <div className="gdcard-hint">保存后点击「生成 N 题」。</div>
        </div>
      )}
    </div>
  )
}
