# 聚合与图表 验收记录

## 共同说明

- 分支关系：`17af981`（2026-10-10 有界基础聚合结果）为共同基线。**dev 线**（`origin/dev`：`2f75f23`→`800b7fe`→`43aa301`→`976bc44`→`491bf48`，2026-10-10–11，原记录写“沿用 main”）交付 Visx 图表、聚合构建、`chart_definition_library`（`009_chart_definitions.sql`，schema v9）、`escope-chart-definitions` v1 交换与折线右轴；**main 线**（本地 `d5aab14` 与检查点 `3fccd6c`，记录日期 2026-10-13）另行实现基础图表与 `saved_chart_library`（`009_saved_charts.sql`，同为 v9），计划节号曾与 dev 线同为 §10.33/§10.34，合并后改记 §10.38/§10.39。2026-10-15 合并提交 `8affb73` 新增 `010_merged_chart_libraries.sql` 升 schema v10，其后 terms 双轴提交 `18f90d8`、参考线提交 `7fda07c`。2026-11-06 核对：当前 `main` 为线性历史，`1144378`/`b884a44`/`6968816` 依次与 `8affb73`/`18f90d8`/`7fda07c` 同树；`d5aab14`、`3fccd6c` 与这三个原提交只在 `backup/pre-cleanup-2026-11-06`。
- 共同未验：各批仅开发/JSDOM/集成/typecheck/构建自动化（Rust 批另有临时 SQLite/文件）通过；真实 ES（版本、多索引/FLS/权限、terms 误差/排序/遗漏、cardinality 近似、interval/时区/DST/keyed/缺桶、部分结果、成本）、原生交互（日夜/四强调色/高对比、200%/窄窗、长值横滚、键盘焦点、`<select>`/`<datalist>`/IME、剪贴板、屏幕阅读器）、桌面 SQLite/文件、性能与 WebView2/macOS/Linux 均**未验**，见 [集中人工清单](../manual-acceptance.md)；配额、JSDOM 元素数与几何不作原生或性能证据。批内只列特有待验。
- 测试约定：前端均 `--maxWorkers=2`、未提高超时；`npm test` 后接 `tests/unit/` 测试基名（`a{,-b}` 即 `a`、`a-b`），模式参数原样。首轮失败除标“真实缺陷”外均为测试/夹具口径修正，未放宽断言；重叠复验不相加；“覆盖上表”指测试逐项断言表内边界。未访问用户数据库/真实 ES/密钥库，未启动浏览器/WebView/预览服务，未构建安装包、未推送；未改 Rust/原型/依赖的批次不重跑其全量/fmt/clippy/审计。Monaco 各批均 3,125.21 kB，大包警告保留。
- 合同：除另注外无 Rust/IPC/schema 或 DSL/PIT/恢复合同变更；恢复文档 v1、固定库 v3、执行快照合同 v4、Data Views/查询库/查询交换合同全程未改；schema 读取批 v8 → 两线各 v9 → 合并后 v10；图表定义与交换文档 v1 至参考线批未变。
- 通则：构建/保存/复用/交换不请求、不开 PIT、不执行；复用只播种构建行，仍走“完整 DSL 预览 → 显式应用”，应用后须明确运行。拒绝均整次（不截取、不丢成员或修复后放行、不部分写入），只针对本地解释/构建/存储，不代表 ES 拒绝。不新建路由/Dashboard/管理首页，索引标签无聚合/构建/定义入口；沿用 token/Lucide/双语键/可见焦点，`primary/secondary/danger` 只用于动作按钮。
- 父任务与后续：Q06/Q06a 与六方向父任务未关闭；Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、nested runtime/深层条件、完整 Q02/Q03/F07、W01/W04 不因此跳过。截至 2026-10-15 未交付：会话级注释（下一项，先定单个已核对接收页上的锚点/文本/数量边界，沿用参考线的执行身份、显式操作、清理与无持久化）、图例筛选、同比环比（先定服务端时间边界）、公式（客户端算数禁止，先定服务端聚合语义）、图层（先定定义库是否版本化）；持久化第二度量或图型开关须先升图表定义 v2 并同步交换文档与迁移。通用聚合树、Dashboard、Kibana Saved Objects 兼容不承诺。

### 通用读取与绘图规则

适用于 dev 线实现与合并后统一的 Visx 实现，进阶图型不放宽、不减半；main 线 2026-10-13 两批为独立实现，见其批次。

| 项 | 规则（首立批次） | 超限/违例 |
| --- | --- | --- |
| 读取 | DSL 256 KiB、接收页 1 MiB（UTF-8）；64 层、每份 100,000 token、每数字 4,096 字符；顶层与直接子指标合计 32 项（未匹配响应项也计）、名称/类型名 1 KiB；合计 4,096 桶，DOM 每页 50 桶（读取批） | 扫描阶段整次拒绝，不等递归溢出；文档结果与原文入口保持 |
| 原文 | 按需挂载，DSL 256 KiB/响应 1 MiB 显示限额，内部滚动 | 超限不渲染正文，仍可复制原页 |
| 绘制 | 单条目 ≤200 个已返回桶；位置轴 ≤12 标签（含首尾），单标签显示截断 20 字符；未绘制清单列前 10 项（dev 线图表批） | 整次拒绘、报返回数并指向桶表格；原 token 留在 `aria-label`/`<title>`/表格；其余汇总计数 |
| 精度 | token→double 独立核对严格十进制、有限性、下溢、安全整数与最短往返，绘制值与原 token 并列 | 只保证转换无损，非 ES 数学精确；缺失/null/非数字/超范围列为未绘制并给原因，绝不画 0；读取已拒者不进绘图 |
| 桶序与日期 | 保持返回顺序/槽位/起点，标签优先 `key_as_string` | 不重排、不补桶、不推结束边界，客户端不解析/格式化日期；折线在跳过处断开，缺口不代表 0 |
| 会话 | 图表与解析结果只在会话内存；续页不换已选接收页，新快照/离开即清理 | 开关/选择/绘图不请求、不改 DSL/PIT；无点击/悬停查询、无导出、不写恢复存储 |

## 2026-10-10 Q06 有界基础聚合结果（共同基线）

基线 `f2c226c`，提交 `17af981`。只读取、展示已有查询的聚合响应。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 类型 | 顶层 sum/avg/min/max/value_count/cardinality；单层 terms/date_histogram 及直接单值指标 | 按不可变执行 rawDsl 识别，不从 value/buckets 形状、typed key、草稿或 field caps 猜 |
| 精度 | 值/计数/格式字符串保留原 JSON token，缺失/null/0/空桶分开；count 指标拒绝负数/小数 | 不转浮点、不填 0、不套 Data View 格式 |
| terms | 整体/逐桶 `doc_count_error_upper_bound`、`sum_other_doc_count`，请求 size/shard_size/order 原值 | -1 与未报告独立；Top terms 非完整分类，桶计数不相加为总数，遗漏计数非类别数 |
| 日期桶 | 数字 key、可选 key_as_string、keyed 成员名、calendar/fixed/旧 interval、时区/offset/bounds 原值 | keyed 成员名不冒充数字 key |
| 统计范围 | 执行来源 ID/连接/端点/精确目标/开始时间；页级 partial、超时、提前终止、分片失败、未报告失败分片、跨集群分别提示 | 命中总数/已加载数不当总体；post_filter 与聚合分开；脚本/runtime 不承诺被 PIT 冻结；授权/HTTP 成功/空值/字段能力不当完整，跨集群需核原响应 |
| 接收页 | 显式选择，默认首个；续页不替换选择，各页独立解释与复制 | 不累加 PIT 聚合、不自动续页或重跑；原 JSON 视图仍显示最新页 |
| 原文回退 | 未请求/未支持/未返回/结构不支持分列；执行定义、执行 DSL、聚合响应、原接收页按需展开与复制 | 高级/管道/多层/未知保留原文不伪装；通用聚合树未实现 |
| 视图 | 结果区会话聚合视图（SelectControl），每次一个聚合；新快照（含复用 request ID）、离开标签/设置清理，切换聚合/页重置桶页与展开 | 隐藏“导出已加载结果”免被当桶导出；resultView 仍 table/json，旧布局与恢复保持 |

