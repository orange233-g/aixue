/**
 * 生题资料来源解析（实施路线 4.5 两层校验的第二层 / 5.4 合并规则 / TASK-02）。
 *
 * - resolveGenerationSource：按 sourceMessageId 精确读取该消息 refs（绝不反向扫描
 *   「最近一条带 refs 的消息」），并校验 kbScope 引用的知识库仍然存在；
 *   失败返回 SOURCE_MISSING，由 spec builder 拒绝构建执行快照（P0-22）。
 * - resolveDraftSourceAction：把「finalIntent + 本轮真实资料 + 已验证 sourcePolicy」
 *   归一为 DraftSourceAction（preserve/replace/clear）或 SOURCE_POLICY_CONFLICT。
 *   纯函数，不写 Store、不访问网络。
 */
import type {
  DraftIssue,
  DraftPatch,
  DraftSourceAction,
  GenerationDraftSource,
  KBDoc,
  Session,
} from '../../types'

/** 资料解析结果：ok=false 时携带 SOURCE_MISSING，禁止构建执行快照 */
export interface ResolvedGenerationSource {
  ok: boolean
  refs?: string
  kbScope?: GenerationDraftSource['kbScope']
  issue?: DraftIssue
}

/** 按草稿 source 精确解析真实资料（实施路线 5.4 第 5.4-1～4 步） */
export function resolveGenerationSource(
  draft: { source: GenerationDraftSource },
  session: Session | undefined | null,
  knowledgeBases: KBDoc[],
): ResolvedGenerationSource {
  const source = draft.source
  const hasMessage = !!source.sourceMessageId
  const hasKb = !!source.kbScope && source.kbScope.volumes.length > 0
  if (!hasMessage && !hasKb) return { ok: true }

  let refs: string | undefined
  if (hasMessage) {
    // 精确按 id 查找，不反向搜索最近 refs（实施路线 4.2 约束 8）
    const msg = session?.messages.find((m) => m.id === source.sourceMessageId)
    if (!msg || !msg.refs || msg.refs.trim().length === 0) {
      return { ok: false, issue: { code: 'SOURCE_MISSING', field: 'source', message: '原参考资料已不存在，请重新选择资料' } }
    }
    refs = msg.refs
  }

  if (hasKb) {
    for (const vol of source.kbScope!.volumes) {
      const kb = knowledgeBases.find((b) => b.id === vol.kbId)
      if (!kb) {
        return { ok: false, issue: { code: 'SOURCE_MISSING', field: 'source', message: `知识库「${vol.kbName}」已删除，请重新选择资料` } }
      }
    }
  }

  return { ok: true, refs, kbScope: source.kbScope }
}

export type DraftSourceActionResolution =
  | { kind: 'ok'; action: DraftSourceAction }
  | {
      kind: 'conflict'
      /** 冲突时本轮不应用 source 变化（preserve），由 Store 写入 turnIssues 让用户选择 */
      action: DraftSourceAction
      issue: DraftIssue
    }

/** 本轮是否携带了真实新资料（App 已从消息 refs/kbScope 归一而来） */
function hasTurnSource(source: GenerationDraftSource | undefined): boolean {
  if (!source) return false
  if (source.sourceMessageId && source.sourceMessageId.trim().length > 0) return true
  if (source.kbScope && source.kbScope.volumes.length > 0) return true
  return false
}

/**
 * 来源动作解析（严格按实施路线 5.4 表格）：
 * - 新建草稿：本轮有资料 → replace 写入；无资料 → clear（空 source）
 * - update 无新资料 → preserve（完整保留旧 source，P0-18）
 * - update/replace 带新资料 → 整体替换（P0-21）
 * - replace 无新资料 → 默认 clear（P0-24）；明确 keep_existing → preserve（P0-25）
 * - 同轮既有新资料又有 sourcePolicy → SOURCE_POLICY_CONFLICT，不猜优先级（P1-12）
 * - chat：资料只属于本轮聊天，不改草稿 source
 */
export function resolveDraftSourceAction(
  currentDraft: { source: GenerationDraftSource } | null | undefined,
  finalIntent: DraftPatch['intent'],
  currentTurnSource: GenerationDraftSource | undefined,
  sourcePolicy?: DraftPatch['sourcePolicy'],
): DraftSourceActionResolution {
  const turnHasSource = hasTurnSource(currentTurnSource)

  // 同轮新资料 + 模型 source_policy：不猜优先级，冲突交用户选择（实施路线 5.4）
  if (turnHasSource && sourcePolicy && finalIntent !== 'chat') {
    return {
      kind: 'conflict',
      action: { kind: 'preserve' },
      issue: {
        code: 'SOURCE_POLICY_CONFLICT',
        field: 'source',
        message: '本轮同时带来了新资料和资料去留指令：请选择「使用新资料」「沿用旧资料」或「不使用资料」',
      },
    }
  }

  if (!currentDraft) {
    // 新建草稿：有资料则一次性写入（sourceMessageId 由 App 指向本轮消息）
    return { kind: 'ok', action: turnHasSource ? { kind: 'replace', source: currentTurnSource! } : { kind: 'clear' } }
  }

  switch (finalIntent) {
    case 'chat':
      // 普通聊天不改变任何草稿字段；附件只服务本轮聊天（实施路线 6.3 规则 5）
      return { kind: 'ok', action: { kind: 'preserve' } }
    case 'cancel':
      return { kind: 'ok', action: { kind: 'preserve' } }
    case 'update':
      // update 无新资料保留、有新资料整体替换（实施路线 5.4）
      return { kind: 'ok', action: turnHasSource ? { kind: 'replace', source: currentTurnSource! } : { kind: 'preserve' } }
    case 'replace':
      if (turnHasSource) return { kind: 'ok', action: { kind: 'replace', source: currentTurnSource! } }
      // replace 无新资料：默认不继承，只有明确 keep_existing（evidence 已在上游验证）才沿用（P0-24/25）
      return { kind: 'ok', action: sourcePolicy?.kind === 'keep_existing' ? { kind: 'preserve' } : { kind: 'clear' } }
  }
}
