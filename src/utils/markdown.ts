/**
 * 轻量 Markdown → 安全 HTML 渲染器（供聊天助手气泡使用）。
 *
 * 安全模型：只在「内容」层面对文本做 HTML 转义（& < > " '），杜绝注入；
 * 块级标记（标题#、引用>、列表-/*、分隔线）在原始行上先行识别，避免被转义破坏。
 * 因内容已转义，正则插入的标签只包含写死的词与受控的 http(s) 链接，不会把用户输入带进标签名/属性。
 *
 * 覆盖聊天气泡常见子集：标题、加粗、斜体、行内代码、列表、引用、分隔线、行内链接、代码块。
 * 对齐 Cherry Studio 的 Streamdown：聊天内容用轻渲染、不引入外部依赖。
 */

import { convertMath } from './math'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 内容行：先转义 HTML，再处理行内标记（代码→加粗→斜体→链接）。
 *  亦供选项等「单行文本」场景做行内富文本（不产生块级标签）。 */
export function inline(s: string): string {
  const escaped = escapeHtml(s).trim()
  return escaped
    .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
}

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/

/** GFM 表格行：以 | 开头且以 | 结尾（内容已含至少一个分隔） */
function isTableLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length >= 2
}

/** 表头分隔行：|---|:---:| 之类（只含 - : | 和空白） */
const TABLE_SEP_RE = /^\|?[\s:|-]+\|$/

/** 把一行表格按 | 切成单元格（去首尾空与首尾竖线），内容走 inline 渲染 */
function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => inline(cell.trim()))
}

export interface MarkdownRenderOptions {
  /** 标题锚点：返回每个标题（按出现顺序）的 id；缺省不加 id */
  headingId?: (index: number) => string
}

function renderBlocks(lines: string[], opts: MarkdownRenderOptions = {}): string {
  // 先做 LaTeX 数学符号 → 可读 Unicode 转换（代码块更早在 renderMarkdown 里按 ``` 切出，不经过这里）
  const src = lines.map(convertMath)
  const out: string[] = []
  let i = 0
  let hIdx = 0
  while (i < lines.length) {
    const raw = src[i]
    const t = raw.trim()

    if (!t) {
      i++
      continue
    }
    if (HR_RE.test(t)) {
      out.push('<hr/>')
      i++
      continue
    }

    // GFM 表格：当前行是 | 行、且下一行是 |---|---| 分隔行 → 渲染为表格（窄屏由 CSS 横向滚动）
    if (isTableLine(t) && i + 1 < src.length && TABLE_SEP_RE.test(src[i + 1].trim())) {
      const head = parseTableRow(src[i])
      i += 2 // 跳过表头行与分隔行
      const body: string[][] = []
      while (i < src.length && isTableLine(src[i])) {
        body.push(parseTableRow(src[i]))
        i++
      }
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head
          .map((c) => `<th>${c}</th>`)
          .join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }

    const head = t.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      const id = opts.headingId ? ` id="${opts.headingId(hIdx)}"` : ''
      hIdx++
      out.push(`<h${head[1].length}${id}>${inline(head[2])}</h${head[1].length}>`)
      i++
      continue
    }

    if (t.startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && src[i].trim().startsWith('>')) {
        body.push(inline(src[i].trim().replace(/^>\s?/, '')))
        i++
      }
      out.push(`<blockquote>${body.join('<br/>')}</blockquote>`)
      continue
    }

    // 无序列表：连续行合并为同一 <ul>
    const ul = t.match(/^[-*+]\s+(.*)$/)
    if (ul) {
      const items: string[] = [inline(ul[1])]
      i++
      while (i < lines.length) {
        const m = src[i].trim().match(/^[-*+]\s+(.*)$/)
        if (m) {
          items.push(inline(m[1]))
          i++
        } else break
      }
      out.push(`<ul>${items.map((it) => `<li>${it}</li>`).join('')}</ul>`)
      continue
    }

    // 有序列表：连续编号项合并为同一 <ol>；项间夹着的无序行并入上一项作嵌套子列表，
    // 空行后若仍是有序项则视为同一列表延续（CommonMark loose list）——
    // 否则模型输出「1. … 1. …」且项间带 - 子项时，每段各自成 <ol> 全部从 1 重新编号（真机 bug 6.x）。
    // 显式 start 保留模型写的起始编号（如「3.」开头不丢）。
    const ol = t.match(/^(\d+)[.)]\s+(.*)$/)
    if (ol) {
      const start = parseInt(ol[1], 10) || 1
      const items: { html: string; subs: string[] }[] = [{ html: inline(ol[2]), subs: [] }]
      i++
      while (i < lines.length) {
        const tt = src[i].trim()
        if (!tt) {
          // 空行：向后看一行，下一条非空行仍是有序项 → 继续同一列表；否则列表结束
          const nxt = src.slice(i + 1).find((l) => l.trim())
          if (nxt && /^\d+[.)]\s+/.test(nxt.trim())) {
            i++
            continue
          }
          break
        }
        const m = tt.match(/^\d+[.)]\s+(.*)$/)
        if (m) {
          items.push({ html: inline(m[1]), subs: [] })
          i++
          continue
        }
        const sub = tt.match(/^[-*+]\s+(.*)$/)
        if (sub) {
          items[items.length - 1].subs.push(inline(sub[1]))
          i++
          continue
        }
        break
      }
      out.push(
        `<ol start="${start}">${items
          .map((it) =>
            it.subs.length
              ? `<li>${it.html}<ul>${it.subs.map((s) => `<li>${s}</li>`).join('')}</ul></li>`
              : `<li>${it.html}</li>`,
          )
          .join('')}</ol>`,
      )
      continue
    }

    // 段落：合并连续普通行，段内软换行
    const para: string[] = [inline(raw)]
    i++
    while (
      i < lines.length &&
      src[i].trim() &&
      !/^(#{1,6})\s/.test(src[i].trim()) &&
      !/^[-*+]\s/.test(src[i].trim()) &&
      !/^\d+[.)]\s/.test(src[i].trim()) &&
      !src[i].trim().startsWith('>') &&
      !isTableLine(src[i].trim()) &&
      !HR_RE.test(src[i].trim())
    ) {
      para.push(inline(src[i]))
      i++
    }
    out.push(`<p>${para.join('<br/>')}</p>`)
  }
  return out.join('')
}

export function renderMarkdown(src: string, opts: MarkdownRenderOptions = {}): string {
  if (!src) return ''
  // 先按 ``` 切分（原始文本），奇数段为代码块、偶数段为普通文本
  const parts = src.split('```')
  let out = ''
  for (let idx = 0; idx < parts.length; idx++) {
    if (idx % 2 === 1) {
      // 代码块：去掉首行语言标记，内容转义后展示
      let code = parts[idx]
      const nl = code.indexOf('\n')
      if (nl !== -1) code = code.slice(nl + 1)
      else code = ''
      out += `<pre class="md-code"><code>${escapeHtml(code)}</code></pre>`
    } else {
      out += renderBlocks(parts[idx].split('\n'), opts)
    }
  }
  return out
}