实现：`src/domain/query-aggregations.ts` 复用 `jsonc-parser` 与无损 JSON reader，先扫限额再建树；`QueryAggregations` 仅打开视图时挂载；不改 `query-result.ts`、执行 hook、后端 DSL、PIT 或 IPC。结果为纯数据，不执行脚本/HTML/URL；缺失直接指标不回查；结构不支持即保留完整原文、不显示部分桶。整份接收、JSON 格式化与累计文档内存仍走原合同，未宣称全管线有界。

自动化：有效 **10 文件 292 项**（主体 291；导出入口复查 3 文件 89 替换原 88），**8 文件 lint**、typecheck/构建通过。领域 88、UI 21 覆盖上表与配额，另含原始数字/转义、原型键名、复制失败、双语与文本安全；工作台 56（新增 3：size-zero 不开 PIT、未知聚合不隐藏文档、续页沿用原 DSL 且各页独立）；其余结果回归 127。主 JS **1,486.75 kB**、CSS **125.23 kB**，Monaco CSS **142.38 kB**、worker **275.63 kB**。文档：18 文件 UTF-8/LF、8 文档/290 链接/65 张表、秘密模式与 diff 检查通过。

命令：`npm test` query-aggregations{,-ui}、query-live、query-{result,executions}、result-grid-ui、document-{detail,comparison}-ui、query-library-ui、workspace-recovery；复查 query-aggregations-ui、query-live、query-library-ui；`npx eslint src/domain/query-aggregations.ts src/features/query/{QueryAggregations,QueryResults}.tsx src/locales/{index,query-aggregations}.ts` + 测试 query-aggregations{,-ui}、query-live；`npm run build`。

首轮：领域 84、UI 19 先过后补脚本/计数指标/原型键名与页范围提示；工作台新增 3 项先独立过；四处 ByRole 不接受 `exact`，移除。复审反例“聚合视图不冒充文档导出”首次失败（真实缺陷），隐藏入口并清理已开文档导出后 3 文件复验通过。

特有待验：多值计数、日期边界、脚本/runtime 编译与成本；PIT 续页实际聚合、超时/分片/跨集群状态、端点/权限漂移与取消；长名称/数字/选项、宽指标表横滚、原文内外滚动、重启；4,096 桶/大量指标/大原页的解析、切换、复制、内存与渲染预算。

## 2026-10-10 Q06 基础聚合图表（dev 线）

基线 `17af981`。在会话聚合视图内绘图，首立通用绘图规则。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 图型 | 单值指标卡、单层 terms 条形、单层 date_histogram 折线，由执行 DSL 已解析的条目类型确定 | 不从响应形状/草稿/字段证据猜；`unrequested`/`unsupported`/`missing`/`invalid` 说明不可绘，保留原文与表格 |
| 输入 | 只用 `readAggregationPage` 的单个条目（所选聚合 + 所选原接收页） | 不重解析、不合并页；新页到达已开的图仍绘原页 |
| 位置/标签 | 条形保槽位、跳过留空槽；折线按数字 key 定位、只连相邻返回行；无 `key_as_string` 用 `key` 原 token | 复制与桶表格保留完整 token |
| 度量 | `doc_count`（默认）或执行 DSL 已解析的直接指标；未知即整体拒绘 | 不回退；cardinality 标近似、value_count 标“值数量不是文档数量” |
| 提示/标注 | 近似、误差未知/未报告、`sum_other_doc_count`、Top N 非完整、仅桶起点、断线、精度损失计数；冻结目标索引、接收页序号、度量、绘制/返回桶数与冻结绝对时间边界原文 | 页级 partial/超时/提前终止/分片/跨集群/post_filter/脚本/runtime 限制图内声明同样适用；标注取自执行快照，只显示不入请求 |
| 交互 | 标题栏“显示/隐藏图表”开关、度量选择器、可聚焦滚动区；条目/页切换按 key 重挂载 | 无拖拽；表格/JSON 视图与文档导出合同不变 |

图表库：`@visx/{scale,shape,group}` 精确锁定 `4.0.0`（React 19 peer、纯 SVG），3 个直接依赖另增 29 个锁定条目；许可 visx/classnames MIT、`@visx/vendor` MIT and ISC、d3-*/delaunator/internmap ISC、robust-predicates Unlicense。只用尺度与路径，坐标轴自绘免 DOM 文本/canvas 测量（JSDOM 可断言结构与 `d`）。`@visx/{scale,shape,group,curve,vendor}` 产物无 `eval`/`new Function`，本地打包、合 `script-src 'self'`，无远程脚本/worker/`unsafe-eval`。延迟 chunk `AggregationChartCanvas` 40.45 kB（gzip 15.18 kB），仅打开条形/折线时加载。

自动化：有效 **13 文件 340 项**（新增 3 文件 48：领域 29、图表 UI 16、加载失败 3；读取/UI 2 文件 109；相邻结果 8 文件 183），**10 文件 lint**、typecheck/构建通过。覆盖上表与通用规则，另含真实 0、空桶、原型键名、纯函数不改输入、`d` 有限、hostile 文本不入 DOM、双语键；集成 5（计入上列）复用 `QueryResults` 装配，不触发 run/loadMore/cancel/view/layout 与 `fetch`，预览与他查询身份无图表入口。主 JS **1,501.89 kB**（+15.14）、CSS **127.89 kB**（+2.66）；`npm install` 后完整与生产 `npm audit` 均 0；无 Rust/原型/CI 变更。

命令：`npm test` query-aggregation-{charts,charts-ui,chart-loader}、query-aggregations{,-ui}；`npm test` query-{result,executions}、result-grid-ui、document-{detail,comparison}-ui、query-library-ui、workspace-recovery、query-live；`npx eslint src/domain/query-aggregation-charts.ts src/features/query/charts src/features/query/QueryAggregations.tsx src/locales/{query-aggregation-charts,index}.ts` + 3 个新测试；`npm run build`。

首轮：领域 1 例夹具少右括号被读取拒绝；UI 7/16（插值模板当字面量、`toHaveAttribute` 传正则、同名文本命中刻度与跳过清单、直方图夹具多括号、Lucide 图标 SVG 当图表 SVG），改作用域查询与 `.qac-*` 选择器；加载失败用例改断失败提示、无 `.qac-state` 残留与重试计数，不断言瞬时 loading。

特有待验：SVG 像素与网格可读性；`value_as_string` 缺省、大 `doc_count` 溢出、负 key；200 桶绘制/切换耗时、内存与 chunk 加载时延；SVG `<title>` tooltip、`role="img"` 摘要与轴文本朗读；剪贴板不参与本批。

## 2026-10-11 Q06 聚合构建与完整 DSL 预览/显式应用（dev 线）

