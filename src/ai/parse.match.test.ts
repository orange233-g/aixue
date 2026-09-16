import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './parse'
import { validateQuestion } from '../services/validation'

/** RC-08：Windows CRLF 文件导入回归——行尾 \r 是 JS 行终止符，字段提取正则 `(.*)$` 失配曾致 42 块全灭 */
describe('parseMarkdown CRLF 兼容（真实真题文件导入）', () => {
  it('全 CRLF 行尾的单选题块正常解析', () => {
    const md = [
      '=== 第 1 题 ===',
      '题型：单选题',
      '题干：测试题干（CRLF）。',
      '选项：',
      'A. 甲',
      'B. 乙',
      '答案：[1]',
      '解析：测试',
      '知识点：abc',
      '难度：2',
    ].join('\r\n')
    const [q] = parseMarkdown(md)
    expect(q.type).toBe('single')
    expect(q.stem).toContain('CRLF')
    expect(q.answer).toBe('[1]')
    expect(q.options).toEqual(['甲', '乙'])
  })

  it('42 题真题同款结构（CRLF + === 分题）全量解析', () => {
    const block = (n: number) =>
      [
        `=== 第 ${n} 题 ===`,
        '题型：单选题',
        `题干：第 ${n} 题题干。`,
        '选项：',
        'A. 甲',
        'B. 乙',
        '答案：[0]',
        '解析：解析',
        '知识点：kp',
        '难度：2',
      ].join('\r\n')
    const md = ['学习本名称: 真题包', '', ...Array.from({ length: 42 }, (_, i) => block(i + 1))].join('\r\n')
    expect(parseMarkdown(md)).toHaveLength(42)
  })

  it('无法识别的文件仍抛「未识别到题目」中性文案', () => {
    expect(() => parseMarkdown('没有任何题目结构的普通文章。\r\n第二行。')).toThrow('未识别到题目')
  })
})

/** 匹配题解析：右列 + 配对必须被构造进 answer 的 {"right":[...],"pairs":[...]}，否则展示右列缺失（app_bug 匹配题显示） */
describe('parseMarkdown 匹配题（右列 + 配对）', () => {
  it('按「右列：」+ 答案字母-序号配对构造 right/pairs', () => {
    const md = [
      '题型：匹配题',
      '题干：将左侧术语与右侧含义匹配。',
      '选项：',
      'A. 路由',
      'B. 交换',
      'C. 网关',
      '右列：',
      '1. 跨网转发数据包',
      '2. 局域网内转发数据帧',
      '3. 连接不同网络协议',
      '答案：A-1,B-2,C-3',
      '解析：解析',
      '知识点：abc',
      '难度：2',
    ].join('\n')
    const [q] = parseMarkdown(md)
    expect(q.type).toBe('match')
    const v = JSON.parse(q.answer)
    expect(v.right).toEqual(['跨网转发数据包', '局域网内转发数据帧', '连接不同网络协议'])
    expect(v.pairs).toEqual([[0, 0], [1, 1], [2, 2]])
    expect(q.options).toEqual(['路由', '交换', '网关'])
  })

  it('无「右列：」时可从答案箭头恢复右列标签', () => {
    const md = [
      '=== 第 1 题 ===',
      '题型：匹配题',
      '题干：匹配左侧与右侧含义。',
      '选项：',
      'A. 列表',
      'B. 字典',
      '答案：列表→有序可变序列；字典→键值对映射',
      '解析：解析',
      '知识点：abc',
      '难度：2',
    ].join('\n')
    const [q] = parseMarkdown(md)
    const v = JSON.parse(q.answer)
    expect(v.right).toEqual(['有序可变序列', '键值对映射'])
    expect(v.pairs).toEqual([[0, 0], [1, 1]])
  })

  it('已是 {"right":...} 结构（导出再导入）原样保留', () => {
    const md = [
      '题型：匹配题',
      '题干：匹配。',
      '选项：',
      'A. 左一',
      'B. 左二',
      '答案：{"right":["右一","右二"],"pairs":[[0,1],[1,0]]}',
      '解析：解析',
      '知识点：abc',
      '难度：2',
    ].join('\n')
    const [q] = parseMarkdown(md)
    expect(q.answer).toBe('{"right":["右一","右二"],"pairs":[[0,1],[1,0]]}')
  })
})

describe('parseMarkdown 排序题答案归一', () => {
  const parseOrder = (answer: string) => {
    const [q] = parseMarkdown(
      [
        '题型：排序题',
        '题干：请按正确顺序排列。',
        '选项：',
        'A. 甲',
        'B. 乙',
        'C. 丙',
        'D. 丁',
        `答案：${answer}`,
        '解析：解析',
        '知识点：abc',
        '难度：2',
      ].join('\n'),
    )
    return q
  }

  it('把选项字母完整排列归一为 0-based 索引，并通过校验', () => {
    const q = parseOrder('C,A,D,B')
    expect(q.answer).toBe('[2,0,3,1]')
    expect(validateQuestion(q)).toEqual([])
  })

  it('兼容模型常输出的 1-based 数字排列', () => {
    expect(parseOrder('2→4→1→3').answer).toBe('[1,3,0,2]')
  })

  it('兼容按选项完整文本返回的排列', () => {
    expect(parseOrder('丙→甲→丁→乙').answer).toBe('[2,0,3,1]')
  })

  it('兼容排序条目内嵌题干且答案使用带圈序号的真实生成格式', () => {
    const [q] = parseMarkdown(
      [
        '题型：排序题',
        '题干：请按时间先后顺序排列以下北宋历史事件：①王安石变法 ②澶渊之盟 ③靖康之变 ④陈桥兵变',
        '答案：④,②,①,③',
        '解析：陈桥兵变、澶渊之盟、王安石变法、靖康之变。',
        '知识点：宋朝历史',
        '难度：2',
      ].join('\n'),
    )
    expect(q.options).toEqual(['王安石变法', '澶渊之盟', '靖康之变', '陈桥兵变'])
    expect(q.answer).toBe('[3,1,0,2]')
    expect(validateQuestion(q)).toEqual([])
  })
})
