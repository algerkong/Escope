# Q06 有界基础聚合结果

日期：2026-10-10。从干净 `f2c226c` 接手，沿用 `main`。
状态：开发、领域/JSDOM/工作台/类型检查与构建自动化通过；真实 ES、原生、性能和跨平台待验。
本批只读取和展示已有查询的聚合响应，不交付聚合构建、绘图、定义保存或 Dashboard，不关闭 Q06/Q06a。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 类型 | 顶层 sum/avg/min/max/value_count/cardinality；单层 terms/date_histogram，可带直接单值指标子项 | 按不可变执行 rawDsl 识别；不从 value/buckets 形状、typed key、当前草稿或 field caps 猜类型 |
| 精度 | 所有数据值/计数/格式字符串保留原 JSON token，缺失、null、0 和空桶分开；count 指标拒绝负数/小数等不支持的计数形状 | 原 token 精确不代表 ES 数学计算精确；不转换成 JS 浮点数绘图、不填 0、不套当前 Data View 格式 |
| terms | 整体/逐桶 doc_count_error_upper_bound、sum_other_doc_count、请求 size/shard_size/order 等原值 | -1/未报告独立；Top terms 不当完整分类，桶计数不相加为文档总数；不把遗漏计数当遗漏类别数量 |
| 日期桶 | 数字 key、可选 key_as_string、显式 keyed 成员名、calendar/fixed/旧 interval、时区/offset/bounds 原值 | 不解析或猜日期、不从相邻 key 推结束边界、不补空桶、不将 keyed 成员名冒充数字 key |
| 统计范围 | 执行来源 ID/连接/端点/精确目标/开始时间；当前接收页和该页 partial 单列 | 不用命中总数或已加载文档数当聚合总体；post_filter 与聚合分开；runtime/聚合脚本不承诺被 PIT 冻结 |
| 不完整性 | 超时、提前终止、分片失败、未报告失败分片、跨集群报告分别保留提示 | 跨集群完整性仍需原响应核对；不把授权、HTTP 成功、空值或当前字段能力当完整统计 |
| 接收页 | 明确选择已接收页，默认首个接收页；新续页不替换当前选择，各页独立解释和复制 | 不累加/合并 PIT 聚合；不额外请求、自动续页或重跑；原 JSON 视图仍显示最新页 |
| 原文回退 | 未请求、未支持、未返回和响应结构不支持分别显示；执行定义/执行 DSL/聚合响应/原接收页按需展开及原文复制 | 高级/管道/多层/未知类型不丢成员后伪装成支持；通用聚合树未实现；超显示限额仍可明确复制已有原页 |
| 交互 | 原结果区域增加会话内聚合视图，沿用 SelectControl/Lucide/token/双语/可见焦点；每次仅显示一个聚合、50 桶分页 | 不增加路由/管理首页；聚合页隐藏“导出已加载结果”文档入口，避免被误当成桶导出；文档导出合同未改 |
| 生命周期 | 新快照（包括复用 request ID）、离开标签/设置清理视图，切换聚合/接收页重置桶页和原文展开 | 聚合视图/页码/选择/解析结果不持久化；原 resultView 仍是 table/json，旧文档布局和恢复保持 |

新领域模块 `src/domain/query-aggregations.ts` 复用 `jsonc-parser` 与既有无损 JSON reader，
先扫描限额再建树。新 `QueryAggregations` 只在会话聚合视图被明确打开时挂载/解释；
不修改 `query-result.ts`、执行 hook、后端 DSL、PIT 或 IPC。返回对象只有纯数据，不执行脚本/HTML/URL。
桶中的缺失直接指标不回查字段或旧响应；一项响应结构不支持时保留其完整原文，不显示部分桶子集。

## 配额

| 对象 | 本批限制 | 超限行为 |
| --- | --- | --- |
| 原始 DSL/接收页 | 256 KiB / 1 MiB，按 UTF-8 核对 | 整次聚合解释拒绝，文档结果和原文入口保持 |
| JSON 结构 | 64 层容器、每份输入 100,000 token、每数字 4,096 字符 | 扫描阶段拒绝，不等递归解析溢出 |
| 定义/名称 | 顶层与直接子指标合计 32 项，未匹配响应项也计数；展示名称/类型名 1 KiB | 整次解释拒绝，不截取前 32 项 |
| 支持的桶 | 所有已解释聚合合计 4,096 桶；每次 DOM 仅 50 桶 | 超限整次解释拒绝，不丢后面的聚合或桶 |
| 原文展示 | 按需挂载，DSL 256 KiB/响应 1 MiB；长值/选项内部滚动 | 超显示限额不渲染大段正文，明确原页复制仍保留已有原文 |

