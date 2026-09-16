/**
 * draftProtocol 纯测试（TASK-03 必测用例全集，实施路线 13 节）。
 * 覆盖：围栏闭合/未闭合/多块/剥离、跨 chunk 不泄漏、容错 JSON、白名单未知键拒绝、
 * intent/patch 冲突、题型别名归一与重复别名冲突、三种 count_plan 操作、
 * evidence 校验与降级、source_policy 键拒绝、本地显式提取与合并。
 */
import { describe, expect, it } from 'vitest'
import type { GenerationDraft } from '../../types'
import {
  ProtocolTailFilter,
  evidenceHolds,
  extractExplicitDraftPatch,
  extractExplicitTotal,
  mergeLocalAndModelPatch,
  parseDraftPatchWire,
  stripWireFences,
} from './draftProtocol'
import type { DraftPatchParseResult, DraftProtocolErrorCode, DraftTurnContext } from './draftProtocol'

/** 断言解析失败并返回错误（收窄类型用） */
function err(r: DraftPatchParseResult): { code: DraftProtocolErrorCode; message: string } {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected parse failure')
  return r.error
}

function ctx(over?: Partial<DraftTurnContext>): DraftTurnContext {
  return {
    turnId: 't1',
    baseRevision: 1,
    userText: '围绕海洋知识出20题，单选10，多选5，先不出了',
    currentDraft: null,
    ...over,
  }
}

function fence(json: string): string {
  return '```gen_draft_patch\n' + json + '\n```'
}

const CUSTOM_DRAFT: GenerationDraft = {
  schemaVersion: 2,
  id: 'gd_1',
  sessionId: 's1',
  revision: 1,
  lifecycle: 'active',
  createdAt: 0,
  updatedAt: 0,
  topic: { value: '海洋知识', basis: 'user_explicit' },
  countPlan: {
    mode: 'custom',
    typeCounts: {
      single: { value: 10, basis: 'user_explicit' },
      multiple: { value: 5, basis: 'user_explicit' },
      judge: { value: 5, basis: 'user_explicit' },
    },
  },
  requirements: [],
  source: {},
  appliedTurnIds: [],
  turnIssues: [],
}

/* ============================ 围栏提取与剥离 ============================ */

describe('围栏提取与正文剥离（实施路线 6.2 规则 1）', () => {
  it('闭合围栏：取块成功、正文剥离干净', () => {
    const reply = '好的，已记录。\n' + fence('{"schema_version":2,"intent":"chat"}') + '\n还有问题随时问我。'
    const stripped = stripWireFences(reply)
    expect(stripped).toBe('好的，已记录。\n\n还有问题随时问我。')
    const r = parseDraftPatchWire(reply, ctx())
    expect(r.ok).toBe(true)
  })

  it('未闭合围栏（流截断）：仍提取到块（解析大概率 INVALID_JSON），正文剥离不残留', () => {
    const reply = '前言\n```gen_draft_patch\n{"schema_version":2,"intent":"cha'
    const stripped = stripWireFences(reply)
    expect(stripped).not.toContain('gen_draft_patch')
    expect(stripped).not.toContain('"intent"')
    const r = parseDraftPatchWire(reply, ctx())
    expect(r.ok).toBe(false)
    expect(['INVALID_JSON', 'SCHEMA_INVALID']).toContain(err(r).code)
  })

  it('多个围栏：只取最后一个解析，可见正文剥离全部', () => {
    const reply =
      fence('{"schema_version":2,"intent":"chat","acknowledgement":"第一块"}') +
      '中间文本\n' +
      fence('{"schema_version":2,"intent":"update","patch":{"topic":{"op":"set","value":"海洋知识","basis":"user_explicit","evidence":"海洋知识"}}}')
    const r = parseDraftPatchWire(reply, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch.intent).toBe('update')
    const stripped = stripWireFences(reply)
    expect(stripped).toBe('中间文本')
  })

  it('JSON 前后说明文字 / 尾逗号：平衡扫描 + 去尾逗号容错', () => {
    const r1 = parseDraftPatchWire(
      fence('好的，这是本轮更新：\n{"schema_version":2,"intent":"chat",}\n以上。'),
      ctx(),
    )
    expect(r1.ok).toBe(true)
  })

  it('截断 JSON / 纯垃圾：INVALID_JSON', () => {
    const r1 = parseDraftPatchWire(fence('{"schema_version":2,"intent":"update","patch":{"to'), ctx())
    expect(r1.ok).toBe(false)
    expect(err(r1).code).toBe('INVALID_JSON')
    const r2 = parseDraftPatchWire(fence('这不是 JSON'), ctx())
    expect(r2.ok).toBe(false)
    expect(err(r2).code).toBe('INVALID_JSON')
  })
})

