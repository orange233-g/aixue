import { useEffect, useState } from 'react'
import { useModal } from '../stores/useModalStore'
import type { QuizMode } from '../stores/useModalStore'

export default function Modal() {
  const modal = useModal()
  const [input, setInput] = useState('')
  const [sel, setSel] = useState('')
  const [mode, setMode] = useState<QuizMode>('seq')
  const [count, setCount] = useState(0)
  /** 本次题数可键入（同 6.88 偏好/生成页 stepper 模式）：draft 非空 = 键入中，失焦/回车提交并夹取 */
  const [countDraft, setCountDraft] = useState<string | null>(null)

  const max = modal.max ?? 0

  useEffect(() => {
    if (modal.type === 'shua' && max > 0) {
      setMode('seq')
      setCount(max)
    }
  }, [modal.type, max])

  if (!modal.type) return null

  const close = () => {
    useModal.getState().close()
    setInput('')
    setSel('')
    setCountDraft(null)
  }

  const commitCount = () => {
    if (countDraft === null) return
    const n = parseInt(countDraft, 10)
    setCount(Math.max(1, Math.min(max || 1, Number.isNaN(n) ? count : n)))
    setCountDraft(null)
  }

  const confirm = () => {
    modal.onConfirm?.(modal.type === 'prompt' ? input : sel)
    close()
  }

  const confirmShua = () => {
    modal.onShua?.(mode, count)
    close()
  }

  return (
    <div className="mask" onClick={close}>
      <div className={'modal' + (modal.type === 'confirm' || modal.type === 'prompt' || modal.type === 'shua' ? ' modal-sm' : '')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{modal.title}</div>
        {modal.type === 'confirm' && modal.desc && <div className="modal-desc">{modal.desc}</div>}

        {modal.type === 'prompt' && (
          <input
            className="input"
            autoFocus
            placeholder={modal.placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        )}

        {modal.type === 'select' && (
          <div className="modal-options">
            {(modal.options ?? []).map((o) => (
              <button
                type="button"
                key={o}
                className={'modal-option' + (sel === o ? ' on' : '')}
                onClick={() => setSel(o)}
              >
                {o === '' ? '未分类' : o}
              </button>
            ))}
          </div>
        )}

        {modal.type === 'menu' && (
          <div className="modal-options">
            {(modal.menuItems ?? []).map((it) => (
              <button
                type="button"
                key={it.label}
                className={'modal-option menu-item' + (it.danger ? ' danger' : '')}
                onClick={() => {
                  close()
                  modal.onConfirm?.((it.value ?? it.label) as string)
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        )}

        {modal.type === 'shua' && (
          <div className="shua-box">
            <div className="modal-desc">刷题模式</div>
            <div className="shua-seg">
              <button
                type="button"
                className={'seg-item' + (mode === 'seq' ? ' active' : '')}
                onClick={() => setMode('seq')}
              >
                顺序刷
              </button>
              <button
                type="button"
                className={'seg-item' + (mode === 'rand' ? ' active' : '')}
                onClick={() => setMode('rand')}
              >
                随机刷
              </button>
            </div>
            <div className="modal-desc" style={{ marginTop: 16 }}>本次题数</div>
            <div className="shua-stepper">
              <button type="button" className="shua-stepper-btn" onClick={() => setCount((c) => Math.max(1, c - 5))}>−</button>
              <input
                className="shua-n"
                type="text"
                inputMode="numeric"
                aria-label="本次题数"
                value={countDraft ?? String(count)}
                onChange={(e) => setCountDraft(e.target.value.replace(/\D/g, ''))}
                onFocus={(e) => { setCountDraft(String(count)); e.target.select() }}
                onBlur={commitCount}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  else if (e.key === 'Escape') setCountDraft(null)
                }}
              />
              <button type="button" className="shua-stepper-btn" onClick={() => setCount((c) => Math.min(max, c + 5))}>+</button>
            </div>
          </div>
        )}

        {modal.type === 'menu' ? (
          <div className="modal-btns">
            <button className="btn ghost flex-1" onClick={close}>
              取消
            </button>
          </div>
        ) : modal.type === 'shua' ? (
          <div className="modal-btns">
            <button className="btn ghost flex-1" onClick={close}>
              取消
            </button>
            <button className="btn flex-1" onClick={confirmShua}>
              开始
            </button>
          </div>
        ) : (
          <div className="modal-btns">
            <button className="btn ghost flex-1" onClick={close}>
              取消
            </button>
            <button className="btn flex-1" onClick={confirm}>
              确定
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
