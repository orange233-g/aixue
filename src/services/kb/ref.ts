/**
 * 知识库引用块构建（Phase 3，见 PRD §4.1 F6 与可行性分析 §4.3；V-EMB 一期扩展）：
 * 按用户主题对库做 topK 命中，合成「【知识库·库名 参考资料】」块，按 KB_REF_CAP 截断，过 sanitizeInput。
 * 引用内容视作不可信输入（源文件正文可能夹带注入指令），先清洗再进生题/聊天管线。
 * 检索源 = bodyText（清洗后原文）；旧数据个别未迁移时回退 consolidated。
 *
 * V-EMB 三通道（按序）：
 *   ① 章号指令：query 含「第N章/第N-M章」→ 直接从 sections 取章注入（不走语义）
 *   ② 向量 + BM25 RRF：语义检索（模型已下载 + 库向量已生成时）与字面检索互补融合
 *   ③ 纯 BM25：无向量/模型不可用/向量化失败 → 降级现状（功能不退步）
 */
import type { KBDoc } from '../../types'
import { searchSections, type SearchHit } from './search'
import { parseChapterRange, resolveChapterSections } from './chapterRef'
import { searchVectors, rrfFusion, cosine } from './searchVec'
import { getEmbedModel } from '../../ai/embed/registry'
import { embedTexts } from '../../ai/embed/loader'
import { dbKBVectors } from '../../db'
import { sanitizeInput } from '../../utils/sanitize'
import { log } from '../../utils/log'
import { surrogateSafeEnd } from '../files/pool'

/** 引用单次注入字符上限（≈2500–3500 token，见可行性分析 §11 容量口径；CJK 1 字 ≈ 1 token） */
export const KB_REF_CAP = 2800
/** 每次检索取的章节数（topK）——通用知识库问答：多召回候选，降低「找到相关内容但被噪声挤掉」概率 */
export const KB_REF_TOPK = 6

/** 相关性门禁阈值（S2，评估分布定标）：BM25 零命中时，query 与 top1 锚点余弦低于此值 → 判定无相关内容返回空。
 *  评估（src/test/eval）：书负例 cos≤0.454 / 正例≥0.509 → 0.5 安全；部分相关负例（bm25 有命中）不受此门禁。 */
export const MIN_EMBED_COS = 0.5

/** 纯函数：是否判定「库内无相关内容」（BM25 零命中 且 最高余弦低于阈值）。评估与生产共用。 */
export function shouldRejectQuery(bm25TopScore: number, maxEmbedCos: number): boolean {
  return bm25TopScore <= 0 && maxEmbedCos < MIN_EMBED_COS
}

/** 召回测试通道标识（P1 强制三档：混合 / 仅向量 / 仅BM25） */
export type RecallChannel = 'vec+bm25' | 'bm25' | 'vec'

/** 相关性门禁信息（P1 可视化用）：区分「被门槛拒绝」还是「库内真没有相关内容」 */
export interface KbSearchGate {
  threshold: number
  top1Cos: number
  hasBm25: boolean
  denied: boolean
}

export interface KbSearchResult {
  hits: SearchHit[]
  channel: RecallChannel
  gate?: KbSearchGate
  /** 降级原因（channel=bm25 时且非 force 档）：告诉用户/排查日志为什么没走向量通道 */
  degrade?: string
}

export interface KbSearchOptions {
  /** 每次检索取的节数（默认 KB_REF_TOPK） */
  topK?: number
  /** 通道强档（P1 调参对照）：auto=自动（向量+BM25 融合、异常降级），bm25=仅关键词，vec=仅向量 */
  force?: 'auto' | 'bm25' | 'vec'
}

/** 截断文案：末尾提示已截断字数，保证引用始终在预算内、超量可见 */
function withCap(body: string, cap: number): string {
  if (body.length <= cap) return body
  const end = surrogateSafeEnd(body, cap)
  return body.slice(0, end) + `\n（已截断：仅含前 ${end}/${body.length} 字）`
}

/* ---- 向量缓存：buildKbRef 保持轻量（每 query 不重复读 IDB），预热由 UI 层/生成页触发 ---- */
const vecCache = new Map<string, { vectors: Float32Array[]; modelId: string; anchorSectionIdx?: number[] }>()

/** 预热某库的向量缓存（库 embedStatus=ready 时读取；generateEmbed 成功 / 进入知识库页 / 生成页引用时调用） */
export async function warmVectorCache(kb: KBDoc): Promise<void> {
  if (!kb?.id || kb.embedStatus !== 'ready' || vecCache.has(kb.id)) return
  const row = await dbKBVectors.get(kb.id)
  if (row) vecCache.set(kb.id, { vectors: row.vectors, modelId: row.modelId, anchorSectionIdx: row.anchorSectionIdx })
}

/** 使某库向量缓存失效（删除索引 / 重新生成后调用） */
export function invalidateVectorCache(kbId: string): void {
  vecCache.delete(kbId)
}

/**
 * 锚点下标 → 节下标（去重、保序）。旧库无 anchorSectionIdx（1 锚点/节）时按「下标=节下标」兜底。
 */
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

