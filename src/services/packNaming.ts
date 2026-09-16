/**
 * 题包命名（W4i）：生成唯一入库标题——同名已存在时追加「 (n)」序号，避免题库撞名难检索。
 * 纯函数、无资源/网络依赖，可独立单测；store 侧负责查询已有标题并喂给本函数。
 */

/** 在同名集合里挑一个不冲突的唯一标题：同名追加 (2)/(3)… */
export function pickUniqueTitle(base: string, existing: string[]): string {
  const b = (base ?? '').trim() || '未命名学习本'
  const taken = new Set(existing)
  if (!taken.has(b)) return b
  let i = 2
  while (taken.has(`${b} (${i})`)) i++
  return `${b} (${i})`
}