describe('ProtocolTailFilter · 跨 chunk 协议不泄漏（实施路线 6.5 规则 7 / P0-27）', () => {
  it('起始标记被拆成多个 chunk：任何标记与 JSON 字符都不进入可见正文', () => {
    const full = '正常回复开头，先说结论。\n' + fence('{"schema_version":2,"intent":"chat","acknowledgement":"好"}') + '结尾补充。'
    // 以各种刁钻切分点喂入
    const splits: string[][] = [
      Array.from(full), // 逐字符
      [full.slice(0, 10), full.slice(10, 30), full.slice(30)],
      [full.slice(0, 25), full.slice(25, 26), full.slice(26)], // 标记中间切
    ]
    for (const chunks of splits) {
      const f = new ProtocolTailFilter()
      let out = ''
      for (const c of chunks) out += f.push(c)
      out += f.flush()
      expect(out).toBe('正常回复开头，先说结论。\n结尾补充。')
    }
  })

  it('未闭合协议残尾：flush 直接丢弃，不上屏', () => {
    const f = new ProtocolTailFilter()
    let out = f.push('可见文本\n```gen_draft_patch\n{"schema_v')
    out += f.flush()
    expect(out).toBe('可见文本\n')
  })

  it('无协议的普通流：文本原样通过（只延迟标记窗口长度）', () => {
    const f = new ProtocolTailFilter()
    let out = f.push('今天天气不错，')
    out += f.push('适合学习。')
    out += f.flush()
    expect(out).toBe('今天天气不错，适合学习。')
  })

  it('协议后还有正常文本：闭合后恢复释放', () => {
    const f = new ProtocolTailFilter()
    let out = f.push('A' + fence('{"schema_version":2,"intent":"chat"}') + 'B' + fence('{"schema_version":2,"intent":"chat"}') + 'C')
    out += f.flush()
    expect(out).toBe('ABC')
  })
})

/* ============================ schema 白名单与门禁 ============================ */

describe('schema 白名单（实施路线 6.2 规则 3）', () => {
  it('schema_version 非 2：SCHEMA_INVALID', () => {
    const r = parseDraftPatchWire(fence('{"schema_version":1,"intent":"chat"}'), ctx())
    expect(err(r).code).toBe('SCHEMA_INVALID')
  })

  it('未知顶层键（含模型伪造 turn_id/draft_id/base_revision）：UNKNOWN_KEY', () => {
    for (const key of ['turn_id', 'draft_id', 'base_revision', 'ready', 'show_button']) {
      const r = parseDraftPatchWire(fence(`{"schema_version":2,"intent":"chat","${key}":1}`), ctx())
      expect(r.ok).toBe(false)
      expect(err(r).code).toBe('UNKNOWN_KEY')
    }
  })

  it('未知 patch 键 / 未知题型键：UNKNOWN_KEY，不静默丢弃', () => {
    const r1 = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"notes":"x"}}'),
      ctx(),
    )
    expect(err(r1).code).toBe('UNKNOWN_KEY')
    const r2 = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_custom","type_counts":{"怪题":5},"basis":"user_explicit","evidence":"单选10"}}}',
      ),
      ctx(),
    )
    expect(err(r2).code).toBe('UNKNOWN_KEY')
  })
})

