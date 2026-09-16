/**
 * V3-I01：android:release 构建前的轻量环境前置检查。
 * 在 Web 构建 / cap sync 之前先定位 Java、Android SDK 与 release keystore，
 * 给出明确可执行的信息，而不是让用户在大段 Gradle 日志里猜环境缺失。
 *
 * 仅检查并输出诊断；除「release 缺少正式 keystore」外都只告警不强制失败
 * （Gradle 可能通过 local.properties / 系统级配置正常找到 SDK）。
 * 退出码：0 通过；1 release keystore 缺失（硬失败）；2 其它配置缺失（告警）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let problems = 0

function note(level, msg) {
  const tag = level === 'ok' ? '  OK' : level === 'warn' ? ' WARN' : 'FAIL'
  problems += level === 'fail' ? 2 : 0
  if (level !== 'ok') problems += 0
  console.log(`[${tag}] ${msg}`)
}

// ---- Java：优先 JAVA_HOME，其次 PATH 上的 java ----
const javaHome = process.env.JAVA_HOME
if (javaHome) {
  if (existsSync(javaHome)) {
    note('ok', `JAVA_HOME 有效：${javaHome}`)
  } else {
    note('warn', `JAVA_HOME 指向不存在的目录：${javaHome}（若本机另有 JDK，请先修正该环境变量）`)
  }
} else {
  note('warn', 'JAVA_HOME 未设置（依赖 PATH 上的 java / Gradle 自动探测）')
}
{
  const jv = spawnSync('java', ['-version'], { encoding: 'utf8' })
  if (jv.status === 0) {
    const m = /version "?(\d+)/.exec(jv.stderr + jv.stdout)
    const v = m ? m[1] : '?'
    if (+v >= 17) note('ok', `java ${v}（>=17，满足 AGP）`)
    else note('warn', `java ${v} 低于 17，AGP 可能要求更高版本`)
  } else {
    note('warn', 'PATH 上未找到可用的 java 命令')
  }
}

// ---- Android SDK：环境变量或 android/local.properties ----
const sdkEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || ''
const lp = join(root, 'android', 'local.properties')
let sdkDir = sdkEnv
if (!sdkDir && existsSync(lp)) {
  const m = /^\s*sdk\.dir=(.*)$/m.exec(readFileSync(lp, 'utf8'))
  if (m) sdkDir = m[1].replace(/\\([:/\\])/g, '$1')
}
if (sdkDir && existsSync(sdkDir)) {
  note('ok', `Android SDK：${sdkDir}`)
  const platforms = join(sdkDir, 'platforms')
  if (!existsSync(join(platforms, 'android-36'))) {
    note('warn', `SDK 平台 android-36 未安装（compileSdk=36），Android Studio 可自动下载`)
  }
} else {
  note('warn', '未定位 Android SDK（ANDROID_HOME/ANDROID_SDK_ROOT 或 android/local.properties 均无有效目录）')
}

// ---- compile/target/min SDK 支持范围 ----
try {
  const vg = readFileSync(join(root, 'android', 'variables.gradle'), 'utf8')
  const g = (k) => {
    const m = new RegExp(`${k}\\s*=\\s*(['\"]?)([\\w.-]+)\\1`).exec(vg)
    return m ? m[2] : '?'
  }
  console.log(`[INFO] 支持：compile/target SDK ${g('compileSdkVersion')}/${g('targetSdkVersion')}，min SDK ${g('minSdkVersion')}`)
} catch {
  /* 读取失败不影响主检查 */
}

// ---- release 签名：android:release 的硬性前置（V4-S01 补全密码/别名）----
// 该脚本仅由 android:release 入口调用，不受个人/debug 构建影响，故可在此强制执行完整签名要素。
const keystorePath = getKey('WENXUE_KEYSTORE_PATH')
const storePass = getKey('WENXUE_KEYSTORE_PASS')
const alias = getKey('WENXUE_KEY_ALIAS')
const keyPass = getKey('WENXUE_KEY_PASS')

if (keystorePath && existsSync(keystorePath)) {
  note('ok', `release keystore 存在：${keystorePath}`)
} else if (keystorePath) {
  note('fail', `release keystore 路径不存在：${keystorePath}`)
} else {
  note(
    'fail',
    '未配置 WENXUE_KEYSTORE_PATH。android:release 已 fail-closed：缺少正式 keystore 时 Gradle 会直接失败，不会用 debug 签名冒充 release。个人自装请用 android:personal（debug 签名），正式发布请提供 keystore 路径/密码/别名。'
  )
}
// 只有提供了 keystore 时才进一步校验密码/别名；完全没有 keystore 时上面已 fail。
if (keystorePath && existsSync(keystorePath)) {
  if (!storePass) note('fail', '缺少 WENXUE_KEYSTORE_PASS（keystore 存储密码）')
  else note('ok', 'WENXUE_KEYSTORE_PASS 已配置')
  if (!alias) note('fail', '缺少 WENXUE_KEY_ALIAS（keystore 密钥别名）')
  else note('ok', 'WENXUE_KEY_ALIAS 已配置')
  if (!keyPass) note('fail', '缺少 WENXUE_KEY_PASS（密钥密码）')
  else note('ok', 'WENXUE_KEY_PASS 已配置')
}

// 从 gradle.properties 读取同名键（keyname 或 keyname=value）
function getKey(name) {
  if (process.env[name]) return process.env[name]
  const gp = join(root, 'android', 'gradle.properties')
  if (!existsSync(gp)) return ''
  const m = new RegExp(`(?:^|\\n)${name}\\s*=\\s*(.+)`, 'm').exec(readFileSync(gp, 'utf8'))
  return m ? m[1].trim() : ''
}

if (problems > 0) {
  console.error('\n[ERROR] 仍有缺失项，请按上面 FAIL 提示修正后重试。')
  process.exit(1)
}
console.log('\n[OK] Android Release 前置检查通过。')
process.exit(0)