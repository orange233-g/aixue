import { describe, expect, it } from 'vitest'
import { parseOutline, splitChapters, resolveTocTarget, type OutlineItem } from './outline'
import type { KBSection } from '../../types'

describe('parseOutline：纯文本小说按真实章节出目录（与 800 字分块解耦）', () => {
  const body = [
    '第一章 山边小村',
    '韩立生在一个小山村，家境贫寒。'.repeat(6),
    '',
    '第二章 青牛镇',
    '几年后他随七叔来到青牛镇。'.repeat(6),
    '',
    '第三章 七玄门',
    '机缘之下他拜入七玄门。'.repeat(6),
  ].join('\n')

  it('识别「第X章」为一级章，不再出现按字数的「第 N 节」碎片', () => {
    const outline = parseOutline(body, [])
    const titles = outline.map((o) => o.title)
    expect(outline.length).toBe(3)
    expect(titles).toEqual(['第一章 山边小村', '第二章 青牛镇', '第三章 七玄门'])
    expect(outline.every((o) => o.level === 1)).toBe(true)
    // 不包含分块器回退的「第 N 节」式碎片
    expect(titles.some((t) => /^第\d*节/.test(t))).toBe(false)
  })

  it('章节偏移在正文中可回源（分页切出该章完整内容）', () => {
    const outline: OutlineItem[] = [1, 2, 3].map((n, i) => ({ index: i, title: `第${n}章`, level: 1, offset: [0, body.indexOf('第二章'), body.indexOf('第三章')][i] }))
    const chapters = splitChapters(body, outline)
    expect(chapters).toHaveLength(3)
    expect(chapters[0].title).toBe('第1章')
    expect(chapters[0].markdown).toContain('山边小村')
    expect(chapters[0].markdown).not.toContain('青牛镇')
  })

  it('章节明确正文按章出目录（含「两」字大章节号：第两千四百三十七章 龙岛）', () => {
    const body = [
      '第一千九百九十九章 黑日',
      '黑色斧芒一斩而下。'.repeat(4),
      '',
      '第两千四百三十七章 龙岛',
      '再回魔源之后，他踏上了前往龙岛的路。'.repeat(4),
      '',
      '第两千四百四十六章 飞升仙界（大结局）',
      '他终究还是飞升而去。'.repeat(4),
    ].join('\n')
    const outline = parseOutline(body, [])
    const titles = outline.map((o) => o.title)
    expect(outline.length).toBe(3)
    expect(titles[1]).toBe('第两千四百三十七章 龙岛')
    expect(titles[2]).toBe('第两千四百四十六章 飞升仙界（大结局）')
    expect(outline.every((o) => o.level === 1)).toBe(true)
  })

  it('剔除「只有卷名」的空页：第一卷不会渲染成只有标题、正文空白的首页', () => {
    const body = [
      '第一卷 七玄门风云',
      '第001章 山边小村',
      '韩立生在一个小山村。'.repeat(6),
      '',
      '第002章 青牛镇',
      '几年后他随七叔来到青牛镇。'.repeat(6),
      '',
      '第二卷 修仙界',
      '第003章 七玄门',
      '机缘之下他拜入七玄门。'.repeat(6),
    ].join('\n')
    const outline = parseOutline(body, [])
    const chapters = splitChapters(body, outline)
    // 卷名与章名都识别为一级边界，但「只有卷名」的空段不入 chapter，避免空白首页
    expect(chapters[0].title).toBe('第001章 山边小村')
    expect(chapters[0].markdown).toContain('韩立生')
    expect(chapters.some((c) => c.title === '第一卷 七玄门风云')).toBe(false)
  })

  it('RC-06 深化：一级只剩书名+卷的小说降级用二级标题切章（第N章成为章页）', () => {
    // Markdown 多级标题小说：# 书名（唯一一级），## 序章/第一卷/第一章~第三章（二级）
    const md = [
      '# 脉海：两场战争之间',
      '## 序章 冰下脉动',
      '冰层之下有脉动。'.repeat(6),
      '## 第一卷 生命之海',
      '## 第一章 黑暗第一次记住自己',
      '黑暗中他第一次记起自己。'.repeat(6),
      '## 第二章 不存在的记忆',
      '那段记忆并不存在。'.repeat(6),
      '## 第三章 断鸣',
      '鸣声忽然断了。'.repeat(6),
    ].join('\n')
    const outline = parseOutline(md, [])
    expect(outline.filter((o) => o.level === 1)).toHaveLength(1) // 只有书名是一级
    const chapters = splitChapters(md, outline)
    // 不再整本一页：二级标题（有正文的）成为章页，「第一卷」这类空段仍剔除
    expect(chapters.map((c) => c.title)).toEqual([
      '序章 冰下脉动',
      '第一章 黑暗第一次记住自己',
      '第二章 不存在的记忆',
      '第三章 断鸣',
    ])
    // 目录点击第N章可精确命中（resolveTocTarget 与章同源）
    const ch3 = outline.find((o) => o.title === '第三章 断鸣')!
    expect(resolveTocTarget(outline, chapters, ch3.index)).toBe(3)
  })

  it('正常多章书不降级：3 个一级章 + 二级节仍按一级切', () => {
    const md = [
      '# 总标题',
      '## 1. 第一章',
      '一章正文。'.repeat(6),
      '### 1.1 小节',
      '小节正文。'.repeat(6),
      '## 2. 第二章',
      '二章正文。'.repeat(6),
      '## 3. 第三章',
      '三章正文。'.repeat(6),
    ].join('\n')
    const outline = parseOutline(md, [])
    const chapters = splitChapters(md, outline)
    // 一级（1./2./3.）有正文且 >2 个、二级不密集（3 < 3×3）→ 不降级，仍按一级切 3 章
    expect(chapters).toHaveLength(3)
    expect(chapters[0].title).toBe('第一章')
  })

  it('RC-06 终版：一级=书名+3卷、二级章密集（≥3倍）→ 降级按章切，目录点击/标红跟到章级', () => {
    // 真机复现场景：《脉海》一级只有书名+3 卷（各卷正文=章内容），二级 15 章——
    // 旧逻辑按卷切成 3 个巨型章页：点「第五章」解析回所在卷 target===idx 原地不动，标红停在卷级
    const md: string[] = ['# 脉海：两场战争之间']
    const vols = ['第一卷 生命之海', '第二卷 潮汐之战', '第三卷 归途']
    const chs = ['第一章 黑暗第一次记住自己', '第二章 不存在的记忆', '第三章 断鸣', '第四章 合弦', '第五章 我们先于我']
    for (const v of vols) {
      md.push(`# ${v}`)
      for (const c of chs) {
        md.push(`## ${c}`)
        md.push('海面下有光。'.repeat(4))
      }
    }
    const outline = parseOutline(md.join('\n'), [])
    expect(outline.filter((o) => o.level === 1)).toHaveLength(4) // 书名 + 3 卷
    expect(outline.filter((o) => o.level === 2)).toHaveLength(15)
    const chapters = splitChapters(md.join('\n'), outline)
    // 降级：15 个章页（卷名/书名空段剔除），不再按卷切 3 个巨型页
    expect(chapters).toHaveLength(15)
    expect(chapters.every((c) => chs.includes(c.title))).toBe(true)
    expect(chapters[0].title).toBe('第一章 黑暗第一次记住自己')
    expect(chapters[chapters.length - 1].title).toBe('第五章 我们先于我')
    // 点「第五章」精确命中第五章章页（而非原地不动的所在卷）
    const ch5 = outline.find((o) => o.title === '第五章 我们先于我')!
    const target = resolveTocTarget(outline, chapters, ch5.index)
    expect(chapters[target].title).toBe('第五章 我们先于我')
    expect(target).not.toBe(0) // 不再停留在第一卷
  })

  it('仅 1 个章节标记（不足 2 个、疑似误命中）回退 sections 分块目录', () => {
    const single = '第一章 说明\n' + '本文只是一份说明性质的材料。'.repeat(8)
    const sections: KBSection[] = [{ id: 's1', title: '第 1 节', start: 0, end: 40 }]
    const outline = parseOutline(single, sections)
    expect(outline[0].title).toBe('第 1 节')
  })

  it('Markdown 标题正文仍优先 Markdown 层级', () => {
    const md = '# 第一章 海洋概述\n正文。'.repeat(3)
    const outline = parseOutline(md)
    expect(outline[0].title).toBe('第一章 海洋概述')
    expect(outline[0].level).toBe(1)
  })

  it('多文件：fileOf 按偏移标注每章所属文件（V8-KB）', () => {
    const body = [
      '第一章 甲文件章',
      '甲内容。'.repeat(6),
      '',
      '第二章 乙文件章',
      '乙内容。'.repeat(6),
      '',
      '第三章 甲文件续章',
      '甲续内容。'.repeat(6),
    ].join('\n')
    // sections 携带 file：第 1/3 章属 a.txt，第 2 章属 b.txt
    const sections: KBSection[] = [
      { id: 's1', title: '第一章 甲文件章', start: 0, end: body.indexOf('第二章'), file: 'a.txt' },
      { id: 's2', title: '第二章 乙文件章', start: body.indexOf('第二章'), end: body.indexOf('第三章'), file: 'b.txt' },
      { id: 's3', title: '第三章 甲文件续章', start: body.indexOf('第三章'), end: body.length, file: 'a.txt' },
    ]
    const fileOf = (offset: number) => sections.find((s) => offset >= s.start && offset < s.end)?.file
    const outline = parseOutline(body, sections, fileOf)
    expect(outline.map((o) => o.file)).toEqual(['a.txt', 'b.txt', 'a.txt'])
    const chapters = splitChapters(body, outline)
    expect(chapters.map((c) => c.file)).toEqual(['a.txt', 'b.txt', 'a.txt'])
    expect(chapters[1].title).toBe('第二章 乙文件章')
  })

  it('sections 兜底分块目录直接带 sections.file（多文件无标题库）', () => {
    const sections: KBSection[] = [
      { id: 's1', title: 'A 节', start: 0, end: 10, file: 'a.txt' },
      { id: 's2', title: 'B 节', start: 10, end: 20, file: 'b.txt' },
    ]
    const outline = parseOutline('只有一行没标题的正文。', sections)
    expect(outline.map((o) => o.file)).toEqual(['a.txt', 'b.txt'])
  })
})

