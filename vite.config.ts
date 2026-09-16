import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { appendFile, stat, writeFile } from 'fs/promises'
import { copyFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { providerHostSuffixes } from './src/ai/providers/manifest.ts'

// base: './' 保证 Capacitor 通过本地 scheme 加载资源时路径正确
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), noCacheDev(), aiDevProxy(), logDevSink(), cspPlugin(), copyOrtWasm()],
  base: './',
  // V-EMB：onnxruntime-web 不做预构建——预构建后其内部动态 import 的 wasm 后端 URL 带 ?import 参数，
  // 访问 public/ort 文件返回 500（实测 jsep.mjs?import=500）；exclude 后走原生 ESM，动态 import 正常。
  cacheDir: 'node_modules/.vite-cache',
  server: {
    watch: {
      // 项目根目录下的大目录（gradle-cache 5GB+ / model-pack 687MB / dist 763MB）不在 Vite 默认忽略
      // 列表内，chokidar 全量扫描会让 dev server 事件循环被占满（CPU 100%、请求全部超时卡死），
      // 显式排除避免 watcher 扫描这些构建产物/模型缓存目录
      ignored: ['**/gradle-cache/**', '**/model-pack/**', '**/dist/**', '**/node_modules/.vite-cache/**'],
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
    // 6.53 同族（TASK-09 走查发现）：依赖扫描默认递归项目根，会把 gradle-cache/ 里的
    // Gradle javadoc HTML 当入口扫到报错并**跳过预打包**——首载数百模块裸请求极慢、
    // 且首次模块发现触发 full-reload 会杀掉在飞请求。显式限定扫描入口根治。
    entries: ['index.html', 'src/**/*.{ts,tsx}'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // 单测挂 fake-indexeddb（DB 隔离见 src/test/setup.ts）
    setupFiles: ['./src/test/setup.ts'],
    // 生产配置不需要 dev 中间件，串行跑避免共享 DB 名的升级争用
    pool: 'forks',
    testTimeout: 20000,
  },
})

/**
 * 生产 CSP（V2-S09）：Release 构建时注入 index.html，作为「JS 可读 API Key」的最后一道防线——
 * 即使未来出现 XSS/依赖注入，也限制其只能从本应用域内取脚本。
 * - 仅 build 注入：dev 不注入，避免干扰 Vite HMR（@vitejs/plugin-react 的 refresh 预设需 inline script）。
 * - connect-src 用 `https:` scheme 兼容用户可配置的自定义 https 供应商域；http 明文链路已在
 *   normalizeProviderBaseUrl 处被拦截，这里再以 scheme 兜底。不用 `*`，保持对明文的最小闭合。
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

/**
 * 禁止缓存：dev server 对 HTML/JS/CSS 一律返回 no-store，防止内置浏览器用缓存的旧
 * bundle/样式渲染（表现为「改了代码但刷新没变化」）。生产 WebView 不受影响（无本中间件）。
 */
function noCacheDev(): Plugin {
  return {
    name: 'no-cache-dev',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
        // V-EMB：onnxruntime-web 走 SIMD-threaded wasm，需 SharedArrayBuffer，
        // 而 SAB 仅在 cross-origin isolated 页面可用（桌面 Chrome 无 COOP/COEP 头时创建推理 session 失败
        // → 「本地推理引擎加载失败」。dev 下补头让本地语义检索可跑，与生产 WebView 行为对齐）
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        next()
      })
    },
  }
}

/**
 * V-EMB：build 后把 src/assets/ort-wasm/ 复制到 dist/assets/ort-wasm/（ort.min chunk 同目录）。
 * onnxruntime-web 默认 wasmPaths 基于 ort.min 模块 URL（dist/assets/），wasm 必须与其同层，
 * 否则 Capacitor/WebView 里 wasm 404（MuMu 实测 logcat：Unable to open asset URL .../assets/ort-wasm/...）。
 */
function copyOrtWasm(): Plugin {
  return {
    name: 'copy-ort-wasm',
    closeBundle() {
      const srcDir = join(process.cwd(), 'src/assets/ort-wasm')
      const dstDir = join(process.cwd(), 'dist/assets/ort-wasm')
      mkdirSync(dstDir, { recursive: true })
      for (const f of readdirSync(srcDir)) {
        copyFileSync(join(srcDir, f), join(dstDir, f))
      }
      console.log('[copy-ort-wasm] -> dist/assets/ort-wasm/')
    },
  }
}

/**
 * 开发代理：浏览器直连各家模型 API 会触发 CORS 拦截。
 * 此中间件监听 /__ai，把请求体里携带的目标 URL 转发到上游服务，
 * 从而让浏览器在开发环境也能完成 AI 调用（生产走 Capacitor 原生 WebView 直连，无需代理）。
 * 参考橘子工作台 vite.config.ts 实现。
 * 按字节流透传：上游响应体（含 SSE 分片）原样流回浏览器，生题的实时增量不受缓冲影响。
 *
 * 安全（W3a）：
 * - URL 白名单：只允许投递到已知 AI 厂商网关 host（含用户通过本机配置追加的自定义 host），
 *   拒绝 file://、内网地址、裸 IP 等，防 SSRF。/__ai 仅作本机开发代理，宽进窄出会放大风险。
 * - header 过滤：转发到上游前只保留无害的少量请求头（Content-Type / Authorization / Accept / User-Agent），
 *   丢弃浏览器侧注入的 Host / Origin / Referer / Cookie 等逐跳或伪造头。
 */

