import { describe, expect, it } from 'vitest'
import {
  chineseToInt,
  hasExplicitGenIntent,
  isAdjustment,
  isDefaultAnswer,
  isGenAbort,
  isGenSpecReply,
  isVagueCountAdjustment,
  isStartConfirm,
  parseTypeStructure,
  pickCount,
} from './intentRules'

describe('chineseToInt 中文数字解析', () => {
  it('常见口语题数', () => {
    expect(chineseToInt('二十')).toBe(20)
    expect(chineseToInt('五十')).toBe(50)
    expect(chineseToInt('十五')).toBe(15)
    expect(chineseToInt('十')).toBe(10)
    expect(chineseToInt('一百')).toBe(100)
    expect(chineseToInt('一百二十')).toBe(120)
    expect(chineseToInt('三十')).toBe(30)
  })
  it('非数字串 / 非法返回 null', () => {
    expect(chineseToInt('abc')).toBeNull()
    expect(chineseToInt('')).toBeNull()
    expect(chineseToInt('道题哈哈')).toBeNull()
  })
})

describe('pickCount 题数提取（含中文数字）', () => {
  it('阿拉伯数字 + 题/道', () => {
    expect(pickCount('帮我出10道关于化学元素周期的判断题')).toBe(10)
    expect(pickCount('20道题，阅读题吧')).toBe(20)
    expect(pickCount('生成 50 题')).toBe(50)
  })
  it('中文数字 + 道/题（口语）', () => {
    expect(pickCount('先来五十道不用太难')).toBe(50)
    expect(pickCount('来二十道')).toBe(20)
    expect(pickCount('十五道')).toBe(15)
  })
  it('无明确数字返回 null；「第三题」讨论语境不当题数', () => {
    expect(pickCount('随便')).toBeNull()
    expect(pickCount('难度适中就好')).toBeNull()
    expect(pickCount('第三题怎么做')).toBeNull()
  })
})

describe('hasExplicitGenIntent 明确出题词', () => {
  it('明确出题词命中', () => {
    expect(hasExplicitGenIntent('帮我出10道关于海洋的单选题')).toBe(true)
    expect(hasExplicitGenIntent('那出题吧')).toBe(true)
    expect(hasExplicitGenIntent('来点题')).toBe(true)
  })
  it('闲聊 / 问答案不命中', () => {
    expect(hasExplicitGenIntent('这道题选什么')).toBe(false)
    expect(hasExplicitGenIntent('这个剧真好看')).toBe(false)
    expect(hasExplicitGenIntent('帮我看看这道题怎么做')).toBe(false)
    // 纯规格承接无出题动词，不应被「明确出题词」接住（应走 isGenSpecReply）
    expect(hasExplicitGenIntent('先来五十道不用太难')).toBe(false)
  })
  it('英语出题请求命中（E2E：give me 10 python questions 确认卡丢失回归）', () => {
    expect(hasExplicitGenIntent('give me 10 python questions')).toBe(true)
    expect(hasExplicitGenIntent('generate 20 quiz questions about history')).toBe(true)
    expect(hasExplicitGenIntent('create 15 exercises')).toBe(true)
    expect(hasExplicitGenIntent('make me a 30 question quiz')).toBe(true)
  })
  it('英语聊天不误判', () => {
    expect(hasExplicitGenIntent('how to write test cases in software engineering')).toBe(false)
    expect(hasExplicitGenIntent('what is this question asking')).toBe(false)
    expect(hasExplicitGenIntent('hello there')).toBe(false)
  })
})

describe('isGenSpecReply 承接式题数/题型规格（6.15）', () => {
  it('「数字+道/题」的承接规格命中', () => {
    expect(isGenSpecReply('20道题，阅读题吧')).toBe(true)
    expect(isGenSpecReply('60道判断')).toBe(true)
    expect(isGenSpecReply('先来五十道不用太难')).toBe(true)
    expect(isGenSpecReply('来二十道')).toBe(true)
  })
  it('讨论某道具体题 / 闲聊不命中', () => {
    expect(isGenSpecReply('第3题选什么')).toBe(false)
    expect(isGenSpecReply('这20道题怎么做')).toBe(false)
    expect(isGenSpecReply('这道题的解析是什么')).toBe(false)
    expect(isGenSpecReply('这个剧真好看')).toBe(false)
  })
  it('6.19 回归：带出题动词/自身主题的完整请求不算承接式，避免 recentGenTopic 把上一条主题拼进来', () => {
    expect(isGenSpecReply('帮我生成 20 道关于海洋的单选题')).toBe(false)
    expect(isGenSpecReply('生成20道关于海洋的单选题')).toBe(false)
    expect(isGenSpecReply('来点海洋知识的选择题')).toBe(false)
    // 纯承接规格仍应命中（无动词、靠上文决定主题）
    expect(isGenSpecReply('20道题，阅读题吧')).toBe(true)
    expect(isGenSpecReply('60道判断')).toBe(true)
  })
  it('真机 bug 回归：句中含「这/那」但非指代具体题目的承接规格要命中（否则生题确认与按钮全丢）', () => {
    expect(isGenSpecReply('100道题，这些都覆盖，难度简单一些')).toBe(true)
    expect(isGenSpecReply('50道题，那些知识点不用覆盖')).toBe(true)
    // 具体题目指代仍然排除
    expect(isGenSpecReply('这道题选什么')).toBe(false)
    expect(isGenSpecReply('这些题太难了')).toBe(false)
    expect(isGenSpecReply('哪题答案是B')).toBe(false)
  })
  it('英语题数承接规格命中（英语链路 P2 验收）', () => {
    expect(isGenSpecReply('20 questions please')).toBe(true)
    expect(isGenSpecReply('10 exercises')).toBe(true)
  })
})

