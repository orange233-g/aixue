/**
 * 对话式生题验收场景·单一数据源（TASK-00 建立对应实施路线第 23 节 P0/P1 矩阵）。
 *
 * 规则：
 * - 本文件是机器可读的验收场景唯一来源；后续 draftReducer / draftValidation /
 *   draftProtocol / generationSpec 的纯函数测试与 useGenerateStore 的跨层测试
 *   一律从本文件引用场景，禁止在其他文件复制另一套口径。
 * - 场景数据是纯数据，不绑定 V2 具体类型（GenerationDraft 等在 TASK-01 才落地）；
 *   到时候由各测试装配层把 seed/expectation 映射为真实领域对象。
 * - `issues` 字段使用实施路线 4.5 节定义的 DraftIssueCode（纯字符串引用，
 *   TASK-02 落地后改为直接引用该类型常量）。
 * - 本文件只声明「V2 应达成的期望」，不代表当前 legacy 行为；
 *   不得用这些期望去断言/修改现有旧链路（TASK-00 只冻结基线）。
 */

export type ScenarioPriority = 'P0' | 'P1'

/** 期望/种子共用的题数计划描述（与实施路线 4.2 GenerationCountPlan 语义对齐） */
export type ScenarioCountPlan =
  | { mode: 'ai'; total?: number; /** custom→ai 未重述总数时由分项合计派生（app_derived） */ totalDerivedFromTypes?: true }
  | {
      mode: 'custom'
      typeCounts: Record<string, number>
      statedTotal?: number
      /** 「不再限定总数」后 statedTotal 被清除（字段缺席即代表不再对账） */
      statedTotalCleared?: true
    }

/** 场景前置时的活动草稿种子（结构化描述，不绑定 V2 类型） */
export interface ScenarioDraftSeed {
  topic?: string
  countPlan?: ScenarioCountPlan
  requirements?: string[]
  /** 已有有效资料来源（sourceMessageId / kbScope 均有效） */
  hasSource?: boolean
  revision?: number
}

export interface ScenarioSetup {
  /** 活动草稿种子；缺省 = 当前无草稿 */
  draft?: ScenarioDraftSeed
  /** 无草稿但已选择知识库范围（如 P0-03 首轮场景） */
  hasKbSelected?: boolean
  /** 有一个生题请求在途未返回（迟到响应竞态场景） */
  requestInFlight?: boolean
  /** 模型行为前提，供 mock gateway 装配（如「两次输出非法 JSON」） */
  modelBehavior?: string
  /** 人读补充说明 */
  context?: string
}

export type ScenarioAction =
  | { kind: 'chat'; text: string }
  | { kind: 'chat_sequence'; texts: string[] }
  | { kind: 'quick_generate' }
  | { kind: 'click_generate'; revision?: number }
  | { kind: 'double_click_generate' }
  | { kind: 'reload' }
  | { kind: 'clear_session' }
  | { kind: 'delete_kb' }
  | { kind: 'attach_source'; description: string }
  | { kind: 'switch_session'; target: string }
  | { kind: 'stop_generation' }

/** 场景期望（字段全部可选；测试只断言列出的字段） */
export interface ScenarioExpectation {
  /** 生命周期终态；'none' 表示不应存在草稿（不创建/已取消且不复活） */
  lifecycle?: 'active' | 'generating' | 'completed' | 'cancelled' | 'none'
  /** replace 语义：应创建新 draft id，旧方案过期 */
  newDraftId?: boolean
  topic?: string
  countPlan?: ScenarioCountPlan
  ready?: boolean
  /** 期望阻断原因（DraftIssueCode，见实施路线 4.5） */
  issues?: string[]
  /** 生成按钮是否可用 */
  generateEnabled?: boolean
  /** 点击生成构建的执行快照总题数 */
  specTotal?: number
  /** 只构建并执行一个 spec（防双击/旧 revision） */
  singleSpec?: boolean
  /** 迟到/旧 revision 响应被拒绝 */
  staleRejected?: boolean
  /** 本轮问题写入 turnIssues（不改需求字段、不加 revision） */
  turnIssues?: boolean
  /** 需求字段与 revision 保持不变 */
  revisionUnchanged?: boolean
  /** 资料来源结果 */
  source?: 'kept' | 'replaced' | 'cleared'
  /** 刷新/切换后 draft、source、revision 完整恢复 */
  restored?: boolean
  /** 协议 JSON 与首次失败正文从不闪现到消息区 */
  noProtocolLeak?: boolean
  /** 模型正文作为普通聊天回复展示 */
  chatReplied?: boolean
  /** 快捷生成完整流程与 TASK-00 冻结基线一致（S-09 回归锚） */
  quickGenParity?: true
  /** 期望被精确删除的附加要求文本 */
  requirementRemoved?: string
  /** 人读补充（固定提示语义等），测试可据此断言文案要点 */
  note?: string
}

