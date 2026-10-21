// 自动化浏览器持久化 profile 驱动
// 用 launchPersistentContext 固定 userDataDir，使 app 的 localStorage / IndexedDB 跨会话保留。
// 用法：
//   node scripts/persist-browser.mjs            # 打开有头持久化浏览器（默认连 5173）
//   node scripts/persist-browser.mjs --headless # 无头跑
//   node scripts/persist-browser.mjs --port 5174
//   node scripts/persist-browser.mjs --reset    # 清空 profile 后重新打开
//   node scripts/persist-browser.mjs -- run-script.mjs  # 跑一段带 page 的自动化脚本（见文末示例）
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// playwright 是 devDependencies 之一（npm ci 会安装），浏览器内核由 npx playwright install 准备
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(__dirname, '..', '.automation-profile')
const DEV_URL = 'http://localhost:5173/'

const args = process.argv.slice(2)
const headless = args.includes('--headless')
const reset = args.includes('--reset')
let portIdx = args.indexOf('--port')
const port = portIdx >= 0 ? args[portIdx + 1] : '5173'
const autoIdx = args.indexOf('--')
const autoScript = autoIdx >= 0 ? args[autoIdx + 1] : null

// 持久化 profile 目录必须专属，否则会与真实浏览器冲突
if (reset && fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })

console.log(`[persist-browser] profile=${PROFILE}`)
console.log(`[persist-browser] url=${DEV_URL.replace(/:517\d/, ':' + port)} headless=${headless}`)

const context = await chromium.launchPersistentContext(PROFILE, {
  headless,
  viewport: { width: 430, height: 900 },
  args: [
    '--window-size=480,980',
    '--disable-blink-features=AutomationControlled',
    // 把所有缓存都收进 profile 目录，避免写入系统目录（如 NVIDIA DXCache）触发沙箱拦截
    `--disk-cache-dir=${path.join(PROFILE, 'cache').replace(/\\/g, '/')}`,
    '--disable-gpu-shader-disk-cache',
    '--disable-gpu',
    '--disable-features=UseSkiaRenderer',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
})

const page = context.pages()[0] || (await context.newPage())
page.setDefaultTimeout(15000)
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)) })

await page.goto(DEV_URL.replace(/:517\d/, ':' + port))
await page.waitForSelector('#root', { timeout: 15000 }).catch(() => {})
console.log('[persist-browser] 已打开, profile 数据将持久保存。按 Ctrl+C 关闭浏览器。')

// 无携带自动化脚本时保持进程存活，供手动界面交互
if (!autoScript) {
  const shutdown = async () => { await context.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {}) // 常驻
} else {
  // 示例自动化脚本会自动加载：module 需 export default async ({ page, context, PROFILE }) => {}
  const url = pathToFileURL(path.resolve(autoScript)).href
  const mod = await import(url)
  await (mod.default || mod)({ page, context, PROFILE })
  await context.close()
  console.log('[persist-browser] 自动化脚本执行完毕')
}