/** query 按模型加检索指令前缀（Qwen3 需 Instruct：官方格式 `instruction\nQuery: {query}`，bge 无需） */
function withQueryInstruct(query: string, modelId: string): string {
  const model = getEmbedModel(modelId)
  return model?.queryInstruct ? `${model.queryInstruct}\nQuery: ${query}` : query
}

/** 向量 + BM25 RRF 融合检索（任一步失败/不可用降级纯 BM25）。返回命中与所用通道，供引用明细日志展示。
 *  知识库详情页内置的「召回测试」复用同一入口，保证所见即真实引用所用。 */
export async function searchKbHits(kb: KBDoc, query: string, opts: KbSearchOptions = {}): Promise<KbSearchResult> {
  const topN = opts.topK ?? KB_REF_TOPK
  const force = opts.force ?? 'auto'
  const body = kb.bodyText || kb.consolidated
  const bm25 = searchSections(body, kb.sections, query, topN * 2)

  // 仅关键词档（P1 对照）：不涉向量/门禁，直接返回 BM25
  if (force === 'bm25') return { hits: bm25.slice(0, topN), channel: 'bm25' }

  const cache = kb.id ? vecCache.get(kb.id) : undefined
  // 向量缓存可用性：有缓存、非空、且锚点覆盖到当前库末节（full 小节锚点>节数但映射覆盖全即合法；库重构后未重建则不同步）
  let cacheUsable = false
  if (cache && cache.vectors.length > 0) {
    let coveredLast = -1
    if (cache.anchorSectionIdx && cache.anchorSectionIdx.length === cache.vectors.length) {
      for (let ai = 0; ai < cache.anchorSectionIdx.length; ai++) if (cache.anchorSectionIdx[ai] > coveredLast) coveredLast = cache.anchorSectionIdx[ai]
    } else {
      coveredLast = cache.vectors.length - 1 // 旧库无锚点→节映射：按锚点数粗判末节
    }
    cacheUsable = kb.sections.length > 0 && coveredLast === kb.sections.length - 1
  }
  if (!cacheUsable || !cache) {
    if (force === 'vec') return { hits: [], channel: 'vec' }
    return { hits: bm25.slice(0, topN), channel: 'bm25', degrade: '向量缓存未就绪（索引向量缺失、未预热，或锚点未覆盖全库——库内容变动后需重建索引）' }
  }

  // 该库绑定的检索方式（kb.embedModel：undefined/bm25=关键词，向量 id=语义）
  // 库绑定模型与库向量缓存模型不一致（更换检索方式后未重建）→ 向量不可用，走 BM25 降级
  if (!kb.embedModel || kb.embedModel === 'bm25' || cache.modelId !== kb.embedModel) {
    if (force === 'vec') return { hits: [], channel: 'vec' }
    return { hits: bm25.slice(0, topN), channel: 'bm25', degrade: `库绑定模型（${kb.embedModel || 'bm25'}）与索引模型（${cache.modelId}）不一致，需重建索引` }
  }

  try {
    /** query 向量化（模型目录 URL 直连加载；离线/未托管时 embedTexts 抛错 → 走 catch 降级） */
    const [qv] = await embedTexts(kb.embedModel, [withQueryInstruct(query, kb.embedModel)])
    const vecTop = searchVectors(qv, cache.vectors, topN * 2)
    let top1Cos = 0
    for (const a of vecTop) top1Cos = Math.max(top1Cos, cosine(qv, cache.vectors[a]))
    const hasBm25Hit = bm25.length > 0 && bm25[0].score > 0
    const gate: KbSearchGate = { threshold: MIN_EMBED_COS, top1Cos, hasBm25: hasBm25Hit, denied: false }

    // 仅向量档（P1 对照）：只回最近邻节，不做融合；不因门禁清空（供对比），门禁信息仅作展示
    if (force === 'vec') {
      gate.denied = shouldRejectQuery(hasBm25Hit ? bm25[0].score : 0, top1Cos)
      const perCos = new Map<number, number>()
      for (const a of vecTop) {
        const s = anchorToSectionIdx([a], cache.anchorSectionIdx)[0]
        if (s == null) continue
        perCos.set(s, Math.max(perCos.get(s) ?? 0, cosine(qv, cache.vectors[a])))
      }
      return {
        hits: anchorToSectionIdx(vecTop, cache.anchorSectionIdx)
          .slice(0, topN)
          .map((s) => ({ section: kb.sections[s], score: perCos.get(s) ?? 0 })),
        channel: 'vec',
        gate,
      }
    }

    // auto/混合（默认）：相关性门禁命中才拒，其余做 RRF 融合，避免负例 query 返回无关 topK
    gate.denied = shouldRejectQuery(hasBm25Hit ? bm25[0].score : 0, top1Cos)
    if (gate.denied) return { hits: [], channel: 'vec+bm25', gate }
    const vecSectionIdx = anchorToSectionIdx(vecTop, cache.anchorSectionIdx)
    const bm25Idx = bm25.map((h) => kb.sections.indexOf(h.section)).filter((i) => i >= 0)
    const fused = rrfFusion([bm25Idx, vecSectionIdx])
    const hitByIdx = new Map<number, SearchHit>()
    bm25.forEach((h) => {
      const i = kb.sections.indexOf(h.section)
      if (i >= 0) hitByIdx.set(i, h)
    })
    return {
      hits: fused
        .slice(0, topN)
        .map((i) => hitByIdx.get(i) ?? { section: kb.sections[i], score: 0 }),
      channel: 'vec+bm25',
      gate,
    }
  } catch (e) {
    if (force === 'vec') return { hits: [], channel: 'vec' }
    // query 向量化失败（模型加载异常等）→ 降级 BM25，带原因供 UI/日志定位
    return { hits: bm25.slice(0, topN), channel: 'bm25', degrade: `query 向量化失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 构建某个知识库的引用块（异步：向量通道需读缓存/推理 query）。
 * @param kb   知识库文档（含 bodyText + sections）
 * @param query 用户主题/意图，用于检索命中章节
 * @param cap  注入字符上限（默认 KB_REF_CAP）
 */
export async function buildKbRef(kb: KBDoc, query: string, cap = KB_REF_CAP): Promise<string> {
  const body = kb.bodyText || kb.consolidated
  if (!body || !kb.sections?.length) return ''
  const sanitizedName = sanitizeInput(kb.name)

  // 通道①：章号指令（「第N章/第N-M章」→ 精确取章注入）
  const chRange = parseChapterRange(query)
  if (chRange) {
    const picked = resolveChapterSections(kb.sections, chRange)
    if (picked.length > 0) {
      log('info', 'kb', `知识库引用·按章号命中 ${sanitizedName}`, {
        query: sanitizeInput(query),
        chapters: picked.map((s) => {
          const idx = kb.sections.indexOf(s)
          return { i: idx >= 0 ? idx + 1 : null, title: s.title }
        }),
      })
      const parts = picked.map((s, i) => {
        const sectionBody = body.slice(s.start, s.end)
        const title = s.title ? `## ${sanitizeInput(s.title)}` : `## 片段 ${i + 1}`
        const src = s.file ? `\n> 📄 来源：${sanitizeInput(s.file)}` : ''
        return `${title}${src}\n${sectionBody}`
      })
      return `【知识库·${sanitizedName} 参考资料】以下为指定章节（第 ${chRange.from}${chRange.to > chRange.from ? `-${chRange.to}` : ''} 章）：\n${sanitizeInput(withCap(parts.join('\n\n'), cap))}`
    }
    // 章号解析到但定位为空（章号超界）→ 回退语义通道
  }

  // 通道②③：向量+BM25 RRF，无向量降级纯 BM25
  const { hits, channel } = await searchKbHits(kb, query)
  const channelName = channel === 'vec+bm25' ? '向量+BM25' : '关键词BM25'
  if (hits.length === 0) {
    // 检索无相关内容（含相关性门禁拒绝：BM25 零命中 + 余弦过低 → 判定库内没有）：
    // 明确告知「未找到」，不再回退库开头——避免 AI 拿无关内容东拼西凑，配合 prompt 纪律「没有就说没有」
    log('info', 'kb', `知识库引用·${sanitizedName} 未命中（${channelName}门禁）`, {
      query: sanitizeInput(query),
      channel,
    })
    return `【知识库·${sanitizedName} 参考资料】未在知识库中找到与「${sanitizeInput(query)}」相关的内容。若用户询问的是库外信息，请直接说明知识库未收录，不要凭检索结果之外的猜测作答。`
  }
  log('info', 'kb', `知识库引用·命中 ${sanitizedName}（${channelName}）`, {
    query: sanitizeInput(query),
    channel,
    hits: hits.map((h) => {
      const idx = kb.sections.indexOf(h.section)
      return { i: idx >= 0 ? idx + 1 : null, title: h.section.title, score: Math.round(h.score * 1e4) / 1e4, file: h.section.file }
    }),
  })
  const parts = hits.map((h, i) => {
    const sectionBody = body.slice(h.section.start, h.section.end)
    const title = h.section.title ? `## ${sanitizeInput(h.section.title)}` : `## 片段 ${i + 1}`
    // 多文件知识库：标注该章所属源文件，让模型能区分引用来自哪份文件（来源名属不可信输入，先 sanitize）
    const src = h.section.file ? `\n> 📄 来源：${sanitizeInput(h.section.file)}` : ''
    return `${title}${src}\n${sectionBody}`
  })
  return `【知识库·${sanitizedName} 参考资料】以下为与「${sanitizeInput(query)}」相关的章节：\n${sanitizeInput(withCap(parts.join('\n\n'), cap))}`
}

/** 合成多个知识库的引用块（多选引用场景）：逐库各自命中并拼入，整体再按 KN 段截断兜底 */
export async function buildMultiKbRef(kbs: KBDoc[], query: string, perCap = KB_REF_CAP): Promise<string> {
  const parts: string[] = []
  for (const kb of kbs) {
    const ref = await buildKbRef(kb, query, perCap)
    if (ref) parts.push(ref)
  }
  return withCap(parts.join('\n\n'), perCap)
}
