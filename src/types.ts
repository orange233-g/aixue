export interface Pack {
  id: string
  title: string
  category: string
  /** 题包来源：ai 生成 / 手动导入 / 手动创建（V2 新增字段，读取时兼容） */
  source?: 'ai' | 'import' | 'manual'
  /** 题包一句话简介（V2 新增，读取时兼容；生成时自动派生，便于用户快速了解题包内容） */
  description?: string
  meta: {
    difficulty: string
    objectives: string[]
    /** 标签（V2 新增，读取时兼容；生成时 AI 派生，如 Python、编程、入门） */
    tags?: string[]
    /** 题型（人类可读名列表，V2 新增，读取时兼容；由题目派生） */
    types?: string[]
    /** 来源描述（V2 新增，读取时兼容；如 AI 生成 / 用户整理 / 手动导入） */
    source?: string
    /** 版本（V2 新增，默认 "1.0"） */
    version?: string
    /** 格式版本（V2 新增，默认 "1.0"） */
    formatVersion?: string
  }
  chapters: Chapter[]
  questions: Question[]
  created_at: number
  /** 生成目标快照（V2 新增，读取时兼容）：中断/不足交付的草稿可据此「继续补齐」到原目标 */
  genTarget?: {
    input: string
    mode: 'ai' | 'custom'
    structure: Record<QuestionTypeId, number>
    /** 生成依据的参考资料块（导入文件/知识库引用），「继续补齐」时同源复原，避免中断后丢材料 */
    refs?: string
    /** 生题范围（Phase 3）：中断续跑「继续生成剩余卷」时复原卷序列与 kbRef 剥离基准 */
    kbScope?: KbScope
  }
}

export interface Chapter {
  id: string
  title: string
  summary: string
  knowledge_points: KnowledgePoint[]
  question_ids: string[]
  /** 二级章节（题包支持两级：一级「大类」下挂二级「子类」叶章）；旧包无此字段则退化为单层 */
  children?: Chapter[]
}

export interface KnowledgePoint {
  id: string
  title: string
  content: string
  examples: string[]
  pitfalls: string[]
}

export interface Question {
  id: string
  type: QuestionTypeId
  stem: string
  material?: string
  options?: string[]
  answer: string
  explanation: string
  score?: number
  kp_ids: string[]
  difficulty: 1 | 2 | 3
}

export type QuestionTypeId =
  | 'single' | 'multiple' | 'judge' | 'fill' | 'match'
  | 'order' | 'short' | 'case' | 'essay'

/** 单次生成题数上限（系统级红线，见 PRD：保证一次生成在合理耗时/预算内，超限由 UI + 生成前校验双重拦截） */
export const MAX_QUESTIONS_PER_GENERATION = 1000
/** 自定义模式下单个题型的题数上限 */
export const MAX_PER_TYPE = 100

export interface QuestionType {
  id: QuestionTypeId
  name: string
  category: 'objective' | 'subjective'
  grading: 'auto' | 'manual' | 'ai'
  hasOptions: boolean
  hasMaterial: boolean
}

export const QUESTION_TYPES: QuestionType[] = [
  { id: 'single',   name: '单选题',   category: 'objective',   grading: 'auto',   hasOptions: true,  hasMaterial: false },
  { id: 'multiple', name: '多选题',   category: 'objective',   grading: 'auto',   hasOptions: true,  hasMaterial: false },
  { id: 'judge',    name: '判断题',   category: 'objective',   grading: 'auto',   hasOptions: true,  hasMaterial: false },
  { id: 'fill',     name: '填空题',   category: 'objective',   grading: 'auto',   hasOptions: false, hasMaterial: false },
  { id: 'match',    name: '匹配题',   category: 'objective',   grading: 'auto',   hasOptions: false, hasMaterial: false },
  { id: 'order',    name: '排序题',   category: 'objective',   grading: 'auto',   hasOptions: true,  hasMaterial: false },
  { id: 'short',    name: '简答题',   category: 'subjective',  grading: 'manual', hasOptions: false, hasMaterial: false },
  { id: 'case',     name: '案例分析', category: 'subjective',  grading: 'ai',     hasOptions: false, hasMaterial: true },
  { id: 'essay',    name: '论文题',   category: 'subjective',  grading: 'manual', hasOptions: false, hasMaterial: false },
]

