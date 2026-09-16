/**
 * onnxruntime-web 共享运行时（wasm 变体直连，替代 transformers.js 内嵌 ort）：
 * - 背景：transformers.js 内嵌 ort.webgpu.bundle，无 WebGPU 沙箱解析 fp32 模型 protobuf 失败
 *   （见 docs/app_bug.md）；本模块用 onnxruntime-web（wasm 变体，实测可解析+推理）。
 * - 直接动态导入 src/assets 下的 ort.min.mjs（wasm 变体）：不 import 'onnxruntime-web'
 *   （node_modules，Vite 预构建后 wasm 后端路径错乱，实测拼出 /src/assets/ortort-wasm...）。
 * - ort 默认 wasmPaths 基于 ort.min.mjs 所在目录（src/assets/），同名 wasm 变体文件放同目录即可命中。
 */
export type OrtTensor = { data: Float32Array | BigInt64Array; dims?: number[] }

export type OrtModule = {
  env: { wasm: { wasmPaths: string } }
  InferenceSession: {
    create(buf: Uint8Array): Promise<OrtSession>
  }
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => OrtTensor
}

export type OrtSession = {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, { data: Float32Array; dims?: number[] }>>
}

export type OrtSessionLike = OrtSession

let ortPromise: Promise<OrtModule> | null = null

export function getOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    // @ts-ignore onnxruntime-web dist 文件无类型声明（运行时导出与包一致）
    ortPromise = import('../../assets/ort.min.mjs') as Promise<OrtModule>
    const m = ortPromise
    // 强制末尾斜杠：Vite 会把字面量改写为无斜杠绝对路径（/src/assets/ort-wasm），ort 拼接文件名
    // 会吞掉分隔符 → /src/assets/ort-wasmort-wasm-*.wasm → SPA 回退 index.html → 实例化报
    // `expected magic word ... found 3c 21 64 6f(<!do`。运行时补斜杠即使被改写也始终正确。
    m.then((mod) => {
      mod.env.wasm.wasmPaths = new URL('../../assets/ort-wasm/', import.meta.url).href
      if (!mod.env.wasm.wasmPaths.endsWith('/')) mod.env.wasm.wasmPaths += '/'
    })
  }
  return ortPromise
}