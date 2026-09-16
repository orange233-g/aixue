# 第三方依赖与模型许可（Third-Party Notices）

本项目以 [MIT](LICENSE) 许可证发布。下表列出运行/构建所依赖的第三方软件及其许可，以及内置向量模型的来源与许可。完整版本与依赖树见 `package-lock.json`。

## 运行时依赖

| 组件 | 许可 |
|---|---|
| [React](https://react.dev/) / react-dom | MIT |
| [zustand](https://github.com/pmndrs/zustand) | MIT |
| [idb](https://github.com/jakearchibald/idb) | ISC |
| [fflate](https://github.com/101arrowz/fflate) | MIT |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT |
| [@capacitor/core](https://capacitorjs.com/) / @capacitor/android | MIT |
| [@capacitor/app](https://github.com/ionic-team/capacitor-plugins) | MIT |
| [@capacitor/filesystem](https://github.com/ionic-team/capacitor-plugins) | MIT |
| [@capacitor/share](https://github.com/ionic-team/capacitor-plugins) | MIT |

## 开发与构建依赖

| 组件 | 许可 |
|---|---|
| [Vite](https://vite.dev/) / [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 |
| [Vitest](https://vitest.dev/) | MIT |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | Apache-2.0 |
| [Playwright](https://playwright.dev/) | Apache-2.0 |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped) 等类型包 | MIT |

`src/assets/ort.min.mjs` 与构建时由 `scripts/copy-ort.mjs` 从 `node_modules/onnxruntime-web/dist` 复制的 wasm 后端文件，同样遵循 onnxruntime 的 MIT 许可。

## 内置向量模型（不随仓库分发，由使用者自行放置）

| 模型 | 开发者 | 许可 | 说明 |
|---|---|---|---|
| bge-small-zh-v1.5 | 北京智源人工智能研究院（BAAI） | MIT | 默认推荐，约 90 MB，512 维，中文检索效果好、手机端友好 |
| Qwen3-Embedding-0.6B | 阿里巴巴通义千问团队 | Apache-2.0 | 进阶选项，约 596 MB（量化版），1024 维，支持 100+ 语言与 32K 上下文 |

模型权重不包含在本仓库中。使用者需自行从模型发布方获取对应文件并放置到 `public/models/`（所需文件与 SHA256 校验值见 `src/ai/embed/registry.ts`），使用即表示同意遵守相应模型的许可条款。

## 厂商名称与商标

应用内出现的第三方厂商名称、Logo（`public/providers/*.svg`）与模型名称仅用于标识你自行配置的调用目标，其商标与品牌权利归各自所有者所有，本项目与其无隶属或背书关系。

## 示例题包

`public/test-packs/` 下的示例题包由本项目生成，用于功能演示与导入格式参考（内容为通用常识类题目），与上述第三方许可无关。