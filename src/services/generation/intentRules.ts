import { MAX_QUESTIONS_PER_GENERATION, QUESTION_TYPES } from '../../types'
import type { QuestionTypeId } from '../../types'
/**
 * 生题参数的纯规则判定集：不依赖任何 AI 网关联调，全部为确定性纯函数，可独立单测。
 * （V2 控制器负责聊天/生题语义，规则层只提取本地明确指令与参数锚点：
 *  hasExplicitGenIntent 负责「明确出题词」、isGenSpecReply 负责「数字+道/题」的承接规格、
 *  其余 is* 负责取消、调整和结构参数识别。）
 *
 * 中文数字说明：用户口语常用「先来五十道不用太难」「来二十道」而非纯阿拉伯数字。
 *  chineseToInt 只支持常见的 1~9999（百/十组合，如 二十/五十/十五/一百一），缺位或超范围返回 null，
 *  由调用方回退到阿拉伯数字解析。仅认阿拉伯数字时用的 [pickCount] 也不会把「六级」读成 6。
 */

/** 中文数字单字映射（不含十/百，它们作单位在 [chineseToInt] 内处理） */
const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 把连续的中文数字串（可含 十/百）转成阿拉伯数字；非数字串 / 超 6 位 / 无法识别返回 null。
 *  支持 二十=20、五十=50、十五=15、一百=100、一百二十=120 等常见口语。 */
export function chineseToInt(s: string): number | null {
  if (!s || !/^[零一二两三四五六七八九十百]{1,6}$/.test(s)) return null
  let total = 0
  let pending = 0 // 当前累积的纯数字（撞到十/百时按单位合成）
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) {
      pending = CN_DIGIT[ch]
    } else if (ch === '百') {
      total += (pending || 1) * 100
      pending = 0
    } else if (ch === '十') {
      total += (pending || 1) * 10
      pending = 0
    }
  }
  return total + pending
}

/** 明确出题词正则（规则预判，省一次意图识别 LLM 调用）：
 *  窗口放宽到 18 字符（主题可较长），并用全局排除「这/那/哪…题」指向性模式，
 *  避免「帮我看看这道题怎么做」这类问答案/解析的聊天被误判为出题意图。 */
const EXPLICIT_GEN_RE =
  /(?:帮我|给我|来|来点|来几道|出|生成|写|整理|弄|编|设计)(?!.*[这那哪].{0,2}题)[^。！？\n]{0,18}?(?:题|题目|练习|测试|试卷|考卷|题库)|(?:那|就|好)?(?:出题吧|开始出题|来点题|来题吧)|(?:就|那)?(?:按这个出|这么出|这样出)/

/** 英语出题请求（真机验收场景：英语输入容错）：
 *  「give me 10 python questions」「generate 20 quiz questions」这类句子不含中文出题词，
 *  语义规则漏判时，V2 控制器仍可使用本地明确字段兜底，避免用户已说出的题数丢失。
 *  窗口 40 字符避免「how to write test cases」这类长句误判。 */
const EXPLICIT_GEN_EN_RE =
  /\b(?:generate|create|make|give\s+me|prepare|quiz\s+me|draw\s+up)\b[^.!?。！？\n]{0,40}?\b(?:questions?|quizzes?|quiz|exercises?|problems?|items?|flashcards?)\b/i

/** 否定/疑问/假设语气开头（场景矩阵 G/I 组补充）：「不要出题」「怎么出题」「如果我想出题」这类句子
 *  虽含「出题」字样，但语义是拒绝/求教方法/假设，不是真的要出题——命中后交 LLM 结合语境判型，
 *  防止字面撞词误触发生题（真机场景扩展发现：C9「出题范围包括函数吗」同族问题的规则侧兜底） */
export const NOT_A_REQUEST_RE =
  /^(?:不要|不用|不想|不打算|不需要|别|怎么|如何|怎样|在哪|在哪儿|哪里|哪儿|如果|假如|要是|是不是|能不能|可不可以|为什么)/

export function hasExplicitGenIntent(input: string): boolean {
  if (NOT_A_REQUEST_RE.test(input.trim())) return false
  return EXPLICIT_GEN_RE.test(input) || EXPLICIT_GEN_EN_RE.test(input)
}

