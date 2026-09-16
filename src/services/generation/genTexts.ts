/** 截断后「继续生成」续写按钮 label */
export const GEN_CONTINUE_LABEL = '继续生成'

/** 普通聊天回复整体失败的兜底文案 */
export const CHAT_FAIL_FALLBACK = '（回复失败）'

/** 续写回复失败的兜底文案 */
export const CONTINUE_FAIL_FALLBACK = '（续写失败）'

/** 中断/失败后「继续生成剩余 X 卷」按钮 label */
export const genResumeLabel = (remaining: number): string => `继续生成剩余 ${remaining} 卷`
