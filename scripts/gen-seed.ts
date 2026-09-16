/**
 * 生成浏览器预置种子数据（6.93）：把 testdata/ 的题包用 app 解析器转成规范 Pack 记录，
 * 输出 testdata/seed-packs.json——由内置浏览器 evaluate 写入 IndexedDB（ai-xue/packs），
 * 让「学习库」直接有书可测（跳过文件选择；导入路径本身另有用例覆盖）。
 * 运行：npx tsx scripts/gen-seed.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseImport, parsePackMarkdown } from '../src/services/io'
import { sanitizeImport } from '../src/services/io/validate'

const DIR = join(process.cwd(), 'testdata')

const packs: Array<Record<string, unknown>> = []

// md 题包：parse 后过一遍 sanitize，得到与导入后一致的规范 Pack（含判断题自动补选项）
// 覆写固定 id（md 包原 id 为随机 uid，重复运行注入会产生重复记录）
let seedSeq = 0
for (const name of [
  'pack-good-standard.md',
  'pack-external-judge.md',
  'pack-broken.md',
  'pack-xss.md',
  'pack-code.md',
  'pack-weird-name.md',
]) {
  const raw = parsePackMarkdown(readFileSync(join(DIR, name), 'utf-8'))
  const safe = sanitizeImport(raw)
  if (safe.pack) {
    seedSeq += 1
    const fixed = safe.pack as unknown as Record<string, unknown>
    fixed.id = `seed-p-${seedSeq}`
    packs.push(fixed)
  }
}

// json 坏题包：sanitize 后只剩 3 道好题（坏题已在校验层剔除）
{
  const raw = parseImport(readFileSync(join(DIR, 'pack-broken.json'), 'utf-8'))
  const safe = sanitizeImport(raw)
  if (safe.pack) packs.push(safe.pack as unknown as Record<string, unknown>)
}

/* 九题型包（FT-04 全题型覆盖）：每种题型一题，题目挂 kp-review-1..4 供复习队列关联 */
{
  const kp = (n: number) => [`kp-review-${n}`]
  const allTypes = {
    version: 2,
    type: 'pack',
    pack: {
      id: 'p-all-types',
      title: '九题型全覆盖练习',
      category: '测试',
      source: 'import',
      meta: { difficulty: '简单', types: ['单选题', '多选题', '判断题', '填空题', '匹配题', '排序题', '简答题', '案例分析', '论文题'], source: '测试数据', version: '1.0', formatVersion: '1.0' },
      chapters: [],
      created_at: 1,
      questions: [
        { id: 'qt-single', type: 'single', stem: '海洋中最小的浮游生物类群是？', options: ['浮游植物', '鲸', '海龟', '鲨鱼'], answer: '[0]', explanation: '浮游植物是海洋食物链的基础。', kp_ids: kp(1), difficulty: 1 },
        { id: 'qt-multiple', type: 'multiple', stem: '下列哪些属于海洋保护行动？（多选）', options: ['建立海洋保护区', '增加塑料倾倒', '执行休渔制度', '过度捕捞'], answer: '[0,2]', explanation: '休渔与保护区是保护措施；增加倾倒与过度捕捞是威胁。', kp_ids: kp(1), difficulty: 2 },
        { id: 'qt-judge', type: 'judge', stem: '珊瑚白化是珊瑚排出共生虫黄藻导致的。', options: ['正确', '错误'], answer: 'true', explanation: '温度升高使珊瑚排出虫黄藻而白化。', kp_ids: kp(2), difficulty: 1 },
        { id: 'qt-fill', type: 'fill', stem: '海洋食物链的基础是______。', answer: '浮游植物', explanation: '浮游植物通过光合作用固定能量。', kp_ids: kp(2), difficulty: 1 },
        {
          id: 'qt-match', type: 'match', stem: '将海洋动物与其特征配对。',
          options: ['蓝鲸', '抹香鲸', '大王乌贼'],
          answer: '{"right":["滤食磷虾","深海捕食乌贼","动物界最大眼睛"],"pairs":[[0,0],[1,1],[2,2]]}',
          explanation: '蓝鲸滤食磷虾；抹香鲸深潜捕乌贼；大王乌贼眼睛最大。',
          kp_ids: kp(3), difficulty: 2,
        },
        { id: 'qt-order', type: 'order', stem: '按食物链能量传递顺序排列（从基础到顶级）。', options: ['浮游植物', '浮游动物', '小型鱼类', '大型掠食者'], answer: '[0,1,2,3]', explanation: '能量沿食物链逐级传递。', kp_ids: kp(3), difficulty: 2 },
        { id: 'qt-short', type: 'short', stem: '简述珊瑚白化的原因。', answer: '海水温度升高导致珊瑚排出共生虫黄藻，失去色彩与主要能量来源。', explanation: '共生虫黄藻离开后珊瑚面临饥饿与死亡风险。', kp_ids: kp(4), difficulty: 2 },
        { id: 'qt-case', type: 'case', stem: '案例：某海湾三年内珊瑚覆盖从 40% 降至 8%，同期水温上升 1.5°C、沿岸旅游与排污增加。请分析主要原因并提出两条保护建议。', answer: '主因：水温上升引发大规模白化；沿岸排污与旅游破坏。建议：设立海洋保护区、控制排污与旅游承载量。', explanation: '白化与人为干扰叠加导致覆盖骤降。', kp_ids: kp(4), difficulty: 3 },
        { id: 'qt-essay', type: 'essay', stem: '以「海洋与人类未来」为题写一篇短文（要点：海洋生态价值、当前威胁、个人行动）。', answer: '要点覆盖即可：海洋提供氧气与食物、面临污染与变暖、个人可减塑与支持保护。', explanation: '开放性题目，按要点给分。', kp_ids: kp(4), difficulty: 3 },
      ],
    },
    exportedAt: 1,
  }
  const safe = sanitizeImport(allTypes as never)
  if (safe.pack) packs.push(safe.pack as unknown as Record<string, unknown>)
}