基线 `2f75f23`。“分组 + 指标”形成待审 DSL，与时间范围、单元格筛选、布尔组、服务器排序、runtime 字段共用审核机制。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 草稿模型 | ≤1 个单层 `terms`/`date_histogram` 分组 + 直接指标，或无分组的一组顶层单值指标（同六类） | 同读取器可解释形状；管道/公式/多层/`top_hits`/composite 只能手写 |
| 写回 | 只改顶层 `aggs`（已有 `aggregations` 长写法原地改，不建第二块） | `query`、时间 wrapper、`sort`、`runtime_mappings`、`_source`/`fields` 等根属性逐字节保留 |
| 手写保留 | 模型外顶层条目按原值文本保留，列为“保留的手写聚合” | 值文本逐字节不变；块被改时条目间空白/换行重排（token/转义不变），须预览核对；生成名与之同名即拒，可表达的同名条目是可编辑行 |
| 选项 | terms 可选 `size`；date_histogram 需 `calendar_interval`/`fixed_interval` 之一，可选 `time_zone` 透传 | 不校验时区；`extended_bounds`/`hard_bounds`/`offset`/legacy `interval`/`keyed` 不生成，保留原文 |
| 文档计数 | 不建 count 聚合：用命中总数与桶 `doc_count`；有分组无指标时只收 `doc_count` | 不伪造 `filter`/`global` |
| 字段证据 | 同连接/端点/完全相同目标的当前 field caps 与当前 DSL `runtime_mappings` 逐行给类型与来源，可重查 | 非权限或成功保证；需 aggregatable、单一非 metadata 类型、非 nested、非含点路径，超保守矩阵即拒 |
| 审核失效 | 预览绑定行对象与字段读取身份，行/目标/草稿/证据变化即失效；应用前再核 `matchesQueryDraft` 与目标，并从源 DSL 重新读回 | 未应用行只在弹窗 React 状态，不入恢复存储；应用后沿用草稿/历史/恢复规则 |
| 运行/可访问性 | 审核中“运行”“保存草稿”禁用并说明；控件显式 aria-label，证据行 `role="status"`，拒绝 `role="alert"` | 索引标签只用“为该索引新建查询”，构建不改锁定目标；JSDOM 只验可达名称与状态文本 |

拒绝条件：多个可表达分组、分组与顶层指标混排、超 31 指标、`aggs` 与 `aggregations` 并存、非对象块、非法 JSON/未替换参数、名称/size/间隔/时区形状错、证据不符、定义总数超 32、构建后读回不一致。配额：DSL 源与最终各 256 KiB（读取器 `dslBytes`，`tooLarge`）；每组指标 ≤31（给 32 定义上限留分组位）；分组 + 指标 + 保留条目及其直接子项 ≤32（`tooComplex`）；名称/字段各 1 KiB、非空、无首尾空白与控制字符、非 `$param`，组内唯一且不与保留条目冲突（`invalidName`/`invalidField`/`duplicateName`/`nameConflict`）；terms size 为 1–1000 整数 token，留空不写（`invalidSize`，不用默认值）；间隔 64、时区 100 字符且无首尾空白（`invalidInterval`/`invalidZone`，写法由 ES 校验）；保留条目不限条数，只计入定义总数与字节。

自动化：有效 **23 文件 434 项**（新增 3 文件 111：领域 95、弹窗 13、工作台 3；相邻读取/图表/排序 8 文件 243；共享 12 文件 80），**8 文件 lint**、typecheck/构建通过。覆盖上表与配额，另含选项 token 反解、22 类手写条目保留（管道/脚本/额外选项/两层分组/歧义子块/`meta`/数组值/legacy `interval`/`keyed`/bounds/数值间隔/名为 `aggregations` 的条目）、6 类整体拒绝、空块删除与首/末/唯一属性位置写法、产物交回 `readAggregationPage` 得 `buckets`+`unsupported` 而非 `invalid`、托管时间绑定复制与失配拒绝；弹窗由已应用块播种行与保留清单、无块从“不分组”起、已最新提示未变化、目标失配全禁用、不可审核块无半成品入口、中英切换不丢已审文本、`fetch` 零调用、指标行重排与移除；工作台应用后编辑器等于已审文本且 `execute`/`openPit` 为 0，手写 `percentiles` 保留且复用其名被拒，托管时间标签与 wrapper 应用后保留。主 JS **1,533.55 kB**（+31.66）、CSS **130.81 kB**（+2.92）；零新增依赖，`package.json`/lock 未改。

命令：`npm test` query-aggregation-build{,-ui}、app-query-aggregation-build、query-aggregations{,-ui}、query-aggregation-{charts,charts-ui,chart-loader}、query-sort{,-ui}、app-query-sort；`npm test` app-data-views、app-index-tabs、app-query-filters、app-query-filter-session、app-pinned-{filters,filter-lifecycle,nested-filters,runtime-filters}、app-query-integration、app-library-integration、app-workspace-recovery、app-ai-integration；`npx eslint src/domain/query-aggregation-build.ts src/features/query/{QueryAggregationBuildDialog,QueryWorkspace}.tsx src/locales/{query-aggregation-build,index}.ts` + 3 个新测试；`npm run build`。

首轮：领域 6/95（夹具少右括号、保留条目值文本口径、`undefined` 走默认参数拿到 catalog、sum 用于 keyword 期望 `fieldNotAggregatable` 而矩阵先报 `fieldUnsupported`（改 value_count 命中 doc values 分支）、字节夹具留白不足、已整体替换的分组误算保留）；弹窗 7/13（`getByLabelText` 查 `Add metric` 文本按钮、`<details>` 内文本断言可见、名称与解析失败两个 `role="alert"` 改统一提示区、`toBeUndefined` 误用）；工作台 3/3（Radix 背景 `aria-hidden` 改 `hidden: true` 查询、未检查字段即点预览、多行格式化片段改 token 级 + `toMatchObject`，长整数与转义仍文本层断言）。lint 去未用导入，`9007199254740993` 改文本层断言防精度丢失。

特有待验：构建出的聚合在真实 ES 编译执行（doc values、`size` 与分片放大、非法 `fixed_interval`/`calendar_interval` 报错呈现）；两个新 fieldset 焦点顺序、指标行增删后焦点归属、`role="status"` 播报、保留清单与最终 DSL 横滚、窄窗网格换行；应用后 Monaco 重渲染与撤销栈（自动化只覆盖 textarea）；已绑定时间 + 参数模板 + 手写 nested/runtime 目标上整条“构建→预览→应用→明确运行”。

## 2026-10-11 Q06a 图表定义保存与复用（dev 线）

