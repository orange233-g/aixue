/**
 * embedding 分词器：BPE（Qwen3 系，ByteLevel + Split regex + merges）与 WordPiece（bge/BERT 系）。
 * 忠实复刻 tokenizer.json 语义（NFC 归一化、pre_tokenizer、ByteLevel 字节→字符映射、BPE merges 优先级），
 * 不做近似——直接喂 onnx 模型，id 序列必须与官方 tokenizer 一致才能得到正确向量空间。
 */

/** 统一分词器接口（encode 已按模型 maxTokens 截断，返回 input_ids（不含特殊 token 包装）） */
export interface Tokenizer {
  encode(text: string): number[]
  maxTokens: number
}

/* ============ ByteLevel 字节→可打印字符映射（GPT-2/Qwen 同款，见 transformers 工具函数） ============ */

let BYTE_UNICODE: Map<number, string> | null = null

/** 构建 byte→char 表：可打印 ASCII/扩展区映射自身，其余字节映射到 U+0100 起未占用区（算法见 bytes_to_unicode）。 */
function buildBytesToUnicode(): Map<number, string> {
  const bs: number[] = []
  for (let i = 0x21; i <= 0x7e; i++) bs.push(i) // !  ~
  for (let i = 0xa1; i <= 0xac; i++) bs.push(i) // ¡  ¬
  for (let i = 0xae; i <= 0xff; i++) bs.push(i) // ®  ÿ
  const cs: number[] = [...bs]
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (bs.indexOf(b) < 0) {
      bs.push(b)
      cs.push(0x100 + n++)
    }
  }
  const map = new Map<number, string>()
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCodePoint(cs[i]))
  return map
}

function byteUnicode(): Map<number, string> {
  if (!BYTE_UNICODE) BYTE_UNICODE = buildBytesToUnicode()
  return BYTE_UNICODE
}

/* ============ BPE ============ */

/** Qwen/GPT 风格 pre_tokenizer Split 正则（把 (?i:...) 改为全局 i 标志；\p 需 u 标志） */
const SPLIT_RE = /'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu

/** 按 Split 正则切分出 pre-token（行为 Isolated：整串被匹配，空匹配丢弃） */
function pretokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(SPLIT_RE)) {
    if (m[0]) out.push(m[0])
  }
  return out
}

/** ByteLevel 编码一个 pre-token：UTF-8 每个字节 → byte-char（use_regex:false，全部字节直达） */
function byteLevelEncode(token: string, bt: Map<number, string>): string {
  const bytes = new TextEncoder().encode(token)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bt.get(bytes[i])!
  return out
}

/** BPE 合并：反复取「全局最小 rank 的相邻对」合并最左者，直到无可合并（tiktoken 参考行为）。
 *  base 单字符（byte-char）不参与 rank（get≈Infinity）。返回合并后的 token 字符串列表。
 *  导出供单测用合成数据独立验证合并顺序与 tie-break。 */
export function bytePairMerge(encoded: string, rank: Map<string, number>): string[] {
  const parts: string[] = []
  for (let i = 0; i < encoded.length; i++) parts.push(encoded[i])
  const getRank = (a: string, b: string) => rank.get(a + b) ?? Infinity

  let minRank = Infinity
  for (let i = 0; i < parts.length - 1; i++) {
    const r = getRank(parts[i], parts[i + 1])
    if (r < minRank) minRank = r
  }
  while (minRank !== Infinity && parts.length > 1) {
    let merged = false
    for (let i = 0; i < parts.length - 1; i++) {
      if (getRank(parts[i], parts[i + 1]) === minRank) {
        parts[i] += parts[i + 1]
        parts.splice(i + 1, 1)
        merged = true
        break
      }
    }
    if (!merged) break
    minRank = Infinity
    for (let i = 0; i < parts.length - 1; i++) {
      const r = getRank(parts[i], parts[i + 1])
      if (r < minRank) minRank = r
    }
  }
  return parts
}

