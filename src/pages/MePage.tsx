import { useEffect, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { usePacks } from '../stores/usePackStore'
import { useLearning } from '../stores/useLearningStore'
import { useAI, resolveActiveId, isProviderReady } from '../stores/useAIStore'
import { usePreferences } from '../stores/usePreferenceStore'
import { useGenerate } from '../stores/useGenerateStore'
import { getAdapter } from '../ai/providers'
import { dbAnswers, dbCategories, dbKB, dbUsage } from '../db'
import { exportBackup, parseImport } from '../services/io'
import { calcKPI, formatCost, formatTokens } from '../services/usage'
import { MAX_IMPORT_BYTES } from '../services/io/validate'
import { exportJSONFile, exportResultToast, pickImportFile } from '../utils'
import LogPanel from '../components/LogPanel'

export default function MePage() {
  const page = useUI((s) => s.page)
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const setImportFile = useUI((s) => s.setImportFile)
  const packs = usePacks((s) => s.packs)
  const loadPacks = usePacks((s) => s.load)
  const { states, wrongs, loaded: learningLoaded, load: loadLearning } = useLearning()
  const defaultId = useAI((s) => s.defaultId)
  const providers = useAI((s) => s.providers)
  const { dailyReviewLimit, loaded: prefLoaded, load: loadPrefs } = usePreferences()
  const defaultTemplate = useGenerate((s) => s.defaultTemplate)
  const templates = useGenerate((s) => s.templates)
  const hasDefaultTemplate = !!defaultTemplate && !!templates[defaultTemplate]

  const [usageSub, setUsageSub] = useState('')
  // BUG-5 修复：用户卡统计接真实数据（此前硬编码「学习 0 天 · 已刷 0 题」）——
  // 学习天数 = 有作答记录的去重日期数；已刷题数 = 作答记录总数。切到本页时实时重算
  const [studySub, setStudySub] = useState('')
  // 调试日志面板（生题迁移到「我的」tab，含模型/生题/知识库/操作/报错日志）
  const [showLog, setShowLog] = useState(false)
  // 数据管理导出：弹窗内勾选才把错题/学习进度/作答/用量一并写入备份，不勾则仅导出学习本+知识库+分类+偏好
  const [exportOpts, setExportOpts] = useState({ wrongs: false, learning: false, answers: false, usage: false })
  const [showExport, setShowExport] = useState(false)

  useEffect(() => {
    if (!prefLoaded) loadPrefs()
  }, [prefLoaded, loadPrefs])

  // 用量摘要：切到「我的」页时实时重算。页面常驻挂载（隐藏/显示切换），挂载期往往尚无数据，
  // 若只在挂载时算一次会一直停在「暂无用量数据」；改为每次进入本页都刷新，与「查看」页数据一致。
  useEffect(() => {
    if (page !== 'me') return
    let alive = true
    dbUsage.getAll().then((records) => {
      if (!alive) return
      const kpi = calcKPI(records)
      const hit = kpi.calls ? `${Math.round(kpi.cacheHitRate * 100)}%` : '—'
      setUsageSub(`${formatTokens(kpi.totalTokens)} Token · 预计 ${formatCost(kpi.cost)} · 缓存命中 ${hit}`)
    })
    dbAnswers.getAll().then((records) => {
      if (!alive) return
      const p = (n: number) => String(n).padStart(2, '0')
      const days = new Set(
        records.map((r) => {
          const d = new Date(r.timestamp)
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
        }),
      )
      setStudySub(`学习 ${days.size} 天 · 已刷 ${records.length} 题`)
    })
    return () => {
      alive = false
    }
  }, [page])

  // 实际生效厂商：默认优先调用，未配置时回退到已配置厂商（含自定义提供商，getAdapter 覆盖运行时注册表）
  const activeId = resolveActiveId(providers, defaultId)
  const defaultProvider = getAdapter(activeId)
  const defaultModel = defaultProvider ? defaultProvider.name : 'DeepSeek'
  // 当前实际生效厂商下选中的具体模型 id（如 glm-4.6 / deepseek-chat）
  const activeModel = providers[activeId]?.model ?? ''
  // 仅当实际生效的模型已配置（API Key + 模型）时才在副标题展示，见 PRD 4.6
  const hasDefaultModel = isProviderReady(providers[activeId])

  const handleExport = async () => {
    if (!learningLoaded) await loadLearning()
    if (!prefLoaded) await loadPrefs()
    await loadPacks()
    // V2-F01：历史「无学习本直接拒绝」改为「学习本或知识库任一存在即可导出」（仅建了知识库也应能备份）
    const kbs = await dbKB.getAll()
    if (packs.length === 0 && kbs.length === 0) {
      showToast('暂无学习本或知识库可导出')
      return
    }
    const [usage, answers, cats] = await Promise.all([dbUsage.getAll(), dbAnswers.getAll(), dbCategories.getAll()])
    const summaryParts = [
      `${packs.length} 学习本`,
      `${kbs.length} 知识库`,
    ]
    if (exportOpts.wrongs) summaryParts.push(`${wrongs.length} 错题`)
    if (exportOpts.learning) summaryParts.push(`${states.length} 学习`)
    if (exportOpts.answers) summaryParts.push(`${answers.length} 作答`)
    if (exportOpts.usage) summaryParts.push(`${usage.length} 用量`)
    if (cats.length) summaryParts.push(`${cats.length} 分类`)
    const json = exportBackup(packs, {
      knowledgeBases: kbs,
      wrongs: exportOpts.wrongs ? wrongs : [],
      learning: exportOpts.learning ? states : [],
      answers: exportOpts.answers ? answers : [],
      usage: exportOpts.usage ? usage : [],
      categories: cats,
      preferences: { dailyReviewLimit },
    })
    try {
      const r = await exportJSONFile(`ai学备份-${new Date().toISOString().slice(0, 10)}.json`, json)
      // 6.85：原生端已落公共目录副本（或如实报错），Web 端浏览器下载已开始才提示成功
      showToast(exportResultToast(r, `已导出：${summaryParts.join(' · ')}`))
      setShowExport(false)
    } catch (e) {
      // 失败保留导出弹窗便于重试
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleImport = async () => {
    try {
      // V2-S05：选文件后先检查体积上限，超大直接拒绝，避免 JSON.parse/校验前耗尽内存
      const result = await pickImportFile(MAX_IMPORT_BYTES)
      if (result.ok === false) {
        if (result.reason === 'too-large') showToast('导入文件超过 20MB 上限，请压缩后再试')
        return
      }
      const file = parseImport(result.text)
      setImportFile(file)
      navigate('import', true)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '导入文件无效')
    }
  }

  return (
    <div>
      <div className="page-title">我的</div>
      <div className="card">
        <div className="row">
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'var(--primary-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--primary)',
            }}
          >
            学
          </div>
          <div className="flex-1">
            <div style={{ fontWeight: 700 }}>ai学用户</div>
            <div className="card-sub">{studySub || '学习 0 天 · 已刷 0 题'}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="flex-1">
            <div className="card-title">AI 设置</div>
            <div className="card-sub mt-4">
              {hasDefaultModel
                ? `模型服务 · 默认 ${defaultModel}${activeModel ? ` · ${activeModel}` : ''}`
                : '模型服务 · 未配置'}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => navigate('ai-settings', true)}>
            配置
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="flex-1">
            <div className="card-title">用量统计</div>
            <div className="card-sub mt-4">{usageSub || '暂无用量数据'}</div>
          </div>
          <button className="btn ghost sm" onClick={() => navigate('usage', true)}>
            查看
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <span className="card-title flex-1">偏好设置</span>
          <button className="btn ghost sm" onClick={() => navigate('preferences', true)}>
            设置
          </button>
        </div>
        <button className="menu-row" onClick={() => navigate('preferences', true)}>
          <span className="flex-1">每日复习上限</span>
          <span className="card-sub">{dailyReviewLimit} 题</span>
          <span className="card-sub">›</span>
        </button>
        <button className="menu-row" onClick={() => navigate('preferences', true)}>
          <span className="flex-1">默认题型</span>
          <span className="card-sub" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hasDefaultTemplate ? defaultTemplate : '使用内置默认'}
          </span>
          <span className="card-sub">›</span>
        </button>
      </div>

      <div className="card">
        <div className="row">
          <span className="card-title flex-1">向量模型</span>
          <button className="btn ghost sm" onClick={() => navigate('embed-settings', true)}>
            查看
          </button>
        </div>
        <button className="menu-row" onClick={() => navigate('embed-settings', true)}>
          <span className="flex-1">向量模型</span>
          <span className="card-sub">内置双模型介绍</span>
          <span className="card-sub">›</span>
        </button>
      </div>

      <div className="card">
        <div className="row">
          <span className="card-title flex-1">运行</span>
          <button className="btn ghost sm" onClick={() => setShowLog(true)}>
            查看
          </button>
        </div>
        <button className="menu-row" onClick={() => setShowLog(true)}>
          <span className="flex-1">运行日志</span>
          <span className="card-sub">模型 · 生题 · 知识库 · 操作</span>
          <span className="card-sub">›</span>
        </button>
      </div>

      <div className="card">
        <div className="card-title">数据管理</div>
        <div className="row mt-8">
          <span className="card-sub flex-1">导出学习本</span>
          <button className="btn ghost sm" onClick={() => setShowExport(true)}>导出</button>
        </div>
        <div className="row mt-8">
          <span className="card-sub flex-1">恢复数据</span>
          <button className="btn ghost sm" onClick={handleImport}>导入</button>
        </div>
      </div>

      {showExport && (
        <div className="mask" onClick={() => setShowExport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">选择导出的内容</div>
            <div className="modal-desc">勾选要随备份一起导出的个人进度；学习本、知识库、分类与偏好设置始终导出</div>
            <div className="exp-opts">
              <label className="exp-opt">
                <input
                  type="checkbox"
                  checked={exportOpts.wrongs}
                  onChange={(e) => setExportOpts((o) => ({ ...o, wrongs: e.target.checked }))}
                />
                <span>错题</span>
              </label>
              <label className="exp-opt">
                <input
                  type="checkbox"
                  checked={exportOpts.learning}
                  onChange={(e) => setExportOpts((o) => ({ ...o, learning: e.target.checked }))}
                />
                <span>学习进度</span>
              </label>
              <label className="exp-opt">
                <input
                  type="checkbox"
                  checked={exportOpts.answers}
                  onChange={(e) => setExportOpts((o) => ({ ...o, answers: e.target.checked }))}
                />
                <span>作答历史</span>
              </label>
              <label className="exp-opt">
                <input
                  type="checkbox"
                  checked={exportOpts.usage}
                  onChange={(e) => setExportOpts((o) => ({ ...o, usage: e.target.checked }))}
                />
                <span>用量</span>
              </label>
            </div>
            <div className="modal-btns">
              <button className="btn ghost flex-1" onClick={() => setShowExport(false)}>取消</button>
              <button className="btn flex-1" onClick={handleExport}>导出</button>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ textAlign: 'center' }}>
        <div className="card-sub">ai学 · 版本 1.0.0</div>
      </div>

      {showLog && <LogPanel onClose={() => setShowLog(false)} />}
    </div>
  )
}