# 贡献指南

感谢你对 ai学（Aixue）感兴趣。提交代码前请先阅读本页。

## 环境

- Node.js **20.19+ 或 22.12+**（Vite 8 的引擎要求，开发使用 Node 24）
- npm 10+
- Android 构建（可选）：JDK 17+、Android SDK（compileSdk 36），见 [docs/ANDROID_RELEASE.md](docs/ANDROID_RELEASE.md)

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # 单元测试（Vitest + fake-indexeddb）
npx tsc --noEmit   # 类型检查
npm run build      # 生产构建（tsc + vite）
npm run secret:scan # 密钥扫描（需安装 gitleaks）
```

向量模型说明：

- 内置 `bge-small-zh-v1.5` 的权重不随仓库分发，放在 `public/models/bge/` 后才会参与构建；
  未放置时除了「语义检索」外其余功能均可用（知识库请选 BM25）。
- Qwen3 等可选模型通过模型包导入，格式与打包方式见 [docs/模型包与导入.md](docs/模型包与导入.md)。

## 提交前自检

1. `npx tsc --noEmit` 与 `npm test` 必须通过；
2. 不要提交任何密钥、`.env`、个人路径、日志、模型权重、APK、`dist/`、`docs/internal/`；
3. 涉及 AI 供应商/模型能力时，保持多厂商通用，不要把逻辑写死在某一家；
4. 新增或修改用户可见行为时，同步更新 README / docs。

## 提交信息

使用 Conventional Commits 风格（中英文均可），例如：

- `feat: 向量模型支持本地导入模型包`
- `fix: 修正知识库删除后模型缓存未释放`
- `docs: 补充模型包发布步骤`

## 问题反馈

- 功能/使用问题：开 Issue，附版本、平台（Web / Android）、复现步骤与日志；
- 安全漏洞：请按 [SECURITY.md](SECURITY.md) 私下上报，不要直接开公开 Issue。

## 许可证

提交的代码默认以 [MIT](LICENSE) 许可发布；第三方依赖与模型许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