基线 `800b7fe`。把读取 → 绘图 → 构建所需的**选择**收为版本化本地定义；本批不含本地交换（下一批），UI 无占位入口。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 内容 | v1 `id/name/connectionId/index/draft{group,metrics}/measure`；分组与指标只存名称、类型、字段与 size/间隔/时区字面文本 | 不存解析结果、绘制值、字段证据、时间边界、端点、认证对象、凭据引用、结果正文或图型开关（图型仍由执行 DSL 定） |
| 校验 | `draft` 用构建模块 `validateAggregationDraft`；度量有分组为 `doc_count` 或组内指标名，无分组须为该单值指标 | 不修好再保存，不回退 `doc_count` |
| 存储 | SQLite `chart_definition_library` 单行文档，schema v8 → v9，`009_chart_definitions.sql` | 迁移逐步单事务，失败保留原版本与文档；读不插行，revision 0 即无行；`revision BETWEEN 1 AND 9007199254740991` 与 256 KiB 由 SQL CHECK 与代码双重约束 |
| 写入 | immediate 事务内比较 expectedRevision，成功 +1 | 冲突 `chartDefinitionConflict`、损坏读回 `invalidResponse`，均不写盘；损坏/未知版本/冲突不覆盖，未知完成需显式重载 |
| 连接 | 固定 `connectionId`，同 ID 不换绑；新增 ID 须同事务确认连接存在 | 缺连接 `chartDefinitionConnectionMissing`；删除连接保留历史 ID 与定义，不重绑、不静默删除 |
| 复用 | 连接与目标完全一致的查询标签上“复用到聚合构建”，交出冻结深拷贝并打开构建审核 | 目标不符或连接已删时禁用并说明 |
| 管理 | 复制为新 ID；重命名只改名称；删除需显式确认 | 不换目标、不覆盖他人写入；删除不改草稿、执行快照或查询定义副本 |
| IPC/服务 | `chart_definitions_load`/`chart_definitions_save` 受限类型化命令；桌面走 IPC，浏览器预览为显式 session 内存适配；定义面板为对话框 | 无任意 URL/方法/认证头，不读密钥库；错误码为既有集合 + 上述两码；桌面失败不降级为内存，session 不跨重启并标注 |

配额：每库 100 条（`invalidInput`，不丢旧条目；到上限新增入口全禁用并说明）；序列化 256 KiB；名称 ≤120 码点、无首尾空白/控制字符（不自动 trim）；目标沿用索引语法 ≤1024 字节（不猜测展开）；名称与字段各 ≤1 KiB、无控制字符，指标 ≤31（同读取器 32 定义上限）；含点路径可作字面量存储，构建预览按 `fieldPath` 拒绝；size 1–1000 整数 token、间隔 ≤64、时区 ≤100 字符（不改默认值，合法性归 ES）；revision 1–9007199254740991，越界由 SQL CHECK 拒绝，客户端不强制覆盖。

自动化：Rust `chart_definitions` 14 覆盖上表与配额（另含 camelCase 文档键、空草稿/重名、篡改存储不修复、重开保留原文、分组完整往返）；受影响模块合计 **190**（原记录如此，分项和为 175）：`chart_definitions` 14、`storage::` 47（含 v8 → v9 与历史迁移保留条目）、`data_views` 19、`pinned_filters` 27、`workspace_recovery` 28、`saved_queries` 13、`query_exchange` 11、`runtime_fields` 7、`query_time_range` 9；`cargo fmt` 干净。已知缺陷：`cargo test --lib` 全量本机不能收尾——既有 `connection::tests` 两条用例各 `has been running for over 60 seconds`（mock 只裸听 TCP，客户端按 `https://localhost:port` 握手而等读超时），与本批无关，记为未运行待补。前端有效 **28 文件 490 项**（新增 5 文件 56：领域 30、服务 5、面板 11、弹窗 8、工作台 2；相邻 11 文件 354；共享 12 文件 80），**16 文件 lint**、typecheck/构建通过；覆盖上表，另含共用夹具 `tests/fixtures/chart-definitions-v1.json`、20 类损坏输入（多余键、端点/结果/证据/凭据/时间边界键、非字面量选项、未知指标、缺度量、无分组用 doc_count、空草稿、重名）、冻结复用拷贝不受后续库改动影响、load 返回脱离引用、非 Tauri 报 `unsupported`、保存不调用 `onCommit`、目标不符的复用被忽略、工作台全链路只改 `aggs` 且长整数 token 保持、`execute`/`openPit` 调用数不变。主 JS **1,554.45 kB**（+20.90）、CSS **132.77 kB**（+1.96）；零新增依赖。

