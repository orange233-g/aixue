// 扫描 ONNX 图输入/输出名（不整读 614MB 避免 ERR_STRING_TOO_LONG，分段找关键串）
const fs = require('fs')
const p = 'E:/Project/maihai_V2/wenxue-ai/model-pack/qwen3-embedding-0.6b/onnx/model_quantized.onnx'
const fd = fs.openSync(p, 'r')
const size = fs.fstatSync(fd).size
const CHUNK = 1 << 24 // 16MB
const overlaps = new Set(['input_ids', 'attention_mask', 'token_type_ids', 'last_hidden_state', 'sentence_embedding', 'output'])
let prevTail = ''
for (let off = 0; off < size; off += CHUNK) {
  const buf = Buffer.alloc(Math.min(CHUNK, size - off))
  fs.readSync(fd, buf, 0, buf.length, off)
  const s = prevTail + buf.toString('latin1')
  for (const name of overlaps) {
    if (name.length > 2 && s.includes(name)) console.log('FOUND:', name, '@', off)
  }
  prevTail = s.slice(-80)
}
fs.closeSync(fd)
// producer + graph name
console.log('file size', size)