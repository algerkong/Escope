# 查询编辑器、参数、时间范围与排序 验收记录

## 共同说明

- 状态口径：各批均为开发/JSDOM/临时 SQLite 与文件/构建自动化通过；真实 ES、原生 WebView2/macOS/Linux 交互（IME、焦点、缩放/200%/窄窗口、高对比、屏幕阅读器、重启/退出）、跨平台、安装包与性能均**未验**，统一列入 [集中人工清单](../manual-acceptance.md)。JSDOM（含真实 Monaco 模型）中的字体测量/绘制为替身，不冒充原生或像素证据；无本批截图或原生通过声明，不复用历史截图。
- 测试约定：前端命令均 `--maxWorkers=2`，未提高超时、未删除安全断言；Rust 只用 fixtures/临时数据库/临时文件，不访问用户数据库、真实 ES/模型或系统密钥库。多轮复验数字有重叠，不相加。各批未推送，未声明 CI 通过；未改原型。
- Elastic 官方文档仅作语义依据，不作为本机/版本支持证明。
- Q02/Q03/Q07/F07/Q01/Q04、W01/W04 与六方向父任务在这些批次后仍开放。

## 2026-10-09 Q07 参数与本地查询定义交换

基线 `main` / `155b4fd`。无依赖新增、schema 迁移。

| 子项 | 交付 | 限制 |
| --- | --- | --- |
| 参数定义 | 可选 v1 模板、名称/类型列表；字符串/数值/布尔/空值/对象/数组 | 32 参数；未完成模板可保存，不能预览/交换 |
| 精确应用 | `{"$param":"name"}` 整值节点替换，最终 DSL 预览、当前草稿可检查，显式应用 | 不插值键名/字符串片段/目标；草稿变化拒绝旧预览，应用不执行 |
| 精度与资源 | jsonc-parser 节点偏移和原 token；结构/重复键/类型/未知参数/嵌套占位拒绝 | 模板/最终 DSL 256 KiB、单值 64 KiB、1,000 占位、深度 64/节点 200,000 |
| 恢复 | 查询库/工作区文档 v1 的可选参数子对象，SQLite schema v6 不变 | 只恢复定义；不独立持久化输入值/预览；已应用 DSL 按原草稿/历史规则保存 |
| 交换格式 | `escope-query-definitions` v1，选择查询、审核 JSON、本地读写 | 100 定义/4 MiB；参数化条目导出模板，不导出已应用参数值 |
| 目标映射 | 来源临时 key + 显示标签，本地稳定 ID + 端点或明确未绑定 | 不按名称、当前连接或来源 ID 重绑；写事务内再次核对 |
| 导入存储 | 新 UUID、全量原子追加，同名查询不覆盖；不打开标签或执行 | 普通保存和导入均 CAS，旧/坏/未知库不修复覆盖；未知完成后重试不重复新增 |
| 文件交互 | 原生 JSON 选择、有限读取、UTF-8 校验，同目录临时文件完整刷盘后替换 | 不接收任意路径；取消/失败/已保存分开，处理未返回前不关闭 |

入口：[参数领域](../../src/domain/query-parameters.ts)、[参数对话框](../../src/features/query/QueryParametersDialog.tsx)、[交换领域](../../src/domain/query-exchange.ts)、[受限服务](../../src/services/query-exchange.ts)、[Rust 交换](../../src-tauri/src/query_exchange.rs)、[查询库存储](../../src-tauri/src/saved_queries.rs)。

- 交换仅含查询定义、模板和来源标签；不含连接 ID/端点、认证、凭据引用、CA、模型、偏好、工作区、执行历史或结果正文；不是完整配置备份或 Kibana Saved Objects 兼容。
- 嵌套未知字段、已知敏感键和认证形式被拒绝；Rust 使用原始结构切片，特殊数字解析器键名不能掩盖敏感字段或占位。不是通用秘密扫描器：无标签敏感字面量需用户审核，合法同名敏感字段可能被保守阻止；不自动删字段或改写原查询。
- 输入值关闭后不单独保留，但已应用到 DSL 的值仍按草稿/历史保存。浏览器显式使用 session 内存和用户选定文件；下载请求不代表磁盘已保存，桌面失败不回退为浏览器/内存成功。原有两类数据导出和执行快照不复用此导入路径。

自动化：