命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib chart_definitions` 与 `--lib` 全量；`npm test` chart-definitions{,-service,-ui,-build-ui}、app-chart-definitions；相邻 11 与共享 12 文件两条同聚合构建批；`npx eslint src/domain/{chart-definitions,query-aggregation-build}.ts src/services/{chart-definitions,ipc}.ts src/features/query/{useChartDefinitions.ts,ChartDefinitionsDialog.tsx,QueryAggregationBuildDialog.tsx,QueryWorkspace.tsx} src/locales/{chart-definitions,index}.ts src/app/App.tsx` + 5 个新测试；`npm run build`。

首轮：领域以只读属性做突变断言，改断 `load()` 脱离引用；面板 8 项（`getAllByRole` 空列表抛错、库未就绪即断言、用 `element.getByRole` 未用 `within()`）；弹窗 6 项（复用接到不匹配标签、`<summary>` 当 label、空度量与状态行文案重复改独立 `noMeasure`、同值触发“行变化”）；工作台以旧 `initial` 快照重挂致删连接后仍显示 Alpha，改每次 `mount()` 重新 `storage.load()`，由此发现复用门控缺“连接仍存在”（真实缺陷），补 `reuseNoConnection`。Rust 4 项编译错误（move 后用值、`format!` 拼接、越界 revision 被 CHECK 拒、`let-else` 移动）与 3 项期望修正（含点字段属门控、字节上限需真实越界夹具、反序列化层拒绝非验证层）。

特有待验：真实 SQLite 上 v8 → v9 在已有工作区/固定筛选/Data Views/查询库数据上的往返与失败回滚、文件锁与并发写、只读与损坏报错、重启后定义仍在不执行；真实 ES 复用应用后能否执行（doc values、间隔/时区写法、`size` 放大）；面板与保存区焦点、删除确认键盘可达、复用禁用原因播报、窄窗条目行布局；三平台 `chart_definitions_*` IPC 往返。

## 2026-10-11 Q06a 图表定义本地交换（dev 线）

基线 `43aa301`。选中定义 → 生成文档 → 原生保存或浏览器下载；选文件 → 逐来源映射 → 审核 → 追加写入；导入后仍须匹配标签 + 显式复用 + 预览 + 应用。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 格式 | `escope-chart-definitions` v1：`{format,version,connections[{key,label}],definitions[{key,name,connectionKey,index,draft,measure}]}` | 封闭形状，定义体沿用存储校验（未知键、非字面量选项、未知指标、度量不归属即拒），不规范化放行 |
| 内容 | 目标模式、分组/指标名称类型字段、size/间隔/时区字面量、绘图度量、不透明来源标签 | 不带端点、真实连接 ID、认证类型、凭据引用、密钥、解析结果、绘制值、字段证据、时间边界、结果、PIT、历史或草稿 DSL |
| 导出 | 从冻结库快照选择 → 审核完整文档 → 显式保存 | 未选不产文档；选中项已消失报 `chartDefinitionConflict`；不改库 |
| 导入 | 读取 → 每个来源映射到本地连接 ID + 端点（按 profiles 现场核对）→ 审核 → 一次追加，全部新 ID | 不覆盖 ID/定义/草稿/收藏，同名同形状可重复；不按名称/当前选择/来源标签重绑；映射不全/重复/未知键/形状不符即拒，profiles 变化 `exchangeTargetChanged` 需重审；不开标签、不改复用门控 |
| 写入 | `chart_definition_exchange_import` 同一 immediate 事务内读回、比较 revision、重检映射 ID/端点后追加，返回整段库供前端逐字核对 | `chartDefinitionConflict`/`exchangeTargetChanged`/`exchangeTooLarge`/`invalidResponse` 不写盘；不修复损坏/未知版本；核对不符即未知完成需重载 |
| 文件 | 原生打开/保存对话框定路径；同目录隐藏 `.<名称>.tmp-<uuid>`（`create_new`）→ 全量写 + `flush` + `sync_all` → `rename`，失败只清理自建临时文件 | 浏览器为 session 内存 + 显式下载请求，不跨重启、不验证磁盘；取消/失败/超限/未知可辨，不降级 |
| IPC | `chart_definition_exchange_read`/`_save`/`_import` 三条受限命令，请求体封闭；UI 沿用查询交换样式 | 不收任意路径/URL/方法/认证头，不读密钥库，错误码沿用交换集合；不承诺 Kibana Saved Objects 兼容 |

偏差与说明：**不支持未绑定导入**——定义库要求 `connectionId` 必填合法、新增 ID 同事务确认连接存在、同 ID 不换绑，未绑定导入会成为永不匹配又不能重绑的死定义；TS 映射类型收紧为非空 target，Rust `target: null` 在反序列化层拒绝；已删除连接的历史定义仍显示未绑定、复用禁用，交换不改其 ID；要支持须先版本化定义库（v2 可空绑定）。来源标签仅为显示提示（可含用户自定义名），`buildChartDefinitionExchange` 只读 `id/displayName`。敏感检查与查询交换共用（TS `SENSITIVE_KEYS`/`SENSITIVE_TEXT` 导出复用，Rust `sensitive_text`/`SENSITIVE_KEYS` 改 `pub(crate)`），任意层级键名或认证样式字符串命中即 `exchangeSensitive`；无标签字面量识别不了，仍需用户预览核对。

配额：文档 1 MiB（读前按字节、解码后按序列化长度），定义与来源各 ≤100，超限 `exchangeTooLarge` 不部分导入；合并后库须 ≤100 条且 ≤256 KiB，否则 `exchangeTooLarge` 既有条目不动；名称/目标/字段/度量/指标/size/间隔/时区同上批（不 trim、不转数字、不改默认值）；来源标签 ≤120 码点、非空、无控制字符；映射端点 ≤2048 字符（仅校验提示，不写入），否则 `exchangeMappingRequired`。

自动化：Rust `chart_definition_exchange` 14 覆盖上表/偏差/配额（另含敏感项文本与类型化两路径都拒、陈旧 revision 先冲突、重载后重复导入再追加不改首批、其他存储不受影响、文件限额/非 UTF-8/缺失/目录各自失败、原子写回读不规范化）；受影响模块 **189**（本模块 14 + 上批 9 个模块），`cargo fmt --check` 干净，`--lib` 全量仍因同一 `connection::tests` 超时未收尾。前端有效 **31 文件 550 项**（新增 4 文件 43：领域 21、服务 8、对话框 11、工作台 3；相邻 17 文件 373；共享 10 文件 134），**15 文件 lint**、typecheck/构建通过；覆盖上表，另含共用夹具 `tests/fixtures/chart-definition-exchange-v1.json`、导出不含 `endpoint`/`dsl`/`results`/`updatedAt`/`revision`、删除连接的来源标签回落为不透明键、`target:null`/额外键/非法 ID 映射拒绝、6 类敏感键与 4 类认证字面量、请求体只带 `{bundle}`/`{bundle,reviewed}`/`{bundle,mappings,expectedRevision}`（多带 `path` 即 `invalidResponse`）、改绑/少行/同 revision 算未确认、CAS 后重放同一审阅冲突不加行、下载只报 `downloadRequested`、对话框**无未绑定选项**、坏文档报 `exchangeInvalid`/`exchangeVersion`/`exchangeSensitive`、二次点击不重复追加、工作台导入后 `execute`/`openPit` 仍为 0 且复用应用只改 `aggs`（`by_host: terms host size 20`）。主 JS **1,575.44 kB**（+20.99）、CSS **132.84 kB**（+0.07）；schema 仍 v9，零新增依赖。

命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib` 分别跑 `chart_definition_exchange`、`chart_definitions`、`query_exchange`、`storage::`；`cargo fmt --check --manifest-path src-tauri/Cargo.toml`；`npm test` chart-definition-exchange{,-service,-ui}、app-chart-definition-exchange；`npm test` chart-definitions{,-service,-ui,-build-ui}、app-chart-definitions、query-aggregation-build{,-ui}、query-aggregation-{charts,charts-ui,chart-loader}、query-aggregations{,-ui}、query-exchange{,-service,-ui}、app-library-integration、workspace-panels；`npm test` app、app-query-integration、app-index-tabs、app-data-views、app-pinned-filters、query-library-ui、build-dependencies、packaging-config、domain、workspace-tabs；`npx eslint src/domain/{chart-definition-exchange,chart-definitions,query-exchange}.ts src/services/chart-definition-exchange.ts src/features/query/{useChartDefinitions.ts,ChartDefinitionExchangeDialog.tsx,ChartDefinitionsDialog.tsx,QueryWorkspace.tsx} src/app/App.tsx src/locales/chart-definitions.ts` + 4 个新测试与 chart-definitions-ui；`npm run build`。

首轮：领域 3 处夹具口径（本地 ID 写进名称致自身命中、`Math.random()` 含点标识符被 `identifier` 语法拒改自增、配置少传致标签回落）。Rust 5 项因敏感扫描晚于结构校验，把“度量里的 `Bearer …`”报成 `exchangeInvalid`，改 validate 先扫原文（同 TS `scanLiterals`）；另 4 项测试口径（未核对 target 改断导入阶段 `exchangeMappingRequired`、未用来源与空标签夹具、容量夹具 3 条改 4 条并显式算字节、循环内重复 `save_chart_definitions(0, …)`）。UI 真实缺陷：错误分支只翻译 `common` 命名空间，未命中交换码把原始 key 显示到屏幕，改全部带 `chartDefinitions:` 前缀；另“选择清空后审阅框消失”误断为取消勾选（元素已卸载），改断入口消失并重选须重审。由此 target 类型收紧非空，浏览器与桌面共用拒绝路径。

特有待验：原生对话框取消/覆盖/不可写/磁盘满/系统中断、`.<名称>.tmp-<uuid>` 不残留、导出实际字节、处理未返回时关闭；v9 单行追加写、文件锁与并发、只读与损坏、重启后导入定义仍在不执行；同一文档对照浏览器下载与桌面保存；真实 ES 导入复用应用后能否执行及“导入不执行、应用后才运行”；对话框焦点顺序（选择列表 → 映射下拉 → 审阅复选框 → 主操作）、映射必填与禁用原因播报、窄窗映射行；三平台 `chart_definition_exchange_*` IPC 往返。

## 2026-10-11 Q06a 进阶图型首批：折线右轴第二度量（dev 线）

