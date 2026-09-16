# -*- coding: utf-8 -*-
"""生成 Qwen3(BPE) 与 bge(WordPiece) 两个模型对样例字符串的官方 token id，供 tokenizers.test.ts 黄金对照。
用法: python scripts/_qwen_tok_groundtruth.py
输出: 每串 "原文 => [id, ...]"  用本机 tokenizers(Rust) 加载 model-pack 同款 tokenizer.json。
"""
import json
import os
from tokenizers import Tokenizer

BASE = os.path.join(os.path.dirname(__file__), '..', 'model-pack')

qwen = Tokenizer.from_file(os.path.join(BASE, 'qwen3-embedding-0.6b', 'tokenizer.json'))
bge = Tokenizer.from_file(os.path.join(BASE, 'bge-small-zh-v1.5', 'tokenizer.json'))

QWEN_SAMPLES = [
    '你好，世界！这是一个测试。',
    'Given a web search query',
]
BGE_SAMPLES = [
    '你好',
    'embedding',
    '韩立修炼了神秘功法',
]

print('===== QWEN3 (BPE) =====')
for s in QWEN_SAMPLES:
    ids = qwen.encode(s).ids
    print(json.dumps(s), '=>', ids)

print('===== BGE (WordPiece) =====')
for s in BGE_SAMPLES:
    ids = bge.encode(s).ids
    print(json.dumps(s), '=>', ids)