| 检查 | 结果 |
| --- | --- |
| 前端定向 | 最终 19 文件 **240 项通过** |
| Rust `query_exchange` | 11 项：共享格式、精度、秘密排除/私有解析标签、映射、原子新增、CAS、损坏与文件限额 |
| Rust `query_parameters` | 1 项：闭合定义、未知字段/版本/类型、限额与 debug 脱敏 |
| Rust `query` | 20 项：未替换参数拒绝，原有精度、分页、计划/认证合同 |
| Rust `saved_queries` | 10 项：查询库兼容/损坏/限额与原子文件 helper |
| Rust `workspace_recovery` | 18 项：可选定义往返、输入值拒绝、v1/修订/隔离及错误 |
| Rust `storage` | 42 项：SQLite/迁移/元信息与恢复跨模块边界 |
| Rust `query_export` | 26 项：受共享查询校验影响的流式导出主模块（非前批整个子树 31 项） |
| 静态/构建 | 受影响路径 ESLint、全工程 TypeScript；`npm run build` JS 1,026.74 kB（保留 >500 kB 警告）；`cargo fmt --check`、`clippy --lib --locked -- -D warnings` |
| 文档/补丁 | 9 份文档、113 本地链接、44 表格；48 改动文件 LF/末尾换行及 diff 检查 |

Rust 每行为 `cargo test --manifest-path src-tauri/Cargo.toml <模块>::tests --lib`，非全量/全目标 clippy；未重跑完整旧基线、audit。前端选择：query-parameters、query-parameters-ui、query-exchange、query-exchange-service、query-exchange-ui、query-library、query-library-ui、workspace-recovery、workspace-recovery-hook、app-workspace-recovery、app-library-integration、app-query-integration、query-dsl、query-executions、query-editor、domain、workspace-tabs、query-export-ui、query-export（`tests/unit/*.test.ts(x)`）。共享样本 [query-exchange-v1.json](../../tests/fixtures/query-exchange-v1.json)，不含真实数据或秘密。定向覆盖：恢复不执行、应用不改旧快照、值/模板改变使预览失效、主机迟到冲突、同名连接不预选、端点变化阻止导入、文件处理中不能关闭、未知导入回执不伪报/重复新增。

失败与修正：首轮领域 4 文件 75 项通过；新 UI/交换测试首跑遇 fixture URL 被 JSDOM 转为 HTTP、测试对象括号错误、含语法示例的可访问名称不匹配，已修正。类型检查发现 mock/UUID 工厂类型与新增 CAS 参数旧调用缺失；Rust 测试 ID 所有权与 `Value` 限定路径问题；lint 提示 effect 清理读写变化 ref，改为稳定失效回调。复审补充最终净字节/组合深度限额、来源标签冻结与 Rust 原始 JSON 切片检查。中间轮 5 文件 63 项、19 文件 237→238 项；交接复查补 `importUnconfirmed` 状态与查询库重载动作（239 项），再区分确定拒绝与未知提交，最终 240 项。

特有待验：原生文件选择、取消/覆盖、不可写/磁盘满/系统中断、退出中保存、桌面重启与多进程 CAS；真实 ES 参数化 DSL、认证/TLS/密钥库；长名称/端点/JSON、原生下拉。

## 2026-10-10 Q02 首批：有界时间范围与执行冻结

基线 `6c0cab0`。前批见 [查询期字段](data-views.md)。

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 时间定义 | 最近 N 秒/分钟/小时/天，或完整本地绝对起止；UTC、IANA 或固定偏移 | N 为 1-10,000 整数，总跨度 ≤3,660 天；天固定 24 小时，无月份/日历取整 |
| 类型与精度 | 显式 `date` / `date_nanos`，完整 ISO，UTC 九位小数边界 | `date` 拒绝非整毫秒；`date_nanos` 限非负有符号 64 位纳秒；不经浮点 |
| 审核与应用 | 字段证据、预览时刻、起止与完整 DSL；显式应用或预览移除 | 不自动查询；冲突/草稿/目标变化拒绝，不覆盖手写范围 |
| 执行 | 点击执行时按客户端时钟冻结相对范围，早于 PIT 打开；续页用原绝对 DSL | 不重读视图库、不发送时间元数据，不用服务器 `now` 重算 |
| 保存与恢复 | 查询/收藏保留相对意图，历史保存当次边界；严格嵌套与串行 CAS | schema v7、文档 v1 不变；恢复不执行；历史恢复不重新启用相对时间 |
| 交换与导出 | 原执行 DSL 走原稳定性检查/独立 PIT 导出；交换增加时间语义确认 | 交换不带本地时间托管；普通定义导出预览绝对边界，参数化定义导出模板 |

入口为查询工具栏时钟图标；索引标签不接受时间配置。应用/移除检查源草稿、稳定连接 ID、索引和当前端点；保存冲突不关闭为成功；设置/语言/主题往返、审核、预览、保存、恢复都不执行。可视化反向转换不支持新 wrapper 时保留 DSL。

