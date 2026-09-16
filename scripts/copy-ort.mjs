/**
 * 构建准备：把 onnxruntime-web 的 wasm 后端文件复制到 src/assets/ort-wasm/（与 ort.min.mjs 同目录）。
 * - 运行时代码依赖（非模型文件）：不入 git（38MB），dev/build 前自动准备
 * - dev：Vite serve src/assets/；build：vite.config 的 closeBundle 钩子把 src/assets/ort-wasm/ 复制到
 *   dist/assets/ort-wasm/（ort.min chunk 同目录）——ort 默认 wasmPaths 基于模块 URL，必须与 ort.min 同层
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'node_modules/onnxruntime-web/dist'
const DST = 'src/assets/ort-wasm'
const NEEDED = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']

mkdirSync(DST, { recursive: true })
const missing = []
for (const name of NEEDED) {
  const src = join(SRC, name)
  try {
    copyFileSync(src, join(DST, name))
  } catch {
    missing.push(name)
  }
}
if (missing.length > 0) {
  console.error(`[prepare-ort] 缺少文件: ${missing.join(', ')}（请确认 node_modules/onnxruntime-web 已安装）`)
  process.exit(1)
}
console.log('[prepare-ort] onnxruntime-web wasm 后端已就绪 → src/assets/ort-wasm/')
