import { beforeEach, describe, expect, it } from 'vitest'
import type { AnswerRecord, ExportFile, KBDoc, Pack, Preferences } from '../../types'
import { clearAllStores, dbAnswers, dbCategories, dbConfig, dbKB, dbLearning, dbPacks, dbUsage, initDB } from '../../db'
import { applyImport, buildImportPlan, exportBackup, exportPackMarkdown, parseImport, parsePackMarkdown } from './index'
import { sanitizeImport, sanitizeImportDetailed, MAX_IMPORT_BYTES } from './validate'
import type { LearningState, WrongRecord } from '../../types'

function mkPack(id: string, qId = `${id}-q1`): Pack {
  return {
    id,
    title: `题包 ${id}`,
    category: '测试',
    source: 'ai',
    meta: { difficulty: '简单', objectives: [] },
    chapters: [],
    questions: [
      {
        id: qId,
        type: 'judge',
        stem: '题干',
        options: ['正确', '错误'],
        answer: 'true',
        explanation: '解析',
        kp_ids: ['kp1'],
        difficulty: 1,
      },
    ],
    created_at: 0,
  }
}

function mkKB(id: string): KBDoc {
  return {
    id,
    name: `库 ${id}`,
    sourceFiles: [{ name: 'a.txt', size: 10 }],
    sourcesText: [],
    bodyText: '语料',
    schema: 2,
    summary: '1 份资料 · 1 节 · 2 字',
    consolidated: '',
    sections: [],
    charCount: 2,
    source: 'kb',
    status: 'ready',
    created_at: 1,
    updated_at: 1,
  }
}

