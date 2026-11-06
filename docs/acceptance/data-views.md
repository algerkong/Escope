# Data Views 验收记录

## 共同说明

- 三批均为 2026-10-10，主代理独占，沿用 `main`、基线工作区干净；无新依赖、worktree、原型修改或额外持久服务。
- 证据来自临时 SQLite（临时目录 DB/文件）、显式内存适配、mock IPC、协议 fixture 与 JSDOM 组件测试；Vitest `--maxWorkers=2`，未提高超时；
  Rust 为定向测试（非全量/全目标 clippy），未重跑原型与历史旧基线。下文 `cargo` 命令均带 `--manifest-path src-tauri/Cargo.toml`，前端测试文件位于 `tests/unit`。
- 共同未验（批次内只列特有项）：真实 ES 多索引/别名/数据流、`_field_caps` 权限与类型变化（目录为空不代表目标不存在）；
  浏览器/WebView/原生交互（窄窗口、200%、大字号、长名称/中英文、下拉与 datalist、键盘/焦点）；桌面重启、升级、退出期间保存；
  安装包、系统密钥库、跨平台。人工项见 [集中人工验收](../manual-acceptance.md) 的 Q09。Q09/F07/Q01/Q05 及六方向父任务保持开放。
- 共同边界：不兼容 Kibana Data Views/Saved Objects，不同步服务器配置；Mapping 写入归 W04 并经 W01 审核，不能由视图配置绕过。
  恢复/切换/修改视图均不执行、不重绑已删连接、不从当前库回填旧快照；结果正文、PIT、页码、行选择、认证不持久化；
  桌面 SQLite 失败不降级内存；未知完成/CAS 冲突不强制重试，损坏存储不修补覆盖。
  旧版程序不认识新增字段时应拒绝文档，禁止手改 `user_version`/删字段强行降级；需旧版时用已备份的兼容数据。

| 批次 | schema | 文档 | 新增限额 |
| --- | --- | --- | --- |
| 第一批 | v6 → **v7** | 视图库 v1、`dataView` 副本 v1 | 100 项 / 256 KiB |
| 第二批 | v7 不变 | `fieldFormats` v1 | 每视图 32 项 / 16 KiB |
| 第三批 | v7 不变 | `runtimeFields` v1、前端 DSL 合同 v3 | 32 项 / 64 KiB，源码 4 KiB |

## 2026-10-10 Q09 第一批 本地 Data Views

基线 `1dc9f7d`。

| 范围 | 实现 | 不包含或不能推断 |
| --- | --- | --- |
| 本地视图库 | 新建、编辑、筛选、删除确认；名称、稳定连接 ID、索引/别名/数据流/多目标模式、可选默认时间字段 | 管理器保存只写本地元信息，不调用 Mapping 或任何 ES 写入 API |
| 草稿选择 | 查询标签内选择同连接视图；管理入口可为其他有效连接新建查询；手改目标解除关联 | 不改绑已有标签连接，不改 DSL、不执行、不打开 PIT |
| 副本隔离 | 所选定义复制入草稿；库修改/删除后旧副本与结果保留并提示，重新选择才应用 | 索引标签不携带或应用视图 |
| 默认时间字段 | 复用显式 `_field_caps`；未检查、缺失、类型冲突、非日期、不可搜索与可用分开 | 只保存字段，不生成时间范围；未检查不等于可用或有权限；不门控原始 DSL |
| 恢复与交换 | 可选 `dataView` v1 副本随工作区/命名查询文档 v1 保存 | 查询交换不导出视图 ID、绑定或时间字段配置 |

入口沿用紧凑工具栏、原生主题下拉与局部对话框（Lucide、双语、主题 token、可见焦点），无新管理首页。
时间字段仅接受单一、可搜索的 `date` 或 `date_nanos`；多类型（含 date/date_nanos 混合）为冲突；`non_searchable_indices` 非空不标全目标可搜索。
刷新中/失败不把旧目录当本次验证；无权限或浏览器无字段读取时可保存“未验证”定义，已知无效字段须清除或改正。
字段建议一次线性筛选；未做大字段量性能基准。

本地合同：

- `data_view_library` 单行表；迁移与版本号同一事务，失败保留 v6，重开不重复建表，不插入演示视图。
- 视图库文档 v1 `{ version, entries }`，每项仅 `id`、`name`、`connectionId`、`index`、`defaultTimeField`；最多 100 项、序列化 UTF-8 **256 KiB**；
  ID 1–64 ASCII 字符，名称 ≤120 字符，目标/时间字段各 ≤1,024 字节。