基线 `976bc44`，计划 §10.2 批次 4 进阶图型自此开始。只在 date_histogram 折线上叠加同一已核对条目的第二个已读取度量；不含 terms 双轴、参考线、注释、图例筛选、同比环比、公式、图层或持久化。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 输入与图型 | 同一条目、同一批返回桶，共用位置轴与 `positionExtent`；仅折线可叠加，`ChartKind` 仍为 `singleValue`/`bars`/`line` | 开关只改绘图输入；terms/单值请求第二度量即拒 |
| 度量与拒绝 | 只取同一 `chartMeasures(entry)`（`doc_count` 或该组直接指标） | 同名 `secondarySame`、不在集合/不属条目 `unknownSecondary`、条目不支持 `secondaryUnsupported`、主度量先验 `unknownMeasure`、第二度量无可绘值 `secondaryNoValues`（两序列都不绘）；均给原因，不静默回落为单序列 |
| 精度与提示 | 每序列各自走通用核对，`data-precise` 逐点标记；`approximate`/`valueCount`/`imprecise`/`sparseSeries` 按度量分组，`bucketStarts` 归“两个度量共用”位置轴组 | 两组不合并、不互相掩盖，无自身提示时不渲染空组 |
| 未绘制清单 | 左/右各一份，逐条给返回行号、原标签、字段、原 token 与原因，标注所属轴 | 不可定位的同一桶键两份都列；各前 10 项后汇总；折线按每序列自身未绘制情况断开 |
| 轴与图例 | 左/右各用自身 `chartValueDomain`（仍含 0）与刻度；轴标题 `左轴：{{measure}}`/`右轴：{{measure}}`（显示截断 20 字符）；图范围行加“左轴度量/右轴度量”、各轴“已绘制（左/右轴）比”及独立成行的“两轴互不可比” | 不共用刻度、不归一化或换算百分比；开右轴前后左序列 `cy` 实测逐点相等；完整度量名与类型在图范围行、`aria-label` 与表格保留；无可点击图例/图例筛选 |
| 模型与交互 | `PlottedChart`（line 分支）加可为 `null` 的 `secondary`（度量/范围/分段/清单/提示/精度计数/绘制数）；“在右轴叠加第二个度量”开关（`role="switch"`）+ 右轴选择器 | 纯会话模型，不进恢复存储、定义库或交换；定义仍 v1 单 `measure`，不存图型/第二度量，schema v9 |
| 外观 | 第二序列虚线 + 空心标记 + 右轴，不靠颜色唯一识别；`forced-colors` 下仍按 CanvasText 描边 | 不重新设计既定原型 |

配额增量：200 桶两序列共用（200 双序列全绘、201 整次拒绘）；位置标签仍 ≤12（`chartAxisSlots`）；每轴各自 `ticks(5)`，不减半不合并（实测 `[0,3]` 出 7 个、`[0,800000]` 出 5 个刻度）；未绘制清单每度量各前 10。

自动化：有效 **21 文件 451 项**（新增 2 文件 27：领域 14、面板 10、集成 3；图表/聚合相邻 9 文件 292 含新增；共享相邻 12 文件 159），**6 文件 lint**、typecheck/构建通过。覆盖上表与配额（含左 `0…3`/右 `0…800000` 刻度独立、200 全绘/201 拒绘、terms 无叠加开关），另含纯函数可重复、`aria-label` 分报两条绘制比；集成：`fetch` 零调用，`onRun`/`onLoadMore`/`onCancel`/`onViewChange`/`onLayoutChange` 未触发，切换所选接收页后重开为单序列、开关不带旧状态，中英切换几何与刻度一致、双语键数一致。主 JS **1,582.13 kB**（+6.69）、CSS **133.38 kB**（+0.54）、绘图 chunk **41.75 kB**（+1.30）；零新增依赖，复用已锁定 `@visx/{scale,shape,group}`。

命令：`npm test` query-aggregation-charts-dual-axis{,-ui}、query-aggregation-{charts,charts-ui,chart-loader}、query-aggregations{,-ui}、query-aggregation-build{,-ui}；`npm test` 定义批 5 个与交换批 4 个新测试 + query-{result,executions}、app-workspace-recovery；`npx eslint src/domain/query-aggregation-charts.ts src/features/query/charts/{AggregationChart,AggregationChartCanvas}.tsx src/locales/query-aggregation-charts.ts` + 2 个新测试；`npm run typecheck`；`npm run build`。

首轮：领域 3/14（terms 夹具多引号致 JSON 非法；可绘图行 `doc_count` 误当缺失；`valueExtent` 已绘制范围误当含 0 轴域，改断 `chartValueDomain`）；面板/集成 7/13（`plottedOf` 用中词语序断言英文文案；负断言应用 `queryByText` 而非 `getByText`；“Right axis measure”命中图范围行与选择器两处，改按 `combobox` 查；空分组不渲染、不能作双轴判据，改断右轴选择器；`ticks(5)` 在 `[0,3]` 返回 7 个而非 4 个；新到达接收页误当应关闭当前图，改为切换所选页；断言 `f.f.pages` 时夹具工厂漏返回 `pages`），修正后全绿。

特有待验：两轴刻度与轴标题在窄窗/长度量名下重叠、右轴旋转文本；虚线空心标记在四强调色/高对比下可辨、色觉不依赖颜色、两序列同点重叠遮挡；双轴长摘要、两提示组与两清单归属的播报，开关与选择器焦点；`doc_count` 与 cardinality 近似并图的口径、大计数与长小数在两轴上的呈现、`size` 放大后的 200 桶上限；200 桶双序列绘制/切换耗时、内存与 41.75 kB chunk 首次加载；三平台双轴 SVG 与 tooltip。

## 2026-10-13 Q06 基础图表（main 线）

基线 `17af981`，提交 `d5aab14`；原依据当时计划 §10.33 与用户指令。独立实现：单值指标卡片（Metric Stat Card）、单层 Terms 条形图（Terms Bar Chart）、单层 Date Histogram 折线图（Date Histogram Line Chart）。

| 模块 | 交付 | 边界 |
| --- | --- | --- |
| 单值指标 | sum/avg/min/max/value_count/cardinality 测量卡片 | 保留精确原文 token；`cardinality` 标近似，`value_count` 标值数量而非文档数；一键复制，缺失/null 明确显示 |
| Terms 条形 | 矢量 SVG，`doc_count` 与桶内直接子指标可切换 | 自动比例尺，桶标签 strip 外层引号，超视口横向滚动；随图告警 `doc_count_error_upper_bound` 与 `sum_other_doc_count`（截断桶）；非有限数字标为未绘制（unplottable），不静默归零 |
| Date Histogram 折线 | 矢量 SVG 折线 + 渐变面积，数据点高亮与悬浮 Tooltip，`doc_count` 与子指标可切换 | 不自动补桶、不推结束边界，保持时间轴原顺序，标注未补桶声明 |
| 视图切换 | 桶聚合“聚合表格 / Bucket table”与“图表 / Chart”双模式 | 默认表格，状态只在会话；切换不发查询、不改或执行 DSL、不改 PIT |

自动化：**4 文件 116 项**——`query-chart` 5（`parsePlottableNumber` 精度与非有限拒绘、`buildMetricChartData` 近似/值计数标注、`buildTermsBarChartData` 桶映射/子指标/截断桶/拒绘计数、`buildDateHistogramChartData` 不补桶与选项提取）、`query-aggregations-chart-ui` 2（Terms 表格/条形切换、SVG 与截断桶提示；折线、时间轴文本与免责声明）、回归 `query-aggregations` 88、`query-aggregations-ui` 21。`npm run lint` 0 error/0 warning、`npm run typecheck`（strict）、`npm run build`、`npm audit --omit=dev` 0 漏洞。主 JS **1,498.57 kB**、CSS **128.45 kB**（据原计划）；无新依赖/Rust/IPC/schema 变化，schema v8。

特有待验：多屏高 DPI 下 SVG 抗锯齿与像素渲染；上百桶横向滚动平滑度与性能；复杂时区与 DST 时间戳标签的本地化排版。

