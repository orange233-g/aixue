/**
 * 知识库源切片 → 清洗后正文 + 结构分块（V2-P04 共享处理逻辑）。
 * 纯函数、无 DOM 依赖：KB Worker（kbProcess.worker.ts）与主线程回退路径
 * （kbProcessWorkerClient.ts）共用同一份语义，保证两条路径结果一致。
 */
import { aggregateSourceTexts } from './sourceSplit'
import { detectFragmented, cleanText, fmtChars } from './clean'
import { splitSections } from './split'
import type { KBSection, KBSourceText } from '../../types'

export interface KBProcessResult {
  bodyText: string
  sections: KBSection[]
  charCount: number
  summary: string
}

/** 把 raw 源切片层聚合还原 → 逐文件清洗 → 拼接 → 结构分块，返回正文与分块 */
export function processSources(sourcesText: KBSourceText[]): KBProcessResult {
  const files = aggregateSourceTexts(sourcesText ?? [])
  if (files.length === 0) {
    return { bodyText: '', sections: [], charCount: 0, summary: '0 份资料 · 0 节 · 0 字' }
  }
  // 逐文件清洗，同时记录每个文件清洗后文本在聚合 body 中的偏移区间（与下方 join 规则一致）
  const cleaned = files.map((f) => (detectFragmented(f.text, f.name) ? cleanText(f.text) : f.text))
  const body = cleaned.join('\n\n')
  const sections = splitSections(body)
  // section.start 落在哪个文件区间 → 标注 file（多文件知识库按文件分组/引用标注来源用）
  const spans = buildFileSpans(files.map((f) => f.name), cleaned)
  const sectionsWithFile = sections.map((sec) => ({ ...sec, file: fileOfOffset(spans, sec.start) }))
  return {
    bodyText: body,
    sections: sectionsWithFile,
    charCount: body.length,
    summary: `${files.length} 份资料 · ${sectionsWithFile.length} 节 · ${fmtChars(body.length)}`,
  }
}

/** 按「清洗后文件文本顺序」构建每个文件在聚合 body 中的偏移区间。
 *  区间只依赖各文件清洗后长度 + 文件间 '\n\n' 分隔（与 processSources 拼接规则一致），
 *  旧库迁移（bodyText 已存在）与新建共用同一映射，保证 section.start 归属正确。 */
export function buildFileSpans(names: string[], cleaned: string[]): { name: string; start: number; end: number }[] {
  const spans: { name: string; start: number; end: number }[] = []
  let cursor = 0
  for (let i = 0; i < cleaned.length; i++) {
    spans.push({ name: names[i], start: cursor, end: cursor + cleaned[i].length })
    cursor += cleaned[i].length + (i < cleaned.length - 1 ? 2 : 0)
  }
  return spans
}

/** 偏移 → 所属文件名（无命中返回 undefined，兜底归首文件） */
export function fileOfOffset(spans: { name: string; start: number; end: number }[], offset: number): string | undefined {
  return spans.find((s) => offset >= s.start && offset < s.end)?.name
}