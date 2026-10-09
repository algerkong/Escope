# Q09 第三批：有界查询期字段

日期：2026-10-10。接手基线 `80dae58`，工作区干净，沿用 `main`。
状态：开发、临时 SQLite、mock 和 JSDOM 自动化通过；真实 ES/runtime 编译/权限/成本、
原生编辑/剪贴板/重启与跨平台待验。主代理独占，无 OMP、新依赖、schema 迁移、
worktree、原型修改或额外持久服务。前批见 [字段格式 QA](data-view-field-formats-qa.md)。

## 交付范围

| 范围 | 实际实现 | 边界 |
| --- | --- | --- |
| 定义 | 原 Data Views 管理器内增删/编辑，七类型、同名 source 或内联 Painless | 32 项/64 KiB；每字段名 1,024 字节、源码 4 KiB |
| 审核 | 遮蔽/类型变化/冲突/未检查证据；返回字段选项、当前与最终 DSL、显式应用 | 不覆盖不同手写定义；草稿/目标改变或 CAS 拒绝后关闭重审，应用不执行 |
| 查询 | 首屏/PIT 后端独立白名单；前端 DSL 合同 v3，固定查询路径与原传输认证 | 不开放 Mapping、脚本管理或 URL/认证代理；编译和实际权限只由 ES 决定 |
| 结果 | 按执行 DSL 的 runtime 名称读取 `fields` 原值，显示来源 tooltip，保留原格式能力 | 未应用配置不改结果；缺失不填旧 `_source`，不展开嵌套结构/多值或执行前端脚本 |
| 副本 | 选择、执行、历史、查询库与工作区深拷贝/严格恢复 | schema v7、文档 v1 不变；不查当前库回填，不重绑连接，恢复不执行 |
| 导出 | 已加载 CSV 使用列原值，JSONL/JSON/文档保持原文本 | 全量 runtime 导出仍拒绝；查询交换排除视图配置，但已应用 DSL/脚本文字按原规则交换 |

UI 沿用紧凑工具界面、Lucide、双语、语义 token、代码字体偏好与可见焦点。
本次不增加页面、外部资源、脚本语言引擎或自动查询流程。

## 本地定义与合同

可选定义示例只含测试字面量：

```json
{
  "runtimeFields": {
    "version": 1,
    "entries": [
      {
        "field": "sequence",
        "type": "long",
        "script": {
          "lang": "painless",
          "source": "emit(9007199254740993L);"
        }
      },
      { "field": "label", "type": "keyword" }
    ]
  }
}
```

- 类型仅 `keyword`、`long`、`double`、`boolean`、`date`、`ip`、`geo_point`。
  `date_nanos`、`lookup`、`composite`、自定义日期格式及其他映射选项不在本批合同内。
- `script` 缺省表示从同名 `_source` 取值；存在时只接受 `source` 与可选 `lang: "painless"`。
  不支持存储脚本 ID、参数、options 或 `on_script_error: continue`；不静默吞掉脚本错误。
- 字段名唯一且精确匹配，拒绝空/首尾空白/控制字符、`$param` 保留字、下划线开头及 `*`/`?`。
  点号保留字段名语义，不意味着展开结果中的嵌套对象。
- 源码保留原文，允许换行/回车/制表符，拒绝空白源码、其他控制字符与超限。
  集合大小按 JSON 序列化后的 UTF-8 字节计算，转义膨胀计入限额。
- TS 与 Rust 同时检查嵌套结构、版本、数量、大小、类型及可选字段；
  显式 `null`、未知键、重复字段与重复/转义重复 JSON 键拒绝。损坏库不修补后覆盖。
- `runtime_mappings` 在手写 DSL 中也必须遵守同一有界合同，不能通过 IPC 绕过。
  旧草稿原文仍可保存/恢复；超出本批支持范围时阻止执行，不静默删减。
  普通查询的其他 DSL 语义仍由 ES 判断，不扩展任意写入通道。