describe('导出/导入 v2（V2-F01 完整备份 + V2-S05 上限）', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
  })

  it('exportBackup 输出 version=2 且含全部白名单字段', () => {
    const answers: AnswerRecord[] = [{ id: 1, packId: 'p1', questionId: 'p1-q1', correct: true, mode: 'quiz', timestamp: 10 }]
    const json = exportBackup([mkPack('p1')], {
      knowledgeBases: [mkKB('kb1')],
      learning: [],
      wrongs: [],
      answers,
      usage: [],
      categories: ['测试'],
      preferences: { dailyReviewLimit: 30 },
    })
    const file = JSON.parse(json) as ExportFile
    expect(file.version).toBe(2)
    expect(file.type).toBe('backup')
    expect(file.packs).toHaveLength(1)
    expect(file.knowledgeBases).toHaveLength(1)
    expect(file.answers).toHaveLength(1)
    expect(file.categories).toEqual(['测试'])
    expect(file.preferences).toEqual({ dailyReviewLimit: 30 })
  })

  it('导出→导入 完整往返：知识库/作答/分类/偏好全部落库', async () => {
    const pack = mkPack('p1')
    const kb = mkKB('kb1')
    const answers: AnswerRecord[] = [{ id: 7, packId: 'p1', questionId: 'p1-q1', correct: false, mode: 'quiz', timestamp: 50 }]
    const json = exportBackup([pack], {
      knowledgeBases: [kb],
      answers,
      learning: [],
      wrongs: [],
      usage: [],
      categories: ['测试'],
      preferences: { dailyReviewLimit: 45 },
    })
    const file = parseImport(json)
    const plan = buildImportPlan(file, [])
    const res = await applyImport(plan, { merge: false })
    expect(res.imported).toBe(1)

    expect(await dbPacks.getAll()).toHaveLength(1)
    expect(await dbKB.getAll()).toHaveLength(1)
    const cats = await dbCategories.getAll()
    expect(cats).toContain('测试')
    const pref = await dbConfig.get('preferences')
    expect((pref as Preferences).dailyReviewLimit).toBe(45)
    // V3-F01：作答改用 add() 生成本机自增 id，不再保留备份外部 id（避免两台设备 id 撞车覆盖）
    const stored = await dbAnswers.getAll()
    expect(stored).toHaveLength(1)
    expect(stored[0].id).not.toBe(7)
    expect(typeof stored[0].id).toBe('number')
  })

  it('导出仅知识库（无题包）也能恢复', async () => {
    const json = exportBackup([], { knowledgeBases: [mkKB('kb1')], categories: [], preferences: undefined })
    const file = parseImport(json) // pack 缺失不再抛错
    const plan = buildImportPlan(file, [])
    const res = await applyImport(plan, { merge: false })
    expect(res.imported).toBe(0)
    expect(await dbKB.getAll()).toHaveLength(1)
  })

  it('v1 旧格式只读兼容：缺失新字段按空数组导入不报错', async () => {
    const v1: ExportFile = {
      version: 1,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      learning: [],
      wrongs: [],
      usage: [],
      exportedAt: Date.now(),
    }
    const safe = sanitizeImport(v1)
    expect(safe.version).toBe(2)
    expect(safe.knowledgeBases ?? []).toEqual([])
    const plan = buildImportPlan(v1, [])
    await applyImport(plan, { merge: false })
    expect(await dbPacks.getAll()).toHaveLength(1)
  })

  it('学习记录超上限抛错而非静默截断（V2-S05）', () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      learning: Array.from({ length: 5001 }, (_, i) => ({
        kp_id: `kp${i}`,
        mastery: 0,
        state: '未学习' as const,
        interval_days: 0,
        next_review: new Date().toISOString(),
        wrong_count: 0,
        last_result: 'correct' as const,
        recent: [],
      })),
    }
    expect(() => sanitizeImport(file)).toThrow(/学习记录超过上限/)
  })

  it('分类超过上限抛错（V2-S05）', () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      categories: Array.from({ length: 501 }, (_, i) => `分类${i}`),
    }
    expect(() => sanitizeImport(file)).toThrow(/分类数量超过上限/)
  })

  it('重复题包 id 抛错（V2-S05 唯一性）', () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('dup'),
      packs: [mkPack('dup'), mkPack('dup')],
    }
    expect(() => sanitizeImport(file)).toThrow(/重复题包 ID/)
  })

  it('导入体积上限常量为 20MB（V2-S05）', () => {
    expect(MAX_IMPORT_BYTES).toBe(20 * 1024 * 1024)
  })

  it('作答历史缺失 id 的脏记录导入会追加并保留', async () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      answers: [{ packId: 'p1', questionId: 'p1-q1', correct: true }] as unknown as AnswerRecord[],
    }
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const stored = await dbAnswers.getAll()
    expect(stored.length).toBe(1)
  })
})

