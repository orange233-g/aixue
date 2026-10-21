/**
 * 向量模型页（V-EMB 三期：内置 bge + 本地导入其他模型）。
 *
 * - 内置模型：bge-small-zh-v1.5 随 app 分发，选用后自动从 app 资产复制到本机缓存。
 * - 导入模型（如 Qwen3-Embedding-0.6B）：用户从发布页下载 `.aixue-model` 包，在本页「添加模型」
 *   选择文件导入；导入后与内置模型一样可在建库时选用。
 * - 导入模型只能显式删除；删除前若仍被知识库绑定会提示。
 */
import { useRef, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { useModal } from '../stores/useModalStore'
import { listEmbedModels, removeImportedModel } from '../ai/embed/registry'
import { deleteModelFiles } from '../ai/embed/storage'
import { disposeModelSession } from '../ai/embed/embedDirect'
import { importModelPackage, type ImportProgress } from '../ai/embed/importer'
import { formatModelSize, modelDisplayName, modelTotalSize } from '../ai/embed/display'
import { dbKB } from '../db'
import type { EmbedModel } from '../ai/embed/types'

/** 上下文长度展示：1024 起以 K 计（512→512，32768→32K） */
const ctxText = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))

export default function EmbedSettingsPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const modal = useModal()

  const [models, setModels] = useState<EmbedModel[]>(() => listEmbedModels())
  const [importOpen, setImportOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = () => setModels(listEmbedModels())

  const closeImport = () => {
    if (importing) return
    setImportOpen(false)
    setFile(null)
    setError('')
    setProgress(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleImport = async () => {
    if (!file || importing) return
    setImporting(true)
    setError('')
    try {
      const model = await importModelPackage(file, { onProgress: setProgress })
      refresh()
      closeImport()
      showToast(`已添加模型：${modelDisplayName(model)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败，请重试')
    } finally {
      setImporting(false)
    }
  }

  const handleDelete = (m: EmbedModel) => {
    void (async () => {
      const bound = (await dbKB.getAll()).filter((kb) => kb.embedModel === m.id)
      const desc = bound.length
        ? `有 ${bound.length} 个知识库正在使用「${modelDisplayName(m)}」。删除后这些库的语义索引会失效并降级为关键词检索，模型文件也会从本机移除（可重新导入）。`
        : `将从本机删除「${modelDisplayName(m)}」的模型文件与配置，之后可在需要时重新导入。`
      modal.confirm('删除模型', desc, () => {
        void (async () => {
          try {
            await deleteModelFiles(m.id)
            disposeModelSession(m.id)
            await removeImportedModel(m.id)
            refresh()
            showToast('模型已删除')
          } catch (e) {
            showToast(e instanceof Error ? e.message : '删除失败')
          }
        })()
      })
    })()
  }

  const builtin = models.filter((m) => !m.imported)
  const imported = models.filter((m) => m.imported)

  const progressText = (() => {
    if (!progress) return '正在读取模型包…'
    if (progress.phase === 'read') return '正在读取模型包…'
    if (progress.phase === 'verify') return `正在校验 ${progress.index + 1}/${progress.total} · ${progress.name}`
    return `正在写入本机 ${progress.index}/${progress.total}`
  })()

  return (
    <div>
      <div className="row" style={{ margin: '6px 0 12px' }}>
        <button className="btn ghost sm" onClick={() => navigate('me')}>‹ 返回</button>
        <div className="page-title" style={{ margin: 0 }}>向量模型</div>
      </div>

      <div className="card">
        <div className="card-title mb-8">检索方式说明</div>
        <div className="card-sub">
          每个知识库独立绑定一种检索方式（建库时选择，详情页可更换）：<b>关键词检索（BM25）</b>零模型零消耗、速度最快；<b>语义检索</b>需选择一个下方向量模型并为其生成语义索引。
        </div>
      </div>

      {/* 内置模型 */}
      <div className="card">
        <div className="card-title mb-8">内置模型（随 app 提供）</div>
        {builtin.map((m) => (
          <div key={m.id} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
            <div className="avatar">
              {m.logo ? <img className="avatar-logo" src={m.logo} alt={m.name} /> : <span>{modelDisplayName(m).slice(0, 1).toUpperCase()}</span>}
            </div>
            <div className="flex-1">
              <div className="card-title">{modelDisplayName(m)}</div>
              <div className="card-sub mt-4">{m.developer} · {m.license} 许可</div>
              <div className="card-sub mt-4">
                {m.dim} 维向量 · 最长 {ctxText(m.maxTokens)} tokens · 约 {formatModelSize(modelTotalSize(m))} · 已内置
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 已导入模型 */}
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="card-title flex-1">已添加的模型</div>
          <button className="btn sm" onClick={() => setImportOpen(true)}>＋ 添加模型</button>
        </div>
        {imported.length === 0 ? (
          <div className="card-sub">
            暂无。想要更强的召回可以添加 <b>Qwen3-Embedding-0.6B</b>：从发布页下载 `.aixue-model` 模型包后，点「添加模型」选择该文件即可（模型文件只保存在本机）。
          </div>
        ) : (
          imported.map((m) => (
            <div key={m.id} className="row" style={{ alignItems: 'flex-start', gap: 10, marginTop: 10 }}>
              <div className="avatar">
                <span>{modelDisplayName(m).slice(0, 1).toUpperCase()}</span>
              </div>
              <div className="flex-1">
                <div className="card-title">{modelDisplayName(m)}</div>
                <div className="card-sub mt-4">{m.developer} · {m.license} 许可</div>
                <div className="card-sub mt-4">
                  {m.dim} 维向量 · 最长 {ctxText(m.maxTokens)} tokens · 约 {formatModelSize(modelTotalSize(m))}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => handleDelete(m)}>删除</button>
            </div>
          ))
        )}
      </div>

      <div className="card-sub" style={{ padding: '0 4px' }}>
        模型文件只保存在本机（IndexedDB），不上传、不联网；删除模型或清除应用数据后需重新导入。
      </div>

      {importOpen && (
        <div className="mask" onClick={closeImport}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">添加模型</div>
            <div className="modal-desc">
              选择从发布页下载的 <b>.aixue-model</b> 模型包（本质是 zip）。导入时会校验文件完整性与 SHA256，
              模型文件写入本机后即可在建库时选用。
            </div>

            <input
              ref={inputRef}
              className="input"
              type="file"
              accept=".aixue-model,.zip,application/zip"
              disabled={importing}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setFile(f)
                setError('')
              }}
            />

            {file && (
              <div className="card-sub mt-8">
                已选择：{file.name} · {formatModelSize(file.size)}
              </div>
            )}

            {importing && (
              <div className="card-sub mt-8" style={{ opacity: 0.85 }}>
                {progressText}
                {progress && progress.total > 0 && progress.phase === 'save' && (
                  <span>（{Math.round((progress.index / progress.total) * 100)}%）</span>
                )}
              </div>
            )}

            {error && (
              <div className="card-sub mt-8" style={{ color: 'var(--danger, #c0392b)' }}>{error}</div>
            )}

            <div className="modal-btns">
              <button className="btn ghost flex-1" disabled={importing} onClick={closeImport}>取消</button>
              <button className="btn flex-1" disabled={!file || importing} onClick={() => void handleImport()}>
                {importing ? '导入中…' : '导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
