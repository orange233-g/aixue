/**
 * S1 · 检索质量评估（Baseline：当前锚点策略 = 标题 + 章首 100 字）
 *
 * 用真实 bge 模型（model-pack 的 ONNX）+ 生产检索函数（searchSections/searchVectors/rrfFusion）
 * 跑测试集（书/制度/笔记），输出 Recall@5 与失败 case，作为后续规模自适应改动的对照 Baseline。
 *
 * 注意：tokenizer 复制自 bgeDirect（逻辑一致，Node 环境无法走 IDB）；评估结果仅用于对比，
 * 不参与生产推理路径。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import { describe, it } from 'vitest'
import { buildAnchors } from '../../services/kb/embed'
import { searchSections } from '../../services/kb/search'
import { searchVectors, rrfFusion, cosine } from '../../services/kb/searchVec'
import type { KBSection } from '../../types'

const EVAL_DIR = join(process.cwd(), 'src/test/eval/datasets')
const MODEL_DIR = join(process.cwd(), 'model-pack/bge-small-zh-v1.5')

// ---- tokenizer（复制自 bgeDirect，Node 评估用）----
const tok = JSON.parse(readFileSync(join(MODEL_DIR, 'tokenizer.json'), 'utf8'))
const vocab = new Map<string, number>(Object.entries(tok.model.vocab))
const isCJK = (ch: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)
function encodeBge(text: string): number[] {
  const MAX = 512
  const CLS = vocab.get('[CLS]') ?? 101
  const SEP = vocab.get('[SEP]') ?? 102
  const UNK = vocab.get('[UNK]') ?? 100
  const parts: string[] = []
  let cur = ''
  const flush = () => { if (cur) { parts.push(cur); cur = '' } }
  for (const ch of text) {
    if (isCJK(ch)) { flush(); parts.push(ch) }
    else if (/[A-Za-z0-9]/.test(ch)) cur += ch
    else if (/\s/.test(ch)) flush()
    else { flush(); parts.push(ch) }
  }
  flush()
  const ids = [CLS]
  for (const p of parts) {
    if (ids.length >= MAX - 1) break
    if (vocab.has(p)) { ids.push(vocab.get(p)!); continue }
    let rest = p, first = true, ok = true
    while (rest && ids.length < MAX - 1) {
      let found: string | null = null
      for (let i = rest.length; i > 0; i--) {
        const c = (first ? '' : '##') + rest.slice(0, i)
        if (vocab.has(c)) { found = c; rest = rest.slice(i); break }
      }
      if (!found) { ok = false; break }
      ids.push(vocab.get(found)!); first = false
    }
    if (!ok) ids.push(UNK)
  }
  ids.push(SEP)
  return ids
}

let sess: InferenceSession | null = null
async function vec(text: string): Promise<Float32Array> {
  if (!sess) sess = await InferenceSession.create(join(MODEL_DIR, 'onnx/model.onnx'))
  const ids = encodeBge(text.trim() || '。')
  const n = ids.length
  const feeds = {
    input_ids: new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]),
    attention_mask: new Tensor('int64', BigInt64Array.from(new Array(n).fill(1n)), [1, n]),
    token_type_ids: new Tensor('int64', BigInt64Array.from(new Array(n).fill(0n)), [1, n]),
  }
  const r = await sess.run(feeds)
  const outName = sess.outputNames[0]
  const dim = Number(r[outName].dims[2])
  const data = r[outName].data as Float32Array
  const cls = data.subarray(0, dim)
  let len = 0
  for (let i = 0; i < cls.length; i++) len += cls[i] * cls[i]
  len = Math.sqrt(len) || 1
  const out = new Float32Array(cls.length)
  for (let i = 0; i < cls.length; i++) out[i] = cls[i] / len
  return out
}

interface EvalDoc {
  name: string
  bodyText: string
  sections: KBSection[]
  queries: [string, number, string, string][]
}

function loadDocs(): EvalDoc[] {
  return (['book', 'policy', 'notes'] as const).map((key) => {
    const raw = JSON.parse(readFileSync(join(EVAL_DIR, `${key}.json`), 'utf8'))
    return { name: raw.name, bodyText: raw.bodyText, sections: raw.sections, queries: raw.queries }
  })
}

/** 锚点下标 → 节下标（去重、保序；缺省 1 锚点/节时下标即节下标）——与生产 ref.ts anchorToSectionIdx 一致 */
function anchorToSectionIdx(anchorIdx: number[], anchorSectionIdx?: number[]): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const a of anchorIdx) {
    const s = anchorSectionIdx?.[a] ?? a
    if (s >= 0 && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** 相关性门禁（模拟生产 minScore 设计）：BM25 零命中 且 top1 余弦 < 阈值 → 判定库内无相关内容（返回空）。
 *  阈值基于评估分布：书负例 cos≤0.454、正例≥0.509；制度负例 cos≤0.543 但因 BM25 有命中（部分相关）不拒。 */
const MIN_EMBED_COS = 0.5

/** 评估一份文档：返回 { recall, fails, stats }（模拟生产 searchKbHits 的 BM25+向量 RRF 融合链路 + 门禁） */
async function evalDoc(doc: EvalDoc, topK = 5) {
  const { anchors, anchorSectionIdx } = buildAnchors({ sections: doc.sections, bodyText: doc.bodyText })
  const anchorVecs: Float32Array[] = []
  for (const a of anchors) anchorVecs.push(await vec(a))
  const pos: { q: string; ans: number; type: string; note: string; hit: boolean; got: number[] }[] = []
  const neg: { q: string; got: number[] }[] = []
  const dist: { kind: string; bm25: number; cos: number; q: string }[] = []
  for (const [q, ans, type, note] of doc.queries) {
    const qv = await vec(q)
    const vecTop = searchVectors(qv, anchorVecs, topK * 2)
    const vecSectionIdx = anchorToSectionIdx(vecTop, anchorSectionIdx)
    const bm25 = searchSections(doc.bodyText, doc.sections, q, topK * 2)
    const bm25Idx = bm25.map((h) => doc.sections.indexOf(h.section)).filter((i) => i >= 0)
    // 相似度分布 + 门禁判定
    const bm25Top = bm25.length ? bm25[0].score : 0
    let cosTop = 0
    for (const a of vecTop) {
      const c = cosine(qv, anchorVecs[a])
      if (c > cosTop) cosTop = c
    }
    dist.push({ kind: ans >= 0 ? 'pos' : 'neg', bm25: bm25Top, cos: cosTop, q })
    const rejected = bm25Top <= 0 && cosTop < MIN_EMBED_COS
    const fused = rejected ? [] : rrfFusion([bm25Idx, vecSectionIdx]).slice(0, topK)
    if (ans >= 0) {
      const hit = fused.includes(ans)
      pos.push({ q, ans, type, note, hit, got: fused })
    } else {
      neg.push({ q, got: fused })
    }
  }
  const hits = pos.filter((p) => p.hit).length
  const recall = hits / pos.length
  return { recall, pos, neg, stats: { anchors: anchors.length, pos: pos.length, neg: neg.length }, dist }
}

describe('S1 · 检索质量评估（Baseline 当前锚点策略）', () => {
  it('跑测试集并输出 Recall@5 报告', async () => {
    const docs = loadDocs()
    const allFails: string[] = []
    let totalPos = 0
    let totalHits = 0
    let totalNeg = 0
    let totalNegOk = 0
    for (const doc of docs) {
      const r = await evalDoc(doc)
      totalPos += r.pos.length
      totalHits += r.pos.filter((p) => p.hit).length
      totalNeg += r.neg.length
      totalNegOk += r.neg.filter((n) => n.got.length === 0).length
      console.log(`\n===== ${doc.name} =====`)
      console.log(`锚点数 ${r.stats.anchors} · Recall@5 ${r.recall.toFixed(2)} (${r.pos.filter((p) => p.hit).length}/${r.pos.length}) · 负例 ${r.neg.filter((n) => n.got.length === 0).length}/${r.neg.length} 正确拒绝`)
      // 相似度分布（minScore 阈值依据）
      const posD = r.dist.filter((d) => d.kind === 'pos')
      const negD = r.dist.filter((d) => d.kind === 'neg')
      const fmt = (arr: { bm25: number; cos: number }[]) =>
        arr.length
          ? `bm25[${Math.min(...arr.map((x) => x.bm25)).toFixed(2)}~${Math.max(...arr.map((x) => x.bm25)).toFixed(2)}] cos[${Math.min(...arr.map((x) => x.cos)).toFixed(3)}~${Math.max(...arr.map((x) => x.cos)).toFixed(3)}]`
          : '—'
      console.log(`  相似度分布 正例: ${fmt(posD)} · 负例: ${fmt(negD)}`)
      for (const p of r.pos) {
        if (!p.hit) {
          allFails.push(`${doc.name} | [${p.type}] ${p.note} | Q「${p.q}」答案节#${p.ans} 未进 top5（got: [${p.got.join(',')}]）`)
        }
      }
      for (const n of r.neg) {
        if (n.got.length > 0) {
          allFails.push(`${doc.name} | [负例] Q「${n.q}」误命中 top5（got: [${n.got.join(',')}]）`)
        }
      }
    }
    console.log(`\n========== 汇总 ==========`)
    console.log(`总 Recall@5: ${(totalHits / totalPos).toFixed(2)} (${totalHits}/${totalPos})`)
    console.log(`负例正确拒绝: ${totalNegOk}/${totalNeg}`)
    console.log(`\n失败 case（${allFails.length}）:`)
    for (const f of allFails) console.log('  ' + f)
  }, 300000)
})