describe('V3-F01：恢复不覆盖本机，追加/孤儿策略', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
  })

  function keyedFile(answers: unknown[], usage: unknown[] = [], kbs: KBDoc[] = []): ExportFile {
    return {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      answers: answers as AnswerRecord[],
      usage: usage as ExportFile['usage'],
      knowledgeBases: kbs,
      learning: [],
      wrongs: [],
    } as unknown as ExportFile
  }

  it('两台设备备份含相同 answer id：导入后双方数据均保留（追加不覆盖）', async () => {
    // 本机已有一条作答（本机自增 id）
    await dbAnswers.add({ packId: 'p1', questionId: 'p1-q1', correct: true, mode: 'quiz', timestamp: 1 })
    const file = keyedFile([
      { id: 1, packId: 'p1', questionId: 'p1-q1', correct: false, mode: 'quiz', timestamp: 999 },
    ])
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const stored = await dbAnswers.getAll()
    // 本机 1 条 + 导入 1 条
    expect(stored.length).toBe(2)
  })

  it('多条 answer 缺失 id：不因 Date.now() 撞 key 互相覆盖', async () => {
    const file = keyedFile([
      { packId: 'p1', questionId: 'p1-q1', correct: true },
      { packId: 'p1', questionId: 'p1-q1', correct: false },
      { packId: 'p1', questionId: 'p1-q1', correct: true },
    ])
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    expect((await dbAnswers.getAll()).length).toBe(3)
  })

  it('跳过重复题包时，不给其作答历史隐式写入', async () => {
    await dbPacks.put(mkPack('p1')) // 本机已存在 p1（重复）
    const file = keyedFile([{ id: 1, packId: 'p1', questionId: 'p1-q1', correct: true, mode: 'quiz', timestamp: 5 }])
    const plan = buildImportPlan(file, [mkPack('p1')])
    const res = await applyImport(plan, { merge: false }) // 跳过
    expect(res.skipped).toBe(1)
    expect(await dbAnswers.getAll()).toHaveLength(0)
  })

  it('作答引用缺失题包/题目计入 answersOrphans，导入时忽略', async () => {
    const file = keyedFile([{ id: 5, packId: 'nope', questionId: 'x', correct: true, mode: 'quiz', timestamp: 5 }])
    const plan = buildImportPlan(file, [])
    expect(plan.answersOrphans).toBe(1)
    await applyImport(plan, { merge: false })
    expect(await dbAnswers.getAll()).toHaveLength(0)
  })

  it('usage 与本地 id 冲突：本机保留，导入以新 id 追加', async () => {
    await dbUsage.add({ id: 'u-dup', module: '生成', providerId: 'x', model: '', inputTokens: 1, outputTokens: 0, totalTokens: 1, cacheReadTokens: 0, cacheMissTokens: 1, cost: 0, timestamp: 1 })
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      usage: [{ id: 'u-dup', module: '生成', providerId: 'x', model: '', inputTokens: 100, outputTokens: 0, totalTokens: 100, cacheReadTokens: 0, cacheMissTokens: 100, cost: 0, timestamp: 999 }],
      learning: [],
      wrongs: [],
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const all = await dbUsage.getAll()
    expect(all.length).toBe(2) // 本机 + 追加，未覆盖
    expect(all.some((u) => u.timestamp === 1)).toBe(true) // 本机仍在
  })

  it('知识库 id 冲突：追加新 id，不覆盖本机同名库', async () => {
    await dbKB.put(mkKB('kb1'))
    const file = keyedFile([], [], [mkKB('kb1')])
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const all = await dbKB.getAll()
    expect(all.length).toBe(2) // 本机 + 追加
    expect(all.map((k) => k.id).filter((id) => id === 'kb1')).toHaveLength(1) // 本机仍为 kb1
  })
})

