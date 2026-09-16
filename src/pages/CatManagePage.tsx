import { useEffect, useState } from 'react'
import { useUI } from '../stores/useUIStore'
import { usePacks } from '../stores/usePackStore'
import { useModal } from '../stores/useModalStore'
import AppIcon from '../components/AppIcon'

export default function CatManagePage() {
  const navigate = useUI((s) => s.navigate)
  const showToast = useUI((s) => s.showToast)
  const { packs, categories, loaded, load, addCategory, deleteCategory } = usePacks()
  const modal = useModal()
  const [name, setName] = useState('')

  useEffect(() => {
    if (!loaded) load()
  }, [loaded])

  const catNames = categories.filter((c) => c !== '')
  const countOf = (cat: string) => packs.filter((p) => p.category === cat).length

  const handleAdd = async () => {
    const v = name.trim()
    if (!v) return showToast('请输入分类名称')
    if (catNames.includes(v)) return showToast('分类已存在')
    await addCategory(v)
    setName('')
    showToast(`已添加分类「${v}」`)
  }

  return (
    <div>
      <div className="subhead">
        <button className="back-btn" onClick={() => navigate('packs')}>‹</button>
        <span className="subhead-title">分类管理</span>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="input flex-1"
          placeholder="新分类名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button className="btn" onClick={handleAdd}>添加</button>
      </div>

      {catNames.length === 0 && (
        <div className="empty">
          <div className="em"><AppIcon name="archive" size={32} /></div>
          <div className="et">暂无自定义分类</div>
          <div className="es">添加分类后可对学习本分组管理</div>
        </div>
      )}

      {catNames.map((c) => (
        <div key={c} className="cat-row">
          <span className="cat-name">{c}</span>
          <span className="cat-count">{countOf(c)} 个学习本</span>
          <button
            className="cat-del"
            onClick={() =>
              modal.confirm(
                '删除分类',
                `删除分类「${c}」后，其下 ${countOf(c)} 个学习本将移至「未分类」，学习本内容不受影响。`,
                () => {
                  deleteCategory(c)
                  showToast(`已删除分类「${c}」`)
                },
              )
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