/* 章节树包（FT-03-01 章节树展开）：3 章 × 知识点 + question_ids */
{
  const chaptersPack = {
    version: 2,
    type: 'pack',
    pack: {
      id: 'p-chapters',
      title: '章节树测试本',
      category: '测试',
      source: 'import',
      meta: { difficulty: '简单', types: ['单选题', '判断题'], source: '测试数据', version: '1.0', formatVersion: '1.0' },
      chapters: [
        {
          id: 'ch-1', title: '第一章 海洋生态', summary: '生态系统基础',
          knowledge_points: [{ id: 'kp-ch-1', title: '食物链基础', content: '能量沿食物链传递', examples: [], pitfalls: [] }],
          question_ids: ['qc-1', 'qc-2'],
        },
        {
          id: 'ch-2', title: '第二章 深海世界', summary: '深海生物',
          knowledge_points: [{ id: 'kp-ch-2', title: '化学合成', content: '热泉生态系统', examples: [], pitfalls: [] }],
          question_ids: ['qc-3', 'qc-4'],
        },
        {
          id: 'ch-3', title: '第三章 保护行动', summary: '海洋保护',
          knowledge_points: [{ id: 'kp-ch-3', title: '保护区', content: '海洋保护区建设', examples: [], pitfalls: [] }],
          question_ids: ['qc-5'],
        },
      ],
      created_at: 1,
      questions: [
        { id: 'qc-1', type: 'single', stem: '第一章题：海洋食物链的基础是？', options: ['浮游植物', '鲸'], answer: '[0]', explanation: '浮游植物固定能量。', kp_ids: ['kp-ch-1'], difficulty: 1 },
        { id: 'qc-2', type: 'judge', stem: '第一章题：能量传递效率约为 10%。', options: ['正确', '错误'], answer: 'true', explanation: '逐级约 10%。', kp_ids: ['kp-ch-1'], difficulty: 1 },
        { id: 'qc-3', type: 'single', stem: '第二章题：深海热泉的能量来源是？', options: ['化学合成', '光合作用'], answer: '[0]', explanation: '硫化物氧化细菌。', kp_ids: ['kp-ch-2'], difficulty: 1 },
        { id: 'qc-4', type: 'judge', stem: '第二章题：大王乌贼的眼睛是动物界最大的。', options: ['正确', '错误'], answer: 'true', explanation: '直径可达 27 厘米。', kp_ids: ['kp-ch-2'], difficulty: 1 },
        { id: 'qc-5', type: 'judge', stem: '第三章题：建立海洋保护区有助于生态恢复。', options: ['正确', '错误'], answer: 'true', explanation: '保护区是核心保护手段。', kp_ids: ['kp-ch-3'], difficulty: 1 },
      ],
    },
    exportedAt: 1,
  }
  const safe = sanitizeImport(chaptersPack as never)
  if (safe.pack) packs.push(safe.pack as unknown as Record<string, unknown>)
}

/* 复习到期数据（FT-06）：4 条今日到期（挂九题型包的 kp）+ 1 条未到期（不进队列） */
{
  const today = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const yesterday = new Date(today.getTime() - 86400000)
  const mk = (kpId: string, nextReview: string, state: '学习中' | '基本掌握') => ({
    kp_id: kpId, mastery: 0.4, state, interval_days: 1, next_review: nextReview,
    wrong_count: 1, last_result: 'wrong', recent: [false],
  })
  const learning = [
    mk('kp-review-1', iso(yesterday), '学习中'),
    mk('kp-review-2', iso(yesterday), '学习中'),
    mk('kp-review-3', iso(today), '学习中'),
    mk('kp-review-4', iso(today), '学习中'),
    { kp_id: 'kp-review-late', mastery: 0.9, state: '已掌握', interval_days: 30, next_review: '2099-01-01', wrong_count: 0, last_result: 'correct', recent: [true] },
  ]
  writeFileSync(join(DIR, 'seed-learning.json'), JSON.stringify(learning, null, 1))
  console.log(`✓ 已生成 ${learning.length} 条复习状态（4 条今日到期）→ seed-learning.json`)
}

const out = join(DIR, 'seed-packs.json')
writeFileSync(out, JSON.stringify(packs, null, 1))
console.log(`✓ 已生成 ${packs.length} 个种子学习本 → ${out}`)
for (const p of packs) {
  console.log(`  - ${String(p.title)}（${(p.questions as unknown[]).length} 题）`)
}