describe('V4-F01：导入冲突与引用完整性', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
  })

  const mkWrong = (over: Partial<WrongRecord>): WrongRecord =>
    (({
      questionId: 'p1-q1',
      packId: 'p1',
      packTitle: 'p1',
      question: mkPack('p1').questions[0],
      wrongCount: 1,
      correctStreak: 0,
      mastered: false,
      lastWrongAt: 1,
      createdAt: 1,
      ...over,
    }) as WrongRecord)

  const mkLearning = (kpId: string, over: Partial<LearningState> = {}): LearningState =>
    (({
      kp_id: kpId,
      mastery: 0.9,
      state: '已掌握' as const,
      interval_days: 15,
      next_review: '2099-01-01',
      wrong_count: 0,
      last_result: 'correct' as const,
      recent: [true],
      ...over,
    }) as LearningState)

  // 「跨题包重复 questionId 必须拒绝」「wrong.questionId 与内嵌题目 id 不一致必须拒绝」
  // 两条 V4-F01 抛错断言随 6.83 坏题跳过策略废止，替代用例见文末「6.83」组与前一组末尾。

  it('导入 learning 与本机主键冲突不得静默覆盖：本机已掌握保持不变', async () => {
    await dbLearning.put(mkLearning('kp1', { mastery: 0.5, state: '学习中' })) // 本机 kp1
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')], // p1-q1 的 kp_ids=['kp1']
      learning: [mkLearning('kp1', { mastery: 0.9, state: '已掌握', next_review: '2099-01-01' })],
      wrongs: [],
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const stored = await dbLearning.get('kp1')
    expect(stored?.state).toBe('学习中') // 未被备份的 已掌握 覆盖
    expect(stored?.mastery).toBe(0.5)
  })

  it('导入 learning 目标 kp 不存在于导入题包时忽略（不产生孤儿掌握状态）', async () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')], // 只含 kp1，无 kp999
      learning: [mkLearning('kp999', { next_review: '2099-01-01' })],
      wrongs: [],
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    expect(await dbLearning.get('kp999')).toBeUndefined()
  })

  it('wrong 引用题包真实题目：内嵌 question 不信任，采用题包 canonical 题目', async () => {
    const p1 = mkPack('p1')
    const tampered = { ...p1.questions[0], stem: '被篡改的题干' }
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: p1,
      packs: [p1],
      wrongs: [mkWrong({ question: tampered })], // 备份内嵌题干被篡改
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const all = await (await import('../../db')).dbWrongs.getAll()
    expect(all.length).toBe(1)
    expect(all[0].question.stem).toBe('题干') // 用题包 canonical，非备份篡改值
  })

  it('wrong 引用不存在的题目/题包时忽略，不落库', async () => {
    const p1 = mkPack('p1')
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: p1,
      packs: [p1],
      wrongs: [mkWrong({ packId: 'ghost-pack' })], // 引用的题包不在备份内
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const all = await (await import('../../db')).dbWrongs.getAll()
    expect(all.length).toBe(0)
  })

  it('wrong 引用存在题包但与题包真实题目元数据不一致时用 canonical 题目', async () => {
    const p1 = mkPack('p1')
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: p1,
      packs: [p1],
      // questionId=p1-q1 指向题包中实际存在的题；内嵌 question.source 字段与 canonical 不同（篡改）
      wrongs: [mkWrong({ question: { ...p1.questions[0], explanation: '备份伪造的解析' } })],
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const all = await (await import('../../db')).dbWrongs.getAll()
    expect(all.length).toBe(1)
    expect(all[0].question.explanation).toBe('解析') // canonical 解析覆盖备份伪造
  })

  it('同一备份内重复 KB id 不得互相覆盖（后一条追加而非覆盖前一条）', async () => {
    const kbA = mkKB('kbdup')
    const kbB = { ...mkKB('kbdup'), bodyText: '第二个库', summary: '第二份' }
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      knowledgeBases: [kbA, kbB],
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [])
    await applyImport(plan, { merge: false })
    const all = await dbKB.getAll()
    expect(all.length).toBe(2) // 两个都保留
    expect(all.filter((k) => k.id === 'kbdup')).toHaveLength(1) // 至少一个为原 id
  })

  it('V4-F05：跳过重复题包时预览作答追加数随 merge 变化', async () => {
    await dbPacks.put(mkPack('dup')) // 本机已有 dup
    const answer = { id: 1, packId: 'dup', questionId: 'dup-q1', correct: true, mode: 'quiz' as const, timestamp: 1 }
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('dup'),
      packs: [mkPack('dup')],
      answers: [answer],
    } as unknown as ExportFile
    const plan = buildImportPlan(file, [mkPack('dup')])
    expect(plan.answersViaDupPack).toBe(1)
    expect(plan.answersOrphans).toBe(0)
    const appendedSkip = plan.answers.length - plan.answersOrphans - plan.answersViaDupPack // merge=false
    const appendedMerge = plan.answers.length - plan.answersOrphans // merge=true
    expect(appendedSkip).toBe(0)
    expect(appendedMerge).toBe(1)
    await applyImport(plan, { merge: false })
    expect(await dbAnswers.getAll()).toHaveLength(0) // 跳过重复题包时其作答不写入
  })

  it('跨题包重复 questionId 改为跳过后者（6.83），不再整包拒绝', () => {
    const p1 = mkPack('pa', 'same-q')
    const p2 = mkPack('pb', 'same-q') // 与 pa 题目 id 相同
    const file: ExportFile = { version: 2, type: 'backup', pack: p1, packs: [p1, p2] }
    const { file: safe, skipped } = sanitizeImportDetailed(file)
    expect(safe.packs?.length).toBe(1) // p2 唯一题目被跳过 → 整包跳过
    expect(skipped.questions[0].reason).toContain('ID')
    expect(skipped.packs.map((p) => p.title)).toEqual(['题包 pb'])
  })

  it('wrong.questionId 与内嵌题目 id 不一致改为跳过该错题记录（6.83）', () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      wrongs: [mkWrong({ questionId: 'different-q' })], // questionId 与 question.id=p1-q1 冲突
    } as unknown as ExportFile
    const { file: safe, skipped } = sanitizeImportDetailed(file)
    expect(safe.wrongs).toHaveLength(0)
    expect(skipped.wrongs).toBe(1)
  })
})

