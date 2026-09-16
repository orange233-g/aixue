/**
 * 召回测试（内置在知识库详情页 V-EMB）：
 * 输入一句话，即时展示从当前知识库「捞到」的章节。复用真实检索入口 searchKbHits，
 * 保证所见即真实引用所用（门禁/降级如实呈现）。
 * 覆盖：相关性门禁可视化 / 结果汇总(命中·耗时·最高分) /
 * 命中列表(节号·标题·来源·score·展开/复制) / 三态与竞态保护。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useUI } from '../stores/useUIStore'
import { searchKbHits, warmVectorCache, type KbSearchGate } from '../services/kb/ref'
import type { KBDoc } from '../types'

interface RecallRow {
  i: number
  title: string
  file?: string
  score: number
  body: string
}

type FlowStatus = 'idle' | 'loading' | 'done'

/** 命中正文的人读友好化：只动分隔/空行，不改字、不改内容（知识库存储保留 Markdown/表格
 * 结构符号以保证检索精度，此处仅对「展示」层做纯文本化）。
 * - 去行首 Markdown 标题井号；
 * - 表格通配行（如 | --- | --- |）整行移除；
 * - 表内 `|`/`||` 分隔替换为空格，避免表格源码直接暴露。
 */
function cleanBody(raw: string): string {
  const lines = raw.split('\n').map((ln) => {
    let l = ln.replace(/^#{1,6}\s*/, '')
    if (/^\s*\|?[\s:\-|]+\|?\s*$/.test(l) && l.includes('|')) return ''
    l = l.split('|').join('  ')
    return l.trim()
  })
  let out = ''
  let prevBlank = false
  for (const l of lines) {
    if (!l) {
      if (!prevBlank) out += '\n'
      prevBlank = true
    } else {
      out += l + '\n'
      prevBlank = false
    }
  }
  return out.trim()
}

/** 找出 query 能在原文中命中的最长连续片段（贪心伸缩），供关键词高亮。 */
function queryTerms(query: string, text: string): string[] {
  const lowerT = text.toLowerCase()
  const out: string[] = []
  let i = 0
  while (i < query.length) {
    let picked: number | null = null
    for (let e = query.length; e > i; e--) {
      if (lowerT.includes(query.slice(i, e).toLowerCase())) {
        picked = e
        break
      }
    }
    if (picked !== null) {
      if (picked - i >= 2) out.push(query.slice(i, picked))
      i = picked
    } else {
      i++
    }
  }
  return out
}

/** 对清洗后的正文做查询词高亮，返回 React 节点（按文本分割生成 <mark>，避免 HTML 注入）。 */
function highlight(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text
  const lowerT = text.toLowerCase()
  const segs: [number, number][] = []
  for (const t of terms) {
    const tl = t.length
    let idx = lowerT.indexOf(t.toLowerCase())
    while (idx !== -1) {
      segs.push([idx, idx + tl])
      idx = lowerT.indexOf(t.toLowerCase(), idx + tl)
    }
  }
  if (segs.length === 0) return text
  segs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = [segs[0]]
  for (let k = 1; k < segs.length; k++) {
    const last = merged[merged.length - 1]
    if (segs[k][0] <= last[1]) last[1] = Math.max(last[1], segs[k][1])
    else merged.push(segs[k])
  }
  const nodes: ReactNode[] = []
  let cursor = 0
  merged.forEach(([s, e], idx) => {
    if (s > cursor) nodes.push(text.slice(cursor, s))
    nodes.push(
      <mark key={idx} style={{ background: 'rgba(255,213,79,.5)', color: 'inherit', borderRadius: 3, padding: '0 1px' }}>
        {text.slice(s, e)}
      </mark>,
    )
    cursor = e
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export default function RecallTest({ kb }: { kb: KBDoc | undefined }) {
  const showToast = useUI((s) => s.showToast)

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<FlowStatus>('idle')
  const [resp, setResp] = useState<{ channel: 'vec+bm25' | 'bm25' | 'vec'; hits: RecallRow[]; ms: number; gate?: KbSearchGate; topScore: number; degrade?: string } | null>(null)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const seqRef = useRef(0)

  // 切库：重置 query、结果、展开态
  useEffect(() => {
    setQuery('')
    setResp(null)
    setStatus('idle')
    setExpanded({})
    // 切库后使进行中的检索失效（hit 旧库结果不落地）
    seqRef.current++
  }, [kb?.id])

  // 库内容/整理态/语义索引状态变化（追加文件重建后）属新库，重置检索状态
  const kbVersion = kb ? `${kb.id}:${kb.status}:${kb.embedStatus}:${kb.sections.length}` : ''
  useEffect(() => {
    setQuery('')
    setResp(null)
    setStatus('idle')
    setExpanded({})
    seqRef.current++
  }, [kbVersion])

  const ready = !!kb && kb.status === 'ready'
  const channelName = resp?.channel === 'vec+bm25' ? '向量+BM25' : resp?.channel === 'vec' ? '仅向量' : '关键词BM25'

  const runSearch = async (text: string) => {
    const q = text.trim()
    if (!kb || !ready || !q) return
    const seq = ++seqRef.current
    setStatus('loading')
    setResp(null)
    const t0 = performance.now()
    try {
      // 预热该库向量缓存：searchKbHits 只有在 vecCache 已预热时才走向量通道，
      // 漏预热会永远降级为纯 BM25（此前召回测试看不到真实语义召回即是此因）。
      await warmVectorCache(kb)
      const { hits, channel, gate, degrade } = await searchKbHits(kb, q)
      if (seq !== seqRef.current) return // 竞态：期间切库/新检索，丢弃旧结果
      const rows: RecallRow[] = hits.map((h) => {
        const i = kb.sections.indexOf(h.section)
        return {
          i: i >= 0 ? i + 1 : 0,
          title: h.section.title,
          file: h.section.file,
          score: Math.round(h.score * 1e4) / 1e4,
          body: (kb.bodyText || '').slice(h.section.start, h.section.end),
        }
      })
      const topScore = rows.reduce((m, r) => (r.score > m ? r.score : m), 0)
      setResp({ channel, hits: rows, ms: Math.round(performance.now() - t0), gate, topScore, degrade })
      setStatus('done')
    } catch (e) {
      if (seq !== seqRef.current) return
      setStatus('done')
      setResp(null)
      showToast(e instanceof Error ? e.message : '检索失败，请稍后重试')
    }
  }

  const copyText = (text: string) => {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => undefined)
  }

  return (
    <div>
      <div className="row" style={{ gap: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(query) }}
          placeholder="输入查询语句"
          style={{
            flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 10,
            border: '1px solid var(--border, rgba(0,0,0,.16))', background: 'rgba(255,255,255,.6)',
            fontSize: 15, outline: 'none',
          }}
        />
        <button className="btn sm" disabled={!ready || status === 'loading'} onClick={() => void runSearch(query)}>
          {status === 'loading' ? '检索中…' : '检索'}
        </button>
      </div>

      {!ready && (
        <div className="card-sub" style={{ textAlign: 'center', padding: '24px 0', color: 'var(--muted)' }}>
          知识库尚未整理完成，整理完成后可在此测试检索效果。
        </div>
      )}

      {ready && status === 'idle' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '28px 12px', textAlign: 'center' }}>
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ color: '#c9c9c9', marginBottom: 8 }}>
            <path d="M4 4h16v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z" />
            <path d="M4 10h5l1.6 2.2h2.8L15 10h5" />
          </svg>
          <div style={{ fontSize: 13, color: '#a9a9a9' }}>输入查询语句开始检索测试</div>
          <div style={{ fontSize: 12, color: '#c3c3c3' }}>结果将展示匹配的文档片段和分数</div>
        </div>
      )}

      {ready && status === 'loading' && (
        <div className="card-sub" style={{ textAlign: 'center', padding: '30px 0', color: 'var(--muted)' }}>正在检索…</div>
      )}

      {ready && status === 'done' && resp && (
        <div>
          <div className="card-sub" style={{ fontSize: 13, marginTop: 12 }}>
            {resp.hits.length === 0
              ? `未在「${kb.name}」中找到与相关的内容（已走 ${channelName} 通道，含相关性门禁判定）`
              : `命中 ${resp.hits.length} 节 · ${channelName} · ${resp.ms}ms · 最高分 ${resp.topScore}`}
          </div>
          {/* 降级原因说明（真机 6.x：建库绑了向量模型但走了 BM25，用户不知道为什么）：
              优先展示检索层回传的具体降级原因；无原因时按 embedStatus 给常规提示 */}
          {resp.channel === 'bm25' && kb.embedModel && (
            <div style={{ fontSize: 12, marginTop: 6, color: '#b45309' }}>
              {resp.degrade
                ? `⚠ 本次未走向量通道：${resp.degrade}`
                : kb.embedStatus === 'ready'
                  ? '⚠ 已绑定向量模型但本次走了关键词通道（索引可能缺失或未加载）——可点上方「重新生成」重建索引'
                  : '向量索引尚未生成，本次为关键词检索降级——点上方「生成索引」后即可启用向量召回'}
            </div>
          )}
          {resp.gate && (
            <div style={{ fontSize: 12, marginTop: 6, color: resp.gate.denied ? '#c0392b' : 'var(--muted)' }}>
              {resp.gate.denied
                ? `相关性门禁：已拒绝（top1 cos ${resp.gate.top1Cos.toFixed(3)} < 阈值 ${resp.gate.threshold.toFixed(2)}，判定库内无相关内容）`
                : `相关性门禁：未触发（top1 cos ${resp.gate.top1Cos.toFixed(3)}，阈值 ${resp.gate.threshold.toFixed(2)}）`}
            </div>
          )}
          {resp.hits.length === 0 ? (
            <div className="card-sub" style={{ padding: '14px 0', color: 'var(--muted)' }}>
              {resp.gate?.denied
                ? '被相关性门槛拒绝：顶部余弦低于 0.5 且无关键词命中，判定库内确无相关内容。可换表述或扩大检索范围再试。'
                : '未匹配到相关内容：多为库内确实没有、或表述与库内差异大；可换关键词、扩大 topK 或切换通道再试。'}
            </div>
          ) : (
            resp.hits.map((row) => {
              const key = row.i
              const open = !!expanded[key]
              const cleaned = cleanBody(row.body)
              const displayBody = highlight(cleaned, queryTerms(query.trim(), cleaned))
              return (
                <div key={key} style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--rule, rgba(0,0,0,.12))' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>#{row.i} {row.title || '未命名片段'}</div>
                      {row.file && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{row.file}</div>}
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <span style={{ background: 'rgba(91,103,232,.12)', color: '#5B67E8', marginRight: 6, fontSize: 11, padding: '1px 8px', borderRadius: 999, fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {channelName}
                      </span>
                      <span style={{ background: 'rgba(91,103,232,.08)', color: '#2A2730', fontSize: 11, padding: '1px 8px', borderRadius: 999, fontWeight: 700, whiteSpace: 'nowrap' }}>score {row.score}</span>
                    </div>
                  </div>
                  <p
                    style={{
                      margin: '8px 0 0', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6,
                      display: open ? 'block' : '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}
                  >
                    {displayBody}
                  </p>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <button
                      className="btn plain sm"
                      style={{ fontSize: 13, padding: '5px 14px', minHeight: 32 }}
                      onClick={() => setExpanded((m) => ({ ...m, [key]: !open }))}
                    >
                      {open ? '收起' : '展开全文'}
                    </button>
                    <button
                      className="btn plain sm"
                      style={{ fontSize: 13, padding: '5px 14px', minHeight: 32 }}
                      onClick={() => copyText(cleaned)}
                    >
                      复制
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}