/**
 * 本地 CJK-bigram BM25 检索（借鉴 Reasonix internal/retrieval/bm25.go，见可行性分析 §6.1）。
 * 纯函数、零外部依赖：中文按重叠 bigram 分词（Lucene CJKAnalyzer 索引单位，避免单字误匹配），
 * 拉丁词小写整词；BM25 按 section 长度归一 + 相对 top 裁剪抗「常见词刷分的长段落」。
 * 主动检索只用 offset/topK + 本地评分，不依赖任何厂商 embedding（对齐「不做向量、不写死单家」铁律）。
 */
import type { KBSection } from '../../types'

/** 只保留得分 ≥ 最高分 × 该比例的命中（相对 top 裁剪，不设绝对阈值） */
const RELATIVE_RATIO = 0.6

/** 检索词归一化：判定字符是否 CJK（中文/日文假名区间） */
function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0) as number
  return (
    (cp >= 0x3000 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) // 日文假名
  )
}

function isWordChar(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch)
}

/**
 * 分词：连续 CJK 字符 → 重叠 bigram（单字回退为单字）；连续拉丁/数字 → 小写整词。
 * 例：「海洋知识」→ ['海洋','洋知','知识']；「Python3入门」→ ['python3','入门']。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  let cjkBuf: string[] = []
  let word = ''
  const flushWord = () => {
    if (word) {
      out.push(word.toLowerCase())
      word = ''
    }
  }
  const flushCjk = () => {
    if (cjkBuf.length === 1) out.push(cjkBuf[0])
    else for (let i = 0; i < cjkBuf.length - 1; i++) out.push(cjkBuf[i] + cjkBuf[i + 1])
    cjkBuf = []
  }
  for (const ch of text) {
    if (isCjk(ch)) {
      flushWord()
      cjkBuf.push(ch)
    } else if (isWordChar(ch)) {
      flushCjk()
      word += ch
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return out
}

export interface SearchHit {
  section: KBSection
  score: number
}

/** 标准 BM25：idf=log(1+(N-df+0.5)/(df+0.5))，tf*(k1+1)/(tf+k1(1-b+b·len/avg))，k1=1.2、b=0.75 */
function bm25(tf: number, df: number, N: number, len: number, avgLen: number): number {
  const k1 = 1.2
  const b = 0.75
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
  const denom = tf + k1 * (1 - b + b * (len / Math.max(1, avgLen)))
  return idf * ((tf * (k1 + 1)) / denom)
}

/** 相对 top 裁剪：只保留得分 ≥ 最高分×ratio 的命中（保底返回最高分那条） */
function keepTopRelative(hits: SearchHit[]): SearchHit[] {
  if (hits.length === 0) return hits
  const top = hits[0].score
  const kept = hits.filter((h) => h.score >= top * RELATIVE_RATIO)
  return kept.length > 0 ? kept : [hits[0]]
}

/* ---- V2-P03：BM25 索引缓存。逐 section 分词 + df 统计是最高频的 CPU 工作，
  连续聊天/多库引用会重复做同一份；按 sections 数组引用缓存分词与 df 只统计一次。
  必须引用同一份 bodyText 才命中，避免清洗/重建后误用旧索引。 ---- */

/** 缓存条目：某 sections 数组对应的预计算统计（引用同一份 bodyText 才命中，避免切片/重建后误用旧索引） */
interface Bm25Index {
  body: string
  tokenized: string[][]
  df: Map<string, number>
  lenArr: number[]
  avgLen: number
}

/** 强引用月下缓存会泄漏；用 WeakMap 键到数组对象，数组被回收时条目一并回收 */
const indexCache = new WeakMap<object, Bm25Index>()

/** 构建（或取缓存）某 sections 的 BM25 统计。必须引用同一份 bodyText 才复用，杜绝切边场景误用旧数据 */
function indexFor(bodyText: string, sections: KBSection[]): Bm25Index {
  const existing = indexCache.get(sections)
  if (existing && existing.body === bodyText) return existing
  const tokenized = sections.map((s) => tokenize(bodyText.slice(s.start, s.end)))
  const df = new Map<string, number>()
  for (const toks of tokenized) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const lenArr = tokenized.map((t) => t.length)
  const avgLen = lenArr.reduce((a, b) => a + b, 0) / Math.max(1, sections.length)
  const idx: Bm25Index = { body: bodyText, tokenized, df, lenArr, avgLen }
  indexCache.set(sections, idx)
  return idx
}

/** 在 bodyText 正文上，对 sections 做 BM25 打分，取相对 top-K 命中的章节 */
export function searchSections(
  bodyText: string,
  sections: KBSection[],
  query: string,
  topK = 4,
): SearchHit[] {
  const qTerms = new Set(tokenize(query))
  if (qTerms.size === 0 || sections.length === 0) return []
  const N = sections.length
  const { tokenized, df, avgLen } = indexFor(bodyText, sections)

  const hits: SearchHit[] = []
  for (let i = 0; i < N; i++) {
    const toks = tokenized[i]
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const term of qTerms) {
      const d = df.get(term) ?? 0
      const f = tf.get(term) ?? 0
      if (d === 0 || f === 0) continue
      score += bm25(f, d, N, toks.length, avgLen)
    }
    if (score > 0) hits.push({ section: sections[i], score })
  }
  hits.sort((a, b) => b.score - a.score)
  return keepTopRelative(hits.slice(0, topK))
}