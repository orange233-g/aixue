import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { Pack, Session, LearningState, UsageRecord, WrongRecord, AnswerRecord, KBDoc } from '../types'

interface AixueDB extends DBSchema {
  packs: {
    key: string
    value: Pack
    indexes: { category: string; created_at: number }
  }
  sessions: {
    key: string
    value: Session
    indexes: { created: number }
  }
  learning: {
    key: string
    value: LearningState
    indexes: { next_review: string; state: string }
  }
  wrongs: {
    key: string
    value: WrongRecord
    indexes: { packId: string; mastered: string }
  }
  wrongs_v2: {
    key: string
    value: WrongRecord & { key: string }
    indexes: { packId: string; mastered: string; questionId: string }
  }
  usage: {
    key: IDBValidKey
    value: UsageRecord
    indexes: { timestamp: number; module: string }
  }
  config: {
    key: string
    value: { key: string; value: unknown }
  }
  categories: {
    key: string
    value: { name: string }
  }
  answers: {
    key: number
    value: AnswerRecord
    indexes: { timestamp: number; packId: string }
  }
  knowledge_bases: {
    key: string
    value: KBDoc
    indexes: { created_at: number }
  }
  /** 语义索引向量（V-EMB 一期）：key=kbId，向量按 sections 下标对齐（仅 embedStatus=ready 的库有值） */
  kb_vectors: {
    key: string
    value: {
      kbId: string
      /** 锚点向量列表（S2 规模自适应：full 模式下锚点数 ≥ sections 数，经 anchorSectionIdx 映射回节） */
      vectors: Float32Array[]
      /** 向量维度（校验与模型一致用） */
      dim: number
      /** 使用的 embedding 模型 id（一库一模型，切换需重建） */
      modelId: string
      /** 锚点→节下标映射（S2+；旧库缺省 = 1 锚点/节，检索端按「下标=节下标」兜底） */
      anchorSectionIdx?: number[]
      /** 部分完成标记（断点续建）：生成中断时 vectors 为「已算完的前缀」，此值=已完成段数；
       *  完整索引无此字段。续建时跳过前缀只补剩余（真机 6.x：8180 段中断重头再来不可接受） */
      partialDone?: number
    }
  }
}

const DB_NAME = 'ai-xue'
const DB_VERSION = 9

let dbPromise: Promise<IDBPDatabase<AixueDB>> | null = null

/**
 * 版本迁移（见 PRD 11.4）：只增不改，按 oldVersion 分步迁移。
 * 字段变更通过读取时兼容（旧数据缺字段给默认值），避免破坏性迁移。
 * V1 → V2：packs 新增 source 字段（类型可选，读取时默认 'ai'，无需改写存量数据）。
 */
