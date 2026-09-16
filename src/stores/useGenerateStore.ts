import { create } from 'zustand'
import type { AIConfig, ChatAction, DraftPatch, DraftSourceAction, DraftUserAction, GenerationExecutionSpec, KbScope, Message, Pack, PackageRef, Question, QuestionTypeId, RejectStats, Session } from '../types'
import { MAX_QUESTIONS_PER_GENERATION, MAX_PER_TYPE, QUESTION_TYPES } from '../types'
import { useAI } from './useAIStore'
import { usePacks } from './usePackStore'
import { useKB } from './useKBStore'
import { useUI } from './useUIStore'
import { dbKB } from '../db'
import { log, logGenOutput } from '../utils/log'
import {
  createSession,
  saveSession,
  listSessions,
  loadSession,
  autoTitle,
  buildPackStructureInfo,
  enrichPackMeta,
  extractTopicTitle,
  decodeSnapshot,
  encodeSnapshot,
  buildChatContext,
  estimateTokens,
  GEN_CONTINUE_LABEL,
  CHAT_FAIL_FALLBACK,
  CONTINUE_FAIL_FALLBACK,
  genResumeLabel,
  DEFAULT_CONTEXT_WINDOW,
  compressSummary,
  describeGenerated,
  maybeCompressChat,
  addPackToBankAtomic,
  type GenerateProgress,
  type EnrichedMeta,
  type SessionSnapshot,
} from '../services/generation'
import { chat } from '../ai/gateway'
import { AIError } from '../ai/types'
import { defaultStructure, zeroStructure } from '../services/generation/structure'
import { generationStart } from '../workers/generationWorkerClient'
import {
  buildDraftMessages,
  buildDraftRetryMessages,
} from '../services/generation/draftContext'
import {
  extractExplicitDraftPatch,
  mergeLocalAndModelPatch,
  parseDraftPatchWire,
  ProtocolTailFilter,
  stripWireFences,
} from '../services/generation/draftProtocol'
import type { DraftProtocolErrorCode } from '../services/generation/draftProtocol'
import {
  requiresDraftProtocol,
  resolveFinalIntent,
  resolveLocalCancel,
} from '../services/generation/draftTurnPolicy'
import { hasExplicitGenIntent, isAdjustment, isGenAbort, isVagueCountAdjustment } from '../services/generation/intentRules'
import { resolveDraftSourceAction, resolveGenerationSource } from '../services/generation/generationSource'
import { buildGenerationExecutionSpec, buildQuickExecutionSpec } from '../services/generation/generationSpec'
import {
  applyDraftTurn,
  beginDraftGeneration,
  cancelDraft,
  clearDraftTurnIssues,
  completeDraftGeneration,
  failDraftGeneration,
  reopenDraft,
  withDraftTurnIssues,
} from '../services/generation/draftReducer'
import { evaluateGenerationDraft } from '../services/generation/draftValidation'
import {
  buildDraftNextQuestion,
  formatGenerationDraft,
} from '../services/generation/draftPresentation'
import {
  loadSession as loadSessionById,
  saveSessionSerial as saveSessionDraftStrict,
} from '../services/generation/session'
import { cumulativeVolumeStructures, remainingVolumeCount, volumeRunRefs } from '../services/kb/scope'
import { validateQuestion, validateCount, validateDuplicate } from '../services/validation'
import { countValidQuestions } from '../services/generation/resultStats'
import { dbConfig, dbSessions, dbPacks } from '../db'
import { pickUniqueTitle } from '../services/packNaming'
import { uid } from '../utils'

export type GenPhase = 'idle' | 'chatting' | 'generating' | 'validating' | 'done'

/** 对话式生题的乐观写入参数。 */
export interface GenOpts {
  userMsgAdded?: boolean
  placeholderId?: string
  kbScope?: KbScope
  /** 对话式生题 V2（实施路线 17 节）：本轮用户消息 id（= V2 turnId，防重复应用/迟到门禁）。
   *  消息入队/乐观写入时即确定，队列项真正开始处理时透传给控制器。 */
  userMessageId?: string
  /** 本轮携带的参考资料块（导入文件/知识库检索块）：V2 来源归一用（sourceMessageId 指向本轮用户消息） */
  refs?: string
}

export interface ValidationSummary {
  total: number
  passed: number
  issueCount: number
  issuesByQuestion: Record<string, string[]>
  duplicateCount: number
  countIssues: string[]
}

/** 题包生成历史里的一条记录（跨会话汇总，见生成页「题包生成历史」弹窗） */
export interface GenPackRecord {
  sessionId: string
  /** 会话创建时间（用于列表里按时间倒序展示） */
  created: number
  title: string
  ref: PackageRef
  /** 完整题包数据（简介/题型/目录等）：draft 从草稿区读、in_bank 从题库读；读不到则 undefined */
  pack?: Pack
}

/** 流式回复中排队待发的下一条消息（借鉴 Cherry Studio follow-up 队列：回复中不禁用发送） */
export interface PendingChat {
  input: string
  placeholderId: string
  /** V2 turnId：入队时即确定的用户消息 id（17 节并发规则：draftId/revision 在队列项开始处理时另读） */
  userMessageId?: string
}

interface GenerateStore {
  session: Session | null
  sessionList: Session[]
  loaded: boolean
  structure: Record<QuestionTypeId, number>
  structureMode: 'ai' | 'custom'
  structureTotal: number
  templates: Record<string, Record<QuestionTypeId, number>>
  /** 默认题型 = 被选中的模板名（见 PRD 4.6：默认题型与题型模板统一为一套） */
  defaultTemplate: string | null
  phase: GenPhase
  progress: GenerateProgress | null
  validation: ValidationSummary | null
  error: string | null
  abort: AbortController | null
  drafts: Record<string, Pack>
  lastInput: string
  /** 流式回复中排队待发的下一条消息（借鉴 Cherry Studio follow-up 队列） */
  pendingChats: PendingChat[]
  /** 本次生成开始时间戳（generating 起算，含校验阶段），生成中用于实时计时 */
  startAt: number | null
  /** 最近一次生成的总耗时（ms），生成完成后展示 */
  lastElapsed: number | null
  /** 最近一次生成的缺口题数（部分完成/中断补齐后 >0）：完成面板据此诚实标注「部分完成」而非「生成完成」 */
  lastDeficit: number
  /** 解析校验阶段已解析题数 / 总题数（第二阶段进度，见两阶段 UX） */
  parsed: number
  parseTotal: number
  /** 多卷生成进度（Phase 3）：当前第几卷/共几卷，单卷/无范围时为 null；与 progress 并存显示「第 i/V 卷」 */
  volumeProgress: { cur: number; total: number } | null
  /** 仅测试用：生成过程中实时累积的模型流式返回原文（DEV 下由 onToken 写入，生产不启用此回调） */
  liveRaw: string

  load: () => Promise<void>
  refreshSessions: () => Promise<void>
  /** 把跨会话的未过期草稿并入 drafts，供聊天记录流里直接入库/编辑（聊天化改造） */
  hydrateDrafts: () => Promise<void>
  /** 一键清空历史会话记录：删除全部会话 + 未入库草稿；已入库题包保留在题库 */
  clearSessions: () => Promise<void>
  /** 汇总所有会话里的生成题包记录（供「题包生成历史」弹窗） */
  listGeneratedPacks: () => Promise<GenPackRecord[]>
  applyDefaults: () => void
  setMode: (mode: 'ai' | 'custom') => void
  setStructure: (type: QuestionTypeId, count: number) => void
  setAiTotal: (count: number) => void
  applyStructure: (s: Record<QuestionTypeId, number>, mode?: 'ai' | 'custom') => void
  saveTemplate: (name: string, structure?: Record<QuestionTypeId, number>) => void
  deleteTemplate: (name: string) => void
  setDefaultTemplate: (name: string | null) => void
  getDefaultStructure: () => Record<QuestionTypeId, number>
  /** 对话式生题入口：乐观写入用户消息 → 意图识别分流（生题 → generate，聊天 → chat）。
   *  refs 为可选参考资料块（导入文件/知识库引用），随本条用户消息持久化，聊天/生题时拼到正文之后。
   *  kbScope 为生题范围（引用知识库出题时传入卷序列）：确认消息预告卷数、generate 时多卷串行。 */
  send: (input: string, refs?: string, kbScope?: KbScope) => Promise<void>
  /** 聊天分支：流式回复；opts.userMsgAdded 时用户消息已由 send() 上屏 */
  chat: (input: string, cfg: AIConfig, snap: SessionSnapshot, opts?: GenOpts) => Promise<void>
  /** 对话式生题 V2 控制器：所有对话式生题轮次均从这里进入 */
  handleGenerationDraftTurn: (args: {
    input: string
    cfg: AIConfig
    snapshot: SessionSnapshot
    userMsgAdded?: boolean
    placeholderId?: string
    userMessageId?: string
    refs?: string
    kbScope?: KbScope
    /** 取消后的剩余聊天请求：草稿已取消，本轮只聊天不再改任何草稿 */
    forceChat?: boolean
  }) => Promise<void>
  /** TASK-08：从活动草稿一键启动生成（不可变 spec；防双击/旧 revision 门禁） */
  startGenerationFromDraft: (draftId: string, revision: number) => Promise<void>
  /** TASK-08：统一取消（文字/卡片/任务条同源，7.5；生成中先停执行再收敛生命周期） */
  cancelGenerationDraft: (reason: 'text' | 'card' | 'taskbar') => void
  /** 完成态方案重新打开：重读 IndexedDB 后 completed → active，供本地编辑并再次生成 */
  reopenGenerationDraft: () => Promise<boolean>
  /** TASK-08：活动方案卡本地编辑（7.6 DraftUserAction → 受信任本地 patch → 同一 reducer/validator） */
  updateGenerationDraft: (action: DraftUserAction) => void
  generate: (input: string, opts?: GenOpts) => Promise<void>
  /** 断点续跑：按草稿 genTarget 补齐缺口（中断/不足交付后一键继续） */
  resume: (packId: string) => Promise<void>
  /** 停止当前生成/回复：复用统一 abort（含聊天流式与生题），对齐 Cherry Studio 的 stop() */
  cancel: () => void
  /** 清除某条助手消息下方的建议操作按钮（点「取消」后不再显示） */
  dismissActions: (msgId: string) => void
  /** 重新生成上一条用户消息的回复（停止/失败后「继续/重新回复」）：按原意图分诊（生成题目→开面板，普通聊天→重跑流式） */
  regenerateLast: () => Promise<void>
  /** 续写被截断的聊天回复：从该消息末尾让模型接着生成（应对 finish_reason=length 的静默截断，借鉴 Cherry 输出上限+截断可见） */
  continueReply: (msg: Message) => Promise<void>
  /** 重试上一条回复：按原意图分诊（出题意图→重新生题，聊天→重跑流式）。区别于 regenerateLast——重试对出题意图是「直接重跑生题」而非重开面板 */
  retryLast: () => Promise<void>
  addToBank: (packId: string) => Promise<void>
  deleteDraft: (packId: string) => Promise<void>
  updateQuestion: (packId: string, questionId: string, patch: Partial<Question>) => Promise<void>
  removeQuestion: (packId: string, questionId: string) => Promise<void>
  removeIssues: (packId: string) => Promise<void>
  syncDraft: (packId: string, questions: Question[]) => Promise<void>
}

/** 结构净化：仅保留当前支持的题型 key（过滤已移除题型如 'code' 及任意非法键），
 *  防止持久化的旧模板/旧数据把废弃题型带入结构 */
function sanitizeStructure(s: Record<string, number> | undefined | null): Record<QuestionTypeId, number> {
  const valid = QUESTION_TYPES.map((t) => t.id)
  const out = {} as Record<QuestionTypeId, number>
  for (const id of valid) {
    const v = s?.[id]
    out[id] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(0, Math.round(v)) : 0
  }
  return out
}

const TEMPLATES_KEY = 'gen-templates'
/** 缺题数问询时用户回「随便/你定」或始终未给题数时，确认用的推荐兜底题数（对齐 AI 推荐模式默认总量 20） */

/** 跨卷合并被过滤题块统计（多卷流水线各卷 rejects 累加，最终一次性展示） */
function mergeRejects(a: RejectStats | undefined, b: RejectStats): RejectStats {
  if (!a) return b
  const invalidByReason: Record<string, number> = { ...a.invalidByReason }
  for (const [k, v] of Object.entries(b.invalidByReason)) invalidByReason[k] = (invalidByReason[k] ?? 0) + v
  return { parse: a.parse + b.parse, invalid: a.invalid + b.invalid, duplicate: a.duplicate + b.duplicate, invalidByReason }
}
const DEFAULT_TEMPLATE_KEY = 'gen-default-template'
const DRAFT_KEY_PREFIX = 'gen-draft:'
/** 草稿保留时长（见 PRD 4.9：确认入库前退出，草稿保留 24 小时，过期自动清理） */
const DRAFT_TTL = 24 * 60 * 60 * 1000
const draftKey = (packId: string) => `${DRAFT_KEY_PREFIX}${packId}`

function isDraftExpired(pack: Pack): boolean {
  return Date.now() - pack.created_at > DRAFT_TTL
}

async function saveDraft(pack: Pack): Promise<void> {
  await dbConfig.set(draftKey(pack.id), pack)
}

async function loadDraft(packId: string): Promise<Pack | undefined> {
  return (await dbConfig.get(draftKey(packId))) as Pack | undefined
}