- 目标复用 `IndexTarget`：最多 64 个逗号分隔目标、每项 ≤255 字节，支持 `*`；拒绝路径、URL、查询片段、排除表达式、远程集群冒号语法。
- `data_views_load` 返回 `{ revision, library }`，仅从未保存时为修订 0/空库；`data_views_save` 只收 `expectedRevision` 与完整库，返回新修订。
  修订限 JS 安全整数，持久行从 1 起，写满上界拒绝。
- 保存用 SQLite immediate 事务：校验现存文档 → CAS → 既有 ID 连接归属 → 写入。新视图须绑定仍存在的连接 ID；连接删除后已有视图保留原归属、可删除，
  不因同名新连接或当前选择重绑；前端也核对编辑/删除时读到的完整条目。
- 未知版本、重复键/ID、额外字段、超限、损坏持久行整体拒绝；无端点、认证、凭据引用、结果、PIT 或传输字段。
- 前端写入串行化，提交后才更新列表；旧代次完成不回填；重载等待已派发写并跳过旧排队意图；失败时保留编辑内容，
  仅“放弃编辑并重新加载”退出并重读。浏览器为 session 内存适配，刷新清除。
- 草稿副本 `{ version: 1, definition }`：连接 ID 与目标须与草稿一致、不可 `null`、不能出现在索引标签；旧无副本记录可读；
  执行历史仍记录实际连接/目标/DSL，不回查后来变动的库。

| 检查 | 结果 |
| --- | --- |
| 领域/IPC 首轮 | 2 文件 40 项 |
| 组件/集成首轮 | 16/20；4 个测试误把 session 恢复提示当桌面保存提示，修正测试适配 |
| 流程复跑 | 59/60；无 sort 的普通 DSL 不开 PIT，修正错误预期，未改执行行为 |
| 最终跨模块 Vitest | **19 文件 297 项**（本批 5 文件 64 项） |
| Rust 定向 | **125 项**：Data Views 10、storage 44、恢复 19、查询库 10、交换 11、query 20、operation 11 |
| ESLint / `npm run build` | 通过（清理回调改为稳定 callback 后过 hook lint）；JS 约 **1,059.13 kB** |
| `cargo fmt -- --check`、`cargo clippy --lib -- -D warnings` | 通过 |
| 文档 | 7 份 Markdown、110 个本地链接、36 张表格；39 个变动文件 LF 与 `git diff --check` |

- Rust：`cargo test --lib -- data_views::tests storage::tests workspace_recovery::tests saved_queries::tests query_exchange::tests query::tests operation::tests`
- 前端：`npm test -- --maxWorkers=2` + data-views、data-views-service、data-views-hook、data-views-ui、app-data-views、domain、workspace-tabs、
  workspace-recovery、workspace-recovery-hook、app-workspace-recovery、query-library、app-library-integration、query-exchange、query-exchange-service、
  query-parameters-ui、app-index-tabs、resource、visual-query、query-editor；共享 fixture `tests/fixtures/data-views-v1.json`。

特有未验：隔离备份上的真实升级失败。

## 2026-10-10 Q09 第二批 字段格式与执行副本

基线 `49e334a`。

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 本地格式 | 视图管理器内增删改；数字分组、百分比、IEC 字节、UTC 日期 | 32 项/16 KiB；不接受 JS、HTML、URL、任意模板或小数舍入选项 |
| 类型证据 | 复用显式字段发现，未验证/缺失/冲突/非数值/非日期/兼容分开 | 不门控 DSL、不隐式请求字段 |
| 表格显示 | 字段列精确格式化、原值 tooltip 与开关、有界标量数组 | 不展开嵌套列/对象，不转换字符串数字；无效/混合/超限保留原值 |
| 执行副本 | 执行前深冻结 Data View 定义及每个格式对象，续页沿用 | 库/草稿变更、删除、语言/设置往返不改旧结果或请求 |
| 历史与恢复 | 工作区、查询库、查询/续页历史保留定义副本；历史恢复为新草稿 | 恢复不读当前库 |
| 原始数据 | 本地排序按原值；复制原值；JSON/文档/CSV/JSONL 不变 | 搜索/PIT 与全量导出 DSL 不带格式；查询交换排除整个视图配置 |