## 2026-10-13 Q06/Q06a 聚合构建与定义保存（main 线）

基线 `d5aab14`，2026-10-15 随检查点 `3fccd6c` 提交；原依据当时计划 §10.34 与 backlog。

| 模块 | 交付 | 边界 |
| --- | --- | --- |
| 可视化构建器 | 单值指标（六类）与单层桶（terms/date_histogram，可带直接子指标） | 最多 32 个顶层聚合定义、每桶 16 个直接子指标；按同连接、完全相同目标的已核对 field caps 拦截：非数值字段阻断数值指标、非日期字段阻断 `date_histogram`、不可聚合与 text 字段提示 `fielddata` 风险、冲突字段明确标记 |
| 无损 DSL 预览与应用 | 纯文本与 JSONC 语法树解析，预览根 `"aggs"`/`"aggregations"` 变更对比（DSL Diff） | 生成 DSL ≤256 KiB；只精确替换或新增顶层 `"aggs"`，完整保留原 query、bool filter、高阶字段与时间范围绑定；显式应用，**不自动执行**，**不改已执行快照与 PIT** |
| 定义保存与复用 | Saved Charts 库：名称、连接 ID、索引目标、默认图表偏好（metric/bar/line/table）与聚合子句 | 独立表 `saved_chart_library`（单例 ID=1，版本 CAS 递增修订号，单行 256 KiB，最多 100 条）；删除连接保留定义身份、不级联删除（明确标识连接丢失、不可重绑）；一键复制定义 JSON 与全量导出 |
| 结果快捷保存 | 结果“聚合 / Aggregations”列表与图表卡片顶部“保存为图表定义 / Save as Chart” | 从已解释执行响应提取字段、指标类型与桶类型回填保存对话框；冻结本次结果身份，不回填未返回字段、不发额外查询（合并批改为按执行 rawDsl 读取） |

自动化：Rust `cargo test --manifest-path src-tauri/Cargo.toml saved_charts` 7 项：`saved_charts::tests::{empty_library_is_valid,valid_definition_validates_and_roundtrips,invalid_chart_types_and_ids_are_rejected,invalid_aggregation_clauses_are_rejected,invalid_sub_metric_is_rejected,over_sized_stored_json_fails_closed}`（空库、定义与子指标往返、非法图表类型/超长名称/脏字符 ID、缺必填字段/非法聚合类型、非法子指标、超 256 KiB 单行）与 `storage::tests::saved_charts_migration_preserves_v8_rows_and_reopens`（v8 → v9 保留旧数据并建表）；`cargo fmt --check` 0 差异。前端 4 文件 17 项：`saved-charts` 7（解析与边界、带子指标桶、超长 ID/名称与超 32 子句拒绝、ISO8601 时间戳严格校验防篡改、`sameChartDefinition`）、`query-aggregation-builder` 6（numeric/date/keyword/text 适宜性、生成聚合对象、从 rawDsl 反解子句与子指标、JSONC 差异预览与无损根 aggs 替换、超 256 KiB 拒绝）、`saved-charts-ui` 2（列表/加载/复制/过滤；搜索与空态）、`aggregation-builder-ui` 2（添加 terms 与子指标并应用）。回归 `query-aggregations` 88、`query-aggregations-ui` 21、`query-aggregations-chart-ui` 2、`query-chart` 5、`app-query-integration` 5；`npm run lint` 0/0、typecheck strict、`npm run build`；`npm run build:prototype && npm run test:prototype` 16 项。

特有待验：真实集群多索引通配符字段能力下拉提示的流畅度；极端深层 JSON DSL 可视化替换后 Monaco 重绘与滚动位置保持；Windows NSIS 桌面 SQLite 实际写入与重启后图表库读取一致；高对比与读屏下子指标嵌套折叠的提示。

## 2026-10-15 Q06/Q06a main/dev 合并

合并本地 main 与 `origin/dev`，提交 `8affb73`（仅存于备份分支；现 `main` 的同树线性提交为 `1144378`）：共同基线 `17af981`，本地 `d5aab14`，远端 `491bf48`，未丢弃任一分支提交；接手时未提交的本地图表/保存/面板工作先存为检查点 `3fccd6c`（此前 5 文件 22 项与 typecheck 通过）。README 简化、`package.json` 的 `seed:es` 与未跟踪 seeder 单独保留，不运行、不纳入合并。派发的 OMP 存储任务异常退出、无有效报告（其生成的两份分支原文件副本经 Git blob 哈希核对后移至系统临时报告目录），冲突处理、兼容代码与独立验证均由主代理完成，派发不计为审查证据。

| 范围 | 结果 | 边界 |
| --- | --- | --- |
| 图表与构建 | 统一接入 Visx 图表、受限分组/指标构建、定义保存/复用与本地交换，保留折线双轴 | 无重复主工具入口，原本地实现/测试保留；原桶表继续可见，不自动查询 |
| 旧库 | 图表定义库中的旧库兼容入口，保留旧定义原文与身份 | 仅同连接/精确目标且无损支持时播种审核；含排序、`min_doc_count`、混合形状等的旧定义不丢弃这些成员后复用 |
| 执行快捷保存 | 结构化核对执行 rawDsl 与原聚合定义，保存实际字段、请求 size、间隔/时区与主度量 | 不从响应桶数、指标名或草稿推断；未知选项/元数据拒绝；全文字面量确认，不存结果或第二度量 |
| 生命周期 | 新快照、离开结果视图、换接收页/聚合即关闭保存对话框 | 旧执行来源与当前草稿分离；保存不执行、不改 DSL/PIT |
| 面板 | 保留结果拖动与最大化；修复隐藏编辑器被 flex 样式显示、跨索引筛选栏被隐藏 | 仅逻辑/结构验证 |

数据库兼容：历史迁移 `009_saved_charts.sql`、`009_chart_definitions.sql` 原样保留，新增 `010_merged_chart_libraries.sql`：新建/v8 库走原 chart_definitions v9 后升 v10，任一已有 v9 或两表并存的 v9 只补缺表；已有 JSON 字节、修订号、定义 ID、连接身份原样保留，不自动转化或合并库；按 SQLite 返回的已知历史 DDL 指纹核对，缺两表、异常列/约束/同名视图拒绝，不自动修复；两表保持原 singleton、256 KiB 与 JS 安全 revision CHECK 且独立 CAS，保存/导入的连接检查保持；迁移与版本变更同事务，损坏文档不改写、相关库读写继续拒绝，其他库不伪造旧数据；未来 schema 拒绝，旧连接、凭据、视图、固定筛选与工作区数据不重写。

自动化：前端有效 **32 文件 483 项**：`npm test` 模式 `chart-definition query-aggregation query-chart saved-charts aggregation-builder results-resize-handle app-query-integration app-query-time-range app-query-sort app-query-filters app-index-tabs`，另单跑 `app-query-filters` 及其 `-t "does not hide a locked-index"`。首条与 Rust/build/lint 并行时 481/482（筛选设置往返用例达原 5 秒超时），停掉其他重检查后该文件 16/16 单独通过、未提高阈值；新增面板跨索引用例单独通过，按 483 个唯一用例计，不累加之前 7 文件 53 项或检查点 22 项。图表/表格各显示截断提示致定位器不唯一，改精确文案；修正测试桩参数类型与最大化按钮完整名称。Rust：`cargo test --manifest-path src-tauri/Cargo.toml storage::chart_library_merge_tests` 迁移/回滚/异常结构/未来版本/独立 CAS **8/8**；`npm run test:rust` 全量 **458 通过、6 默认忽略**（含这 8 项，未启用真实服务与密钥测试）；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`npm run lint`（含补充 lint）、`npm run typecheck`、`npm run build`、`git diff --check` 通过；未做无关依赖升级、严格 clippy、原型或安装包构建。