// 预置厂商之外允许追加的自定义 host：逗号分隔，可用 AIR_PROXY_ALLOW_HOSTS 环境变量注入。
// 均为精确 host（如 my-gw.example.com），与厂商白名单做「host === 项」精确匹配（V3-S02：不再用后缀模糊放行同域子域）。
const EXTRA_ALLOW_HOSTS = (process.env.AI_PROXY_ALLOW_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

/** 已知 AI 厂商网关 host 精确白名单：由 src/ai/providers/manifest.ts 的 defaultBaseUrl 单源推导（V2-I06），
 *  改厂商只需改 manifest 一处；环境变量仍可追加测试域。 */
const ALLOWED_HOSTS: string[] = [...providerHostSuffixes(), ...EXTRA_ALLOW_HOSTS]

/** URL 是否命中代理白名单：仅 http(s) 且 host 精确命中某个白名单项，并拒绝内网/本机环回 */
function isAllowedProxyUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  // 内网 / 环回地址一概拒绝（完整体校验，防 IP 段绕过；host 白名单只对域名开放）
  if (/^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(host)) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
  return ALLOWED_HOSTS.some((h) => h === host)
}

/** 允许转发到上游的请求头（白名单式过滤；Authorization 由 app 在运行时注入，见 aiFetch 调用方） */
const ALLOW_FORWARD_HEADERS = new Set(['content-type', 'authorization', 'accept', 'user-agent'])

// S-05：开发代理加固——限制请求体大小与并发，杜绝持续大 POST 消耗内存；
// 重定向不再默认跟随，改为逐次校验 Location 命中白名单才继续，防开放重定向把请求带向未授权/内网地址。
const MAX_PROXY_BODY = 2 * 1024 * 1024 // 2MB
const MAX_PROXY_CONCURRENT = 8

/** 从浏览器侧请求头里过滤出可安全转发的子集（小写名归一；忽略 Host/Origin/Referer/Cookie 等） */
function filterForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (ALLOW_FORWARD_HEADERS.has(lk) && typeof v === 'string') out[k] = v
  }
  return out
}

/** 递归跟随重定向：每次拿到 3xx 的 Location，先校验是否命中白名单（isAllowedProxyUrl），
 *  通过才继续 fetch，最多 5 跳；任一跳 Location 非法即拒绝。防御「允许域上的开放重定向 → 内网/未授权」SSRF。 */
async function fetchWithSafeRedirects(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    const next = new URL(loc, current).toString()
    if (!isAllowedProxyUrl(next)) {
      const err = new Error(`代理禁止跟随重定向到非白名单地址：${next}`) as Error & { status?: number }
      err.status = 403
      throw err
    }
    current = next
  }
  throw new Error('代理重定向次数超过上限（5 跳）')
}

