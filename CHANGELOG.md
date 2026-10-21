# 变更记录（Changelog）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 升级 `@capacitor/android` 至 ≥ 8.5.1（修复上游安全公告 GHSA-rvm3-566m-v7fv）。
- 模型包下载页/清单校验（可选）。

## [1.0.0] - 2026-10-22

首个开源版本。

### 新增

- **对话式生题**：自然语言描述主题/题量/题型，AI 收集需求、确认方案后流式生成；支持快捷生成、批次并发调度、限流自适应、中断续跑与缺口补齐。
- **九种题型**：单选、多选、判断、填空、匹配、排序、简答、案例分析、论文。
- **学习与复习**：学习本/分类管理、顺序与随机刷题、成绩复盘、错题本、SRS 今日复习。
- **本地知识库**：txt/md/csv/代码/docx/xlsx/odt 导入与笔记，BM25 关键词检索 + 端侧 ONNX 语义检索，召回测试与全屏阅读器。
- **向量模型**：内置 `bge-small-zh-v1.5`；支持从发布页下载 `.aixue-model` 模型包后在应用内本地导入（如 Qwen3-Embedding-0.6B），导入时校验文件大小与 SHA256。
- **AI 供应商**：9 家 OpenAI 兼容适配器、自定义 API 地址、模型列表拉取、连通性测试、思考开关与峰谷计价。
- **用量统计**：按时间窗/板块/模型/天统计 Token 与花费。
- **导入导出**：JSON/Markdown 题包导入、学习本导出 Markdown、全量数据备份与恢复（不含 API Key）。
- **Android**：Capacitor 打包，安全区/软键盘/返回手势适配，长任务屏幕常亮。

### 安全

- API Key 只存本机 IndexedDB，备份/导出不包含密钥。
- 生产构建注入严格 CSP；开发代理 `/__ai` 采用厂商域名精确白名单、拒绝内网/环回地址、限制请求体与并发、逐跳校验重定向。
- 密钥扫描门禁（gitleaks）覆盖工作区与完整 Git 历史。

### 文档

- README、部署与模型准备、Android 发布、知识库原理、九题型导入示例、模型包格式与导入说明。
- CONTRIBUTING / SECURITY / PRIVACY / THIRD-PARTY-NOTICES / CODE_OF_CONDUCT。

