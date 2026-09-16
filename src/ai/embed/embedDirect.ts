/**
 * 通用 embedding 直连引擎（V-EMB 二期，替代 bgeDirect 单一 bge 硬编码）：
 * - 按模型元数据（registry）分发：tokenizer（wordpiece/bpe）+ weight 文件 + 池化方式（cls/last_token）+ 归一化。
 * - 从 IndexedDB 读模型文件（离线可用），onnxruntime-web wasm 变体直连推理（见 onnx.ts），浏览器/Android WebView/Node 通用。
 * - 批推理：按批 padding 到批内 maxLen（attention_mask 标注），批间降低合并推理开销；向量池化取真实长度尾标。
 */
import { readModelFile } from './storage'
import { getOrt, type OrtSession } from './onnx'
import { buildBpeTokenizer, buildWordPieceTokenizer, type Tokenizer } from './tokenizers'
import type { EmbedModel } from './types'

/** 批内合并推理的文本条数：wordpiece 小模型可合并批；bpe 大模型须跑完整因果 LM（含 KV present 输出），批收紧到 1 防内存爆炸 */
const batchSize = (model: EmbedModel) => (model.tokenizer === 'bpe' ? 1 : 8)

/** URI 是否形如过去 KV 输入 `past_key_values.N.{key,value}`（qwen 系 base-LM ONNX 需要，其余模型不需要） */
const isKvInput = (name: string) => /^past_key_values\.\d+\.(key|value)$/.test(name)

interface LoadedModel {
  sess: OrtSession
  tok: Tokenizer
  /** 当前模型是否需要喂空 past_key_values（从 config.json 读 kv heads/head_dim） */
  kv?: { heads: number; headDim: number }
}

const sessionCache = new Map<string, Promise<LoadedModel>>()

function loadKvMeta(buf: ArrayBuffer): { heads: number; headDim: number } | undefined {
  try {
    const cfg = JSON.parse(new TextDecoder().decode(buf)) as {
      num_key_value_heads?: number
      num_attention_heads?: number
      head_dim?: number
      hidden_size?: number
    }
    const heads = cfg.num_key_value_heads
    const headDim = cfg.head_dim ?? Math.floor((cfg.hidden_size ?? 0) / (cfg.num_attention_heads ?? 1))
    if (heads && headDim) return { heads, headDim }
  } catch {
    /* config 缺字段/解析失败 → 按不需要 KV 处理 */
  }
  return undefined
}

function ensureModel(model: EmbedModel): Promise<LoadedModel> {
  let p = sessionCache.get(model.id)
  if (!p) {
    p = (async () => {
      const [onnxBuf, tokBuf, cfgBuf] = await Promise.all([
        readModelFile(model.id, model.weight),
        readModelFile(model.id, 'tokenizer.json'),
        readModelFile(model.id, 'config.json'),
      ])
      const tokJson = JSON.parse(new TextDecoder().decode(tokBuf))
      const tok =
        model.tokenizer === 'bpe'
          ? buildBpeTokenizer(tokJson, model.maxTokens)
          : buildWordPieceTokenizer(tokJson, model.maxTokens)
      const kv = loadKvMeta(cfgBuf)
      const ort = await getOrt()
      const sess = await ort.InferenceSession.create(new Uint8Array(onnxBuf))
      return { sess, tok, ...(kv ? { kv } : {}) }
    })()
    sessionCache.set(model.id, p)
  }
  return p
}

function l2NormalizeSafe(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const len = Math.sqrt(sum)
  const out = new Float32Array(v.length)
  if (len < 1e-9) return out // 全零（空输入等）→ 零向量，不归一化避免 NaN
  for (let i = 0; i < v.length; i++) out[i] = v[i] / len
  return out
}

/**
 * 批量文本向量化（通用引擎）：读取模型 → 逐批 pading 推理 → 按 pooling 取向量 → 按需 L2 归一化。
 * 返回与 texts 等长的 Float32Array[]。模型未下载/推理失败抛错，由调用方降级 BM25。
 */
export async function runEmbedDirect(model: EmbedModel, texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const { sess, tok, kv } = await ensureModel(model)
  const ort = await getOrt()

  const idLists: number[][] = []
  for (const t of texts) {
    const clean = t.trim()
    // empty/空白 → 用模型特判最小输入（bge 空文给 '。' 有 CLS/SEP 语义；BPE 无 UNK 则给空串，靠 mask=0 + 池化守卫）
    const src = clean || (model.tokenizer === 'wordpiece' ? '。' : '')
    idLists.push(tok.encode(src))
  }

  const hasTokenTypes = sess.inputNames.includes('token_type_ids')
  const hasPositionIds = sess.inputNames.includes('position_ids') // BPE/Qwen 系模型需要显式位置 id，缺了会 `input 'position_ids' is missing`
  const out = new Array<Float32Array>(texts.length)

  const BS = batchSize(model)
  for (let s = 0; s < idLists.length; s += BS) {
    const chunk = idLists.slice(s, s + BS)
    const seqLens = chunk.map((c) => c.length)
    const maxLen = Math.max(1, ...seqLens)
    const B = chunk.length
    const total = B * maxLen

    const inputIds = new BigInt64Array(total)
    const attn = new BigInt64Array(total)
    const tokenTypes = hasTokenTypes ? new BigInt64Array(total) : null
    const positionIds = hasPositionIds ? new BigInt64Array(total) : null
    for (let i = 0; i < B; i++) {
      const ids = chunk[i]
      for (let j = 0; j < ids.length; j++) {
        inputIds[i * maxLen + j] = BigInt(ids[j])
        attn[i * maxLen + j] = 1n
        if (positionIds) positionIds[i * maxLen + j] = BigInt(j) // 真实 token 位置 0..len-1；pad 区置 0（mask 忽略）
      }
    }

    const feeds: Record<string, unknown> = { input_ids: new ort.Tensor('int64', inputIds, [B, maxLen]) }
    if (sess.inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', attn, [B, maxLen])
    if (tokenTypes) feeds.token_type_ids = new ort.Tensor('int64', tokenTypes, [B, maxLen])
    if (positionIds) feeds.position_ids = new ort.Tensor('int64', positionIds, [B, maxLen])
    if (kv) {
      // 因果 LM（qwen 系 base-LM ONNX）：KV 缓存为空（past_len=0），float32 空张量，形状 [B, kv_heads, 0, head_dim]
      for (const inputName of sess.inputNames) {
        if (isKvInput(inputName)) {
          feeds[inputName] = new ort.Tensor('float32', new Float32Array(0), [B, kv.heads, 0, kv.headDim])
        }
      }
    }

    const result = await sess.run(feeds as Record<string, import('./onnx').OrtTensor>)
    const outputName = sess.outputNames[0]
    const data = result[outputName].data as Float32Array
    const dim = Number(result[outputName].dims?.[2] ?? model.dim)

    for (let i = 0; i < B; i++) {
      const len = seqLens[i]
      const rowOff = i * maxLen
      const col = model.pooling === 'last_token' ? rowOff + (len - 1) : rowOff // cls → 行首；last_token → 真实末 token
      const vec = data.slice(col * dim, col * dim + dim)
      out[s + i] = model.normalize ? l2NormalizeSafe(vec) : Float32Array.from(vec)
    }
  }
  return out
}