describe('isStartConfirm 开始确认短指令', () => {
  it('承接/开始指令', () => {
    expect(isStartConfirm('好')).toBe(true)
    expect(isStartConfirm('生成吧')).toBe(true)
    expect(isStartConfirm('开始生成')).toBe(true)
    expect(isStartConfirm('就这样')).toBe(true)
  })
  it('非开始指令', () => {
    expect(isStartConfirm('这道题为什么错')).toBe(false)
    expect(isStartConfirm('这个剧真好看')).toBe(false)
  })
})

describe('isAdjustment 需求调整判定', () => {
  it('调整句命中', () => {
    expect(isAdjustment('人界多一些')).toBe(true)
    expect(isAdjustment('改成中文命题')).toBe(true)
    expect(isAdjustment('题型换成判断')).toBe(true)
  })
  it('开始确认不当作调整', () => {
    expect(isAdjustment('生成吧')).toBe(false)
    expect(isAdjustment('可以')).toBe(false)
  })
  it('问句不当作调整', () => {
    expect(isAdjustment('为什么选这个')).toBe(false)
    expect(isAdjustment('这道题选什么？')).toBe(false)
  })
})

describe('isVagueCountAdjustment 模糊题量调整', () => {
  it('错别字/口语只表达增减题量时命中', () => {
    expect(isVagueCountAdjustment('我觉得刚才的题有点上了，还想多出一些')).toBe(true)
    expect(isVagueCountAdjustment('题有点少了，再多一点')).toBe(true)
    expect(isVagueCountAdjustment('题量不够')).toBe(true)
  })
  it('明确数量、题型或复杂要求不走本地澄清', () => {
    expect(isVagueCountAdjustment('再多出5题')).toBe(false)
    expect(isVagueCountAdjustment('多选题再多一些')).toBe(false)
    expect(isVagueCountAdjustment('多出一些，难度再高一点')).toBe(false)
  })
})

describe('isDefaultAnswer 放弃指定题数', () => {
  it('随便/你定等', () => {
    expect(isDefaultAnswer('随便')).toBe(true)
    expect(isDefaultAnswer('都行')).toBe(true)
    expect(isDefaultAnswer('你看着办')).toBe(true)
  })
  it('明确数量不当作放弃', () => {
    expect(isDefaultAnswer('30道')).toBe(false)
  })
})

describe('isGenAbort 取消/放弃待确认生题（分诊加固 A）', () => {
  it('明确取消/放弃', () => {
    expect(isGenAbort('算了')).toBe(true)
    expect(isGenAbort('不弄了')).toBe(true)
    expect(isGenAbort('取消')).toBe(true)
    expect(isGenAbort('先不弄了')).toBe(true)
    expect(isGenAbort('聊点别的')).toBe(true)
    expect(isGenAbort('改天再说')).toBe(true)
  })
  it('普通承接/调整不误判为取消', () => {
    expect(isGenAbort('出吧')).toBe(false)
    expect(isGenAbort('好')).toBe(false)
    expect(isGenAbort('人界再多一点')).toBe(false)
    expect(isGenAbort('改成 40 道')).toBe(false)
    expect(isGenAbort('20道判断')).toBe(false)
  })
})

describe('parseTypeStructure 题型×数量结构解析（RC-07）', () => {
  it('真机原句：选择题15+案例分析2+论文1 → 歧义选择题15 + case2 + essay1，合计 18', () => {
    const r = parseTypeStructure('帮我生成软考系统规划与管理师的习题，选择题15题，案例分析2题，论文1题。')
    expect(r.matched).toBe(true)
    expect(r.ambiguousCount).toBe(15)
    expect(r.entries).toEqual([
      { type: 'case', count: 2 },
      { type: 'essay', count: 1 },
    ])
    expect(r.total).toBe(18)
  })

  it('单选/多选各自限定时直接入结构（不歧义）', () => {
    const r = parseTypeStructure('出题，单选10道，多选5道，判断2题')
    expect(r.ambiguousCount).toBeNull()
    expect(r.entries).toEqual([
      { type: 'single', count: 10 },
      { type: 'multiple', count: 5 },
      { type: 'judge', count: 2 },
    ])
    expect(r.total).toBe(17)
  })

  it('数量在别名前：「15道单选题」', () => {
    const r = parseTypeStructure('来 15 道单选题')
    expect(r.entries).toEqual([{ type: 'single', count: 15 }])
    expect(r.total).toBe(15)
  })

  it('无题型词不误判：纯题数/普通聊天', () => {
    expect(parseTypeStructure('帮我出20道题').matched).toBe(false)
    expect(parseTypeStructure('今天天气怎么样').matched).toBe(false)
  })

  it('无编号 Markdown 节标题（## 1.1 xx）不因数字前缀被误读为题数', () => {
    const r = parseTypeStructure('请围绕 1.1 网络架构 出题，案例 2 题')
    // 「案例 2 题」命中 case:2；「1.1 网络架构」不是题型别名
    expect(r.entries).toEqual([{ type: 'case', count: 2 }])
  })
})
