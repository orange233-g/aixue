import { useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useModal } from '../stores/useModalStore'
import { useQuiz, quizQuestionKey, type AnswerEntry, type QuizSession } from '../stores/useQuizStore'
import {
  formatAnswer,
  isEntryAnswered,
  isEntrySubmitted,
  parseIndexArray,
  parsePairs,
  resolveMatchCols,
  shuffle,
  SUBJECTIVE_TYPES,
  typeName,
} from '../services/quiz'
import type { GradeResult } from '../services/quiz'
import type { Question } from '../types'
import AppIcon from '../components/AppIcon'
import { convertMath } from '../utils/math'
import { renderMarkdown, inline as renderInline } from '../utils/markdown'

/** LaTeX 数学符号 → 可读 Unicode 文本（与聊天区同一套转换；题干/选项/答案/解析统一走这里） */
const M = (s?: string) => (s ? convertMath(s) : '')

/** 题面块级富文本：走与聊天区同一套轻量 Markdown 渲染器（代码块/行内代码/列表），
 *  内容已 HTML 转义防注入；convQuestion 已做过数学符号转换，这里不再重复。
 *  真机反馈：编程题里的代码块按纯文本展示没有格式（旧包 JSX 纯文本插值还会把换行折叠成空格，
 *  表现为「代码挤成一行」），统一接 Markdown 渲染后换行与 ``` 围栏代码块都能正常展示 */
function mdBlock(s?: string): string {
  return s ? renderMarkdown(s) : ''
}

/** 选项等单行文本的行内富文本（行内代码/加粗，不产生块级标签） */
function InlineText({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: renderInline(text) }} />
}

/** 题目文本域转换：返回浅拷贝，id/type/answer 等判分字段不变，仅把题干/选项/答案/解析里的 $...$ 转成可读文本 */
function convQuestion(q: Question): Question {
  return {
    ...q,
    stem: M(q.stem),
    answer: M(q.answer),
    explanation: M(q.explanation),
    options: q.options ? q.options.map(M) : undefined,
  }
}

/** 单题是否已完成作答：统一走 services/quiz 的 isEntryAnswered
 *  （BUG-1/2 修复：计数、提交弹窗、提交判分三处共用同一口径，主观题 = 文本 + 自评） */
function isAnswered(q: Question, entry?: AnswerEntry): boolean {
  return isEntryAnswered(q, entry)
}

function isSubmitted(q: Question, entry?: AnswerEntry): boolean {
  return isEntrySubmitted(q, entry)
}

function questionAt(session: QuizSession, index: number, packs: { id: string; questions: Question[] }[]): Question | undefined {
  const ref = session.questionRefs?.[index]
  if (ref) return packs.find((p) => p.id === ref.packId)?.questions.find((q) => q.id === ref.questionId)
  return packs.flatMap((p) => p.questions).find((q) => q.id === session.questionIds[index])
}