export interface Session {
  id: string
  title: string
  created: number
  summary: string
  messages: Message[]
  packages: PackageRef[]
  provider: string
  /** 已折叠进 summary 的前缀消息条数（阶段3：只统计/发送从该下标起的消息，避免把已压缩的旧内容每轮重复压缩；旧会话/未压缩默认 0，见 chatWindowKeep/maybeCompressChat） */
  summaryBound?: number
  /** 对话式生题 V2：当前会话尚未执行的需求草稿（实施路线 5.1，TASK-05 接线）。
   *  会话工作流状态，随本记录存入 sessions store；与「已生成题包草稿 Pack draft
   *  （config(gen-draft:*)）」不是同一种数据。旧记录读取时自然为 undefined。 */
  generationDraft?: GenerationDraft
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  tokens: number
  /** 参考资料块（导入文件 / 知识库引用，V3 新增字段，读取时兼容）：
   *  气泡只显示正文与「附资料」标记，发给模型时由 buildChatContext/buildContext 拼到正文之后，
   *  生题时 generate() 自动携带最近一条用户消息的 refs，材料随批次提示下发。 */
  refs?: string
  result?: PackageRef
  /** 助手消息下方挂载的建议操作按钮（Trae 式：模型回复后，在回复气泡下方弹出可点击的选项） */
  actions?: ChatAction[]
  /** 固定模板回复（如多轮问询「好的，想围绕…」）标记：渲染时逐字显示，模拟 AI 打字节奏，避免整句突兀弹出 */
  reveal?: boolean
  /** 普通聊天回复因达到单次输出上限被截断（finish_reason=length）：渲染截断提示并可「继续生成」续写 */
  truncated?: boolean
  /** 对话式生题 V2 迁移桥（实施路线 7.3）：本条消息挂载的生题动作归属的草稿版本。
   *  旧按钮执行前必须与当前 Session.generationDraft 的 id+revision 比对，过期即失效（TASK-09 UI 门禁）。 */
  proposalRef?: { draftId: string; revision: number }
}

/** 建议操作按钮：kind 决定点击行为（生成 / 展开题型面板 / 取消 / 继续生成 / 续跑剩余卷） */
export interface ChatAction {
  id: string
  label: string
  kind: 'configure' | 'dismiss' | 'continue' | 'resume' | 'source_new' | 'source_keep' | 'source_clear'
  /** resume 专用：续跑时复用的草稿题包 id（已完成卷所在题包） */
  packId?: string
  /** 来源冲突动作专用：本轮真实资料只携带消息 id，正文仍从 Message.refs 精确读取 */
  source?: GenerationDraftSource
}

export interface PackageRef {
  id: string
  title: string
  questionCount: number
  /** 通过校验、可入库的题数；缺省时兼容旧记录，按 questionCount 处理 */
  validCount?: number
  status: 'draft' | 'in_bank' | 'removed'
  /** 生题时被过滤（rejected）的统计（V2 新增，读取时兼容；仅诊断展示，不入题包本体） */
  rejects?: RejectStats
}

/** 生题阶段被过滤的题块统计（用于定位「实际题数 < 请求数」的缺口成因） */
export interface RejectStats {
  /** 解析失败：题块格式无法解析（parseMarkdown 抛错） */
  parse: number
  /** 字段校验不过：题干/答案/解析缺失、选项/答案非法等 */
  invalid: number
  /** 题干重复：与已生成题跨批查重命中 */
  duplicate: number
  /** 校验不过的具体原因拆分（如 解析缺失/答案缺失…） */
  invalidByReason: Record<string, number>
}