export interface GenerationScenario {
  /** 实施路线第 23 节矩阵行 ID（如 'P0-01'） */
  id: string
  priority: ScenarioPriority
  /** 同一矩阵行覆盖多个前置分支时用 variant 区分（唯一键 = id + variant） */
  variant?: string
  title: string
  setup: ScenarioSetup
  action: ScenarioAction
  expect: ScenarioExpectation
}

/** 4.5 节定义的 DraftIssueCode 全集（用于数据源自检） */
export const SCENARIO_ISSUE_CODES = [
  'TOPIC_OR_SOURCE_REQUIRED',
  'TOTAL_REQUIRED',
  'TOTAL_OUT_OF_RANGE',
  'TYPE_COUNT_OUT_OF_RANGE',
  'CUSTOM_TYPES_REQUIRED',
  'TOTAL_TYPE_SUM_MISMATCH',
  'DUPLICATE_TYPE_CONFLICT',
  'COUNT_PLAN_REQUIRED',
  'COUNT_NOT_EXPLICIT',
  'TURN_UPDATE_NOT_APPLIED',
  'SOURCE_MISSING',
  'SOURCE_POLICY_CONFLICT',
  'DRAFT_NOT_ACTIVE',
] as const

/* ============================================================
 * P0：切换 V2 前必须全部通过（实施路线第 23 节）
 * ============================================================ */

