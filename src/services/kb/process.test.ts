import { describe, expect, it } from 'vitest'
import { processSources, buildFileSpans, fileOfOffset } from './process'
import { splitSourceText } from './sourceSplit'
import type { KBSourceText } from '../../types'

/** 用与 useKBStore.create 相同的路径构造 sourcesText：splitSourceText 分片后落库 */
function slices(file: string, text: string): KBSourceText[] {
  return splitSourceText(text).map((s) => ({ file, span: s.span, text: s.text }))
}

describe('processSources（V2-P04 KB 处理，Worker/主线程共用）', () => {
  it('多文件聚合：正文按文件拼接、段落保留、分块生成', () => {
    const src = [
      ...slices('海洋.txt', '第一章 海洋概述。\n\n海洋覆盖地球百分之七十。'),
      ...slices('地壳.txt', '大陆板块在缓慢移动。'),
    ]
    const r = processSources(src)
    expect(r.bodyText).toContain('第一章 海洋概述。')
    expect(r.bodyText).toContain('大陆板块在缓慢移动。')
    expect(r.bodyText).toContain('\n\n') // 文件间以空行衔接
    expect(r.sections.length).toBeGreaterThan(0)
    expect(r.charCount).toBe(r.bodyText.length)
    expect(r.summary).toContain('份资料')
    // 章节标题应被识别进结构分块
    expect(r.sections.some((s) => s.title?.includes('第一章'))).toBe(true)
  })

  it('碎行被清洗：无标点行与下一行合并，字数守恒', () => {
    const src = slices('碎行.txt', '海洋是地球最大的水库。\n海水占地球总水量的\n百分之九十六。')
    const r = processSources(src)
    // cleaner 会把碎行拼成完整一句；同时 lossless（除换行外字符集一致）
    expect(r.bodyText.replace(/[\n\r]/g, '')).toBe('海洋是地球最大的水库。海水占地球总水量的百分之九十六。')
  })

  it('空输入返回空正文', () => {
    const r = processSources([])
    expect(r.bodyText).toBe('')
    expect(r.sections).toEqual([])
    expect(r.charCount).toBe(0)
  })

  it('正文与按 span 聚合还原一致（切片可回源）', () => {
    const text = '第一段内容。\n\n第二段更长的段落，包含一些生僻名词测试回源。'
    const src = slices('a.txt', text)
    const r = processSources(src)
    // 聚合后正文应能还原原文（clean 对非碎行不改字）
    expect(r.bodyText.replace(/\n\n{2,}/g, '\n\n')).toContain('第一段内容。')
    expect(r.bodyText).toContain('第二段更长的段落')
  })

  it('多文件：每个 section 标注所属源文件（V8-KB）', () => {
    // 每个文件文本 >1500 字（splitSections 的 maxChars 上限，低于此整篇一节不切），保证两文件各自成节
    const aText = '第一章 甲文件内容。\n\n' + '甲文件正文段落，用于测试章节来源标注。'.repeat(40) + '\n\n' + '甲文件第二段补充正文，继续用于测试章节来源标注归属。'.repeat(40)
    const bText = '第二章 乙文件内容。\n\n' + '乙文件正文段落，用于测试章节来源标注。'.repeat(40) + '\n\n' + '乙文件第二段补充正文，继续用于测试章节来源标注归属。'.repeat(40)
    const src = [
      ...slices('甲.txt', aText),
      ...slices('乙.txt', bText),
    ]
    const r = processSources(src)
    expect(r.sections.length).toBeGreaterThanOrEqual(2)
    // 第一个文件的内容 → 甲.txt；最后一个文件的内容 → 乙.txt
    const first = r.sections.find((s) => s.start === 0)
    const last = r.sections[r.sections.length - 1]
    expect(first?.file).toBe('甲.txt')
    expect(last?.file).toBe('乙.txt')
    // 所有 section 都带 file（两文件都命中）
    expect(r.sections.every((s) => s.file)).toBe(true)
  })

  it('buildFileSpans/fileOfOffset：偏移落在文件区间内归对文件，分隔区/越界兜底 undefined', () => {
    const spans = buildFileSpans(['a.txt', 'b.txt'], ['AAAA', 'BBBB']) // body = "AAAA\n\nBBBB"（len 4 + 2 + 4）
    expect(fileOfOffset(spans, 0)).toBe('a.txt')
    expect(fileOfOffset(spans, 3)).toBe('a.txt')
    expect(fileOfOffset(spans, 5)).toBeUndefined() // 4-5 是 \n\n 分隔符区，不归属任何文件
    expect(fileOfOffset(spans, 6)).toBe('b.txt')
    expect(fileOfOffset(spans, 9)).toBe('b.txt')
    expect(fileOfOffset(spans, 99)).toBeUndefined()
  })
})