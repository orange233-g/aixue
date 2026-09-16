/**
 * 范围选题 + 按预算切卷（去凝练架构，见改造方案 §4.2）。
 * 出题不再靠有损压缩解决覆盖：用户勾选章节范围，planVolumes 按文档序把选中
 * sections 装箱到 ≤budget 字/卷，每卷一次生成请求（模型每次只看一卷，保证整明白）。
 * 纯本地零 token；卷文本用 bodyText.slice 取得，不复制存储。
 */
import type { KBSection, KbScope, KBVolume, QuestionTypeId } from '../../types'
import { AIError } from '../../ai/types'
import { sanitizeInput } from '../../utils/sanitize'

export type { KbScope, KBVolume }

/** 范围选择：空 sectionIds = 该库全部内容 */
export interface ScopeSelection {
  kbId: string
  sectionIds: string[]
}

/** 单卷默认预算（字） */
export const VOLUME_BUDGET = 4500

/** 句末标点（节内硬切的次选边界） */
const SENT_END = /[。！？；.!?)）]/

/** 在 [from, to) 内从 to 向前找最近的可切偏移：优先空行，次选句末标点，最后 to 本身 */
function findCut(body: string, from: number, to: number): number {
  const seg = body.slice(from, to)
  const blank = seg.lastIndexOf('\n\n')
  if (blank > 0) return from + blank + 1
  for (let i = seg.length - 1; i > 0; i--) {
    if (SENT_END.test(seg[i])) return from + i + 1
  }
  return to
}

/**
 * 范围切卷：选中 sections 按文档序装箱到 ≤budget 字/卷。
 * @param sectionIds 选中的节 id 列表；空数组 = 全部节
 * @returns volumes 按文档序排列；totalChars 为选中范围总字数
 */
export function planVolumes(
  bodyText: string,
  sections: KBSection[],
  sectionIds: string[],
  budget = VOLUME_BUDGET,
): { volumes: KBVolume[]; totalChars: number } {
  if (!bodyText) return { volumes: [], totalChars: 0 }
  const wanted = sectionIds.length
    ? sections.filter((s) => sectionIds.includes(s.id))
    : [...sections]
  wanted.sort((a, b) => a.start - b.start)

  // 空 sections 兜底：整篇一卷
  if (wanted.length === 0) {
    return {
      // P-01：卷只存定位 [start,end) 不存正文，执行时按 kbId 懒加载 bodyText 切片
      volumes: [{ index: 0, kbId: '', kbName: '', start: 0, end: bodyText.length, charCount: bodyText.length, sectionTitles: [] }],
      totalChars: bodyText.length,
    }
  }

  const volumes: KBVolume[] = []
  let volStart = wanted[0].start
  let volEnd = volStart
  let titles: string[] = []
  const closeVolume = (nextStart: number) => {
    if (volEnd > volStart) {
      volumes.push({
        index: volumes.length,
        kbId: '',
        kbName: '',
        start: volStart,
        end: volEnd,
        charCount: volEnd - volStart,
        sectionTitles: titles,
      })
    }
    volStart = nextStart
    volEnd = nextStart
    titles = []
  }

  for (const sec of wanted) {
    // 勾选不连续（跳过了中间节）时存在间隙：先封卷，新卷从 sec.start 起，不带进未选内容
    if (volEnd > volStart && sec.start > volEnd) closeVolume(sec.start)
    const secLen = sec.end - sec.start
    if (secLen > budget) {
      // 单节自身超预算：先封当前卷，再在节内按空行→句读边界硬切成多卷
      closeVolume(sec.start)
      let p = sec.start
      while (p < sec.end) {
        const target = Math.min(p + budget, sec.end)
        const cut = target >= sec.end ? sec.end : findCut(bodyText, p, target)
        volumes.push({
          index: volumes.length,
          kbId: '',
          kbName: '',
          start: p,
          end: cut,
          charCount: cut - p,
          sectionTitles: sec.title ? [sec.title] : [],
        })
        p = cut
      }
      volStart = sec.end
      volEnd = sec.end
      continue
    }
    if (volEnd > volStart && volEnd - volStart + secLen > budget) {
      closeVolume(sec.start)
    }
    volEnd = sec.end
    if (sec.title) titles.push(sec.title)
  }
  closeVolume(volEnd)
  return { volumes, totalChars: volumes.reduce((s, v) => s + v.charCount, 0) }
}

