import { useEffect, useMemo, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useLearning } from '../stores/useLearningStore'
import { usePacks } from '../stores/usePackStore'
import { useQuiz } from '../stores/useQuizStore'
import type { WrongRecord } from '../types'
import AppIcon from '../components/AppIcon'
import { renderMarkdown } from '../utils/markdown'

type Filter = 'all' | 'new' | 'done'

export default function WrongPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const { wrongs, loaded, load, markMastered, remove } = useLearning()
  const packs = usePacks((s) => s.packs)
  const packsLoaded = usePacks((s) => s.loaded)
  const loadPacks = usePacks((s) => s.load)
  const startWrong = useQuiz((s) => s.startWrong)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    if (!loaded) load()
    if (!packsLoaded) loadPacks()
  }, [loaded, packsLoaded])

  const groups = useMemo(() => {
    const list = wrongs.filter((w) =>
      filter === 'new' ? !w.mastered : filter === 'done' ? w.mastered : true,
    )
    const map = new Map<string, WrongRecord[]>()
    for (const w of list) {
      const arr = map.get(w.packId) ?? []
      arr.push(w)
      map.set(w.packId, arr)
    }
    return [...map.entries()].map(([packId, records]) => ({
      packId,
      packTitle: records[0].packTitle,
      records,
    }))
  }, [wrongs, filter])

  const unmastered = wrongs.filter((w) => !w.mastered)

  const handleRetry = async () => {
    if (unmastered.length === 0) {
      showToast('暂无未掌握错题')
      return
    }
    if (!packsLoaded) await loadPacks()
    await startWrong(unmastered, packs)
    navigate('quiz', true)
  }

  const handleMaster = (w: WrongRecord) => {
    markMastered(w)
    showToast('已标记掌握，移出错题本')
  }

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => navigate('packs')}>‹</button>
        <span className="subhead-title">错题本</span>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          className={'chip' + (filter === 'all' ? ' active' : '')}
          onClick={() => setFilter('all')}
        >
          全部 {wrongs.length}
        </button>
        <button
          className={'chip' + (filter === 'new' ? ' active' : '')}
          onClick={() => setFilter('new')}
        >
          未掌握 {unmastered.length}
        </button>
        <button
          className={'chip' + (filter === 'done' ? ' active' : '')}
          onClick={() => setFilter('done')}
        >
          已掌握 {wrongs.length - unmastered.length}
        </button>
      </div>

      {loaded && wrongs.length === 0 && (
        <div className="empty">
          <div className="em"><AppIcon name="check" size={32} /></div>
          <div className="et">没有错题</div>
          <div className="es">继续保持</div>
        </div>
      )}

      {/* OBS-1 修复：筛选维度为空（整本非空但当前筛选无结果）时给出空态提示，而非列表区空白 */}
      {loaded && wrongs.length > 0 && groups.length === 0 && (
        <div className="empty">
          <div className="em"><AppIcon name="check" size={32} /></div>
          <div className="et">{filter === 'done' ? '还没有已掌握的错题' : '没有未掌握的错题'}</div>
          <div className="es">切换筛选查看全部 {wrongs.length} 题</div>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.packId} className="card wrong-group">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="card-title flex-1">{g.packTitle}</span>
            <span className="tag muted">{g.records.length} 题</span>
          </div>
          {g.records.map((w) => (
            <div key={w.questionId} className="wrong-item">
              <div className="flex-1">
                <div className="wrong-stem md-rich" dangerouslySetInnerHTML={{ __html: renderMarkdown(w.question.stem) }} />
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  <span className={'tag ' + (w.mastered ? 'success' : 'danger')}>
                    答错 {w.wrongCount} 次
                  </span>
                  {!w.mastered && w.correctStreak > 0 && (
                    <span className="tag warning">连续答对 {w.correctStreak} 次</span>
                  )}
                </div>
              </div>
              <button
                className={'wrong-act ' + (w.mastered ? 'del' : '')}
                title={w.mastered ? '移出错题本' : '标记已掌握'}
                onClick={() => (w.mastered ? remove(w.questionId, w.packId) : handleMaster(w))}
              >
                {w.mastered ? '×' : '✓'}
              </button>
            </div>
          ))}
        </div>
      ))}

      {wrongs.length > 0 && (
        <button
          className="btn block mt-12"
          disabled={unmastered.length === 0}
          onClick={handleRetry}
        >
          错题重练（{unmastered.length} 题）
        </button>
      )}
    </div>
  )
}