export interface LearningState {
  kp_id: string
  mastery: number
  state: '未学习' | '学习中' | '基本掌握' | '已掌握'
  interval_days: number
  next_review: string
  wrong_count: number
  last_result: 'correct' | 'wrong'
  /** 最近答题结果（滚动窗口，掌握度计算依据；V2 新增字段，读取时兼容） */
  recent?: boolean[]
}

/** 错题记录（见 PRD 4.5：刷题答错自动收录，按题包分组） */
export interface WrongRecord {
  questionId: string
  packId: string
  packTitle: string
  /** 题目快照（题包删除时级联清理，快照保证错题本可独立展示） */
  question: Question
  wrongCount: number
  /** 错题重练中连续答对次数，达到阈值标记已掌握 */
  correctStreak: number
  mastered: boolean
  lastWrongAt: number
  createdAt: number
}

/** 作答记录（见 PRD 4.2：当日已刷题数 / 最近学习时间统计） */
export interface AnswerRecord {
  id: number
  packId: string
  questionId: string
  correct: boolean
  /** 作答场景：刷题 / 复习 / 错题重练 */
  mode: 'quiz' | 'review' | 'wrong'
  timestamp: number
}

export interface AIConfig {
  providers: Record<string, ProviderCfg>
  defaultId: string
  /** 一次性迁移标记：已清空早期自动填入的旧价（内置价表已废弃，定价现为选填） */
  pricesCleared?: boolean
  /** 用户自建的自定义提供商（不在内置 manifest 内）：运行时注册 OpenAI 兼容适配器，随 ai-config 持久化。
   *  其 ProviderCfg（Key/模型/定价等）仍存于 providers 字典（key=meta.id），与其他厂商完全同构。 */
  customProviders?: CustomProviderMeta[]
}

export interface CustomProviderMeta {
  id: string
  name: string
  /** API 地址（已归一化，https） */
  baseUrl: string
}

export interface ProviderCfg {
  apiKey: string
  model: string
  baseUrl?: string
  fetchedModels?: string[]
  /** 该服务商一份自定义定价（非按模型） */
  price?: PriceItem
  /** 通用推理抑制开关：推理模型会把 max_tokens 预算消耗在 reasoning 上导致正文被截断。
   *  由用户在 AI 设置按需开启，适配层通用透传，不针对任何特定厂商硬编码（见铁律）。 */
  disableThinking?: boolean
  /** 生题场景运行时关闭思考：生题批次是时延敏感场景，「始终思考」类模型每批先吐 reasoning 再出正文，
   *  单批前置等待约 1 分钟。开启后仅 module='generate' 的请求临时注入 thinking disabled（聊天仍按 disableThinking）；
   *  缺省视为 true（默认启用），设 false 关闭。对「始终思考」不支持关闭的模型，适配层已有自动剥离降级兜底。 */
  genDisableThinking?: boolean
  /** 模型上下文窗口（token），用于聊天超长时按预算自动压缩上下文。
   *  通用、可配置的兜底机制（见铁律）：未设置时用全局默认 DEFAULT_CONTEXT_WINDOW，可为任一厂商/模型独立配置，不写死单家。 */
  contextWindow?: number
  /** 单次回复输出上限（token）：聊天等场景的 maxTokens 取值。
   *  遵循「尽量不主动截断」：未设置时不设上限（provider 不发送 max_tokens，由服务端按模型窗口自然输出，截断走「继续生成」续写）；
   *  设置在时以其为准约束输出。通用、可配置机制，可为任一厂商/模型独立配置，不写死单家（见铁律）。 */
  maxOutputTokens?: number
  /** 服务商级「高峰时段」开关：开启后该厂商下参与峰谷的模型按高峰/空闲分别计价；关闭则一律平峰价（适配没有峰谷定价的厂商） */
  peakEnabled?: boolean
  /** 服务商级高峰时段（24 小时制，偶数个元素两两一段，如 [9,12,14,18] = 9:00-12:00、14:00-18:00）。
   *  支持跨午夜（如 [22,6] = 22:00-次日 6:00）。缺省回退 [9,12,14,18]。 */
  peakTimes?: number[]
  /** 高峰时段是否处于「自定义」模式：为 true 时忽略预设匹配，按 peakTimes 逐段编辑（与预设下拉互斥） */
  peakCustom?: boolean
}