/* ---------------- 多卷执行（Phase 3：范围选题 + 多卷生成流水线） ---------------- */

function structTotal(s: Record<QuestionTypeId, number>): number {
  return Object.values(s).reduce((a, b) => a + b, 0)
}

/** 多卷题数均分：每题型独立按卷均分（floor + 前 n%V 卷 +1，保证各题型比例跨卷稳定），
 *  返回「累计」目标结构序列——第 i 卷结构 = 前 i+1 卷配额之和，末卷 = 原结构。
 *  累计口径与 seed 补全机制对齐：每卷传入已生成题目作 seed，缺口 = 累计目标 − 已生成数，
 *  恰好等于本卷配额；断点续跑时「累计目标 ≤ 已生成数」的卷自然跳过（含 T<V 时的零配额卷）。 */
export function cumulativeVolumeStructures(
  structure: Record<QuestionTypeId, number>,
  volumeCount: number,
): Record<QuestionTypeId, number>[] {
  if (volumeCount <= 1) return [structure]
  const out: Record<QuestionTypeId, number>[] = []
  for (let i = 0; i < volumeCount; i++) {
    const cum = {} as Record<QuestionTypeId, number>
    for (const [t, nRaw] of Object.entries(structure)) {
      const n = Number(nRaw) || 0
      const base = Math.floor(n / volumeCount)
      const rem = n % volumeCount
      cum[t as QuestionTypeId] = (i + 1) * base + Math.min(i + 1, rem)
    }
    out.push(cum)
  }
  return out
}

/** 从 refs 中剥除知识库检索块（多卷生成时由整卷正文取代）：
 *  页面侧 refs = 文件块 + '\n\n' + 知识库块（buildMultiKbRef 产物），按精确后缀剥离。 */
function stripKbRefSuffix(refs: string, kbRef?: string): string {
  if (!kbRef || !refs) return refs
  if (refs === kbRef) return ''
  if (refs.endsWith('\n\n' + kbRef)) return refs.slice(0, refs.length - kbRef.length - 2)
  return refs
}

/** 卷正文解析器：按 kbId 取该库清洗后正文（P-01：卷只存定位，正文执行时懒加载切片） */
export type BodyResolver = (kbId: string) => string | undefined | Promise<string | undefined>

/** 单卷 refs：原 refs 剥除知识库检索块（保留文件附件块）后，拼上本卷正文（头部标注归属库名）。
 *  卷正文按 [vol.start, vol.end) 从 resolveBody(kbId) 返回的正文懒切片，再过
 *  sanitizeInput（引用内容视作不可信输入，与 ref.ts 同口径）。库已删除/取不到正文时降级为仅保留文件 refs。 */
export async function volumeRunRefs(
  vol: KBVolume,
  resolveBody: BodyResolver,
  baseRefs?: string,
  kbRef?: string,
): Promise<string | undefined> {
  const kept = baseRefs ? stripKbRefSuffix(baseRefs, kbRef).trim() : ''
  const body = await resolveBody(vol.kbId)
  // V2-F05：断点续跑引用的知识库已删除/损坏时不得静默脱离资料继续生成（否则“按知识库续跑”实为无源出题）。
  // 抛出可识别错误，保留草稿并提示用户重新选择资料。
  if (!body) {
    throw new AIError('KB_SOURCE_MISSING', `知识库「${vol.kbName}」已删除或损坏，请重新选择知识库后再继续生成`)
  }
  const head = sanitizeInput(vol.kbName) ? `【参考资料 · ${sanitizeInput(vol.kbName)}】` : '【参考资料】'
  const slice = body.slice(vol.start, vol.end)
  const volText = `${head}\n${sanitizeInput(slice)}`
  const out = kept ? `${kept}\n\n${volText}` : volText
  return out || undefined
}

/** 断点续跑：还有多少卷未完成（累计目标 > 已生成题数的卷数；按去重后的目标档位计数，
 *  T<V 时多个零配额卷共享同一目标档，不会虚报「剩余卷数」）。 */
export function remainingVolumeCount(
  structure: Record<QuestionTypeId, number>,
  volumes: KBVolume[],
  done: number,
): number {
  const cums = cumulativeVolumeStructures(structure, volumes.length)
  const targets = new Set(cums.map(structTotal))
  return [...targets].filter((t) => t > done).length
}