async function clearDraft(packId: string): Promise<void> {
  // V2-P09：真正删除而非写 null，避免墓碑键常驻 config 表
  await dbConfig.delete(draftKey(packId))
}

/** P-01：卷正文懒加载解析器——按 kbId 从内存 bases / IndexedDB 取清洗后正文，
 * 多卷执行时据此对卷 [start,end) 切片，草稿 genTarget 因此不再携带大段卷文本。 */
async function resolveVolumeBody(kbId: string): Promise<string | undefined> {
  const cached = useKB.getState().bases.find((b) => b.id === kbId)
  if (cached) return cached.bodyText || cached.consolidated
  try {
    const doc = await dbKB.get(kbId)
    return doc ? doc.bodyText || doc.consolidated : undefined
  } catch {
    return undefined
  }
}

/** 会话落库串行链：fire-and-forget 但按调用顺序入库。
 *  聊排队续跑时，前一轮与下一轮的保存若并行化会乱序写库（旧快照后写覆盖新回复）；
 *  UI 首字不被落库阻塞，但写入严格排队保证最终库态是最近一次会话。 */
let sessionSaveChain: Promise<void> = Promise.resolve()
function saveSessionSerial(session: Session): void {
  sessionSaveChain = sessionSaveChain.then(() => saveSession(session)).catch(() => {})
}

/** 判断异常是否用户取消（中止）。网关把 AbortController 归一成了 AIError(code='ABORTED', message='已取消')，
 *  而 worker 端则抛 Error('ABORTED')——统一按「AIError.code==='ABORTED'」识别，避免漏判导致真的取消
 *  被当成普通失败、退回既没停止按钮也没正确重试路径。 */
function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true
  if (e instanceof AIError && e.code === 'ABORTED') return true
  return e instanceof Error && e.message === 'ABORTED'
}

/** 题包索引（W4i）：生成唯一入库标题——同名已存在时追加「 (n)」序号（逻辑见 packNaming 纯函数） */
function uniquePackTitle(title: string): Promise<string> {
  return dbPacks.getAll().then((existing) => pickUniqueTitle(title, existing.map((p) => p.title)))
}

function buildDraftPack(
  input: string,
  questions: Question[],
  id?: string,
  enriched?: EnrichedMeta,
  /** 续跑/补齐时沿用原题包标题，防止命名被重算改写 */
  titleOverride?: string,
): Pack {
  const info = buildPackStructureInfo(questions)
  return {
    id: id ?? uid('p_'),
    title: titleOverride ?? enriched?.title ?? extractTopicTitle(input) ?? autoTitle(input),
    category: enriched?.category ?? '',
    source: 'ai',
    meta: {
      difficulty: info.difficulty,
      objectives: info.objectives,
      tags: enriched?.tags && enriched.tags.length ? enriched.tags : info.tags,
      types: info.types,
      source: info.source,
      version: info.version,
      formatVersion: info.formatVersion,
    },
    description: info.description,
    chapters: info.chapters,
    questions,
    created_at: Date.now(),
  }
}

/** TASK-08：卡片启动同步锁——同一草稿的两次点击间隔小于任何 await，靠它实现「连点只启动一次」 */
let draftStartLockId: string | null = null
/** TASK-08：生成中用户取消意图——runGenCore 中止路径回写会话时携带旧草稿快照，
 *  启动收尾按此把草稿收敛为 cancelled，而不是被旧快照复活成 generating/active */
let draftCancelIntentId: string | null = null
/** 日志用会话 id 尾部（脱敏：不落完整 id） */
const sessionIdSlice = (id: string): string => id.slice(-8)