export function getDB(): Promise<IDBPDatabase<AixueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AixueDB>(DB_NAME, DB_VERSION, {
      blocked() {
        // 升级被其他标签页的旧连接阻塞时，等待其关闭（见 PRD 11.4）
        console.warn('[db] upgrade blocked by another open connection, waiting...')
      },
      upgrade(db, oldVersion) {
        // V1 初始 schema
        if (oldVersion < 1) {
          const packs = db.createObjectStore('packs', { keyPath: 'id' })
          packs.createIndex('category', 'category')
          packs.createIndex('created_at', 'created_at')
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
          sessions.createIndex('created', 'created')
          const learning = db.createObjectStore('learning', { keyPath: 'kp_id' })
          learning.createIndex('next_review', 'next_review')
          learning.createIndex('state', 'state')
          const wrongs = db.createObjectStore('wrongs', { keyPath: 'questionId' })
          wrongs.createIndex('packId', 'packId')
          wrongs.createIndex('mastered', 'mastered')
          const usage = db.createObjectStore('usage', { keyPath: 'id' })
          usage.createIndex('timestamp', 'timestamp')
          usage.createIndex('module', 'module')
          db.createObjectStore('config', { keyPath: 'key' })
          db.createObjectStore('categories', { keyPath: 'name' })
        }
        // V2 → V3：新增 wrongs 错题存储（V2 及以下版本需补建）
        if (oldVersion < 3 && !db.objectStoreNames.contains('wrongs')) {
          const wrongs = db.createObjectStore('wrongs', { keyPath: 'questionId' })
          wrongs.createIndex('packId', 'packId')
          wrongs.createIndex('mastered', 'mastered')
        }
        // V3 → V4：新增 answers 作答记录（首页统计当日已刷题数 / 最近学习时间）
        if (oldVersion < 4 && !db.objectStoreNames.contains('answers')) {
          const answers = db.createObjectStore('answers', { keyPath: 'id', autoIncrement: true })
          answers.createIndex('timestamp', 'timestamp')
          answers.createIndex('packId', 'packId')
        }
        // 新增 knowledge_bases 知识库 store（文件导入+知识库需求）。
        // 无条件幂等补建：任何一次 upgrade 只要缺该 store 就补建，自愈「版本号已到但建表遗漏」的脏 DB
        // （曾出现 version=5/6 却无 knowledge_bases，导致 load/put 报 NotFoundError；用 oldVersion<N
        //  守卫无法覆盖「版本号已是目标值时不再触发 upgrade」的情况，故改为无条件 contains 判断）。
        if (!db.objectStoreNames.contains('knowledge_bases')) {
          const kbs = db.createObjectStore('knowledge_bases', { keyPath: 'id' })
          kbs.createIndex('created_at', 'created_at')
        }
        // V8：kb_vectors 语义索引向量 store（同样无条件幂等补建）
        if (!db.objectStoreNames.contains('kb_vectors')) {
          db.createObjectStore('kb_vectors', { keyPath: 'kbId' })
        }
        // V9：错题按「题包 + 题目」复合键存储，避免不同题包的同名题目相互覆盖。
        if (!db.objectStoreNames.contains('wrongs_v2')) {
          const wrongs = db.createObjectStore('wrongs_v2', { keyPath: 'key' })
          wrongs.createIndex('packId', 'packId')
          wrongs.createIndex('mastered', 'mastered')
          wrongs.createIndex('questionId', 'questionId')
        }
      },
    })
  }
  return dbPromise
}

/** 重置数据库连接（测试用，或 HMR 后需要重建连接时调用） */
export function resetDB(): void {
  dbPromise = null
}

/** 清空所有 store（用于测试/数据管理） */
export async function clearAllStores(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['packs', 'sessions', 'learning', 'wrongs', 'wrongs_v2', 'usage', 'config', 'categories', 'answers', 'knowledge_bases', 'kb_vectors'], 'readwrite')
  for (const name of ['packs', 'sessions', 'learning', 'wrongs', 'wrongs_v2', 'usage', 'config', 'categories', 'answers', 'knowledge_bases', 'kb_vectors'] as const) {
    await tx.objectStore(name).clear()
  }
  await tx.done
}

/** 迁移失败兜底：初始化失败不阻塞首屏，返回空数据可正常使用 */
export async function initDB(): Promise<boolean> {
  try {
    await getDB()
    return true
  } catch (e) {
    console.error('[db] init failed:', e)
    return false
  }
}

// ---- packs ----
export const dbPacks = {
  async getAll(): Promise<Pack[]> {
    const db = await getDB()
    return db.getAll('packs')
  },
  async get(id: string): Promise<Pack | undefined> {
    const db = await getDB()
    return db.get('packs', id)
  },
  async getByCategory(category: string): Promise<Pack[]> {
    const db = await getDB()
    return db.getAllFromIndex('packs', 'category', category)
  },
  async put(pack: Pack): Promise<void> {
    const db = await getDB()
    await db.put('packs', pack)
  },
  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('packs', id)
  },
  /** 删除题包并级联清理其学习记录与错题（事务保证原子性，见 PRD 11.5）。
   *  对畸形/空题包（缺 questions/chapters/meta 等字段）同样容错删除，避免级联时抛错导致删除失败。 */
  async deletePack(pack: Pack): Promise<void> {
    const db = await getDB()
    const tx = db.transaction(['packs', 'learning', 'wrongs', 'wrongs_v2', 'answers'], 'readwrite')
    await tx.objectStore('packs').delete(pack.id)
    const kpIds = (pack.questions ?? []).map((q) => q.kp_ids ?? []).flat()
    const learning = tx.objectStore('learning')
    for (const kpId of kpIds) await learning.delete(kpId)
    const wrongStore = tx.objectStore('wrongs')
    const wrongs = (await wrongStore.index('packId').getAll(pack.id)) ?? []
    for (const w of wrongs) await wrongStore.delete(w.questionId)
    const wrongStoreV2 = tx.objectStore('wrongs_v2')
    const wrongsV2 = (await wrongStoreV2.index('packId').getAll(pack.id)) ?? []
    for (const w of wrongsV2) await wrongStoreV2.delete(w.key)
    const answerStore = tx.objectStore('answers')
    const answers = (await answerStore.index('packId').getAll(pack.id)) ?? []
    for (const a of answers) await answerStore.delete(a.id)
    await tx.done
  },
  /** 分类删除时：把该分类下题包移至未分类 */
  async moveCategoryToUncategorized(category: string): Promise<void> {
    const db = await getDB()
    const tx = db.transaction('packs', 'readwrite')
    const store = tx.objectStore('packs')
    const packs = await store.index('category').getAll(category)
    for (const p of packs) {
      await store.put({ ...p, category: '' })
    }
    await tx.done
  },
}