export const P0_SCENARIOS: GenerationScenario[] = [
  {
    id: 'P0-01',
    priority: 'P0',
    title: '明确主题+总数直接 ready',
    setup: {},
    action: { kind: 'chat', text: '围绕牛顿第二定律出20题' },
    expect: {
      lifecycle: 'active',
      topic: '牛顿第二定律',
      countPlan: { mode: 'ai', total: 20 },
      ready: true,
      generateEnabled: true,
    },
  },
  {
    id: 'P0-02',
    priority: 'P0',
    title: '只有总数缺主题/资料：不显示生成按钮',
    setup: {},
    action: { kind: 'chat', text: '给我出20题' },
    expect: {
      countPlan: { mode: 'ai', total: 20 },
      ready: false,
      issues: ['TOPIC_OR_SOURCE_REQUIRED'],
      generateEnabled: false,
    },
  },
  {
    id: 'P0-03',
    priority: 'P0',
    title: '按知识库出题：source 保留，input 用固定资料主句',
    setup: { hasKbSelected: true },
    action: { kind: 'chat', text: '根据这些资料出20题' },
    expect: {
      countPlan: { mode: 'ai', total: 20 },
      ready: true,
      source: 'kept',
      note: '无主题但有资料时执行 input 使用固定主句「请严格依据所选参考资料生成题目」',
    },
  },
  {
    id: 'P0-04',
    priority: 'P0',
    title: '「题型你来安排」= ai 模式，不编造 typeCounts',
    setup: { draft: { topic: 'Python 入门' } },
    action: { kind: 'chat', text: '20题，题型你来安排' },
    expect: { countPlan: { mode: 'ai', total: 20 }, note: '不出现任何题型分项' },
  },
  {
    id: 'P0-05',
    priority: 'P0',
    title: '明确分项 = custom 模式',
    setup: { draft: { topic: 'Python 入门' } },
    action: { kind: 'chat', text: '单选10，多选5，判断5' },
    expect: {
      countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5, judge: 5 } },
      ready: true,
      note: '三类合计 20',
    },
  },
  {
    id: 'P0-06',
    priority: 'P0',
    title: 'ai ready 下只改总数，其余字段不动',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 2 } },
    action: { kind: 'chat', text: '改成30题' },
    expect: {
      countPlan: { mode: 'ai', total: 30 },
      topic: '海洋知识',
      source: 'kept',
      revisionUnchanged: false,
      note: 'topic/source/requirements 全部保持，仅 total 变化',
    },
  },
  {
    id: 'P0-07',
    priority: 'P0',
    title: 'custom 下改一项删一项，其余题型保持',
    setup: {
      draft: {
        topic: '海洋知识',
        countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5, judge: 5 } },
        revision: 2,
      },
    },
    action: { kind: 'chat', text: '多选改成8题，删掉判断题' },
    expect: {
      countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 8 } },
      note: 'judge 被 unset；single 等未提到的题型保持',
    },
  },
  {
    id: 'P0-08',
    priority: 'P0',
    title: '文字取消 → cancelled，按钮消失',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 2 } },
    action: { kind: 'chat', text: '先不出了' },
    expect: { lifecycle: 'cancelled', generateEnabled: false },
  },
  {
    id: 'P0-09',
    priority: 'P0',
    title: '普通闲聊：草稿保留且不被修改',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 2 } },
    action: { kind: 'chat', text: '今天天气怎么样' },
    expect: { lifecycle: 'active', revisionUnchanged: true, chatReplied: true },
  },
  {
    id: 'P0-10',
    priority: 'P0',
    title: '「另出一套」= replace，新 draft id，旧方案过期',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 } },
    action: { kind: 'chat', text: '另出一套关于光合作用的15题' },
    expect: {
      newDraftId: true,
      topic: '光合作用',
      countPlan: { mode: 'ai', total: 15 },
      note: '旧 draft（旧 id/revision）不可再执行',
    },
  },
  {
    id: 'P0-11',
    priority: 'P0',
    title: 'active 且 not ready 时刷新可恢复',
    setup: { draft: { topic: '海洋知识', revision: 2 } },
    action: { kind: 'reload' },
    expect: { restored: true, note: '同 session 恢复 draft、source、revision' },
  },
  {
    id: 'P0-12',
    priority: 'P0',
    title: '旧 revision 按钮（rev=2 vs 当前 rev=3）被拒绝',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 } },
    action: { kind: 'click_generate', revision: 2 },
    expect: { singleSpec: false, staleRejected: true, note: '提示方案已更新，不启动生成' },
  },
  {
    id: 'P0-13',
    priority: 'P0',
    title: '请求未返回时用户取消：旧响应返回后不复活草稿',
    setup: {
      draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 2 },
      requestInFlight: true,
      modelBehavior: '旧响应在用户取消之后才返回',
    },
    action: { kind: 'chat', text: '先不出了' },
    expect: { staleRejected: true, lifecycle: 'cancelled' },
  },
  {
    id: 'P0-14',
    priority: 'P0',
    title: 'ready 下双击生成：只构建并执行一个 spec',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 } },
    action: { kind: 'double_click_generate' },
    expect: { singleSpec: true, specTotal: 20 },
  },
  {
    id: 'P0-15',
    priority: 'P0',
    title: '模型两次输出非法 JSON：草稿不变 + turnIssues + 按钮暂禁',
    setup: {
      draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 },
      modelBehavior: '连续两次输出非法 JSON',
    },
    action: { kind: 'chat', text: '改成30题' },
    expect: {
      revisionUnchanged: true,
      turnIssues: true,
      generateEnabled: false,
      note: '显示「本轮修改未应用」与恢复提示；用户可点「仍按当前方案」恢复',
    },
  },
  {
    id: 'P0-16',
    priority: 'P0',
    title: '超限题数显示冲突，不静默夹取',
    setup: {},
    action: { kind: 'chat', text: '出1001题' },
    expect: {
      ready: false,
      issues: ['TOTAL_OUT_OF_RANGE'],
      generateEnabled: false,
      note: '仍显示用户原值 1001，不得夹成 1000',
    },
  },
  {
    id: 'P0-17',
    priority: 'P0',
    title: '同题型多别名值冲突：不采用最后一个值',
    setup: {},
    action: { kind: 'chat', text: '出题，单选题10、single8' },
    expect: {
      turnIssues: true,
      issues: ['DUPLICATE_TYPE_CONFLICT'],
      generateEnabled: false,
      note: '冲突数量整体不应用',
    },
  },
  {
    id: 'P0-18',
    priority: 'P0',
    title: '知识库首轮后第二轮只补题数：KB scope 保留',
    setup: {
      draft: { topic: '海洋知识', hasSource: true, revision: 1 },
      context: '首轮已绑定知识库范围',
    },
    action: { kind: 'chat', text: '20题' },
    expect: {
      countPlan: { mode: 'ai', total: 20 },
      source: 'kept',
      note: 'KB scope 不被 null 覆盖',
    },
  },
  {
    id: 'P0-19',
    priority: 'P0',
    title: 'ready 点击生成：不开第二弹窗，spec 与卡片一致',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 } },
    action: { kind: 'click_generate', revision: 3 },
    expect: { singleSpec: true, specTotal: 20, generateEnabled: true, note: '不再打开快捷生成弹窗二次确认' },
  },
  {
    id: 'P0-20',
    priority: 'P0',
    title: '快捷生成原有完整流程行为与基线一致',
    setup: {},
    action: { kind: 'quick_generate' },
    expect: {
      quickGenParity: true,
      note: '题数、题型、资料和生成结果与 TASK-00 冻结的快捷生成基线一致（见 quickGenBaseline.test.ts）',
    },
  },
  {
    id: 'P0-21',
    priority: 'P0',
    title: 'update 轮附新资料：整体替换旧 source 并明确提示',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 2 } },
    action: { kind: 'attach_source', description: '重新附加新的资料文件并要求据此出题' },
    expect: { source: 'replaced', note: '助手明确提示「已更新资料范围」' },
  },
  {
    id: 'P0-22',
    priority: 'P0',
    title: 'KB 被删除后点击生成：SOURCE_MISSING 阻断',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 3 } },
    action: { kind: 'delete_kb' },
    expect: {
      issues: ['SOURCE_MISSING'],
      generateEnabled: false,
      note: '禁止启动并提示用户重新选择资料',
    },
  },
  {
    id: 'P0-23',
    priority: 'P0',
    title: '聊天轮附新文件只问内容：不改草稿 source',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 2 } },
    action: { kind: 'attach_source', description: '附新文件但只询问文件内容，不要求改题' },
    expect: { source: 'kept', chatReplied: true, lifecycle: 'active', note: 'finalIntent=chat；新附件只服务本轮聊天' },
  },
  {
    id: 'P0-24',
    priority: 'P0',
    title: 'replace 未附资料且未说沿用：默认不继承旧 source',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 2 } },
    action: { kind: 'chat', text: '另出一套关于光合作用的15题' },
    expect: { newDraftId: true, source: 'cleared' },
  },
  {
    id: 'P0-25',
    priority: 'P0',
    title: 'replace 明确沿用资料：验证 keep_existing evidence 后复制旧 source',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 2 } },
    action: { kind: 'chat', text: '沿用这些资料另出15题' },
    expect: { newDraftId: true, source: 'kept' },
  },
  {
    id: 'P0-26',
    priority: 'P0',
    title: '唯一缺总数时裸答「20」：本地可靠回答补齐（模型误回 chat 也生效）',
    setup: {
      draft: { topic: '海洋知识', revision: 2 },
      context: '系统刚追问总数，唯一缺项为总题数',
      modelBehavior: '模型误回 chat（无协议块）',
    },
    action: { kind: 'chat', text: '20' },
    expect: { countPlan: { mode: 'ai', total: 20 }, ready: true },
  },
  {
    id: 'P0-27',
    priority: 'P0',
    title: '流式协议围栏跨 chunk + 首次 invalid 二次 valid：不闪现失败正文',
    setup: {
      draft: { topic: '海洋知识', revision: 2 },
      modelBehavior: '协议围栏被拆在多个 chunk，首次输出 invalid，重试后 valid',
    },
    action: { kind: 'chat', text: '改成30题' },
    expect: { noProtocolLeak: true, chatReplied: true, note: '只提交第二次有效可见回复' },
  },
  {
    id: 'P0-28',
    priority: 'P0',
    title: '生题请求未返回时清空/删除会话：响应到达后安全丢弃',
    setup: { requestInFlight: true },
    action: { kind: 'clear_session' },
    expect: { staleRejected: true, lifecycle: 'none', note: '不重建会话或 draft' },
  },
  {
    id: 'P0-29',
    priority: 'P0',
    title: '模型擅填题数被拒；有效重试只保留 topic 并追问总数',
    setup: {
      modelBehavior: '首次响应擅填 total=20；重试只保留 topic',
    },
    action: { kind: 'chat', text: '来一些 Python 题' },
    expect: {
      issues: ['COUNT_NOT_EXPLICIT'],
      topic: 'Python',
      ready: false,
      generateEnabled: false,
      note: '首次以 COUNT_NOT_EXPLICIT 整体拒绝；不出现按钮，追问总数',
    },
  },
  {
    id: 'P0-30',
    priority: 'P0',
    title: '明显闲聊漏协议：不重试、不改草稿、正常显示聊天正文',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 2 } },
    action: { kind: 'chat', text: '给我讲个冷笑话' },
    expect: {
      chatReplied: true,
      revisionUnchanged: true,
      lifecycle: 'active',
      note: 'requiresDraftProtocol=false，漏协议块不触发重试',
    },
  },
]