const createGenerateStore = () =>
  create<GenerateStore>((set, get) => {
  /** 生成执行核心（全新生成 generate 与断点续跑 resume 共用）：
   *  seed 提供已生成题目时按目标结构只补缺口（计入进度与查重）；reusePack 沿用原草稿 id/标题/分类标签。
   *  userMsgAdded 表示用户消息已由 send() 乐观写入（下游不再重复追加）；placeholderId 为 send() 的空助手占位。
   *  kbScope 为生题范围（Phase 3 多卷流水线）：每卷一次生成请求（refs 换成该卷正文、题数为累计结构缺口），
   *  串行滚动累积进同一题包；无 kbScope 时等价单卷，行为与原路径完全一致。 */
  async function runGenCore(opts: {
    input: string
    mode: 'ai' | 'custom'
    structure: Record<QuestionTypeId, number>
    seed?: Question[]
    reusePack?: Pack
    userMsgAdded?: boolean
    placeholderId?: string
    refs?: string
    kbScope?: KbScope
  }): Promise<{ questions: number; status: 'done' | 'abort' | 'fail' }> {
    const ai = useAI.getState()
    const ui = useUI.getState()
    const activeId = ai.getActiveId()
    const provider = ai.providers[activeId]
    if (!provider?.apiKey || !provider.model) {
      ui.showToast('请先配置 AI 模型（我的 → AI 设置）')
      return { questions: 0, status: 'fail' }
    }

    // 思考开关完全遵循用户在 AI 设置的配置（disableThinking），系统不再强制注入关闭——
    // 「始终思考」类模型（如 GLM flash 系）不支持关闭，适配器已有通用降级重试兜底
    const genCfg: AIConfig = {
      providers: { ...ai.providers },
      defaultId: ai.defaultId,
    }

    let s = get().session
    const snap = { providerId: activeId, model: provider.model }
    if (!s) {
      s = createSession(opts.input, snap)
    } else if (s.provider !== encodeSnapshot(snap)) {
      // 复用历史会话但在设置页换了厂商/模型：刷新快照为当前生效配置，
      // 否则本次生成会沿用旧会话快照里的旧模型（测试连通用的新模型）导致「连接成功但生成全失败」。
      // 仅覆盖 provider 快照，保留会话的历史消息与上下文。
      s = { ...s, provider: encodeSnapshot(snap) }
    }
    // send() 已乐观写入用户消息 + 空助手占位：生题完成后 runGeneration 会追加新的助手消息，
    // 这里移除占位，避免留下一个永远为空的助手气泡
    if (opts.placeholderId) {
      s.messages = s.messages.filter((m) => m.id !== opts.placeholderId)
    }

    const abort = new AbortController()
    const started = Date.now()
    const packId = opts.reusePack?.id ?? uid('p_')
    // 多卷规划（Phase 3 范围选题）：volStructs 为「累计」目标结构序列，第 i 卷缺口 = cums[i] − 已生成数
    // 恰为本卷配额；零配额卷（题数 < 卷数）与续跑已完成的卷在循环内自然跳过。
    const volumes = opts.kbScope?.volumes ?? []
    const volCount = volumes.length
    const volStructs = volCount > 0 ? cumulativeVolumeStructures(opts.structure, volCount) : [opts.structure]
    const grandTotal = Object.values(opts.structure).reduce((a, b) => a + b, 0)
    const genTarget = { input: opts.input, mode: opts.mode, structure: opts.structure, refs: opts.refs, kbScope: opts.kbScope }
    set({ phase: 'generating', progress: null, validation: null, error: null, abort, lastInput: opts.input, startAt: started, lastElapsed: null, lastDeficit: 0, liveRaw: '', volumeProgress: volCount > 1 ? { cur: 1, total: volCount } : null })

    log('info', 'pack', `生题开始 ${opts.mode} ${grandTotal} 题 ${opts.reusePack ? '（补全' + packId + '）' : ''}${volCount > 1 ? ` · 分 ${volCount} 卷` : ''}`, {
      packId, mode: opts.mode, total: grandTotal, volumes: volCount,
      input: opts.input.slice(0, 80),
      structure: opts.structure,
      providerId: activeId, model: provider.model,
    })

    // 每批结束持久化工作草稿（含目标快照，断网/停止后可「继续补齐」）
    const persistDraft = async (qs: Question[]) => {
      const p = { ...buildDraftPack(opts.input, qs, packId), genTarget }
      await saveDraft(p)
      set({ drafts: { ...get().drafts, [p.id]: p } })
    }

    // 生题原文全文（不截断，供 run-gen.log）：须在 try 外声明，catch（失败/中止）也要能读到已流式的原文
    let genRaw = ''
    // 最小结果（TASK-08）：成功/中止/失败 + 产出题数——卡片启动路径据此区分
    // 「成功或已形成 Pack 草稿 → 需求草稿置 completed」与「首次请求前失败 → 恢复 active」
    let genOutcome: { questions: number; status: 'done' | 'abort' | 'fail' } = { questions: 0, status: 'fail' }

    // 卷循环的滚动状态：catch（中止/失败）也要能读到已收齐题目与当前卷号
    let collected: Question[] = opts.seed ? [...opts.seed] : []
    let curVol = 1
    let failedBatches = 0
    let rejects: RejectStats | undefined
    let deficitByType: Partial<Record<QuestionTypeId, number>> = {}
    let updated: Session = s

    try {
      // 运行生成核心：Worker 化执行（批次网络 + SSE 解析 + IndexedDB 写入出主线程，借鉴 Cherry 的「执行与 UI 分离」）。
      // progress/token/draft 经 postMessage 回传；abort 由 client 翻译成消息。DEV 的 liveRaw 用 rAF 帧合并降频 setState。
      let live = ''
      let liveFlushScheduled = false
      const flushLive = () => {
        liveFlushScheduled = false
        if (live !== get().liveRaw) set({ liveRaw: live })
      }
      const rounds = Math.max(volCount, 1)
      for (let i = 0; i < rounds; i++) {
        if (volCount > 0) {
          // 卷级跳过：累计目标已满足的卷不再发请求（零配额卷 / 断点续跑已完成的卷）
          const cumTotal = Object.values(volStructs[i]).reduce((a, b) => a + b, 0)
          if (cumTotal <= collected.length) continue
          if (abort.signal.aborted) throw Object.assign(new Error('ABORTED'), { partial: collected })
          curVol = i + 1
          set({ volumeProgress: { cur: curVol, total: volCount } })
          // 新卷实时面板从头写入（genRaw 连续累积供排障日志）
          live = ''
        }
        // 单卷 refs 原样；多卷 refs 剥除知识库检索块（由整卷正文取代，保留文件附件块）
        const volRefs = volCount > 0 ? await volumeRunRefs(volumes[i], resolveVolumeBody, opts.refs, opts.kbScope?.kbRef) : opts.refs
        const res = await generationStart(
          {
            session: s,
            input: opts.input,
            req: {
              content: opts.input,
              structure: volCount > 0 ? volStructs[i] : opts.structure,
              source: opts.mode === 'ai' ? 'ai' : 'custom',
              refs: volRefs,
            },
            // 仅传纯数据 AIConfig（providers/defaultId），不可把含方法的整个 AI store state 传给 Worker
            // （postMessage 结构化克隆会因函数成员抛 "could not be cloned"）
            cfg: genCfg,
            seed: volCount > 0 ? (collected.length ? collected : undefined) : opts.seed,
            // 用户消息已由 send() 乐观写入会话：生题流程不再重复追加（runGeneration 只补助手消息）
            skipUserMsg: opts.userMsgAdded,
            // 多卷全部跳过会话更新：末尾若存在「题数 < 卷数」导致的零配额卷，物理序号的末卷会被
            // continue 跳过，报复核真正执行的末卷仍被当成中间卷，导致会话里永远没有本轮助手消息、
            // lastMsg 挂不上 result。因此会话最终化从卷循环拆出，统一在循环后（多卷分支）执行。
            skipSessionUpdate: volCount > 0,
          },
          {
            // 多卷时 progress.questions 已是跨卷累计口径（seed 计入），targetTotal 统一覆盖为总目标，
            // 避免 UI「已生成 X/卷内累计目标」中途变小造成困惑
            onProgress: (p) => set({ progress: volCount > 0 ? { ...p, targetTotal: grandTotal } : p }),
            // 把模型流式返回原文经 rAF 帧合并累积进 liveRaw，供「实时生成」面板逐题展示；
            // rAF 合并把一帧内多次 token 收敛为一次 setState，避免逐 token 高频重渲染卡 UI。
            onToken: (delta: string, _reasoning: string) => {
              if (!delta) return
              live += delta
              if (live.length > 6000) live = live.slice(-6000)
              // 另存一份不被截断的全文，供生题结束时写进 run-gen.log 排障（上限 512k 防内存爆）
              if (genRaw.length < 512 * 1024) genRaw += delta
              if (!liveFlushScheduled) {
                liveFlushScheduled = true
                requestAnimationFrame(flushLive)
              }
            },
            onDraft: persistDraft,
          },
          abort.signal,
        )
        failedBatches += res.failedBatches
        rejects = mergeRejects(rejects, res.rejects)
        updated = res.session
        collected = res.questions
        // 卷边界落盘（D8：每卷完成即入库，中断不丢已完卷；单卷路径由末尾统一保存）
        if (volCount > 0) await persistDraft(collected)
      }
      // 末卷 deficit 相对原结构（cums[V-1] = 原结构）计算，即整轮全局缺口
      const questions = collected
      // 生成完成：冲刷最后一次 rAF 未提交的 liveRaw，避免尾部实时文本滞留面板外
      if (liveFlushScheduled) flushLive()

      // 生成期已逐题校验，此处仅做快速复核（流式采纳即合格，异常极少）
      set({ phase: 'validating', parsed: 0, parseTotal: questions.length })
      const issuesByQuestion: Record<string, string[]> = {}
      let issueCount = 0
      // V2-P08：按约每 20 题合并一次进度上报（而非逐题 set），减少长题包下的 Zustand 订阅抖动；
      // 结束再写最终值，与进度条确认一致即可。
      let lastReported = -1
      const reportEvery = Math.max(1, Math.ceil(questions.length / 50))
      for (let i = 0; i < questions.length; i++) {
        const errs = validateQuestion(questions[i])
        if (errs.length) {
          issuesByQuestion[questions[i].id] = errs
          issueCount++
        }
        if (i - lastReported >= reportEvery || i === questions.length - 1) {
          set({ parsed: i + 1 })
          lastReported = i
        }
        if (i % 10 === 9) await new Promise((r) => setTimeout(r, 30))
      }
      const validation: ValidationSummary = {
        total: questions.length,
        passed: questions.length - issueCount,
        issueCount,
        issuesByQuestion,
        duplicateCount: validateDuplicate(questions).length,
        countIssues: validateCount(opts.structure, questions),
      }

      // 创建草稿题包并挂到 AI 消息：先生成确定性结构（难度/章节/题型/版本等），
      // 再做一次轻量 AI 调用派生「分类 + 标签」写入题包本体（见需求：题包需包含详情元数据）。
      const snap = decodeSnapshot(updated.provider)
      const enriched = opts.reusePack?.category
        ? { category: opts.reusePack.category, tags: opts.reusePack.meta.tags }
        : await enrichPackMeta(opts.input, snap, genCfg)
      const pack = { ...buildDraftPack(opts.input, questions, packId, enriched, opts.reusePack?.title), genTarget }

      // 多卷会话最终化（与卷循环解耦，见上方 skipSessionUpdate 注释）：卷循环内多卷一律跳过会话更新，
      // 这里统一补齐本轮助手消息（描述合并后的整卷结果），避免「题数<卷数」时零配额末卷被跳过导致
      // 会话里没有可挂 result 的助手落点；随后压缩摘要并落库。单卷路径助手消息已由 runGeneration 追加，
      // 此处仅在多卷且缺失时补一条，避免重复。
      if (volCount > 0 && updated.messages[updated.messages.length - 1]?.role !== 'assistant') {
        const reply = describeGenerated(questions)
        updated.messages.push({ id: uid('m_'), role: 'assistant', content: reply, tokens: estimateTokens(reply) })
        // 摘要压缩失败绝不可阻断结果交付（与 runGeneration 同样容错）
        try {
          updated.summary = await compressSummary(updated, genCfg, snap)
        } catch (e) {
          console.warn('[gen] 多卷摘要压缩失败，降级保留旧摘要', e)
        }
        await saveSession(updated)
      }

      const lastMsg = updated.messages[updated.messages.length - 1]
      if (lastMsg?.role === 'assistant') {
        lastMsg.result = { id: pack.id, title: pack.title, questionCount: questions.length, validCount: validation.passed, status: 'draft', rejects }
      }
      await saveSession(updated)
      await saveDraft(pack)

      const total = Object.values(opts.structure).reduce((a, b) => a + b, 0)
      set({
        session: updated,
        phase: 'done',
        validation,
        drafts: { ...get().drafts, [pack.id]: pack },
        progress: null,
        volumeProgress: null,
        abort: null,
        startAt: null,
        lastElapsed: Date.now() - started,
        // 缺口快照：完成面板据此标「部分完成 · 差 N 题」而非「生成完成」（后台中断/多批失败后不足额）
        lastDeficit: Math.max(0, total - questions.length),
      })
      log('info', 'pack', `生题完成 ${questions.length}/${total}`, {
        packId, mode: opts.mode, total, got: questions.length,
        failedBatches, rejectTotal: rejects ? rejects.parse + rejects.invalid + rejects.duplicate : 0, ms: Date.now() - started,
      })
      // 生题原文落盘：模型流式输出全文 + 结构/拒绝/缺口，写进项目 run-gen.log，后台读原文定位质量问题
      logGenOutput({
        t: new Date().toISOString(), kind: 'gen', status: 'done',
        input: opts.input.slice(0, 120), mode: opts.mode, reuse: !!opts.reusePack,
        structure: opts.structure, targetTotal: total, got: questions.length,
        failedBatches, deficitByType, rejects,
        ms: Date.now() - started,
        raw: genRaw,
      })
      void get().refreshSessions()
      // 数量保障结果提示：不足目标时正常交付已有题目（如 92/100），如实报告缺口
      const deficitTotal = Object.values(deficitByType).reduce((a, b) => a + b, 0)
      if (deficitTotal > 0) {
        const parts = Object.entries(deficitByType)
          .map(([t, n]) => `${QUESTION_TYPES.find((x) => x.id === t)?.name ?? t}缺 ${n}`)
          .join('、')
        ui.showToast(
          opts.mode === 'ai'
            ? `本次实际生成 ${questions.length}/${total} 题，${deficitTotal} 题多次重试仍失败`
            : `本次实际生成 ${questions.length}/${total} 题（${parts}），可继续补齐`,
        )
      } else if (failedBatches > 0) {
        ui.showToast(`本次生成 ${questions.length} 题，补齐完成`)
      }
      genOutcome = { questions: questions.length, status: 'done' }
      return genOutcome
    } catch (e) {
      const isAbort = isAbortError(e)
      log(isAbort ? 'warn' : 'error', 'pack', isAbort ? '生题中止' : '生题失败', {
        input: opts.input.slice(0, 80),
        mode: opts.mode,
        error: e instanceof Error ? e.message : String(e),
      })
      // 失败/中止也把已流式拿到的原文落盘，便于看截到哪、报错前模型输出了什么
      logGenOutput({
        t: new Date().toISOString(), kind: 'gen', status: isAbort ? 'abort' : 'fail',
        input: opts.input.slice(0, 120), mode: opts.mode,
        error: e instanceof Error ? e.message : String(e),
        raw: genRaw,
      })
      if (isAbort) {
        // 中止：优先使用随异常带回的内存题目；IndexedDB 草稿读回仅兜底。
        // 任一来源有题即保留草稿（含目标快照，可「继续补齐」），确保已生成题目绝不丢失
        const partial = (e as Error & { partial?: Question[] }).partial ?? []
        let draft: Pack | undefined
        try {
          draft = await loadDraft(packId)
        } catch {
          draft = undefined
        }
        const dbCount = draft?.questions?.length ?? 0
        if (partial.length > dbCount) {
          // 内存题目比库里新/全（或写盘失败）：用内存数据现补一份草稿
          draft = { ...buildDraftPack(opts.input, partial, packId), genTarget }
          await saveDraft(draft).catch(() => {})
        }
        set({
          phase: 'idle',
          error: null,
          progress: null,
          volumeProgress: null,
          abort: null,
          startAt: null,
          lastElapsed: null,
        })
        if (draft && draft.questions.length) {
          // 把保留的草稿挂到会话的 AI 消息，便于用户继续编辑/入库
          // （用户消息已由 send() 乐观写入时不再重复追加）。
          // 多卷中断：已完成卷保留在草稿，挂「继续生成剩余 X 卷」按钮（resume 走 reusePack 续跑）
          const remaining =
            volCount > 1 && draft.genTarget?.kbScope
              ? remainingVolumeCount(draft.genTarget.structure, draft.genTarget.kbScope.volumes, draft.questions.length)
              : 0
          const aiMsg: Message = {
            id: uid('m_'),
            role: 'assistant',
            content:
              volCount > 1 && remaining > 0
                ? `已取消。已完成卷保留 ${draft.questions.length} 题为草稿，还有 ${remaining} 卷未生成。`
                : `已取消。保留已生成 ${draft.questions.length} 题为草稿。`,
            tokens: 1,
            result: { id: draft.id, title: draft.title, questionCount: draft.questions.length, status: 'draft' },
            actions: remaining > 0 ? [{ id: uid('a_'), label: genResumeLabel(remaining), kind: 'resume', packId: draft.id }] : undefined,
          }
          if (!opts.userMsgAdded) {
            s.messages.push({ id: uid('m_'), role: 'user', content: opts.input, tokens: 1 })
          }
          s.messages.push(aiMsg)
          await saveSession(s)
          set({ session: s, drafts: { ...get().drafts, [draft.id]: draft } })
          ui.showToast(`已取消，保留已生成 ${draft.questions.length} 题草稿`)
        } else {
          // 中止/中断且一题未产出：仍追加一条会话记录，避免「静默失败」让用户误以为数据被清空。
          // 不设 result（不生成空草稿），仅作可追溯的对话记录。
          if (!opts.userMsgAdded) {
            s.messages.push({ id: uid('m_'), role: 'user', content: opts.input, tokens: 1 })
          }
          s.messages.push({
            id: uid('m_'),
            role: 'assistant',
            content: '已取消/中断生成，本次未产生有效题目，未写入学习库。',
            tokens: 1,
          })
          await saveSession(s)
          set({ session: s })
          await clearDraft(packId)
          ui.showToast('已取消生成，未产生题目')
        }
        genOutcome = { questions: draft?.questions.length ?? 0, status: 'abort' }
        return genOutcome
      }
      // 多卷某卷失败不静默：已完成卷保留为草稿 + 挂「继续生成剩余 X 卷」（第 1 卷即失败无已完成，
      // 与单卷一致走普通错误直出）
      if (volCount > 1 && collected.length > 0) {
        const draft = { ...buildDraftPack(opts.input, collected, packId), genTarget }
        await saveDraft(draft).catch(() => {})
        const remaining = remainingVolumeCount(opts.structure, volumes, collected.length)
        const aiMsg: Message = {
          id: uid('m_'),
          role: 'assistant',
          content: `第 ${curVol}/${volCount} 卷生成失败：${e instanceof Error ? e.message : String(e)}。已保留已生成 ${collected.length} 题为草稿。`,
          tokens: 1,
          result: { id: draft.id, title: draft.title, questionCount: collected.length, status: 'draft' },
          actions: remaining > 0 ? [{ id: uid('a_'), label: genResumeLabel(remaining), kind: 'resume', packId: draft.id }] : undefined,
        }
        if (!opts.userMsgAdded) {
          s.messages.push({ id: uid('m_'), role: 'user', content: opts.input, tokens: 1 })
        }
        s.messages.push(aiMsg)
        await saveSession(s)
        set({
          session: s,
          drafts: { ...get().drafts, [draft.id]: draft },
          phase: 'idle',
          error: e instanceof Error ? e.message : '生成失败，请重试',
          abort: null,
          progress: null,
          volumeProgress: null,
          startAt: null,
          lastElapsed: null,
        })
        ui.showToast(`第 ${curVol} 卷失败，已保留 ${collected.length} 题`)
        genOutcome = { questions: collected.length, status: 'fail' }
        return genOutcome
      }
      set({
        phase: 'idle',
        error: e instanceof Error ? e.message : '生成失败，请重试',
        abort: null,
        progress: null,
        volumeProgress: null,
        startAt: null,
        lastElapsed: null,
      })
      return genOutcome
    }
  }

  /** 统一执行入口（TASK-08 最小抽取，实施路线 18 节）：快捷生成与对话卡片都通过
   *  不可变 GenerationExecutionSpec 调 runGenCore——对话卡片绝不先篡改全局 structure
   *  再复用 generate()，杜绝「卡片参数被全局态覆盖」的竞态。 */
  async function runGenerationSpec(
    spec: GenerationExecutionSpec,
    opts?: { userMsgAdded?: boolean; placeholderId?: string },
  ) {
    return runGenCore({
      input: spec.input,
      mode: spec.mode,
      structure: spec.structure,
      refs: spec.refs,
      kbScope: spec.kbScope,
      userMsgAdded: opts?.userMsgAdded,
      placeholderId: opts?.placeholderId,
    })
  }

  return {
  session: null,
  sessionList: [],
  loaded: false,
  structure: zeroStructure(),
  structureMode: 'custom',
  structureTotal: 0,
  templates: {},
  defaultTemplate: null,
  phase: 'idle',
  progress: null,
  validation: null,
  error: null,
  abort: null,
  drafts: {},
  lastInput: '',
  pendingChats: [],
  startAt: null,
  lastElapsed: null,
  lastDeficit: 0,
  parsed: 0,
  parseTotal: 0,
  volumeProgress: null,
  liveRaw: '',

  async load() {
    if (get().loaded) return
    try {
      const sessions = await listSessions()
      const session = sessions[0] ?? null
      const drafts: Record<string, Pack> = {}
      const expiredIds: string[] = []
      if (session) {
        for (const m of session.messages) {
          if (m.result?.status === 'draft') {
            const pack = await loadDraft(m.result.id)
            if (pack && !isDraftExpired(pack)) {
              drafts[m.result.id] = pack
            } else if (pack) {
              // 草稿超过 24 小时：清理 config 并从会话移除消息（见 PRD 4.9）
              expiredIds.push(m.result.id)
              await clearDraft(m.result.id)
            }
          }
        }
        if (expiredIds.length > 0) {
          session.messages = session.messages.filter((m) => !m.result || !expiredIds.includes(m.result.id))
          await saveSession(session)
        }
        // 清理「孤儿空助手占位」：若在流式回复中途刷新/关闭，乐观写入的空 assistant 占位会被持久化，
        // 重启后没有任何在途请求，UI 会永远挂着「正在思考」（占位无内容、无题包结果）。此处一并剔除。
        const orphanCount = session.messages.filter((m) => m.role === 'assistant' && !m.content && !m.result).length
        if (orphanCount > 0) {
          session.messages = session.messages.filter((m) => !(m.role === 'assistant' && !m.content && !m.result))
          await saveSession(session)
        }
      }
      // 清理孤儿过期草稿（会话已删除 / 非最新会话遗留）
      const rows = await dbConfig.getAll()
      for (const row of rows) {
        if (row.key.startsWith(DRAFT_KEY_PREFIX) && row.value && isDraftExpired(row.value as Pack)) {
          // V2-P09：真正删除而非写 null，避免墓碑键常驻 getAll() 扫描
          await dbConfig.delete(row.key)
        }
      }
      const rawTemplates =
        ((await dbConfig.get(TEMPLATES_KEY)) as Record<string, Record<string, number>> | undefined) ?? {}
      // 模板净化：过滤已移除题型（如 'code'），并回写清理脏数据，避免每次加载都残留
      const templates: Record<string, Record<QuestionTypeId, number>> = {}
      for (const [name, s] of Object.entries(rawTemplates)) {
        templates[name] = sanitizeStructure(s)
      }
      if (Object.keys(templates).length !== Object.keys(rawTemplates).length) {
        await dbConfig.set(TEMPLATES_KEY, templates)
      }
      const defaultTemplate =
        ((await dbConfig.get(DEFAULT_TEMPLATE_KEY)) as string | null) ?? null
      // 竞态保护：load() 是异步的，若读 IndexedDB 期间用户已开始/完成生成
      // （store 里已写入 session/草稿），不能拿旧快照覆盖，否则刚生成的题包会"消失"。
      // 已有状态优先，仅合并补齐恢复的草稿。
      const cur = get()
      set({
        session: cur.session ?? session,
        sessionList: sessions,
        drafts: { ...drafts, ...cur.drafts },
        templates,
        defaultTemplate,
        loaded: true,
      })
      // 无历史会话且无进行中的会话时，用默认题型（选中的模板）预填生成结构（见 PRD 4.6）
      if (!session && !cur.session) get().applyDefaults()
    } catch (e) {
      console.error('[generate] load failed:', e)
      set({ loaded: true })
    }
  },

  /** 应用默认题型为本会话结构（默认题型 = 选中的模板，未设置时回退内置默认，见 PRD 4.6） */
  applyDefaults() {
    const types = get().getDefaultStructure()
    const has = Object.values(types).some((n) => n > 0)
    set({
      structure: { ...types },
      structureMode: 'custom',
      structureTotal: Object.values(types).reduce((a, b) => a + b, 0),
    })
    if (!has) {
      set({ structure: defaultStructure(), structureTotal: Object.values(defaultStructure()).reduce((a, b) => a + b, 0) })
    }
  },

  /** 把跨会话的未过期草稿全部并入 drafts：聊天记录流会展示所有历史会话的题包卡片，
   *  入库/编辑都要从 drafts 里取题目；自增方式并入，不打乱进行中的会话草稿 */
  async hydrateDrafts() {
    try {
      const sessions = await listSessions()
      const drafts = { ...get().drafts }
      let changed = false
      for (const s of sessions) {
        for (const m of s.messages) {
          const r = m.result
          if (r?.status === 'draft' && !drafts[r.id]) {
            const d = await loadDraft(r.id)
            if (d && !isDraftExpired(d)) {
              drafts[r.id] = d
              changed = true
            }
          }
        }
      }
      if (changed) set({ drafts })
    } catch {
      /* 读失败静默，历史草稿可后续再并入 */
    }
  },

  /** 一键清空历史会话记录：删除全部会话 + 未入库草稿（草稿过期/孤儿也一并清理）；
   *  已入库的题包本体在题库中，保留不动 */
  async clearSessions() {
    const sessions = await listSessions()
    log('info', 'ui', `清空历史会话 ${sessions.length} 个`, { sessions: sessions.length, drafts: Object.keys(get().drafts).length })
    for (const s of sessions) await dbSessions.delete(s.id)
    const rows = await dbConfig.getAll()
    for (const row of rows) {
      if (row.key.startsWith(DRAFT_KEY_PREFIX)) await dbConfig.delete(row.key)
    }
    set({
      session: null,
      sessionList: [],
      drafts: {},
      pendingChats: [],
      volumeProgress: null,
      phase: 'idle',
      progress: null,
      validation: null,
      error: null,
      startAt: null,
      lastElapsed: null,
      parsed: 0,
      parseTotal: 0,
    })
    get().applyDefaults()
    useUI.getState().showToast('已清空历史会话')
  },

  /** 汇总所有会话里的生成题包记录（新→旧），供「题包生成历史」弹窗展示与删除 */
  async listGeneratedPacks(): Promise<GenPackRecord[]> {
    const sessions = await listSessions()
    const packCache = new Map<string, Pack>()
    // OBS-9②：同一题包 ref 会随会话副本（如恢复备份追加）出现在多个会话里，
    // 历史列表按 ref.id 渲染会撞 React duplicate key——按 ref.id 去重，保留较新会话的记录
    const newestByRef = new Map<string, GenPackRecord>()
    for (const s of sessions) {
      let repaired = false
      for (const m of s.messages) {
        const r = m.result
        if (!r) continue
        let pack = packCache.get(r.id)
        if (!pack) {
          if (r.status === 'in_bank') {
            pack = await dbPacks.get(r.id)
          } else {
            const d = await loadDraft(r.id)
            if (d && !isDraftExpired(d)) pack = d
          }
          if (pack) {
            packCache.set(r.id, pack)
          } else if (r.status !== 'removed') {
            // F-06 自愈：题包已从题库/草稿清除，按真实存在性修复会话引用为失效态，
            // 使「已入库/未入库」标签与题包实际存在保持一致（AGENTS.md 真实存在性铁律）
            r.status = 'removed'
            repaired = true
          }
        }
        const rec: GenPackRecord = { sessionId: s.id, created: s.created, title: r.title, ref: r, pack }
        const existed = newestByRef.get(r.id)
        if (!existed || rec.created > existed.created) newestByRef.set(r.id, rec)
      }
      if (repaired) await saveSession(s)
    }
    return [...newestByRef.values()].sort((a, b) => b.created - a.created)
  },

  /** 刷新历史会话列表（聊天化改造后用于恢复 sessionList）；HMR 重置 store 后也可靠它恢复列表 */
  async refreshSessions() {
    try {
      const sessions = await listSessions()
      set({ sessionList: sessions })
    } catch { /* 读失败静默，列表保持现状 */ }
  },

  /** 切换题型模式：AI 推荐（总题数驱动，题型由 AI 搭配）/ 自定义（逐题型调整） */
  setMode(mode: 'ai' | 'custom') {
    const cur = get()
    log('info', 'ui', `切换题型模式 → ${mode}`, { from: cur.structureMode })
    if (mode === 'ai') {
      // 进入 AI 模式：清空各题型，仅保留当前总题数（放 single 位作为载体）
      // 自定义全 0（未设置）时给默认 20，避免 AI 推荐模式 0 题
      const total =
        cur.structureTotal || Object.values(cur.structure).reduce((a, b) => a + b, 0) || 20
      set({ structureMode: 'ai', structure: { ...defaultStructure(), single: total }, structureTotal: total })
    } else {
      // 自定义模式默认全 0：结构只承载用户手填的题型数。若保留 AI 推荐态残留的
      // structure（single/judge/fill 非零），自定义合计会被凭空撑大，违背「自定义就该自己定题数」。
      set({ structureMode: 'custom', structure: { ...zeroStructure() }, structureTotal: 0 })
    }
  },

  setStructure(type, count) {
    const setVal = Math.max(0, Math.min(Math.round(count), MAX_PER_TYPE))
    if (get().structure[type] !== setVal) {
      log('info', 'ui', `设置题型 ${type} → ${setVal} 题`, { type, count: setVal })
    }
    // 单题型上限 + 总题数上限双约束：保证自定义总题数不超系统红线
    const cur = get().structure
    const others = Object.values({ ...cur, [type]: 0 }).reduce((a, b) => a + b, 0)
    const max = Math.min(MAX_PER_TYPE, MAX_QUESTIONS_PER_GENERATION - others)
    const structure = { ...get().structure, [type]: Math.max(0, Math.min(max, Math.round(count))) }
    set({ structure, structureMode: 'custom', structureTotal: Object.values(structure).reduce((a, b) => a + b, 0) })
  },

  /** AI 推荐模式：调整总题数（题型分布交给 AI 自行搭配） */
  setAiTotal(count) {
    const total = Math.max(1, Math.min(MAX_QUESTIONS_PER_GENERATION, Math.round(count)))
    log('info', 'ui', `AI 推荐模式调整总题数 → ${total}`, { total })
    set({ structureTotal: total, structure: { ...defaultStructure(), single: total }, structureMode: 'ai' })
  },

  applyStructure(s, mode = 'custom') {
    log('info', 'ui', `应用题型结构 ${mode}`, { mode, structure: s })
    // 模板/默认结构应用时先净化（过滤废弃题型），再收紧到系统上限，避免超出红线的结构被带入
    const clean = sanitizeStructure(s)
    const capped: Record<string, number> = {}
    let acc = 0
    for (const [k, v] of Object.entries(clean)) {
      const vc = Math.min(Number(v) || 0, MAX_PER_TYPE, MAX_QUESTIONS_PER_GENERATION - acc)
      capped[k] = Math.max(0, vc)
      acc += capped[k]
    }
    set({ structure: capped as any, structureMode: mode, structureTotal: acc })
  },

  async saveTemplate(name: string, structure?: Record<QuestionTypeId, number>) {
    const s = sanitizeStructure(structure ?? get().structure)
    const templates = { ...get().templates, [name]: s }
    set({ templates })
    await dbConfig.set(TEMPLATES_KEY, templates)
  },

  async deleteTemplate(name: string) {
    const templates = { ...get().templates }
    delete templates[name]
    set({ templates })
    await dbConfig.set(TEMPLATES_KEY, templates)
    // 删除的是默认模板时，清空默认标记
    if (get().defaultTemplate === name) {
      set({ defaultTemplate: null })
      // V2-P09：真正删除而非写 null
      await dbConfig.delete(DEFAULT_TEMPLATE_KEY)
    }
  },

  async setDefaultTemplate(name: string | null) {
    if (name && !get().templates[name]) return
    set({ defaultTemplate: name })
    await dbConfig.set(DEFAULT_TEMPLATE_KEY, name)
  },

  /** 默认题型结构：选中的模板结构，未设置时回退内置默认 */
  getDefaultStructure() {
    const g = get()
    if (g.defaultTemplate && g.templates[g.defaultTemplate]) {
      return sanitizeStructure(g.templates[g.defaultTemplate])
    }
    return defaultStructure()
  },

  /** 对话式生题入口：乐观写入用户消息 → 意图识别分流（生题 → generate，聊天 → chat） */
  async send(input: string, refs?: string, kbScope?: KbScope) {
    const ai = useAI.getState()
    const activeId = ai.getActiveId()
    const provider = ai.providers[activeId]
    if (!provider?.apiKey || !provider.model) {
      useUI.getState().showToast('请先配置 AI 模型（我的 → AI 设置）')
      return
    }
    const trimmed = input.trim()
    if (trimmed.length < 2) {
      useUI.getState().showToast('请输入内容')
      return
    }
    // 防重入：生题处理中禁止再次发送，避免消息乱序
    const busy = get().phase
    // 流式回复中：借鉴 Cherry Studio「发送即回复」——不禁用发送，乐观追加用户消息 + 占位，
    // 排队等当前回复完成后自动发送（避免用户干等上一轮结束才能发下一条）
    if (busy === 'chatting') {
      const latest = get().session
      if (latest) {
        const ph: Message = { id: uid('m_'), role: 'assistant', content: '', tokens: 0 }
        const queuedUser: Message = { id: uid('m_'), role: 'user', content: trimmed, tokens: estimateTokens(trimmed), refs }
        latest.messages.push(queuedUser)
        latest.messages.push(ph)
        set({
          session: { ...latest },
          pendingChats: [...get().pendingChats, { input: trimmed, placeholderId: ph.id, userMessageId: queuedUser.id }],
        })
        saveSessionSerial(latest)
        useUI.getState().showToast('已排队，当前回复完成后自动发送')
      }
      return
    }
    if (busy === 'generating' || busy === 'validating') {
      useUI.getState().showToast('正在生成中，请稍候')
      return
    }
    // 思考开关遵循用户配置（不再运行时强制关闭）
    const cfg: AIConfig = {
      providers: { ...ai.providers },
      defaultId: ai.defaultId,
    }
    const snap = { providerId: activeId, model: provider.model }

    // ① 乐观写入（借鉴 Cherry Studio）：用户消息 + 空助手占位立即上屏，
    //    意图识别在后台进行，不再阻塞消息显示（此前用户消息要等意图识别 LLM 返回才出现）
    let s = get().session
    if (!s) {
      s = createSession(trimmed, snap)
    } else if (s.provider !== encodeSnapshot(snap)) {
      // 复用历史会话但换了厂商/模型：刷新快照（同 runGenCore/chat）
      s = { ...s, provider: encodeSnapshot(snap) }
    } else {
      // 复制一份：避免直接改原对象导致引用不变、消息流 useMemo 不重算（新消息不显示）
      s = { ...s }
    }
    s.messages.push({ id: uid('m_'), role: 'user', content: trimmed, tokens: estimateTokens(trimmed), refs })
    const userMessageId = s.messages[s.messages.length - 1]!.id
    const placeholder: Message = { id: uid('m_'), role: 'assistant', content: '', tokens: 0 }
    s.messages.push(placeholder)
    // BUG-4 修复：AbortController 必须在乐观上屏时同步创建——此前要到 chat() 真正发起流式请求才创建，
    // 中间的「意图识别 LLM 分类窗口」（可达数秒）里 phase 已是 chatting、停止按钮已出现，
    // 但 get().abort 为 null，用户点停止被静默吞掉（cancel() 空转），回复照样继续
    const abort = new AbortController()
    set({ session: s, phase: 'chatting', error: null, abort })
    // 后台落库（串行链：不阻塞上屏，且保证与后续 chat 完成的保存按序合并；失败静默）
    saveSessionSerial(s)
    await get().handleGenerationDraftTurn({
      input: trimmed,
      cfg,
      snapshot: snap,
      userMsgAdded: true,
      placeholderId: placeholder.id,
      userMessageId,
      refs,
      kbScope,
    })
  },

  /** 普通聊天流：V2 草稿协议之外的消息只走这条通用流式路径。 */
  async chat(input: string, cfg: AIConfig, snap: SessionSnapshot, opts?: GenOpts) {
    let s = get().session
    if (!s) {
      s = createSession(input, snap)
    } else if (s.provider !== encodeSnapshot(snap)) {
      s = { ...s, provider: encodeSnapshot(snap) }
    } else {
      s = { ...s }
    }

    if (!opts?.userMsgAdded) {
      s.messages.push({ id: uid('m_'), role: 'user', content: input, tokens: estimateTokens(input), refs: opts?.refs })
    }
    let aiMsg = opts?.placeholderId
      ? s.messages.find((m) => m.id === opts.placeholderId)
      : undefined
    if (!aiMsg) {
      aiMsg = { id: uid('m_'), role: 'assistant', content: '', tokens: 0 }
      s.messages.push(aiMsg)
    }
    const abort = new AbortController()
    set({ session: s, phase: 'chatting', error: null, abort })

    let reply = ''
    let flushScheduled = false
    const flush = () => {
      flushScheduled = false
      aiMsg!.content = reply
      const current = get().session
      if (!current || current.id !== s!.id) return
      const index = current.messages.findIndex((m) => m.id === aiMsg!.id)
      if (index === -1) return
      const messages = current.messages.slice()
      messages[index] = { ...aiMsg! }
      set({ session: { ...current, messages } })
    }

    try {
      const contextWindow = cfg.providers[snap.providerId]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      const outLimit = cfg.providers[snap.providerId]?.maxOutputTokens
      await maybeCompressChat(s, cfg, snap, contextWindow, estimateTokens(input)).catch(() => undefined)
      const messages = buildChatContext(s, estimateTokens(input), contextWindow)
      const result = await chat(
        messages,
        {
          providerId: snap.providerId,
          model: snap.model,
          temperature: 0.7,
          maxTokens: outLimit,
          signal: abort.signal,
          module: 'chat',
          stream: true,
          timeoutMs: 180_000,
          onToken: (delta) => {
            if (!delta) return
            reply += delta
            if (!flushScheduled) {
              flushScheduled = true
              requestAnimationFrame(flush)
            }
          },
        },
        cfg,
      )
      if (flushScheduled) flush()
      aiMsg.tokens = result.usage.outputTokens
      if (result.finishReason === 'length') {
        aiMsg.truncated = true
        aiMsg.actions = [{ id: uid('a_'), label: GEN_CONTINUE_LABEL, kind: 'continue' }]
      }
      let latest = get().session ?? s
      const index = latest.messages.findIndex((m) => m.id === aiMsg!.id)
      if (index !== -1 && (aiMsg!.truncated || aiMsg!.actions)) {
        const nextMessages = latest.messages.slice()
        nextMessages[index] = { ...aiMsg! }
        latest = { ...latest, messages: nextMessages }
      }
      set({ session: latest, phase: 'idle', abort: null })
      saveSessionSerial(latest)
      void get().refreshSessions()

      const queue = get().pendingChats
      if (queue.length > 0) {
        const next = queue[0]
        set({ pendingChats: queue.slice(1) })
        const nextUser = latest.messages.find((m) => m.id === next.userMessageId)
        await get().handleGenerationDraftTurn({
          input: next.input,
          cfg,
          snapshot: snap,
          userMsgAdded: true,
          placeholderId: next.placeholderId,
          userMessageId: next.userMessageId,
          refs: nextUser?.refs,
        })
      }
    } catch (e) {
      if (flushScheduled) flush()
      if (isAbortError(e)) {
        if (!aiMsg!.content) s.messages = s.messages.filter((m) => m.id !== aiMsg!.id)
        const pendingIds = new Set(get().pendingChats.map((p) => p.placeholderId))
        if (pendingIds.size > 0) s.messages = s.messages.filter((m) => !pendingIds.has(m.id))
        set({ pendingChats: [] })
        await saveSession(s)
        set({ session: s, phase: 'idle', abort: null, error: '已停止回复' })
      } else {
        aiMsg!.content = aiMsg!.content || CHAT_FAIL_FALLBACK
        await saveSession(s)
        set({
          session: s,
          phase: 'idle',
          error: e instanceof Error ? e.message : '回复失败，请重试',
          abort: null,
        })
      }
      void get().refreshSessions()
    }
  },

  /** 对话式生题 V2 控制器（实施路线 17 节 / TASK-07）：
   *  流程（17 节 14 步）：本地取消门禁 → 本地显式提取 → 统一一次 V2 chat（需要协议且无效时
   *  重试一次）→ finalIntent 门禁 → 来源归一（5.4）→ 重读最新 Session 校验 turnId/草稿版本
   *  → 一次 applyDraftTurn → validator → acknowledgement + 固定下一问（ready 时投影旧 UI
   *  确认按钮 + proposalRef 迁移桥）→ 一次串行落库（失败可见提示）。
   *  并发：turnId 在入队/乐观写入时确定；draftId/revision 在本队列项开始处理时读取；提交前
   *  重读 DB 最新会话做门禁；当前 UI 已切走时只写回原会话、不闪入结果、不重置全局 phase。 */
  async handleGenerationDraftTurn(args: {
    input: string
    cfg: AIConfig
    snapshot: SessionSnapshot
    userMsgAdded?: boolean
    placeholderId?: string
    userMessageId?: string
    refs?: string
    kbScope?: KbScope
    /** 取消后的剩余聊天请求：草稿已取消，本轮只聊天不再改任何草稿 */
    forceChat?: boolean
  }) {
    const { input, cfg, snapshot, placeholderId } = args
    const trimmed = input.trim()
    const startSession = get().session
    if (!startSession) return
    const sessionId = startSession.id
    const contextWindow = cfg.providers[snapshot.providerId]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    const turnId =
      args.userMessageId ?? [...startSession.messages].reverse().find((m) => m.role === 'user')?.id ?? uid('turn_')
    const abortSignal = get().abort?.signal

    // ---- 流式上屏（仅纯聊天轮；协议轮走 turn-local buffer，终态一次性提交，P0-27） ----
    let streamed = ''
    let flushScheduled = false
    const flushStream = () => {
      flushScheduled = false
      const cs = get().session
      if (!cs || cs.id !== sessionId || !placeholderId) return
      const i = cs.messages.findIndex((m) => m.id === placeholderId)
      if (i === -1) return
      const mm = cs.messages.slice()
      mm[i] = { ...mm[i], content: streamed }
      set({ session: { ...cs, messages: mm } })
    }
    const streamToPlaceholder = (delta: string) => {
      streamed += delta
      if (!flushScheduled) {
        flushScheduled = true
        requestAnimationFrame(flushStream)
      }
    }
    const commitPlaceholder = (patch: Partial<Message>) => {
      const cs = get().session
      if (!cs || cs.id !== sessionId || !placeholderId) return
      const i = cs.messages.findIndex((m) => m.id === placeholderId)
      if (i === -1) return
      const mm = cs.messages.slice()
      mm[i] = { ...mm[i], ...patch }
      set({ session: { ...cs, messages: mm } })
    }
    /** 一次落库（草稿+消息同一条记录）；失败必须可见（实施路线 5.3 / 15 节步骤 9） */
    const persistTurn = async (nextSession: Session) => {
      if (get().session?.id === sessionId) {
        set({
          session: nextSession,
          phase: 'idle',
          abort: null,
        })
      }
      try {
        await saveSessionDraftStrict(nextSession)
      } catch {
        log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionId.slice(-8) })
        useUI.getState().showToast('方案暂未保存，刷新可能丢失')
      }
    }

    const activeDraft = args.forceChat
      ? null
      : (() => {
          const d = startSession.generationDraft
          return d && d.lifecycle === 'active' ? d : null
        })()
    const evaluation0 = activeDraft ? evaluateGenerationDraft(activeDraft) : null

    // ---- ① 本地取消门禁（6.3 首步）：纯取消不调用模型（P0-08/P1-02） ----
    const localCancel = args.forceChat ? ({ action: 'none' } as const) : resolveLocalCancel(trimmed, !!activeDraft)
    if (localCancel.action === 'cancel') {
      if (!activeDraft) return
      const next = cancelDraft(activeDraft)
      const fresh = await loadSessionById(sessionId)
      const base = fresh && fresh.messages.some((m) => m.id === turnId) ? fresh : get().session ?? startSession
      const messages = base.messages.map((m) =>
        m.id === placeholderId ? { ...m, content: '好的，已取消当前方案。', actions: [] } : m,
      )
      await persistTurn({ ...base, messages, generationDraft: next })
      return
    }
    if (localCancel.action === 'cancel_and_chat') {
      // 复合输入：先取消草稿，剩余请求继续一次普通聊天（该回复不得再改已取消草稿）
      if (activeDraft) {
        const next = cancelDraft(activeDraft)
        const fresh = await loadSessionById(sessionId)
        const base = fresh && fresh.messages.some((m) => m.id === turnId) ? fresh : get().session ?? startSession
        const messages = base.messages.map((m) => (m.id === placeholderId ? { ...m, content: '好的，已取消当前方案。' } : m))
        await persistTurn({ ...base, messages, generationDraft: next })
      }
      await get().handleGenerationDraftTurn({ ...args, input: localCancel.remainder, forceChat: true })
      return
    }

    // ---- ② 本地显式提取（6.4）：只提可靠的题数/题型；是否采纳由模型响应后的门禁统一裁决 ----
    const localPatch = extractExplicitDraftPatch(trimmed, {
      turnId,
      baseRevision: activeDraft?.revision ?? 0,
      ...(activeDraft ? { expectedDraftId: activeDraft.id } : {}),
      userText: trimmed,
      currentDraft: activeDraft,
    })

    // 错别字/省略式的模糊增减题量没有可靠的可执行数值；本地直接澄清，
    // 保留活动方案并结束占位，避免因协议缺失触发第二次长模型调用。
    if (activeDraft && localPatch === null && isVagueCountAdjustment(trimmed)) {
      const fresh = await loadSessionById(sessionId)
      const base = fresh && fresh.messages.some((m) => m.id === turnId) ? fresh : get().session ?? startSession
      const messages = base.messages.map((m) => (
        m.id === placeholderId
          ? { ...m, content: '我理解你想调整题量，请直接告诉我最终需要多少题（例如：30题）。' }
          : m
      ))
      await persistTurn({ ...base, messages })
      return
    }

    // ---- ③ 统一一次 V2 chat（6.3）：协议轮 buffer；纯聊天轮流式 + 跨 chunk 协议尾过滤 ----
    const needProtocol = requiresDraftProtocol(trimmed, activeDraft, evaluation0)
    const wireCtx = {
      turnId,
      baseRevision: activeDraft?.revision ?? 0,
      ...(activeDraft ? { expectedDraftId: activeDraft.id } : {}),
      userText: trimmed,
      currentDraft: activeDraft,
    }
    const runAttempt = async (retryNote?: string): Promise<{ raw: string; error: string | null }> => {
      const msgs = buildDraftMessages({
        session: get().session ?? startSession,
        draft: activeDraft,
        evaluation: evaluation0,
        userInput: trimmed,
        refs: args.refs,
        kbScope: args.kbScope,
        contextWindow,
      })
      if (retryNote) msgs.push({ role: 'user', content: retryNote })
      const filter = new ProtocolTailFilter()
      let full = ''
      try {
        const result = await chat(
          msgs,
          {
            providerId: snapshot.providerId,
            model: snapshot.model,
            temperature: 0.6,
            stream: true,
            signal: abortSignal,
            module: 'chat',
            noThink: needProtocol,
            // 与 V1 流式聊天对齐放宽到 3 分钟：「始终思考」类模型常见 50-90s 首包延迟，
            // 网关默认 60s 会让 V2 协议轮必然超时（TASK-09 内置浏览器走查实测）
            timeoutMs: 180_000,
            onToken: (delta) => {
              if (!delta) return
              full += delta
              if (!needProtocol) streamToPlaceholder(filter.push(delta))
            },
          },
          cfg,
        )
        if (!needProtocol) streamToPlaceholder(filter.flush())
        return { raw: full || result.content, error: null }
      } catch (e) {
        if (!needProtocol) streamToPlaceholder(filter.flush())
        // 用户主动停止：独立标记，主流程直接收尾（不重试、不当作失败）
        const aborted = (e instanceof AIError && e.code === 'ABORTED') || (e instanceof Error && e.message === 'ABORTED')
        return { raw: full, error: aborted ? '__ABORTED__' : e instanceof Error ? e.message : String(e) }
      }
    }

    /** 协议失败终态（6.5 规则 2）：草稿不变 + turnIssues + 固定提示；一次性提交不闪残缺正文。
     *  TASK-09 走查加固：网络/超时错误与协议解析错误统一走此终态（重试一次后仍失败）。 */
    const commitProtocolFailure = async (reason?: string) => {
      const msg = activeDraft
        ? '我没能可靠读取这次修改，原方案未变，请换一种说法。'
        : '这次没有创建方案，请换一种说法再试。'
      let base = get().session ?? startSession
      let nextDraft = activeDraft
      if (activeDraft) {
        const f = await loadSessionById(sessionId)
        if (
          f &&
          f.messages.some((m) => m.id === turnId) &&
          f.generationDraft?.id === activeDraft.id &&
          f.generationDraft.revision === activeDraft.revision
        ) {
          nextDraft = withDraftTurnIssues(f.generationDraft, [
            {
              code: 'TURN_UPDATE_NOT_APPLIED',
              message: reason
                ? `上一轮修改未能应用（${reason.slice(0, 40)}）`
                : '上一轮修改未能应用（协议解析失败）',
            },
          ])
          base = f
        }
      }
      commitPlaceholder({ content: msg })
      const messages = base.messages.map((m) => (m.id === placeholderId ? { ...m, content: msg } : m))
      log('warn', 'draft-v2', 'draft_turn_failed', {
        session: sessionIdSlice(sessionId),
        turn: turnId.slice(-8),
        reason: (reason ?? 'parse').slice(0, 60),
      })
      await persistTurn({ ...base, messages, generationDraft: nextDraft ?? base.generationDraft })
    }

    const r1 = await runAttempt()
    let raw = r1.raw
    let netError = r1.error
    let parsed = netError ? null : parseDraftPatchWire(raw, wireCtx)
    let usedLocalFallback = false
    // ---- ④ 重试契约（6.5）：仅需要协议且首次无效（协议错误或网络错误）时重试一次 ----
    if (needProtocol && (netError !== null || (parsed && !parsed.ok))) {
      const firstCode: DraftProtocolErrorCode =
        netError || !parsed || !parsed.ok ? (netError ? 'INVALID_JSON' : parsed && !parsed.ok ? parsed.error.code : 'INVALID_JSON') : 'INVALID_JSON'
      const r2 = await runAttempt(buildDraftRetryMessages(firstCode, {
        draft: activeDraft,
        evaluation: evaluation0,
        userInput: trimmed,
      })[0]?.content)
      netError = r2.error
      raw = r2.raw
      parsed = netError ? null : parseDraftPatchWire(raw, wireCtx)
    }
    // 用户主动停止：占位保留已上屏内容，草稿保持，整轮收尾（不重试、不当作失败）
    if (netError === '__ABORTED__') {
      commitPlaceholder({ content: streamed.trim() || '（已停止回复）' })
      const cs = get().session
      if (cs && cs.id === sessionId) await persistTurn({ ...cs })
      return
    }
    // ---- ⑤ 协议硬失败（网络/超时/JSON/Schema 等非漏块错误）：草稿不变 + turnIssues + 固定提示（P0-15/P1-10） ----
    const parseFailed = netError !== null || (parsed && !parsed.ok)
    // 漏协议本身仍可按普通聊天继续；若本轮有本地明确补丁，则由下面的兜底分支接管。
    const protocolFailed = netError !== null || (parsed && !parsed.ok && parsed.error.code !== 'NO_PROTOCOL_BLOCK')
    const localFallbackSignal =
      localPatch !== null &&
      !isGenAbort(trimmed) &&
      (needProtocol || hasExplicitGenIntent(trimmed) || isAdjustment(trimmed))
    const canUseLocalFallback =
      localFallbackSignal &&
      (parseFailed || (parsed?.ok === true && parsed.patch.intent === 'chat'))
    if (canUseLocalFallback) {
      // 模型协议失败时，只采纳本地已从用户原文明确提取的字段；未提到的旧字段仍由 reducer 保留。
      const failureCode = netError
        ? 'NETWORK_OR_TIMEOUT'
        : parsed && !parsed.ok
          ? parsed.error.code
          : 'NO_PROTOCOL_BLOCK'
      log('warn', 'draft-v2', 'draft_local_fallback', {
        session: sessionIdSlice(sessionId),
        turn: turnId.slice(-8),
        reason: failureCode,
      })
      parsed = {
        ok: true,
        patch: { ...localPatch, intent: 'update', acknowledgement: '已按本轮明确指令更新方案。' },
        acknowledgement: '已按本轮明确指令更新方案。',
      }
      netError = null
      usedLocalFallback = true
    } else if (protocolFailed) {
      await commitProtocolFailure(netError ?? undefined)
      return
    }

    // ---- ⑥ finalIntent 门禁（6.3 唯一顺序；NO_PROTOCOL_BLOCK 时 modelIntent=null 走本地裁决） ----
    if (!parsed) {
      await commitProtocolFailure('未知解析态')
      return
    }
    const modelIntent = parsed.ok ? parsed.patch.intent : null
    const fin = resolveFinalIntent({
      input: trimmed,
      modelIntent,
      hasActiveDraft: !!activeDraft,
      evaluation: evaluation0,
      localPatch,
    })

    // ---- ⑦ 普通聊天：撤销未完成草稿，正文剥离协议块后上屏（P0-09/P0-30）。
    //  需要协议却两次漏块且本地无高置信补齐：按失败处理（P1-10），绝不把残缺正文当回复 ----
    if (fin.kind === 'chat') {
      if (needProtocol && !parsed.ok) {
        await commitProtocolFailure()
        return
      }
      const visible = stripWireFences(raw).trim()
      commitPlaceholder({ content: visible || '（已回复）' })
      // 普通聊天不能继续占用当前未完成方案；否则下一轮裸数字会重新补回旧方案。
      // 以提交前的最新 IndexedDB 会话为准，避免旧内存快照覆盖并发中的新 revision。
      const fresh = await loadSessionById(sessionId)
      const base = fresh && fresh.messages.some((m) => m.id === turnId) ? fresh : get().session ?? startSession
      const latestDraft = base.generationDraft
      const cancelledDraft = latestDraft && latestDraft.lifecycle === 'active' ? cancelDraft(latestDraft) : latestDraft
      const messages = base.messages.map((m) => (m.id === placeholderId ? { ...m, content: visible || '（已回复）' } : m))
      await persistTurn({ ...base, messages, generationDraft: cancelledDraft })
      return
    }

    // ---- ⑧ update/replace/cancel：合并本地与模型补丁（本地显式优先，6.4） ----
    if (fin.kind === 'cancel' && !parsed.ok) {
      // 模型 cancel 一定带协议块；无块时按聊天兜底（已由门禁判定，防御）
      const visible = stripWireFences(raw).trim()
      commitPlaceholder({ content: visible || '（已回复）' })
      const cs = get().session
      if (cs && cs.id === sessionId) await persistTurn({ ...cs })
      return
    }
    const useModel = modelIntent === 'update' || modelIntent === 'replace' || modelIntent === 'cancel' ? parsed.ok ? parsed.patch : null : null
    const merged0 = mergeLocalAndModelPatch(localPatch, useModel).patch
    const finalPatch = merged0
      ? { ...merged0, intent: (fin.kind === 'replace' ? 'replace' : fin.kind === 'cancel' ? 'cancel' : 'update') as 'update' | 'replace' | 'cancel' }
      : null
    if (!finalPatch) {
      const visible = stripWireFences(raw).trim()
      commitPlaceholder({ content: visible || '（已回复）' })
      const cs = get().session
      if (cs && cs.id === sessionId) await persistTurn({ ...cs })
      return
    }

    // ---- ⑨ 写回前重读最新 Session：三重门禁（17 节步骤 8 / 5.3 迟到响应） ----
    const fresh = await loadSessionById(sessionId)
    if (!fresh) {
      // 原会话已删除/清空：安全丢弃，不重建（P0-28）
      log('warn', 'draft-v2', 'stale_patch_rejected', { reason: 'session_gone', turn: turnId.slice(-8) })
      if (get().session?.id === sessionId) set({ phase: 'idle', abort: null })
      return
    }
    if (!fresh.messages.some((m) => m.id === turnId)) {
      log('warn', 'draft-v2', 'stale_patch_rejected', { reason: 'turn_message_gone', turn: turnId.slice(-8) })
      if (get().session?.id === sessionId) set({ phase: 'idle', abort: null })
      return
    }
    const freshDraft =
      fresh.generationDraft && fresh.generationDraft.lifecycle === 'active' ? fresh.generationDraft : null
    if (activeDraft && (!freshDraft || freshDraft.id !== activeDraft.id || freshDraft.revision !== activeDraft.revision)) {
      // 迟到响应：草稿已被取消/更新/替换（P0-13/P0-17）
      log('warn', 'draft-v2', 'stale_patch_rejected', { reason: 'draft_moved', turn: turnId.slice(-8) })
      commitPlaceholder({ content: '方案已更新，本轮修改未应用，请查看当前方案。' })
      const cs = get().session
      if (cs?.id === sessionId) await persistTurn({ ...cs })
      return
    }

    // ---- ⑩ 来源归一（5.4）：真实资料 + source_policy → DraftSourceAction；冲突不选边 ----
    const turnSource =
      args.refs || args.kbScope
        ? { sourceMessageId: turnId, ...(args.kbScope ? { kbScope: args.kbScope } : {}) }
        : undefined
    const sourceRes = resolveDraftSourceAction(
      freshDraft,
      fin.kind,
      turnSource,
      parsed.ok ? parsed.patch.sourcePolicy : undefined,
    )
    if (sourceRes.kind === 'conflict') {
      // P1-12：本轮不应用 source 变化、不改需求字段，写 turnIssues 交用户选择
      const nextDraft = freshDraft ? withDraftTurnIssues(freshDraft, [sourceRes.issue]) : null
      const reply = [parsed.ok ? parsed.acknowledgement ?? '' : '', sourceRes.issue.message].filter(Boolean).join('\n')
      const sourceActions: ChatAction[] = freshDraft && turnSource
        ? [
            { id: uid('a_'), label: '使用新资料', kind: 'source_new', source: turnSource },
            { id: uid('a_'), label: '沿用旧资料', kind: 'source_keep', source: turnSource },
            { id: uid('a_'), label: '不使用资料', kind: 'source_clear', source: turnSource },
          ]
        : []
      const messages = fresh.messages.map((m) => (m.id === placeholderId
        ? {
            ...m,
            content: reply,
            ...(sourceActions.length > 0 ? { actions: sourceActions } : {}),
            ...(freshDraft ? { proposalRef: { draftId: freshDraft.id, revision: freshDraft.revision } } : {}),
          }
        : m))
      await persistTurn({ ...fresh, messages, generationDraft: nextDraft ?? fresh.generationDraft })
      return
    }

    // ---- ⑪ 一次 applyDraftTurn（17 节步骤 9：source 合并只发生在 reducer 入口） ----
    const next = applyDraftTurn(freshDraft, finalPatch, sourceRes.action, sessionId)
    if (!next || next === freshDraft) {
      log('warn', 'draft-v2', 'stale_patch_rejected', { reason: 'reducer_rejected', turn: turnId.slice(-8) })
      commitPlaceholder({ content: '本轮修改未能应用，方案未变。' })
      const cs = get().session
      if (cs?.id === sessionId) await persistTurn({ ...cs })
      return
    }

    // ---- ⑫ validator + 回复（17 节步骤 10/11） ----
    const ev2 = evaluateGenerationDraft(next)
    const ack = usedLocalFallback
      ? '已按本轮明确指令更新方案。'
      : parsed.ok
        ? parsed.acknowledgement ?? ''
        : ''
    let reply: string
    if (fin.kind === 'cancel') {
      reply = '好的，已取消当前方案。'
    } else if (ev2.ready) {
      const view = formatGenerationDraft(next, ev2)
      const sumLines: string[] = []
      if (view.topic) sumLines.push(`主题：${view.topic.value}`)
      if (view.totalText) sumLines.push(`题量：${view.totalText} 题`)
      if (view.aiTypes) sumLines.push('题型：AI 推荐')
      else if (view.typeCounts?.length) sumLines.push(`题型：${view.typeCounts.map((t) => `${t.name} ${t.count}`).join('、')}`)
      if (view.requirements?.length) sumLines.push(`要求：${view.requirements.map((r) => r.text).join('；')}`)
      if (view.sourceSummary) sumLines.push(`资料：${view.sourceSummary}`)
      reply = [ack, `【当前方案】\n${sumLines.join('\n')}`, '确认无误即可在上方方案卡点击「生成」。'].filter(Boolean).join('\n')
    } else {
      reply = [ack, buildDraftNextQuestion(ev2) ?? '请补充生题需求。'].filter(Boolean).join('\n')
    }

    // ---- ⑬ 一次提交：消息 + 草稿同记录落库（17 节步骤 12）。
    // TASK-09 迁移完成：不再向消息投影旧确认按钮；
    // 生成入口已收敛到唯一活动方案卡（GenerationDraftCard → startGenerationFromDraft） ----
    const messages = fresh.messages.map((m) => (m.id === placeholderId ? { ...m, content: reply } : m))
    await persistTurn({ ...fresh, messages, generationDraft: next })
  },

  /** TASK-08：从活动草稿一键启动生成（实施路线 18 节）。
   *  门禁链：id/revision/lifecycle → validator → 来源解析（SOURCE_MISSING 阻断）→ 不可变 spec
   *  → 原子置 generating（同步 set 防双击）→ runGenerationSpec（显式参数调 runGenCore）
   *  → 成功或已形成 Pack 草稿置 completed；首次请求前失败（0 产出）恢复 active 保留可重试信息；
   *  生成中用户取消按取消语义收敛（不复活）。旧 revision/异 id：提示「方案已更新，请使用最新方案」。 */
  async startGenerationFromDraft(draftId: string, revision: number) {
    const ui = useUI.getState()
    if (draftStartLockId === draftId) return // 双击防抖：同一草稿已在启动流程中
    const s = get().session
    const d = s?.generationDraft
    if (!s || !d || d.id !== draftId || d.revision !== revision) {
      ui.showToast('方案已更新，请使用最新方案')
      return
    }
    if (d.lifecycle !== 'active') {
      if (d.lifecycle === 'generating') return // 正在生成：忽略重复点击
      ui.showToast('方案已更新，请使用最新方案')
      return
    }
    draftStartLockId = draftId
    try {
      // IndexedDB 是跨标签的唯一事实源：旧标签的内存快照不能绕过 revision/lifecycle 门禁。
      const persisted = await loadSessionById(s.id)
      const persistedDraft = persisted?.generationDraft
      if (
        persisted &&
        (!persistedDraft ||
          persistedDraft.id !== draftId ||
          persistedDraft.revision !== revision ||
          persistedDraft.lifecycle !== 'active')
      ) {
        set({ session: persisted })
        ui.showToast('方案已更新，请使用最新方案')
        return
      }
      const workingSession = persisted ?? s
      const workingDraft = persistedDraft ?? d
      const ev = evaluateGenerationDraft(workingDraft)
      if (!ev.ready) {
        ui.showToast('方案尚未就绪，请先补齐缺项')
        return
      }
      const resolved = resolveGenerationSource(workingDraft, workingSession, useKB.getState().bases)
      if (!resolved.ok) {
        ui.showToast(resolved.issue?.message ?? '参考资料已不存在，请重新选择')
        return
      }
      const spec = buildGenerationExecutionSpec(workingDraft, revision, resolved)
      if (!spec) {
        ui.showToast('方案已更新，请使用最新方案')
        return
      }
      // 原子置 generating（同步 set，无 await 插入）+ 落库
      const starting = beginDraftGeneration(workingDraft)
      const startSession: Session = { ...workingSession, generationDraft: starting }
      set({ session: startSession })
      try {
        await saveSessionDraftStrict(startSession)
      } catch {
        log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(workingSession.id) })
        ui.showToast('方案暂未保存，刷新可能丢失')
      }
      const outcome = await runGenerationSpec(spec)
      const cs = get().session
      const cur = cs?.generationDraft
      if (!cs || !cur || cur.id !== starting.id) return // 会话/草稿已被其他操作接管
      const cancelled = draftCancelIntentId === starting.id
      draftCancelIntentId = null
      const target = cancelled
        ? cancelDraft(cur)
        : outcome.questions > 0 || outcome.status === 'done'
          ? completeDraftGeneration(cur)
          : failDraftGeneration(cur) // 首次请求前失败（0 产出）：恢复 active，保留可重试信息
      const fin: Session = { ...cs, generationDraft: target }
      set({ session: fin })
      try {
        await saveSessionDraftStrict(fin)
      } catch {
        log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(fin.id) })
      }
      if (!cancelled && target.lifecycle === 'active') {
        ui.showToast('生成未能开始，方案已恢复，可重试')
      }
    } finally {
      draftStartLockId = null
    }
  },

  /** TASK-08：统一取消（实施路线 7.5）——文字/卡片/任务条三个入口共用本动作。
   *  active：直接置 cancelled 撤下方案；generating：先停执行（复用现有 cancel()），
   *  已产出题由 Pack draft/续跑机制处理，需求草稿收敛为 cancelled 不复活。 */
  async cancelGenerationDraft(reason: 'text' | 'card' | 'taskbar') {
    const s = get().session
    const d = s?.generationDraft
    if (!s || !d) return
    if (d.lifecycle === 'generating') {
      draftCancelIntentId = d.id
      get().cancel() // 停止执行；runGenCore 中止路径收尾后由启动收尾按取消语义收敛
      const next = cancelDraft(d)
      const ns: Session = { ...s, generationDraft: next }
      set({ session: ns })
      log('info', 'draft-v2', 'draft_cancelled', { reason, revision: next.revision })
      saveSessionDraftStrict(ns).catch(() => {
        log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(ns.id) })
      })
      return
    }
    if (d.lifecycle !== 'active') return
    // 卡片取消也必须以 IndexedDB 最新 revision 为准，避免旧标签把新方案覆盖成 cancelled。
    const persisted = await loadSessionById(s.id)
    const persistedDraft = persisted?.generationDraft
    if (
      persisted &&
      (!persistedDraft ||
        persistedDraft.id !== d.id ||
        persistedDraft.revision !== d.revision ||
        persistedDraft.lifecycle !== 'active')
    ) {
      set({ session: persisted })
      useUI.getState().showToast('方案已更新，请使用最新方案')
      return
    }
    const base = persisted ?? s
    const current = base.generationDraft
    if (!current || current.lifecycle !== 'active') return
    const next = cancelDraft(current)
    const ns: Session = { ...base, generationDraft: next }
    set({ session: ns })
    log('info', 'draft-v2', 'draft_cancelled', { reason, revision: next.revision })
    saveSessionDraftStrict(ns).catch(() => {
      log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(ns.id) })
    })
  },

  /** 完成态方案重新打开：必须以 IndexedDB 最新 revision/lifecycle 为准，避免旧标签覆盖新状态。 */
  async reopenGenerationDraft() {
    const s = get().session
    const d = s?.generationDraft
    if (!s || !d || d.lifecycle !== 'completed') return false

    const persisted = await loadSessionById(s.id)
    const persistedDraft = persisted?.generationDraft
    if (
      persisted &&
      (!persistedDraft ||
        persistedDraft.id !== d.id ||
        persistedDraft.revision !== d.revision ||
        persistedDraft.lifecycle !== 'completed')
    ) {
      set({ session: persisted })
      useUI.getState().showToast('方案已更新，请使用最新方案')
      return false
    }

    const base = persisted ?? s
    const current = base.generationDraft
    if (!current || current.lifecycle !== 'completed') return false
    const next = reopenDraft(current)
    const ns: Session = { ...base, generationDraft: next }
    set({ session: ns })
    try {
      await saveSessionDraftStrict(ns)
    } catch {
      log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(ns.id) })
      useUI.getState().showToast('方案暂未保存，刷新可能丢失')
    }
    return true
  },

  /** TASK-08：活动方案卡本地编辑（实施路线 7.6）——不调用模型，DraftUserAction 转换为
   *  受信任的本地 DraftPatch（turnId=ui:<uuid>，值一律 user_explicit）后走同一个 reducer；
   *  accept_current 只清 turnIssues 不加 revision；保存失败可见提示。 */
  updateGenerationDraft(action: DraftUserAction) {
    const s = get().session
    const d = s?.generationDraft
    if (!s || !d || d.lifecycle !== 'active') return
    const turnId = `ui:${uid('')}`
    if (action.kind === 'accept_current') {
      const next = clearDraftTurnIssues(d)
      if (next === d) return
      const ns: Session = { ...s, generationDraft: next }
      set({ session: ns })
      saveSessionDraftStrict(ns).catch(() => {
        log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(ns.id) })
      })
      return
    }
    const base: DraftPatch = {
      schemaVersion: 2,
      turnId,
      expectedDraftId: d.id,
      baseRevision: d.revision,
      intent: 'update',
      appendRequirements: [],
      removeRequirementIds: [],
    }
    let patch: DraftPatch
    let sourceAction: DraftSourceAction = { kind: 'preserve' }
    switch (action.kind) {
      case 'set_topic':
        patch = {
          ...base,
          topic: { kind: 'set', field: { value: action.value.trim(), basis: 'user_explicit', messageId: turnId } },
        }
        break
      case 'set_ai_total':
        patch = {
          ...base,
          countPlan: { kind: 'set_ai', total: { value: action.total, basis: 'user_explicit', messageId: turnId } },
        }
        break
      case 'set_custom_counts':
        patch = {
          ...base,
          countPlan: {
            kind: 'set_custom',
            typeCounts: Object.fromEntries(
              Object.entries(action.typeCounts).map(([k, v]) => [
                k,
                { value: v, basis: 'user_explicit', messageId: turnId },
              ]),
            ),
            ...(action.statedTotal !== undefined
              ? { statedTotal: { value: action.statedTotal, basis: 'user_explicit', messageId: turnId } }
              : {}),
            ...(action.unsetStatedTotal ? { unsetStatedTotal: true } : {}),
          },
        }
        break
      case 'append_requirement':
        patch = {
          ...base,
          appendRequirements: [{ value: action.text.trim(), basis: 'user_explicit', messageId: turnId }],
        }
        break
      case 'remove_requirement':
        patch = { ...base, removeRequirementIds: [action.id] }
        break
      case 'clear_source':
        patch = { ...base }
        sourceAction = { kind: 'clear' }
        break
      case 'resolve_source_conflict':
        patch = { ...base }
        sourceAction = action.decision === 'replace'
          ? action.source
            ? { kind: 'replace', source: action.source }
            : { kind: 'preserve' }
          : action.decision === 'clear'
            ? { kind: 'clear' }
            : { kind: 'preserve' }
        break
    }
    const next = applyDraftTurn(d, patch, sourceAction, s.id)
    if (!next || next === d) return
    const ns: Session = { ...s, generationDraft: next }
    set({ session: ns })
    saveSessionDraftStrict(ns).catch(() => {
      log('warn', 'draft-v2', 'draft_persist_failed', { session: sessionIdSlice(ns.id) })
    })
  },

  // 续写被截断的聊天回复：在上一条截断消息之后追加一条助手消息，让模型紧接其末尾继续生成
  // （应对 finish_reason=length 的静默截断；独立流式段，不使用「重发用户消息」以免污染会话历史）。
  async continueReply(msg: Message) {
    const ai = useAI.getState()
    const cfg: AIConfig = { providers: { ...ai.providers }, defaultId: ai.defaultId }
    const s = get().session
    if (!s) return
    const idx = s.messages.findIndex((m) => m.id === msg.id)
    if (idx === -1) return
    const snap = decodeSnapshot(s.provider)
    const contMsg: Message = { id: uid('m_'), role: 'assistant', content: '', tokens: 0 }
    // 先在截图消息后插入续写占位；同时移除原消息的「继续生成」按钮（已开始续写），保留截断标记以免误解
    const msgs = s.messages.slice()
    msgs.splice(idx + 1, 0, contMsg)
    msgs[idx] = { ...msgs[idx], actions: [] }
    const s2 = { ...s, messages: msgs }
    const abort = new AbortController()
    set({ session: s2, phase: 'chatting', abort, pendingChats: [] })

    let reply = ''
    let flushScheduled = false
    const flush = () => {
      flushScheduled = false
      if (reply === contMsg.content) return
      contMsg.content = reply
      const cs = get().session
      if (!cs) return
      const i = cs.messages.findIndex((m) => m.id === contMsg.id)
      if (i === -1) return
      const m2 = cs.messages.slice()
      m2[i] = { ...contMsg }
      set({ session: { ...cs, messages: m2 } })
    }

    try {
      const contextWindow = cfg.providers[snap.providerId]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      // 聊天输出上限遵循「默认不主动截断」：未配置 maxOutputTokens 则取 undefined（provider 不发送 max_tokens，
      // 由服务端按模型窗口自然输出完成）；截断了走「继续生成」兜底续写，而非靠小上限提前掐断。
      const outLimit = cfg.providers[snap.providerId]?.maxOutputTokens
      await maybeCompressChat(s2, cfg, snap, contextWindow, estimateTokens('继续')).catch(() => undefined)
      const messages = buildChatContext(s2, estimateTokens('继续'), contextWindow)
      // 模型上下文里已有截断的 assistant 原文（buildChatContext 已跳过空占位），系统指令让它从断处续写
      messages.push({
        role: 'system',
        content: '上一段回复因达到单次输出上限被截断。请紧接上一条 assistant 回复的末尾、从中断处自然续写剩余内容；不要复述或重写已经输出的内容。',
      })
      const result = await chat(
        messages,
        {
          providerId: snap.providerId,
          model: snap.model,
          temperature: 0.7,
          maxTokens: outLimit,
          signal: abort.signal,
          module: 'chat',
          stream: true,
          // 同 chat()：流式续写放宽到 3 分钟（始终思考模型首包慢）
          timeoutMs: 180_000,
          onToken: (delta) => {
            if (!delta) return
            reply += delta
            if (!flushScheduled) {
              flushScheduled = true
              requestAnimationFrame(flush)
            }
          },
        },
        cfg,
      )
      if (flushScheduled) flush()
      contMsg.tokens = result.usage.outputTokens
      if (result.finishReason === 'length') {
        contMsg.truncated = true
        contMsg.actions = [{ id: uid('a_'), label: GEN_CONTINUE_LABEL, kind: 'continue' }]
      }
      let latest = get().session ?? s2
      const li = latest.messages.findIndex((m) => m.id === contMsg.id)
      if (li !== -1 && (contMsg.truncated || contMsg.actions)) {
        const m2 = latest.messages.slice()
        m2[li] = { ...contMsg }
        latest = { ...latest, messages: m2 }
      }
      set({ session: latest, phase: 'idle', abort: null })
      saveSessionSerial(latest)
      void get().refreshSessions()
    } catch (e) {
      if (flushScheduled) flush()
      if (isAbortError(e)) {
        if (!contMsg.content) s2.messages = s2.messages.filter((m) => m !== contMsg)
        await saveSession(s2)
        set({ session: get().session ?? s2, phase: 'idle', abort: null, error: '已停止续写' })
      } else {
        contMsg.content = contMsg.content || CONTINUE_FAIL_FALLBACK
        await saveSession(s2)
        set({ session: get().session ?? s2, phase: 'idle', abort: null, error: e instanceof Error ? e.message : '续写失败，请重试' })
      }
      void get().refreshSessions()
    }
  },

  async generate(input: string, opts?: GenOpts) {
    const ai = useAI.getState()
    const { structure } = get()
    const ui = useUI.getState()

    // 实际生效厂商：默认优先调用，未配置时回退到已配置厂商（见 resolveActiveId）
    const activeId = ai.getActiveId()
    const provider = ai.providers[activeId]
    if (!provider?.apiKey || !provider.model) {
      ui.showToast('请先配置 AI 模型（我的 → AI 设置）')
      return
    }
    if (Object.values(structure).every((n) => n <= 0)) {
      ui.showToast('至少选择一种题型')
      return
    }
    const trimmed = input.trim()
    if (trimmed.length < 2) {
      ui.showToast('请输入学习内容（2-100 字）')
      return
    }

    // 系统级上限校验（兜底）：即使 UI/模板绕过限制，也在发起任何请求前拦截，保证系统不因超大请求而异常
    const total = get().structureMode === 'ai'
      ? get().structureTotal
      : Object.values(get().structure).reduce((a, b) => a + b, 0)
    if (total > MAX_QUESTIONS_PER_GENERATION) {
      ui.showToast(`单次最多生成 ${MAX_QUESTIONS_PER_GENERATION} 题，超出部分请分批生成（如分 2 次各 500 题）`)
      return
    }

    const isAi = get().structureMode === 'ai'
    // AI 推荐模式：structure 仅承载总题数（放 single 位），题型分布由 AI 自行搭配。
    // 必须用 zeroStructure 承载——若叠加 defaultStructure(含 judge:5/fill:5)，结构求和就 > 用户选的总题数，
    // 导致「AI 推荐显示 N 道、实际却生成 N+默认题数」(如选 10 却生成 20)。生成核心只对结构求和、不按键位分型，
    // 零基承载后 total 恰好等于 structureTotal，实际题型仍由 AI 自由生成。
    const genStructure = isAi
      ? { ...zeroStructure(), single: get().structureTotal }
      : { ...structure }
    // 提示题数来源：自定义模式按题型结构，AI 推荐模式按总题数（输入里的「N题」在建议按钮流程中已兜底并入 AI 总题数）
    ui.showToast(`将按${isAi ? ' AI 推荐结构生成' : '题型结构生成'} ${total} 题`)
    // 参考资料：从会话里往回找最近一条携带 refs 的用户消息（跳过「难一点」这类无材料的调整句），
    // 保证「导入文件/引用库 → 出题 → 补一句调整再出题」不丢材料（见 app_bug 7.x）
    const refs = [...(get().session?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'user' && m.refs)?.refs
    // 快捷生成由调用方直接携带生题范围；V2 卡片生成走 startGenerationFromDraft。
    const kbScope = opts?.kbScope
    // TASK-08 最小抽取：快捷生成与对话卡片共用同一执行入口——
    // 先构建不可变 GenerationExecutionSpec（origin=quick），再交 runGenerationSpec 调 runGenCore
    const spec = buildQuickExecutionSpec(
      trimmed,
      isAi ? 'ai' : 'custom',
      genStructure,
      refs,
      kbScope && kbScope.volumes.length > 0 ? kbScope : undefined,
    )
    await runGenerationSpec(spec, { userMsgAdded: opts?.userMsgAdded, placeholderId: opts?.placeholderId })
  },

  /** 断点续跑「继续补齐」：按草稿携带的目标快照补齐缺口，已生成题目作为种子参与计数与查重 */
  async resume(packId: string) {
    const ui = useUI.getState()
    const pack = get().drafts[packId] ?? (await loadDraft(packId))
    if (!pack) {
      ui.showToast('草稿不存在或已入库')
      return
    }
    const t = pack.genTarget
    if (!t) {
      ui.showToast('该草稿缺少生成目标，无法补齐')
      return
    }
    if (get().phase === 'generating' || get().phase === 'validating') {
      ui.showToast('正在生成中，请稍候')
      return
    }
    const target = Object.values(t.structure).reduce((a, b) => a + b, 0)
    if (pack.questions.length >= target) {
      ui.showToast(`已达目标 ${target} 题，无需补齐`)
      return
    }
    if (!get().drafts[packId]) set({ drafts: { ...get().drafts, [pack.id]: pack } })
    await runGenCore({
      input: t.input,
      mode: t.mode,
      structure: t.structure,
      seed: pack.questions,
      reusePack: pack,
      refs: t.refs,
      // 多卷续跑：genTarget 携带的卷序列与卷数复原（「继续生成剩余 X 卷」按钮走这里）
      kbScope: t.kbScope && t.kbScope.volumes.length > 0 ? t.kbScope : undefined,
    })
  },

  cancel() {
    get().abort?.abort()
  },

  /** 清除某条助手消息下方的建议操作按钮（点「取消」后不再显示） */
  dismissActions(msgId: string) {
    const s = get().session
    if (!s) return
    const messages = s.messages.map((m) => (m.id === msgId ? { ...m, actions: undefined } : m))
    set({ session: { ...s, messages } })
    saveSessionSerial({ ...s, messages })
  },

  /** 重新生成上一条用户消息的回复（停止/失败后「重新回复/继续」）：
   *  按原意图分诊——命中出题词重跑「确认回复 + 建议按钮」，否则重跑流式聊天；不重复追加用户消息。 */
  async regenerateLast() {
    const g = get()
    const ai = useAI.getState()
    const activeId = ai.getActiveId()
    const provider = ai.providers[activeId]
    if (!provider?.apiKey || !provider.model) {
      useUI.getState().showToast('请先配置 AI 模型（我的 → AI 设置）')
      return
    }
    if (g.phase === 'chatting' || g.phase === 'generating' || g.phase === 'validating') return
    const lastUser = [...(g.session?.messages ?? [])].reverse().find((m) => m.role === 'user')
    if (!lastUser) {
      useUI.getState().showToast('没有可重新生成的消息')
      return
    }
    // 思考开关遵循用户配置（不再运行时强制关闭）
    const cfg: AIConfig = {
      providers: { ...ai.providers },
      defaultId: ai.defaultId,
    }
    const snap = { providerId: activeId, model: provider.model }
    const s = get().session
    if (!s) {
      useUI.getState().showToast('没有可重新生成的消息')
      return
    }
    const ph: Message = { id: uid('m_'), role: 'assistant', content: '', tokens: 0 }
    s.messages.push(ph)
    set({ session: { ...s }, phase: 'chatting', error: null })
    await get().handleGenerationDraftTurn({
      input: lastUser.content,
      cfg,
      snapshot: snap,
      userMsgAdded: true,
      placeholderId: ph.id,
      userMessageId: lastUser.id,
      refs: lastUser.refs,
    })
  },

  /** 重试上一条回复：统一走 regenerateLast 按原意图分诊（出题意图→重跑确认回复+建议按钮，聊天→重跑流式）。
   *  修复「聊天回复失败点重试却提示至少选择一种题型」：重试不再盲目进生题流。 */
  async retryLast() {
    const g = get()
    const ai = useAI.getState()
    const activeId = ai.getActiveId()
    const provider = ai.providers[activeId]
    if (!provider?.apiKey || !provider.model) {
      useUI.getState().showToast('请先配置 AI 模型（我的 → AI 设置）')
      return
    }
    if (g.phase === 'chatting' || g.phase === 'generating' || g.phase === 'validating') return
    await get().regenerateLast()
  },

  /** 更新草稿题包并同步会话消息题数（编辑/删除/批量处理后调用） */
  async syncDraft(packId: string, questions: Question[]) {
    const pack = get().drafts[packId]
    if (!pack) return
    const updated = { ...pack, questions }
    set({ drafts: { ...get().drafts, [packId]: updated } })
    await saveDraft(updated)
    const session = get().session
    if (session) {
      const msg = session.messages.find((m) => m.result?.id === packId)
      if (msg?.result) {
        msg.result.questionCount = questions.length
        msg.result.validCount = countValidQuestions(questions)
      }
      await saveSession(session)
    }
  },

  async updateQuestion(packId, questionId, patch) {
    const pack = get().drafts[packId]
    if (!pack) return
    const questions = pack.questions.map((q) => (q.id === questionId ? { ...q, ...patch } : q))
    await get().syncDraft(packId, questions)
  },

  async removeQuestion(packId, questionId) {
    const pack = get().drafts[packId]
    if (!pack) return
    const questions = pack.questions.filter((q) => q.id !== questionId)
    await get().syncDraft(packId, questions)
  },

  /** 批量移除所有未通过校验的题目（见 PRD 4.9） */
  async removeIssues(packId) {
    const pack = get().drafts[packId]
    if (!pack) return
    const questions = pack.questions.filter((q) => validateQuestion(q).length === 0)
    await get().syncDraft(packId, questions)
  },

  /** 入库：仅写入通过校验的题目（见 PRD 4.9 / 5.2），异常题默认不入库。
   *  draft 可能属于历史会话（聊天记录流/生成历史），故同步更新所有会话里该题包的状态，
   *  而不仅当前活跃会话。V2-F03：packs + sessions + config 草稿在同一 readwrite
   *  事务内原子提交，任何一步失败整体回滚，杜绝「实体已入库但会话仍是草稿」的半完成态。 */
  async addToBank(packId: string) {
    const pack = get().drafts[packId]
    if (!pack) return
    const valid = pack.questions.filter((q) => validateQuestion(q).length === 0)
    if (valid.length === 0) {
      log('warn', 'pack', `入库被拦截：无有效题目 ${packId}`, { packId, total: pack.questions.length })
      useUI.getState().showToast('没有可通过校验的题目')
      return
    }
    log('info', 'pack', `入库 ${valid.length} 题 ${packId}`, { packId, total: pack.questions.length, valid: valid.length })
    // 题包索引（W4i）：入库前对同名标题做序号后缀，避免多次「主题同名」生成在题库里撞名难检索
    const finalPack: Pack = { ...pack, questions: valid, created_at: Date.now(), title: await uniquePackTitle(pack.title) }
    // V2-F03：与 addPack 同序写库，但题包/会话/草稿落在同一事务内，避免半提交
    await addPackToBankAtomic(finalPack, { packId, questionCount: valid.length })
    // 事务已提交：刷新题库内存态（保持按时间倒序、最新题包置顶，与 usePacks.addPack 一致）
    usePacks.setState({
      packs: [...usePacks.getState().packs, finalPack].sort(
        (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0),
      ),
    })
    const drafts = { ...get().drafts }
    delete drafts[packId]
    set({ drafts })
    const curId = get().session?.id
    if (curId) {
      const reload = await loadSession(curId)
      if (reload) set({ session: reload })
    }
    void get().refreshSessions()
    useUI.getState().showToast('已入库')
  },

  /** 删除题包记录：从所有会话里移除该条记录 + 清空草稿数据。
   *  已入库的题包本体在题库中，这里只删「记录 + 草稿」，不影响题库；未入库的则连同题目彻底清除。 */
  async deleteDraft(packId: string) {
    const sessions = await listSessions()
    for (const s of sessions) {
      const before = s.messages.length
      s.messages = s.messages.filter((m) => !m.result || m.result.id !== packId)
      if (s.messages.length !== before) await saveSession(s)
    }
    const drafts = { ...get().drafts }
    delete drafts[packId]
    await clearDraft(packId)
    set({ drafts })
    const curId = get().session?.id
    if (curId) {
      const reload = await loadSession(curId)
      if (reload) set({ session: reload })
    }
    void get().refreshSessions()
    useUI.getState().showToast('已删除')
  },
  }
})