describe('6.83：坏题跳过导入（题目级不合法不再整包拒绝）', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
  })

  const rawQ = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    type: 'single',
    stem: `题干${id}`,
    options: ['甲', '乙'],
    answer: '[0]',
    explanation: '解析',
    kp_ids: [],
    difficulty: 1,
    ...over,
  })

  it('一题校验不通过只跳该题，其余照常导入，跳过明细带包名与题号', () => {
    const pack = {
      id: 'p1', title: '外部 AI 包', category: '', source: 'import', meta: {}, chapters: [], created_at: 1,
      questions: [rawQ('q1'), rawQ('q2', { options: [] }), rawQ('q3')],
    }
    const { file, skipped } = sanitizeImportDetailed({ version: 2, type: 'pack', pack } as unknown as ExportFile)
    expect(file.pack?.questions.map((q) => q.id)).toEqual(['q1', 'q3'])
    expect(skipped.questionTotal).toBe(1)
    expect(skipped.questions[0]).toMatchObject({ packTitle: '外部 AI 包', index: 2 })
    expect(skipped.questions[0].reason).toContain('缺少选项')
  })

  it('章节 question_ids 同步剔除被跳过题目（不留悬空引用）', () => {
    const pack = {
      id: 'p1', title: 'T', category: '', source: 'import', meta: {}, created_at: 1,
      chapters: [{ id: 'ch1', title: 'C1', summary: '', knowledge_points: [], question_ids: ['q1', 'q2', 'q3'] }],
      questions: [rawQ('q1'), rawQ('q2', { type: 'ghost' }), rawQ('q3')],
    }
    const { file, skipped } = sanitizeImportDetailed({ version: 2, type: 'pack', pack } as unknown as ExportFile)
    expect(file.pack?.chapters[0].question_ids).toEqual(['q1', 'q3'])
    expect(skipped.questions[0].reason).toContain('题型非法')
  })

  it('全部题目不合法 → 整包跳过，buildImportPlan 不产生该包也不崩溃', () => {
    const pack = {
      id: 'p1', title: '坏包', category: '', source: 'import', meta: {}, chapters: [], created_at: 1,
      questions: [rawQ('q1', { options: [] }), rawQ('q2', { options: [] })],
    }
    const rawFile = { version: 2, type: 'pack', pack } as unknown as ExportFile
    const { file, skipped } = sanitizeImportDetailed(rawFile)
    expect(file.pack).toBeUndefined()
    expect(skipped.packs.map((p) => p.title)).toEqual(['坏包'])
    const plan = buildImportPlan(rawFile, [])
    expect(plan.packs).toHaveLength(0)
    expect(plan.skipped.packs[0].title).toBe('坏包')
  })

  it('空题包（0 题）保持旧行为照常导入，不按坏包处理', () => {
    const pack = { id: 'p1', title: '空包', category: '', source: 'import', meta: {}, chapters: [], questions: [], created_at: 1 }
    const { file, skipped } = sanitizeImportDetailed({ version: 2, type: 'pack', pack } as unknown as ExportFile)
    expect(file.pack?.title).toBe('空包')
    expect(skipped.packs).toHaveLength(0)
  })

  it('备份内嵌错题的题目不合法 → 跳过该错题记录并计数', () => {
    const file: ExportFile = {
      version: 2,
      type: 'backup',
      pack: mkPack('p1'),
      packs: [mkPack('p1')],
      wrongs: [
        {
          questionId: 'q1', packId: 'p1', packTitle: 'T',
          question: rawQ('q1') as never, // 合法（questionId 与内嵌 id 一致）
          wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: 1, createdAt: 1,
        },
        {
          questionId: 'q9', packId: 'p1', packTitle: 'T',
          question: rawQ('q9', { options: [] }) as never, // 内嵌题缺选项 → 该记录跳过
          wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: 1, createdAt: 1,
        },
      ],
    } as unknown as ExportFile
    const { file: safe, skipped } = sanitizeImportDetailed(file)
    expect(safe.wrongs).toHaveLength(1)
    expect(skipped.wrongs).toBe(1)
  })

  it('包内重复题目 ID → 跳过后者，不再整包拒绝', () => {
    const pack = {
      id: 'p1', title: '重复 ID 包', category: '', source: 'import', meta: {}, chapters: [], created_at: 1,
      questions: [rawQ('qx'), rawQ('qx', { stem: '另一题' })],
    }
    const { file, skipped } = sanitizeImportDetailed({ version: 2, type: 'pack', pack } as unknown as ExportFile)
    expect(file.pack?.questions).toHaveLength(1)
    expect(skipped.questionTotal).toBe(1)
    expect(skipped.questions[0].reason).toContain('ID')
  })

  it('判断题缺「正确/错误」选项对 → 自动补默认选项（6.83 补充：外部 judge 不带选项被误拒的治本修复）', () => {
    const pack = {
      id: 'p1', title: '外部判断题包', category: '', source: 'import', meta: {}, chapters: [], created_at: 1,
      // 外部 AI 写的判断题：不带 options（本项目数据模型 judge 要求选项对）
      questions: [{ id: 'q1', type: 'judge', stem: 'Python 变量名可以以下划线开头。', answer: 'true', explanation: '如 _name 合法', kp_ids: [], difficulty: 1 }],
    }
    const { file, skipped } = sanitizeImportDetailed({ version: 2, type: 'pack', pack } as unknown as ExportFile)
    expect(file.pack?.questions[0].options).toEqual(['正确', '错误'])
    expect(skipped.questionTotal).toBe(0)
  })

  it('结构类问题仍整体拒绝：题包数量超上限照旧抛错', () => {
    const packs = Array.from({ length: 201 }, (_, i) => ({
      id: `p${i}`, title: `包${i}`, category: '', source: 'import', meta: {}, chapters: [],
      questions: [rawQ(`q${i}`)], created_at: 1,
    }))
    const file: ExportFile = { version: 2, type: 'backup', pack: packs[0], packs } as unknown as ExportFile
    expect(() => sanitizeImport(file)).toThrow(/题包数量超过上限/)
  })
})
describe('6.84：同名题包查重（外部导入每次生成新 id，按 id 判不出重复）', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
  })

  it('同名不同 id 的导入包 → 标记重复并收编本机既有 id', () => {
    const local = mkPack('p-local')
    const incoming = { ...mkPack('p-new'), title: local.title }
    const file: ExportFile = { version: 2, type: 'pack', pack: incoming } as unknown as ExportFile
    const plan = buildImportPlan(file, [local])
    expect(plan.packs[0].duplicate).toBe(true)
    expect(plan.packs[0].pack.id).toBe('p-local') // 收编本机 id，合并时 put 直接覆盖原记录
  })

  it('非合并模式同名跳过不落库；合并模式覆盖原 id 记录且包数量不变', async () => {
    const local = mkPack('p-local')
    await dbPacks.put(local)
    const incoming = {
      ...mkPack('p-new'),
      title: local.title,
      questions: [{ ...local.questions[0], stem: '覆盖后的新题干' }],
    }
    const file: ExportFile = { version: 2, type: 'pack', pack: incoming } as unknown as ExportFile
    const plan = buildImportPlan(file, await dbPacks.getAll())
    await applyImport(plan, { merge: false })
    let all = await dbPacks.getAll()
    expect(all.length).toBe(1)
    expect(all[0].questions[0].stem).toBe('题干') // 原内容未动
    await applyImport(plan, { merge: true })
    all = await dbPacks.getAll()
    expect(all.length).toBe(1)
    expect(all[0].id).toBe('p-local')
    expect(all[0].questions[0].stem).toBe('覆盖后的新题干') // 内容被覆盖
  })
})