describe('intent 与 patch 一致性（实施路线 6.2 规则 10）', () => {
  it('intent=chat/cancel 携带非空 patch：INTENT_PATCH_CONFLICT', () => {
    const r = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"chat","patch":{"topic":{"op":"set","value":"海洋","basis":"model_inferred"}}}',
      ),
      ctx(),
    )
    expect(err(r).code).toBe('INTENT_PATCH_CONFLICT')
  })

  it('intent=chat 携带空 patch 对象：合法（无字段）', () => {
    const r = parseDraftPatchWire(fence('{"schema_version":2,"intent":"chat","patch":{}}'), ctx())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch.intent).toBe('chat')
  })

  it('intent=update/replace 无 patch 或全空：EMPTY_PATCH（触发重试）', () => {
    const r1 = parseDraftPatchWire(fence('{"schema_version":2,"intent":"update"}'), ctx())
    expect(err(r1).code).toBe('EMPTY_PATCH')
    const r2 = parseDraftPatchWire(fence('{"schema_version":2,"intent":"replace","patch":{}}'), ctx())
    expect(err(r2).code).toBe('EMPTY_PATCH')
  })
})

/* ============================ topic / requirements ============================ */

describe('topic 与 requirements 转换', () => {
  it('topic set：evidence 成立 → user_explicit；不成立/缺失 → 降级 model_inferred（必测）', () => {
    const okR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"topic":{"op":"set","value":"海洋知识","basis":"user_explicit","evidence":"海洋知识"}}}'),
      ctx(),
    )
    if (!okR.ok) throw okR.error
    expect(okR.patch.topic).toMatchObject({ kind: 'set', field: { basis: 'user_explicit' } })

    const badR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"topic":{"op":"set","value":"数学","basis":"user_explicit","evidence":"微积分"}}}'),
      ctx(),
    )
    if (!badR.ok) throw badR.error
    expect(badR.patch.topic).toMatchObject({ kind: 'set', field: { basis: 'model_inferred' } })

    const noEvR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"topic":{"op":"set","value":"海洋","basis":"user_explicit"}}}'),
      ctx(),
    )
    if (!noEvR.ok) throw noEvR.error
    expect(noEvR.patch.topic).toMatchObject({ kind: 'set', field: { basis: 'model_inferred' } })
  })

  it('topic unset：evidence 成立才生效；不成立拒绝该操作（实施路线 4.4）', () => {
    const okR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"topic":{"op":"unset","evidence":"不要主题了"}}}'),
      ctx({ userText: '把主题去掉，不要主题了' }),
    )
    expect(okR.ok).toBe(true)

    const badR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"topic":{"op":"unset","evidence":"随便写的"}}}'),
      ctx(),
    )
    // 唯一操作被拒 → EMPTY_PATCH（触发重试）
    expect(err(badR).code).toBe('EMPTY_PATCH')
  })

  it('requirements append：evidence 成立 → user_explicit；不成立降级 inferred', () => {
    const r = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"requirements":{"append":[{"text":"难一点","basis":"user_explicit","evidence":"难一点"},{"text":"全部中文","basis":"user_explicit","evidence":"瞎写的"}]}}}',
      ),
      ctx({ userText: '出20题，难一点，全部中文' }),
    )
    if (!r.ok) throw r.error
    expect(r.patch.appendRequirements[0].basis).toBe('user_explicit')
    expect(r.patch.appendRequirements[1].basis).toBe('model_inferred')
  })

  it('requirements remove：evidence 不成立拒绝删除该条（实施路线 6.2）', () => {
    const r = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"requirements":{"remove":[{"id":"r1","evidence":"把难度那条去掉"}]}}}',
      ),
      ctx({ userText: '把难度那条去掉' }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch.removeRequirementIds).toEqual(['r1'])

    const badR = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"requirements":{"remove":[{"id":"r1","evidence":"无关证据"}]}}}',
      ),
      ctx({ userText: '把难度那条去掉' }),
    )
    expect(err(badR).code).toBe('EMPTY_PATCH')
  })
})

