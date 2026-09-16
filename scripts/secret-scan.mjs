#!/usr/bin/env node
/**
 * V4-S04 密钥扫描门禁（默认 fail-closed）：
 * - 无参数 / `strict`：发布与 CI 门禁。缺 gitleaks 一律判失败（fail-closed），绝不在无扫描下放行。
 * - 可选参数 `optional`：仅供日常非发布开发。本机缺 gitleaks 时仅警告放行；CI（CI=true）仍判失败。
 * - 依次执行工作区扫描（detect）与完整 Git 历史扫描（git --log-opts=--all），任一发现即失败。
 * - 使用自定义 GITLEAKS 环境变量可指定 gitleaks 可执行文件路径。
 *
 * 安装：https://github.com/gitleaks/gitleaks#installing（brew install gitleaks / scoop install gitleaks /
 *   curl -LO https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_<os>_<arch>.tar.gz）
 */
import { spawnSync } from 'node:child_process'

// npm run 在包根目录执行，process.cwd() 即 ai-xue 根；此处扫描范围与 .gitleaks.toml 一致
const sourceDir = process.cwd()

const CI = process.env.CI === 'true' || process.env.CI === '1'
const cmd = process.env.GITLEAKS ?? 'gitleaks'
const OPTIONAL = process.argv.includes('optional')

function installed(cmdName) {
  const probe = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [cmdName],
    { shell: false, encoding: 'utf8' },
  )
  return probe.status === 0
}

if (!installed(cmd)) {
  const hint = '请先安装：https://github.com/gitleaks/gitleaks#installing'
  if (OPTIONAL && !CI) {
    console.warn(`[secret-scan] 未找到 gitleaks（${cmd}），${hint}`)
    console.warn('[secret-scan] optional 模式（日常开发）：本机未安装，本次扫描跳过，仅警告放行。')
    process.exit(0)
  }
  // 缺 gitleaks 一律失败：发布/CI/strict 都不允许「未扫描也成功」（V4-S04）
  console.error(`[secret-scan] 未找到 gitleaks（${cmd}），${hint}`)
  console.error('[secret-scan] 本门禁 fail-closed：缺少 gitleaks 时判定失败。确保 CI 镜像/发布机预装 gitleaks 后再提交/合入。')
  process.exit(1)
}

/** 跑一次 gitleaks，通过返回 true；失败（发现泄露或异常）返回 false 并输出现场 */
function run(label, args) {
  console.log(`[secret-scan] ${label} …`)
  const r = spawnSync(cmd, args, { cwd: sourceDir, shell: false, encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  // gitleaks：0=未发现，1=发现泄露，其他=参数/运行错误
  if (r.status === 0) {
    console.log(`[secret-scan] ${label}：未发现泄露`)
    return true
  }
  console.error(`[secret-scan] ${label}：失败（exit ${r.status}）。请到对应文件/提交移除真实凭证，或用占位假 Key 替代。`)
  return false
}

let ok = true
// 1) 工作区扫描
ok = run('工作区扫描', ['detect', '--source', '.', '--no-banner', '-v']) && ok
// 2) 完整 Git 历史扫描（不被当前 HEAD 遮蔽）；非 Git 目录在严格模式视为门禁未完整覆盖
const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: sourceDir }).status === 0
if (isGit) {
  ok = run('完整 Git 历史扫描', ['git', '--log-opts=--all', '--no-banner', '-v']) && ok
} else if (OPTIONAL && !CI) {
  console.warn('[secret-scan] 当前目录不是 Git 仓库，跳过历史扫描（optional 模式）')
} else {
  console.error('[secret-scan] 当前目录不是 Git 仓库，无法扫描完整提交历史，fail-closed 判失败。请先 git init。')
  ok = false
}

if (!ok) {
  console.error('[secret-scan] 存在密钥泄露风险或扫描未完整覆盖，未通过门禁。')
  process.exit(1)
}
console.log('[secret-scan] 通过。')