/**
 * 规范化自定义题型数量的编辑态文本。
 *
 * 编辑时允许空字符串，方便用户删除后重新输入；提交仍由 store 负责
 * 做题型上限和总题数上限校验。
 */
export function normalizeCountDraft(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '')
  return digits.replace(/^0+(?=\d)/, '')
}