/** 生题「承接/开始」短指令识别，供参数调整规则排除确认语义。 */
export function isStartConfirm(text: string): boolean {
  const t = text.trim().replace(/[！!。，,、\s]+/g, ' ')
  if (/^(好|嗯|行|可以|没问题|ok|OK|对|是|够了|来吧)$/.test(t)) return true
  if (/^(?:(?:好|嗯|行|可以|就|那)?(?:生成吧|开始吧|开始生成|来一套|出题吧|出吧))$/.test(t)) return true
  return /(生成吧|开始吧|开始生成|帮我生成|帮我出题|就这样|就按这个|按这个(来|出)|来吧|出吧)/.test(t)
}

/** 生题参数调整判定；问句/闲聊排除，避免误触发。 */
export function isAdjustment(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (isStartConfirm(t)) return false
  if (/^(?:为什么|怎么|如何|啥|请问|能否|what|how|why)/i.test(t) || /[？?]$/.test(t)) return false
  // 疑问语气词结尾（「出题范围包括函数吗」）：是在提问而非下调整指令，
  // 交 LLM 结合 pending 语境判型（真机场景矩阵 C9：「出题范围」会撞出题动词正则，需在此拦下）
  if (/[吗呢]\s*[。.！!]*$/.test(t)) return false
  if (pickCount(t) != null) return true
  if (hasExplicitGenIntent(t)) return true
  return /(调整|改|修改|优化|增加|减少|多|少|重点|难度|题型|内容|侧重|偏重|去掉|移除|换成|只要|包含|覆盖|围绕|结合|加强|方案|比例|往|加)/.test(t)
}

/** 「数字(阿拉伯或中文)紧邻 道/题」= 题目数量规格；英语变体见 COUNT_SPEC_EN。 */
const COUNT_SPEC = /(\d{1,4}|[零一二两三四五六七八九十百]{1,6})\s*(?:道\s*题|道|题)/
/** 英语题数规格：「20 questions」「10 exercises」等（承接式回复，配合 EXPLICIT_GEN_EN_RE 覆盖英语链路）。 */
const COUNT_SPEC_EN = /\b\d{1,4}\s*(?:questions?|quizzes?|exercises?|problems?|items?)\b/i
const DISCUSS_SPEC = /怎么做|如何|答案|选什么|为什么|解析|错在|怎么解|怎么选/

/** 承接式「题数/题型规格」：模型问完需求后，用户回「20道题，阅读题吧」「60道判断」「先来五十道不用太难」这类**给生成的参数**。
 *  本身没有出题动词，EXPLICIT_GEN_RE 匹配不到，不加规则就会被当普通聊天直答、在聊框里铺 N 道题并截断。
 *  注意：**不能**把含出题动词的输入也判成承接式——否则会把历史主题拼进完整新请求。 */
export function isGenSpecReply(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (hasExplicitGenIntent(t)) return false
  if (!COUNT_SPEC.test(t) && !COUNT_SPEC_EN.test(t)) return false
  // 指代/序号/求解语境多半在讨论某道具体题，不是下生成规格。
  // 只排除「这/那/哪 + 题」的具体题目指代（这道题/这些题/哪题）——不能一刀切含这那哪就排除，
  // 否则「100道题，这些都覆盖，难度简单一些」被误当聊天、生题确认与按钮全丢（真机 bug 6.x）
  if (/(?:这|那|哪)\s*(?:\d{1,3}|[一二两三四五六七八九十])?\s*[道个些]?\s*(?:题|题目|试卷|题库)/.test(t)) return false
  if (/第\s*(\d|[一二三四五六七八九十]+)/.test(t)) return false
  if (DISCUSS_SPEC.test(t)) return false
  return true
}

/** 从文本里提取题数：支持「阿拉伯/中文数字 + 题/道」，也支持整条消息就是一个裸数字（如「50」）。
 *  钳制到系统上限；没有明确数字返回 null。 */
