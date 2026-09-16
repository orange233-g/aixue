import 'fake-indexeddb/auto'
import { resetDB, clearAllStores, dbPacks, dbLearning, dbWrongs, dbUsage } from '../src/db'
import {
  exportPack,
  exportBackup,
  parseImport,
  buildImportPlan,
  applyImport,
  exportPackMarkdown,
  parsePackMarkdown,
} from '../src/services/io'
import type { ExportFile, LearningState, Pack, Question, WrongRecord } from '../src/types'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

function mkQ(id: string, kpId: string): Question {
  return { id, type: 'single', stem: `${id} 题干`, options: ['A', 'B', 'C', 'D'], answer: '[0]', explanation: '解析', kp_ids: [kpId], difficulty: 1 }
}

function mkPack(id: string, title: string): Pack {
  return {
    id, title, category: '', source: 'ai', meta: { difficulty: 'auto', objectives: [] },
    chapters: [{ id: `c${id}`, title: '章', summary: '', knowledge_points: [{ id: `k${id}`, title: '点', content: '', examples: [], pitfalls: [] }], question_ids: [`q${id}`] }],
    questions: [mkQ(`q${id}`, `k${id}`)], created_at: Date.now(),
  }
}

function mkLearning(kpId: string): LearningState {
  return { kp_id: kpId, mastery: 0.5, state: '学习中', interval_days: 1, next_review: '2026-08-16', wrong_count: 1, last_result: 'wrong', recent: [false, true] }
}

function mkWrong(packId: string, packTitle: string, questionId: string): WrongRecord {
  const q = mkQ(questionId, `k${questionId}`)
  return { questionId, packId, packTitle, question: q, wrongCount: 1, correctStreak: 0, mastered: false, lastWrongAt: Date.now(), createdAt: Date.now() }
}

async function fresh() {
  resetDB()
  await clearAllStores()
}

