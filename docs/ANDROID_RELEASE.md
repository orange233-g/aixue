# Android 构建与发布说明

本文说明 ai学（Aixue）的 Android 打包流程、签名配置与已知问题。

## 1. 工程与变体

- Capacitor 工程目录：`android/`，应用包名 `com.aixue.app`，应用名 `ai学`，`webDir` 为 `dist`（见 [capacitor.config.ts](../capacitor.config.ts)）。
- Gradle 构建变体（[android/app/build.gradle](../android/app/build.gradle)）：

| 变体 | 签名 | 用途 |
|---|---|---|
| `debug` | debug 签名 | 本地调试 |
| `personal` | 固定 debug 签名 | 个人自装包，明确与 release 区分 |
| `release` | 正式 keystore（缺一即 fail-closed） | 正式发布 |

## 2. 常用命令

```bash
npm run android:sync      # npm run build + npx cap sync android
npm run android:apk       # debug 包：build + sync + gradlew assembleDebug
npm run android:personal  # 个人自装包：build + sync + gradlew assemblePersonal
npm run android:open      # 用 Android Studio 打开工程
npm run android:release   # 正式包：环境前置检查 + build + sync + gradlew assembleRelease
```

产物位置：`android/app/build/outputs/apk/<变体>/`。

`npm run android:sync` 会把 `dist/`（含 `public/models/` 下的内置向量模型，若已放置）同步到 `android/app/src/main/assets/public/`，并生成 wasm 后端所需的 `assets/ort-wasm/`。该同步产物目录已在 `.gitignore` 中排除。

## 3. 环境要求

| 项 | 要求 |
|---|---|
| JDK | 17 及以上（`JAVA_HOME` 需指向真实存在的 JDK 目录，或 PATH 上可用的 `java`） |
| Android SDK | 通过 `ANDROID_HOME` / `ANDROID_SDK_ROOT` 指定，或写入 `android/local.properties` 的 `sdk.dir=` |
| SDK 平台 | `compileSdk` / `targetSdk` / `minSdk` 见 [android/variables.gradle](../android/variables.gradle)（当前 compileSdk 36） |
| Gradle | 使用工程自带的 wrapper（`android/gradlew.bat`），无需单独安装 |

`npm run android:release` 会先执行 [scripts/check-android-env.mjs](../scripts/check-android-env.mjs)，打印 Java / SDK / SDK 平台 / 签名的检查结果：签名缺失为硬失败（退出码 1），其余为告警（退出码 2）。

## 4. 正式签名配置

keystore 与密码**不入库**（`*.jks`、`*.keystore`、`android/local.properties` 已在 `.gitignore` 中排除）。提供四个变量，环境变量优先，也可写入 `android/gradle.properties`：

| 变量 | 含义 |
|---|---|
| `AIXUE_KEYSTORE_PATH` | keystore 文件路径 |
| `AIXUE_KEYSTORE_PASS` | keystore 存储密码 |
| `AIXUE_KEY_ALIAS` | 密钥别名 |
| `AIXUE_KEY_PASS` | 密钥密码 |

PowerShell 示例（仅当前会话有效）：

```powershell
$env:AIXUE_KEYSTORE_PATH = 'E:\keys\aixue-release.jks'
$env:AIXUE_KEYSTORE_PASS = '********'
$env:AIXUE_KEY_ALIAS     = 'aixue'
$env:AIXUE_KEY_PASS      = '********'
npm run android:release
```

生成 keystore（示例）：

```bash
keytool -genkeypair -v -keystore aixue-release.jks -alias aixue \
  -keyalg RSA -keysize 2048 -validity 36500
```

### 4.1 已知问题：签名变量命名不一致（发布前需先处理）

| 位置 | 读取的变量 |
|---|---|
| `android/app/build.gradle`（真正用于签名） | `AIXUE_KEYSTORE_PATH` / `AIXUE_KEYSTORE_PASS` / `AIXUE_KEY_ALIAS` / `AIXUE_KEY_PASS` |
| `scripts/check-android-env.mjs`（release 前置检查） | `WENXUE_KEYSTORE_PATH` / `WENXUE_KEYSTORE_PASS` / `WENXUE_KEY_ALIAS` / `WENXUE_KEY_PASS` |

后果：只配置 `AIXUE_*` 时，前置检查会报"未配置 keystore"并以退出码 1 阻断 `npm run android:release`；若两套都配成同一份 keystore，则流程可以走通。正式发布前建议把检查脚本统一为 `AIXUE_*`（或同时兼容两套命名）。

另外，`android/app/build.gradle` 只在任务图确实包含 release 任务时才做 fail-closed 校验，因此缺少正式 keystore 不影响 `assembleDebug` / `assemblePersonal`。

### 4.2 严禁用 debug 签名冒充 release

`assembleRelease` 在缺少完整签名要素时会直接抛错；个人自装请用 `assemblePersonal`，不要把 debug 签名包当作正式发布包分发。

## 5. 打包前后的检查清单

1. `npm test`、`npx tsc --noEmit`、`npm run build` 全部通过；
2. `npm run secret:scan` 通过（工作区与完整 Git 历史均无泄露）；
3. `dist/` 内确认 `assets/ort-wasm/` 已生成；如需语义检索，确认 `public/models/` 已放置模型；
4. 真机安装后验证：四条安全区不被状态栏/手势条遮挡、软键盘为平移而非压缩页面、子页返回回到宿主页、主 Tab 连按两次退出、长任务期间屏幕常亮；
5. 验证无 AI 配置时不误触发真实模型调用；配置真实 Key 后，仅在你明确授权时才发起真实生题；
6. 清除应用数据后首启不崩溃（IndexedDB 全新建库路径）。

## 6. 已知限制

- 本机若 `JAVA_HOME` 指向不存在的目录、未设置 `ANDROID_HOME`、未放置 keystore，则无法完成 release 构建；这些属于本机环境配置，不会随仓库迁移。
- 未配置向量模型时，APK 仍可正常构建与使用，只是知识库只能走 BM25 关键词检索。
- 本项目的 release 流程尚未在开放环境完成端到端验证，首次发布前请按第 5 节清单在目标机器上完整走一遍。