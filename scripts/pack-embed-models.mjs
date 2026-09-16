#!/usr/bin/env node
/**
 * 模型清单打包脚本（V-EMB 一期，托管后置用）：
 * 输入：本地模型目录（含 config.json/tokenizer.json/model.onnx 等）
 * 输出：stdout 打印可直接贴入 `docs/embed-models.example.json` / registry 的 files 片段
 *   （文件名 + 字节数 + SHA256），并支持 --baseUrl 前缀拼出完整 source 条目。
 *
 * 用法：
 *   node scripts/pack-embed-models.mjs <模型目录> --baseUrl <文件目录URL>
 * 示例：
 *   node scripts/pack-embed-models.mjs ./models/bge-small-zh-v1.5 \
 *     --baseUrl https://github.com/xxx/ai-xue-models/releases/download/v1.0/bge
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [, , dir, ...rest] = process.argv
const baseUrlFlag = rest.indexOf('--baseUrl')
const baseUrl = baseUrlFlag >= 0 ? rest[baseUrlFlag + 1] : ''

if (!dir) {
  console.error('用法: node scripts/pack-embed-models.mjs <模型目录> [--baseUrl <文件目录URL>]')
  process.exit(1)
}

/** 模型需要的文件（与 src/ai/embed/storage.ts MODEL_FILES 保持一致） */
const MODEL_FILES = {
  'bge-small-zh-v1.5': ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'],
  'qwen3-embedding-0.6b': [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
  ],
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const files = []
const modelId = rest.find((a) => a && !a.startsWith('--') && !a.includes('/'))
const want = modelId ? MODEL_FILES[modelId] : null

// 遍历目录收集（want 存在时按清单过滤；否则取全部常规文件）
function walk(d, prefix = '') {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (want && !want.includes(rel)) continue
    if (statSync(p).isDirectory()) walk(p, rel)
    else files.push({ name: rel, size: statSync(p).size, sha256: sha256(p) })
  }
}

walk(dir)

if (files.length === 0) {
  console.error('目录为空或未匹配到模型文件')
  process.exit(1)
}

const out = {
  baseUrl: baseUrl || '<文件目录URL>',
  files: files.sort((a, b) => a.name.localeCompare(b.name)),
}
console.log(JSON.stringify(out, null, 2))