async function run() {
  console.log('—— 导出格式 ——')
  const packA = mkPack('pa', '题包A')
  const packB = mkPack('pb', '题包B')
  const packJson = exportPack(packA)
  const packFile = JSON.parse(packJson) as ExportFile
  assert(packFile.version === 1 && packFile.type === 'pack', '题包导出 version=1 type=pack')
  assert(packFile.pack.id === 'pa' && packFile.pack.questions.length === 1, '题包导出包含题包本体')
  assert(packFile.learning === undefined && packFile.wrongs === undefined, '题包导出不含学习数据')

  const ls = [mkLearning('kpa'), mkLearning('kpb')]
  const wrongs = [mkWrong('pa', '题包A', 'qa1'), mkWrong('pb', '题包B', 'qb1')]
  const usage = [{ id: 1, module: 'generate', providerId: 'deepseek', model: 'deepseek-chat', inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 0, cacheMissTokens: 150, cost: 0.001, timestamp: Date.now() }]
  const backupJson = exportBackup([packA, packB], ls, wrongs, usage)
  const backupFile = JSON.parse(backupJson) as ExportFile
  assert(backupFile.type === 'backup' && backupFile.packs?.length === 2, '完整备份 type=backup 含全部题包')
  assert(backupFile.learning?.length === 2 && backupFile.wrongs?.length === 2 && backupFile.usage?.length === 1, '完整备份含学习/错题/用量')
  assert(backupFile.exportedAt !== undefined, '完整备份含导出时间戳')

  console.log('—— parseImport 校验 ——')
  assert(parseImport(packJson).type === 'pack', '合法题包文件解析通过')
  assert(parseImport(backupJson).type === 'backup', '合法备份文件解析通过')
  let threw = false
  try { parseImport('{bad json') } catch { threw = true }
  assert(threw, '非 JSON 抛错')
  threw = false
  try { parseImport(JSON.stringify({ version: 2, type: 'pack', pack: packA })) } catch (e) { threw = (e as Error).message.includes('版本') }
  assert(threw, '版本不兼容抛错并提示')
  threw = false
  try { parseImport(JSON.stringify({ version: 1, type: 'unknown', pack: packA })) } catch { threw = true }
  assert(threw, '类型无效抛错')
  threw = false
  try { parseImport(JSON.stringify({ version: 1, type: 'pack', pack: { id: 'x' } })) } catch { threw = true }
  assert(threw, '题包数据缺失抛错')
  threw = false
  try { parseImport(JSON.stringify({ version: 1, type: 'backup', pack: packA })) } catch { threw = true }
  assert(threw, 'backup 缺少题包列表抛错')

  console.log('—— buildImportPlan 重复检测 ——')
  const existing = [packA]
  const plan1 = buildImportPlan(packFile, existing)
  assert(plan1.packs.length === 1 && plan1.packs[0].duplicate === true, '重复题包标记 duplicate')
  const plan2 = buildImportPlan(packFile, [])
  assert(plan2.packs[0].duplicate === false, '新题包不标记重复')
  const plan3 = buildImportPlan(backupFile, existing)
  assert(plan3.packs.length === 2 && plan3.packs[0].duplicate === true && plan3.packs[1].duplicate === false, '备份计划逐题包检测重复')

  console.log('—— applyImport 合并/跳过 ——')
  await fresh()
  await dbPacks.put(packA)
  const r1 = await applyImport(plan1, { merge: true })
  assert(r1.imported === 1 && r1.skipped === 0, '合并模式导入重复题包')
  const storedA = await dbPacks.get('pa')
  assert(storedA?.id === 'pa', '合并后题包存在')

  await fresh()
  await dbPacks.put(packA)
  const r2 = await applyImport(plan1, { merge: false })
  assert(r2.imported === 0 && r2.skipped === 1, '跳过模式不导入重复题包')
  assert((await dbPacks.get('pa'))?.title === '题包A', '跳过保留现有题包')

  console.log('—— applyImport 备份导入写入学习数据 ——')
  await fresh()
  const r3 = await applyImport(plan3, { merge: false })
  assert(r3.imported === 1 && r3.skipped === 1, '备份导入：pa 跳过、pb 导入')
  assert((await dbPacks.get('pb'))?.title === '题包B', 'pb 已写入')
  assert(!(await dbPacks.get('pa')), 'pa 未写入（跳过）')
  const learningAll = await dbLearning.getAll()
  assert(learningAll.length === 1 && learningAll[0].kp_id === 'kpb', '仅导入关联题包的学习记录，无孤儿数据')
  const wrongsAll = await dbWrongs.getAll()
  assert(wrongsAll.length === 1 && wrongsAll[0].packId === 'pb', '仅导入关联题包的错题')
  const usageAll = await dbUsage.getAll()
  assert(usageAll.length === 1, '用量记录全部导入')

  await fresh()
  await dbPacks.put(packA)
  const r4 = await applyImport(plan3, { merge: true })
  assert(r4.imported === 2 && r4.skipped === 0, '备份导入全合并')
  const learningAll2 = await dbLearning.getAll()
  assert(learningAll2.length === 2, '合并模式导入全部学习记录')

  console.log('—— Markdown 元数据往返 ——')
  const mdPack: Pack = {
    id: 'pmd',
    title: 'Python基础学习',
    category: '程序语言/Python',
    source: 'import',
    description: '用于Python基础学习和练习。',
    meta: {
      difficulty: '简单',
      objectives: ['基础语法', '数据类型', '流程控制'],
      tags: ['Python', '编程', '入门'],
      types: ['单选题', '判断题'],
      source: '用户整理',
      version: '1.0',
      formatVersion: '1.0',
    },
    chapters: [
      { id: 'c1', title: '基础语法', summary: '', knowledge_points: [{ id: 'kp1', title: '变量与赋值', content: '', examples: [], pitfalls: [] }], question_ids: ['q1'] },
    ],
    questions: [
      { id: 'q1', type: 'single', stem: 'GIL 是什么？', options: ['全局解释器锁', '垃圾回收', '字节码', '生成器'], answer: '[0]', explanation: 'GIL 是全局解释器锁。', kp_ids: ['kp1'], difficulty: 1 },
    ],
    created_at: 1,
  }
  const md = exportPackMarkdown(mdPack)
  assert(md.includes('题包名称: Python基础学习'), 'md 可读块含题包名称')
  assert(md.includes('格式版本: 1.0') && md.includes('<!-- format-version: 1.0 -->'), 'md 含格式版本可读块与注释块')
  const parsedMd = parsePackMarkdown(md)
  const p = parsedMd.pack
  assert(parsedMd.type === 'pack', '解析成功且为 pack 类型')
  assert(p.title === 'Python基础学习', '往返：题包名称')
  assert(p.category === '程序语言/Python', '往返：分类')
  assert(p.description === '用于Python基础学习和练习。', '往返：简介')
  assert(p.meta.difficulty === '简单', '往返：难度')
  assert(p.meta.source === '用户整理', '往返：来源')
  assert(p.meta.version === '1.0' && p.meta.formatVersion === '1.0', '往返：版本/格式版本')
  assert(JSON.stringify(p.meta.tags) === JSON.stringify(['Python', '编程', '入门']), '往返：标签')
  assert(JSON.stringify(p.meta.types) === JSON.stringify(['单选题', '判断题']), '往返：题型')
  assert(p.meta.objectives.includes('数据类型'), '往返：章节(目录)')
  assert(p.questions.length === 1 && p.questions[0].answer === '[0]', '往返：题目与答案')
  assert(p.chapters[0]?.knowledge_points[0]?.title === '变量与赋值', '往返：知识点')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('测试运行异常:', e)
  process.exit(1)
})