export function pickCount(text: string): number | null {
  // 阿拉伯数字：数字+题/道/条/个，或整条裸数字
  const m = text.match(/(\d+)\s*[题道条个]/) || text.match(/^\s*(\d{1,4})\s*$/)
  let n: number | null = null
  if (m) {
    const v = parseInt(m[1] ?? m[2] ?? '', 10)
    if (Number.isFinite(v) && v > 0) n = v
  }
  // 中文数字：如「先来五十道」「来二十道」；前缀若是 第/这/那/哪（如「第三题」）不当作题数
  if (n === null) {
    const c = text.match(/([零一二两三四五六七八九十百]{1,6})\s*(?:道\s*)?(?:题|道)/)
    if (c) {
      const before = c.index && c.index > 0 ? text[c.index - 1] : ''
      if (!/[第这那哪]/.test(before ?? '')) n = chineseToInt(c[1])
    }
  }
  if (n === null) return null
  return Math.min(n, MAX_QUESTIONS_PER_GENERATION)
}

/**
 * 判断「只想模糊增减题量、但没有给最终题数」的输入。
 *
 * 这类句子常带口语、省略或错别字（如「题有点上了，还想多出一些」），
 * 不足以安全改动 Draft，却会被宽泛的 isAdjustment 判进协议模型调用。
 * 交给模型既慢，又可能触发一次协议重试；这里仅识别题量相关的模糊表达，
 * 明确数字/题型或其他复杂要求仍走原有语义链路。
 */
const VAGUE_COUNT_ADJUSTMENT_RE =
  /(?:多出|少出|多做|少做|多来|少来|(?:再\s*)?(?:多|少)\s*(?:一些|一点|几道)(?:题|题目)?|增加\s*(?:题|题目|题量|数量|一些|一点|几道)|减少\s*(?:题|题目|题量|数量|一些|一点|几道)|(?:题|题目|题量|数量)[^，,。；;！!？?\n]{0,6}(?:太少|太多|少了|多了|不够))/

export function isVagueCountAdjustment(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || pickCount(t) !== null || parseTypeStructure(t).matched) return false
  // 带其他明确维度时仍交给模型，避免澄清题量时吞掉难度/题型等要求。
  if (/(?:难度|简单|困难|容易|重点|题型|单选|多选|判断|填空|匹配|排序|简答|案例|论文|论述|要求|内容|主题|资料|知识点)/.test(t)) return false
  return VAGUE_COUNT_ADJUSTMENT_RE.test(t)
}

/** 用户回答「随便/你定」等时，视为放弃指定题数，用推荐量兜底 */
export function isDefaultAnswer(text: string): boolean {
  return /^(随便|都行|都可以|你定|你看着办|无所谓|怎么都行|多少都行)/.test(text.trim())
}

/** 生题「取消/放弃」判定，供活动草稿取消门禁使用。 */
export function isGenAbort(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return /^(?:算了|算了吧|不出了|不弄了|不要了|不用了|先不弄|先不|先算了|暂时不用|暂时先不|先搁着|先放着|先别弄|不弄题|取消|取消吧|别弄了|别出了|改天再(?:说|弄|出)|回头再(?:说|弄|出)|聊点别的|另说吧|再说吧)/.test(t)
}

/* ------------------------------------------------------------------ *
 *  RC-07：题型×数量结构解析（对话式生题「选择题15题，案例分析2题」）
 * ------------------------------------------------------------------ */

/** 题型别名 → 题型 id（'choice' 表示「选择题」这类未定单/多的歧义题型，需问询分配）。
 *  注意长别名在前（「单项选择题」要先于「单选」「选择题」被匹配）。 */
const TYPE_ALIAS: [string, QuestionTypeId | 'choice'][] = [
  ['单项选择题', 'single'],
  ['单项选择', 'single'],
  ['多项选择题', 'multiple'],
  ['多项选择', 'multiple'],
  ['案例分析题', 'case'],
  ['案例分析', 'case'],
  ['案例题', 'case'],
  ['单选题', 'single'],
  ['多选题', 'multiple'],
  ['判断题', 'judge'],
  ['填空题', 'fill'],
  ['匹配题', 'match'],
  ['排序题', 'order'],
  ['简答题', 'short'],
  ['论文题', 'essay'],
  ['论述题', 'essay'],
  ['单选', 'single'],
  ['多选', 'multiple'],
  ['判断', 'judge'],
  ['填空', 'fill'],
  ['匹配', 'match'],
  ['排序', 'order'],
  ['简答', 'short'],
  ['案例', 'case'],
  ['论文', 'essay'],
  ['论述', 'essay'],
  ['选择题', 'choice'],
  ['选择', 'choice'],
]
const TYPE_SCAN_RE = new RegExp(TYPE_ALIAS.map(([a]) => a).join('|'), 'g')

