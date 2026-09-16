import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 6.82：导出平台分流——原生端写缓存 + 系统分享面板（Android WebView 无浏览器下载管线，
// blob+a.download 是无效操作）；Web 端保持浏览器下载。
// 6.85：原生端额外在公共 Documents/ai学/ 落副本（MIUI 分享面板可能没有「保存到文件」目标），
// 分享降级为「发给其他 app」的附加通道；公共副本失败不阻断分享但如实上报。
const st = vi.hoisted(() => ({
  native: false,
  writeFile: vi.fn(),
  share: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => st.native },
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE', Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf-8' },
  Filesystem: { writeFile: st.writeFile },
}))
vi.mock('@capacitor/share', () => ({
  Share: { share: st.share },
}))

import { exportTextFile, exportJSONFile, exportResultToast } from './index'

describe('exportTextFile 平台分流', () => {
  let clicked: Array<Record<string, unknown>>

  beforeEach(() => {
    st.native = false
    st.writeFile.mockReset()
    st.share.mockReset()
    // 默认两个目录都写成功，按 directory 区分返回 uri
    st.writeFile.mockImplementation(async (opts: { path: string; directory: string }) => ({
      uri: opts.directory === 'CACHE' ? `file:///cache/${opts.path}` : `file:///storage/${opts.path}`,
    }))
    st.share.mockResolvedValue({ activityType: '' })
    clicked = []
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    })
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        const el: Record<string, unknown> = {}
        el.click = () => clicked.push(el)
        return el
      }),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('原生端：先写公共 Documents/ai学/ 副本，再写缓存并带 file uri 调系统分享', async () => {
    st.native = true

    const r = await exportTextFile('linux基础.md', '<md>', 'text/markdown')

    expect(r).toMatchObject({ channel: 'native-share', fileName: 'linux基础.md', savedPath: 'Documents/ai学/linux基础.md' })
    expect(st.writeFile).toHaveBeenNthCalledWith(1, {
      path: 'ai学/linux基础.md',
      data: '<md>',
      directory: 'DOCUMENTS',
      encoding: 'utf-8',
      recursive: true,
    })
    expect(st.writeFile).toHaveBeenNthCalledWith(2, {
      path: 'linux基础.md',
      data: '<md>',
      directory: 'CACHE',
      encoding: 'utf-8',
    })
    expect(st.share).toHaveBeenCalledWith({
      title: 'linux基础.md',
      files: ['file:///cache/linux基础.md'],
    })
    expect(clicked).toHaveLength(0)
  })

  it('原生端：公共目录写失败不阻断分享，saveError 如实带回', async () => {
    st.native = true
    st.writeFile.mockImplementation(async (opts: { directory: string }) => {
      if (opts.directory === 'DOCUMENTS') throw new Error('EACCES')
      return { uri: 'file:///cache/a.md' }
    })

    const r = await exportTextFile('a.md', 'x', 'text/markdown')

    expect(r.channel).toBe('native-share')
    expect(r.savedPath).toBeUndefined()
    expect(r.saveError).toBe('EACCES')
    expect(st.share).toHaveBeenCalledTimes(1)
  })

  it('原生端：用户取消分享面板（Share canceled）不算失败，静默返回', async () => {
    st.native = true
    st.share.mockRejectedValue(new Error('Share canceled'))

    const r = await exportJSONFile('a.json', '{}')

    expect(r.channel).toBe('native-share')
  })

  it('原生端：写缓存/调起失败如实抛错（供调用方提示「导出失败」）', async () => {
    st.native = true
    st.writeFile.mockRejectedValue(new Error('File write failed'))

    await expect(exportTextFile('a.md', 'x', 'text/markdown')).rejects.toThrow('File write failed')

    st.writeFile.mockImplementation(async (opts: { directory: string }) =>
      opts.directory === 'CACHE' ? { uri: 'file:///cache/a.md' } : { uri: 'file:///storage/ai学/a.md' })
    st.share.mockRejectedValue(new Error("Can't share while sharing is in progress"))
    await expect(exportTextFile('a.md', 'x', 'text/markdown')).rejects.toThrow('sharing is in progress')
  })

  it('浏览器端：blob + a.download 下载，不触碰原生插件', async () => {
    const r = await exportTextFile('linux基础.md', '<md>', 'text/markdown')

    expect(r.channel).toBe('browser')
    expect(clicked).toHaveLength(1)
    expect(clicked[0].download).toBe('linux基础.md')
    expect(clicked[0].href).toBe('blob:mock')
    expect(st.writeFile).not.toHaveBeenCalled()
    expect(st.share).not.toHaveBeenCalled()
  })

  it('exportResultToast：按结果给出口文案（浏览器/已落盘/落盘失败）', () => {
    expect(exportResultToast({ channel: 'browser', fileName: 'a.md' }, '已导出（浏览器）')).toBe('已导出（浏览器）')
    expect(exportResultToast({ channel: 'native-share', fileName: 'a.md', savedPath: 'Documents/ai学/a.md' }, '')).toContain('Documents/ai学/a.md')
    expect(exportResultToast({ channel: 'native-share', fileName: 'a.md', saveError: 'EACCES' }, '')).toContain('EACCES')
    expect(exportResultToast({ channel: 'native-share', fileName: 'a.md' }, '')).toContain('分享')
  })
})