定义与时间：
- 可选 `QueryDocument.timeRange` v1 含 `definition`、`bounds`、`binding`、`hadQuery`；绑定为连接 ID + 精确索引；`bounds` 为 `resolvedAt`（UTC 毫秒）及 `from`/`to`（UTC 九位小数）。执行副本只含版本、定义与边界，不存基础 DSL、PIT、正文、认证或端点。
- 条件左闭右开 `[from, to)`，`gte`/`lt` + `format: "strict_date_optional_time_nanos"`。拒绝缺秒、非法日期、闰秒、24:00、年份 0000、超九位小数、日历标注、带另一时区的本地输入。`date` 年份 0001-9999；`date_nanos` 须在 `[0, 9223372036854775807]` 纳秒；边界严格递增，绝对范围同受 3,660 天限额。
- 夏令时不存在/双义时间拒绝，不自动选侧；固定偏移 `+HH:MM`/`-HH:MM`，拒绝 `-00:00`；不接受 `system`/`local`。设置时区只作表单初值。
- 相对时间不支持 `now/d`、自然月、任意日期数学或自动刷新；冻结在首个网络等待前，PIT 延迟/续页/失败/取消不重读时钟。不校时、不查询远端时间。

DSL 与字段：
- `jsonc-parser` 按位置只替换/新增顶层 `query`：原查询放入外层 `bool.must` 一项，时间放 `bool.filter`，保留评分与 `should` 默认 minimum_should_match；无 `query` 时保留 `match_all` 评分；移除只删本批成员。大整数/指数/小数/转义保持原 token。
- 不对 `knn`/`retriever`/未知混合检索猜语义；原查询或 `post_filter` 已有同字段手写范围拒绝，不替换不求交。托管范围需定义、边界、目标、wrapper 形状全匹配才可更新/移除；手改 DSL（含格式化）或目标解除托管，撤回相同文本也不恢复。手写日期数学、脚本、子查询、global 聚合不在冻结范围。
- 字段发现仅作证据：未检查与目录缺失分开，显式确认后可用手填字段（非 ES 授权）；冲突、不匹配、不可搜索、nested 拒绝。未应用的本地 runtime 同名字段不可当日期；实际 `runtime_mappings` 只有 `type: "date"` 且选 `date` 才可用，不以旧 field caps 覆盖。不能从此入口写 Mapping；PIT 不冻结 runtime 输出。

恢复与交换：查询库/工作区/历史深拷贝时间子对象；未知键/版本、null、重复键、绑定/边界/wrapper 不匹配拒绝且不覆盖存储；已删连接保留原 ID 不重绑。续页历史开始时刻可晚于冻结时刻但沿用原边界；首屏历史要求一致。历史恢复不带可重算时间配置，收藏保留相对意图；摘要来自执行副本。交换 v1 不变，更改选择/重新预览清除确认，导入只新增不执行。全量导出用所选执行绝对 DSL，继续拒绝 runtime mappings、脚本和剩余手写动态时间，不复用结果页 PIT。

自动化：

| 检查 | 结果 |
| --- | --- |
| 前端初轮时间领域 | 27 项通过 |
| 首轮旧查询合同 | 4 文件 81 项中 1 失败：旧 `createSnapshot` 无效日期异常类型被改变；保留原 `RangeError` 后通过 |
| 前端跨模块 | **24 文件 461 项**：时间、DSL、执行/PIT、编辑器、runtime、保存/恢复、交换/导出、应用生命周期 |
| 日期端点补强 | 3 文件 48 项（重叠），新增 0001/9999 年两例 |
| Rust | 初轮 63 项（时间、查询、查询库、恢复）；跨模块 **134 项**（加视图库、runtime、交换、导出、只读操作合同） |
| 静态/构建 | 20 变动文件 ESLint；`npm run build` JS 约 **1,272.16 kB**（保留 500 kB 警告）；fmt 与 `cargo clippy --lib -- -D warnings` |
| 审计 | `npm audit --omit=dev` 0；完整审计报继承的 5 项开发依赖 high |
| 文档/diff | 8 Markdown、139 本地链接、47 表格、41 变动文件 UTF-8/LF 与 `git diff --check` |

