const fs = require('fs')
const path = require('path')
const root = 'E:/Project/maihai_V2/wenxue-ai/src'
const re = /bgeDirect|runEmbedBge|BGE_MODEL_ID|\bembedTexts\b|\.\/api|embed\/api|\.\.\/api|ai\/embed\/api/
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(p)) {
      const c = fs.readFileSync(p, 'utf8')
      if (re.test(c)) console.log(p)
    }
  }
}
walk(root)