/* ============================================================
 * P1：正式清理旧代码前通过（实施路线第 23 节）
 * ============================================================ */

export const P1_SCENARIOS: GenerationScenario[] = [
  {
    id: 'P1-01',
    priority: 'P1',
    title: '假设性咨询不创建 ready 草稿',
    setup: {},
    action: { kind: 'chat', text: '如果要出20题，应该怎么分配？' },
    expect: { lifecycle: 'none', generateEnabled: false, note: '判为咨询/闲聊' },
  },
  {
    id: 'P1-02',
    priority: 'P1',
    variant: '无草稿',
    title: '否定句「不要给我出题，只讲概念」→ 纯聊天',
    setup: {},
    action: { kind: 'chat', text: '不要给我出题，只讲概念' },
    expect: { lifecycle: 'none', chatReplied: true },
  },
  {
    id: 'P1-02',
    priority: 'P1',
    variant: '有活动草稿',
    title: '否定句在有活动草稿时 = 明确取消并正常讲解',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 2 } },
    action: { kind: 'chat', text: '不要给我出题，只讲概念' },
    expect: { lifecycle: 'cancelled', chatReplied: true, note: '取消后仍回答概念，不误生成' },
  },
  {
    id: 'P1-03',
    priority: 'P1',
    title: '主题/数量/难度三轮合并后字段齐全',
    setup: {},
    action: { kind: 'chat_sequence', texts: ['我想学英语六级词汇', '出20题', '难一点'] },
    expect: {
      lifecycle: 'active',
      topic: '英语六级词汇',
      countPlan: { mode: 'ai', total: 20 },
      note: '难度作为附加要求保留，不覆盖主题与总数',
    },
  },
  {
    id: 'P1-04',
    priority: 'P1',
    title: 'custom 改「题型你安排」：切 ai，分项不再保留，总数取分项合计',
    setup: {
      draft: {
        topic: '海洋知识',
        countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5 } },
        revision: 2,
      },
    },
    action: { kind: 'chat', text: '题型你安排' },
    expect: {
      countPlan: { mode: 'ai', total: 15, totalDerivedFromTypes: true },
      note: 'total 为 app_derived（原分项合计 15）',
    },
  },
  {
    id: 'P1-05',
    priority: 'P1',
    title: 'ai 20 后只给分项合计 15：旧 20 转 statedTotal 并冲突',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 2 } },
    action: { kind: 'chat', text: '单选10、多选5' },
    expect: {
      countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5 }, statedTotal: 20 },
      issues: ['TOTAL_TYPE_SUM_MISMATCH'],
      generateEnabled: false,
      note: '禁止生成并追问修正；不静默按 15 生成',
    },
  },
  {
    id: 'P1-06',
    priority: 'P1',
    title: '明确总数与分项冲突：只问冲突修正',
    setup: {},
    action: { kind: 'chat', text: '总共20题，单选10，多选15' },
    expect: {
      issues: ['TOTAL_TYPE_SUM_MISMATCH'],
      generateEnabled: false,
      note: '提示同时显示 statedTotal、分项合计与差额，给「全 AI 安排 / 补齐分项」两个选择',
    },
  },
  {
    id: 'P1-07',
    priority: 'P1',
    title: '撤销某条附加要求：精确删除，不清空全部',
    setup: {
      draft: {
        topic: '海洋知识',
        countPlan: { mode: 'ai', total: 20 },
        requirements: ['难度偏难', '全部中文'],
        revision: 2,
      },
    },
    action: { kind: 'chat', text: '把「难度偏难」这条要求去掉' },
    expect: { requirementRemoved: '难度偏难', note: '剩余要求「全部中文」保持' },
  },
  {
    id: 'P1-08',
    priority: 'P1',
    title: 'A/B 会话各有活动草稿：切换各自恢复不串',
    setup: {
      draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 3 },
      context: '会话 B 另有自己的活动草稿',
    },
    action: { kind: 'switch_session', target: 'B' },
    expect: { restored: true, note: '按钮和资料随会话各自恢复，不串单' },
  },
  {
    id: 'P1-09',
    priority: 'P1',
    title: '生成途中停止且已有部分题：Pack draft 保留可续跑，需求卡不重复启动',
    setup: {
      draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 },
      context: '已进入 generating 并产出部分题目后用户停止',
    },
    action: { kind: 'stop_generation' },
    expect: {
      lifecycle: 'completed',
      generateEnabled: false,
      note: 'Pack draft 保留并可续跑（Pack genTarget 负责）；活动需求草稿不再重新打开生成',
    },
  },
  {
    id: 'P1-10',
    priority: 'P1',
    title: '自定义供应商漏协议：最多重试一次，失败保持草稿',
    setup: {
      draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, revision: 3 },
      modelBehavior: '自定义 OpenAI 兼容端点连续漏输出协议块',
    },
    action: { kind: 'chat', text: '改成30题' },
    expect: { turnIssues: true, revisionUnchanged: true, note: '最多重试一次；两次失败草稿不变' },
  },
  {
    id: 'P1-11',
    priority: 'P1',
    title: '「不再限定总数，按分项合计」：只清 statedTotal',
    setup: {
      draft: {
        topic: '海洋知识',
        countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5 }, statedTotal: 20 },
        revision: 2,
      },
    },
    action: { kind: 'chat', text: '不再限定总数，按分项合计' },
    expect: {
      countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5 }, statedTotalCleared: true },
      note: 'typeCounts 保留，按分项合计校验',
    },
  },
  {
    id: 'P1-12',
    priority: 'P1',
    title: '同轮新资料 + source_policy 冲突：SOURCE_POLICY_CONFLICT，不选边',
    setup: { draft: { topic: '海洋知识', countPlan: { mode: 'ai', total: 20 }, hasSource: true, revision: 2 } },
    action: { kind: 'attach_source', description: '本轮附新资料且模型同时输出 keep_existing/clear 的 source_policy' },
    expect: {
      issues: ['SOURCE_POLICY_CONFLICT'],
      source: 'kept',
      note: '本轮不应用 source 变化，要求用户明确选择',
    },
  },
  {
    id: 'P1-13',
    priority: 'P1',
    title: '「多选改成0」归一为 unset，草稿不保存 0',
    setup: {
      draft: {
        topic: '海洋知识',
        countPlan: { mode: 'custom', typeCounts: { single: 10, multiple: 5 } },
        revision: 2,
      },
    },
    action: { kind: 'chat', text: '多选改成0' },
    expect: { countPlan: { mode: 'custom', typeCounts: { single: 10 } }, note: 'multiple 被 unset；不出现 0 值分项' },
  },
  {
    id: 'P1-14',
    priority: 'P1',
    title: '「讲解 20 个概念」不误识别为生题',
    setup: {},
    action: { kind: 'chat', text: '请给我讲解20个Python概念' },
    expect: { lifecycle: 'none', chatReplied: true },
  },
  {
    id: 'P1-15',
    priority: 'P1',
    title: '总数 + 部分分项（混合模式）：TOTAL_TYPE_SUM_MISMATCH 阻断',
    setup: { draft: { topic: '海洋知识', revision: 1 } },
    action: { kind: 'chat', text: '总共20题，单选10题，剩下你安排' },
    expect: {
      issues: ['TOTAL_TYPE_SUM_MISMATCH'],
      generateEnabled: false,
      note: '不假装支持混合执行；要求选择「全 AI 安排」或「补齐全部分项」',
    },
  },
  {
    id: 'P1-16',
    priority: 'P1',
    title: '「用我刚才的文件出题」且本轮未重选：不扫描最近 refs',
    setup: {
      draft: { topic: '海洋知识', revision: 1 },
      context: '最近闲聊消息带附件，但当前 draft source 不是它',
    },
    action: { kind: 'chat', text: '用我刚才的文件出20题' },
    expect: {
      countPlan: { mode: 'ai', total: 20 },
      source: 'kept',
      generateEnabled: false,
      note: '提示在卡片重新选择资料；选择后生成精确 sourceMessageId',
    },
  },
]

/** 全量场景（P0 + P1）；测试按 priority/id 过滤取用 */
export const GENERATION_SCENARIOS: GenerationScenario[] = [...P0_SCENARIOS, ...P1_SCENARIOS]

/** 按优先级取场景 */
export function scenariosByPriority(priority: ScenarioPriority): GenerationScenario[] {
  return GENERATION_SCENARIOS.filter((s) => s.priority === priority)
}
