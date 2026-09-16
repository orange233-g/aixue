import { useEffect } from 'react'
import { useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { usePacks } from '../stores/usePackStore'
import { useModal } from '../stores/useModalStore'
import { useLearning } from '../stores/useLearningStore'
import { parseImport, parsePackMarkdown } from '../services/io'
import { pickTextFile } from '../utils'
import AppIcon from '../components/AppIcon'

export default function PacksPage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const openPack = useUI((s) => s.openPack)
  const setImportFile = useUI((s) => s.setImportFile)
  const page = useUI((s) => s.page)
  const { packs, categories, filterCat, search, loaded, load, setFilterCat, setSearch, renamePack, movePack, deletePack } = usePacks()
  const { wrongs, loaded: learningLoaded, load: loadLearning } = useLearning()
  const modal = useModal()
  /** 当前展开下拉菜单的学习本 id（点击 ⋯ 只出紧凑下拉，不再弹大窗） */
  const [menuFor, setMenuFor] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) load()
    if (!learningLoaded) loadLearning()
  }, [loaded, learningLoaded])

  // 每次回到学习库都从 IDB 重读，避免长生成/开发热更新导致内存 store 与新入库学习本失同步
  //（否则可能出现「生成页已入库、学习库暂未显示」的假象，refresh 后会自动对齐）
  useEffect(() => {
    if (page === 'packs') load()
  }, [page, load])

  const handleImport = async () => {
    try {
      const text = await pickTextFile('.md,text/markdown,.json,application/json')
      if (!text) return
      // 自动识别格式：JSON 备份以 { 开头；否则视为 Markdown 学习本
      const file = text.trimStart().startsWith('{') ? parseImport(text) : parsePackMarkdown(text)
      setImportFile(file)
      navigate('import', true)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '导入文件无效')
    }
  }

  const filtered = packs.filter((p) => {
    if (filterCat && p.category !== filterCat) return false
    if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const catNames = categories.filter((c) => c !== '')

  return (
    <div>
      {/* 主 tab 页标题字号对齐知识库（31px）：两页来回切换时标题观感一致（字体栈本就相同） */}
      <div className="page-title packs-title">学习库</div>

      {/* 错题本汇总卡片：错题本并入学习库页（导航改版 F8），点击进入错题本子页 */}
      <div className="card wrong-card" style={{ cursor: 'pointer' }} onClick={() => navigate('wrong', true)}>
        <div className="row">
          <span className="wrong-card-ic"><AppIcon name="file" size={21} /></span>
          <div className="flex-1">
            <div className="card-title">错题本</div>
            <div className="card-sub mt-4">
              {wrongs.length} 条错题 · 未掌握 {wrongs.filter((w) => !w.mastered).length} 题
            </div>
          </div>
          <span className="card-sub">›</span>
        </div>
      </div>

      {/* 搜索 + 分类管理入口 */}
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          className="input flex-1"
          placeholder="搜索学习本"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn ghost sm" onClick={handleImport}>
          导入
        </button>
        <button className="btn ghost sm" onClick={() => navigate('cat-manage', true)}>
          分类管理
        </button>
      </div>

      {/* 分类筛选器 */}
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
        <button type="button" className={'chip' + (filterCat === '' ? ' active' : '')} onClick={() => setFilterCat('')}>
          全部
        </button>
        {catNames.map((c) => (
          <button
            type="button"
            key={c}
            className={'chip' + (filterCat === c ? ' active' : '')}
            onClick={() => setFilterCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {!loaded && <div className="empty"><div className="em">⏳</div><div className="es">加载中...</div></div>}
      {loaded && packs.length === 0 && (
        <div className="empty">
          <div className="em"><AppIcon name="library" size={32} /></div>
          <div className="et">暂无学习本</div>
          <div className="es">可以用「出题」生成，或点击顶部「导入」添加现有学习本</div>
          {/* RC-04：generate 是主 tab，不能按子页压栈（subPages 无此条目 → 空壳 .page.active 白屏） */}
          <button className="btn mt-12" onClick={() => navigate('generate')}>去出题</button>
        </div>
      )}

      {/* 学习本列表 */}
      {filtered.map((p) => (
        <div key={p.id} className="card pack-card">
          <div className="row" style={{ cursor: 'pointer' }} onClick={() => { navigate('pack-detail', true); openPack(p.id) }}>
            <span className="pack-book-glyph"><AppIcon name="book" size={20} /></span>
            <span className="card-title flex-1">{p.title || '未命名'}</span>
            <span
              className="pack-menu-wrap"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="pack-menu"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuFor((prev) => (prev === p.id ? null : p.id))
                }}
              >
                ⋯
              </button>
              {menuFor === p.id && (
                <>
                  <div className="pack-menu-mask" onClick={() => setMenuFor(null)} />
                  <div className="pack-menu-pop">
                    <button
                      onClick={() => {
                        setMenuFor(null)
                        modal.prompt('重命名学习本', '输入新名称', (val) => {
                          if (val?.trim()) renamePack(p.id, val.trim())
                        })
                      }}
                    >
                      重命名
                    </button>
                    <button
                      onClick={() => {
                        setMenuFor(null)
                        modal.select('移动到分类', categories, (val) => {
                          if (val != null) movePack(p.id, val)
                        })
                      }}
                    >
                      移动到分类
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        setMenuFor(null)
                        modal.confirm('删除学习本', `确定删除「${p.title || '未命名'}」？此操作不可恢复，学习本内所有题目和学习数据将被清除。`, () => {
                          // OBS-16：删除后补 toast 反馈，与知识库删除（「已删除知识库」）保持一致
                          void deletePack(p).then(() => showToast('已删除学习本'))
                        })
                      }}
                    >
                      删除学习本
                    </button>
                  </div>
                </>
              )}
            </span>
          </div>
          <div className="card-sub mt-8">
            {p.questions?.length ?? 0} 题 · {p.chapters?.length ?? 0} 章节 · {p.meta?.difficulty ?? '未标注'}
          </div>
          {p.category && <div className="card-sub">分类：{p.category}</div>}
        </div>
      ))}

      {filtered.length > 0 && search && (
        <div className="card-sub" style={{ textAlign: 'center', padding: 8 }}>
          共找到 {filtered.length} 个学习本
        </div>
      )}
    </div>
  )
}