// ---- sessions ----
const SESSION_LIMIT = 50

export const dbSessions = {
  async getAll(): Promise<Session[]> {
    const db = await getDB()
    return db.getAll('sessions')
  },
  async get(id: string): Promise<Session | undefined> {
    const db = await getDB()
    return db.get('sessions', id)
  },
  async put(session: Session): Promise<void> {
    const db = await getDB()
    await db.put('sessions', session)
  },
  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('sessions', id)
  },
  /** 会话上限清理：保留最近 N 个，超出删除最旧（见 PRD 11.5）。
   *  V2-P07：用 created 升序索引游标只取最旧多出的记录删除，避免每次 getAll+sort 全量反序列化。 */
  async trim(): Promise<void> {
    const db = await getDB()
    const count = await db.count('sessions')
    if (count <= SESSION_LIMIT) return
    const excess = count - SESSION_LIMIT
    const tx = db.transaction('sessions', 'readwrite')
    const store = tx.objectStore('sessions')
    let cursor = await store.index('created').openCursor()
    let removed = 0
    while (cursor && removed < excess) {
      await cursor.delete()
      removed++
      cursor = await cursor.continue()
    }
    await tx.done
  },
}

// ---- learning ----
export const dbLearning = {
  async getAll(): Promise<LearningState[]> {
    const db = await getDB()
    return db.getAll('learning')
  },
  async get(kpId: string): Promise<LearningState | undefined> {
    const db = await getDB()
    return db.get('learning', kpId)
  },
  async put(state: LearningState): Promise<void> {
    const db = await getDB()
    await db.put('learning', state)
  },
  async delete(kpId: string): Promise<void> {
    const db = await getDB()
    await db.delete('learning', kpId)
  },
  /** 今日到期复习队列（next_review <= 今天） */
  async getDue(today: string): Promise<LearningState[]> {
    const db = await getDB()
    const all = await db.getAllFromIndex('learning', 'next_review')
    return all.filter((s) => s.next_review <= today)
  },
  /** 按掌握状态筛选 */
  async getByState(state: string): Promise<LearningState[]> {
    const db = await getDB()
    return db.getAllFromIndex('learning', 'state', state)
  },
}

// ---- wrongs ----
export const wrongKey = (packId: string, questionId: string): string => `${packId}::${questionId}`
let legacyWrongMigration: Promise<void> | null = null

async function migrateLegacyWrongs(): Promise<void> {
  if (!legacyWrongMigration) {
    legacyWrongMigration = (async () => {
      const db = await getDB()
      const current = await db.getAll('wrongs_v2')
      if (current.length > 0) return
      const legacy = await db.getAll('wrongs')
      if (legacy.length === 0) return
      const tx = db.transaction('wrongs_v2', 'readwrite')
      for (const record of legacy) {
        await tx.store.put({ ...record, key: wrongKey(record.packId, record.questionId) })
      }
      await tx.done
    })().catch((e) => {
      legacyWrongMigration = null
      throw e
    })
  }
  await legacyWrongMigration
}

