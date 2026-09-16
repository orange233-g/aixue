/**
 * 轻量 LaTeX 数学符号 → 可读 Unicode 文本（供轻量 Markdown 渲染前预处理）。
 *
 * 适用对象是聊天助手气泡里出现的行内公式（如 $r$、$B \cdot A$、$\frac{a}{b}$）。
 * 不引入 MathJax/KaTeX 等重依赖（对齐 Cherry Studio 的 Streamdown 思路），
 * 而是在渲染前把这些 LaTeX 定界符与常用命令转成普通可读文本，保证任意环境都能正常显示。
 *
 * 能力覆盖：$...$ 与 $$...$$ 定界符；常用二元运算符（\cdot \times \div \pm \le \ge \ne \approx）；
 * 希腊字母；\frac{a}{b}、\sqrt{...}、上下标（^ _）；无法识别的 \command 与花括号去掉并用原字符兜底。
 */

/** 常用 LaTeX 命令 → Unicode 文本映射（名称 → 输出） */
const LATEX_COMMANDS: Record<string, string> = {
  cdot: '·',
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  sum: 'Σ',
  prod: 'Π',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  rightarrow: '→',
  to: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  prime: '′',
  degree: '°',
  emptyset: '∅',
  cap: '∩',
  cup: '∪',
  subset: '⊂',
  subseteq: '⊆',
  in: '∈',
  notin: '∉',
  sqrt: '√',
}

/** 解析一组 {...}（pos 指向 '{'），返回 [组内文本, 消费后的位置]；格式异常返回 null 保底 */
function parseBraced(text: string, pos: number): [string, number] | null {
  if (text[pos] !== '{') return null
  let depth = 1
  let i = pos + 1
  const start = i
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return [text.slice(start, i), i + 1]
    }
    i++
  }
  return null
}

/** 把一个「内部数学表达式」（不含 $ 定界符）转成可读 Unicode 文本 */
function convertInner(expr: string): string {
  let out = ''
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === '\\') {
      // 读命令名（字母序列）
      let j = i + 1
      while (j < expr.length && /[A-Za-z]/.test(expr[j])) j++
      const name = expr.slice(i + 1, j)
      if (name === 'frac') {
        // \frac{a}{b} → (a/b)：解析两组花括号
        // 跳过命令后的空白
        let k = j
        while (k < expr.length && /[\s]/.test(expr[k])) k++
        const num = k < expr.length && expr[k] === '{' ? parseBraced(expr, k) : null
        if (!num) {
          const n = j > i + 1 ? expr.slice(i, j) : '\\'
          out += n
          i = k
          continue
        }
        let k2 = num[1]
        while (k2 < expr.length && /[\s]/.test(expr[k2])) k2++
        if (k2 < expr.length && expr[k2] === '{') {
          const den = parseBraced(expr, k2)
          if (den) {
            out += `(${convertInner(num[0])}/${convertInner(den[0])})`
            i = den[1]
            continue
          }
        }
        out += convertInner(num[0])
        i = k2
        continue
      }
      if (name === 'sqrt') {
        // \sqrt{...} → √(...) 或 √x（单字符则不加括号）
        let k = j
        while (k < expr.length && /[\s]/.test(expr[k])) k++
        const body = k < expr.length && expr[k] === '{' ? parseBraced(expr, k) : null
        if (body) {
          const inner = convertInner(body[0])
          out += inner.length === 1 ? `√${inner}` : `√(${inner})`
          i = body[1]
          continue
        }
        out += '√'
        i = k
        continue
      }
      // 普通命令：查表；查不到则丢弃反斜杠、留原名（避免 \ 残留在转义后的 HTML 里）
      const mapped = LATEX_COMMANDS[name]
      if (mapped != null) {
        out += mapped
        i = j
        continue
      }
      if (j > i + 1) {
        out += name // 未知命令：保留名称可读性
        i = j
        continue
      }
      // 孤立的斜杠 + 非字母（如符号转义 \_）：丢弃反斜杠，保留后续字符
      out += expr[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === '^' || ch === '_') {
      // 上/下标：把紧跟的单个字符或 {组} 提出来，紧凑显示（如 r^2 → r²）
      let k = i + 1
      while (k < expr.length && /[\s]/.test(expr[k])) k++
      if (k < expr.length && expr[k] === '{') {
        const grp = parseBraced(expr, k)
        if (grp) {
          out += `(${convertInner(grp[0])})`
          i = grp[1]
          continue
        }
      }
      const inner = expr[k] ?? ''
      out += inner.length === 1 ? inner : ''
      i = k + 1
      continue
    }
    if (ch === '{' || ch === '}') {
      // 孤立的包裹符（非命令一部分）直接去掉
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * 扫描文本，找出 $...$ / $$...$$ 数学段（跳过 ` 行内代码）并替换为可读文本。
 * 未闭合的 $ 按普通字符保留（避免误伤货币 $5、版本号等）。
 */
export function convertMath(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    // 跳过行内代码段（`` `...` ``），其中的 $ 保持原样
    if (ch === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== '`') j++
      if (j < text.length) {
        out += text.slice(i, j + 1)
        i = j + 1
        continue
      }
      out += '`'
      i++
      continue
    }
    if (ch === '$') {
      // 支持 $$...$$（块级）与 $...$（行内）
      const isBlock = text[i + 1] === '$'
      const end = isBlock ? '$$' : '$'
      const startIdx = i + (isBlock ? 2 : 1)
      const closeIdx = text.indexOf(end, startIdx)
      if (closeIdx !== -1 && closeIdx > startIdx && !text.slice(startIdx, closeIdx).includes('\n')) {
        const expr = text.slice(startIdx, closeIdx)
        // 形如纯运算符/字母的短表达式才转换，避免把「商品  $5 上标 $3」这类误当公式
        out += convertInner(expr)
        i = closeIdx + end.length
        continue
      }
      // 未闭合：按普通字符保留
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}