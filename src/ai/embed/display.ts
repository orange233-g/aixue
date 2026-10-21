/**
 * 模型展示辅助：名称 / 短名 / 体积格式化。
 * 统一放在注册表旁边，避免各页面各写一套硬编码（bge/Qwen3 等）。
 */
import { getEmbedModel } from './registry'
import type { EmbedModel } from './types'

/** 去掉名称里的括注，得到展示用全名（"bge-small-zh-v1.5（内置默认）" → "bge-small-zh-v1.5"） */
export function modelDisplayName(m: Pick<EmbedModel, 'name'>): string {
  return m.name.replace(/\s*[（(][^（()）]*[)）]\s*$/g, '').trim() || m.name
}

/** 模型短名（知识库卡片 tag 用：bge / Qwen3 …）；未知 id 原样返回 */
export function modelShortName(id?: string): string {
  if (!id) return ''
  const m = getEmbedModel(id)
  return m ? modelDisplayName(m) : id
}

/** 把字节数格式化为 MB/GB（模型体积展示） */
export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

/** 模型总体积（文件清单求和） */
export function modelTotalSize(m: EmbedModel): number {
  return m.files.reduce((sum, f) => sum + (f.size || 0), 0)
}