export interface PriceItem {
  input?: number
  cacheRead?: number
  output?: number
  /** 谷价（空闲时段单价，元/百万 token）；是否启用谷价由服务商级「高峰时段」开关决定 */
  inputOff?: number
  cacheReadOff?: number
  outputOff?: number
}

export interface UsageRecord {
  id: string | number
  module: string
  providerId: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  cost: number | null
  timestamp: number
}

/** 偏好设置（IndexedDB config store，key='preferences'） */
export interface Preferences {
  /** 每日复习上限（见 PRD 4.6，默认 20） */
  dailyReviewLimit: number
}

/**
 * 导出文件（见 PRD 6.7 + V2-F01）：pack=题包内容（可分享）| backup=完整备份。
 * version=2：白名单导出 packs/knowledgeBases/learning/wrongs/answers/usage/categories/preferences；
 * AI Key、Authorization、日志、会话消息永久排除，不随备份导出。
 * version=1 旧格式保持只读兼容（读入时缺失字段按空数组兜底，见 io/validate.ts）。
 */
export interface ExportFile {
  version: 1 | 2
  type: 'pack' | 'backup'
  /** pack 类型：单个题包本体；backup 且无题包时（仅知识库导出）可为空 */
  pack?: Pack
  /** backup 类型：全部题包 */
  packs?: Pack[]
  /** 知识库（V2-F01 新增），仅 backup 类型包含 */
  knowledgeBases?: KBDoc[]
  /** 学习数据（掌握度 / 复习队列），仅 backup 类型包含 */
  learning?: LearningState[]
  /** 错题本，仅 backup 类型包含 */
  wrongs?: WrongRecord[]
  /** 作答历史（首页周统计 / 最近学习时间），V2-F01 新增，仅 backup 类型包含 */
  answers?: AnswerRecord[]
  /** 用量统计，仅 backup 类型包含 */
  usage?: UsageRecord[]
  /** 分类（V2-F01 新增），仅 backup 类型包含 */
  categories?: string[]
  /** 偏好设置（V2-F01 新增），仅 backup 类型包含 */
  preferences?: Preferences
  /** 导出时间戳 */
  exportedAt?: number
}

export interface GenerateRequest {
  content: string
  structure: Record<QuestionTypeId, number>
  source: 'ai' | 'custom'
  /** 参考资料块（导入文件 / 知识库引用）：随每批生题提示下发，供模型依据材料出题 */
  refs?: string
  duration?: number
}

/* ---------------- 对话式生题 V2：GenerationDraft 领域模型（实施路线 4.1～4.4，TASK-01 落地） ----------------
 * 与「已生成题包草稿 Pack draft（config(gen-draft:*)）」不是同一种数据：
 * GenerationDraft 是当前会话尚未执行的生题需求草稿，随 Session 存入 sessions（TASK-05 接线）。
 * 本区块仅为类型定义，生产 Store 暂不使用（TASK-06 起影子接入、TASK-07 起接管）。 */

/** 字段来源依据（实施路线 4.2）：优先级 user_explicit > app_derived > model_inferred > app_default */
export type DraftValueBasis =
  | 'user_explicit'
  | 'app_derived'
  | 'model_inferred'
  | 'app_default'

export interface DraftValue<T> {
  value: T
  basis: DraftValueBasis
  /** 产生该值的轮次消息 id（可选溯源） */
  messageId?: string
  /** 用户原文证据（可选） */
  evidence?: string
}

/** 生题资料来源快照：精确指向携带 Message.refs 的用户消息，不复制 refs 正文；
 *  KBVolume 只含 id/偏移，知识库正文执行时懒加载（实施路线 4.2） */