/** 构建 Qwen3 通用 BPE 分词器（读 tokenizer.json：model.vocab + model.merges，ByteLevel base） */
export function buildBpeTokenizer(json: unknown, maxTokens: number): Tokenizer {
  const m = (json as { model?: { vocab?: Record<string, number>; merges?: string[] } }).model
  if (!m?.vocab || !Array.isArray(m.merges)) throw new Error('BPE tokenizer.json 缺 model.vocab/merges')

  const vocab = new Map<string, number>(Object.entries(m.vocab))
  const rank = new Map<string, number>()
  for (let i = 0; i < m.merges.length; i++) {
    // 兼容两种 merges 形态：["A","B"] 数组 或 "A B" 字符串（onnx-community 用数组）
    const raw = m.merges[i]
    const a = typeof raw === 'string' ? (raw as string).split(' ')[0] : (raw as string[])[0]
    const b = typeof raw === 'string' ? (raw as string).split(' ')[1] : (raw as string[])[1]
    if (a && b) rank.set(a + b, i)
  }
  const bt = byteUnicode()

  return {
    maxTokens,
    encode(text: string): number[] {
      const norm = text.normalize('NFC')
      const ids: number[] = []
      for (const token of pretokenize(norm)) {
        const merged = bytePairMerge(byteLevelEncode(token, bt), rank)
        for (const piece of merged) {
          if (ids.length >= maxTokens) return ids
          const id = vocab.get(piece)
          // byte_fallback 保证每个 merged piece 都在 vocab（无缝覆盖）；若异常缺失则跳过
          if (id !== undefined) ids.push(id)
        }
      }
      return ids
    },
  }
}

/* ============ WordPiece ============ */

function isCJK(ch: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)
}

/** 构建 BERT 系 WordPiece 分词器（bge 等）：CJK 逐字、英文按词 + ## 子词，包 [CLS]...[SEP]，截到 maxTokens 内 */
export function buildWordPieceTokenizer(json: unknown, maxTokens: number): Tokenizer {
  const m = (json as { model?: { vocab?: Record<string, number> } }).model
  if (!m?.vocab) throw new Error('WordPiece tokenizer.json 缺 model.vocab')
  const vocab = new Map<string, number>(Object.entries(m.vocab))
  const CLS = vocab.get('[CLS]') ?? 101
  const SEP = vocab.get('[SEP]') ?? 102
  const UNK = vocab.get('[UNK]') ?? 100

  return {
    maxTokens,
    encode(text: string): number[] {
      // 预切：CJK 逐字；连续字母数字为词；其余（标点）单字符；空白跳过
      const parts: string[] = []
      let cur = ''
      const flush = () => {
        if (cur) {
          parts.push(cur)
          cur = ''
        }
      }
      for (const ch of text) {
        if (isCJK(ch)) {
          flush()
          parts.push(ch)
        } else if (/[A-Za-z0-9]/.test(ch)) {
          cur += ch
        } else if (/\s/.test(ch)) {
          flush()
        } else {
          flush()
          parts.push(ch)
        }
      }
      flush()

      const ids: number[] = [CLS]
      for (const p of parts) {
        if (ids.length >= maxTokens - 1) break
        if (vocab.has(p)) {
          ids.push(vocab.get(p)!)
          continue
        }
        // WordPiece：贪心最长前缀 + ## 后缀
        let rest = p
        let first = true
        let ok = true
        while (rest && ids.length < maxTokens - 1) {
          let found: string | null = null
          for (let i = rest.length; i > 0; i--) {
            const cand = (first ? '' : '##') + rest.slice(0, i)
            if (vocab.has(cand)) {
              found = cand
              rest = rest.slice(i)
              break
            }
          }
          if (!found) {
            ok = false
            break
          }
          ids.push(vocab.get(found)!)
          first = false
        }
        if (!ok) ids.push(UNK)
      }
      ids.push(SEP)
      return ids
    },
  }
}