import type {
  AnswerRecord,
  ExportFile,
  KBDoc,
  KnowledgePoint,
  LearningState,
  Pack,
  Preferences,
  Question,
  UsageRecord,
  WrongRecord,
} from '../../types'
import { QUESTION_TYPES } from '../../types'
import { parseMarkdown } from '../../ai/parse'
import { getDB, wrongKey } from '../../db'
import { sanitizeImportDetailed, type ImportSkips } from './validate'
import { uid } from '../../utils'

/**
 * 导入导出服务（见 PRD 6.7）：题包分享 + 完整备份 / 恢复。
 * - type=pack：题包内容导出，不含个人进度，用于分享。
 * - type=backup：完整备份导出，含掌握度 / 错题 / 复习队列 / 用量 / 知识库 / 作答历史 / 分类 / 偏好（V2-F01）。
 * API Key、Authorization、日志、会话消息不随备份导出（见 PRD 11.6 数据安全）。
 */

export function exportPack(pack: Pack): string {
  const file: ExportFile = { version: 2, type: 'pack', pack, exportedAt: Date.now() }
  return JSON.stringify(file, null, 2)
}

/** exportBackup 可选数据项（个人进度按需勾选；知识库/分类/偏好始终随完整备份导出，见 V2-F01） */
export interface BackupExportOptions {
  /** 知识库（V2-F01 新增，始终导出备份时包含，供「仅知识库」也能备份） */
  knowledgeBases?: KBDoc[]
  /** 学习数据（掌握度 / 复习队列），勾选才导出 */
  learning?: LearningState[]
  /** 错题本，勾选才导出 */
  wrongs?: WrongRecord[]
  /** 作答历史（V2-F01），勾选才导出 */
  answers?: AnswerRecord[]
  /** 用量统计，勾选才导出 */
  usage?: UsageRecord[]
  /** 分类（V2-F01，始终导出） */
  categories?: string[]
  /** 偏好设置（V2-F01，存在则导出） */
  preferences?: Preferences
}

export function exportBackup(packs: Pack[], opts: BackupExportOptions = {}): string {
  const file: ExportFile = {
    version: 2,
    type: 'backup',
    pack: packs[0],
    packs,
    knowledgeBases: opts.knowledgeBases ?? [],
    // 个人进度项可选：不勾选则仅导出题包/知识库（见数据管理导出可选项）
    learning: opts.learning ?? [],
    wrongs: opts.wrongs ?? [],
    answers: opts.answers ?? [],
    usage: opts.usage ?? [],
    categories: opts.categories ?? [],
    preferences: opts.preferences,
    exportedAt: Date.now(),
  }
  return JSON.stringify(file, null, 2)
}

/** 解析导入文件：JSON 解析 + 基础格式校验，失败抛错（见 AC-6.5 格式校验失败提示）。
 *  v1 与 v2 兼容：v2 完整备份、v1 旧格式只读导入。 */
