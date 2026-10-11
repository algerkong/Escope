# Q06a 进阶图型首批：同一已核对条目的右轴第二度量

日期：2026-10-11。任务：Q06a 进阶图型首批（双序列/独立右轴）。从干净 `976bc44` 接手，沿用 `main`，不建 worktree。
状态：开发、领域/JSDOM/工作台集成/类型检查与构建自动化通过；真实 ES、原生渲染、性能和跨平台待验。
本批只在既有会话聚合视图的 date_histogram 折线上叠加第二个已读取度量，不交付 terms 双轴、参考线、注释、
图例筛选、同比环比、公式计算、图层或任何持久化定义，不关闭 Q06/Q06a。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 输入 | 第二序列仍取上一批 `readAggregationPage` 核对过的同一条目、同一批返回桶，位置轴与 `positionExtent` 共用 | 不重新解析 JSON、不合并接收页、不额外请求、不开 PIT、不执行、不改 DSL；开关只改绘图输入 |
| 图型 | 只在 `date_histogram` 折线上提供叠加；不新增图型种类，`ChartKind` 仍为 `singleValue`/`bars`/`line` | 图型仍按执行 DSL 已解析类型确定，不从响应形状或当前草稿猜类型；terms 条形与单值项请求第二度量整次拒绝 |
| 度量集合 | 第二度量只能来自同一 `chartMeasures(entry)`（`doc_count` 或该分组直接指标） | 与主度量同名→`secondarySame`；不在集合内/不属于该条目→`unknownSecondary`；条目不支持→`secondaryUnsupported`；主度量仍先校验→`unknownMeasure`；均给原因，不静默回落 |
| 完整拒绝 | 第二度量本序列无可绘图值→`secondaryNoValues`，两条序列都不绘制 | 不“只画主序列”放行；未绘制清单按造成拒绝的度量标注左/右轴归属 |
| 精度 | 每序列各自走既有 token→double 独立核对（严格十进制、有限性、下溢、安全整数、最短往返），绘制值与原 token 并列保留，`data-precise` 逐点标记 | 精确只指转换无损，不代表 ES 数学精确；缺失/null/非数字/超范围列为未绘制并给原因，绝不画成 0 |
| 提示分列 | `approximate`/`valueCount`/`imprecise`/`sparseSeries` 按度量各自计算并分组显示；`bucketStarts` 归入“两个度量共用”的位置轴组 | 两条提示清单不合并、不互相掩盖；某序列无自身提示时该组不渲染，空组不冒充提示 |
| 未绘制清单 | 左/右各一份，逐条给返回行号、原标签、字段、原 token 与原因 | 同一桶键不可定位时在两份清单中都列出（位置轴共享的事实各自成立）；前 10 项后汇总计数仍指向桶表格 |
| 轴 | 左轴用主度量自身范围、右轴用第二度量自身范围，各自 `chartValueDomain`（仍含 0）与各自刻度 | 不共用刻度、不做归一化或百分比换算；开启右轴前后左序列各点几何完全一致（实测 `cy` 逐点相等）；两轴归属由轴标题与图范围行点名，不暗示可比 |
| 轴标题 | `左轴：{{measure}}` / `右轴：{{measure}}`，仍仅显示截断到 20 字符 | 完整度量名与类型在图范围行、`aria-label` 摘要与聚合表格中保留；截断不改原值 |
| 图例 | 图范围行新增“左轴度量/右轴度量”与每轴各自的“已绘制（左/右轴）比”，并有独立成行的“两轴互不可比”声明 | 不新增可点击图例、不做图例筛选；`primary/secondary/danger` 未用于这些只读控件 |
| 桶序与日期 | 返回顺序、返回槽位与返回起点原样；标签优先 `key_as_string`，折线在各自跳过处断开 | 不重排、不补空桶、不推结束边界、客户端不解析或格式化日期；断线按每序列自身的未绘制情况计算 |
| 序列化 | 领域结果 `PlottedChart`（line 分支）新增可为 `null` 的 `secondary` 序列载荷，含自身度量/范围/分段/清单/提示/精度计数/绘制数 | 纯会话内模型；不写入恢复存储、不进入定义库、不参与交换 |
| 交互 | 明确的“在右轴叠加第二个度量”开关（`role="switch"`）与右轴度量选择器 | 任何控件都不修改或执行 DSL、不查询、不导出、不持久化；索引标签仍无聚合/定义入口，无 Dashboard 或管理首页 |
| 外观 | 第二序列用虚线 + 空心标记 + 自身右轴，不依赖颜色唯一识别；`forced-colors` 下仍按 CanvasText 描边 | 沿用既有语义 token、紧凑控件、Lucide 图标与可见焦点，不重新设计既定原型 |
| 持久化 | 未持久化：图表定义仍 v1、`measure` 仍单个字符串、不保存图型或第二度量 | schema 仍 v9、无新迁移、无新 IPC 命令；交换文档仍 `escope-chart-definitions` v1，格式与内容边界未放宽 |