核心为 `query-time-range` 领域/组件/测试与 `query_time_range` Rust 模块；共享 fixture `tests/fixtures/query-time-range-v1.json`；应用级覆盖在 `app-data-views.test.tsx`，延迟 PIT/续页时钟在 `query-executions.test.tsx`。复审补强已知 nested 祖先检查，已应用 runtime 声明不能绕过平面时间筛选限制。Rust 命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib -- query_time_range::tests saved_queries::tests workspace_recovery::tests query::tests runtime_fields::tests data_views::tests query_exchange::tests query_export::tests operation::tests --test-threads=2`。

依赖：新增 `@js-temporal/polyfill` 0.5.1（ISC）与 `jsbi` 4.3.2（Apache-2.0）；Rust 将锁定的 `chrono` 0.4.45 声明为直接依赖，新增 `chrono-tz` 0.10.4 及 `phf`/`phf_shared` 0.12.1，无无关升级。完整审计 5 项 high：`@tailwindcss/cli` 4.3.3、`@parcel/watcher` 2.5.1、`micromatch` 4.0.8、`braces` 3.0.3、`source-map-js` 1.2.1，对照 HEAD 锁文件均非本批引入；后续修复与审计 0 见 [依赖安全](foundation-and-connections.md)。一个子代理仅持有两个新 Rust 文件、超时未产出代码，全部实现由主代理完成。

依据（2026-10-10 读取）：
- [Range query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-range-query)：`gte`/`lt`、日期格式覆盖、缺失日期补齐、IANA/UTC 偏移与 `now`。
- [Date nanoseconds](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/date_nanos)：毫秒/纳秒差异、有符号 long 范围及 `strict_date_optional_time_nanos`。

特有待验：真实 ES 边界命中、Mapping 日期格式、FLS/多目标/nested、runtime 编译/成本、PIT 过期、部分/失败/取消；前端 IANA 依赖宿主 Intl、Rust 用锁定 tzdb，跨平台/升级规则差异未实测（语义不一致则拒绝，不回退系统时区）；时区下拉、升级。

## 2026-10-10 Q02 第三批：有界服务器多字段排序

基线 `44a9cfa`。前批见 [单元格筛选](query-filters.md)。

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 独立入口 | 工具栏 Lucide 排序按钮、紧凑双语审核弹窗，字段增删/方向/优先级上下移 | 表头 TanStack 排序不变成服务器操作；索引标签仍锁定，沿用新建查询入口 |
| 排序子集 | 最多 8 个平面字段、升降序、默认/最前/最后缺失位置、显式兼容 unmapped_type | 字段 1,024 字节、源/最终 DSL 256 KiB；不猜 keyword 子字段、nested、geo、script 或类型转换 |
| 已有排序 | 单字段字符串/对象和有序数组、order/missing/unmapped_type 白名单 | 未知选项、复杂路径、重复字段或超限整体拒绝，不静默清空覆盖 |
| 字段证据 | 同连接/端点/目标的显式 field caps、当前 DSL runtime 声明 | 未检查/失败/缺失/未映射/冲突/不可排序/不支持分开；非授权、doc values 或成功证明 |
| 应用与隔离 | 完整原/最终 DSL、显式应用或移除、草稿 CAS、字段刷新需重新预览 | 只改 sort；保留条件、时间绑定、精确值、脚本文字和参数模板；不执行、不改旧结果 |
| 续页与恢复 | 旧 PIT 续页用原执行 DSL；新运行冻结新排序和时间；按原存储规则恢复 | 未应用选项仅在弹窗，取消丢弃；无新持久定义、执行元数据或 IPC |

语义与安全：
- 默认方向复用 `visual-query`：`_score` 降序，其余升序。`_doc`/`_shard_doc` 不接受 missing/unmapped；`_shard_doc` 仅在可走首页 PIT 时生成，不改 `from`/`size`/手写游标；PIT 隐式 tiebreaker 不由前端注入。
- 缺失指无排序值（不等于 `_source` 缺键或 null），默认 `_last`，支持 `_first`/`_last`；自定义缺失值（含字面量 `"default"`）保留手写 DSL。
- 未映射默认服务端失败；仅用户明确选择才写 `unmapped_type`，不转换冲突类型、不证明全目标已映射；部分未映射须选相容策略，只报 unmapped 或目录缺失时不猜类型。
- 候选限 keyword/constant_keyword、数值、boolean、date/date_nanos、ip，要求可聚合且无 `non_aggregatable_indices`（非空或格式异常不标全目标可用）；接受不可搜索但可聚合的 doc-values-only 字段；`constant_keyword`/`scaled_float` 不生成 unmapped 类型。text/geo/对象/nested/含点路径排除，不猜 `.keyword`，不把 date/date_nanos 或 long/double 冲突转 `numeric_type`；多值用 ES 默认（升序 min、降序 max），`mode`/`format`/`nested` 走手写。
- runtime 只取源草稿实际 `runtime_mappings`，类型仅作声明证据；不执行前端脚本，不因 PIT 声称脚本输出冻结，不改全量导出 runtime 拒绝规则。
- 只替换/插入/删除顶层 sort；未知顶层、手写 PIT/search_after、collapse、knn/retriever/rescore 拒绝组合；原始 DSL 执行通道不受新 UI 门控。无修改保留原 sort 字节，有修改仅无损空白格式化。
- 托管时间携带原绑定副本并保留 `hadQuery`；移除时间不丢排序，新增单元格筛选保留排序与手写条件；参数模板不自动改写。
- 源草稿/目标/端点/字段读取变化、无效可视化或待应用单元格筛选阻止应用；弹窗中禁止运行和保存旧 DSL（含键盘）；CAS 失败不关闭不报成功。
- 无新依赖；Rust 生产代码、SQLite schema v7、文档 v1、DSL 快照合同 v4 与 IPC 不变；仅修正 `FieldCatalog.aggregatable` 对部分不可聚合索引的解释，形状不变。

自动化：

| 检查 | 结果 |
| --- | --- |
| 首轮领域 | 3 文件 154/155；新测试误用两个已有 helper 名致一例失败及 typecheck 报错，改用实际 API 后通过 |
| 领域/组件 | 4 文件 171 项：默认方向、原文/选项、字段证据、双语/审核/刷新/CAS |
| 应用/执行 | 4 文件 107 项：新排序与旧 PIT、时间、索引锁定、待应用筛选/无效可视化、存储恢复 |
| 跨模块 | 16 文件首轮 410/411：新增筛选/参数组合测试漏传 `createSnapshot` 显式时钟，补后领域 65/65 |
| 最终覆盖 | 其余 15 文件 346 项 + 领域 65 项 = 16 文件 411 项（未重跑未受影响的 15 文件） |
| 静态/构建 | 12 变动文件 lint（初轮 `it.each` 换行已修正）、typecheck/构建；JS **1,316.21 kB**、CSS **107.35 kB** |
| Rust | 查询/时间 32 项、fmt；仅新增共享 fixture 的首屏/PIT/续页请求组装测试 |
| 文档/diff | 7 Markdown、157 本地链接、42 表格、22 变动文件 UTF-8/LF 与 diff |

前端选择：query-sort、query-sort-ui、app-query-sort、resource、visual-query、visual-query-editor、query-executions、app-query-filters、query-filters、query-time-range、query-time-range-ui、query-time-range-recovery、app-index-tabs、query-editor、result-grid-ui、query-live。共享 `tests/fixtures/query-sort-v1.json` 由前端生成合同与 Rust 请求组装测试共读；完整 sort 数组、长整数、小数、时间边界、runtime 源码与多项 `search_after` 原 token 保留，UI 的 unmappedType/字段证据/时间元数据不进入请求。JSDOM 验证应用不执行、旧结果不变、表头不改 DSL、旧 PIT 续页沿用旧排序、取消/双语/设置/连接切换/恢复不隐式执行。命令：`npm test -- --maxWorkers=2 tests/unit/query-sort.test.ts`；`cargo test --manifest-path src-tauri/Cargo.toml --lib -- query::tests query_time_range::tests --test-threads=2`；`cargo fmt --manifest-path src-tauri/Cargo.toml --check`；`npm run build`。未重跑 clippy/依赖审计。

依据（2026-10-10，HTTP 200）：
- [Sort search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/sort-search-results)：方向默认、数组 min/max、缺失/未映射、nested 与 numeric_type。
- [Paginate search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)：续页保持同一 query/sort、PIT 隐式 `_shard_doc`、混合日期精度显式要求。

特有待验：doc values、normalizer/null_value、多值 min/max、部分不可聚合索引、多目标未映射/FLS、date/date_nanos 精度、runtime 成本/权限/变化、部分失败与 PIT 过期游标；下拉弹层。

## 2026-10-10 Q03 首批：Monaco DSL 编辑器

基线 `6dc36b4`。前置见 [固定 runtime 筛选](query-filters.md) 与 [执行计划](../development-plan.md)。只替换正式查询 DSL 编辑面，不替换审核对话框、结果 JSON 或原型。

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 编辑面 | Monaco 0.57.0 JSON 词法着色、选区、行/词操作、撤销/重做、紧凑工具栏 | 原始 DSL 为事实来源，不经 JSON 数值重序列化，未知 DSL 保留；无通用 REST/多请求 Console |
| 模型 | 每工作区按稳定查询标签 ID 持有独立模型/撤销栈/视图，匿名 URI 不含连接/索引/文本 | 切换标签/首页/设置不释放；关闭标签/工作区才释放；模型、搜索词、撤销栈不持久化 |
| 同步 | 外部审核/可视化/格式化结果作为可撤销编辑，抑制反向回调 | 不重复改修订号或自动执行；挂载不回写换行/BOM 规范化文本，原文可精确撤销恢复 |
| 校验 | 沿用 `query-dsl.ts` 严格 JSON、重复键、参数/runtime 合同，显式校验显示双语行列与 marker | marker 不含解析器原始报错或输入片段；编辑后旧诊断失效；本地合法≠ES 授权/脚本编译成功 |
| 格式化 | jsonc-parser 空白编辑，独立撤销点，可重做 | 未加载/只读/可视化模式不格式化；长整数、小数、指数、转义、未支持条件不丢失 |
| 查找 | 字面量查找、大小写、前后匹配、Enter/Shift+Enter/Esc、Ctrl/Cmd+F | 搜索词 ≤4,096 字符，计数超 1,000 明示（导航仍覆盖全模型）；不解释正则、不改草稿或执行 |
| 偏好/焦点 | 主题 token、代码字体/字号、密度、换行、减少动态、高对比、可见焦点，中英文 | 设置/语言变化不重建模型；异步完成仅在仍持有加载面焦点时进入编辑器 |
| 失败 | 加载失败保留只读原文和显式重试；旧加载不复活已关闭视图 | 不降级为可编辑 textarea；worker 失败独立提示，不回显底层错误 |

索引标签仍用锁定预览；执行快捷键在编辑器之前仲裁，走同一 canRun/快照入口，对话框、IME/229、长按与隐藏工作区保护保持；无变化的设置、恢复、查找、标签切换不调用查询/PIT。模型内部 LF，未编辑草稿不被重写。

资源与安全：
- 唯一新增直接依赖 `monaco-editor: 0.57.0`；其精确 DOMPurify 3.4.15 有两项 low 公告，用仅限 Monaco 的 3.4.16 override，未 `audit fix --force`；最终 `npm audit` 与 `--omit=dev` 均 **0**。
- 用 Monaco 自带 JSON tokenizer（内含 jsonc-parser），为锁定版本补窄类型声明并以真实词法测试验证。不导入默认 JSON 注册入口（会带入语言服务/worker）；仅注册词法与括号配置，无 schema resolver、JSON worker、补全/远程 hover、格式服务；`$schema` 不请求 URL。
- Monaco 为独立延迟 chunk；editor worker、Codicon、字体本地加载。`getWorker` 仅接收 `editorWorkerService`，无 CDN/任意 worker 地址。CSP 增加 `worker-src 'self'`，`script-src 'self'` 与 IPC-only connect-src 不变，无 blob/unsafe-eval/远程脚本。
- 关闭跨文档词语建议、外部链接、隐式格式化、富粘贴/拖入、默认上下文菜单；自有查找控件用 Lucide。
- Rust 业务、schema v8、恢复/查询文档 v1、固定库 v3、DSL 快照 v4、IPC 不变；仅调整 Tauri CSP。

| 构建资源（Vite 十进制） | 大小 | 说明 |
| --- | --- | --- |
| 主 JS | 1,385.28 kB | 保留大包警告 |
| 延迟 Monaco JS | 2,994.85 kB | 不在初始 HTML，有大包警告 |
| editor worker | 275.63 kB | 独立本地文件，非内联 blob |
| 主 CSS / Monaco CSS | 112.41 / 124.30 kB | 编辑器布局隔离全局表单样式 |
| Codicon | 153.23 kB | 本地 TTF |

引用检查确认主包→延迟 Monaco→实际 worker、CSS→实际字体，无 jsonMode/json.worker；不代表 WebView/CSP 下 worker 已运行。

自动化：有效覆盖 **19 文件 213 项**（主体 19 文件 212 项 + 真实 Monaco 视图/工作台补强 2 文件 10 项，runtime 原 3 项替换为 4 项，重复 9 项不计）；快捷键补强 4 文件 72 项全重叠。

| 检查 | 证据 |
| --- | --- |
| 真实模型 | 未知 DSL、长整数/小数/指数/转义、BOM/混合换行、单步格式化/重做、外部同步抑制、同 ID 跨工作区、关闭释放 |
| 编辑器组件 | 选区/滚动/撤销、偏好/双语 marker、只读/隐藏、异步换标签/卸载、失败重试、worker 提示、查找/计数/IME |
| 真实实例 | `editor.create`、`executeEdits`、`trigger('undo'/'redo')` 与可访问名称 |
| 工作台回归 | 查询/PIT/取消/快捷键、索引标签、AI 应用、收藏、恢复、排序/会话筛选、Data Views/runtime 固定、可视化与文本选择 |
| 静态/资源 | 18 文件 lint、typecheck/构建、完整/生产审计 0、本地 worker/字体/延迟资源检查 |
| 文档/diff | 31 文件 UTF-8/LF、8 文档/230 本地链接/53 表格、diff 空白 |

测试选择（`tests/unit/`）：query-editor-models、query-monaco-editor、query-monaco-options、query-monaco-runtime、query-editor、query-dsl、query-live、app、app-index-tabs、app-query-integration、app-workspace-recovery、app-ai-integration、app-library-integration、app-query-sort、app-query-filter-session、app-data-views、app-pinned-runtime-filters、visual-query-editor、text-selection；复验子集 query-monaco-runtime+query-editor，及 +query-monaco-editor+query-live。其他命令：`npm install --ignore-scripts`、`npx eslint src/features/query/editor src/features/query/QueryWorkspace.tsx src/app/App.tsx src/locales/{en-US,zh-CN}.ts` 及相关测试/mock、`npm run build`、`npm audit --json`、`npm audit --omit=dev --json`。未改 Rust、未构建安装包。

开发期修正：新版 hover/selectionHighlight 类型差异；测试视图自引用类型与未使用参数；模型替身未注册 JSON 导致 plaintext；视图先销毁的清理顺序；查找订阅模型版本防止外部更新后计数陈旧。初次完整 JSON 入口带来的约 1,038 kB jsonMode、407 kB JSON worker 与重复样式已移除。新增两例先红后绿：长按执行键/查找框内重复查找键未拦截默认行为——改为捕获阶段消费重复执行/关闭事件但不触发动作，查找框消费 Ctrl/Cmd+F 并保留焦点。

特有待验：离线启动及本地 worker/CSP、原生剪贴板、撤销分组/光标、快捷键冲突、Tab/Esc、字体加载、大草稿性能。重启只恢复草稿定义，不恢复模型/撤销栈；真实 ES 权限/runtime/PIT 未重验。

## 2026-10-10 Q03 第二批：有界字段与参数补全

基线 `d6cb70d`。不引入 JSON 语言服务、任意 REST、查询执行或新存储合同。

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 字段位置 | `query`/`post_filter` 内 term/terms/match/match_phrase/range 字段键、exists.field；bool 子句与 constant_score.filter 已知容器；sort、fields、_source 已知字符串位置 | 不从未知 DSL、nested、聚合、docvalue_fields、脚本或任意字符串猜；含点名称只用真实返回完整名 |
| 字段证据 | 当前连接 ID、端点与完全相同请求目标的 ready field caps | 刷新中/失败/端点替换/连接删除不用旧证据；不自动发现字段，非权限或成功证明 |
| 类型边界 | 有界标量类型；冲突/未知不建议；查询位置排除不可搜索，排序排除不可聚合/text/geo_point，已知 nested 后代不作平面条件 | 不猜 keyword 子字段、nested 路径、转换、权限或默认值；_source 不建议元数据字段 |
| Runtime | 只读当前 DSL 受限 runtime_mappings，显示类型与遮蔽来源 | 无效声明不回退同名映射；runtime 不进 _source；geo_point 仅字段/exists 位置，不显示/执行脚本 |
| 参数 | 只在非根、单属性 `{"$param": ...}` 整值占位中补当前参数名与类型 | 不插新占位、不补值、不改已保存模板、不读其他标签；未替换参数仍被执行门控拒绝 |
| 编辑 | jsonc-parser 词法 token/节点位置生成一个 JSON 转义文本编辑，显式选择后可撤销/重做 | 不重序列化；无 command/action/additionalTextEdits/snippet；长整数、小数、指数、未知条件与转义原样 |
| 交互 | Lucide 图标与 Monaco 本地建议列表；无自动弹出/行内建议/共享选择记忆，不预选、不用 Enter 或提交字符自动接受 | 按模型 URI 与对象身份隔离；切换标签/目标/参数/证据/语言、隐藏/只读/卸载使旧 provider 失效并关闭列表；IME 开始关闭建议 |
| 双语 | 来源/类型、空/加载状态、列表与可访问名称中英文 | Monaco 0.57 冻结部分原生文案，仅适配该实例文字/ARIA；升级需复验 |

字段键为空或无冒号时只插入 `"字段": `，不猜值；其余位置仅替换完整字符串 token 或在明确空值处插入带引号名称。光标之外 JSON 须可严格解析；评论、重复键、无效转义、未闭合字符串、无法定位结构不建议。接受建议沿用手改 DSL 的修订号、托管解除和结果过期规则，不改旧执行/PIT。

上限与资源：
- DSL ≤**256 KiB**、嵌套 ≤**64** 层、扫描 ≤**100,000** token；字段名 ≤**1,024 UTF-8 字节**，控制/方向覆盖/通配选择符不建议，转义前缀须完整。
- field caps 超 **4,096** 项不提供映射字段建议（不截断为完整目录）；runtime 与参数仍按原 32 项合同。按前缀筛选、去重、排除同对象已有键后最多展示 **100** 项；列表内继续输入重读当前模型。
- 无依赖/锁文件、Rust、IPC、schema 变化；schema v8、恢复/查询文档 v1、固定库 v3、DSL 快照 v4 保持；补全数据不持久化。
- Monaco 0.57 的 `features/suggest/register` 只注册行内 provider，无建议窗口；最终只引入锁定版本 suggestController，未启用 snippet/行内来源；`${...}`、引号、反斜杠真实实例回归通过。仍无 JSON worker/jsonMode；CSP 未改。

| 构建资源 | 大小 | 说明 |
| --- | --- | --- |
| 主 JS | 1,395.78 kB | 保留大包警告 |
| 延迟 Monaco JS | 3,125.21 kB | 建议窗口在延迟包内 |
| editor worker | 275.63 kB | 本地独立 |
| 主 CSS / Monaco CSS | 112.41 / 142.38 kB | 含建议列表样式 |
| Codicon | 153.23 kB | 本地 TTF |

自动化：最终 **14 文件 257 项**、**20 文件 lint**、typecheck/构建与本地资源引用检查通过（早期 6 文件 139 项重叠）。

| 检查 | 证据 |
| --- | --- |
| 领域 | 20 个已知字段位置；未知/脚本/nested/聚合拒绝；空键/值、转义前缀、JSON 注入字符、重复键、UTF-8/深度/目录/建议配额 |
| 证据 | 连接 ID/端点/目标隔离，未检查/刷新中/失败/迟到响应/已删连接；runtime 遮蔽、无效声明不回退、不读脚本/模板值 |
| Provider/视图 | 匿名 URI、模型对象/cancel/dispose 守卫；变化关闭旧建议；只读/隐藏/IME/模态守卫、双语 ARIA |
| 真实 Monaco | editor.create、建议窗口显示与显式接受、单步撤销/重做；含 `${...}`/引号/反斜杠字段保留长数值与原文 |
| 工作台 | 显式字段读取后建议、跨标签隔离、刷新失败与旧端点迟到不回填；接受/撤销不查询/开 PIT；校验/参数/恢复/索引/可视化回归 |
| 构建/资源 | 主包→延迟 runtime→实际 worker、CSS→Codicon；无 jsonMode/json.worker、远程 importScripts/URL |
| 文档/diff | 25 文件 UTF-8/LF、9 文档/242 本地链接/57 表格、diff 空白 |

测试选择（`tests/unit/`）：query-completions、query-monaco-completions、query-monaco-editor、query-monaco-options、query-monaco-runtime、query-editor、query-editor-models、query-live、query-dsl、query-parameters、query-parameters-ui、app-workspace-recovery、app-index-tabs、visual-query-editor；lint 覆盖 `src/domain/query-completions.ts`、`src/features/query/editor`、`QueryWorkspace.tsx`、两份 locale 及相关测试/`monaco-view-mock.ts`；另 `npm run typecheck`、`npm run build`。未改 Rust/原型/依赖，未重跑审计。

开发中修正：
1. 首轮 4 文件 83 项 1 项预期错误：无前缀 exists 空值应返回全部合格候选，移入空值用例，未放松守卫。
2. jsonc-parser ambient const enum 不兼容 isolatedModules，改为本模块具名词法常量；lint 控制字符正则改为有界字符码检查。
3. 真实建议窗口用例先红：默认 suggest feature 入口未注册触发动作，改为 suggestController 后通过。
4. 增加原生空状态/ARIA 双语适配、字面 `${...}` 接受回归与字段前缀集合检查，最终重新通过。

特有待验：Ctrl+Space 与 IME、方向键/Tab/点击/Esc/Enter、长字段、列表边缘定位及代码/标签焦点、离线/重启、大目录/大草稿性能；授权真实环境补验不自动执行、未知 DSL 原文保留、参数模板独立与结果/PIT 不变。
