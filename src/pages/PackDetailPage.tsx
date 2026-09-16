import { useEffect, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { usePacks } from '../stores/usePackStore'
import { useQuiz } from '../stores/useQuizStore'
import { useLearning } from '../stores/useLearningStore'
import { useModal } from '../stores/useModalStore'
import { exportResultToast, exportTextFile, sanitizeFileName } from '../utils'
import { exportPackMarkdown } from '../services/io'
import { formatAnswer, typeName } from '../services/quiz'
import { renderMarkdown, inline as renderInline } from '../utils/markdown'
import type { Chapter, Pack, Question } from '../types'
import AppIcon from '../components/AppIcon'

const DIFF_LABEL: Record<number, string> = { 1: '易', 2: '中', 3: '难' }

interface Section {
  chapterId?: string
  title: string
  summary?: string
  kpCount: number
  questions: Question[]
  /** 二级章节（学习本两级章节时，一级章在展开区挂子章节，而非直接铺题目） */
  children?: Section[]
}

/** 单章 → Section（含递归二级子章节） */
function chapterToSection(ch: Chapter, byId: Map<string, Question>): Section {
  const qs = (ch.question_ids ?? []).filter((id) => byId.has(id)).map((id) => byId.get(id)!) as Question[]
  return {
    chapterId: ch.id,
    title: ch.title,
    summary: ch.summary,
    kpCount: ch.knowledge_points?.length ?? 0,
    questions: qs,
    children: (ch.children ?? []).length ? ch.children!.map((cc) => chapterToSection(cc, byId)) : undefined,
  }
}

/** 按章节组织题目。有章节则逐章展开其 question_ids；映射不到章节的题目兜底归入「其他」，
 *  无章节/全空空则整包归为一栏，保证所有题目始终可见。 */
function buildSections(pack: Pack): Section[] {
  const all = pack.questions ?? []
  const byId = new Map<string, Question>()
  for (const q of all) byId.set(q.id, q)
  const chapters = pack.chapters ?? []
  if (chapters.length) {
    const claimed = new Set<string>()
    const sections: Section[] = []
    for (const ch of chapters) {
      const sec = chapterToSection(ch, byId)
      sec.questions.forEach((q) => claimed.add(q.id))
      if (sec.questions.length) sections.push(sec)
    }
    if (sections.length === 0) {
      return [{ title: '全部题目', kpCount: 0, questions: all }]
    }
    const leftover = all.filter((q) => !claimed.has(q.id))
    if (leftover.length) {
      sections.push({ title: '其他题目', kpCount: 0, questions: leftover })
    }
    return sections
  }
  return [{ title: '全部题目', kpCount: 0, questions: all }]
}

export default function PackDetailPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const currentPackId = useUI((s) => s.currentPackId)
  const packs = usePacks((s) => s.packs)
  const startQuiz = useQuiz((s) => s.start)
  const modal = useModal()
  const { loaded: learningLoaded, load: loadLearning } = useLearning()
  const [expanded, setExpanded] = useState<string[]>([])
  /** 章级别默认收起：仅展示章节标题，点击才展开该章题目 */
  const [openChapters, setOpenChapters] = useState<string[]>([])

  useEffect(() => {
    if (!learningLoaded) loadLearning()
  }, [learningLoaded])

  const pack = packs.find((p) => p.id === currentPackId) ?? packs[0]

  if (!pack) {
    return (
      <div>
        <div className="subhead">
          <button className="back-btn" onClick={() => navigate('packs')}>‹</button>
          <span className="subhead-title">学习本详情</span>
        </div>
        <div className="empty"><div className="em"><AppIcon name="library" size={32} /></div><div className="et">学习本不存在</div></div>
      </div>
    )
  }

  const total = pack.questions?.length ?? 0
  const meta = pack.meta ?? {}
  const tags = meta.tags?.length ? meta.tags : []
  const types = meta.types?.length ? meta.types : []

  const toggle = (id: string) =>
    setExpanded((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  const toggleChapter = (id: string) =>
    setOpenChapters((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const handleExport = async () => {
    try {
      const r = await exportTextFile(`${sanitizeFileName(pack.title)}.md`, exportPackMarkdown(pack), 'text/markdown')
      // 6.85：原生端已落 Documents/ai学/ 副本（或如实报错），分享面板关闭后 toast 汇报落点；
      // Web 端浏览器下载已开始，保留原提示
      showToast(exportResultToast(r, '已导出学习本（md）'))
    } catch (e) {
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const startShua = () => {
    if (total === 0) {
      showToast('该学习本暂无题目')
      return
    }
    modal.shua(total, async (mode, count) => {
      await startQuiz(pack, mode, count)
      navigate('quiz', true)
    })
  }

  const startChapter = (chapterId?: string, chapterTotal?: number) => {
    if (total === 0) {
      showToast('该学习本暂无题目')
      return
    }
    // 章节刷与整本刷同弹窗：顺序/随机可选 + 本次题数可键入（默认上限=该章题数）
    modal.shua(chapterTotal ?? total, async (mode, count) => {
      await startQuiz(pack, mode, count, chapterId)
      navigate('quiz', true)
    })
  }

  const sections = buildSections(pack)

  /** 题目列表（展开某题的答案/解析） */
  const renderQList = (qs: Section['questions']) => (
    <div className="q-list">
      {qs.map((q, qi) => (
        <div key={q.id} className={'quiz-q' + (expanded.includes(q.id) ? ' open' : '')} onClick={() => toggle(q.id)}>
          <div className="q-top">
            <span className="tag">{typeName(q.type)}</span>
            <span className="card-sub">{DIFF_LABEL[q.difficulty] ?? '中'} · {qi + 1}</span>
            <span className="card-sub" style={{ marginLeft: 'auto' }}>{expanded.includes(q.id) ? '收起' : '展开'}</span>
          </div>
          <div className="q-stem md-rich" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.stem) }} />
          {expanded.includes(q.id) && (
            <div className="q-detail">
              {q.material && <div className="q-mat md-rich">📄 <span dangerouslySetInnerHTML={{ __html: renderMarkdown(q.material) }} /></div>}
              {q.options?.length ? (
                <div className="q-opts">{q.options.map((o, i) => <div key={i}>{String.fromCharCode(65 + i)}. <span dangerouslySetInnerHTML={{ __html: renderInline(o) }} /></div>)}</div>
              ) : null}
              {q.answer && <div className="q-ans">答案：{formatAnswer(q)}</div>}
              <div className="q-exp md-rich">解析：<span dangerouslySetInnerHTML={{ __html: renderMarkdown(q.explanation ?? '') }} /></div>
            </div>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => navigate('packs')}>‹</button>
        <span className="subhead-title">学习本详情</span>
      </div>

      <div className="card">
        <div className="row">
          <span className="card-title flex-1">{pack.title}</span>
          <button className="pack-menu" title="导出学习本（md）" onClick={handleExport}><AppIcon name="download" size={20} /></button>
        </div>
        <div className="card-sub mt-8">
          {pack.category || '未分类'} · {meta.difficulty ?? '未标注'}
        </div>
        {pack.description && <div className="card-sub mt-8 dd-desc">{pack.description}</div>}
        {tags.length > 0 && (
          <div className="dd-tags mt-8">
            {tags.map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
        )}
        <div className="dd-meta mt-8">
          {types.length > 0 && <div className="dd-row"><span>题型</span><b>{types.join('、')}</b></div>}
          {meta.source && <div className="dd-row"><span>来源</span><b>{meta.source}</b></div>}
          {meta.version && <div className="dd-row"><span>版本</span><b>{meta.version}{meta.formatVersion ? `（格式 ${meta.formatVersion}）` : ''}</b></div>}
          {(meta.objectives?.length ?? 0) > 0 && (
            <div className="dd-row"><span>目录</span><b>{meta.objectives!.join('、')}</b></div>
          )}
        </div>
      </div>

      <div className="detail-stat">
        <div className="dstat"><div className="n">{pack.questions?.length ?? 0}</div><div className="l">题目</div></div>
        <div className="dstat"><div className="n">{pack.chapters?.length ?? 0}</div><div className="l">章节</div></div>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <button className="btn flex-1 shua-main" onClick={startShua}>▶ 开始刷题</button>
      </div>

      <div className="page-sub">章节与题目</div>
      {total === 0 && (
        <div className="empty"><div className="em"><AppIcon name="archive" size={32} /></div><div className="et">暂无章节内容</div></div>
      )}
      {sections.map((sec, si) => {
        const key = sec.chapterId ?? `grp-${si}`
        const isOpen = openChapters.includes(key)
        const hasSub = !!sec.children?.length
        return (
        <div key={key} className="card chapter-card">
          <div className="row ch-head ch-head-toggle" onClick={() => toggleChapter(key)}>
            <span className={'chev ch-chev' + (isOpen ? ' open' : '')}>›</span>
            <div className="flex-1">
              <div className="card-title">{sec.title}</div>
              <div className="card-sub">
                {sec.questions.length} 题 · {sec.kpCount} 知识点
                {sec.summary ? ` · ${sec.summary}` : ''}
              </div>
            </div>
            {sec.chapterId && (
              <button
                className="btn ghost sm"
                onClick={(e) => {
                  e.stopPropagation()
                  startChapter(sec.chapterId, sec.questions.length)
                }}
              >
                章节刷
              </button>
            )}
          </div>
          {isOpen && (
            hasSub ? (
            <div className="seq-list">
              {sec.children!.map((sub, sci) => {
                const skey = sec.chapterId ? `${sec.chapterId}:${sci}` : `grp-${si}:${sci}`
                const subOpen = openChapters.includes(skey)
                return (
                <div key={skey} className="seq-item">
                  <div className="row ch-head ch-head-toggle seq-head" onClick={() => toggleChapter(skey)}>
                    <span className={'chev ch-chev' + (subOpen ? ' open' : '')}>›</span>
                    <div className="flex-1">
                      <div className="card-sub seq-title">{sub.title}</div>
                      <div className="card-sub">
                        {sub.questions.length} 题 · {sub.kpCount} 知识点
                        {sub.summary ? ` · ${sub.summary}` : ''}
                      </div>
                    </div>
                    {/* 章节刷只保留在顶层章节：子节粒度过细，整章刷已覆盖其题目范围 */}
                  </div>
                  {subOpen && renderQList(sub.questions)}
                </div>
                )
              })}
            </div>
            ) : renderQList(sec.questions)
          )}
        </div>
        )
      })}
    </div>
  )
}
