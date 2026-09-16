# testdata · 出厂测试数据

由 `node scripts/gen-testdata.mjs` 生成（可重复执行，覆盖旧文件）；2026-09-07 全功能验收数据由
`node scripts/gen-testdata-20260907.mjs` 生成到 `testdata/20260907/`，两套数据互不覆盖。
`npx tsx scripts/verify-testdata.ts` 校验旧版题包，`npx tsx scripts/verify-testdata-20260907.ts`
校验本批题包/备份的关键断言。
**本目录已 gitignore**（含大文件与测试内容），文件需手动拷贝到真机（文件管理/USB）后经 app 内导入入口选择。

## 旧版文件 ↔ 用例映射

| 文件 | 大小 | 对应用例 | 说明 |
|---|---|---|---|
| kb-small.txt | 2K | FT-13-01/06、SM-04/05 | 知识库小文档（5 章结构，出目录/分块/索引用） |
| kb-large-15mb.txt | 15MB | FT-13-02、PT-04 | 大文件导入性能 |
| bad-encoding.txt | 112B | FT-13-04 | UTF-16 编码伪装 txt（乱码清洗/失败态） |
| oversize-51mb.txt | 51MB | FT-07-09 | 附件 50MB 上限拦截 |
| kb-doc.docx | 1K | FT-13-01 | Word 导入（最小合法 OOXML） |
| kb-xlsx.xlsx | 2K | FT-13-01 | Excel 导入（sharedStrings 结构） |
| pack-good-standard.md | — | FT-15-01 | 标准格式基线（判断题带选项对），应 3/3 入库 |
| pack-external-judge.md | — | FT-15-01、6.83 | 外部 AI 风格（判断题无选项），应自动补「正确/错误」后 2/2 入库 |
| pack-broken.md | — | FT-15-02 | md 坏题：缺选项 1 条进跳过明细；题型非法/缺答案在解析层丢弃（不崩） |
| pack-broken.json | — | FT-15-02 | json 坏题：三种跳过原因齐全（缺选项/题型非法/答案缺失） |
| pack-xss.md | — | ST-12/13 | 题干/选项/解析含 script 与 onerror，应转义显示不执行 |
| pack-code.md | — | FT-04-13 | python 多行代码围栏，验证刷题页代码渲染 |
| pack-weird-name.md | — | ST-08 | 标题含路径非法字符、保留名与超长文本，验证导出文件名净化 |

## 需人工准备的数据（无法脚本生成）

| 项 | 用于 |
|---|---|
| AI 厂商 API Key（如 Xiaomi MiMo） | 全部生成/接口用例（FT-07/08、IT-01~14） |
| 一台已登录微信/网盘的真机 | 分享面板导出验证（FT-03-04/14-09） |
| 千章级长文本库（可用 kb-large 重复导入叠加） | FT-14-03 阅读器性能 |

## 20260907 用例映射

| 数据文件 | 用例 | 用途 |
|---|---|---|
| `G-BASE.txt` | D-01、G-04、G-12～G-16 | 生成页基础需求输入 |
| `G-SUPPLEMENT.txt` | D-02、G-15、G-33 | 多轮补充且保留已有字段 |
| `G-CANCEL.txt` | D-03、G-18、G-37 | 需求收集取消/生成中取消 |
| `G-LONG.txt` | D-04、G-34～G-46 | 多批、进度、取消、续跑和部分完成 |
| `F-TXT.txt` | D-05、G-54、K-13、K-25 | UTF-8、标题/表格/代码片段 |
| `F-MULTI-A.txt`、`F-MULTI-B.txt` | D-06、G-55、K-41 | 多文件与关键词检索/切换 |
| `F-NOTE.txt` | D-07、K-20 | 文字笔记，正文超过 300 字 |
| `PACK-9T.json` | D-08、L-42 | 九题型导入与刷题闭环 |
| `PACK-BAD.json` | D-09、L-44 | 缺选项、答案越界、答案缺失，验证跳过明细 |
| `BACKUP-BASE.json` | D-10、L-45～L-48 | 完整备份、重复导入、合并与恢复；不含密钥/会话/日志 |
| `F-LARGE-15MB.txt`、`F-OVER-LIMIT-51MB.txt` | D-11、G-56～G-57、K-31 | 大文件性能与 50MB 单文件上限 |
| `F-INVALID.docx`、`F-INVALID.txt` | D-12、G-58、K-16 | 非法 Office 容器/空文件解析失败 |
| `F-INJECTION.txt` | D-13、G-64、G-82、K-25、C-06 | 不可信资料、HTML/脚本文本安全边界 |

生成类 `G-*.txt` 只是便于复制粘贴的输入卡片，不走资料导入入口；`PACK-*.json` 与
`BACKUP-BASE.json` 才是学习库导入入口使用的文件。