原值开关仅属当前结果显示，新执行重新启用冻结配置，不存工作区；列宽/顺序/显隐/排序/行选择规则不变。

数值与日期：

- 数字按原始十进制 token 分解符号/数字/指数；分组用 `Intl` BigInt 输入，不转浮点；百分比精确移动两位小数点。
- IEC 字节 `B`–`EiB` 按绝对值选单位，除以 `1024^n` 用 `5^(10n)` 与十进制指数精确变换、不舍入，负值保留符号；例 `1537` → `1.5009765625 KiB`。
- 日期须显式选来源。ISO 只接受含 `Z` 或明确偏移的完整时间戳，验证真实日历/时分秒/偏移，保留 1–9 位小数；无时区、非法日期、闰秒、
  `-00:00`、更多小数位保留原值，不猜本地时区。Unix 毫秒只接受整数 token，先用 BigInt 校验 Date 范围；字符串数字、指数、非整数、超范围回退。
- 数值输入 ≤1,024 字符，展开十进制部分 ≤2,048 字符，超大指数在分配前拒绝，无科学计数法浮点回退。
- 标量数组 ≤32 项，JSON 输入 ≤16,384 UTF-16 码元，显示输出 ≤4,096 字符；用严格 JSON 解析器与原文切片，格式化项带引号维持边界，`null` 保留；
  混合类型、嵌套、超限整列回退；格式化数组不作新原始数据。
- 按结果列精确名称匹配，点号不自动展开 `_source`；`fields` 顶级标量数组可显示，`_source`/`fields` 优先级不变。

保存合同：定义增加可选字段，无迁移：

```json
{
  "fieldFormats": {
    "version": 1,
    "entries": [
      { "field": "sequence", "format": { "kind": "number", "grouping": true } },
      { "field": "ratio", "format": { "kind": "percent", "grouping": false } },
      { "field": "size", "format": { "kind": "bytes", "grouping": true } },
      { "field": "@timestamp", "format": { "kind": "date", "input": "iso" } }
    ]
  }
}
```

数字类仅 `kind` + 布尔 `grouping`，日期仅 `kind` + `iso`/`epoch_millis`；选项必填。字段名唯一、无控制字符/首尾空白、≤1,024 UTF-8 字节；
集合序列化 ≤16 KiB，整库仍 100 项/256 KiB。`null`、未知版本、重复字段/JSON 键、额外选项、超限整体拒绝。
`ExecutionSnapshot` 与持久历史可含 `dataView` v1 完整副本（校验连接 ID/目标一致）；索引执行/标签不能携带；历史只投影允许字段；
查询/PIT IPC 显式投影原合同字段。本地查询交换排除视图 ID、连接绑定、默认时间字段与格式。
复制：原生选区无可逆局部原值映射，触及格式化单元格时复制所选完整单元格原值（多列/行用制表符/换行），格式化数组复制原数组文本；
未触及时保留原生复制；JSON/文档复制始终原文；CSV 公式防护、已加载导出不额外查询、PIT 全量导出边界不变。

| 检查 | 结果 |
| --- | --- |
| 首轮领域 | 95 中 94；测试误以为所有单位同一指数都超限，改按变换后展开长度验证 |
| 组件/执行首轮 | 6 文件 **133 项** |
| 最终跨模块 Vitest | **21 文件 394 项** |
| Rust 首轮 | 45 中 44；新恢复 fixture 的 `orders` 副本与 `orders-*` 草稿不符被正确拒绝，修正 fixture |
| Rust 最终定向 | **76 项**：视图 15、恢复 20、查询库 10、查询 20、交换 11 |
| ESLint / `npm run build` | 17 个变动文件通过；首轮仅测试辅助函数与 `getByRole` 选项类型标注修正；JS 约 **1,073.54 kB** |
| fmt / `cargo clippy --lib -- -D warnings` | 通过 |
| 文档 | 8 份 Markdown、121 个本地链接、39 张表格；32 个变动文件 UTF-8/LF、`git diff --check` |

复审补强：数组末尾为 `null` 也逐项检查输出限额，防止接近上限时绕过（含在 394 项内）。

