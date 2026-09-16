/**
 * 输入清洗（W3a）：把「用户提供、随后会被拼进模型提示」的文本里可能夹带的 prompt 注入指令中和掉。
 * 原则：只处理「覆盖/推翻系统设定」这类注入指令，不误伤正常学习内容——中文正常句几乎不命中。
 * 纯函数、无副作用，可独立单测。
 */

/** 覆盖/推翻系统指令的注入式说法（子串匹配；勿加 \b，JS 词边界不认中文） */
const INJECT_RE = [
  // 英文注入典型说法
  /\bignore (?:all |the )?(?:previous|prior|above|earlier)?\s*(?:instructions|prompts?|context|rules?|system)\b/gi,
  /\bdisregard (?:the )?(?:previous|above|prior)?\s*(?:instructions?|prompt|context|rules?|system)\b/gi,
  /\byou are now|act as the system|pretend to be the system\b/gi,
  /\b(?:reveal|print|output|repeat) (?:your|the) (?:system|hidden) prompt\b/gi,
  // 中文注入典型说法
  /忽略(?:我)?(?:以上|之前|前面|上文)?(?:所有|全部)?的?(?:指令|提示|设定|要求|规则|上下文)/g,
  /无视(?:以上|之前|前面|上文)?(?:所有|全部)?的?(?:指令|提示|设定|要求|规则|上下文)/g,
  /不要(?:再)?遵循(?:以上|之前)?(?:所有|全部)?的?(?:指令|提示|设定|要求|规则)/g,
  /你现在(?:是|扮演)(?:(?:我的)?系统|AI|助手)(?:角色|身份)?(?:，|,)?(?:把|请|给我)/g,
  /禁止回(?:答|复).*(?:内容|指令|问题)/g,
]

const PLACEHOLDER = '[已按输入安全规则过滤]'

/**
 * 中和用户文本中的 prompt 注入指令（覆盖/推翻系统设定的说法），其余原样保留。
 * 调用方负责在「用户文本进入模型提示」这一边界前调用。
 */
export function sanitizeInput(text: string): string {
  if (!text) return text
  let out = text
  for (const re of INJECT_RE) out = out.replace(re, PLACEHOLDER)
  return out
}

/** 同 sanitizeInput，但返回是否发生了过滤（供日志/审计） */
export function sanitizeInputChecked(text: string): { text: string; changed: boolean } {
  const sanitized = sanitizeInput(text)
  return { text: sanitized, changed: sanitized !== (text ?? '') }
}