/** 题型结构解析结果：entries=已明确的题型数量；ambiguousCount=「选择题N」未定单/多时等待分配的题数 */
export interface TypeStructureParse {
  entries: { type: QuestionTypeId; count: number }[]
  ambiguousCount: number | null
  total: number
  matched: boolean
}

/** 从需求文本解析「题型×数量」结构：支持「选择题15题，案例分析2题，论文1题」「单选10多选5」「15道单选题」等句式。
 *  同一题型多次出现取第一次；数量钳制到系统上限；「选择题」未带单/多限定时记入 ambiguousCount 交由问询分配。 */
export function parseTypeStructure(text: string): TypeStructureParse {
  const entries: { type: QuestionTypeId; count: number }[] = []
  let ambiguousCount: number | null = null
  const seen = new Set<QuestionTypeId | 'choice'>()
  const t = text || ''
  TYPE_SCAN_RE.lastIndex = 0
  for (let m = TYPE_SCAN_RE.exec(t); m; m = TYPE_SCAN_RE.exec(t)) {
    const alias = m[0]
    const mapped = TYPE_ALIAS.find(([a]) => a === alias)?.[1]
    if (!mapped || seen.has(mapped)) continue
    // 数量在别名后（「选择题15题」「案例分析2」）：别名后 0~4 个非数字字符内出现数字
    const after = t.slice(m.index + alias.length, m.index + alias.length + 10)
    const mAfter = after.match(/^[题]?\s*[是约]?(\d{1,4})\s*[题道个]?/)
    let n: number | null = mAfter ? parseInt(mAfter[1], 10) : null
    // 数量在别名前（「15道单选题」）：别名前是「数字+题/道/个」结尾
    if (n === null) {
      const before = t.slice(Math.max(0, m.index - 8), m.index)
      const mBefore = before.match(/(\d{1,4})\s*[题道个]\s*(?:的)?$/)
      if (mBefore) n = parseInt(mBefore[1], 10)
    }
    if (n === null || n <= 0) continue
    n = Math.min(n, MAX_QUESTIONS_PER_GENERATION)
    seen.add(mapped)
    if (mapped === 'choice') ambiguousCount = n
    else entries.push({ type: mapped, count: n })
  }
  const total = entries.reduce((a, b) => a + b.count, 0) + (ambiguousCount ?? 0)
  return { entries, ambiguousCount, total, matched: entries.length > 0 || ambiguousCount != null }
}

/* ------------------------------------------------------------------ *
 *  V2 协议共用题型键归一（TASK-03 步骤 3：统一别名表，防止漂移）
 *  接受：标准 id（single/case…）、英文短名、中文名长/短/带题变体（案例分析/案例分析题）、
 *  以及 TYPE_ALIAS 全部别名；「选择题」这类未消歧键返回 'choice'，由调用方处理。
 * ------------------------------------------------------------------ */
const TYPE_KEY_MAP: Record<string, QuestionTypeId | 'choice'> = (() => {
  const m: Record<string, QuestionTypeId | 'choice'> = {}
  const put = (k: string, v: QuestionTypeId | 'choice') => {
    const key = k.trim().toLowerCase().replace(/\s+/g, '')
    if (key && !(key in m)) m[key] = v
  }
  for (const t of QUESTION_TYPES) {
    put(t.id, t.id)
    put(t.name, t.id)
    const short = t.name.replace(/题$/, '')
    if (short !== t.name) put(short, t.id)
    const long = t.name.endsWith('题') ? t.name : `${t.name}题`
    put(long, t.id)
  }
  for (const [alias, id] of TYPE_ALIAS) put(alias, id)
  put('multi', 'multiple') // 常见英文短名
  return m
})()

/** 题型键 → 标准题型 id；未知/歧义键：'choice'=选择题未消歧，null=完全未知（调用方必须拒绝，不得静默丢弃） */
export function normalizeTypeKey(rawKey: string): QuestionTypeId | 'choice' | null {
  const key = (rawKey ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!key) return null
  return TYPE_KEY_MAP[key] ?? null
}
