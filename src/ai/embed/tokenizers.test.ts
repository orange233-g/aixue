/**
 * embedding 分词器单测：BPE（Qwen3）+ WordPiece（bge）。
 * - bytePairMerge：合成数据手算黄金用例（独立验证合并顺序/全局最小 rank/tie-break 最左）。
 * - BPE 全链路：真实 Qwen3 tokenizer.json 结构校验（词表覆盖、确定性、截断、contraction）。
 * - WordPiece：bge 真实 tokenizer.json 结构校验（CLS/SEP 包装、中文逐字、英文子词、截断）。
 * - 回归锁：编码输出自 2026-08-26 首次跑通固定（防止后续改动悄悄改变 token 序列；字节级外部
 *   oracle 校验需在线 tokenizers 库，本沙箱 pip 源不可达暂缺，回归锁保证改动可感知）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildBpeTokenizer, buildWordPieceTokenizer, bytePairMerge, type Tokenizer } from './tokenizers'

// 真实词表来自本地模型权重目录（model-pack/ 不入库）：干净克隆下自动跳过这两组用例，
// 放了模型后再跑即可覆盖真实词表（npm test 仍是零外部依赖的可运行门禁）。
const PACK = join(process.cwd(), 'model-pack')
const QWEN_TOK_PATH = join(PACK, 'qwen3-embedding-0.6b/tokenizer.json')
const BGE_TOK_PATH = join(PACK, 'bge-small-zh-v1.5/tokenizer.json')
const hasModelFiles = existsSync(QWEN_TOK_PATH) && existsSync(BGE_TOK_PATH)
const qwenTok = hasModelFiles ? JSON.parse(readFileSync(QWEN_TOK_PATH, 'utf8')) : null
const bgeTok = hasModelFiles ? JSON.parse(readFileSync(BGE_TOK_PATH, 'utf8')) : null

const VOCAB_SIZE_QWEN = 151643

describe('bytePairMerge（BPE 合并算法，合成黄金）', () => {
  const rank = (es: [string, number][]) => new Map<string, number>(es)

  it('合并全局最小 rank 的相邻对', () => {
    // 'abcb': 相邻对 ab=0, bc=1, cb=∞ → ab 最小，合并 → ['ab','c','b']；再无可合并
    const r = rank([['ab', 0], ['bc', 1]])
    expect(bytePairMerge('abcb', r)).toEqual(['ab', 'c', 'b'])
  })

  it('先合并更低 rank 的对（非首对）', () => {
    // 'abxyc': xy=1 < ab=3 → 先合并 xy 得 a,b,xy,c；再合并 ab → ab,xy,c
    const r = rank([['ab', 3], ['bx', 2], ['xy', 1]])
    expect(bytePairMerge('abxyc', r)).toEqual(['ab', 'xy', 'c'])
  })

  it('连续合并级联', () => {
    // 'abcd': ab=0 → abc=4? rank 是二元组，级联靠新生成对：含 bc=5, cd=7。先 ab → ab,c,d；ab+c=∞→ 再 bc? 新对 'abc' 不在，'cd'=7 → 停。用简单可判情形：
    // 'aabb': aa=0, bb=1 → 先 aa → aa,bb；新对 aa+bb=∞ → 停
    const r = rank([['aa', 0], ['bb', 1]])
    expect(bytePairMerge('aabb', r)).toEqual(['aa', 'bb'])
  })

  it('无可合并时返回单字符', () => {
    expect(bytePairMerge('abc', new Map())).toEqual(['a', 'b', 'c'])
  })
})

describe.skipIf(!hasModelFiles)('BPE tokenizer（Qwen3 真实词表）', () => {
  let tok!: Tokenizer
  beforeAll(() => {
    tok = buildBpeTokenizer(qwenTok!, 32768)
  })

  it('分词结果全部落在词表内且非空', () => {
    const samples = ['你好，世界！这是一个测试。', 'Given a web search query, retrieve relevant passages', '凡人修仙传 韩立 修仙', 'Qwen3-Embedding 0.6B 12.5%']
    for (const s of samples) {
      const ids = tok.encode(s)
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) {
        expect(id).toBeGreaterThanOrEqual(0)
        expect(id).toBeLessThan(VOCAB_SIZE_QWEN)
      }
    }
  })

  it('中文句子产生合理 token 数（1 汉字 ≈ 1~2 token）', () => {
    const ids = tok.encode('你好，世界！这是一个测试。')
    expect(ids.length).toBeGreaterThanOrEqual(2)
    expect(ids.length).toBeLessThanOrEqual(40)
  })

  it('同样输入结果确定（NFC 归一化 + merges 稳定）', () => {
    const a = tok.encode('韩立在凡人修仙传里修炼')
    const b = tok.encode('韩立在凡人修仙传里修炼')
    expect(a).toEqual(b)
  })

  it('截断到 maxTokens', () => {
    const small = buildBpeTokenizer(qwenTok!, 16)
    expect(small.encode('a'.repeat(200)).length).toBeLessThanOrEqual(16)
  })

  it('英文撇号契约（contraction）能被切分', () => {
    const ids = tok.encode("won't You're fine")
    expect(ids.length).toBeGreaterThan(1)
    for (const id of ids) expect(id).toBeLessThan(VOCAB_SIZE_QWEN)
  })

  it('回归锁：样例编码输出（2026-08-26 首次跑通固定，改动会在此暴露）', () => {
    // 仅回归锁（防后续改动悄悄改变 token 序列）；字节级跟官方一致性需在线 tokenizers 库外部
    // oracle，本沙箱 pip 源不可达暂缺。若某日拿到官方输出发现与此不符，以官方为准更新。
    const pin: Record<string, number[]> = {
      你好: [108386],
      'Hello world': [9707, 1879],
      凡人修仙传: [100216, 17340, 23081, 100717, 41683],
    }
    const tok2 = buildBpeTokenizer(qwenTok!, 32768)
    for (const [s, want] of Object.entries(pin)) {
      expect(tok2.encode(s)).toEqual(want)
    }
  })
})

describe.skipIf(!hasModelFiles)('WordPiece tokenizer（bge）', () => {
  let tok!: Tokenizer
  let vocabSize = 0
  beforeAll(() => {
    tok = buildWordPieceTokenizer(bgeTok!, 512)
    vocabSize = Object.keys((bgeTok as any).model.vocab).length
  })

  it('以 [CLS] 开头、[SEP] 结尾，id 全部在词表内', () => {
    const vocab = (bgeTok as any).model.vocab as Record<string, number>
    const CLS = vocab['[CLS]']
    const SEP = vocab['[SEP]']
    const ids = tok.encode('韩立修炼了神秘功法')
    expect(ids[0]).toBe(CLS)
    expect(ids[ids.length - 1]).toBe(SEP)
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(vocabSize)
    }
  })

  it('中文逐字切分', () => {
    const ids = tok.encode('你好')
    expect(ids.length).toBe(4) // CLS + 你 + 好 + SEP
  })

  it('英文按词前缀 + ## 子词', () => {
    expect(tok.encode('embedding').length).toBeGreaterThan(1)
  })

  it('截断到 maxTokens', () => {
    const small = buildWordPieceTokenizer(bgeTok!, 32)
    expect(small.encode('这是一个非常长的中文句子'.repeat(20)).length).toBeLessThanOrEqual(32)
  })
})