/* ============================ count_plan ============================ */

describe('count_plan · set_ai / set_custom / patch_custom', () => {
  it('set_ai：evidence 成立 → ai/total；「题型你安排」可省略 total（实施路线 4.3）', () => {
    const r = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_ai","total":20,"basis":"user_explicit","evidence":"出20题"}}}'),
      ctx(),
    )
    if (!r.ok) throw r.error
    expect(r.patch.countPlan).toEqual({
      kind: 'set_ai',
      total: { value: 20, basis: 'user_explicit', messageId: 't1', evidence: '出20题' },
    })
    const r2 = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_ai","basis":"user_explicit","evidence":"题型你来安排"}}}'),
      ctx({ userText: '20题，题型你来安排' }),
    )
    if (!r2.ok) throw r2.error
    expect(r2.patch.countPlan).toEqual({ kind: 'set_ai' })
  })

  it('set_ai/set_custom evidence 不成立：COUNT_NOT_EXPLICIT，不写草稿数量（必测/P0-29）', () => {
    const r1 = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_ai","total":20,"basis":"user_explicit","evidence":"我猜的"}}}'),
      ctx({ userText: '来一些 Python 题' }),
    )
    expect(err(r1).code).toBe('COUNT_NOT_EXPLICIT')
    const r2 = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_custom","type_counts":{"single":10},"basis":"user_explicit","evidence":"乱编的"}}}'),
      ctx({ userText: '来一些 Python 题' }),
    )
    expect(err(r2).code).toBe('COUNT_NOT_EXPLICIT')
  })

  it('题型别名归一：「案例分析/案例分析题/case」→ case（必测，共用 intentRules 归一表）', () => {
    for (const key of ['案例分析', '案例分析题', 'case', 'CASE']) {
      const r = parseDraftPatchWire(
        fence(
          `{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_custom","type_counts":{"${key}":2},"basis":"user_explicit","evidence":"案例分析2题"}}}`,
        ),
        ctx({ userText: '案例分析2题' }),
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        const cp = r.patch.countPlan!
        expect(cp.kind).toBe('set_custom')
        if (cp.kind === 'set_custom') expect(cp.typeCounts.case).toEqual({ value: 2, basis: 'user_explicit' })
      }
    }
  })

  it('同一题型多别名：值相同合并；值不同 DUPLICATE_TYPE_CONFLICT 而非最后写入覆盖（必测/P0-17）', () => {
    const same = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_custom","type_counts":{"single":10,"单选题":10},"basis":"user_explicit","evidence":"单选10"}}}',
      ),
      ctx({ userText: '单选10' }),
    )
    expect(same.ok).toBe(true)

    const conflict = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_custom","type_counts":{"单选题":10,"single":8},"basis":"user_explicit","evidence":"单选题10"}}}',
      ),
      ctx({ userText: '单选题10' }),
    )
    expect(err(conflict).code).toBe('DUPLICATE_TYPE_CONFLICT')
  })

  it('set_custom 完整替换 vs patch_custom 局部修改（必测/P0-07）', () => {
    // patch_custom 在活动 custom 方案上合法：set + unset
    const patch = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"patch_custom","set":{"multiple":8},"unset":["judge"],"basis":"user_explicit","evidence":"多选改成8题，删掉判断题"}}}',
      ),
      ctx({ userText: '多选改成8题，删掉判断题', currentDraft: CUSTOM_DRAFT }),
    )
    expect(patch.ok).toBe(true)
    if (patch.ok) {
      const cp = patch.patch.countPlan!
      expect(cp.kind).toBe('patch_custom')
      if (cp.kind === 'patch_custom') {
        expect(cp.set.multiple).toMatchObject({ value: 8 })
        expect(cp.unset).toEqual(['judge'])
      }
    }
    // patch_custom 在无 custom 方案时：COUNT_PLAN_REQUIRED（要求改用 set_custom）
    const needFull = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"patch_custom","set":{"multiple":8},"unset":[],"basis":"user_explicit","evidence":"多选改成8题"}}}',
      ),
      ctx({ userText: '多选改成8题' }),
    )
    expect(err(needFull).code).toBe('COUNT_PLAN_REQUIRED')
  })

  it('set_custom 携带 stated_total：statedTotal 转为对账约束（必测/P1-05）', () => {
    const r = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_custom","type_counts":{"single":10,"multiple":5},"stated_total":20,"basis":"user_explicit","evidence":"总共20题，单选10，多选5"}}}',
      ),
      ctx({ userText: 'ai20题后改：总共20题，单选10，多选5' }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cp = r.patch.countPlan!
      expect(cp.kind).toBe('set_custom')
      if (cp.kind === 'set_custom') expect(cp.statedTotal).toMatchObject({ value: 20 })
    }
  })

  it('unset_stated_total：与 stated_total 同现报 SCHEMA_INVALID；单独出现合法（P1-11）', () => {
    const both = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"patch_custom","set":{},"unset":[],"stated_total":20,"unset_stated_total":true,"basis":"user_explicit","evidence":"不再限定总数"}}}',
      ),
      ctx({ userText: '不再限定总数，按分项合计', currentDraft: CUSTOM_DRAFT }),
    )
    expect(err(both).code).toBe('SCHEMA_INVALID')

    const ok = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"patch_custom","set":{},"unset":[],"unset_stated_total":true,"basis":"user_explicit","evidence":"不再限定总数，按分项合计"}}}',
      ),
      ctx({ userText: '不再限定总数，按分项合计', currentDraft: CUSTOM_DRAFT }),
    )
    expect(ok.ok).toBe(true)
  })

  it('负数 / 小数 / 0 / 字符串数字：INVALID_COUNT_VALUE（wire 不得携带 0）', () => {
    for (const bad of ['0', '-5', '10.5', '"20"']) {
      const r = parseDraftPatchWire(
        fence(
          `{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_ai","total":${bad},"basis":"user_explicit","evidence":"出20题"}}}`,
        ),
        ctx(),
      )
      expect(err(r).code).toBe('INVALID_COUNT_VALUE')
    }
  })

  it('超限整数 1001 放行进 patch（不夹取），由 validator 报 TOTAL_OUT_OF_RANGE（P0-16）', () => {
    const r = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_ai","total":1001,"basis":"user_explicit","evidence":"出1001题"}}}'),
      ctx({ userText: '出1001题' }),
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.patch.countPlan?.kind === 'set_ai') expect(r.patch.countPlan.total?.value).toBe(1001)
  })

  it('count_plan 整体 unset：evidence 成立生效；不成立拒绝（保留旧方案）', () => {
    const okR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"unset","evidence":"题数也不限了"}}}'),
      ctx({ userText: '主题保留，题数也不限了' }),
    )
    expect(okR.ok).toBe(true)
    const badR = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"unset","evidence":"没依据"}}}'),
      ctx({ userText: '主题保留，题数也不限了' }),
    )
    expect(err(badR).code).toBe('EMPTY_PATCH')
  })
})