export function parseImport(json: string): ExportFile {
  let file: unknown
  try {
    file = JSON.parse(json)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  if (!file || typeof file !== 'object') throw new Error('备份文件格式无效')
  const f = file as ExportFile
  if (f.version !== 1 && f.version !== 2) throw new Error(`备份版本不兼容（当前支持 v1/v2，文件为 v${f.version ?? '?'}）`)
  if (f.type !== 'pack' && f.type !== 'backup') throw new Error('备份文件类型无效')
  if (f.type === 'pack') {
    if (!f.pack || !f.pack.id || !Array.isArray(f.pack.questions)) throw new Error('题包数据缺失')
  }
  if (f.type === 'backup' && !Array.isArray(f.packs)) throw new Error('备份缺少题包列表')
  return f
}

/** 导入计划：题包 + 学习/错题/作答/用量/知识库/分类/偏好，标记重复题包（见 AC-6.5 重复题包提示合并/跳过） */
export interface ImportPlan {
  type: 'pack' | 'backup'
  packs: { pack: Pack; duplicate: boolean }[]
  knowledgeBases: KBDoc[]
  learning: LearningState[]
  wrongs: WrongRecord[]
  answers: AnswerRecord[]
  usage: UsageRecord[]
  categories: string[]
  preferences?: Preferences
  /** V3-F01：作答记录中「关联题包/题目缺失」被忽略的条数（导入预览展示，防静默丢数据） */
  answersOrphans: number
  /** V4-F05：作答记录中引用「重复题包」的条数——非合并模式跳过重复题包时会被一并忽略 */
  answersViaDupPack: number
  /** 6.83：题目级/整包级/错题级跳过明细（导入预览展示，坏内容跳过而非整包拒绝） */
  skipped: ImportSkips
}

/** 由包内问题 id 建立「packId → Set<questionId>」引用表（V3-F01 作答引用完整性校验用） */
export function answerRefIndex(
  packs: ReadonlyArray<{ pack: Pack; duplicate: boolean }>,
): Map<string, Set<string>> {
  const ref = new Map<string, Set<string>>()
  for (const { pack } of packs) {
    const ids = new Set<string>()
    for (const q of pack.questions) ids.add(q.id)
    ref.set(pack.id, ids)
  }
  return ref
}

/** 构建导入计划：先经 sanitizeImportDetailed 全量校验/规范化（坏题跳过留痕、结构问题抛错），再按题包 id 检测与现有题包重复 */
export function buildImportPlan(file: ExportFile, existingPacks: Pack[]): ImportPlan {
  const { file: safe, skipped } = sanitizeImportDetailed(file)
  // 6.83：type=pack 且整包被跳过时 safe.pack 为空，不产生计划项（不崩溃）
  const safePacks = safe.type === 'backup' ? safe.packs ?? [] : safe.pack ? [safe.pack] : []
  const packs = safePacks.map((rawPack) => {
    let pack = rawPack
    // 6.84：查重按 id；外部导入（md/外部 json）没有稳定 id——md 每次 parsePackMarkdown 都生成新
    // uid，同名文件反复导入按 id 永远判不出重复。同名（标题一致）也视为重复，并**收编本机既有 id**：
    // 合并模式 put() 直接覆盖原记录（学习进度/错题引用挂原 id 不丢），跳过模式维持不落库。
    let duplicate = existingPacks.some((p) => p.id === pack.id)
    if (!duplicate) {
      const byTitle = existingPacks.find((p) => p.title === pack.title)
      if (byTitle) {
        duplicate = true
        pack = { ...pack, id: byTitle.id }
      }
    }
    return { pack, duplicate }
  })
  // V3-F01：作答须能追溯到本备份内的题包+题目，否则计入 orphan（预览提示，导入时忽略）
  const ref = answerRefIndex(packs)
  const answers = safe.answers ?? []
  let answersOrphans = 0
  const dupPackIds = new Set(packs.filter((p) => p.duplicate).map((p) => p.pack.id))
  let answersViaDupPack = 0
  for (const a of answers) {
    const qids = ref.get(a.packId)
    if (!qids || !qids.has(a.questionId)) {
      answersOrphans++
    } else if (dupPackIds.has(a.packId)) {
      // 引用「已存在题包」的作答：非合并（跳过重复）时不会写入（V4-F05 预览据 merge 计算真实追加数）
      answersViaDupPack++
    }
  }
  return {
    type: safe.type,
    packs,
    knowledgeBases: safe.knowledgeBases ?? [],
    learning: safe.learning ?? [],
    wrongs: safe.wrongs ?? [],
    answers,
    usage: safe.usage ?? [],
    categories: safe.categories ?? [],
    preferences: safe.preferences ?? undefined,
    answersOrphans,
    answersViaDupPack,
    skipped,
  }
}

/**
 * 执行导入：合并（覆盖重复题包）或跳过（保留现有）。
 * 学习数据仅写入与导入题包关联的记录，避免孤儿数据。
 * S-02 / V2-F01：所有记录已在 buildImportPlan 阶段校验/规范化，此处用单个跨 store
 * IndexedDB 事务（packs/learning/wrongs/answers/usage/knowledge_bases/categories/config）
 * 原子提交全部白名单数据，任一失败整体回滚，杜绝「导入到一半失败留下部分恢复状态」。
 */
export async function applyImport(
  plan: ImportPlan,
  opts: { merge: boolean },
): Promise<{ imported: number; skipped: number }> {
  const db = await getDB()
  const tx = db.transaction(
    ['packs', 'learning', 'wrongs', 'wrongs_v2', 'answers', 'usage', 'knowledge_bases', 'categories', 'config'],
    'readwrite',
  )
  const packsStore = tx.objectStore('packs')
  const learnStore = tx.objectStore('learning')
  const wrongsStore = tx.objectStore('wrongs_v2')
  const answerStore = tx.objectStore('answers')
  const usageStore = tx.objectStore('usage')
  const kbStore = tx.objectStore('knowledge_bases')
  const catStore = tx.objectStore('categories')
  const cfgStore = tx.objectStore('config')

  let imported = 0
  let skipped = 0
  const importedIds = new Set<string>()
  const importedPacksById = new Map<string, Pack>()

  for (const { pack, duplicate } of plan.packs) {
    if (duplicate && !opts.merge) {
      skipped++
      continue
    }
    packsStore.put(pack)
    importedIds.add(pack.id)
    importedPacksById.set(pack.id, pack)
    imported++
  }

  if (plan.type === 'backup') {
    // 知识库 / 分类 / 偏好：与题包导入进度无关，直接白名单写入。
    // V3-F01：KB id 与本机冲突时生成新 id 追加（append_on_conflict），不覆盖本机同名知识库。
    // V4-F01：每次确定某个 KB 的最终 id 后立即并入 existingKbKeys，防止同一备份内重复 KB id 互相覆盖。
    const existingKbKeys = new Set(await kbStore.getAllKeys())
    for (const kb of plan.knowledgeBases) {
      let finalId = kb.id
      if (existingKbKeys.has(finalId)) finalId = uid('kb_')
      existingKbKeys.add(finalId)
      kbStore.put({ ...kb, id: finalId })
    }
    for (const name of plan.categories) catStore.put({ name })
    if (plan.preferences) cfgStore.put({ key: 'preferences', value: plan.preferences })

    // V4-F01：学习/错题只写「实际被导入」题包关联的数据，且已存在本机主键时**跳过而非覆盖**，
    // 杜绝导入把本机掌握度/错题进度静默覆盖（与作答/用量的「追加不覆盖」语义对齐）。
    const kpIds = new Set<string>()
    let learningSkipped = 0
    let wrongSkipped = 0
    const ref = answerRefIndex(plan.packs)
    for (const pack of plan.packs.map((p) => p.pack)) {
      if (!importedIds.has(pack.id)) continue
      for (const q of pack.questions) for (const kp of q.kp_ids) kpIds.add(kp)
    }
    // 学习状态：kp 须属于实际导入题包；本机已存在该 kp 记录时不覆盖
    for (const s of plan.learning) {
      if (!kpIds.has(s.kp_id)) continue
      if (await learnStore.get(s.kp_id)) {
        learningSkipped++
        continue
      }
      learnStore.put(s)
    }
    // 错题：须引用实际导入题包中的真实题目；内嵌题目一律改用题包 canonical question，
    // 不信任备份携带的 question 快照；本机已存在该题错题记录时不覆盖。
    for (const w of plan.wrongs) {
      const pack = importedPacksById.get(w.packId)
      if (!pack) {
        wrongSkipped++
        continue
      }
      const qIds = ref.get(w.packId)
      const canonical = qIds?.has(w.questionId) ? pack.questions.find((q) => q.id === w.questionId) : undefined
      if (!canonical) {
        wrongSkipped++
        continue
      }
      if (await wrongsStore.get(wrongKey(pack.id, canonical.id))) {
        wrongSkipped++
        continue
      }
      wrongsStore.put({ ...w, key: wrongKey(pack.id, canonical.id), questionId: canonical.id, question: canonical, packId: pack.id })
    }
    // 作答历史：只导入归属于「实际导入题包」且题目存在的记录；用 add() 生成本机自增 id，
    // 不保留备份中的外部自增 id（两台设备 id 易撞）——恢复语义为「追加，永不覆盖本机」（V3-F01）。
    for (const r of plan.answers) {
      if (!importedIds.has(r.packId)) continue
      const qids = ref.get(r.packId)
      if (!qids || !qids.has(r.questionId)) continue
      const { id: _omit, ...rec } = r
      answerStore.add(rec as AnswerRecord)
    }
    // 用量：每次导入生成新的全局唯一 id 追加，禁止外部 id 覆盖本地记录（V3-F01）。
    for (const r of plan.usage) {
      usageStore.add({ ...r, id: uid('u') })
    }
  }

  await tx.done
  return { imported, skipped }
}

/* ------------------------------------------------------------------ *
 *  Markdown 题包分享（见需求：题包导出为 .md，重复导入 app 可识别复用）。
 *  与 AI 生题的 parseMarkdown 格式一致，保证机器可逆：导出 → 导入不失真。
 *  包级元数据（标题/分类/难度/目标/知识点）用行首 HTML 注释承载，
 *  parseMarkdown 会忽略非字段行，不影响题目解析。
 * ------------------------------------------------------------------ */

const typeNameOf = (id: Question['type']) =>
  QUESTION_TYPES.find((t) => t.id === id)?.name ?? id

/** 多行文本压平成单行：折叠换行，规避字段名所在行被 md 解析器误切成新字段 */
const flatten = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

function serializeQuestion(q: Question): string[] {
  const lines: string[] = []
  lines.push(`题型：${typeNameOf(q.type)}`)
  if (q.material) lines.push(`材料：${flatten(q.material)}`)
  lines.push(`题干：${flatten(q.stem)}`)
  if (q.options && q.options.length) {
    lines.push('选项：')
    for (let i = 0; i < q.options.length; i++) {
      lines.push(`${String.fromCharCode(65 + i)}. ${flatten(q.options[i])}`)
    }
  }
  lines.push(`答案：${flatten(q.answer)}`)
  if (q.explanation) lines.push(`解析：${flatten(q.explanation)}`)
  lines.push(`知识点：${(q.kp_ids ?? []).join(',')}`)
  lines.push(`难度：${q.difficulty}`)
  return lines
}

/** 逗号/顿号分隔的元数据列表 → 数组 */
const splitMetaList = (s: string | undefined) =>
  (s ?? '').split(/[,、]/).map((x) => x.trim()).filter(Boolean)

/** 序列化题包为 Markdown（与 parseMarkdown 严格对应，可机器往返）。
 *  文件头含「可读元数据块 + 行首 HTML 注释块」：可读块方便人一眼看清，注释块保证机器可逆解析。 */
export function exportPackMarkdown(pack: Pack): string {
  const meta = pack.meta ?? {}
  const tags = (meta.tags ?? []).join(',')
  const types = (meta.types ?? []).join(',')
  const chapters = (pack.chapters ?? []).map((c) => c.title).filter(Boolean).join(', ')
  const description = pack.description || (meta.objectives ?? []).join('、')

  const head: string[] = []
  head.push(`学习本名称: ${flatten(pack.title)}`, '')
  head.push(`分类: ${flatten(pack.category) || '未分类'}`, '')
  head.push(`章节: ${chapters || '无'}`, '')
  head.push(`难度: ${flatten(meta.difficulty) || '未标注'}`, '')
  head.push(`标签: ${tags || '无'}`, '')
  head.push(`题型: ${types || '无'}`, '')
  head.push(`来源: ${flatten(meta.source) || '未标注'}`, '')
  head.push(`版本: ${flatten(meta.version) || '1.0'}`, '')
  head.push(`简介: ${flatten(description)}`, '')
  head.push(`格式版本: ${flatten(meta.formatVersion) || '1.0'}`, '')

  const out: string[] = [...head]
  out.push(`<!-- title: ${flatten(pack.title)} -->`)
  if (pack.category) out.push(`<!-- category: ${flatten(pack.category)} -->`)
  out.push(`<!-- difficulty: ${flatten(meta.difficulty)} -->`)
  for (const o of meta.objectives ?? []) if (o) out.push(`<!-- objective: ${flatten(o)} -->`)
  if (tags) out.push(`<!-- tags: ${tags} -->`)
  if (types) out.push(`<!-- types: ${types} -->`)
  if (meta.source) out.push(`<!-- source: ${flatten(meta.source)} -->`)
  out.push(`<!-- version: ${flatten(meta.version) || '1.0'} -->`)
  out.push(`<!-- format-version: ${flatten(meta.formatVersion) || '1.0'} -->`)
  if (description) out.push(`<!-- description: ${flatten(description)} -->`)
  const kpById = new Map<string, { title: string; content: string; examples: string[]; pitfalls: string[] }>()
  for (const ch of pack.chapters) for (const kp of ch.knowledge_points) kpById.set(kp.id, kp)
  for (const [id, kp] of kpById) out.push(`<!-- kp: ${id}=${flatten(kp.title)} -->`)
  out.push('')

  pack.questions.forEach((q, i) => {
    out.push(`=== 第 ${i + 1} 题 ===`)
    out.push(...serializeQuestion(q))
    out.push('')
  })
  return out.join('\n')
}

/** 从行首注释提取包级元数据（另读头部「章节:」人读行——供按「章节>知识点」前缀重建章节结构） */
function parsePackMeta(md: string): {
  title: string
  category: string
  difficulty: string
  objectives: string[]
  kps: Record<string, string>
  chapters: string[]
  tags: string
  types: string
  source: string
  version: string
  formatVersion: string
  description: string
} {
  const meta: {
    title: string; category: string; difficulty: string; objectives: string[];
    kps: Record<string, string>; chapters: string[]; tags: string; types: string; source: string;
    version: string; formatVersion: string; description: string;
  } = {
    title: '', category: '', difficulty: '', objectives: [], kps: {}, chapters: [],
    tags: '', types: '', source: '', version: '', formatVersion: '', description: '',
  }
  for (const m of md.matchAll(/^<!--\s*(title|category|difficulty|objective|tags|types|source|version|format-version|description|kp)\s*[:=]\s*(.*?)\s*-->\s*$/gm)) {
    const key = m[1]
    const val = m[2].trim()
    if (key === 'title') meta.title = val
    else if (key === 'category') meta.category = val
    else if (key === 'difficulty') meta.difficulty = val
    else if (key === 'objective') meta.objectives.push(val)
    else if (key === 'tags') meta.tags = val
    else if (key === 'types') meta.types = val
    else if (key === 'source') meta.source = val
    else if (key === 'version') meta.version = val
    else if (key === 'format-version') meta.formatVersion = val
    else if (key === 'description') meta.description = val
    else if (key === 'kp') {
      const eq = val.indexOf('=')
      if (eq > 0) meta.kps[val.slice(0, eq).trim()] = val.slice(eq + 1).trim()
    }
  }
  // 「章节:」是头部人读行（非注释），单独取首个匹配；题目块内不会有以「章节:」开头的行
  const chLine = md.match(/^章节[:：]\s*(.+)$/m)
  if (chLine) meta.chapters = splitMetaList(chLine[1])
  return meta
}

/** 解析 Markdown 题包为导出文件（type=pack），复用 parseMarkdown 解析题目 */
export function parsePackMarkdown(md: string): ExportFile {
  const meta = parsePackMeta(md)
  const questions = parseMarkdown(md)

  const kps: KnowledgePoint[] = Object.entries(meta.kps)
    .filter(([id]) => questions.some((q) => (q.kp_ids ?? []).includes(id)))
    .map(([id, title]) => ({ id, title, content: '', examples: [], pitfalls: [] }))

  // 章节结构重建：导出格式的 kp id 为「章节>知识点」，按前缀归组；头部「章节:」行提供章节顺序，
  // 未列出的前缀追加尾部；题目按其 kp_ids 归入第一个命中的章节（防跨章重复）。
  // 无任何结构信息（无「章节:」行且 kp id 无前缀）时保持原扁平单章兜底。
  const usedKp = new Set<string>()
  for (const q of questions) for (const k of q.kp_ids ?? []) usedKp.add(k)
  const prefixedKpIds = Object.keys(meta.kps).filter((id) => id.includes('>'))
  const chapterTitles = [...meta.chapters.filter(Boolean)]
  for (const p of prefixedKpIds) {
    const t = p.split('>')[0].trim()
    if (t && !chapterTitles.includes(t)) chapterTitles.push(t)
  }
  let chapters: Pack['chapters'] = []
  if (chapterTitles.length) {
    const assigned = new Set<string>()
    chapters = []
    for (const title of chapterTitles) {
      const kpIdsInCh = prefixedKpIds.filter((id) => usedKp.has(id) && id.split('>')[0].trim() === title)
      if (!kpIdsInCh.length) continue
      const kpSet = new Set(kpIdsInCh)
      const qids = questions.filter((q) => !assigned.has(q.id) && (q.kp_ids ?? []).some((k) => kpSet.has(k))).map((q) => q.id)
      for (const id of qids) assigned.add(id)
      chapters.push({
        id: uid('ch_'),
        title,
        summary: '',
        knowledge_points: kpIdsInCh.map((id) => ({ id, title: meta.kps[id] || id, content: '', examples: [], pitfalls: [] })),
        question_ids: qids,
      })
    }
  }
  const pack: Pack = {
    id: uid('p_'),
    title: meta.title || '未命名',
    category: meta.category || '',
    source: 'import',
    description: meta.description || undefined,
    meta: {
      difficulty: meta.difficulty || '未标注',
      objectives: meta.objectives,
      tags: splitMetaList(meta.tags),
      types: splitMetaList(meta.types),
      source: meta.source || '手动导入',
      version: meta.version || '1.0',
      formatVersion: meta.formatVersion || '1.0',
    },
    chapters: chapters.length
      ? chapters
      : kps.length
        ? [{ id: uid('ch_'), title: meta.title || '全部题目', summary: '', knowledge_points: kps, question_ids: [] }]
        : [],
    questions,
    created_at: Date.now(),
  }
  // 不填 exportedAt：md 格式本身没有导出时间，填 Date.now() 会让预览页「导出时间」显示成导入当天（误导）
  return { version: 1, type: 'pack', pack }
}
