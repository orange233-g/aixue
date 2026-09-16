import type { GenerationDraft, Pack, Session } from '../../types'
import { dbSessions, getDB } from '../../db'
import { uid } from '../../utils'

/** 生成草稿在 config store 的 key 前缀（与 useGenerateStore 的 draftKey 保持一致） */
const DRAFT_KEY_PREFIX = 'gen-draft:'

/** 会话启动时的配置快照（见 PRD 4.4.3：切换 API 不影响进行中的会话） */
export interface SessionSnapshot {
  providerId: string
  model: string
}

/** 快照编解码：存于 Session.provider（JSON 字符串），兼容旧格式纯厂商 id */
export function encodeSnapshot(s: SessionSnapshot): string {
  return JSON.stringify(s)
}

export function decodeSnapshot(raw: string): SessionSnapshot {
  if (!raw) return { providerId: '', model: '' }
  try {
    const p = JSON.parse(raw)
    if (p && typeof p.providerId === 'string') {
      return { providerId: p.providerId, model: typeof p.model === 'string' ? p.model : '' }
    }
  } catch {
    /* 旧格式：provider 直接存厂商 id */
  }
  return { providerId: raw, model: '' }
}

/** 自动生成会话/题包标题：取首条输入前 80 字（此前 40 字截断导致题包详情无法展示详细名称） */
export function autoTitle(input: string): string {
  const t = input.trim().replace(/\s+/g, ' ')
  return t.length > 80 ? t.slice(0, 80) + '…' : t
}

export function createSession(input: string, snapshot: SessionSnapshot): Session {
  return {
    id: uid('s_'),
    title: autoTitle(input),
    created: Date.now(),
    summary: '',
    messages: [],
    packages: [],
    provider: encodeSnapshot(snapshot),
  }
}

export async function saveSession(session: Session): Promise<void> {
  await dbSessions.put(session)
  await dbSessions.trim()
}

/** V2 轻量 normalize（实施路线 15 节步骤 2）：旧会话缺 generationDraft 自然为 undefined；
 *  已有草稿但数组字段缺失（异常中断写入等）只补默认值，绝不修改旧消息语义。 */
export function normalizeSession(s: Session): Session {
  const d = s.generationDraft
  if (!d) return s
  const lifecycleOk = d.lifecycle === 'active' || d.lifecycle === 'generating' || d.lifecycle === 'completed' || d.lifecycle === 'cancelled'
  const fixed: GenerationDraft = {
    ...d,
    requirements: Array.isArray(d.requirements) ? d.requirements : [],
    appliedTurnIds: Array.isArray(d.appliedTurnIds) ? d.appliedTurnIds : [],
    turnIssues: Array.isArray(d.turnIssues) ? d.turnIssues : [],
    lifecycle: lifecycleOk ? d.lifecycle : 'active',
  }
  return fixed === d ? s : { ...s, generationDraft: fixed }
}

export async function loadSession(id: string): Promise<Session | undefined> {
  const s = await dbSessions.get(id)
  return s ? normalizeSession(s) : s
}

/** V2 草稿落库串行链（实施路线 5.3）：与 useGenerateStore 内部的 saveSessionSerial
 *  职责一致（排队写入防乱序覆盖），但失败**必须向上抛出**——V2 草稿提交不能静默吞掉失败，
 *  调用方负责记录脱敏日志并提示「方案暂未保存，刷新可能丢失」。
 *  链本身不因单次失败断裂：后续保存继续排队。 */
let draftSaveChain: Promise<void> = Promise.resolve()
export function saveSessionSerial(session: Session): Promise<void> {
  const task = draftSaveChain.then(() => saveSession(session))
  draftSaveChain = task.then(
    () => undefined,
    () => undefined, // 失败已由返回的 task 向调用方传播；链保持可用
  )
  return task
}

export async function deleteSession(id: string): Promise<void> {
  await dbSessions.delete(id)
}

export async function listSessions(): Promise<Session[]> {
  const all = await dbSessions.getAll()
  return all.map(normalizeSession).sort((a, b) => b.created - a.created)
}

/**
 * V2-F03：题包入库「packs + sessions + config 草稿清除」放在**同一** IndexedDB
 * readwrite 事务内原子提交：题包写入、涉及该题包的会话引用置 in_bank、草稿删除，任一失败整体回滚，
 * 杜绝「实体已入库但会话仍是草稿 / 前后半完成态」。
 * 事务完成后由调用方刷新 Zustand。
 */
export async function addPackToBankAtomic(
  pack: Pack,
  opts: { packId: string; questionCount: number },
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['packs', 'sessions', 'config'], 'readwrite')
  const packsStore = tx.objectStore('packs')
  const sessStore = tx.objectStore('sessions')
  const cfgStore = tx.objectStore('config')

  packsStore.put(pack)
  // 清草稿：真正删除 config 草稿键（V3-F04：不用「写 {key, value: null}」的墓碑，避免 getAll 永久残留空记录）
  cfgStore.delete(`${DRAFT_KEY_PREFIX}${pack.id}`)

  // 会话：事务内读取全部，把该题包引用置 in_bank 后统一写回（原子，避免半提交）
  const all = await sessStore.getAll()
  for (const s of all) {
    let changed = false
    for (const m of s.messages ?? []) {
      if (m.result?.id === opts.packId && m.result.status !== 'in_bank') {
        m.result.status = 'in_bank'
        m.result.questionCount = opts.questionCount
        m.result.validCount = opts.questionCount
        changed = true
      }
    }
    if (changed) sessStore.put(s)
  }
  await tx.done
}
