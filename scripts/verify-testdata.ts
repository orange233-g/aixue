/**
 * 校验 testdata/ 下题包能被 app 解析器按预期处理（6.93）。
 * 运行：npx tsx scripts/verify-testdata.ts
 * 覆盖：标准导入 / 判断题自动补选项（sanitize 后） / md 与 json 双路径坏题跳过明细 /
 *       XSS 原文保留 / 代码围栏保留 / 导出文件名净化。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseImport, parsePackMarkdown, buildImportPlan } from '../src/services/io'
import { sanitizeFileName } from '../src/utils'

const DIR = join(process.cwd(), 'testdata')
let failed = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}

function loadMd(name: string) {
  const file = parsePackMarkdown(readFileSync(join(DIR, name), 'utf-8'))
  return { file, plan: buildImportPlan(file, []) }
}

function loadJson(name: string) {
  const file = parseImport(readFileSync(join(DIR, name), 'utf-8'))
  return { file, plan: buildImportPlan(file, []) }
}

/* 1. 标准包：3 题全入库 */
{
  const { plan } = loadMd('pack-good-standard.md')
  check('标准包：3 题全部可入库', plan.packs[0]?.pack.questions.length === 3 && plan.skipped.questionTotal === 0)
}

/* 2. 外部风格判断题：自动补「正确/错误」选项对（发生在 sanitize 层，取计划内题目验证） */
{
  const { plan } = loadMd('pack-external-judge.md')
  const q = plan.packs[0]?.pack.questions ?? []
  check('外部判断题：2 题全入库（0 跳过）', q.length === 2 && plan.skipped.questionTotal === 0)
  check(
    '外部判断题：sanitize 后自动补「正确/错误」选项对',
    q.length === 2 && q.every((x) => x.options?.[0] === '正确' && x.options?.[1] === '错误'),
  )
}

/* 3a. 坏题包 md 路径：仅缺选项 1 条进明细，3 道好题入库（题型非法/缺答案在解析层被丢弃） */
{
  const { plan } = loadMd('pack-broken.md')
  const s = plan.skipped
  check('坏题md：恰好 1 条跳过明细（缺选项）', s.questionTotal === 1 && s.questions[0]?.reason.includes('缺少选项'))
  check('坏题md：3 道好题正常入库', plan.packs[0]?.pack.questions.length === 3)
}

/* 3b. 坏题包 json 路径：三种跳过原因齐全（缺选项/题型非法/答案缺失），3 道好题入库 */
{
  const { plan } = loadJson('pack-broken.json')
  const s = plan.skipped
  const reasons = s.questions.map((x) => x.reason).join(' | ')
  check('坏题json：恰好 3 条跳过明细', s.questionTotal === 3)
  check('坏题json：明细含「缺少选项」', reasons.includes('缺少选项'))
  check('坏题json：明细含「题型非法」', reasons.includes('题型非法'))
  check('坏题json：明细含「答案缺失」', reasons.includes('答案缺失'))
  check('坏题json：3 道好题正常入库', plan.packs[0]?.pack.questions.length === 3)
}

/* 4. XSS 包：原文保留（转义交给渲染层） */
{
  const { file } = loadMd('pack-xss.md')
  const q = file.pack?.questions ?? []
  const stem = q[0]?.stem ?? ''
  check('XSS 包：2 题入库', q.length === 2)
  check('XSS 包：题干保留 <script> 原文（供渲染层转义）', stem.includes("<script>alert('题干xss')</script>"))
  check('XSS 包：选项保留 <img onerror> 原文', (q[0]?.options ?? []).some((o) => o.includes('onerror')))
}

/* 5. 代码题包：多行代码围栏保留 */
{
  const { file } = loadMd('pack-code.md')
  const stem = file.pack?.questions?.[0]?.stem ?? ''
  check('代码包：2 题入库', (file.pack?.questions?.length ?? 0) === 2)
  check('代码包：题干保留 ```python 围栏与换行', stem.includes('```python') && stem.includes('\n'))
}

/* 6. 特殊文件名：导出名净化 */
{
  const { file } = loadMd('pack-weird-name.md')
  const raw = file.pack?.title ?? ''
  const safe = sanitizeFileName(raw)
  check('怪名包：导入标题原样保留', raw.includes('CON'))
  check('怪名包：导出文件名被净化（无非法字符、非保留名、限长）', !/[\\/:*?"<>|]/.test(safe) && !/^con\./i.test(safe) && safe.length > 0)
  console.log(`   净化结果示例: ${safe.slice(0, 30)}…`)
}

console.log(failed === 0 ? '\n全部校验通过 ✓' : `\n${failed} 项校验失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