export interface GenerationDraftSource {
  sourceMessageId?: string
  kbScope?: KbScope
}

/** 题数计划判别联合（实施路线 4.2）：不并列保存长期有效的 mode/total/typeCounts 三份事实 */
export type GenerationCountPlan =
  | {
      mode: 'ai'
      total: DraftValue<number>
    }
  | {
      mode: 'custom'
      typeCounts: Partial<Record<QuestionTypeId, DraftValue<number>>>
      /** 仅用于校验用户明确说出的总数；最终总数仍由 typeCounts 合计派生 */
      statedTotal?: DraftValue<number>
    }

/** 草稿问题码（实施路线 4.5）：validator（TASK-02）产出，reducer 的 turnIssues 复用同类型 */
export type DraftIssueCode =
  | 'TOPIC_OR_SOURCE_REQUIRED'
  | 'TOTAL_REQUIRED'
  | 'TOTAL_OUT_OF_RANGE'
  | 'TYPE_COUNT_OUT_OF_RANGE'
  | 'CUSTOM_TYPES_REQUIRED'
  | 'TOTAL_TYPE_SUM_MISMATCH'
  | 'DUPLICATE_TYPE_CONFLICT'
  | 'COUNT_PLAN_REQUIRED'
  | 'COUNT_NOT_EXPLICIT'
  | 'TURN_UPDATE_NOT_APPLIED'
  | 'SOURCE_MISSING'
  | 'SOURCE_POLICY_CONFLICT'
  | 'DRAFT_NOT_ACTIVE'

export interface DraftIssue {
  code: DraftIssueCode
  field?: string
  message: string
}

/** 当前会话尚未执行的生题需求草稿（实施路线 4.2 冻结骨架，不得自行改名/拆分/加平行事实字段）。
 *  lifecycle 不含 ready：是否就绪由 validator 派生（TASK-02），绝不持久化两份相互冲突的事实 */
export interface GenerationDraft {
  schemaVersion: 2
  id: string
  sessionId: string
  revision: number
  lifecycle: 'active' | 'generating' | 'completed' | 'cancelled'
  createdAt: number
  updatedAt: number

  topic?: DraftValue<string>
  countPlan?: GenerationCountPlan
  requirements: Array<DraftValue<string> & { id: string }>
  source: GenerationDraftSource

  /** 用于拒绝同一模型响应被重复应用（保留最近 20 条，见 draftReducer） */
  appliedTurnIds: string[]
  /** 最近一次未能应用的歧义/协议问题；成功更新或用户明确沿用旧方案时清空 */
  turnIssues: DraftIssue[]
}

/** 题数计划补丁（实施路线 4.4 内部协议；wire 层 DraftPatchWireV2 由 TASK-03 转换而来） */
export type CountPlanPatch =
  | { kind: 'set_ai'; total?: DraftValue<number> }
  | {
      kind: 'set_custom'
      typeCounts: Partial<Record<QuestionTypeId, DraftValue<number>>>
      statedTotal?: DraftValue<number>
      unsetStatedTotal?: boolean
    }
  | {
      kind: 'patch_custom'
      set: Partial<Record<QuestionTypeId, DraftValue<number>>>
      unset: QuestionTypeId[]
      statedTotal?: DraftValue<number>
      unsetStatedTotal?: boolean
    }
  | { kind: 'unset' }

/** 每轮需求增量补丁（实施路线 4.4）：只接收已完成 schema/evidence 归一的内部 patch；
 *  turnId/expectedDraftId/baseRevision 由 App 注入，不信任模型伪造 */
export interface DraftPatch {
  schemaVersion: 2
  turnId: string
  expectedDraftId?: string
  baseRevision: number
  intent: 'chat' | 'update' | 'replace' | 'cancel'
  acknowledgement?: string
  topic?: { kind: 'set'; field: DraftValue<string> } | { kind: 'unset' }
  countPlan?: CountPlanPatch
  /** 只表达是否沿用/清除旧 source 的用户语义；实际资料 id/refs 永远由 App 决定（经 sourceAction 落地） */
  sourcePolicy?: { kind: 'keep_existing' | 'clear'; evidence: string }
  appendRequirements: Array<DraftValue<string>>
  removeRequirementIds: string[]
}

