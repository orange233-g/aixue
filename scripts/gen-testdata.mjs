/**
 * 出厂测试数据生成器（6.93）：一键生成 docs/出厂测试用例.md 所需的全部测试文件到 testdata/。
 * 运行：node scripts/gen-testdata.mjs
 * 产物清单与用例映射见 testdata/README.md。testdata/ 已 gitignore（含大文件与用户内容）。
 */
import { zipSync, strToU8 } from 'fflate'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'testdata')
mkdirSync(OUT, { recursive: true })

const write = (name, data) => {
  writeFileSync(join(OUT, name), data)
  const kb = typeof data === 'string' ? Buffer.byteLength(data) : data.length
  console.log(`✓ ${name}  ${(kb / 1024 / 1024).toFixed(2)} MB`)
}

/* ---------- 知识库 txt ---------- */

const kbSmallText = `海洋生物知识手册

第一章 海洋生态系统
海洋是地球生命最早的摇篮，海洋生态系统包括红树林、珊瑚礁、深海热泉、潮间带等多种类型。珊瑚礁虽然只占海洋面积的不到百分之一，却养活了约四分之一的海洋物种，被称为海底热带雨林。
海洋食物链从浮游植物开始，它们通过光合作用固定能量，是整条食物链的基础。浮游动物、小型鱼类、大型掠食者层层递进，能量沿食物链逐级传递时大约只有百分之十能够流向上一级。

第二章 鲸类动物
鲸类分为须鲸与齿鲸两大类。须鲸没有牙齿，依靠鲸须板滤食磷虾与小鱼，蓝鲸是地球历史上体型最大的动物，成年蓝鲸体长可达三十米，心脏相当于一辆小汽车的大小。
齿鲸以乌贼和鱼类为食，具有回声定位能力。抹香鲸可以下潜到两千米以上的深海捕捉大王乌贼，其头部储存的大量鲸脑油曾经是人类捕鲸的重要目标。

第三章 珊瑚与共生
珊瑚虫是刺胞动物，它与虫黄藻形成共生关系：虫黄藻通过光合作用为珊瑚提供养分，珊瑚则为虫黄藻提供庇护与光合所需的代谢产物。海水温度升高会导致珊瑚排出虫黄藻，出现白化现象。
大堡礁是世界最大的珊瑚礁系统，绵延两千三百公里。近年来多次大规模白化事件促使各国加强海洋保护区的建设。

第四章 深海生物
深海阳光无法到达，深海生物依靠化学合成或海洋雪为生。鮟鱇鱼用头部的发光器官引诱猎物，巨型的深海大王乌贼拥有动物界最大的眼睛，直径可达二十七厘米。
深海热泉喷出富含硫化物的热液，管虫与热泉虾依靠体内硫化物氧化细菌为生，形成了不依赖阳光的独立生态系统。

第五章 海洋保护
过度捕捞、塑料污染、海水酸化与气候变暖是海洋面临的四大威胁。每年约有八百万吨塑料进入海洋，微塑料已经出现在从浮游生物到顶级掠食者的各级生物体内。
建立海洋保护区、执行休渔制度、减少一次性塑料使用是个人与政府层面都可以参与的海洋保护行动。
`
write('kb-small.txt', kbSmallText)

// 15MB 大文件：中文段落 + 章节标记循环（分块/目录/导入性能用）
{
  const chunk = `深海观测第%N%章。海洋观测网由海底光缆、观测节点与岸基数据中心组成，可对深海温度、盐度、洋流与生物活动进行连续实时监测。浮标阵列随洋流漂移，卫星数据链路每天回传数次观测结果。%N%
水下机器人分为遥控潜水器与自主水下航行器两类，前者由母船通过脐带缆供电与通信，后者依靠自带能源按预设航线作业。深海高压低温环境下，设备的密封与防腐是工程上的主要难点。%N%
海洋声学层析利用声波在海水中的传播速度随温度变化的特性，反演大范围海水的温度场结构。鲸类的歌声可以在水中传播数百公里，是研究海洋哺乳动物迁徙的重要数据来源。%N%
`
  const target = 15 * 1024 * 1024
  let buf = ''
  let n = 1
  // Buffer.byteLength 计字节数保证跨字符集准确
  while (Buffer.byteLength(buf, 'utf8') < target) {
    buf += chunk.replaceAll('%N%', String(n++))
  }
  write('kb-large-15mb.txt', buf)
}

