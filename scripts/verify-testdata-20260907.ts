/** 校验 20260907 测试数据的结构与关键验收前置条件。 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildImportPlan, parseImport } from '../src/services/io'

const dir = join(process.cwd(), 'testdata', '20260907')
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) failed++
}
const json = (name: string) => parseImport(readFileSync(join(dir, name), 'utf8'))

const nine = buildImportPlan(json('PACK-9T.json'), [])
check('PACK-9T 可解析', nine.packs.length === 1)
check('PACK-9T 恰好九题', nine.packs[0]?.pack.questions.length === 9)
check('PACK-9T 覆盖九种题型', new Set(nine.packs[0]?.pack.questions.map((q) => q.type)).size === 9)
check('PACK-9T 无跳过题', nine.skipped.questionTotal === 0)

const bad = buildImportPlan(json('PACK-BAD.json'), [])
check('PACK-BAD 保留两道合法题', bad.packs[0]?.pack.questions.length === 2)
check('PACK-BAD 记录三道跳过题', bad.skipped.questionTotal === 3)
const badReasons = bad.skipped.questions.map((q) => q.reason).join('|')
check('PACK-BAD 包含缺选项原因', badReasons.includes('缺少选项'))
check('PACK-BAD 包含答案越界原因', badReasons.includes('超出选项范围'))
check('PACK-BAD 包含答案缺失原因', badReasons.includes('答案缺失'))

const backup = buildImportPlan(json('BACKUP-BASE.json'), [])
check('BACKUP-BASE 可解析为完整备份', backup.type === 'backup')
check('BACKUP-BASE 含题包/知识库/学习/错题/作答/用量', backup.packs.length === 1 && backup.knowledgeBases.length === 1 && backup.learning.length === 1 && backup.wrongs.length === 1 && backup.answers.length === 1 && backup.usage.length === 1)
check('BACKUP-BASE 无跳过项', backup.skipped.questionTotal === 0 && backup.skipped.wrongs === 0)

const note = readFileSync(join(dir, 'F-NOTE.txt'), 'utf8')
check('F-NOTE 正文超过 300 字', note.replace(/\s/g, '').length > 300, `${note.replace(/\s/g, '').length} 字`)
check('F-LARGE 约 15MB', statSync(join(dir, 'F-LARGE-15MB.txt')).size === 15 * 1024 * 1024)
check('F-OVER-LIMIT 超过 50MB', statSync(join(dir, 'F-OVER-LIMIT-51MB.txt')).size > 50 * 1024 * 1024)
check('F-INVALID.docx 不是 ZIP 容器', readFileSync(join(dir, 'F-INVALID.docx')).subarray(0, 2).toString('hex') !== '504b')
check('F-INVALID.txt 为空文件', statSync(join(dir, 'F-INVALID.txt')).size === 0)

let allText = ''
for (const name of ['G-BASE.txt', 'G-SUPPLEMENT.txt', 'G-CANCEL.txt', 'G-LONG.txt', 'F-TXT.txt', 'F-MULTI-A.txt', 'F-MULTI-B.txt', 'F-NOTE.txt', 'F-INJECTION.txt']) allText += readFileSync(join(dir, name), 'utf8')
check('测试数据不含 API Key/Authorization 字段', !/(api[_ -]?key|authorization|bearer\s+tp-|sk-[a-z0-9])/i.test(allText))

console.log(failed === 0 ? '\n20260907 测试数据校验通过 ✓' : `\n${failed} 项校验失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