/** App 根据本轮真实资料/finalIntent/sourcePolicy 归一出的可执行来源动作（实施路线 4.4/5.4） */
export type DraftSourceAction =
  | { kind: 'preserve' }
  | { kind: 'replace'; source: GenerationDraftSource }
  | { kind: 'clear' }

/** 草稿确定性评估结果（实施路线 4.5）：是否 ready 完全由本地规则计算，
 *  模型输出 complete/gathering/show_button 一律不作为按钮依据 */
export interface DraftEvaluation {
  ready: boolean
  /** 生效总题数：ai 模式取 total；custom 模式由题型合计派生 */
  effectiveTotal?: number
  missing: DraftIssue[]
  conflicts: DraftIssue[]
  warnings: DraftIssue[]
  /** 由问题码按固定优先级映射的下一问提示（冲突修正 > 缺主题/资料 > 缺总题数 > 缺自定义题型） */
  nextQuestion?: string
}

/** 不可变执行快照（实施路线 4.6）：快捷生成与对话生成共用的最终生题参数。
 *  点击生成时一次性构建；启动后不再读取活动草稿的可变字段 */
export interface GenerationExecutionSpec {
  origin:
    | { kind: 'quick' }
    | {
        kind: 'conversation'
        draftId: string
        draftRevision: number
        sessionId: string
      }
  input: string
  mode: 'ai' | 'custom'
  structure: Record<QuestionTypeId, number>
  total: number
  refs?: string
  kbScope?: KbScope
}

/** 活动方案卡的本地编辑动作（实施路线 7.6 / TASK-08 落地）：不调用模型，
 *  转换为受信任的本地 DraftPatch 后复用同一个 reducer/validator。
 *  UI set/append 值一律 user_explicit，turnId 形如 ui:<uuid> */
export type DraftUserAction =
  | { kind: 'set_topic'; value: string }
  | { kind: 'set_ai_total'; total: number }
  | {
      kind: 'set_custom_counts'
      typeCounts: Partial<Record<QuestionTypeId, number>>
      statedTotal?: number
      unsetStatedTotal?: boolean
    }
  | { kind: 'append_requirement'; text: string }
  | { kind: 'remove_requirement'; id: string }
  | { kind: 'clear_source' }
  /** 解决同轮「新资料 + source_policy」冲突；来源选择仍经统一 reducer 落地 */
  | {
      kind: 'resolve_source_conflict'
      decision: 'replace' | 'preserve' | 'clear'
      source?: GenerationDraftSource
    }
  /** 只清 turnIssues，不改需求 revision（用户「仍按当前方案」） */
  | { kind: 'accept_current' }

/* ---------------- 知识库（Phase 2/3，见 PRD §4 与可行性分析 §4.2） ---------------- */

/** 原文证据层：每份源文件按段落切片留存（保真/回源用，见可行性分析 §4.5 防线①）。
 *  text 为该 span 对应的原文片段；所有片段按 span.start 排序拼接可还原全文。 */
export interface KBSourceText {
  file: string
  /** 该片段在源文件解析文本中的偏移区间（回源定位），旧数据可能缺失 */
  span?: { start: number; end: number }
  text: string
}

/** 清洗后正文的一段章节：只存 start/end 偏移，正文仅存一份 bodyText（单源偏移，省存储）。
 *  file：所属源文件名（多文件知识库用，阅读器按文件分组/引用标注来源；旧库缺省 undefined） */
export interface KBSection {
  id: string
  title: string
  start: number
  end: number
  file?: string
}

/** 一卷（Phase 3 范围选题）：一次生成请求的取材单元。P-01：只存定位与归属库，
 *  不复制正文——执行时按 kbId 懒加载 bodyText 切片，故草稿 genTarget 不再携带大段卷文本。 */
