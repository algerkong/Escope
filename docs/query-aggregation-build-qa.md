# Q06 聚合构建与完整 DSL 预览/显式应用（首批）

日期：2026-10-11。任务：Q06 聚合构建首批。接手 HEAD `2f75f23`，复用 `main`，不建 worktree。
状态：开发、领域/对话框/工作台自动化、lint、typecheck 与正式构建通过；真实 ES、原生交互与性能待验。

本批把“分组 + 指标”形成**待审 DSL**，走既有“完整 DSL 预览 → 显式应用、不自动执行”合同，
与时间范围、单元格筛选、布尔组、服务器排序和 runtime 字段同一套审核机制。
构建不发送请求、不打开 PIT、不执行；应用后的 DSL 仍是普通草稿，需明确运行才生效。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 草稿模型 | 至多一个单层 `terms`/`date_histogram` 分组 + 其直接指标，或无分组的一组顶层单值指标；指标限 sum/avg/min/max/value_count/cardinality | 与聚合读取器可解释的形状一致；管道/公式/多层分组/`top_hits`/composite 不生成，仍只能在 DSL 编辑器手写 |
| 写回 | 只改写顶层 `aggs`（或已有的 `aggregations` 长写法，原地改写，不新建第二块） | `query`、已绑定时间 wrapper、`sort`、`runtime_mappings`、`_source`/`fields` 等其余根属性按原字节保留，由测试逐片段断言 |
| 手写保留 | 不属于草稿模型的顶层条目按原值文本保留，并在弹窗内列出“保留的手写聚合” | 保留条目的**值文本**逐字节不变；块内条目之间的空白/换行在块被改动时重新排布，token 与转义不变，仍需在完整 DSL 预览中核对 |
| 名称冲突 | 生成的名称若与保留条目同名则整体拒绝，不覆盖任何手写定义 | 可表达的同名条目是可编辑行，其改动经预览后显式应用，不属静默替换 |
| 拒绝 | 多个可表达分组、分组与顶层指标混排、超 31 指标、`aggs` 与 `aggregations` 并存、非对象聚合块、非法 JSON/未替换参数、名称/大小/间隔/时区形状错、证据不符、定义总数超 32、构建后读回不一致 | 整体拒绝且不丢成员后放行；拒绝只作用于本批构建，不代表查询被 ES 拒绝 |
| 选项 | terms 可选 `size`（1–1000 整数，留空不写）；date_histogram 需一个 `calendar_interval`/`fixed_interval`，可选 `time_zone` 透传 | 客户端不解析日期、不补空桶、不推结束边界、不做时区校验；`extended_bounds`/`hard_bounds`/`offset`/legacy `interval`/`keyed` 不生成，保留原文 |
| 文档计数 | 不构建 count 聚合：文档数取执行返回的命中总数，分组内计数取桶 `doc_count`（图表已按 `doc_count` 可选度量绘制） | 不为“计数”伪造 `filter`/`global` 聚合；分组存在而指标为空时只收集 `doc_count` |
| 字段证据 | 按同连接/端点/完全相同目标的当前 field caps 与当前 DSL `runtime_mappings` 声明逐行给出类型与来源；可显式重新检查 | 证据不是权限、不是聚合成功保证；要求 aggregatable、单一非 metadata 类型、非 nested、非含点路径；保守类型矩阵超出即拒绝 |
| 审核失效 | 预览结果按草稿行对象与字段读取身份绑定，行/目标/草稿/证据变化即失效需重预览；应用前再次核对 `matchesQueryDraft` 与目标身份，应用时重新从源 DSL 读回 | 未应用的行只在弹窗 React 状态内，不写入恢复存储；应用后的 DSL 沿用既有草稿/历史/恢复规则 |
| 运行边界 | 审核打开期间“运行”和“保存草稿”禁用并给出原因；索引标签不渲染查询编辑器工具条，因而无构建入口 | 索引标签继续只用显式“为该索引新建查询”入口，构建不改写锁定目标；不新建 Dashboard 或管理首页 |
| 可访问性 | 紧凑 token 风格、Lucide 图标、中英双语键、可见焦点、每个控件显式 aria-label、证据行 `role="status"`、拒绝提示 `role="alert"` | JSDOM 只验证可达名称与状态文本；原生焦点顺序、屏幕阅读器朗读与 IME 单列人工验收 |

## 配额