- Rust：`cargo test --lib -- data_views::tests workspace_recovery::tests saved_queries::tests query::tests query_exchange::tests --test-threads=2`
- 前端：field-formats、field-formats-grid、data-views、data-views-service、data-views-hook、data-views-ui、app-data-views、query-executions、
  result-grid、result-grid-ui、query-result、query-library、query-library-ui、query-exchange、query-exchange-service、workspace-recovery、
  workspace-recovery-hook、app-workspace-recovery、query-live、domain、workspace-tabs；共享 fixture `tests/fixtures/data-view-field-formats-v1.json`。

特有未验：原生 Ctrl/Cmd+C 与系统剪贴板（DOM 剪贴板测试不代表）、32 行配置；真实数字/日期返回。不承诺任意数字模板或自动展开嵌套列。

## 2026-10-10 Q09 第三批 有界查询期 runtime fields

基线 `80dae58`。

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 定义 | 视图管理器内增删改，七类型，同名 source 或内联 Painless | 32 项/64 KiB；字段名 ≤1,024 字节、源码 ≤4 KiB |
| 审核 | 遮蔽/类型变化/冲突/未检查证据；返回字段选项、当前与最终 DSL、显式应用 | 不覆盖不同手写定义；草稿/目标改变或 CAS 拒绝后关闭重审；应用不执行 |
| 查询 | 首屏/PIT 后端独立白名单；前端 DSL 合同 v3，固定查询路径与原传输认证 | 不开放 Mapping、脚本管理或 URL/认证代理；编译与权限由 ES 决定 |
| 结果 | 按执行 DSL 的 runtime 名称读取 `fields` 原值，tooltip 标来源，可用字段格式 | 未应用配置不改结果；缺失不填旧 `_source`；不展开嵌套/多值，不执行前端脚本 |
| 副本 | 选择、执行、历史、查询库、工作区深拷贝/严格恢复 | — |
| 导出 | 已加载 CSV 用列原值，JSONL/JSON/文档原文 | 全量 runtime 导出拒绝；查询交换排除视图配置，已应用 DSL/脚本文字按原规则交换 |

不增加页面、外部资源、脚本引擎或自动查询流程。

合同（示例仅测试字面量）：

```json
{
  "runtimeFields": {
    "version": 1,
    "entries": [
      {
        "field": "sequence",
        "type": "long",
        "script": { "lang": "painless", "source": "emit(9007199254740993L);" }
      },
      { "field": "label", "type": "keyword" }
    ]
  }
}
```

- 类型仅 `keyword`、`long`、`double`、`boolean`、`date`、`ip`、`geo_point`；不含 `date_nanos`、`lookup`、`composite`、自定义日期格式及其他映射选项。
- 缺省 `script` 从同名 `_source` 取值；`script` 只接受 `source` 与可选 `lang: "painless"`；不支持存储脚本 ID、参数、options、`on_script_error: continue`。
- 字段名唯一精确匹配，拒绝空/首尾空白/控制字符、`$param` 保留字、下划线开头及 `*`/`?`；点号不表示展开嵌套对象。
- 源码保留原文，允许换行/回车/制表符，拒绝空白源码、其他控制字符、超限；集合按 JSON 序列化 UTF-8 字节计（含转义膨胀）。
- TS 与 Rust 同时检查结构/版本/数量/大小/类型/可选字段；显式 `null`、未知键、重复字段、重复/转义重复 JSON 键拒绝。
- 手写 DSL 中的 `runtime_mappings` 也受同一合同，不能经 IPC 绕过；旧草稿原文可保存/恢复，超范围时阻止执行，不静默删减。

预览与执行：

- 合并用 `jsonc-parser` AST 位置编辑，数值/指数/转义字符串/手写值不经 `Number` 或重序列化；最终格式化只改空白，显式应用前源草稿不变。
- 同名声明类型与源码一致才视为已存在（缺省语言等价于 Painless），否则拒绝并显示字段名，无隐式覆盖；其他手写定义保留，合并总量受 32 项/64 KiB 与 256 KiB 草稿限制。
  重复键、无效 JSON、未替换参数、超限拒绝。
