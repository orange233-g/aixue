/** 聊天 Markdown 渲染器回归：GFM 表格支持（app_bug 6.62：表格源码原样露出） */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown GFM 表格', () => {
  it('标准表格渲染为 <table>，含表头与数据行', () => {
    const md = [
      '| 方法 | 核心原理 |',
      '| --- | --- |',
      '| 间隔重复法 | 按遗忘曲线安排复习时间点 |',
      '| 联想记忆法 | 把新知识与已有知识建立联系 |',
    ].join('\n')
    const html = renderMarkdown(md)
    expect(html).toContain('<table class="md-table">')
    expect(html).toContain('<th>方法</th>')
    expect(html).toContain('<td>间隔重复法</td>')
    expect(html).not.toContain('| --- |')
    expect(html).not.toContain('<p>|') // 不再当段落原样露出
  })

  it('分隔行支持对齐冒号写法 |:---:|', () => {
    const md = '| A | B |\n|:--:|---:|\n| 1 | 2 |'
    const html = renderMarkdown(md)
    expect(html).toContain('<th>A</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('单元格内容保留行内标记（加粗/行内代码）', () => {
    const md = '| 名 | 值 |\n| --- | --- |\n| **重点** | `code` |'
    const html = renderMarkdown(md)
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code class="md-inline">code</code>')
  })

  it('竖线开头的非表格内容（无分隔行）不受影响，按原逻辑渲染', () => {
    const md = 'a | b 竖线示例'
    const html = renderMarkdown(md)
    expect(html).not.toContain('<table')
    expect(html).toContain('a | b 竖线示例')
  })

  it('表格后的普通段落正常渲染（表格块正确终结）', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n结论：以上。'
    const html = renderMarkdown(md)
    expect(html).toContain('</table></div>')
    expect(html).toContain('<p>结论：以上。</p>')
  })
})

describe('renderMarkdown 有序列表编号（真机 bug：模型输出 1. 1. 1. 时全部显示 1）', () => {
  it('「1. 1. 1.」且项间夹 - 子项：合并为同一 <ol>，自动连续编号，子项作嵌套 <ul>', () => {
    const md = [
      '1. **题目数量**：你想做几道题？',
      '1. **想要覆盖的知识点**，比如：',
      '- 变量与数据类型',
      '- 循环（for / while）',
      '1. **题目难度偏好**：简单入门还是有一定挑战性？',
    ].join('\n')
    const html = renderMarkdown(md)
    expect(html).toContain('<ol start="1">')
    expect((html.match(/<li>/g) ?? []).length).toBe(5) // 3 个有序项 + 2 个嵌套子项
    expect((html.match(/<ul>/g) ?? []).length).toBe(1) // 中间的 - 子项并入第二项作同一个嵌套列表
    expect(html).toContain('<li>变量与数据类型</li>')
  })

  it('空行分隔的有序项延续同一列表（编号不重启）', () => {
    const md = '1. 第一项\n\n2. 第二项\n\n3. 第三项'
    const html = renderMarkdown(md)
    expect((html.match(/<ol/g) ?? []).length).toBe(1)
    expect(html).toContain('<li>第三项</li>')
  })

  it('保留模型写的起始编号（start 属性）', () => {
    const html = renderMarkdown('3. 第三步\n4. 第四步')
    expect(html).toContain('<ol start="3">')
  })

  it('列表后跟普通段落时列表正确终结（不吞段落）', () => {
    const md = '1. 甲\n2. 乙\n\n这是正文说明。'
    const html = renderMarkdown(md)
    expect(html).toContain('<p>这是正文说明。</p>')
  })
})
