import { useEffect } from 'react'
import { useUI } from '../stores/useUIStore'
import { useReview } from '../stores/useReviewStore'
import { gradeAnswer } from '../services/quiz'
import { QuestionCard } from './QuizPage'
import AppIcon from '../components/AppIcon'

/** 复习页（见 PRD 4.8）：复用刷题组件，展示复习进度与间隔重复反馈 */
export default function ReviewPage() {
  const navigate = useUI((s) => s.navigate)
  const { list, index, done, lastFeedback, loaded, load, start, answer, next, finish } = useReview()

  useEffect(() => {
    if (!loaded) load()
    // 已有进行中的复习会话则续刷，否则构建新序列
    if (list.length === 0) start()
  }, [loaded])

  if (loaded && list.length === 0) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => navigate('home')}>‹</button>
          <span className="subhead-title">今日复习</span>
        </div>
        <div className="empty">
          <div className="em"><AppIcon name="check" size={32} /></div>
          <div className="et">今日复习已完成</div>
          <div className="es">明天再来看看</div>
        </div>
      </div>
    )
  }

  // BUG-3 修复：复习完成退出时——①等最后一题的原子提交落库（answer 是异步事务，next() 不等它，
  // 立刻回首页会让角标重查到旧调度数据）；②主动重查到期数，首页角标不依赖返回效果链的时序
  const exitReview = async () => {
    let guard = 0
    while (useReview.getState().saving && guard < 20) {
      await new Promise((r) => window.setTimeout(r, 50))
      guard++
    }
    finish()
    void load()
    navigate('home')
  }

  // 完成页
  if (index >= list.length) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => { void exitReview() }}>‹</button>
          <span className="subhead-title">今日复习</span>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '32px 16px' }}>
          <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--primary)' }}>{done}</div>
          <div className="card-title mt-8">今日复习完成</div>
          <div className="card-sub mt-6">共复习 {done} 个知识点</div>
          <div className="row mt-12">
            <button className="btn flex-1" onClick={() => { void exitReview() }}>完成</button>
          </div>
        </div>
      </div>
    )
  }

  const item = list[index]
  const total = list.length

  const feedbackNote = (correct: boolean) => {
    if (!lastFeedback) return ''
    return correct ? `回答正确 · 下次 ${lastFeedback.interval} 天后复习` : '回答错误 · 明天再复习'
  }

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => navigate('home')}>‹</button>
        <span className="subhead-title">今日复习</span>
      </div>
      <div className="row mb-8">
        <span className="card-sub">已完成 {done} / {total}</span>
        <span className="tag primary">{item.kpTitle}</span>
      </div>
      <div className="progress mb-12"><i style={{ width: `${(done / total) * 100}%` }} /></div>
      <QuestionCard
        key={item.question.id}
        q={item.question}
        onAnswer={(q, ua, self) => {
          const result = gradeAnswer(q, ua)
          const correct = result.subjective ? (self ?? false) : result.correct
          void answer(item, correct)
          return { ...result, correct }
        }}
        onNext={() => next()}
        feedbackNote={feedbackNote}
      />
    </div>
  )
}