不将上述边界或 JSDOM 行数当作原生内存、耗时、滚动帧率与可访问性达标证据。
整份结果的接收/已有 JSON 格式化/累计文档内存仍走原合同，本批没有宣称全管线已经有界或完成虚拟化。

## 本次验证

前端有效覆盖 **10 文件 292 项**：主体 **10 文件 291 项**通过，
导出入口复查后 **3 文件 89 项**通过，替换该范围原 **88 项**，不重复累加。
**8 文件 lint**、最终 typecheck/正式构建通过；前端均为 `--maxWorkers=2`，没有提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 新领域 88 项 | 六类指标、原始数字/转义、缺失/null/0、直接指标、两类桶/keyed、错误/截断、原请求类型、未知回退、原型键名安全、独立页/范围/脚本和配额 |
| 新 UI 21 项 | 明确打开/不保存、原值与复制失败、按需原文、页隔离/部分状态、新快照/离开清理、unsupported/无数据、50 桶、日期选项、双语和原文文本安全 |
| 工作台 56 项 | 含新增 3 项：真实前端执行接线的 size-zero 不开 PIT、未知聚合不隐藏文档、续页沿用原 DSL 且各聚合页独立；原工作台回归保持 |
| 其他结果回归 127 项 | query-result、query-executions、result-grid UI、详情/对比 UI、query-library UI、workspace-recovery；未运行无关全量 |
| 构建 | 主 JS **1,486.75 kB**、主 CSS **125.23 kB**；Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB**，原大包警告保留 |
| 文档/暂存 | 18 文件 UTF-8/LF、8 文档/290 本地链接/65 张 GFM 表格、秘密模式及 diff 检查通过；无本机配置或无关文件 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx tests/unit/query-live.test.tsx tests/unit/query-result.test.ts tests/unit/query-executions.test.tsx tests/unit/result-grid-ui.test.tsx tests/unit/document-detail-ui.test.tsx tests/unit/document-comparison-ui.test.tsx tests/unit/query-library-ui.test.tsx tests/unit/workspace-recovery.test.ts
npm test -- --maxWorkers=2 tests/unit/query-aggregations-ui.test.tsx tests/unit/query-live.test.tsx tests/unit/query-library-ui.test.tsx
npx eslint src/domain/query-aggregations.ts src/features/query/QueryAggregations.tsx src/features/query/QueryResults.tsx src/locales/index.ts src/locales/query-aggregations.ts tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx tests/unit/query-live.test.tsx
npm run build
```

首轮新领域 **84**、UI **19** 通过；补入脚本/计数指标/原型键名及页范围提示后进入主体回归。
工作台新增 3 项先独立通过；中间 typecheck 指出四处 ByRole 定位器不接受 `exact` 选项，
移除多余选项后最终构建含 typecheck 通过。独立复审新增“聚合视图不冒充文档导出”反例，
首次确实失败；随后隐藏对应入口并清理已打开的文档导出，最终 3 文件复验通过。
这些早期检查有重叠，均不额外计入最终 292 项。

主代理独占实现、diff 审查与验证，无 OMP/worktree/用户数据库/真实服务或持久服务操作。
无新依赖/Rust/IPC/schema 变更，schema v8、恢复文档 v1、固定库 v3、执行快照合同 v4 保持。
未启动浏览器/WebView/预览服务，未构建安装包；未改原型/Rust/依赖，不重复其全量/fmt/clippy/审计。

## 待验与接续

[集中人工清单](manual-acceptance.md) 保留：

- 授权 ES 精确版本、多索引/FLS、terms 误差/排序/遗漏、多值计数、cardinality 近似、
  真实日期 interval/时区/DST/keyed/边界与缺桶、脚本/runtime 编译和真实成本。
- PIT 续页实际聚合行为、超时/提前终止/分片/跨集群状态、端点/权限漂移与取消。
- 原生日夜/双语/高对比/200%/窄窗、长聚合名/数字/选项、宽指标表横滚、
  原文展开/内外滚动、选择器/分页/焦点/剪贴板/屏幕阅读器、跨平台与重启。
- 4,096 桶/大量指标/大原页的真实解析、切换、复制、内存和原生渲染预算。

下一批 **Q06 基础图表**：复用本批核对过的单页结果，先单值、terms 条形与日期桶折线，
选用项目相容的成熟图表库，绘图数值转换须独立核对范围/精度并保留原 token；
缺失、近似、误差、截断、部分失败与执行来源随图显示，不把拒绘当 0，
不自动补桶、重排为不同语义或从图表交互自动查询，不增加 Dashboard。
聚合构建/全文 DSL 预览应用、图表定义保存 Q06a、公式/比较/图层随后按依赖增量。
Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、
nested runtime/深层条件及 W01/W04 和六方向其余项继续开放。
本批本地提交后创建一个 local 后继，停止写仓库并更新既有监控，不推送、不提前睡眠。