export default function QuizPage() {
  const session = useQuiz((s) => s.session)
  const packs = useQuiz((s) => s.packs)
  const submitting = useQuiz((s) => s.submitting)
  const answer = useQuiz((s) => s.answer)
  const go = useQuiz((s) => s.go)
  const submit = useQuiz((s) => s.submit)
  const finish = useQuiz((s) => s.finish)
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const modal = useModal()

  if (!session) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => navigate('packs')}>‹</button>
          <span className="subhead-title">刷题</span>
        </div>
        <div className="empty"><div className="em"><AppIcon name="book" size={32} /></div><div className="et">暂无刷题会话</div></div>
      </div>
    )
  }

  const total = session.questionIds.length
  const idx = session.index

  // 统一提交后：回顾成绩 + 逐题对错/答案/解析（未作答与待自评分开显示）
  if (session.submitted) {
    const gradedCount = session.questionIds.filter((id) => session.results[id] && !session.results[id].pendingSelfReview).length
    const pendingCount = session.questionIds.filter((id) => session.results[id]?.pendingSelfReview).length
    const pct = gradedCount ? Math.round((session.correct / gradedCount) * 100) : 0
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => { finish(); navigate('pack-detail', true) }}>‹</button>
          <span className="subhead-title">刷题结果</span>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '24px 16px' }}>
          <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--primary)' }}>{pct}%</div>
          <div className="card-title mt-8">正确率 {session.correct} / {gradedCount}</div>
          {pendingCount > 0 && <div className="card-sub mt-6">待自评 {pendingCount} 题不计分、不算错题</div>}
          {total - gradedCount - pendingCount > 0 && (
            <div className="card-sub mt-6">未作答 {total - gradedCount - pendingCount} 题不计分、不算错题</div>
          )}
          <div className="card-sub mt-6">答错题目已自动加入错题本</div>
        </div>
        <div className="page-sub mt-12">答题回顾</div>
        {session.questionIds.map((_, i) => {
          const q = questionAt(session, i, packs)
          if (!q) return null
          const res = session.results[quizQuestionKey(session, i)]
          const notAnswered = !res
          const pendingSelfReview = res?.pendingSelfReview
          const ok = res?.correct
          return (
            <div key={quizQuestionKey(session, i)} className="card" style={{ marginTop: 10 }}>
              <div className="row mb-8">
                <span className="card-sub">第 {i + 1} 题</span>
                <span className={'tag ' + (notAnswered || pendingSelfReview ? 'muted' : ok ? 'success' : 'danger')}>
                  {notAnswered ? '未作答' : pendingSelfReview ? '待自评' : ok ? '答对' : '答错'}
                </span>
              </div>
              <div className="quiz-question md-rich" style={{ marginBottom: 8 }} dangerouslySetInnerHTML={{ __html: mdBlock(q.stem) }} />
              {!notAnswered && !pendingSelfReview && (
                <>
                  <div className="fb-answer">正确答案：{formatAnswer(q)}</div>
                  {q.explanation && <div className="fb-explain md-rich" style={{ marginTop: 6 }} dangerouslySetInnerHTML={{ __html: mdBlock(q.explanation) }} />}
                </>
              )}
            </div>
          )
        })}
        <div className="row mt-14" style={{ gap: 8 }}>
          <button className="btn flex-1" onClick={() => { finish(); navigate('pack-detail', true) }}>
            完成
          </button>
          <button className="btn ghost flex-1" onClick={() => { finish(); navigate('wrong', true) }}>
            查看错题本
          </button>
        </div>
      </div>
    )
  }

  const q = questionAt(session, idx, packs)
  if (!q) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => navigate('pack-detail', true)}>‹</button>
          <span className="subhead-title">刷题</span>
        </div>
        <div className="empty"><div className="em"><AppIcon name="book" size={32} /></div><div className="et">题目不存在</div></div>
      </div>
    )
  }
  const answered = session.questionIds.filter((_, i) => {
    const xq = questionAt(session, i, packs)
    return xq ? isSubmitted(xq, session.answers[quizQuestionKey(session, i)]) : false
  })
  const rest = total - answered.length

  // 未答完可随时提前交卷；未作答题目不算错题（不判分、不入错题本、不计入统计）
  const doSubmit = () => {
    submit().catch((e) => {
      // 落库失败：保留答卷与结果，提示用户稍后重试（绝不在 UI 显示已成功却丢数据）
      console.warn('[quiz] 提交保存失败', e)
      showToast('提交保存失败，请重试')
    })
  }
  const handleSubmit = () => {
    if (rest > 0) {
      modal.confirm('提交交卷', `还有 ${rest} 题未作答，本次将不计分、也不算错题。确定提交吗？`, doSubmit)
      return
    }
    doSubmit()
  }

  const entry = session.answers[quizQuestionKey(session, idx)]

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => { if (!submitting) navigate('pack-detail', true) }}>‹</button>
        <span className="subhead-title">{session.packTitle}</span>
      </div>
      <div className="quiz-body">
        <div className="row mb-8">
          <span className="card-sub">第 {idx + 1} / {total} 题 · 已答 {answered.length}</span>
          <span className="tag primary">{typeName(q.type)}</span>
        </div>
        <div className="progress mb-12"><i style={{ width: `${(idx / total) * 100}%` }} /></div>
        <QuizAnswerCard
          key={q.id}
          q={q}
          initial={entry}
          locked={submitting}
          subjectiveDone={isAnswered(q, entry)}
          subjectiveSubmitted={isSubmitted(q, entry)}
          onSave={(ua, self) => answer(q, ua, self)}
        />
      </div>

      {/* 底部固定操作栏：切题按钮固定在底部，不随题干长短移动；提交按钮全程可用，提前交卷时未答题不算错题 */}
      {/* V4-F03：提交进行中禁用上一题/下一题/提交，避免事务落库期间被切题或重复提交 */}
      <div className="quiz-actions">
        <button className="btn ghost flex-1" disabled={idx === 0 || submitting} onClick={() => go(idx - 1)}>上一题</button>
        <button className="btn flex-1" disabled={idx >= total - 1 || submitting} onClick={() => go(idx + 1)}>下一题</button>
        <button className="btn flex-1" disabled={submitting} onClick={handleSubmit}>
          {submitting ? '提交中...' : '提交'}
        </button>
      </div>
    </div>
  )
}

