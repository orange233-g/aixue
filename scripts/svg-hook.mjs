// 临时 loader：让 node/tsx 能加载 .svg（测试环境用），返回空 SVG 的默认导出
export async function load(url, context, nextLoad) {
  if (url.endsWith('.svg')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default "data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"></svg>"',
    }
  }
  return nextLoad(url, context)
}