SQLite schema v7、视图库/查询库/恢复文档 v1 保持不变，不修改用户数据库。
旧版不认识可选字段时应拒绝文档，不手工删字段或降版本强行打开。

## 预览与执行

合并使用已有 `jsonc-parser` AST 的位置编辑，原数值、指数、转义字符串和手写值不经过
`Number` 或对象重序列化。最终格式化仅修改空白，源草稿在显式应用前不变。

已有同名 runtime 声明只有类型与源码一致时作为已存在保留；
缺省语言与显式 Painless 等价。类型/源码不同则拒绝并显示字段名，没有隐式覆盖开关。
其他手写 runtime 定义保留，合并后的总量仍受 32 项/64 KiB 与 256 KiB 草稿限制。
重复键、无效 JSON、未替换参数及超限拒绝，不从不完整文本猜测查询。

返回值选项默认选中，只向 `fields` 数组添加缺少的精确名称；
已有字符串项/对象项（含格式）保持原文。非数组 `fields` 不改写，关闭该选项可保留其原文。
选项变化使最终预览失效。默认时间字段和时间范围均不在此处注入。

字段发现是打开审核时的证据副本，不做自动网络请求，也不是权限证明。
未检查、返回目录未见、同型遮蔽、异型遮蔽与多类型冲突分别显示；
未检查或已有同名字段时需勾选本次遮蔽确认。目录未返回不证明真实目标不存在该字段。
编译错误、昂贵查询被禁用或权限失败不会触发删脚本/降级/重试为无 runtime 的查询。

执行只发送审核后显式应用的 `rawDsl`，不发送 `dataView`/`runtimeFields` 本地元数据。
所选定义副本可能尚未应用，**生效语义始终以执行 DSL 为准**；不在 run 或续页时合并当前库。
副本中的脚本对象/条目/数组/定义均独立冻结，续页和历史恢复保留旧副本。
删除/修改库、设置往返、语言变化和恢复不执行，不改变既有结果/PIT。

## 结果与稳定性

只对执行 DSL 中实际声明的 runtime 名称读取服务器 `fields`，包括手写的受支持声明；
其他列继续原 `_source` 优先规则。runtime 未返回时不伪装成同名 `_source` 的旧值。
字段数组、日期字符串、地理值和高精度数值保持原始文本，原有有界字段格式可用于显示。
不把单元素数组转换成标量，继续已有数组/嵌套列与本地排序边界。

表格 tooltip 标明来自 `fields`。JSON/文档详情仍分别展示完整 `_source` 和 `fields`；
“复制文档”继续原 source 优先规则，“复制响应”与 JSONL 保留完整响应/hit。
CSV 使用实际列原值，字段格式不污染复制/导出，不额外执行查询。

**PIT 冻结索引读取上下文，不冻结脚本输出、随机性或计算成本。**
本批不分析任意 Painless 的确定性或资源成本，不把字节限额当执行配额。
网络超时/取消及部分分片继续既有协议，取消不伪装服务器已完成。
全量导出继续拒绝所有 `runtime_mappings` 与脚本，包括无脚本的 runtime 定义，
不放宽稳定性合同。已加载导出无需再次计算，继续可用。

查询库本地交换排除视图 ID/绑定、默认时间字段、字段格式和 runtime 本地配置。
已显式应用的 runtime DSL 属于查询定义，脚本文字会随其交换；字面量仍须审核，
不自动附带连接端点、凭据引用、认证或结果。参数化查询仍按原规则只交换参数模板。

## 自动化证据

前端均 `--maxWorkers=2`，没有提高超时；Rust 使用临时 DB/文件和 fixtures。