/**
 * 作答暂存版单选卡片（F5）：只保存答案不判分，可前后切换反复修改，最后统一提交。
 * 主观题在输入文本后展示参考答案并自评（selfCorrect 也会被暂存）。
 */
export function QuizAnswerCard({
  q: _q,
  initial,
  subjectiveDone,
  subjectiveSubmitted,
  locked,
  onSave,
}: {
  q: Question
  initial?: AnswerEntry
  subjectiveDone: boolean
  subjectiveSubmitted: boolean
  /** V4-F03：提交进行中锁定作答输入，禁止改动答卷 */
  locked?: boolean
  onSave: (ua: string, selfCorrect?: boolean) => void
}) {
  const q = convQuestion(_q)
  const isSubjective = SUBJECTIVE_TYPES.includes(q.type)
  // 匹配题左右列：优先结构化数据，缺失时从题干内嵌列表兜底拆分
  const mc = q.type === 'match' ? resolveMatchCols(q) : null
  const initSel = () => {
    try {
      const v = initial?.ua ? JSON.parse(initial.ua) : []
      return Array.isArray(v) ? v.map(Number) : []
    } catch {
      return []
    }
  }
  const [selected, setSelected] = useState<number[]>(() => (isSubjective ? [] : initSel()))
  const [fillText, setFillText] = useState(() => (!isSubjective && q.type !== 'fill' ? '' : initial?.ua ?? ''))
  const [matchLeft, setMatchLeft] = useState<number | null>(null)
  const [pairs, setPairs] = useState<[number, number][]>(() => {
    if (q.type !== 'match' || !initial?.ua) return []
    return parsePairs(initial.ua)
  })
  const [rightOrder] = useState<number[]>(() => shuffle(mc?.right.map((_, i) => i) ?? []))
  const [order, setOrder] = useState<number[]>(() => {
    if (q.type !== 'order') return q.options?.map((_, i) => i) ?? []
    if (initial?.ua) return parseIndexArray(initial.ua)
    return shuffle(q.options?.map((_, i) => i) ?? [])
  })
  const [subjText, setSubjText] = useState(() => (isSubjective ? initial?.ua ?? '' : ''))
  // 自评状态以 store 答卷为唯一事实源（BUG-2 修复）：此前本地 state 与库内暂存脱节——
  // 界面显示「已标记答对」但提交判答错；现在显示直接读暂存条目，写库失败/文本修改重置都如实反映
  const selfCorrect = initial?.selfCorrect ?? null
  const [showAnswer, setShowAnswer] = useState(false)

  const renderOptions = () => {
    // 单选 / 判断：点击即暂存，可再点更换
    if (q.type === 'single' || q.type === 'judge') {
      return (
        <div className="quiz-opts">
          {q.options?.map((o, i) => {
            const isSel = selected[0] === i
            return (
              <button
                key={i}
                type="button"
                className={isSel ? 'opt sel' : 'opt'}
                disabled={locked}
                onClick={() => {
                  setSelected([i])
                  const ua = q.type === 'judge' ? (i === 0 ? 'true' : 'false') : JSON.stringify([i])
                  onSave(ua)
                }}
              >
                {q.type === 'judge' ? <InlineText text={o} /> : (
                  <>{String.fromCharCode(65 + i)}. <InlineText text={o} /></>
                )}
              </button>
            )
          })}
        </div>
      )
    }

    // 多选：勾选切换，选择即暂存整组
    if (q.type === 'multiple') {
      return (
        <div className="quiz-opts">
          <div className="multi-hint">可多选，选择即暂存，可反复调整</div>
          {q.options?.map((o, i) => {
            const isSel = selected.includes(i)
            return (
              <button
                key={i}
                type="button"
                className={isSel ? 'opt sel' : 'opt'}
                disabled={locked}
                onClick={() => {
                  const next = selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i]
                  setSelected(next)
                  onSave(JSON.stringify(next))
                }}
              >
                {`${String.fromCharCode(65 + i)}. `}<InlineText text={o} />
              </button>
            )
          })}
        </div>
      )
    }

    // 填空：本地输入即时暂存，可继续改
    if (q.type === 'fill') {
      return (
        <div className="quiz-opts">
          <input
            className="input"
            placeholder="请输入答案..."
            value={fillText}
            disabled={locked}
            onChange={(e) => {
              setFillText(e.target.value)
              if (e.target.value.trim()) onSave(e.target.value)
            }}
          />
          {fillText.trim() && <button className="btn sm block mt-12" disabled={locked} onClick={() => onSave(fillText)}>已暂存</button>}
        </div>
      )
    }

    // 匹配：配对即暂存，可增删调整
    if (q.type === 'match') {
      const left = mc?.left ?? []
      const right = mc?.right ?? []
      if (mc?.incomplete || !left.length || !right.length) {
        return (
          <div className="quiz-opts">
            <div className="multi-hint">先点左侧项，再点右侧项完成配对；配对即暂存</div>
            <div className="match-empty">本题数据不完整（缺少左/右列），无法作答</div>
          </div>
        )
      }
      return (
        <div className="quiz-opts">
          <div className="multi-hint">先点左侧项，再点右侧项完成配对；配对即暂存</div>
          <div className="match-cols">
            <div className="match-col">
              {left.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  className={'match-item' + (matchLeft === i ? ' sel' : '')}
                  disabled={locked}
                  onClick={() => setMatchLeft(i)}
                >
                  {o}
                </button>
              ))}
            </div>
            <div className="match-col">
              {rightOrder.map((ri) => (
                <button
                  key={ri}
                  type="button"
                  className={'match-item' + (pairs.some(([, r]) => r === ri) ? ' used' : '')}
                  disabled={locked}
                  onClick={() => {
                    if (matchLeft === null) return
                    const next: [number, number][] = [...pairs.filter(([, r]) => r !== ri), [matchLeft, ri]]
                    setPairs(next)
                    setMatchLeft(null)
                    onSave(JSON.stringify(next))
                  }}
                >
                  {right[ri]}
                </button>
              ))}
            </div>
          </div>
          {pairs.length > 0 && (
            <div className="match-pairs">
              {pairs.map(([l, r], i) => (
                <div key={i} className="match-pair">
                  <span>{left[l]}</span>
                  <span className="arrow">→</span>
                  <span>{right[r]}</span>
                  <button
                    className="pair-del"
                    disabled={locked}
                    onClick={() => {
                      const next = pairs.filter((_, x) => x !== i)
                      setPairs(next)
                      onSave(JSON.stringify(next))
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    // 排序：调整顺序即暂存
    if (q.type === 'order') {
      return (
        <div className="quiz-opts">
          <div className="multi-hint">点击 ↑↓ 调整顺序，结果即暂存</div>
          {order.map((oi, i) => (
            <div key={oi} className="order-item">
              <span className="order-idx">{i + 1}</span>
              <span className="order-text"><InlineText text={q.options?.[oi] ?? ''} /></span>
              <span className="order-btns">
                <button disabled={i === 0 || locked} onClick={() => setOrder((o) => { const n = swap(o, i, i - 1); onSave(JSON.stringify(n)); return n })}>↑</button>
                <button disabled={i === order.length - 1 || locked} onClick={() => setOrder((o) => { const n = swap(o, i, i + 1); onSave(JSON.stringify(n)); return n })}>↓</button>
              </span>
            </div>
          ))}
        </div>
      )
    }

    // 主观题：输入 + 参考答案自评
    return (
      <div className="quiz-opts">
        <textarea
          className="input textarea"
          rows={4}
          placeholder="请输入你的作答..."
          value={subjText}
          disabled={locked}
          onChange={(e) => {
            setSubjText(e.target.value)
            onSave(e.target.value)
          }}
        />
        {subjText.trim() && (
          <div className="mt-12">
            <button className="btn sm ghost block" disabled={locked} onClick={() => setShowAnswer((v) => !v)}>
              {showAnswer ? '隐藏参考答案' : '查看参考答案'}
            </button>
            {showAnswer && (
              <div className="subj-self">
                <div className="subj-ref">
                  <div className="card-sub" style={{ fontWeight: 700, marginBottom: 4 }}>参考答案</div>
                  <div className="md-rich" style={{ fontSize: 13, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: mdBlock(q.answer) }} />
                </div>
                <div className="card-sub" style={{ margin: '10px 0 6px' }}>对照参考答案，你的作答：</div>
                <div className="row">
                  <button
                    className={'btn sm flex-1' + (selfCorrect === true ? '' : ' ghost')}
                    disabled={locked}
                    onClick={() => onSave(subjText, true)}
                  >
                    {selfCorrect === true ? '已标记答对' : '答对了'}
                  </button>
                  <button
                    className={'btn sm ghost flex-1' + (selfCorrect === false ? ' danger' : '')}
                    disabled={locked}
                    onClick={() => onSave(subjText, false)}
                  >
                    {selfCorrect === false ? '已标记答错' : '答错了'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="quiz-question md-rich" dangerouslySetInnerHTML={{ __html: mdBlock(q.type === 'match' && mc ? mc.stem : q.stem) }} />
      {renderOptions()}
      {/* F3：客观题已作答后可展开查看参考答案+解析 */}
      {!isSubjective && !!initial?.ua && (
        <div className="mt-12">
          <button className="btn sm ghost block" onClick={() => setShowAnswer((v) => !v)}>
            {showAnswer ? '隐藏参考答案' : '查看参考答案'}
          </button>
          {showAnswer && (
            <div className="quiz-feedback">
              <div className="fb-card ok">
                <div className="fb-answer">参考答案：{formatAnswer(q)}</div>
                {q.explanation && <div className="fb-explain md-rich" dangerouslySetInnerHTML={{ __html: mdBlock(q.explanation) }} />}
              </div>
            </div>
          )}
        </div>
      )}
      {isSubjective && subjectiveSubmitted && !subjectiveDone && (
        <div className="quiz-feedback">
          <div className="fb-card ok">
            <div className="fb-title">已填写，待自评</div>
          </div>
        </div>
      )}
      {isSubjective && subjectiveDone && (
        <div className="quiz-feedback">
          <div className={'fb-card ' + (selfCorrect ? 'ok' : 'no')}>
            <div className="fb-title">已自评：{selfCorrect ? '答对' : '答错'}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function swap<T>(arr: T[], i: number, j: number): T[] {
  const a = arr.slice()
  ;[a[i], a[j]] = [a[j], a[i]]
  return a
}

/* ============================================================
 * 以下 QuestionCard 为「复习页」复用组件（逐题即时判分），保持原逻辑不变。
 * ============================================================ */

/** 单题作答卡片：按题型渲染作答区 + 判分反馈（复习页复用，见 PRD 4.8） */
export function QuestionCard({
  q: _q,
  onAnswer,
  onNext,
  feedbackNote,
}: {
  q: Question
  onAnswer: (q: Question, ua: string, selfCorrect?: boolean) => GradeResult
  onNext: () => void
  /** 自定义反馈标题（复习页展示间隔重复结果） */
  feedbackNote?: (correct: boolean) => string
}) {
  const q = convQuestion(_q)
  const isSubjective = SUBJECTIVE_TYPES.includes(q.type)
  // 匹配题左右列：优先结构化数据，缺失时从题干内嵌列表兜底拆分
  const mc = q.type === 'match' ? resolveMatchCols(q) : null
  const [result, setResult] = useState<GradeResult | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [fillText, setFillText] = useState('')
  const [matchLeft, setMatchLeft] = useState<number | null>(null)
  const [pairs, setPairs] = useState<[number, number][]>([])
  const [rightOrder] = useState<number[]>(() => shuffle(mc?.right.map((_, i) => i) ?? []))
  const [order, setOrder] = useState<number[]>(() => shuffle(q.options?.map((_, i) => i) ?? []))
  const [subjText, setSubjText] = useState('')
  const [selfCorrect, setSelfCorrect] = useState<boolean | null>(null)

  const answered = result !== null
  // 主观题已提交但未自评：显示参考答案与自评按钮
  const awaitingSelf = answered && isSubjective && selfCorrect === null

  const submit = (userAnswer: string, self?: boolean) => {
    setResult(onAnswer(q, userAnswer, self))
  }

  const handleNext = () => {
    setResult(null)
    setSelected([])
    setFillText('')
    setMatchLeft(null)
    setPairs([])
    setSubjText('')
    setSelfCorrect(null)
    onNext()
  }

  const renderC = () => {
    // 单选 / 判断：点击即判分
    if (q.type === 'single' || q.type === 'judge') {
      const correctIdx = q.type === 'judge' ? (q.answer === 'true' ? 0 : 1) : parseIndexArray(q.answer)[0]
      return (
        <div className="quiz-opts">
          {q.options?.map((o, i) => {
            const isSel = selected[0] === i
            const cls = answered
              ? i === correctIdx ? 'opt correct' : isSel ? 'opt wrong' : 'opt dim'
              : isSel ? 'opt sel' : 'opt'
            return (
              <button
                key={i}
                type="button"
                className={cls}
                disabled={answered}
                onClick={() => {
                  setSelected([i])
                  const ua = q.type === 'judge' ? (i === 0 ? 'true' : 'false') : JSON.stringify([i])
                  submit(ua)
                }}
              >
                {q.type === 'judge' ? <InlineText text={o} /> : (
                  <>{String.fromCharCode(65 + i)}. <InlineText text={o} /></>
                )}
              </button>
            )
          })}
        </div>
      )
    }

    // 多选：勾选后确认
    if (q.type === 'multiple') {
      return (
        <div className="quiz-opts">
          <div className="multi-hint">可多选，点击选项后确认作答</div>
          {q.options?.map((o, i) => {
            const isSel = selected.includes(i)
            const cls = answered
              ? parseIndexArray(q.answer).includes(i) ? 'opt correct' : isSel ? 'opt wrong' : 'opt dim'
              : isSel ? 'opt sel' : 'opt'
            return (
              <button
                key={i}
                type="button"
                className={cls}
                disabled={answered}
                onClick={() => {
                  setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))
                }}
              >
                {`${String.fromCharCode(65 + i)}. `}<InlineText text={o} />
              </button>
            )
          })}
          {!answered && (
            <button className="btn sm block mt-12" onClick={() => submit(JSON.stringify(selected))}>
              确认作答
            </button>
          )}
        </div>
      )
    }

    // 填空
    if (q.type === 'fill') {
      return (
        <div className="quiz-opts">
          <input
            className="input"
            placeholder="请输入答案..."
            value={fillText}
            disabled={answered}
            onChange={(e) => setFillText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fillText.trim() && !answered) submit(fillText)
            }}
          />
          {!answered && (
            <button className="btn sm block mt-12" onClick={() => fillText.trim() && submit(fillText)}>
              提交答案
            </button>
          )}
        </div>
      )
    }

    // 匹配
    if (q.type === 'match') {
      const left = mc?.left ?? []
      const right = mc?.right ?? []
      if (mc?.incomplete || !left.length || !right.length) {
        return (
          <div className="quiz-opts">
            <div className="multi-hint">先点左侧项，再点右侧项完成配对</div>
            <div className="match-empty">本题数据不完整（缺少左/右列），无法作答</div>
          </div>
        )
      }
      return (
        <div className="quiz-opts">
          <div className="multi-hint">先点左侧项，再点右侧项完成配对</div>
          <div className="match-cols">
            <div className="match-col">
              {left.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  className={'match-item' + (matchLeft === i && !answered ? ' sel' : '')}
                  disabled={answered}
                  onClick={() => setMatchLeft(i)}
                >
                  {o}
                </button>
              ))}
            </div>
            <div className="match-col">
              {rightOrder.map((ri) => (
                <button
                  key={ri}
                  type="button"
                  className={'match-item' + (pairs.some(([, r]) => r === ri) ? ' used' : '')}
                  disabled={answered || matchLeft === null}
                  onClick={() => {
                    if (matchLeft === null) return
                    setPairs((p) => [...p.filter(([, r]) => r !== ri), [matchLeft, ri]])
                    setMatchLeft(null)
                  }}
                >
                  {right[ri]}
                </button>
              ))}
            </div>
          </div>
          {pairs.length > 0 && (
            <div className="match-pairs">
              {pairs.map(([l, r], i) => (
                <div key={i} className="match-pair">
                  <span>{left[l]}</span>
                  <span className="arrow">→</span>
                  <span>{right[r]}</span>
                  {!answered && (
                    <button className="pair-del" onClick={() => setPairs((p) => p.filter((_, x) => x !== i))}>×</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!answered && pairs.length > 0 && (
            <button className="btn sm block mt-12" onClick={() => submit(JSON.stringify(pairs))}>
              确认作答
            </button>
          )}
        </div>
      )
    }

    // 排序
    if (q.type === 'order') {
      return (
        <div className="quiz-opts">
          <div className="multi-hint">点击 ↑↓ 调整顺序</div>
          {order.map((oi, i) => (
            <div key={oi} className="order-item">
              <span className="order-idx">{i + 1}</span>
              <span className="order-text"><InlineText text={q.options?.[oi] ?? ''} /></span>
              {!answered && (
                <span className="order-btns">
                  <button disabled={i === 0} onClick={() => setOrder((o) => swap(o, i, i - 1))}>↑</button>
                  <button disabled={i === order.length - 1} onClick={() => setOrder((o) => swap(o, i, i + 1))}>↓</button>
                </span>
              )}
            </div>
          ))}
          {!answered && (
            <button className="btn sm block mt-12" onClick={() => submit(JSON.stringify(order))}>
              确认作答
            </button>
          )}
        </div>
      )
    }

    // 主观题：输入 + 参考答案自评
    return (
      <div className="quiz-opts">
        <textarea
          className="input textarea"
          rows={4}
          placeholder="请输入你的作答..."
          value={subjText}
          disabled={answered}
          onChange={(e) => setSubjText(e.target.value)}
        />
        {!answered && (
          <button
            className="btn sm block mt-12"
            onClick={() => subjText.trim() && setResult({ correct: false, score: 0, subjective: true })}
          >
            提交作答
          </button>
        )}
        {awaitingSelf && (
          <div className="subj-self">
            <div className="subj-ref">
              <div className="card-sub" style={{ fontWeight: 700, marginBottom: 4 }}>参考答案</div>
              <div className="md-rich" style={{ fontSize: 13, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: mdBlock(q.answer) }} />
            </div>
            <div className="card-sub" style={{ margin: '10px 0 6px' }}>对照参考答案，你的作答：</div>
            <div className="row">
              <button className="btn sm flex-1" onClick={() => { setSelfCorrect(true); submit(subjText, true) }}>
                答对了
              </button>
              <button className="btn sm ghost flex-1" onClick={() => { setSelfCorrect(false); submit(subjText, false) }}>
                答错了
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="quiz-question md-rich" dangerouslySetInnerHTML={{ __html: mdBlock(q.stem) }} />
      {renderC()}

      {/* 反馈区 */}
      {answered && !awaitingSelf && (
        <div className="quiz-feedback">
          <div className={'fb-card ' + (result?.correct ? 'ok' : 'no')}>
            <div className="fb-title">
              {feedbackNote
                ? feedbackNote(result?.correct ?? false)
                : result?.correct
                  ? '回答正确'
                  : '回答错误' + (result?.correct ? '' : ' · 已加入错题本')}
            </div>
            {!result?.correct && !isSubjective && (
              <div className="fb-answer">正确答案：{formatAnswer(q)}</div>
            )}
            {q.explanation && <div className="fb-explain md-rich" dangerouslySetInnerHTML={{ __html: mdBlock(q.explanation) }} />}
            <button className="btn sm block mt-12" onClick={handleNext}>
              下一题
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
