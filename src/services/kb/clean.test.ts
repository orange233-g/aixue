import { describe, expect, it } from 'vitest'
import { detectFragmented, cleanText, fmtChars, fmtLines, fmtWords } from './clean'

/** 字数守恒强校验：除换行符（\n/\r）外字符集一字不变 */
function invariant(t: string): void {
  expect(cleanText(t).replace(/[\n\r]/g, '')).toBe(t.replace(/[\n\r]/g, ''))
}

describe('cleanText：字数守恒', () => {
  it('中文碎行', () => {
    const t = '海洋是地球最大的水库。\n海水占地球总水量的\n百分之九十六以上。\n\n海洋调节着全球气候。\n洋流影响沿岸降水。'
    invariant(t)
  })
  it('英文碎行', () => {
    const t = 'The ocean covers\nmost of the earth.\nIt regulates climate.\n\nWaves shape the coast.'
    invariant(t)
  })
  it('中英混合 + Windows 换行', () => {
    const t = '海洋 ocean is vast\r\nholds 96% of water\r\n\r\n climate regulator\r\n波 wave motion'
    invariant(t)
  })
  it('首尾空格保留（空格属内容字符）', () => {
    const t = '  abc def '
    invariant(t)
  })
})

describe('cleanText：断段与空行压缩', () => {
  it('行尾句末标点断段，无标点行与下一行拼接', () => {
    const t = '海洋是地球最大的水库。\n海水占地球总水量\n的百分之九十六。'
    const r = cleanText(t)
    expect(r.split('\n')).toEqual(['海洋是地球最大的水库。', '海水占地球总水量的百分之九十六。'])
  })
  it('连续空行压缩为一个', () => {
    const t = '第一段。\n\n\n\n\n第二段。'
    expect(cleanText(t)).toBe('第一段。\n\n第二段。')
  })
  it('\\r\\n 统一为 \\n', () => {
    const t = '第一段。\r\n第二段。'
    expect(cleanText(t)).toBe('第一段。\n第二段。')
  })
  it('首尾换行剥除', () => {
    expect(cleanText('\n\n第一段。\n\n')).toBe('第一段。')
  })
  it('空字符串', () => {
    expect(cleanText('')).toBe('')
  })
})

describe('detectFragmented：判定顺序与门槛', () => {
  const fragmented = '海洋很大。\n海水是咸的。\n覆盖七成表面。\n平均深度三千米。\n含盐量约百分之三点五。\n调节着气候。'
  const regular = Array.from({ length: 12 }, (_, i) => `第${i}章内容：这一行是足够长的规整文档排版示例句子，其长度明显超过四十二个字符的门槛值，用于对照测试平均行长判定。`).join('\n')

  it('碎行文本判 true', () => {
    expect(detectFragmented(fragmented)).toBe(true)
  })
  it('规整长行文档判 false', () => {
    expect(detectFragmented(regular)).toBe(false)
  })
  it('代码文件豁免（短行也不清洗）', () => {
    expect(detectFragmented(fragmented, 'main.py')).toBe(false)
    expect(detectFragmented(fragmented, 'app.tsx')).toBe(false)
  })
  it('含 Markdown 标题判 false（顺序：标题检查先于碎行判定）', () => {
    const withHeading = `# 海洋知识\n${fragmented}`
    expect(detectFragmented(withHeading)).toBe(false)
  })
  it('短行但无连续 5 行折行段判 false', () => {
    const t = '短。\n\n短。\n\n短。\n\n短。\n\n短。\n\n短。'
    expect(detectFragmented(t)).toBe(false)
  })
  it('空文本判 false', () => {
    expect(detectFragmented('')).toBe(false)
  })
})

describe('fmtChars / fmtLines / fmtWords：人类可读格式化', () => {
  it('字符数：万/千/个位', () => {
    expect(fmtChars(12530000)).toBe('1253.0w 字')
    expect(fmtChars(4200)).toBe('4.2k 字')
    expect(fmtChars(500)).toBe('500 字')
  })
  it('行数：万/千/个位', () => {
    expect(fmtLines(12345)).toBe('1.2w 行')
    expect(fmtLines(1234)).toBe('1.2k 行')
    expect(fmtLines(300)).toBe('300 行')
  })
  it('词数：万/千/个位', () => {
    expect(fmtWords(42000)).toBe('4.2w 词')
    expect(fmtWords(1500)).toBe('1.5k 词')
    expect(fmtWords(80)).toBe('80 词')
  })
})
