# 安全策略（Security Policy）

## 报告漏洞

如果你发现安全问题，请**不要**公开提交 issue，改用私下渠道报告：

- 若本仓库托管在 GitHub：使用仓库页面的 **Security → Report a vulnerability**（Private vulnerability reporting）提交。
- 若该入口不可用：先开一个**不含任何细节**的 issue，只说明"需要私下渠道报告安全问题"，等待维护者提供联系方式后再提交细节。

报告中请尽量包含：影响版本/提交、复现步骤、影响范围（能否读取本地数据、能否外发 API Key 等）、以及你建议的修复方向。

## 适用范围

本应用是**纯前端 + 本地存储**的离线优先应用，没有自建服务端，因此关注重点为：

- 是否可能让**第三方的 Key/内容**被非预期外发（例如把 Key 发送到非用户配置的地址、日志或备份泄漏 Key）；
- 注入类问题（资料/模型输出被当作 HTML/脚本执行）；
- 开发环境中间件（`/__ai` 代理、日志落盘端点）的越权与 SSRF 风险；
- Android 打包配置导致的签名或数据暴露问题。

不在范围内：你自己配置的模型厂商服务端本身的问题；对应用进行拒绝服务式的本地资源耗尽；需要设备已被 root/越狱或已被物理控制才能触发的问题。

## 密钥处理规范（面向贡献者）

本项目对密钥采取"只走运行时配置、绝不入库"的原则，提交前请遵守：

1. **不要把 API Key、keystore、密码写进代码、文档、测试或提交信息。** 应用运行时由用户在「AI 设置」里填写，只存本机 IndexedDB。
2. 需要本地跑真实链路时，复制 `.env.example` 为 `.env` 并填入自己的 Key；`.env*` 已在 `.gitignore` 中排除。
3. Android 签名只通过环境变量或 `android/gradle.properties` 提供，keystore 文件（`*.jks` / `*.keystore`）与 `android/local.properties` 不入库。
4. 提交前执行密钥门禁：

   ```bash
   npm run secret:scan          # 发布/CI 门禁：需要 gitleaks，缺工具即失败（fail-closed）
   npm run secret:scan:optional # 日常开发：本机未装 gitleaks 时仅警告
   ```

   该门禁会同时扫描工作区与**完整 Git 历史**，任一命中即失败。`.gitleaks.toml` 只放行逐字列出的假 Key（测试/文档中的占位凭证），不允许整目录放行。
5. 日志与错误提示必须保持脱敏：不要把 `Authorization` 头、Key、内部堆栈渲染到界面或写入日志文件。

## 应用侧已有的防护措施

- 生产构建自动注入严格 CSP（`default-src 'self'`、`frame-src 'none'`、`object-src 'none'` 等），限制脚本只能来自应用自身域。
- 开发代理 `/__ai` 采用 host 精确白名单，拒绝内网/环回/裸 IP，过滤逐跳请求头，限制请求体大小与并发，并逐跳校验重定向目标。
- 备份/导出内容不包含 API Key。
- 密钥扫描门禁（见上）在提交与发布环节双重拦截。