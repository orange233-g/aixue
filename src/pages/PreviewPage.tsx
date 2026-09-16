import { useMemo, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useGenerate } from '../stores/useGenerateStore'
import { usePacks } from '../stores/usePackStore'
import { useModal } from '../stores/useModalStore'
import { QUESTION_TYPES } from '../types'
import type { Question, QuestionTypeId } from '../types'
import { validateQuestion } from '../services/validation'
import { renderMarkdown } from '../utils/markdown'

function typeName(id: QuestionTypeId): string {
  return QUESTION_TYPES.find((t) => t.id === id)?.name ?? id
}

function parseIdx(s: string): number[] {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v.map(Number) : []
  } catch {
    return []
  }
}

/** 生成预览页（见 PRD 4.9）：分组 / 异常标记 / 单题编辑删除 / 批量处理 / 确认入库 */
export default function PreviewPage() {
  const ui = useUI()
  const store = useGenerate()
  const packs = usePacks((s) => s.packs)
  const modal = useModal()
  const [editing, setEditing] = useState<Question | null>(null)
  const packId = ui.currentPackId
  const pack = packId ? (store.drafts[packId] ?? packs.find((p) => p.id === packId)) : undefined
  const isDraft = !!packId && !!store.drafts[packId]

  const groups = useMemo<[QuestionTypeId, Question[]][]>(() => {
    if (!pack) return []
    const map = new Map<QuestionTypeId, Question[]>()
    for (const q of pack.questions) {
      if (!map.has(q.type)) map.set(q.type, [])
      map.get(q.type)!.push(q)
    }
    return [...map.entries()]
  }, [pack])

  if (!pack) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => ui.navigate('generate')}>
            ←
          </button>
          <div className="subhead-title">预览</div>
        </div>
        <div className="empty">
          <div className="em">📭</div>
          <div className="et">学习本不存在</div>
        </div>
      </div>
    )
  }

  const issueCount = pack.questions.filter((q) => validateQuestion(q).length > 0).length
  const validCount = pack.questions.length - issueCount

  if (pack.questions.length === 0) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => ui.navigate('generate')}>
            ←
          </button>
          <div className="subhead-title">学习本预览</div>
        </div>
        <div className="empty">
          <div className="em">📭</div>
          <div className="et">学习本为空，请重新生成</div>
          <div className="es">所有题目已被删除</div>
          <button className="btn sm mt-8" onClick={() => ui.navigate('generate')}>
            返回生成
          </button>
        </div>
      </div>
    )
  }

  const confirmRemove = (q: Question) => {
    modal.confirm('删除题目', `删除「${q.stem.slice(0, 20)}${q.stem.length > 20 ? '…' : ''}」？`, () =>
      store.removeQuestion(pack.id, q.id),
    )
  }

  const confirmRemoveIssues = () => {
    modal.confirm('删除异常题', `将移除全部 ${issueCount} 道未通过校验的题目。`, () => store.removeIssues(pack.id))
  }

  const handleImport = () => {
    if (validCount === 0) {
      ui.showToast('没有可通过校验的题目')
      return
    }
    if (issueCount > 0) {
      modal.confirm('确认入库', `有 ${issueCount} 题未通过校验，将只入库通过的 ${validCount} 题。`, () => {
        store.addToBank(pack.id)
        ui.navigate('pack-detail', true)
      })
    } else {
      store.addToBank(pack.id)
      ui.navigate('pack-detail', true)
    }
  }

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => ui.navigate('generate')}>
          ←
        </button>
        <div className="subhead-title">学习本预览</div>
      </div>

      {/* ① 结果头部 */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="flex-1">
            <div className="card-title">{pack.title}</div>
            <div className="card-sub">
              {pack.questions.length} 题 · 校验通过 {validCount} 题
              {issueCount > 0 && ` · ${issueCount} 题需处理`}
            </div>
          </div>
          <span className={issueCount > 0 ? 'tag warning' : 'tag success'}>
            {issueCount > 0 ? '有异常题' : '全部通过'}
          </span>
        </div>
      </div>

      {/* ② 分题型题目列表 */}
      {groups.map(([type, qs]) => {
        const bad = qs.filter((q) => validateQuestion(q).length > 0).length
        return (
          <div className="card" key={type}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
              <span className="card-title">
                {typeName(type)} · {qs.length} 题
              </span>
              <span className={bad > 0 ? 'tag warning' : 'tag success'}>
                {bad > 0 ? `${bad} 题需处理` : '全部通过'}
              </span>
            </div>
            {qs.map((q) => {
              const errs = validateQuestion(q)
              return (
                <div key={q.id} className={'pv-item' + (errs.length ? ' bad' : '')}>
                  <div className="pv-item-head">
                    <div className="pv-stem md-rich" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.stem) }} />
                    {errs.length > 0 && <span className="pv-tag">答案异常</span>}
                  </div>
                  {errs.length > 0 && <div className="pv-errs">{errs.join('；')}</div>}
                  {isDraft && (
                    <div className="pv-actions">
                      <button className="btn ghost sm" onClick={() => setEditing(q)}>
                        编辑
                      </button>
                      <button className="btn ghost sm danger" onClick={() => confirmRemove(q)}>
                        删除
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

      {/* ③ 批量操作 + 确认入库 */}
      {isDraft && (
        <div className="pv-bar">
          {issueCount > 0 && (
            <button className="btn ghost sm danger" onClick={confirmRemoveIssues}>
              删除异常题（{issueCount}）
            </button>
          )}
          <button className="btn flex-1" onClick={handleImport}>
            确认入库
          </button>
        </div>
      )}

      {editing && isDraft && (
        <QuestionEditor
          question={editing}
          onSave={(patch) => {
            store.updateQuestion(pack.id, editing.id, patch)
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/** 单题编辑表单（见 PRD 4.9：修改题干 / 选项 / 答案 / 解析，保存后重新校验） */
function QuestionEditor({
  question,
  onSave,
  onClose,
}: {
  question: Question
  onSave: (patch: Partial<Question>) => void
  onClose: () => void
}) {
  const t = QUESTION_TYPES.find((x) => x.id === question.type)
  const isJudge = question.type === 'judge'
  const isSingle = question.type === 'single'
  const isMultiple = question.type === 'multiple'
  const hasOptions = !!t?.hasOptions && !isJudge

  const [stem, setStem] = useState(question.stem)
  const [explanation, setExplanation] = useState(question.explanation)
  const [options, setOptions] = useState<string[]>(() => {
    const o = question.options ?? []
    return o.length ? [...o] : ['', '', '', '']
  })
  const [sel, setSel] = useState<number[]>(() => {
    if (isJudge) return question.answer === 'true' ? [0] : [1]
    return parseIdx(question.answer)
  })
  const [textAnswer, setTextAnswer] = useState(question.answer)

  const toggle = (i: number) => {
    if (isSingle) setSel([i])
    else setSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort()))
  }

  const save = () => {
    const patch: Partial<Question> = { stem: stem.trim(), explanation: explanation.trim() }
    if (isJudge) {
      patch.options = ['正确', '错误']
      patch.answer = sel[0] === 0 ? 'true' : 'false'
    } else if (isSingle || isMultiple) {
      patch.options = options.map((o) => o.trim())
      patch.answer = JSON.stringify(sel)
    } else {
      patch.answer = textAnswer.trim()
    }
    onSave(patch)
  }

  return (
    <div className="pv-mask" onClick={onClose}>
      <div className="pv-editor" onClick={(e) => e.stopPropagation()}>
        <div className="pv-editor-title">编辑{typeName(question.type)}</div>

        <label className="pv-field">
          <span>题干</span>
          <textarea value={stem} onChange={(e) => setStem(e.target.value)} rows={3} />
        </label>

        {hasOptions && (
          <label className="pv-field">
            <span>选项</span>
            {options.map((o, i) => (
              <div className="pv-opt-row" key={i}>
                <span className="pv-opt-key">{String.fromCharCode(65 + i)}</span>
                <input
                  value={o}
                  onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button
                  type="button"
                  className={'pv-opt-check' + (sel.includes(i) ? ' on' : '')}
                  onClick={() => toggle(i)}
                >
                  {isSingle ? '单选' : '多选'}
                </button>
              </div>
            ))}
          </label>
        )}

        {isJudge && (
          <label className="pv-field">
            <span>答案</span>
            <div className="pv-judge-toggle">
              <button type="button" className={sel[0] === 0 ? 'on' : ''} onClick={() => setSel([0])}>
                正确
              </button>
              <button type="button" className={sel[0] === 1 ? 'on' : ''} onClick={() => setSel([1])}>
                错误
              </button>
            </div>
          </label>
        )}

        {!hasOptions && !isJudge && (
          <label className="pv-field">
            <span>答案</span>
            <input
              value={textAnswer}
              onChange={(e) => setTextAnswer(e.target.value)}
              placeholder={
                question.type === 'match' ? '如 [[0,1],[1,0]]' : question.type === 'order' ? '如 [0,2,1]' : '参考答案'
              }
            />
          </label>
        )}

        <label className="pv-field">
          <span>解析</span>
          <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={3} />
        </label>

        <div className="pv-editor-btns">
          <button className="btn ghost flex-1" onClick={onClose}>
            取消
          </button>
          <button className="btn flex-1" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
