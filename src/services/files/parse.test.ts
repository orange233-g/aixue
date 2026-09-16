import { describe, expect, it } from 'vitest'
import { parseFileToText, isLatinText, countWords, countLines } from './parse'

/** 构造指定编码的 txt File（据此验证中文文本的识别/解码路径） */
function txtFile(bytes: Uint8Array, name = '资料.txt'): File {
  return new File([bytes as BlobPart], name, { type: 'text/plain' })
}

function utf8Bytes(s: string): Uint8Array {
  return new Uint8Array(new TextEncoder().encode(s))
}

/** UTF-16LE 编码 + 标准 BOM（Windows 记事本「Unicode」）：按 charCodeAt 取原始 UTF-16 码元 */
function utf16LeBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2 + 2)
  out[0] = 0xff
  out[1] = 0xfe
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    out[2 + i * 2] = code & 0xff
    out[2 + i * 2 + 1] = (code >> 8) & 0xff
  }
  return out
}

describe('parseFileToText：多编码 txt 解码', () => {
  it('UTF-8 文本正常解码', async () => {
    const text = await parseFileToText(txtFile(utf8Bytes('第一章 玄武遗蜕。')))
    await expect(text).toBe('第一章 玄武遗蜕。')
  })

  it('UTF-8 BOM（EF BB BF）文本正常解码', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes('凡人修仙传。')])
    const text = await parseFileToText(txtFile(bytes))
    await expect(text).toBe('凡人修仙传。')
  })

  it('UTF-16LE + BOM 中文文本不再乱码', async () => {
    const text = await parseFileToText(txtFile(utf16LeBytes('第二千零三十二章 青竹庭院。')))
    await expect(text).toBe('第二千零三十二章 青竹庭院。')
  })
})

describe('isLatinText：拉丁字母占比判定', () => {
  it('英文文档 → true', () => {
    expect(isLatinText('The quick brown fox jumps over the lazy dog.')).toBe(true)
  })
  it('中文文档 → false', () => {
    expect(isLatinText('凡人修仙传，韩立缓缓睁开双眼。')).toBe(false)
  })
  it('空文本 → false', () => {
    expect(isLatinText('')).toBe(false)
  })
  it('代码片段（ASCII 为主）→ true（实际走 CODE_EXTS 行数分支，此处仅验证判定本身）', () => {
    expect(isLatinText('function add(a, b) {\n  return a + b\n}')).toBe(true)
  })
})

describe('countWords / countLines：词数与行数统计', () => {
  it('英文按空白切分计数', () => {
    expect(countWords('The quick brown fox jumps over the lazy dog.')).toBe(9)
    expect(countWords('hello world')).toBe(2)
  })
  it('多空白/换行不重复计数', () => {
    expect(countWords('a  b\n\nc')).toBe(3)
  })
  it('空文本 → 0', () => {
    expect(countWords('')).toBe(0)
  })
  it('行数按 \\n 计数（含末行无换行）', () => {
    expect(countLines('line1\nline2\nline3')).toBe(3)
    expect(countLines('line1\nline2\nline3\n')).toBe(4)
  })
  it('空文本 → 0', () => {
    expect(countLines('')).toBe(0)
  })
})