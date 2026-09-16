import { describe, expect, it } from 'vitest'
import { cnToInt, parseChapterRange, chapterNoOfTitle, resolveChapterSections } from './chapterRef'
import type { KBSection } from '../../types'

describe('cnToInt：中文数字转阿拉伯', () => {
  it('个位/十位/百位', () => {
    expect(cnToInt('三')).toBe(3)
    expect(cnToInt('十二')).toBe(12)
    expect(cnToInt('二十三')).toBe(23)
    expect(cnToInt('一百零一')).toBe(101)
    expect(cnToInt('两百')).toBe(200)
  })

  it('千位/万位（网文大章节号）', () => {
    expect(cnToInt('二千零三十二')).toBe(2032)
    expect(cnToInt('一千零一')).toBe(1001)
    expect(cnToInt('三千')).toBe(3000)
  })

  it('阿拉伯直接透传', () => {
    expect(cnToInt('12')).toBe(12)
  })

  it('非法/空返回 null', () => {
    expect(cnToInt('')).toBeNull()
    expect(cnToInt('abc')).toBeNull()
    expect(cnToInt('第')).toBeNull()
    expect(cnToInt('零')).toBe(0)
  })
})

describe('parseChapterRange：章号指令解析', () => {
  it('中文单章', () => {
    expect(parseChapterRange('第三章的内容主要讲了什么')).toEqual({ from: 3, to: 3 })
  })
  it('阿拉伯单章', () => {
    expect(parseChapterRange('第3章讲了什么')).toEqual({ from: 3, to: 3 })
  })
  it('中文范围（到/至）', () => {
    expect(parseChapterRange('根据第三章到第四章出题')).toEqual({ from: 3, to: 4 })
    expect(parseChapterRange('第三章至第五章')).toEqual({ from: 3, to: 5 })
  })
  it('阿拉伯范围（到/-）', () => {
    expect(parseChapterRange('第3章到第5章')).toEqual({ from: 3, to: 5 })
    expect(parseChapterRange('第3-5章')).toEqual({ from: 3, to: 5 })
    expect(parseChapterRange('第12章~第15章')).toEqual({ from: 12, to: 15 })
  })
  it('通用文档编号：第X条（制度/章程/合同）', () => {
    expect(parseChapterRange('第三条说了什么')).toEqual({ from: 3, to: 3 })
    expect(parseChapterRange('第5条 请假流程')).toEqual({ from: 5, to: 5 })
    expect(parseChapterRange('第三条到第五条')).toEqual({ from: 3, to: 5 })
    expect(chapterNoOfTitle('第一条 总则')).toBe(1)
  })
  it('范围倒序自动交换', () => {
    expect(parseChapterRange('第5章到第3章')).toEqual({ from: 3, to: 5 })
  })
  it('兜底：query 开头无「第」前缀的章号提问（用户实测）', () => {
    expect(parseChapterRange('1999章节说了什么')).toEqual({ from: 1999, to: 1999 })
    expect(parseChapterRange('1999章内容')).toEqual({ from: 1999, to: 1999 })
    expect(parseChapterRange('1999 章节')).toEqual({ from: 1999, to: 1999 })
    expect(parseChapterRange('  1999章节')).toEqual({ from: 1999, to: 1999 })
  })
  it('兜底不误匹配正文片段（非章号提问/章节不在开头）', () => {
    expect(parseChapterRange('韩立5章节之内突破')).toBeNull()
    expect(parseChapterRange('韩立什么时候达成元婴')).toBeNull()
    expect(parseChapterRange('请问1999章节')).toBeNull() // 礼貌词在前，章节不在开头
    expect(parseChapterRange('')).toBeNull()
  })
})

describe('chapterNoOfTitle / resolveChapterSections：章节定位', () => {
  const sections: KBSection[] = [
    { id: 's0', title: '第一章 韩立醒来', start: 0, end: 10 },
    { id: 's1', title: '第二章 偶遇故人', start: 11, end: 20 },
    { id: 's2', title: '第三章 启程之路', start: 21, end: 30 },
    { id: 's3', title: '第四章 灵根觉醒', start: 31, end: 40 },
  ]

  it('标题章号提取', () => {
    expect(chapterNoOfTitle('第三章 启程之路')).toBe(3)
    expect(chapterNoOfTitle('12. 标题')).toBeNull()
    expect(chapterNoOfTitle('无编号标题')).toBeNull()
  })

  it('标题匹配优先', () => {
    const picked = resolveChapterSections(sections, { from: 2, to: 3 })
    expect(picked.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('单章', () => {
    const picked = resolveChapterSections(sections, { from: 4, to: 4 })
    expect(picked.map((s) => s.id)).toEqual(['s3'])
  })

  it('超界钳制', () => {
    const picked = resolveChapterSections(sections, { from: 3, to: 99 })
    expect(picked.map((s) => s.id)).toEqual(['s2', 's3'])
  })

  it('无标题库按数组序兜底（1-based）', () => {
    const plain: KBSection[] = [
      { id: 'a', title: '正文一', start: 0, end: 10 },
      { id: 'b', title: '正文二', start: 11, end: 20 },
    ]
    const picked = resolveChapterSections(plain, { from: 2, to: 2 })
    expect(picked.map((s) => s.id)).toEqual(['b'])
  })

  it('空 sections 返回空', () => {
    expect(resolveChapterSections([], { from: 1, to: 1 })).toEqual([])
  })
})
