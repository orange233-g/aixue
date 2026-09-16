/**
 * 语义索引锚点构造（V-EMB 一期，规模自适应版 S2）。
 *
 * 锚点 = 向量化的输入单元（检索定位用，不向量化全文）。两种策略：
 * - full（小/中文档）：每节内按 300 字切 chunk，全文覆盖 → 节中后部内容可被向量检索到
 * - section（大文档）：每节 1-2 个锚点（节首 200 字 / 长节中段）→ 控成本，定位到"节"可用
 * 决策：全量所需锚点数 ≤ ANCHOR_BUDGET → full，否则 section。
 *
 * 检索命中锚点后，经 anchorSectionIdx 映射回「节」，再从 bodyText 按偏移取整节正文。
 */
import { surrogateSafeEnd } from '../files/pool'
import type { KBSection } from '../../types'

/** 节首/中段锚点截取字符数（bge 512 token 上限下留足余量；100→200：短锚点区分度差） */
export const ANCHOR_HEAD_CHARS = 200
/** 全量模式每 chunk 字符数（检索粒度；bge 512 token 余量内） */
export const CHUNK_CHARS = 300
/** 锚点预算：真机约 2-3 分钟可接受的索引量（阈值 = CHUNK_CHARS × ANCHOR_BUDGET ≈ 120 万字） */
export const ANCHOR_BUDGET = 4000

export type AnchorStrategy = 'full' | 'section'

/** 按库总字数决策锚点策略：全量所需锚点数 ≤ 预算 → full（正文全覆盖）；否则 section（节采样控成本） */
export function decideAnchorStrategy(charCount: number): AnchorStrategy {
  const fullNeeded = Math.ceil(charCount / CHUNK_CHARS)
  return fullNeeded <= ANCHOR_BUDGET ? 'full' : 'section'
}

/** 单锚点文本（标题 + 片段；标题为空时纯片段） */
function anchorText(title: string | undefined, body: string): string {
  const t = (title ?? '').trim()
  return t ? `${t} ${body}` : body
}

/** 全量模式：节内按 300 字切 chunk（首 chunk 带标题）；返回锚点数组 + 锚点→节下标映射 */
function buildFullAnchors(sections: KBSection[], bodyText: string): { anchors: string[]; anchorSectionIdx: number[] } {
  const anchors: string[] = []
  const anchorSectionIdx: number[] = []
  for (let i = 0; i < sections.length; i++) {
    const body = bodyText.slice(sections[i].start, sections[i].end)
    const title = (sections[i].title ?? '').trim()
    if (body.length <= CHUNK_CHARS) {
      anchors.push(anchorText(title, body))
      anchorSectionIdx.push(i)
    } else {
      for (let off = 0; off < body.length; off += CHUNK_CHARS) {
        const chunk = body.slice(off, off + CHUNK_CHARS)
        anchors.push(off === 0 && title ? `${title} ${chunk}` : chunk)
        anchorSectionIdx.push(i)
      }
    }
  }
  return { anchors, anchorSectionIdx }
}

/** 节采样模式：每节 1 锚点（节首 200 字），长节（>2000 字）追加中段锚点 */
function buildSectionAnchors(sections: KBSection[], bodyText: string): { anchors: string[]; anchorSectionIdx: number[] } {
  const anchors: string[] = []
  const anchorSectionIdx: number[] = []
  for (let i = 0; i < sections.length; i++) {
    const body = bodyText.slice(sections[i].start, sections[i].end)
    const title = (sections[i].title ?? '').trim()
    const headEnd = surrogateSafeEnd(body, ANCHOR_HEAD_CHARS)
    anchors.push(anchorText(title, body.slice(0, headEnd)))
    anchorSectionIdx.push(i)
    if (body.length > 2000) {
      const mid = Math.floor(body.length / 2)
      anchors.push(body.slice(mid, surrogateSafeEnd(body, mid + ANCHOR_HEAD_CHARS)))
      anchorSectionIdx.push(i)
    }
  }
  return { anchors, anchorSectionIdx }
}

/** 全库锚点构造：按规模自动选策略；返回锚点数组 + 锚点→节下标映射（第 i 锚点属于 anchorSectionIdx[i] 节） */
export function buildAnchors(kb: { sections: KBSection[]; bodyText: string }): { anchors: string[]; anchorSectionIdx: number[] } {
  const totalChars = kb.bodyText.length
  const strategy = decideAnchorStrategy(totalChars)
  const out = strategy === 'full' ? buildFullAnchors(kb.sections, kb.bodyText) : buildSectionAnchors(kb.sections, kb.bodyText)
  return out
}

/** 分批切分（Worker 分批向量化用；batchSize<=0 时整批） */
export function chunkTexts(texts: string[], batchSize: number): string[][] {
  const out: string[][] = []
  if (batchSize <= 0) {
    out.push(texts)
    return out
  }
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(texts.slice(i, i + batchSize))
  }
  return out
}