describe('导入章节结构重建（kp id「章节>知识点」前缀 + 头部「章节:」行）', () => {
  // 注：kp id 不能含空格/逗号（parseMarkdown 的 kp_ids 按空白+逗号切分），与导出格式约束一致
  const MD = [
    '学习本名称: 结构测试包', '',
    '分类: 测试', '',
    '章节: 第一章A, 第二章B', '',
    '<!-- title: 结构测试包 -->',
    '<!-- kp: 第一章A>知识点1=知识点1 -->',
    '<!-- kp: 第二章B>知识点2=知识点2 -->', '',
    '=== 第 1 题 ===',
    '题型：单选题',
    '题干：A 章的题',
    '选项：',
    'A. 1',
    'B. 2',
    '答案：A',
    '知识点：第一章A>知识点1',
    '难度：1', '',
    '=== 第 2 题 ===',
    '题型：单选题',
    '题干：B 章的题',
    '选项：',
    'A. 1',
    'B. 2',
    '答案：B',
    '知识点：第二章B>知识点2',
    '难度：1', '',
  ].join('\n')

  it('按前缀 + 章节:行重建多章节，题目归入对应章节', () => {
    const file = parsePackMarkdown(MD)
    const chs = file.pack!.chapters
    expect(chs.map((c) => c.title)).toEqual(['第一章A', '第二章B'])
    expect(chs[0].question_ids).toHaveLength(1)
    expect(chs[1].question_ids).toHaveLength(1)
    const q1 = file.pack!.questions.find((q) => q.id === chs[0].question_ids[0])!
    expect(q1.stem).toBe('A 章的题')
    expect(chs[0].knowledge_points[0].id).toBe('第一章A>知识点1')
  })

  it('导出→导入往返保持章节结构（3.2 往返保真补全）', () => {
    const once = parsePackMarkdown(MD)
    const twice = parsePackMarkdown(exportPackMarkdown(once.pack!))
    expect(twice.pack!.chapters.map((c) => c.title)).toEqual(['第一章A', '第二章B'])
    expect(twice.pack!.chapters.flatMap((c) => c.question_ids)).toHaveLength(2)
  })

  it('无结构信息的外部文件保持现状兜底（不建章）', () => {
    const flat = ['=== 第 1 题 ===', '题型：单选题', '题干：无结构题', '选项：', 'A. 1', 'B. 2', '答案：A', '难度：1'].join('\n')
    const file = parsePackMarkdown(flat)
    expect(file.pack!.chapters).toHaveLength(0)
  })

  it('md 题包不伪造 exportedAt——预览页不显示「导出时间」', () => {
    expect(parsePackMarkdown(MD).exportedAt).toBeUndefined()
  })
})