特有待验：两个实际桌面 v9 数据库副本的升级、重启、只读/磁盘故障与旧库读取；最大化/拖动与 Monaco 布局；真实 ES 双轴语义与部分结果。

## 2026-10-15 Q06a terms 第二度量（合并后）

基线 `8affb73`（合并提交），提交 `18f90d8`（均仅存于备份分支；现 `main` 同树提交为 `b884a44`）。

- 同一已核对 terms 条目可选第二个已返回度量；两组柱共享原桶槽位、标签与顺序，各用独立值域与左右刻度。柱形并列，主柱实心、第二组空心虚线；分组时主柱变窄但 y 坐标/高度不变，类别槽位不变。
- 原 token、缺失/null、真实 0、负值、近似与精度损失分别保留，每轴独立未绘制清单；terms Top N、计数误差与遗漏属共有桶范围，按共享提示呈现，不归到另一度量的数值精度。
- 未知/同名度量、无可绘值整次拒绝，不退回单序列；有限数值相减仍可能溢出，故新增左右轴跨度拒绝，条形与既有折线均不再为此输出 NaN 坐标。
- 双轴不翻倍 200 桶/12 类别标签；不补桶、排序、跨页合并或推断单位可比。
- 保存仍为 v1 单 `measure`：双轴开启时结果快捷保存只存主度量，不写第二序列、结果或显示开关；无新依赖、IPC、定义版本或 schema 迁移。
- 合并兼容补强：复查 `8affb73` 的 v9 DDL 指纹时，新用例复现 CRLF 版历史迁移被拒（真实缺陷）；仅在比较指纹时把 CRLF 统一为 LF，两版本表原文、JSON、修订号不写入或转换；其他 DDL 差异、缺表、损坏结构与未来 schema 仍拒绝，不放宽库、凭据或授权校验。

自动化：`npm test` 模式 `query-aggregation-chart query-aggregation-bars query-aggregations chart-definition-result`、`npm run typecheck`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml storage::`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`。前端最终 **11 文件 209 项**（新增条形领域 10、UI 与结果生命周期 6，相邻折线跨度回归 1，另保留图表/读取/延迟加载/双轴/结果保存回归），**9 文件定向 ESLint**、typecheck、构建通过；Rust 存储 **57/57**（含 CRLF 回归），合并批全量 458/6 ignored 为前批证据，未重复全量/clippy。初轮领域 7 红：6 条命中尚未支持 terms 第二度量的旧逻辑，1 条误用小数 cardinality 夹具（改 sum 精度用例并独立核对 cardinality 整数近似）；原“不提供 terms 开关”用例按新范围更新；CRLF 用例先失败为 `storageUnavailable`，修正比较后通过，JSON/修订号原样核对。主 JS **1,612.79 kB**、CSS **142.07 kB**、绘图 chunk **42.52 kB**。暂存 diff/LF/冲突标记/文件范围检查通过，用户 README/测试脚本改动不纳入；本地 Vite 预览启动被执行策略拦截，未做浏览器/WebView 巡检。

特有待验：真实 terms 多索引/FLS/误差/部分结果与双轴不同单位的理解；真实 v9 数据库副本的跨平台换行与桌面升级；200 桶并列柱、长轴名、大字号下的布局，空心虚线在日夜/高对比下的辨识。

## 2026-10-15 Q06a 会话级参考线首批（合并后）

基线 `18f90d8`，提交 `7fda07c`（均仅存于备份分支；现 `main` 同树提交为 `6968816`）。不含注释、公式、同比环比或参考线持久化。接续：原会话 `01a13ed0-b4c8-7e20-8ca2-079127df129f` 三次 `rate_limit_exceeded` 后被手动中断（非测试长跑、非已交付），末次测试退出码 0 但未完成工作台验证、构建、交接或提交；本会话只收口已开始的参考线、不重做双轴，下列验证均为本次执行，旧会话与前批跑分不计入。

- terms 条形与 date_histogram 折线复用 Visx 运行时，显式添加/编辑/删除参考线；编辑须明确应用，取消或 Escape 保持旧线；单值指标无此入口。
- 每图共用最多 4 条，轴外线也计入；到上限仍可编辑/删除，删除后只复用空出的编号。须明确选左/右轴，无已绘制第二度量时不能选右轴，不默默换绑到另一度量。
- 原值须为 ≤4,096 字符的严格 JSON 数字，保留小数尾零、指数与负零拼写；非法、非有限、非零下溢与跨度溢出明确拒绝并保留原输入。`doc_count` 只接受精确安全整数，其他度量复用最短往返核对，精度损失单列双精度值与原文。
- 参考值不参与轴域，不改原柱/点几何、两轴刻度、桶顺序/原值、折线断口或画布尺寸；用原始十进制比较轴边界，不把舍入后的轴外值钳到边界；轴外只列明高于/低于当前范围，不绘制。
- 图外图例逐条显示完整原值与归属度量，长值可聚焦滚动；重合高度逐条提示；4 种虚线与编号对应，不只靠颜色，不在绘图区叠放长标签；文本不作 HTML 或脚本解释。
- 会话绑定执行来源、所选接收页、聚合及两侧度量：任一变化、关闭双轴、图表拒绘、关闭图表或离开结果/标签/设置即清理已应用线与未提交编辑；同一执行续页不换所选页，草稿变动不改旧图执行来源。
- 编辑器 IME、Ctrl/Cmd+Enter 不误应用或触发工作台运行，正常 Enter 明确提交；删除后聚焦图例标题，弹窗取消沿用 Modal 恢复触发器焦点。
- 添加/编辑/删除不请求字段、不查询、不开关 PIT、不改 DSL；工作台测试核对恢复库、查询库、定义库与请求原文不变。结果快捷保存仍只存主度量，不带参考值或第二序列。schema v10、IPC 与依赖不变；不扩 Dashboard、图层或注释。

自动化：`npm test` 模式 `query-aggregation-chart-references chart-definition-result-ui` 首轮 **5 文件 82 项**；`query-aggregation-chart query-aggregation-bars query-aggregations chart-definition-result` 相邻 **15 文件 286 项**全过（含首轮范围，不相加），覆盖上列各项及既有聚合读取/图表/延迟加载回归；`npm run build`（内含 `tsc --noEmit`）。**12 文件定向 ESLint**（7 个 TS/TSX 生产文件 + 5 个测试）通过。主 JS **1,622.40 kB**、CSS **144.13 kB**、图表 chunk **43.25 kB**，不调警告阈值掩盖大包。未改 Rust/原型/依赖；未运行 seeder，`README.md`、`package.json`、`scripts/seed-es-test-data.mjs` 用户改动保留不提交（接手与提交前核对 SHA-256）；`git diff --check` 对 README 原有行末双空格的提示不处理，本批暂存范围单独检查。

特有待验：窄窗/200%/长名称与 4,096 字符原值的滚动与选择复制，图例与参考线可辨性；四强调色/高对比下的重合线与左右轴单位理解；读屏焦点恢复、原生下拉与 IME；真实 ES 极端值/部分结果，200 桶加 4 线的渲染时延与内存，桌面重启后无参考线恢复。