export const dbWrongs = {
  async getAll(): Promise<WrongRecord[]> {
    const db = await getDB()
    await migrateLegacyWrongs()
    return db.getAll('wrongs_v2')
  },
  async get(questionId: string): Promise<WrongRecord | undefined> {
    const db = await getDB()
    await migrateLegacyWrongs()
    return db.getFromIndex('wrongs_v2', 'questionId', questionId)
  },
  async put(record: WrongRecord): Promise<void> {
    const db = await getDB()
    await migrateLegacyWrongs()
    await db.put('wrongs_v2', { ...record, key: wrongKey(record.packId, record.questionId) })
  },
  async delete(questionId: string, packId?: string): Promise<void> {
    const db = await getDB()
    await migrateLegacyWrongs()
    const tx = db.transaction('wrongs_v2', 'readwrite')
    const records = await tx.store.index('questionId').getAll(questionId)
    for (const record of records) {
      if (!packId || record.packId === packId) await tx.store.delete(record.key)
    }
    await tx.done
  },
  /** 按题包查询（级联清理用） */
  async getByPack(packId: string): Promise<WrongRecord[]> {
    const db = await getDB()
    await migrateLegacyWrongs()
    return db.getAllFromIndex('wrongs_v2', 'packId', packId)
  },
  async getByPackAndQuestion(packId: string, questionId: string): Promise<WrongRecord | undefined> {
    const db = await getDB()
    await migrateLegacyWrongs()
    return db.get('wrongs_v2', wrongKey(packId, questionId))
  },
}

// ---- usage ----
const USAGE_LIMIT = 2000

export const dbUsage = {
  async getAll(): Promise<UsageRecord[]> {
    const db = await getDB()
    return db.getAll('usage')
  },
  async add(record: UsageRecord): Promise<void> {
    const db = await getDB()
    await db.put('usage', record)
    await this.trim()
  },
  /** 用量上限清理：最多保留 2000 条，超出丢弃最旧。
   *  I-04：先用 count 判断是否超限（O(1)，非全表），需要清理才走 timestamp 升序索引游标逐条删最旧，
   *  避免每次写入都 getAll()+sort() 造成批量生题时高频全表扫描。 */
  async trim(): Promise<void> {
    const db = await getDB()
    const count = await db.count('usage')
    if (count <= USAGE_LIMIT) return
    let toDelete = count - USAGE_LIMIT
    const tx = db.transaction('usage', 'readwrite')
    const idx = tx.objectStore('usage').index('timestamp')
    let cursor = await idx.openCursor() // ascending → 最旧在前
    while (cursor && toDelete > 0) {
      cursor.delete()
      toDelete--
      cursor = await cursor.continue()
    }
    await tx.done
  },
  /** 时间窗查询（统计页） */
  async getByRange(from: number, to: number): Promise<UsageRecord[]> {
    const db = await getDB()
    return db.getAllFromIndex('usage', 'timestamp', IDBKeyRange.bound(from, to))
  },
  /** 按板块查询 */
  async getByModule(module: string): Promise<UsageRecord[]> {
    const db = await getDB()
    return db.getAllFromIndex('usage', 'module', module)
  },
  /** 清空全部用量记录（统计页，需二次确认） */
  async clear(): Promise<void> {
    const db = await getDB()
    await db.clear('usage')
  },
}

// ---- config ----
export const dbConfig = {
  async get(key: string): Promise<unknown> {
    const db = await getDB()
    const row = await db.get('config', key)
    return row?.value
  },
  async set(key: string, value: unknown): Promise<void> {
    const db = await getDB()
    await db.put('config', { key, value })
  },
  /** 全量扫描（清理孤儿草稿等场景，见 PRD 4.9 草稿 24 小时过期） */
  async getAll(): Promise<{ key: string; value: unknown }[]> {
    const db = await getDB()
    return db.getAll('config')
  },
  /** V2-P09：真正删除记录而非写 null，避免 getAll() 永久扫描墓碑键 */
  async delete(key: string): Promise<void> {
    const db = await getDB()
    await db.delete('config', key)
  },
}

// ---- answers ----
export const dbAnswers = {
  async add(record: Omit<AnswerRecord, 'id'>): Promise<void> {
    const db = await getDB()
    // keyPath 自增 id 由 idb 生成，类型上需完整值，运行时省略 key 由 autoIncrement 填充
    await db.add('answers', record as AnswerRecord)
  },
  async getAll(): Promise<AnswerRecord[]> {
    const db = await getDB()
    return db.getAll('answers')
  },
  /** 时间窗查询（当日已刷题数 / 最近学习时间） */
  async getByRange(from: number, to: number): Promise<AnswerRecord[]> {
    const db = await getDB()
    return db.getAllFromIndex('answers', 'timestamp', IDBKeyRange.bound(from, to))
  },
  /** 按题包查询（级联清理用） */
  async getByPack(packId: string): Promise<AnswerRecord[]> {
    const db = await getDB()
    return db.getAllFromIndex('answers', 'packId', packId)
  },
}