| 对象 | 本批限制 | 超限行为 |
| --- | --- | --- |
| DSL | 源与最终文本各 256 KiB（沿用聚合读取 `dslBytes`） | 整体拒绝，报告 `tooLarge`，不改草稿 |
| 指标数 | 每组最多 31 个（与读取器 32 定义上限留出分组位） | 整体拒绝，不截取前 N 个 |
| 定义总数 | 分组 + 指标 + 保留条目及其直接子项 ≤ 32 | 整体拒绝 `tooComplex`，与读取器同一口径 |
| 名称/字段 | 各 1 KiB、非空、无首尾空白、无控制字符、非 `$param`；分组内名称唯一且不与保留条目冲突 | 拒绝并区分 `invalidName`/`invalidField`/`duplicateName`/`nameConflict` |
| terms size | 整数 token，1–1000，留空不写入 | 拒绝 `invalidSize`，不静默使用默认值 |
| 间隔/时区 | 间隔 64 字符、时区 100 字符、均不得含首尾空白 | 拒绝 `invalidInterval`/`invalidZone`；写法由 ES 校验，客户端不解析 |
| 保留条目 | 无条数上限，只参与定义总数与字节上限 | 不因块被重写而丢弃；名称冲突时拒绝新生成 |

不把这些边界或 JSDOM 元素数量当作真实 ES 聚合成本、原生布局或可访问性达标证据。

## 本次验证

