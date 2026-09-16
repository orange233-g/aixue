/**
 * 6.83：导入预检工具——把外部题包文件（.md 或 .json）灌入导入校验管线，
 * 离线报告哪些题会被跳过、原因是什么、多少题能入库。不写库、不发请求。
 *
 * 用法：npx tsx scripts/check-import.ts <题包文件路径>
 * 背景：合成测试全按本项目数据模型造数据，测不出「外部格式不合约定」类问题
 * （如外部判断题不带「正确/错误」选项对）；用真实外部文件预检才靠得住。
 */
import { readFileSync } from 'node:fs'
import { parseImport, parsePackMarkdown, buildImportPlan } from '../src/services/io'
import type { ExportFile } from '../src/types'

const path = process.argv[2]
if (!path) {
  console.error('用法：npx tsx scripts/check-import.ts <题包文件路径>（.md 或 .json）')
  process.exit(1)
}
const text = readFileSync(path, 'utf-8')
const file: ExportFile = text.trimStart().startsWith('{') ? parseImport(text) : parsePackMarkdown(text)
const plan = buildImportPlan(file, [])
const total = plan.packs.reduce((n, p) => n + p.pack.questions.length, 0)

console.log('=== 导入预检结果（6.83 管线） ===')
console.log(`可入库题数: ${total}`)
for (const { pack, duplicate } of plan.packs) {
  console.log(`  学习本「${pack.title}」${pack.questions.length} 题${duplicate ? '（本机已存在同 ID）' : ''}`)
}
console.log(`跳过题目总数: ${plan.skipped.questionTotal}`)
for (const s of plan.skipped.questions) {
  console.log(`  - 「${s.packTitle}」第 ${s.index} 题: ${s.reason}`)
}
if (plan.skipped.questionTotal > plan.skipped.questions.length) {
  console.log(`  - …其余 ${plan.skipped.questionTotal - plan.skipped.questions.length} 题同样不合法，略列`)
}
for (const p of plan.skipped.packs) {
  console.log(`  整包跳过「${p.title}」: ${p.reason}`)
}
if (plan.skipped.wrongs) console.log(`跳过错题记录: ${plan.skipped.wrongs} 条`)