## 配额

| 对象 | 本批限制 | 超限行为 |
| --- | --- | --- |
| 绘制桶数 | 仍 200 个已返回桶，两序列共用同一条目 | 不因双轴放宽或减半；201 桶整次拒绘并报告返回数，指向桶表格 |
| 位置轴标签 | 仍最多 12 个（`chartAxisSlots`），单个显示截断到 20 字符 | 仅显示截断；原 token 在 `<title>`、图范围行与桶表格中保留 |
| 数值刻度 | 每轴各自 `ticks(5)` 提示，与单序列时同规则 | 双轴不减半也不合并；实测 `[0,3]` 出 7 个刻度、`[0,800000]` 出 5 个刻度，各自独立 |
| 未绘制清单 | 每度量各列前 10 项 | 其余汇总为计数并指向桶表格；两份清单分列不合并 |
| 读取边界 | 沿用 DSL 256 KiB、原页 1 MiB、64 层、100,000 token、数字 4,096 字符、名称 1 KiB | 读取阶段已整次拒绝者不进入绘图；绘图阶段按 token 判定超范围并列出原因 |

不将上述边界或 JSDOM 元素数量当作原生内存、绘制耗时、滚动帧率与可访问性达标证据。

## 本次验证

前端有效覆盖 **21 文件 451 项**：新增 **2 文件 27 项**（领域 14、面板与工作台集成 13），
图表/聚合相邻 **9 文件 292 项**（含新增 2 文件）与共享相邻回归 **12 文件 159 项**复跑通过；
**6 文件 lint**、typecheck 与正式构建通过；前端均为 `--maxWorkers=2`，没有提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 领域 14 项 | 同一批桶/位置/标签的第二序列、逐度量精度与原 token、逐度量未绘制清单与断线分段、共享坏键在两清单各列一次、不重排不补桶不推边界、近似只标自身序列、左右轴域各自独立且互不归一、`unknownSecondary`/`secondarySame`/`secondaryUnsupported`/`secondaryNoValues` 四类拒绝、主度量先校验、200 桶双序列仍全绘 / 201 桶整次拒绘、纯函数不改输入且可重复 |
| 面板 10 项 | 显式开关后才出现第二序列、`aria-label` 双轴摘要分别报两条绘制比、左轴刻度 `0…3` 与右轴刻度 `0…800000` 各自独立、开右轴前后左序列各点 `cy` 完全相同、提示按度量分组且共享 `bucketStarts` 单列、未绘制清单按度量归属标注、返回顺序与 `key_as_string` 原样（轴仅显示截断，`<title>` 保留完整 token）、同度量选择整次拒绝且不画单序列、第二度量无可绘图值整次拒绝并报右轴归属、terms 不出现叠加开关 |
| 集成 3 项 | 叠加与切换第二度量全程 `fetch` 零调用且 `onRun`/`onLoadMore`/`onCancel`/`onViewChange`/`onLayoutChange` 均未触发；续页到达不换已开双轴图，切换所选接收页后双轴随图表一并清理且重开为单序列、开关不带旧状态；替换快照身份后视图与叠加一起清理；中英切换后左右几何与刻度完全一致，双语键计数一致 |
| 相邻回归 | chart-definitions 领域/服务/UI/构建播种/工作台 5 文件、chart-definition-exchange 4 文件、query-result、query-executions、app-workspace-recovery；未运行无关全量 |
| 构建 | 主 JS **1,582.13 kB**（较上批 +6.69 kB）、主 CSS **133.38 kB**（+0.54 kB）、绘图 chunk **41.75 kB**（+1.30 kB）；Monaco **3,125.21 kB** 不变，原大包警告保留 |
| 依赖 | 零新增依赖，复用已锁定的 `@visx/{scale,shape,group}` 多序列绘制能力；无 Rust/IPC/schema/迁移/交换格式变更，schema v9、恢复文档 v1、固定库 v3、Data Views/查询库/查询交换合同未改 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/query-aggregation-charts-dual-axis.test.ts tests/unit/query-aggregation-charts-dual-axis-ui.test.tsx tests/unit/query-aggregation-charts.test.ts tests/unit/query-aggregation-charts-ui.test.tsx tests/unit/query-aggregation-chart-loader.test.tsx tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx tests/unit/query-aggregation-build.test.ts tests/unit/query-aggregation-build-ui.test.tsx
npm test -- --maxWorkers=2 tests/unit/chart-definitions.test.ts tests/unit/chart-definitions-service.test.ts tests/unit/chart-definitions-ui.test.tsx tests/unit/chart-definitions-build-ui.test.tsx tests/unit/app-chart-definitions.test.tsx tests/unit/chart-definition-exchange.test.ts tests/unit/chart-definition-exchange-service.test.ts tests/unit/chart-definition-exchange-ui.test.tsx tests/unit/app-chart-definition-exchange.test.tsx tests/unit/query-result.test.ts tests/unit/query-executions.test.tsx tests/unit/app-workspace-recovery.test.tsx
npx eslint src/domain/query-aggregation-charts.ts src/features/query/charts/AggregationChart.tsx src/features/query/charts/AggregationChartCanvas.tsx src/locales/query-aggregation-charts.ts tests/unit/query-aggregation-charts-dual-axis.test.ts tests/unit/query-aggregation-charts-dual-axis-ui.test.tsx
npm run typecheck
npm run build
```

红绿证据（首轮失败全部是测试自身口径或夹具问题，未放宽断言语义）：

- 领域首轮 14 项有 3 例红：一处 terms 夹具字符串多写一个引号致 JSON 非法被读取阶段拒绝；
  一处把可绘图行的 `doc_count` 当成缺失，实际主序列未绘制清单只含第 1 行；
  一处把 `valueExtent` 当成含 0 的轴域断言，实际它是“已绘制值范围”，改以 `chartValueDomain` 断言轴域。
- 面板/集成首轮 13 项有 7 例红：`plottedOf` 用中词语序断言英文文案；负断言误用 `getByText`（应 `queryByText`）；
  “Right axis measure”同时命中图范围行与选择器 label，改按 `combobox` 角色查询；
  干净序列的按度量分组本身为空、不渲染，故不能当双轴已开启的判据，改断右轴选择器存在；
  `ticks(5)` 在 `[0,3]` 上返回 7 个刻度而非 4 个，按实际独立刻度断言；
  集成用例把“新到达的接收页”误当成应关闭当前图，而合同是续页不换已选接收页，改为切换所选接收页；
  断言 `f.f.pages` 时夹具工厂漏返回 `pages`，补齐后通过。
- 修正后领域 14 项、面板与集成 13 项、图表相邻 9 文件 292 项全绿；主 JS/CSS/绘图 chunk 体积增量列于上表。

主代理独占实现、diff 复查与验证，无 OMP/worktree/用户数据库/真实服务或持久服务操作。
未启动浏览器/WebView/预览服务，未构建安装包；未改原型/Rust/依赖，不重复其全量/fmt/clippy/审计。

## 待验与接续

[集中人工清单](manual-acceptance.md) 保留：

- 原生双轴可读性：左右轴刻度与轴标题在 200%/窄窗与长度量名下的重叠、右轴旋转文本、横向滚动与键盘焦点。
- 序列可辨性：虚线 + 空心标记在日夜主题、四种强调色与系统高对比下的区分，色觉障碍不依赖颜色，
  以及两序列同点重叠时的遮挡。
- 屏幕阅读器：`role="img"` 的双轴长摘要朗读、两个提示组与两份未绘制清单的归属播报、
  叠加开关（`role="switch"`）与右轴选择器的焦点顺序、`<select>` 与中文 IME。
- 真实 ES：同一条目上 `doc_count` 与 cardinality 近似值并图时的口径理解、真实 interval/时区/DST/keyed、
  大计数溢出与长小数在左右两轴上的呈现、`size` 放大后的 200 桶上限。
- 性能：200 桶双序列的原生绘制与切换耗时、内存，以及 41.75 kB 绘图 chunk 首次加载时延。
- 跨平台：Windows WebView2 / macOS / Linux 上的双轴 SVG 渲染与 tooltip。

本批明确未做，留待后续批次且不得顺手扩：terms 条形双轴、参考线/注释/图例筛选、
同比环比（需先定时间边界方案）、公式类跨指标计算（客户端算数被禁止，需先定服务端聚合语义范围）、
多图层（需先决定定义库是否版本化）。**开放项**：若产品要求持久化第二度量或图型开关，
图表定义必须版本化（v2）并同步交换文档与迁移，本批不实现，仅在此登记为需版本化的范围。

下一批按第 10.2 节继续 **Q06a 进阶图型**：terms 条形双轴或同比/环比的时间边界方案选型；
沿用同一精度、配额与只绘已核对接收页的规则。
Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、nested runtime/深层条件及
W01/W04 继续开放，不以此跳过未完成项。
本批本地提交后停止仓库写入；平台禁止本会话创建嵌套会话，后继由用户按授权新开，不推送、不提前睡眠。
