/**
 * 向量模型页（6.90 全自动化改版，原「检索设置/下载管理/就绪管理」）：
 * 纯介绍页——两个向量模型已随 APK 内置，生命周期全自动：
 * 建库选用后自动从 app 内复制到本机缓存并加载；不再被任何知识库使用时自动释放空间。
 * 无任何手动按钮；BM25 关键词检索零模型零消耗。
 */
import { useUI } from '../stores/useUIStore'
import { EMBED_MODELS } from '../ai/embed/registry'

/** 上下文长度展示：1024 起以 K 计（512→512，32768→32K） */
const ctxText = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))

export default function EmbedSettingsPage() {
  const navigate = useUI((s) => s.navigate)

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

      {/* 模型介绍卡：开发商/特点/参数（生命周期全自动，无手动操作） */}
      {EMBED_MODELS.map((m) => (
        <div key={m.id} className="card">
          <div className="row">
            <div className="avatar">
              <img className="avatar-logo" src={m.logo} alt={m.name} />
            </div>
            <div className="flex-1">
              <div className="card-title">{m.name.replace(/\s*（.*?）\s*$/g, '').trim()}</div>
              <div className="card-sub mt-4">{m.developer}</div>
            </div>
          </div>
          <div className="card-sub mt-8">{m.description}</div>
          <div className="card-sub mt-8" style={{ opacity: 0.72 }}>
            {m.dim} 维向量 · 最长 {ctxText(m.maxTokens)} tokens · 体积约 {m.id === 'bge-small-zh-v1.5' ? '95MB' : '614MB'}
          </div>
        </div>
      ))}
    </div>
  )
}
