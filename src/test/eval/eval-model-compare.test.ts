/**
 * 模型横向对比评估：bge-small-zh-v1.5 vs Qwen3-Embedding-0.6B（同数据集、同检索链路）
 *
 * 用真实 ONNX（model-pack/bge 与 public/models/qwen3）+ 生产检索函数（searchSections /
 * searchVectors / rrfFusion / MIN 门禁），对同一份 eval 数据集各跑一遍，输出 Recall@5 与失败 case。
 * - bge：cls 池化、无 query 指令。
 * - qwen3：last_token 池化、query 加官方 queryInstruct 前缀（与生产 ref.ts 的 withQueryInstruct 一致）。
 * 仅用于对比，不参与生产推理路径。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import { describe, it } from 'vitest'
import { buildAnchors } from '../../services/kb/embed'
import { searchSections } from '../../services/kb/search'
import { searchVectors, rrfFusion, cosine } from '../../services/kb/searchVec'
import { buildBpeTokenizer } from '../../ai/embed/tokenizers'
import type { KBSection } from '../../types'

const EVAL_DIR = join(process.cwd(), 'src/test/eval/datasets')
const BGE_DIR = join(process.cwd(), 'model-pack/bge-small-zh-v1.5')
const QWEN_DIR = join(process.cwd(), 'public/models/qwen3')

// ================= bge tokenizer / vec =================
const bgeTok = JSON.parse(readFileSync(join(BGE_DIR, 'tokenizer.json'), 'utf8'))
const bgeVocab = new Map<string, number>(Object.entries(bgeTok.model.vocab))
const isCJK = (ch: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)
function encodeBge(text: string): number[] {
  const MAX = 512
  const CLS = bgeVocab.get('[CLS]') ?? 101
  const SEP = bgeVocab.get('[SEP]') ?? 102
  const UNK = bgeVocab.get('[UNK]') ?? 100
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
    if (bgeVocab.has(p)) { ids.push(bgeVocab.get(p)!); continue }
    let rest = p, first = true, ok = true
    while (rest && ids.length < MAX - 1) {
      let found: string | null = null
      for (let i = rest.length; i > 0; i--) {
        const c = (first ? '' : '##') + rest.slice(0, i)
        if (bgeVocab.has(c)) { found = c; rest = rest.slice(i); break }
      }
      if (!found) { ok = false; break }
      ids.push(bgeVocab.get(found)!); first = false
    }
    if (!ok) ids.push(UNK)
  }
  ids.push(SEP)
  return ids
}
let bgeSess: InferenceSession | null = null
async function bgeVec(text: string): Promise<Float32Array> {
  if (!bgeSess) bgeSess = await InferenceSession.create(join(BGE_DIR, 'onnx/model.onnx'))
  const ids = encodeBge(text.trim() || '。')
  const n = ids.length
  const r = await bgeSess.run({
    input_ids: new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]),
    attention_mask: new Tensor('int64', BigInt64Array.from(new Array(n).fill(1n)), [1, n]),
    token_type_ids: new Tensor('int64', BigInt64Array.from(new Array(n).fill(0n)), [1, n]),
  })
  const name = bgeSess.outputNames[0]
  const dim = Number(r[name].dims[2])
  const data = r[name].data as Float32Array
  const cls = data.subarray(0, dim)
  let len = 0
  for (const v of cls) len += v * v
  len = Math.sqrt(len) || 1
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = cls[i] / len
  return out
}

// ================= qwen3 tokenizer / vec =================
const qwenTok = buildBpeTokenizer(JSON.parse(readFileSync(join(QWEN_DIR, 'tokenizer.json'), 'utf8')), 32768)
const QCFG = JSON.parse(readFileSync(join(QWEN_DIR, 'config.json'), 'utf8'))
const QLAYERS = QCFG.num_hidden_layers
const QKV = QCFG.num_key_value_heads
const QHEAD = QCFG.head_dim
const QWEN_INSTR = 'Given a web search query, retrieve relevant passages that answer the query'
let qwenSess: InferenceSession | null = null
async function qwenVec(text: string): Promise<Float32Array> {
  if (!qwenSess) qwenSess = await InferenceSession.create(join(QWEN_DIR, 'onnx/model_quantized.onnx'))
  const ids = qwenTok.encode(text.trim() || '')
  const n = Math.max(1, ids.length)
  const inputIds = new BigInt64Array(n)
  const attn = new BigInt64Array(n)
  const pos = new BigInt64Array(n)
  for (let j = 0; j < ids.length; j++) {
    inputIds[j] = BigInt(ids[j])
    attn[j] = 1n
    pos[j] = BigInt(j)
  }
  const feeds: Record<string, Tensor> = {
    input_ids: new Tensor('int64', inputIds, [1, n]),
    attention_mask: new Tensor('int64', attn, [1, n]),
    position_ids: new Tensor('int64', pos, [1, n]),
  }
  for (let L = 0; L < QLAYERS; L++) {
    feeds[`past_key_values.${L}.key`] = new Tensor('float32', new Float32Array(0), [1, QKV, 0, QHEAD])
    feeds[`past_key_values.${L}.value`] = new Tensor('float32', new Float32Array(0), [1, QKV, 0, QHEAD])
  }
  const r = await qwenSess.run(feeds)
  const name = qwenSess.outputNames[0]
  const dim = Number(r[name].dims[2])
  const data = r[name].data as Float32Array
  const col = n - 1 // last_token
  const row = data.subarray(col * dim, col * dim + dim)
  let len = 0
  for (const v of row) len += v * v
  len = Math.sqrt(len) || 1
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = row[i] / len
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
const MIN_EMBED_COS = 0.5

type VFunc = (text: string) => Promise<Float32Array>

async function evalDoc(doc: EvalDoc, queryText: (q: string) => string, vec: VFunc, topK = 5) {
  const { anchors, anchorSectionIdx } = buildAnchors({ sections: doc.sections, bodyText: doc.bodyText })
  const anchorVecs: Float32Array[] = []
  for (const a of anchors) anchorVecs.push(await vec(a))
  const pos: { q: string; ans: number; hit: boolean; got: number[] }[] = []
  const neg: { q: string; got: number[] }[] = []
  for (const [q, ans] of doc.queries) {
    const qv = await vec(queryText(q))
    const vecTop = searchVectors(qv, anchorVecs, topK * 2)
    const vecSectionIdx = anchorToSectionIdx(vecTop, anchorSectionIdx)
    const bm25 = searchSections(doc.bodyText, doc.sections, q, topK * 2)
    const bm25Idx = bm25.map((h) => doc.sections.indexOf(h.section)).filter((i) => i >= 0)
    const bm25Top = bm25.length ? bm25[0].score : 0
    let cosTop = 0
    for (const a of vecTop) {
      const c = cosine(qv, anchorVecs[a])
      if (c > cosTop) cosTop = c
    }
    const rejected = bm25Top <= 0 && cosTop < MIN_EMBED_COS
    const fused = rejected ? [] : rrfFusion([bm25Idx, vecSectionIdx]).slice(0, topK)
    if (ans >= 0) pos.push({ q, ans, hit: fused.includes(ans), got: fused })
    else neg.push({ q, got: fused })
  }
  return { anchors: anchors.length, pos, neg }
}

describe('S1b · 模型横向对比评估：bge vs Qwen3', () => {
  it('同数据集背靠背输出 Recall@5', async () => {
    const docs = loadDocs()
    const models: { label: string; queryText: (q: string) => string; vec: VFunc }[] = [
      { label: 'bge-small-zh', queryText: (q) => q, vec: bgeVec },
      { label: 'qwen3-0.6b', queryText: (q) => `${QWEN_INSTR}\nQuery: ${q}`, vec: qwenVec },
    ]
    for (const m of models) {
      let totalPos = 0, totalHits = 0, totalNeg = 0, totalNegOk = 0
      const fails: string[] = []
      console.log(`\n############ ${m.label} ############`)
      for (const doc of docs) {
        const r = await evalDoc(doc, m.queryText, m.vec)
        const hits = r.pos.filter((p) => p.hit).length
        totalPos += r.pos.length
        totalHits += hits
        totalNeg += r.neg.length
        totalNegOk += r.neg.filter((n) => n.got.length === 0).length
        console.log(`  ${doc.name}: 锚点 ${r.anchors} · Recall@5 ${(hits / r.pos.length).toFixed(2)} (${hits}/${r.pos.length}) · 负例正确拒绝 ${r.neg.filter((n) => n.got.length === 0).length}/${r.neg.length}`)
        for (const p of r.pos) if (!p.hit) fails.push(`${doc.name} | Q「${p.q}」答案节#${p.ans} 未进 top5 (got [${p.got.join(',')}])`)
        for (const n of r.neg) if (n.got.length > 0) fails.push(`${doc.name} | [负例]「${n.q}」误命中 (got [${n.got.join(',')}])`)
      }
      console.log(`  ---- ${m.label} 汇总：Recall@5 ${(totalHits / totalPos).toFixed(2)} (${totalHits}/${totalPos}) · 负例正确拒绝 ${totalNegOk}/${totalNeg} · 失败 ${fails.length}`)
      for (const f of fails) console.log('  ' + f)
    }
  }, 600000)
})