/* ============================ source_policy ============================ */

describe('source_policy（实施路线 4.3：只表达旧资料去留）', () => {
  it('keep_existing/clear + evidence 成立：转为 sourcePolicy', () => {
    const r = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"replace","patch":{"source_policy":{"op":"keep_existing","evidence":"沿用这些资料"}}}',
      ),
      ctx({ userText: '沿用这些资料另出15题' }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch.sourcePolicy).toEqual({ kind: 'keep_existing', evidence: '沿用这些资料' })
  })

  it('模型夹带 messageId/refs/kbId：未知键拒绝（必测）', () => {
    for (const key of ['message_id', 'refs', 'kb_id']) {
      const r = parseDraftPatchWire(
        fence(
          `{"schema_version":2,"intent":"replace","patch":{"source_policy":{"op":"clear","evidence":"不要资料","${key}":"x"}}}`,
        ),
        ctx({ userText: '不要资料了' }),
      )
      expect(err(r).code).toBe('UNKNOWN_KEY')
    }
  })

  it('evidence 不成立：拒绝该策略（不整体失败时需有其他操作，否则 EMPTY_PATCH）', () => {
    const r = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"replace","patch":{"source_policy":{"op":"keep_existing","evidence":"瞎写的"}}}',
      ),
      ctx({ userText: '另出一套15题' }),
    )
    expect(err(r).code).toBe('EMPTY_PATCH')
  })
})