// HMR 自我保护：热更新时保留 store 实例与状态（loaded/session/草稿等），
// 避免开发期改源码导致 store 被重建为「空会话」，让用户误以为生成记录丢失。
// 生产构建无 import.meta.hot，直接走 createGenerateStore()。
export const useGenerate: ReturnType<typeof createGenerateStore> =
  (import.meta.hot?.data?.useGenerate as ReturnType<typeof createGenerateStore> | undefined) ??
  createGenerateStore()
if (import.meta.hot) {
  import.meta.hot.data.useGenerate = useGenerate
}

// 生成/校验期间的「误刷新·离开」兜底：SSE 长连接流最怕整页卸载（刷新/跳转/关标签页会立刻掐断在跑的请求，
// 浏览器报 net::ERR_ABORTED）。普通的点击/滚动不会触发，但刷新/离开是真实威胁。
// 生成进行中挂原生 beforeunload，让浏览器弹「离开将中断生成」的确认框——选「留下」则流不会断。
let unloadGuardOn = false
function setUnloadGuard(active: boolean) {
  if (active === unloadGuardOn) return
  unloadGuardOn = active
  if (active) window.addEventListener('beforeunload', onBeforeUnload)
  else window.removeEventListener('beforeunload', onBeforeUnload)
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault()
  e.returnValue = ''
}
useGenerate.subscribe((state) => {
  setUnloadGuard(state.phase === 'generating' || state.phase === 'validating' || state.phase === 'chatting')
})
setUnloadGuard(
  useGenerate.getState().phase === 'generating' ||
    useGenerate.getState().phase === 'validating' ||
    useGenerate.getState().phase === 'chatting',
)
