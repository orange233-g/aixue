import { useMemo, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { usePacks } from '../stores/usePackStore'
import { useLearning } from '../stores/useLearningStore'
import { useKB } from '../stores/useKBStore'
import { buildImportPlan, applyImport } from '../services/io'
import { fmtDate } from '../utils'

export default function ImportPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const importFile = useUI((s) => s.importFile)
  const setImportFile = useUI((s) => s.setImportFile)
  const packs = usePacks((s) => s.packs)
  const loadPacks = usePacks((s) => s.load)
  const loadLearning = useLearning((s) => s.load)
  const loadKB = useKB((s) => s.load)
  const [merge, setMerge] = useState(false)
  const [busy, setBusy] = useState(false)

  // V3-F03：useMemo 保持纯计算，返回 { plan, error }，不在渲染期调用 setState（React 并发下不稳定）
  const { plan, error } = useMemo(() => {
    if (!importFile) return { plan: null, error: null }
    try {
      return { plan: buildImportPlan(importFile, packs), error: null }
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : '备份文件校验失败，请检查文件是否完整' }
    }
  }, [importFile, packs])

  const back = () => {
    setImportFile(null)
    navigate('packs')
  }

  const handleConfirm = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const { imported, skipped } = await applyImport(plan, { merge })
      // 导入备份可能包含知识库；刷新 KB store，避免当前已加载页面继续显示旧快照。
      await Promise.all([loadPacks(), loadLearning(), loadKB()])
      // 6.83：坏题在预览已逐条展示，完成 toast 再带一次总数，与「已导入」口径闭环
      const badQ = plan.skipped.questionTotal
      showToast(
        `已导入 ${imported} 个学习本${skipped > 0 ? `，跳过 ${skipped} 个重复` : ''}` +
        `${badQ > 0 ? `，坏题已跳过 ${badQ} 题` : ''}`,
      )
      setImportFile(null)
      navigate('packs')
    } catch (e) {
      console.error('[import] failed:', e)
      showToast('导入失败，请检查文件')
    } finally {
      setBusy(false)
    }
  }

  if (!importFile || !plan) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={back}>‹</button>
          <span className="subhead-title">导入</span>
        </div>
        {error ? (
          <div className="card">
            <div className="row">
              <span className="card-title flex-1">校验未通过</span>
            </div>
            <div className="card-sub mt-8">{error}</div>
            <button className="btn block mt-12" onClick={back}>返回</button>
          </div>
        ) : (
          <div className="empty">
            <div className="em">📄</div>
            <div className="et">没有待导入文件</div>
            <div className="es">请从学习库或「我的」页选择 .md 或 .json 文件</div>
          </div>
        )}
      </div>
    )
  }

  const dupCount = plan.packs.filter((p) => p.duplicate).length

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={back}>‹</button>
        <span className="subhead-title">导入预览</span>
      </div>

      <div className="card">
        <div className="row">
          <span className="card-title flex-1">
            {plan.type === 'backup' ? '完整备份' : '学习本分享'}
          </span>
          <span className="tag success">v{importFile.version}</span>
        </div>
        {importFile.exportedAt && (
          <div className="card-sub mt-8">导出时间：{fmtDate(importFile.exportedAt)}</div>
        )}
        <div className="card-sub mt-8">
          {plan.type === 'backup'
            ? `包含 ${plan.packs.length} 个学习本、${plan.learning.length} 条学习记录、${plan.wrongs.length} 条错题、${plan.usage.length} 条用量、${plan.knowledgeBases.length} 个知识库`
            : '仅学习本内容，不含个人学习进度'}
        </div>        {(plan.type === 'backup' || plan.answers.length > 0) && (
          <div className="card-sub mt-8" style={{ opacity: 0.72 }}>
            {plan.answers.length > 0 && (() => {
              // V4-F05：按当前 merge 状态计算真实追加数——跳过重复学习本时，引用它的作答也不写入
              const appended = plan.answers.length - plan.answersOrphans - (merge ? 0 : plan.answersViaDupPack)
              return `作答历史：${appended} 条将追加到本机（不覆盖）`
            })()}
            {plan.answersViaDupPack > 0 && !merge && plan.answers.length > 0 ? '；' : ''}
            {plan.answersViaDupPack > 0 && !merge && `${plan.answersViaDupPack} 条随重复学习本一并跳过`}
            {plan.answersOrphans > 0 && plan.answers.length > 0 ? '；' : ''}
            {plan.answersOrphans > 0 && `${plan.answersOrphans} 条无关联学习本，导入时忽略`}
            {plan.usage.length > 0 && `；用量：${plan.usage.length} 条将追加（新 ID）`}
            {plan.knowledgeBases.length > 0 && `；知识库：ID 冲突时追加不覆盖`}
          </div>
        )}
      </div>

      {(plan.skipped.questionTotal > 0 || plan.skipped.packs.length > 0 || plan.skipped.wrongs > 0) && (
        <div className="card">
          <div className="row">
            <span className="card-title flex-1">部分内容将跳过</span>
            <span className="tag warning">
              {plan.skipped.questionTotal > 0 && `${plan.skipped.questionTotal} 题`}
              {plan.skipped.questionTotal > 0 && plan.skipped.wrongs > 0 ? ' · ' : ''}
              {plan.skipped.wrongs > 0 && `${plan.skipped.wrongs} 错题`}
            </span>
          </div>
          <div className="card-sub mt-8">
            {plan.skipped.questions.map((s, i) => (
              <div key={`q${i}`}>· 「{s.packTitle}」第 {s.index} 题：{s.reason}</div>
            ))}
            {plan.skipped.questionTotal > plan.skipped.questions.length && (
              <div>· …其余 {plan.skipped.questionTotal - plan.skipped.questions.length} 题同样不合法，略列</div>
            )}
            {plan.skipped.packs.map((p, i) => (
              <div key={`p${i}`}>· 「{p.title}」{p.reason}，整包跳过</div>
            ))}
            {plan.skipped.wrongs > 0 && <div>· 错题记录跳过 {plan.skipped.wrongs} 条（题目不合法或引用不一致）</div>}
          </div>
        </div>
      )}

      <div className="page-sub">学习本列表</div>
      {plan.packs.map(({ pack, duplicate }) => (
        <div key={pack.id} className="card">
          <div className="row">
            <span className="card-title flex-1">{pack.title}</span>
            {duplicate && <span className="tag warning">已存在</span>}
          </div>
          <div className="card-sub mt-8">
            {pack.questions.length} 题 · {pack.chapters.length} 章节 · {pack.meta.difficulty}
          </div>
        </div>
      ))}

      {dupCount > 0 && (
        <div className="card">
          <div className="row">
            <span className="card-sub flex-1">
              {dupCount} 个学习本已存在，合并将覆盖现有内容
            </span>
            <button
              className={'chip' + (merge ? ' active' : '')}
              onClick={() => setMerge(!merge)}
            >
              {merge ? '合并' : '跳过'}
            </button>
          </div>
        </div>
      )}

      <button className="btn block mt-12" disabled={busy} onClick={handleConfirm}>
        {busy ? '导入中...' : `确认导入（${plan.packs.length} 个学习本）`}
      </button>
    </div>
  )
}