// ---- categories ----
export const dbCategories = {
  async getAll(): Promise<string[]> {
    const db = await getDB()
    const rows = await db.getAll('categories')
    return rows.map((r) => r.name)
  },
  async add(name: string): Promise<void> {
    const db = await getDB()
    await db.put('categories', { name })
  },
  async delete(name: string): Promise<void> {
    const db = await getDB()
    await db.delete('categories', name)
  },
}

// ---- knowledge_bases ----
export const dbKB = {
  async getAll(): Promise<KBDoc[]> {
    const db = await getDB()
    return db.getAll('knowledge_bases')
  },
  async get(id: string): Promise<KBDoc | undefined> {
    const db = await getDB()
    return db.get('knowledge_bases', id)
  },
  async put(doc: KBDoc): Promise<void> {
    const db = await getDB()
    await db.put('knowledge_bases', doc)
  },
  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('knowledge_bases', id)
  },
}

// ---- kb_vectors（V-EMB 一期：语义索引向量，与 knowledge_bases 同生命周期） ----
export const dbKBVectors = {
  async get(kbId: string) {
    const db = await getDB()
    return db.get('kb_vectors', kbId)
  },
  async put(kbId: string, vectors: Float32Array[], dim: number, modelId: string, anchorSectionIdx?: number[]): Promise<void> {
    const db = await getDB()
    // anchorSectionIdx 可选：旧库（1 锚点/节）缺省时检索端按「下标=节下标」兜底（向后兼容）
    await db.put('kb_vectors', { kbId, vectors, dim, modelId, anchorSectionIdx })
  },
  /** 断点续建：写入已算完的前缀向量 + partialDone 标记（每批一次，中断后可跳过前缀续算） */
  async putPartial(kbId: string, vectors: Float32Array[], dim: number, modelId: string, anchorSectionIdx: number[], done: number): Promise<void> {
    const db = await getDB()
    await db.put('kb_vectors', { kbId, vectors, dim, modelId, anchorSectionIdx, partialDone: done })
  },
  async delete(kbId: string): Promise<void> {
    const db = await getDB()
    await db.delete('kb_vectors', kbId)
  },
}

export type { AixueDB }
export { DB_NAME, DB_VERSION }

/** 刷题提交专用单事务类型（V2-F02 / V2-I01）：learning + wrongs + answers + config 同一 readwrite 事务，
 *  业务层在其中读旧值→算新值→写入，任一步失败整体回滚，杜绝多点写造成的半提交/重复累计。 */
export type QuizSubmissionTx = IDBPTransaction<AixueDB, ['learning', 'wrongs', 'wrongs_v2', 'answers', 'config'], 'readwrite'>;

/**
 * 打开刷题提交单事务并执行 fn：全部成功才提交，任一异常 abort 回滚。
 * submissionId 幂等：首次成功在 config 落标记，重放同一 submissionId 直接跳过（防止失败重试重复累计）。
 */
export async function withQuizSubmissionTransaction<T>(fn: (tx: QuizSubmissionTx) => Promise<T>): Promise<T> {
  const db = await getDB()
  const tx = db.transaction(['learning', 'wrongs', 'wrongs_v2', 'answers', 'config'], 'readwrite')
  try {
    const result = await fn(tx)
    await tx.done
    return result
  } catch (e) {
    // V4-I03：tx.abort() 可能因事务已自动 abort / 进入 inactive 而再次抛错，须单独 try/catch，
    // 避免用 abort 阶段的二次异常覆盖业务层原始异常；无论 abort 是否成功都消费 tx.done 的拒绝。
    try {
      tx.abort()
    } catch {
      /* 忽略二次 abort 失败，保留原始异常给调用方 */
    }
    // abort 后 tx.done 会以 AbortError 拒绝：此处虽不在成功路径，仍需消费其拒绝，
    // 否则会成为未处理 rejection（在 Node/fake-indexeddb 下被判定为 unhandled error）
    tx.done.catch(() => {})
    throw e
  }
}