export interface KBVolume {
  index: number
  /** 卷取材来源知识库 id（执行时解析 bodyText 用） */
  kbId: string
  kbName: string
  /** 卷在 kb.bodyText 中的 [start, end) 区间 */
  start: number
  end: number
  charCount: number
  sectionTitles: string[]
}

/** 生题范围（Phase 3）：volumes 为多库拼接后的统一卷序列；kbRef 为页面侧构建 refs 时的
 *  知识库检索块原文——多卷执行时从 refs 中剥除（由整卷正文取代）。
 *  仅存于内存与草稿 genTarget（不进会话消息，避免会话记录膨胀）。 */
export interface KbScope {
  volumes: KBVolume[]
  kbRef?: string
}

/** 知识库文档（object store：knowledge_bases，keyPath: id） */
export interface KBDoc {
  id: string // kb_xxx
  name: string // 用户命名，可重命名
  sourceFiles: { name: string; size: number; chars?: number; lines?: number; words?: number; type?: 'file' | 'note'; pending?: boolean }[]
  /** raw 原始层：源文件段落切片（可回源/还原原始排版，阅读器「原始排版」模式数据源） */
  sourcesText: KBSourceText[]
  /** 清洗后正文（工作层：分块/检索/注入的唯一取材源，只动换行不动字） */
  bodyText: string
  /** 文档级 schema 版本，=2 表示已按去凝练架构整理；旧库 load 时检测迁移 */
  schema: 2
  /** 本地拼装的结构化摘要「N 份资料 · N 节 · N 字」（无 AI 摘要） */
  summary: string
  /** 旧库凝练产物只读留存（新库一律写 ''）；迁移兜底可充当 bodyText */
  consolidated: string
  /** 章节索引（title + 偏移指向 bodyText，不复制正文） */
  sections: KBSection[]
  /** bodyText 字符数 */
  charCount: number
  source: 'kb' | 'import'
  status: 'indexing' | 'ready' | 'failed'
  /** 失败原因（status=failed 时展示，失败不静默） */
  error?: string
  /** 语义索引（V-EMB 一期）：使用的 embedding 模型 id；缺省 = 未启用语义检索 */
  embedModel?: string
  /** 向量维度（与 embedModel 对应，检索归一用） */
  embedDim?: number
  /** 语义索引状态（旧库缺省视为 idle=未生成） */
  embedStatus?: 'idle' | 'indexing' | 'ready' | 'error'
  /** 卡片外观主题（0-9：书脊色/书脊小图标/页面插图三件套）；建库时随机，旧库缺省按 id 哈希兜底 */
  tone?: number
  created_at: number
  updated_at: number
}

/* ---------------- 知识库阅读器（Phase 3，见阅读器需求） ---------------- */

/** 阅读器护眼背景 */
export type ReaderBg = 'paper' | 'green' | 'yellow' | 'blue'
/** 翻页动画：覆盖（默认）/ 上下 / 平移 */
export type ReaderAnim = 'cover' | 'vertical' | 'horizontal'

/** 书签：定位到某个一级章 */
export interface KBBookmark {
  id: string
  kbId: string
  /** 一级章序号（对应 outline index） */
  chapter: number
  chapterTitle: string
  note?: string
  createdAt: number
}

/** 想法（批注）：阅读时选中文本添加 */
export interface KBNote {
  id: string
  kbId: string
  chapter: number
  /** 选中的原文片段（≤120 字，正文高亮用） */
  quote: string
  note: string
  createdAt: number
}

/** 阅读器设置（全局，localStorage 持久化） */
export interface ReaderSettings {
  fontSize: number
  bg: ReaderBg
  /** 夜间模式：独立开关，开启后忽略 bg 护眼色 */
  night: boolean
  /** 亮度 30~100；跟随系统时忽略 */
  brightness: number
  /** 亮度跟随系统（系统深色自动开夜间） */
  followSystem: boolean
  animation: ReaderAnim
}
