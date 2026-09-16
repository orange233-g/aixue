// 注册 svg-hook，供测试运行：node --import tsx --import ./scripts/svg-loader.mjs
import { register } from 'node:module'
register('./svg-hook.mjs', import.meta.url)