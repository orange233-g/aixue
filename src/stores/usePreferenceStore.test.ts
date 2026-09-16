import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllStores, dbConfig, initDB } from '../db'
import { usePreferences, APP_BG_OPTIONS } from './usePreferenceStore'

describe('usePreferences 换肤偏好（6.86）', () => {
  beforeEach(async () => {
    await initDB()
    await clearAllStores()
    // zustand store 是模块单例，用例间重置回默认态
    usePreferences.setState({ dailyReviewLimit: 20, appBg: 'default', loaded: false })
  })

  it('空库 load → 默认色 default', async () => {
    await usePreferences.getState().load()
    expect(usePreferences.getState().appBg).toBe('default')
  })

  it('setAppBg 持久化，重启（重新 load）后恢复', async () => {
    await usePreferences.getState().load()
    usePreferences.getState().setAppBg('dark')
    expect(usePreferences.getState().appBg).toBe('dark')
    // 模拟重启：内存重置后重新 load
    usePreferences.setState({ appBg: 'default', loaded: false })
    await usePreferences.getState().load()
    expect(usePreferences.getState().appBg).toBe('dark')
  })

  it('库内非法肤色值 → 回退 default（不进白名单就不生效）', async () => {
    await dbConfig.set('appearance', { bg: 'hot-pink' })
    await usePreferences.getState().load()
    expect(usePreferences.getState().appBg).toBe('default')
  })

  it('改每日复习上限不影响已选肤色（两键隔离，互不覆盖）', async () => {
    await usePreferences.getState().load()
    usePreferences.getState().setAppBg('green')
    usePreferences.getState().setDailyReviewLimit(50)
    usePreferences.setState({ appBg: 'default', dailyReviewLimit: 20, loaded: false })
    await usePreferences.getState().load()
    expect(usePreferences.getState().appBg).toBe('green')
    expect(usePreferences.getState().dailyReviewLimit).toBe(50)
  })

  it('肤色白名单与色值一一对应（弹层选项与 CSS 变量同源）', () => {
    const ids = APP_BG_OPTIONS.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const o of APP_BG_OPTIONS) expect(o.color).toMatch(/^#[0-9a-fA-F]{6}$/)
  })
})