function aiDevProxy(): Plugin {
  return {
    name: 'ai-dev-proxy',
    configureServer(server) {
      let inFlight = 0
      server.middlewares.use('/__ai', (req, res) => {
        // S-05：只允许 POST（aiFetch 恒定 POST；GET 由浏览器直连上游即可，无需代理）
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'POST')
          res.end(JSON.stringify({ error: { message: 'proxy: 仅允许 POST' } }))
          return
        }
        if (inFlight >= MAX_PROXY_CONCURRENT) {
          res.statusCode = 429
          res.end(JSON.stringify({ error: { message: 'proxy: 代理并发已达上限，请稍后重试' } }))
          return
        }
        inFlight++
        // V4-I02：并发名额必须等到「上游 fetch/SSE 真正结束」才释放，而不是请求体读完就放；
        // 用 released 幂等保护，避免 close(读完)+finally 双释放
        let released = false
        const release = () => {
          if (released) return
          released = true
          inFlight = Math.max(0, inFlight - 1)
        }
        let ended = false
        let data = ''
        let tooBig = false
        req.on('data', (c) => {
          data += c
          if (data.length > MAX_PROXY_BODY) {
            tooBig = true
            req.destroy()
          }
        })
        req.on('error', () => {})
        req.on('close', () => {
          // 请求体未读完客户端就断开（刷新/取消/导航）：不会触发 end，须在此释放名额
          if (!ended) release()
        })
        req.on('end', async () => {
          ended = true
          try {
            if (tooBig) return
            const { method = 'POST', url, headers, body } = JSON.parse(data)
            if (typeof url !== 'string' || !isAllowedProxyUrl(url)) {
              if (!res.headersSent) res.statusCode = 403
              if (!res.headersSent) res.setHeader('Content-Type', 'application/json')
              if (!res.writableEnded) res.end(JSON.stringify({ error: { message: `proxy: 目标地址不在代理白名单内：${url}` } }))
              return
            }
            // V4-I02：断开客户端连接 → abort 上游 fetch/SSE，避免模型资源/配额被长时间占用
            const ac = new AbortController()
            res.on('close', () => {
              if (!res.writableEnded) ac.abort()
            })
            const upstream = await fetchWithSafeRedirects(url, {
              method,
              headers: filterForwardHeaders(headers as Record<string, string>),
              // body 已由 aiFetch 序列化为字符串，直接透传，不能再 JSON.stringify（否则二次序列化会变成带引号的转义字符串，导致上游 400）
              ...(body !== undefined ? { body: body as string } : {}),
              signal: ac.signal,
            })
            if (res.headersSent || res.writableEnded) return
            res.statusCode = upstream.status
            // 透传上游响应头，但排除逐跳头与实体头：Node 已自动解压 body 且按 chunked 流式写，
            // 保留 content-encoding / content-length 会让浏览器按错误方式解码（ERR_CONTENT_DECODING_FAILED）
            const skip = ['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length']
            upstream.headers.forEach((v, k) => {
              const lk = k.toLowerCase()
              if (!skip.includes(lk) && !res.headersSent) res.setHeader(k, v)
            })
            if (upstream.body) {
              await pipeline(Readable.fromWeb(upstream.body as any), res)
            } else if (!res.writableEnded) {
              res.end()
            }
          } catch (err) {
            // 长流式生成（SSE）中客户端中途断开（刷新/取消/导航）会让 pipeline 抛错，
            // 此时 header 可能已发送；必须加守卫再写，否则 ERR_HTTP_HEADERS_SENT 会未捕获崩掉 dev server
            try {
              if (!res.headersSent) res.statusCode = (err as { status?: number }).status ?? 502
              if (!res.headersSent) res.setHeader('Content-Type', 'application/json')
              if (!res.writableEnded) res.end(JSON.stringify({ error: { message: String((err as Error).message) } }))
            } catch {
              /* 连接已终止，忽略写入冲突 */
            }
          } finally {
            release()
          }
        })
      })
    },
  }
}

/**
 * 开发期日志落盘：浏览器里的日志在 localStorage，我在后台读不到；此中间件监听 /__log，
 * 把应用同步上来的日志（数组）按行追加写成本地 run.log（JSONL），
 * 这样排查时我直接读 `wenxue-ai/run.log` 就能翻到用户侧的操作/报错，无需用户复制。
 * 另监听 /__genlog 把「生题每次的模型输出原文 + 结构/拒绝/缺口」写进独立 run-gen.log（JSONL），
 * 便于直接读模型原文分析质量问题（如判断题缺选项）。
 * 仅开发环境生效；生产打包（WebView 无 dev server）由 localStorage + 一键导出兜底。
 */
function logDevSink(): Plugin {
  const logFile = fileURLToPath(new URL('./logs/run.log', import.meta.url))
  const genFile = fileURLToPath(new URL('./logs/run-gen.log', import.meta.url))
  // 生题原文可以很大：单文件超过 4MB 就整体清空重写（该文件只服务「最近一轮排障」，无需长期保留）
  const GEN_FILE_MAX = 4 * 1024 * 1024
  const MAX_LOG_BODY = 5 * 1024 * 1024 // 单次日志上报请求体上限 5MB
  return {
    name: 'log-dev-sink',
    configureServer(server) {
      const sink = (target: string) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        // S-05：日志端点仅收 POST，并把单次请求体限制在 5MB，防页面持续大 POST 填满日志磁盘/内存
        if (req.method !== 'POST' || (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_LOG_BODY)) {
          res.statusCode = 405
          res.end(Number(req.headers['content-length']) > MAX_LOG_BODY ? 'body too large' : 'only POST')
          return
        }
        let data = ''
        let tooBig = false
        req.on('data', (c) => {
          data += c
          if (data.length > MAX_LOG_BODY) {
            tooBig = true
            req.destroy()
          }
        })
        req.on('error', () => {})
        req.on('end', async () => {
          try {
            if (tooBig) return
            const parsed = JSON.parse(data || '[]')
            const list = Array.isArray(parsed) ? parsed : [parsed]
            if (list.length) {
              if (target === genFile) {
                try {
                  const st = await stat(genFile)
                  if (st.size > GEN_FILE_MAX) await writeFile(genFile, '')
                } catch {
                  /* 文件不存在则直接追加 */
                }
              }
              await appendFile(target, list.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
            }
          } catch {
            /* 解析/写入失败不影响 dev server */
          }
          if (!res.headersSent) {
            res.statusCode = 200
            res.end('ok')
          }
        })
      }
      server.middlewares.use('/__log', sink(logFile))
      server.middlewares.use('/__genlog', sink(genFile))
    },
  }
}