describe('resolveTocTarget：目录点击 → 目标章（RC-06 静默不跳修复）', () => {
  // 纯文本小说场景：书名/卷名只有标题行（被 hasBody 剔除不入 chapter），章有正文
  const novelOutline: OutlineItem[] = [
    { index: 0, title: '脉海：两场战争之间', level: 1, offset: 0 },
    { index: 1, title: '序章 冰下脉动', level: 1, offset: 30 },
    { index: 2, title: '第一卷 生命之海', level: 1, offset: 60 },
    { index: 3, title: '第一章 黑暗第一次记住自己', level: 1, offset: 90 },
    { index: 4, title: '第二章 不存在的记忆', level: 1, offset: 120 },
  ]
  // 卷(2)与书名(0)只有标题行被剔除；viewChapters 只剩 序章/第一章/第二章
  const novelChapters = [
    { index: 1, title: '序章 冰下脉动', markdown: '序章正文。' },
    { index: 3, title: '第一章 黑暗第一次记住自己', markdown: '第一章正文。' },
    { index: 4, title: '第二章 不存在的记忆', markdown: '第二章正文。' },
  ]

  it('章边界标题原样命中（序章 → 下标 0）', () => {
    expect(resolveTocTarget(novelOutline, novelChapters, 1)).toBe(0)
  })

  it('被剔除的一级标题（卷名）向后落到下一章（第一卷 → 第一章）', () => {
    expect(resolveTocTarget(novelOutline, novelChapters, 2)).toBe(1)
  })

  it('书名（首个被剔除标题）向后落到第一个有效章（序章）', () => {
    expect(resolveTocTarget(novelOutline, novelChapters, 0)).toBe(0)
  })

  it('viewChapters 为空返回 -1（调用方按原地关闭处理）', () => {
    expect(resolveTocTarget(novelOutline, [], 1)).toBe(-1)
  })

  it('Markdown 层级场景：二级标题归入其所在的一级章（向前找最近章边界）', () => {
    const mdOutline: OutlineItem[] = [
      { index: 0, title: '脉海', level: 1, offset: 0 },
      { index: 1, title: '序章 冰下脉动', level: 2, offset: 10 },
      { index: 2, title: '第一卷 生命之海', level: 2, offset: 40 },
      { index: 3, title: '第一章 黑暗第一次记住自己', level: 2, offset: 70 },
      { index: 4, title: '第二部', level: 1, offset: 100 },
    ]
    // 一级只有 2 个：书名(0，被剔除)与 第二部(4) → viewChapters 只剩 第二部
    const mdChapters = [{ index: 4, title: '第二部', markdown: '第二部正文。' }]
    // 点二级「第一章」→ 所在章向前找不到有正文的卷 → 兜底第 0 章
    expect(resolveTocTarget(mdOutline, mdChapters, 3)).toBe(0)
    // 点一级「第二部」→ 原样命中下标 0
    expect(resolveTocTarget(mdOutline, mdChapters, 4)).toBe(0)
  })
})