- 返回值选项默认选中，仅向 `fields` 数组补缺失精确名称，已有字符串/对象项（含格式）原样；非数组 `fields` 不改写；选项变化使预览失效。不注入默认时间字段或时间范围。
- 字段发现是打开审核时的证据副本，不自动请求、非权限证明；未检查/目录未见/同型遮蔽/异型遮蔽/多类型冲突分别显示，未检查或同名时须勾选遮蔽确认。
- 编译错误、昂贵查询禁用或权限失败不触发删脚本/降级/重试。
- 执行只发送显式应用的 `rawDsl`，不发 `dataView`/`runtimeFields` 元数据；**生效语义始终以执行 DSL 为准**，run/续页不合并当前库；副本脚本对象独立冻结。

结果与稳定性：仅对执行 DSL 实际声明（含手写受支持声明）的 runtime 名称读取 `fields`，其他列沿用 `_source` 优先；未返回不伪装为同名 `_source` 旧值；
数组、日期串、地理值、高精度数值保持原文，不把单元素数组转标量。JSON/文档详情分别展示 `_source` 与 `fields`；“复制文档”source 优先，
“复制响应”与 JSONL 保留完整响应/hit；CSV 用列原值。**PIT 冻结索引读取上下文，不冻结脚本输出、随机性或计算成本**；
不分析 Painless 确定性或成本，字节限额不是执行配额；超时/取消/部分分片沿用既有协议。全量导出拒绝所有 `runtime_mappings` 与脚本（含无脚本定义）。
查询库交换排除视图 ID/绑定、默认时间字段、字段格式与 runtime 本地配置；已应用 runtime DSL 属查询定义，脚本文字随之交换且须审核，不附带端点/凭据/认证/结果；参数化查询仅交换参数模板。

| 检查 | 结果 |
| --- | --- |
| 首轮领域/查询解析 | 94 中 92；测试 CSV helper 名称与未来开始时间导致的完成时间拒绝已修正 |
| 首轮组件/接线 | 6 文件 95 中 94；`toHaveValue` 不支持该非对称断言，改读 textarea 值 |
| 跨模块 Vitest | **27 文件 632 项** |
| Rust 首轮 | **65 项**（runtime、视图、恢复、查询） |
| Rust 跨模块 | **123 项**：runtime 6、视图 17、恢复 21、查询 21、查询库 10、交换 11、导出 26、操作白名单 11 |
| 复审定向 | `$param` 保留名与复选框样式补强后，前端 **2 文件 46 项**、Rust **6 项**（与上重复，不相加） |
| ESLint / `npm run build` | **24 个变动文件**通过；测试 helper 导入与只读属性赋值类型错误已修正；JS 约 **1,090.12 kB** |
| fmt / `cargo clippy --lib -- -D warnings` | 通过 |
| 文档 | 8 份 Markdown、128 个本地链接、40 张表格；41 个变动文件 UTF-8/LF、`git diff --check` |

复审另保留深层解析失败拒绝、复制时脚本属性顺序归一化、DSL 合同 v3；复选框移除局部自动宽度并加属性选择器避免表单 padding 覆盖控件尺寸，已补样式合同断言。
核心新增测试 `runtime-fields.test.ts`、`runtime-fields-ui.test.tsx`、`src-tauri/src/runtime_fields/tests.rs`；应用级用例在 `app-data-views.test.tsx`；
共享 fixture `tests/fixtures/data-view-runtime-fields-v1.json`。
Rust：`cargo test --lib -- runtime_fields::tests data_views::tests workspace_recovery::tests saved_queries::tests query::tests query_exchange::tests query_export::tests operation::tests --test-threads=2`

依据（2026-10-10 读取，仅作合同依据）：
[查询中的 runtime_mappings](https://www.elastic.co/docs/manage-data/data-store/mapping/define-runtime-fields-in-search-request)（仅属本次查询，同名可遮蔽已映射字段；不执行文档中的 Mapping 写入示例）；
[runtime 类型、无脚本取值与脚本错误](https://www.elastic.co/docs/manage-data/data-store/mapping/map-runtime-field)（官方支持面大于本批白名单，忽略错误选项不开放）。

特有未验：原生 Tab/Esc/IME、长脚本、代码字体、系统剪贴板；真实 ES 版本/部署、FLS、类型/遮蔽、Painless 编译/字段依赖/成本、403/昂贵查询禁用/部分/取消。
脚本参数/存储脚本、lookup/composite、Mapping 写入、runtime 全量导出、任意类型格式不在支持范围，不能用能力/许可报告或 mock 推断可用。
后续 Q02 时间：runtime 日期须核对已应用 DSL，不能把未应用本地定义或目录证据当可执行时间字段。