/* ============================ acknowledgement 与注入 ============================ */

describe('acknowledgement 与上下文注入', () => {
  it('acknowledgement 清洗不可信标记与围栏、限长 80', () => {
    const long = '好'.repeat(100)
    const r = parseDraftPatchWire(
      fence(
        `{"schema_version":2,"intent":"update","acknowledgement":"<untrusted_user_content>好 的</untrusted_user_content> 已记录${long}","patch":{"topic":{"op":"set","value":"海洋","basis":"model_inferred"}}}`,
      ),
      ctx(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.acknowledgement).not.toContain('untrusted_user_content')
      expect(r.acknowledgement!.length).toBeLessThanOrEqual(80)
    }
  })

  it('turnId/expectedDraftId/baseRevision 来自 App 上下文，不信任模型', () => {
    const r = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"chat"}'),
      ctx({ turnId: 'm_99', expectedDraftId: 'gd_x', baseRevision: 7 }),
    )
    if (!r.ok) throw r.error
    expect(r.patch.turnId).toBe('m_99')
    expect(r.patch.expectedDraftId).toBe('gd_x')
    expect(r.patch.baseRevision).toBe(7)
  })
})

/* ============================ evidence 规范化函数 ============================ */

describe('evidenceHolds（唯一规范化：NFKC + 小写 + 去空白标点）', () => {
  it('大小写 / 空白 / 中英标点差异不影响判定', () => {
    expect(evidenceHolds('Ocean!', 'The OCEAN is big。')).toBe(true)
    expect(evidenceHolds('出20题', '围绕牛顿第二定律，出 20 题！')).toBe(true)
    expect(evidenceHolds('微积分', '围绕海洋出题')).toBe(false)
    expect(evidenceHolds('', '原文')).toBe(false)
    expect(evidenceHolds(undefined, '原文')).toBe(false)
  })
})

/* ============================ 本地显式提取与合并 ============================ */