// 无效编码：UTF-16LE BOM + 中文（用 utf-8 解码产生大量 U+FFFD，触发乱码清洗/整理失败路径）
{
  const text = '这是一个故意使用错误编码保存的测试文件。海洋数据整理程序应当能够优雅地处理乱码内容，而不是崩溃。海洋海洋海洋。'
  const bytes = Buffer.from(text, 'utf16le')
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes])
  write('bad-encoding.txt', withBom)
}

// 超 50MB 附件（附件上限拦截用例 FT-07-09）
{
  const block = '海洋大数据重复块0123456789。'.repeat(64) // ~2KB
  const target = 51 * 1024 * 1024
  const parts = []
  let total = 0
  while (total < target) {
    parts.push(block)
    total += block.length // ASCII+常用汉字混合，按字节再校
    if (total > target) break
  }
  let out = Buffer.concat(parts.map((p) => Buffer.from(p, 'utf8')))
  out = out.subarray(0, target)
  write('oversize-51mb.txt', out)
}

/* ---------- Office 文档（最小合法 OOXML） ---------- */

const xmlDecl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        xmlDecl +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
      ),
      '_rels/.rels': strToU8(
        xmlDecl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
      ),
      'word/document.xml': strToU8(
        xmlDecl +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        body +
        '</w:body></w:document>',
      ),
    },
    { level: 6 },
  )
}