前端有效覆盖 **23 文件 434 项**：新增 **3 文件 111 项**（领域 95、构建弹窗 13、工作台集成 3），
相邻聚合读取/图表/排序 **8 文件 243 项**与工作台级共享组件回归 **12 文件 80 项**复跑通过；
**8 文件 lint**、最终 typecheck/正式构建通过；前端均为 `--maxWorkers=2`，没有提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 领域 95 项 | 反解两种容器写法与 size/间隔/时区 token、22 类手写条目保留（管道/脚本/额外选项/两层分组/歧义子块/`meta`/数组值/legacy `interval`/`keyed`/bounds/数值间隔/名为 `aggregations` 的条目）、6 类整体拒绝、只改 `aggs` 且其余根片段逐字节保留、空块删除与新建/首/末/唯一属性位置写法、长写法原地改写、保留条目原值文本不变、构建产物交回 `readAggregationPage` 得到 `buckets`+`unsupported` 而非 `invalid`、超字节整体拒绝、托管时间绑定复制与失配拒绝、保守证据矩阵与 runtime 声明只用当前 DSL、名称/形状/配额拒绝、定义总数按保留子项计数 |
| 构建弹窗 13 项 | 由已应用块播种行与保留清单、无块时从“不分组”起、显式预览才可应用、行间改动使旧预览失效、名称冲突拒绝且不提供最终文本、已是最新块时提示未变化、目标失配禁用全部控件、字段读取中/失败/显式重试提示、不可审核的块不给出半成品入口、中英切换不丢已审文本、`fetch` 零调用、指标行重排与移除 |
| 工作台集成 3 项 | 构建应用后 DSL 编辑器等于已审文本且 `execute`/`openPit` 调用数为 0、审核打开时运行/保存禁用并提示原因、取消不改草稿、二次审核播种已应用块（未变化）、托管时间标签与 wrapper 在应用后保留、手写 `percentiles` 保留且复用其名字被拒 |
| 相邻回归 | query-aggregations 领域/UI、聚合图表领域/UI/chunk 加载、query-sort 领域/UI/工作台；未运行无关全量 |
| 共享组件回归 | app-data-views、app-index-tabs、app-query-filters/session、app-pinned-* 四件、app-query-integration、app-library-integration、app-workspace-recovery、app-ai-integration |
| 构建 | 主 JS **1,533.55 kB**（较上批 +31.66 kB）、主 CSS **130.81 kB**（+2.92 kB）、图表 chunk **40.45 kB** 不变；Monaco **3,125.21 kB** 不变，原大包警告保留 |
| 依赖 | 本批零新增依赖，`package.json`/lock 未改；无 Rust/原型/CI 变更，故未重跑其全量/fmt/clippy/审计 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/query-aggregation-build.test.ts tests/unit/query-aggregation-build-ui.test.tsx tests/unit/app-query-aggregation-build.test.tsx tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx tests/unit/query-aggregation-charts.test.ts tests/unit/query-aggregation-charts-ui.test.tsx tests/unit/query-aggregation-chart-loader.test.tsx tests/unit/query-sort.test.ts tests/unit/query-sort-ui.test.tsx tests/unit/app-query-sort.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-data-views.test.tsx tests/unit/app-index-tabs.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/app-query-filter-session.test.tsx tests/unit/app-pinned-filters.test.tsx tests/unit/app-pinned-filter-lifecycle.test.tsx tests/unit/app-pinned-nested-filters.test.tsx tests/unit/app-pinned-runtime-filters.test.tsx tests/unit/app-query-integration.test.tsx tests/unit/app-library-integration.test.tsx tests/unit/app-workspace-recovery.test.tsx tests/unit/app-ai-integration.test.tsx
npx eslint src/domain/query-aggregation-build.ts src/features/query/QueryAggregationBuildDialog.tsx src/features/query/QueryWorkspace.tsx src/locales/query-aggregation-build.ts src/locales/index.ts tests/unit/query-aggregation-build.test.ts tests/unit/query-aggregation-build-ui.test.tsx tests/unit/app-query-aggregation-build.test.tsx
npm run build
```

红绿证据：首轮领域 95 项有 6 项失败，均为测试自身问题——分组夹具少一个右括号、把保留条目“值文本”
当成含名称的整段、`undefined` 走默认参数导致“无字段读取”用例拿到了 catalog、sum 用在 keyword 上
期望 `fieldNotAggregatable`（实际按类型矩阵先报 `fieldUnsupported`，改用 value_count 才命中 doc values 分支）、
字节上限夹具留白不足、以及保留子项计数用例把已被整体替换的分组算作保留。修正后 95 项通过，未放宽断言。
构建弹窗首轮 7 项失败：`Add metric` 用 `getByLabelText` 查询文本按钮、`<details>` 折叠内文本断言可见性、
名称与解析失败同时渲染两个 `role="alert"`（改为统一一个提示区）、以及 `toBeUndefined` 误用；
修正后 13 项通过。工作台集成首轮 3 项失败：Radix 弹窗把背景标记为 `aria-hidden` 导致背景按钮查询失败
（用 `hidden: true` 查询）、显式检查字段前就点预览（无行可读）、格式化后的多行片段被当单行子串断言
（改为 token 级 + `toMatchObject` 结构断言，长整数与转义仍在文本层断言）。
另按 lint 反馈去掉未用导入，并把 `9007199254740993` 的数字面字面量改为文本层断言，避免精度丢失。

主代理独占实现、diff 审查与验证，无 OMP/worktree/用户数据库/真实服务或持久服务操作。
无 Rust/IPC/schema 或 DSL/PIT/恢复合同变更，schema v8、恢复文档 v1、固定库 v3、执行快照合同 v4 保持。
未启动浏览器/WebView/预览服务，未构建安装包。

## 待验与接续

[集中人工清单](manual-acceptance.md) 保留：

- 真实 ES：构建出的 terms/date_histogram 与六类指标能否实际编译执行、doc values/FLS/权限影响、
  `size` 与分片放大、`time_zone` 与 DST、`fixed_interval`/`calendar_interval` 非法写法的服务端报错呈现。
- 原生：新增两个 fieldset 的焦点顺序与键盘可达性、`<datalist>` 补全与 IME 输入、指标行增删后的
  焦点归属、`role="status"` 证据更新在屏幕阅读器下的播报、保留清单与最终 DSL 区域的横向滚动、
  200% 缩放与窄窗下网格换行、日夜主题与高对比。
- 应用后 Monaco 对新增 `aggs` 块的重渲染与撤销栈行为（自动化只覆盖 textarea 路径）。
- 已绑定时间 + 参数模板 + 手写 nested/runtime 目标上重复整条“构建→预览→应用→明确运行”链路。

下一批 **Q06a 图表定义保存/复用/本地交换**：在已交付的读取、绘图与本批构建之上，
保存版本化的聚合/图表定义（查询 + 分组 + 度量 + 显示选择），支持复用、复制与本地交换，
不默认保存结果、改定义不改已执行快照、恢复不执行、承诺范围不外扩到 Dashboard 或 Kibana 对象。
随后再扩公式/同比环比/双轴/图层并沿用同一精度与配额规则。
Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、
nested runtime/深层条件和 W01/W04 不被本批跳过或关闭。
本批本地提交后创建一个 local 后继，停止写仓库并更新既有监控，不推送、不提前睡眠。