| 检查 | 本批结果 |
| --- | --- |
| 首轮领域/查询解析 | 94 项中 92 通过；测试 CSV helper 名称及未来开始时间导致的完成时间拒绝已修正 |
| 首轮组件/接线 | 6 文件 95 项中 94 通过；`toHaveValue` 不支持该非对称断言，改为读取 textarea 值后断言 |
| 跨模块 Vitest | **27 文件 632 项通过**；覆盖 runtime、视图、结果/格式、执行/PIT、恢复、查询库、参数/交换及导出拒绝 |
| Rust 首轮 | **65 项通过**：runtime、视图、恢复与查询 |
| Rust 跨模块 | **123 项通过**：runtime 6、视图 17、恢复 21、查询 21、查询库 10、交换 11、导出 26、操作白名单 11 |
| 复审定向 | `$param` 保留名与复选框样式补强后，前端 **2 文件 46 项**、Rust **6 项**通过；与前述重复，不相加 |
| ESLint | **24 个变动 TS/TSX/测试文件通过** |
| TypeScript / 正式构建 | `npm run build` 通过；最初测试 helper 导入和只读属性赋值的类型错误已修正，未放松类型 |
| Rust 格式 / clippy | fmt 检查与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过 |
| 文档与 diff | 8 份 Markdown、128 个本地链接、40 张表格、41 个变动文件 UTF-8/LF 与 `git diff --check` 通过 |

复审另保留深层解析失败拒绝、复制时的脚本属性顺序归一化与前端 DSL 合同 v3；
复选框移除局部自动宽度，增加属性选择器避免表单 padding 覆盖统一控件尺寸，已补样式合同断言。
JS 单包约 **1,090.12 kB** 的既有类构建警告保留，没有调整警告阈值或顺带拆包。
本次不是全量 Rust/全目标 clippy，不重跑原型或历史旧基线。

核心新增测试为 `runtime-fields.test.ts`、`runtime-fields-ui.test.tsx`、
`src-tauri/src/runtime_fields/tests.rs`；共享 fixture 为
`tests/fixtures/data-view-runtime-fields-v1.json`。
应用级用例在 `app-data-views.test.tsx`，存储/续页/错误/恢复用例扩展已有文件。

Rust 跨模块命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib -- runtime_fields::tests data_views::tests workspace_recovery::tests saved_queries::tests query::tests query_exchange::tests query_export::tests operation::tests --test-threads=2
```

## 协议依据

2026-10-10 实际读取的 Elastic 官方文档，仅用于合同依据，不作为本机已支持或授权证明：

- [查询中的 runtime_mappings](https://www.elastic.co/docs/manage-data/data-store/mapping/define-runtime-fields-in-search-request)：
  定义仅属于本次查询，同名 runtime 可遮蔽已映射字段；本文不执行文档中的 Mapping 写入示例。
- [runtime 类型、无脚本取值与脚本错误](https://www.elastic.co/docs/manage-data/data-store/mapping/map-runtime-field)：
  官方支持面大于本批白名单；无脚本从同名 source 读取，忽略错误选项本批不开放。

## 剩余与接续

- [集中人工清单](manual-acceptance.md) 保留原生 Tab/Esc/IME、32 行/长脚本/窄窗口/200%/双语/
  字体与焦点、系统剪贴板、重启/升级/退出期间保存。本次没有浏览器/WebView 或原生巡检。
- 真实 ES 版本/部署、FLS/多索引/别名/数据流、类型/遮蔽、Painless 编译/字段依赖/成本、
  403/昂贵查询禁用/部分/取消须在当次授权环境验证；没有访问真实 ES/模型/用户数据库或密钥库。
- 任意脚本参数/存储脚本、lookup/composite、Mapping 写入、runtime 全量导出和任意类型格式
  不在本批支持范围，不能用能力/许可报告或 mock 推断其可用。
- 下一批 Q02 有界相对/绝对时间与时区：先定义、最终 DSL 预览/显式应用、执行时间冻结与恢复；
  runtime 日期须核对已应用 DSL，而不是把未应用本地定义或目录证据当作可执行时间字段。
  Q09/F07/Q01/Q05 及六方向父任务保持开放。
- 本批交接后本地提交、不推送；全部命令退出后创建一个 local 后继、更新既有接续监控，
  当前会话停止写仓库，不新增监控或 worktree，不提前睡眠。