function makeXlsx(sheetName, rows) {
  // sharedStrings 方案：全部文本进 sharedStrings，单元格 t="s" 引用
  const strings = [...new Set(rows.flat())]
  const idx = (t) => strings.indexOf(t)
  const sst =
    xmlDecl +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((t) => `<si><t>${t}</t></si>`).join('') +
    '</sst>'
  const sheetXml =
    xmlDecl +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows
      .map(
        (row, ri) =>
          `<row r="${ri + 1}">` +
          row
            .map((cell, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="s"><v>${idx(cell)}</v></c>`)
            .join('') +
          '</row>',
      )
      .join('') +
    '</sheetData></worksheet>'
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        xmlDecl +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
      ),
      '_rels/.rels': strToU8(
        xmlDecl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
      ),
      'xl/workbook.xml': strToU8(
        xmlDecl +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="海洋数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        xmlDecl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '</Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(sst),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    },
    { level: 6 },
  )
}

write(
  'kb-doc.docx',
  makeDocx([
    '海洋生物知识手册（Word 版）',
    '第一章 海洋生态系统：珊瑚礁被称为海底热带雨林，养活了约四分之一的海洋物种。',
    '第二章 鲸类动物：蓝鲸是地球历史上体型最大的动物，心脏相当于一辆小汽车的大小。',
    '第三章 深海生物：深海热泉生态系统不依赖阳光，管虫依靠硫化物氧化细菌为生。',
    '第四章 海洋保护：每年约有八百万吨塑料进入海洋，微塑料已进入各级生物体内。',
  ]),
)

write(
  'kb-xlsx.xlsx',
  makeXlsx('海洋数据', [
    ['物种', '类群', '分布深度', '保护级别'],
    ['蓝鲸', '须鲸', '表层至深海', '濒危'],
    ['抹香鲸', '齿鲸', '深海', '易危'],
    ['鹿角珊瑚', '刺胞动物', '浅海珊瑚礁', '近危'],
    ['大王乌贼', '头足类', '深海', '无危'],
    ['海獭', '鳍足类近亲', '近岸 kelp 森林', '濒危'],
  ]),
)

/* ---------- Markdown 题包变体 ---------- */

// 1. 标准 app 导出格式（判断题带选项对）——FT-15-01 正常导入基线
write(
  'pack-good-standard.md',
  `学习本名称: 海洋知识标准包

分类: 测试

章节: 海洋基础

难度: 简单

标签: 测试

题型: 单选题,判断题

来源: 手动整理

版本: 1.0

简介: 标准格式基线包（判断题带选项对）。

格式版本: 1.0

<!-- title: 海洋知识标准包 -->
<!-- category: 测试 -->
<!-- difficulty: 简单 -->
<!-- types: 单选题,判断题 -->
<!-- source: 手动整理 -->
<!-- version: 1.0 -->
<!-- format-version: 1.0 -->
<!-- kp: ocean=海洋基础 -->

=== 第 1 题 ===
题型：单选题
题干：蓝鲸属于哪一类鲸？
选项：
A. 须鲸
B. 齿鲸
C. 海豚
D. 以上都不是
答案：[0]
解析：蓝鲸依靠鲸须板滤食，属于须鲸。
知识点：ocean
难度：1

=== 第 2 题 ===
题型：判断题
题干：珊瑚的白化现象是珊瑚虫死亡导致的。
选项：
A. 正确
B. 错误
答案：错误
解析：白化是珊瑚排出共生虫黄藻，珊瑚虫本身并未立即死亡。
知识点：ocean
难度：1

=== 第 3 题 ===
题型：判断题
题干：深海热泉生态系统的能量来源是化学合成。
选项：
A. 正确
B. 错误
答案：正确
解析：热泉细菌通过氧化硫化物固定能量，不依赖阳光。
知识点：ocean
难度：1
`,
)

// 2. 外部 AI 风格：判断题不带选项对（验证 6.83 自动补「正确/错误」，应 100% 导入）
write(
  'pack-external-judge.md',
  `学习本名称: 外部风格判断题包

分类: 测试

难度: 简单

题型: 判断题

来源: 手动整理

版本: 1.0

简介: 外部 AI 常见风格：判断题不带选项（应自动补「正确/错误」后 100% 导入）。

格式版本: 1.0

<!-- title: 外部风格判断题包 -->
<!-- category: 测试 -->
<!-- types: 判断题 -->

=== 第 1 题 ===
题型：判断题
题干：Python 变量名可以以下划线开头。
答案：正确
解析：如 _name、__private 均合法。
知识点：py
难度：1

=== 第 2 题 ===
题型：判断题
题干：Python 的列表是不可变类型。
答案：错误
解析：列表是可变类型，元组才是不可变类型。
知识点：py
难度：1
`,
)

console.log('\n全部生成完成 → testdata/')

// 4. XSS 题包：题干/解析/选项含脚本与事件属性（应转义显示不执行）——ST-12
write(
  'pack-xss.md',
  `学习本名称: XSS 渲染防御包

分类: 测试

难度: 简单

题型: 单选题,判断题

来源: 手动整理

版本: 1.0

简介: 题干/选项/解析含 script 与事件属性，验证按文本转义显示不执行。

格式版本: 1.0

<!-- title: XSS 渲染防御包 -->
<!-- category: 测试 -->

=== 第 1 题 ===
题型：单选题
题干：<script>alert('题干xss')</script> 以下哪种做法能防止海洋塑料污染？
选项：
A. 减少一次性塑料使用
B. <img src=x onerror="alert('选项xss')"> 全部排入深海
C. 无视
D. 增加倾倒
答案：[0]
解析：<img src=x onerror="alert('解析xss')"> 减塑是源头治理的关键。
难度：1

=== 第 2 题 ===
题型：判断题
题干：<svg onload="alert('判断xss')"> 微塑料已被发现存在于海洋生物体内。
选项：
A. 正确
B. 错误
答案：[0]
解析：微塑料已出现在浮游生物到顶级掠食者体内。
难度：1
`,
)

// 5. 代码题包：题干含多行 python 代码围栏（验证代码渲染）——FT-04-13
write(
  'pack-code.md',
  `学习本名称: Python 代码题包

分类: 编程

难度: 简单

题型: 单选题,简答题

来源: 手动整理

版本: 1.0

简介: 题干/解析含多行代码围栏，验证刷题页代码格式渲染。

格式版本: 1.0

<!-- title: Python 代码题包 -->
<!-- category: 编程 -->
<!-- types: 单选题,简答题 -->

=== 第 1 题 ===
题型：单选题
题干：阅读以下 Python 代码，程序的输出是什么？
\`\`\`python
def greet(name):
    return f"你好, {name}!"

print(greet("海洋"))
\`\`\`
选项：
A. 你好, 海洋!
B. greet("海洋")
C. 报错
D. None
答案：[0]
解析：f-string 将变量插入字符串，输出「你好, 海洋!」。
知识点：py
难度：1

=== 第 2 题 ===
题型：简答题
题干：简述下面代码的运行结果，并说明原因。
\`\`\`python
nums = [1, 2, 3]
nums.append([4, 5])
print(len(nums))
\`\`\`
答案：输出 4。append 将 [4, 5] 作为单个元素追加，列表长度为 4。
解析：列表 append 只追加一个元素；若想合并应使用 extend。
知识点：py
难度：2
`,
)

// 6. 特殊文件名标题（导出时验证 sanitizeFileName）——ST-08
write(
  'pack-weird-name.md',
  `学习本名称: 测试/库:CON*?"<>|特别长标题一二三四五六七八九十十一十二十三十四十五

分类: 测试

难度: 简单

题型: 判断题

来源: 手动整理

版本: 1.0

简介: 标题含路径非法字符、Windows 保留名与超长文本，验证导出文件名净化。

格式版本: 1.0

<!-- title: 测试/库:CON*?"<>|特别长标题一二三四五六七八九十十一十二十三十四十五 -->
<!-- category: 测试 -->

=== 第 1 题 ===
题型：判断题
题干：这是一本书名非常奇怪的测试库。
答案：正确
解析：用于导出文件名净化验证。
难度：1
`,
)

// 3a. 坏题包 md 版：第 2 题缺选项（sanitize 层跳过并进明细）；第 4/5 题（题型非法/缺答案）
//     在 md 解析层即被丢弃——验证 md 路径容错不崩溃，明细只含「缺少选项」一条
write(
  'pack-broken.md',
  `学习本名称: 坏题跳过验证包

分类: 测试

难度: 简单

题型: 单选题,判断题

来源: 手动整理

版本: 1.0

简介: 第 2 题缺选项应被跳过并在明细给出原因；其余正常入库。第 4/5 题在 md 解析层被丢弃（不进明细）。

格式版本: 1.0

<!-- title: 坏题跳过验证包 -->
<!-- category: 测试 -->

=== 第 1 题 ===
题型：单选题
题干：海洋中含盐量最高的区域一般是？（本题正常）
选项：
A. 副热带海区
B. 赤道海区
C. 极地海区
答案：[0]
解析：副热带蒸发量大、降水少，表层盐度最高。
难度：1

=== 第 2 题 ===
题型：单选题
题干：这是一道缺少选项的坏题（应被跳过并在明细中给出原因）。
答案：[0]
解析：缺少选项。
难度：1

=== 第 3 题 ===
题型：判断题
题干：海洋占地球表面积约 71%。（本题正常）
答案：正确
解析：海洋覆盖地球表面约七成。
难度：1

=== 第 4 题 ===
题型：问答题
题干：这是一道题型非法的坏题（md 解析层直接丢弃）。
答案：略
解析：题型非法。
难度：1

=== 第 5 题 ===
题型：简答题
题干：这是一道缺少答案的坏题（md 解析层直接丢弃）。
解析：缺少答案。
难度：1

=== 第 6 题 ===
题型：单选题
题干：世界最大的珊瑚礁系统是？（本题正常）
选项：
A. 大堡礁
B. 加勒比礁群
C. 红海礁群
答案：[0]
解析：大堡礁绵延约两千三百公里。
难度：1
`,
)

// 3b. 坏题包 json 版（app 外 AI 生成 json 题包的场景）：三种跳过原因齐全
//     （缺选项 / 题型非法 / 答案缺失）——json 路径不经 md 解析层，sanitize 明细完整
const brokenJson = {
  version: 2,
  type: 'pack',
  pack: {
    id: 'p-broken-json',
    title: '坏题跳过验证包(JSON)',
    category: '测试',
    source: 'import',
    meta: { difficulty: '简单', types: ['单选题', '判断题'], source: '手动整理', version: '1.0', formatVersion: '1.0' },
    chapters: [],
    created_at: 1,
    questions: [
      { id: 'q1', type: 'single', stem: '海洋中含盐量最高的区域一般是？（本题正常）', options: ['副热带海区', '赤道海区', '极地海区'], answer: '[0]', explanation: '副热带蒸发量大、降水少。', kp_ids: [], difficulty: 1 },
      { id: 'q2', type: 'single', stem: '这是一道缺少选项的坏题。', options: [], answer: '[0]', explanation: '缺少选项。', kp_ids: [], difficulty: 1 },
      { id: 'q3', type: 'judge', stem: '海洋占地球表面积约 71%。（本题正常）', options: ['正确', '错误'], answer: 'true', explanation: '海洋覆盖约七成。', kp_ids: [], difficulty: 1 },
      { id: 'q4', type: '问答', stem: '这是一道题型非法的坏题。', answer: '略', explanation: '题型非法。', kp_ids: [], difficulty: 1 },
      { id: 'q5', type: 'short', stem: '这是一道缺少答案的坏题。', explanation: '缺少答案。', kp_ids: [], difficulty: 1 },
      { id: 'q6', type: 'single', stem: '世界最大的珊瑚礁系统是？（本题正常）', options: ['大堡礁', '加勒比礁群', '红海礁群'], answer: '[0]', explanation: '大堡礁。', kp_ids: [], difficulty: 1 },
    ],
  },
  exportedAt: 1,
}
write('pack-broken.json', JSON.stringify(brokenJson, null, 2))

console.log('\n全部生成完成 → testdata/')