describe('extractExplicitTotal / extractExplicitDraftPatch（实施路线 6.4）', () => {
  it('中文数字 / 阿拉伯数字 / 裸数字；排除「第三题」指代', () => {
    expect(extractExplicitTotal('出二十道')).toBe(20)
    expect(extractExplicitTotal('先来50题吧')).toBe(50)
    expect(extractExplicitTotal('100')).toBe(100)
    expect(extractExplicitTotal('第三题选什么')).toBeNull()
    expect(extractExplicitTotal('来2份资料')).toBeNull()
  })

  it('明确总数 → set_ai（user_explicit 本地来源，不夹取）', () => {
    const p = extractExplicitDraftPatch('出1001题', ctx())
    expect(p!.countPlan).toEqual({
      kind: 'set_ai',
      total: { value: 1001, basis: 'user_explicit', messageId: 't1', evidence: '出1001题' },
    })
  })

  it('题型×数量 → set_custom（无草稿）/ patch_custom（活动 custom）', () => {
    const p1 = extractExplicitDraftPatch('单选10，多选5', ctx())
    expect(p1!.countPlan).toMatchObject({ kind: 'set_custom', typeCounts: { single: { value: 10 }, multiple: { value: 5 } } })
    const p2 = extractExplicitDraftPatch('多选改成8题，删掉判断题', ctx({ currentDraft: CUSTOM_DRAFT }))
    expect(p2!.countPlan).toMatchObject({
      kind: 'patch_custom',
      set: { multiple: { value: 8 } },
      unset: ['judge'],
    })
  })

  it('活动 custom 下「多选改成0 / 不要多选」→ unset 归一，不保存 0（必测/P1-13）', () => {
    const p1 = extractExplicitDraftPatch('多选改成0', ctx({ currentDraft: CUSTOM_DRAFT }))
    expect(p1!.countPlan).toEqual({ kind: 'patch_custom', set: {}, unset: ['multiple'] })
    const p2 = extractExplicitDraftPatch('不要多选了', ctx({ currentDraft: CUSTOM_DRAFT }))
    expect(p2!.countPlan).toEqual({ kind: 'patch_custom', set: {}, unset: ['multiple'] })
  })

  it('混合表达（总数 + 部分分项）：分项为执行事实、总数进 statedTotal（P1-15）', () => {
    const p = extractExplicitDraftPatch('总共20题，单选10题，剩下你安排', ctx())
    const cp = p!.countPlan!
    expect(cp.kind).toBe('set_custom')
    if (cp.kind === 'set_custom') {
      expect(cp.typeCounts.single).toMatchObject({ value: 10 })
      expect(cp.statedTotal).toMatchObject({ value: 20 })
    }
  })

  it('无可靠显式值：null（不编造）', () => {
    expect(extractExplicitDraftPatch('难一点', ctx())).toBeNull()
    expect(extractExplicitDraftPatch('用我刚才的文件出题', ctx())).toBeNull()
  })

  it('明确主题与要求也可形成本地兜底补丁，不依赖模型协议', () => {
    const p = extractExplicitDraftPatch('围绕光合作用出题，高中难度，重点考易错点', ctx())
    expect(p).not.toBeNull()
    expect(p!.topic).toEqual({
      kind: 'set',
      field: { value: '光合作用', basis: 'user_explicit', messageId: 't1', evidence: '围绕光合作用' },
    })
    expect(p!.appendRequirements).toEqual([
      { value: '高中难度', basis: 'user_explicit', messageId: 't1' },
      { value: '重点考易错点', basis: 'user_explicit', messageId: 't1' },
    ])
  })
})

describe('mergeLocalAndModelPatch（本地显式优先，实施路线 6.4）', () => {
  it('模型说 25、本地明确 20：采用本地 20 并记录差异（必测）', () => {
    const local = extractExplicitDraftPatch('出20题', ctx())
    const model = parseDraftPatchWire(
      fence('{"schema_version":2,"intent":"update","patch":{"count_plan":{"op":"set_ai","total":25,"basis":"user_explicit","evidence":"出20题"}}}'),
      ctx(),
    )
    const merged = mergeLocalAndModelPatch(local!, model.ok ? model.patch : null)
    expect(merged.patch!.countPlan).toMatchObject({ kind: 'set_ai', total: { value: 20 } })
    expect(merged.diffs).toHaveLength(1)
    expect(merged.diffs[0]).toContain('20')
    expect(merged.diffs[0]).toContain('25')
  })

  it('仅一方存在时取该方；topic/requirements 沿用模型（本地只提数量题型）', () => {
    const local = extractExplicitDraftPatch('出20题', ctx())
    const model = parseDraftPatchWire(
      fence(
        '{"schema_version":2,"intent":"update","patch":{"topic":{"op":"set","value":"海洋知识","basis":"user_explicit","evidence":"海洋知识"}}}',
      ),
      ctx(),
    )
    const merged = mergeLocalAndModelPatch(local!, model.ok ? model.patch : null)
    expect(merged.patch!.topic).toBeDefined()
    expect(merged.patch!.countPlan).toMatchObject({ kind: 'set_ai', total: { value: 20 } })
    expect(merged.diffs).toHaveLength(0)
    expect(mergeLocalAndModelPatch(null, null).patch).toBeNull()
  })
})
