import { describe, expect, it } from 'vitest'
import { splitSections } from './split'

describe('splitSections：无结构纯文本降级', () => {
  it('无标题/列表的纯文本块标题兜底「第 N 节」，序号全局连续', () => {
    const para = '海洋覆盖了地球表面的七成。'.repeat(30) // 约 390 字/段
    const md = [para, para, para, para, para, para].join('\n\n') // 约 2350 字 → 多块
    const secs = splitSections(md)
    expect(secs.length).toBeGreaterThan(1)
    const unstructured = secs.filter((s) => /^第 \d+ 节$/.test(s.title))
    expect(unstructured.length).toBe(secs.length)
    expect(secs.map((s) => s.title)).toEqual(secs.map((_, i) => `第 ${i + 1} 节`))
  })

  it('带 Markdown 标题的块保持原标题', () => {
    const md = `# 第一章 海洋概述\n${'海洋是地球最大的水库。'.repeat(80)}\n\n# 第二章 海水成分\n${'海水含盐量约百分之三点五。'.repeat(80)}`
    const secs = splitSections(md)
    const titles = secs.map((s) => s.title)
    expect(titles).toContain('第一章 海洋概述')
    expect(titles).toContain('第二章 海水成分')
  })

  it('列表开头的块剥离列表前缀作标题', () => {
    const md = `- 海洋知识点一\n${'补充说明文字。'.repeat(40)}`
    const secs = splitSections(md)
    expect(secs[0].title).toBe('海洋知识点一')
  })

  it('偏移拼接还原全文（不丢字不重叠）', () => {
    const para = '波浪塑造着海岸线形态。'.repeat(30)
    const md = [para, para, para].join('\n\n')
    const secs = splitSections(md)
    expect(secs.map((s) => md.slice(s.start, s.end)).join('')).toBe(md)
  })

  it('空文本返回空数组', () => {
    expect(splitSections('')).toEqual([])
    expect(splitSections('   \n  ')).toEqual([])
  })

  it('F-05：识别带千位的中文章节标题（第二千零三十三章）', () => {
    const ch1 = '第二千零三十二章 青竹庭院\n' + '韩立走进庭院，四周静谧。'.repeat(90)
    const ch2 = '第二千零三十三章 化神之约\n' + '数百年修炼，如今已到化神关口。'.repeat(90)
    const md = `${ch1}\n\n${ch2}`
    const secs = splitSections(md)
    const titles = secs.map((s) => s.title)
    expect(titles).toContain('第二千零三十二章 青竹庭院')
    expect(titles).toContain('第二千零三十三章 化神之约')
  })
})
