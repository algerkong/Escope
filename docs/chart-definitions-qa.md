# Q06a 图表定义保存与复用（首批）

日期：2026-10-11。任务：Q06a 首批（保存 / 复用 / 复制 / 重命名 / 删除）。接手 HEAD `800b7fe`，
复用 `main`，不建 worktree。状态：开发、Rust/TS 自动化与 lint/typecheck/正式构建通过；
真实 ES、原生交互、跨平台存储与**本地交换**待验或待开发。

本批把“读取 → 绘图 → 构建”所需的**选择**收为版本化本地定义：一条定义记录连接 ID + 目标模式 +
分组 + 指标 + 绘图度量。定义只是定义：保存、加载、复用、复制、重命名和删除都不发请求、
不开 PIT、不执行；复用只填充聚合构建的待审行，之后仍要走既有
“完整 DSL 预览 → 显式应用”合同。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 定义内容 | `id/name/connectionId/index/draft{group,metrics}/measure` v1；分组与指标只存名称、类型、字段与 size/间隔/时区字面文本 | 不存解析结果、绘制数值、字段能力证据、时间边界、端点、认证对象、凭据引用或结果正文；不存图型开关，图型仍由执行 DSL 决定 |
| 可构建性 | 定义的 `draft` 直接用聚合构建模块的 `validateAggregationDraft` 校验 | 存的定义一定是构建器能产出的形状；形状不符整条拒绝，不修好再保存 |
| 度量 | 有分组时 `doc_count` 或任一分组内指标名；无分组时必须指向那个单值指标 | 度量不匹配即拒绝，不静默回退 `doc_count` |
| 存储 | SQLite `chart_definition_library` 单行文档，schema v8 → v9，迁移 `009_chart_definitions.sql` | 迁移逐步单事务，失败保留原版本与既有文档；读不插行；revision 0 表示无行；`revision BETWEEN 1 AND 9007199254740991` 与 256 KiB 由 SQL CHECK 与代码双重约束 |
| 写入 | 单一 immediate 事务内比较 expectedRevision，成功后 +1；损坏/未知版本/冲突不覆盖，未知完成需显式重载 | 冲突码 `chartDefinitionConflict`，损坏读回 `invalidResponse`，两者都不写盘 |
| 连接绑定 | 定义固定 `connectionId`；同 ID 不可换绑；**新增** ID 必须在同一事务内确认连接仍存在 | 缺连接返回 `chartDefinitionConnectionMissing`；删除连接保留历史 ID 与定义，不重绑、不静默删除 |
| 复用 | 定义列表在目标与连接完全一致的查询标签上提供“复用到聚合构建”，写入冻结深拷贝的选择并打开构建审核 | 目标不符或连接已删除时禁用并说明原因；复用不写 DSL、不运行；应用仍需显式预览+应用 |
| 复制/重命名/删除 | 复制生成新 ID 的独立定义；重命名只改名称；删除走显式确认面板 | 已保存 ID 不换目标、不覆盖他人写入；删除只移除库中定义，不改草稿、执行快照或查询定义副本 |
| IPC | 新增 `chart_definitions_load` / `chart_definitions_save` 两个受限类型化命令 | 不提供任意 URL/方法/认证头；不读取密钥库；错误码沿用既有集合外加两条冲突/缺连接码 |
| 服务 | 桌面走 IPC 适配，浏览器预览走显式 session 内存适配 | 桌面失败不降级为内存保存；session 存储不跨重启，UI 明确标注 |
| UI | 紧凑 token 风格、Lucide 图标、中英双语键齐全、可见焦点；`primary/secondary/danger` 仅用于动作按钮 | 不新建 Dashboard 或管理首页；定义面板为对话框，索引标签不出现该工具条 |

## 配额

| 对象 | 限制 | 超限行为 |
| --- | --- | --- |
| 定义条数 | 每库最多 100 条 | 整体拒绝 `invalidInput`，不丢弃旧条目；到达上限时所有新增入口禁用并给出原因 |
| 库字节 | 序列化后 256 KiB | 整次拒绝，不截断，不部分保存 |
| 名称 | ≤120 字符码点、无首尾空白、无控制字符 | 拒绝，不自动 trim 后保存 |
| 目标 | 沿用索引目标语法，≤1024 字节 | 拒绝，不猜测展开 |
| 聚合字段/度量 | 名称与字段各 ≤1 KiB，无控制字符；指标 ≤31 个（与读取器 32 定义上限一致） | 拒绝；含点路径可作为字面量存储，但在构建预览时按 `fieldPath` 拒绝 |
| size/间隔/时区 | size 1–1000 整数 token；间隔 ≤64 字符；时区 ≤100 字符 | 拒绝，不改为默认值；写法与合法性仍由 Elasticsearch 判定 |
| revision | 1 ≤ revision ≤ 9007199254740991 | SQL CHECK 直接拒绝越界写入；客户端不强制覆盖 |

这些边界只是本地存储与形状约束，不构成真实 ES 聚合可行性、成本或原生交互达标的证据。

## 本次验证

Rust：**14 项**新增 `chart_definitions` 测试通过（共享夹具解析与 camelCase 文档键、分组选项混排/未知键/
非字面量拒绝、size 与间隔/时区字面量边界、度量与分组归属、空草稿与重名拒绝、含点字段属门控而非存储、
库版本/重复 ID/条数/字节上限、损坏或篡改存储不修复、空读不插行、重开保留原文、
revision CAS 与换绑拒绝、缺连接拒绝且删除后保留、越界计数器由 SQL CHECK 拒绝、分组经完整存储往返）。
按项目精简约定改跑受影响模块，Rust 合计 **190 项通过**：`chart_definitions` 14、`storage::` 47（含 v8 → v9
与各历史迁移保留既有条目的用例）、`data_views` 19、`pinned_filters` 27、`workspace_recovery` 28、
`saved_queries` 13、`query_exchange` 11、`runtime_fields` 7、`query_time_range` 9；`cargo fmt` 干净。
`cargo test --lib` 全量在本机不能收尾：既有 `connection::tests` 两条用例逐个 `has been running for over 60 seconds`
（其 mock 服务器只裸听 TCP，客户端却按 `https://localhost:port` 握手，只能等读超时），与本批改动无关，
按未运行记录，留待独立环境补跑，不用模块通过冒充全量通过。

前端有效覆盖 **28 文件 490 项**：新增 **5 文件 56 项**
（领域 30、服务 5、定义面板 11、构建弹窗保存/复用 8、工作台集成 2），
相邻聚合构建/读取/图表/排序 **11 文件 354 项**与共享工作台组件 **12 文件 80 项**复跑通过；
**16 文件 lint**、typecheck 与正式构建通过；前端均为 `--maxWorkers=2`，没有提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 领域 30 项 | 与 Rust 共用 `tests/fixtures/chart-definitions-v1.json`；20 类损坏输入整条拒绝（多余键、端点/结果/证据/凭据/时间边界键、非字面量选项、未知指标类型、缺失度量、无分组却用 doc_count、空草稿、重名）；版本/重复 ID/条数/字节上限；revision 规则；冻结复用拷贝不可变且后续库改动不影响已开审核；目标精确匹配才复用；构建预览用已存形状只改 `aggs`；含点字段在门控处 `fieldPath` 拒绝而非改写 |
| 服务 5 项 | 空库读、revision 递增、每次 load 返回脱离引用、陈旧 revision 与换绑拒绝且不落盘、损坏文档拒绝写入、上限内追加与越界整拒、桌面适配在非 Tauri 环境报 `unsupported` 而不回退内存 |
| 定义面板 11 项 | 异步加载态、空态文案、目标匹配才启用复用且点击交出冻结选择、目标不符禁用并说明、复制为新 ID 且原定义不变、重命名只改名称（含拒绝空白名与取消）、删除需显式确认且可取消、连接删除后显示未绑定并禁用复用、并发写后本面板报冲突并显式重载恢复、中英切换不改变存储内容 |
| 构建弹窗 8 项 | 保存写入字面量且不调用 `onCommit`/不生成已审 DSL、名称缺失/形状不可构建/达到上限各自拒绝并给原因、度量选项随分组出现 `doc_count` 而否则只列指标名、保存后改动行即作废提示、复用播种行仍需显式预览与应用、目标不符的复用被忽略并回到草稿播种 |
| 工作台集成 2 项 | 构建→保存定义→取消→定义面板复用→预览→应用只改 `aggs` 且原查询/排序/长整数 token 保持，`execute`/`openPit` 调用数全程不变；重启后定义仍在且恢复不执行，删除连接后定义保留为未绑定且复用禁用 |
| 相邻回归 | 聚合构建领域/UI/工作台、聚合读取领域/UI、图表领域/UI/chunk 加载、排序领域/UI/工作台；未运行无关全量 |
| 共享组件回归 | app-data-views、app-index-tabs、app-query-filters/session、app-pinned-* 四件、app-query-integration、app-library-integration、app-workspace-recovery、app-ai-integration |
| 构建 | 主 JS **1,554.45 kB**（较上批 +20.90 kB）、主 CSS **132.77 kB**（+1.96 kB）、图表 chunk **40.45 kB** 不变、Monaco **3,125.21 kB** 不变，原大包警告保留 |
| 合同 | 仅 schema v8 → v9 与新增两条 IPC 命令；恢复文档 v1、固定库 v3、执行快照合同 v4、Data Views/查询库/交换合同未改；零新增依赖 |

主要命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib chart_definitions
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm test -- --maxWorkers=2 tests/unit/chart-definitions.test.ts tests/unit/chart-definitions-service.test.ts tests/unit/chart-definitions-ui.test.tsx tests/unit/chart-definitions-build-ui.test.tsx tests/unit/app-chart-definitions.test.tsx
npm test -- --maxWorkers=2 tests/unit/query-aggregation-build.test.ts tests/unit/query-aggregation-build-ui.test.tsx tests/unit/app-query-aggregation-build.test.tsx tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx tests/unit/query-aggregation-charts.test.ts tests/unit/query-aggregation-charts-ui.test.tsx tests/unit/query-aggregation-chart-loader.test.tsx tests/unit/query-sort.test.ts tests/unit/query-sort-ui.test.tsx tests/unit/app-query-sort.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-data-views.test.tsx tests/unit/app-index-tabs.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/app-query-filter-session.test.tsx tests/unit/app-pinned-filters.test.tsx tests/unit/app-pinned-filter-lifecycle.test.tsx tests/unit/app-pinned-nested-filters.test.tsx tests/unit/app-pinned-runtime-filters.test.tsx tests/unit/app-query-integration.test.tsx tests/unit/app-library-integration.test.tsx tests/unit/app-workspace-recovery.test.tsx tests/unit/app-ai-integration.test.tsx
npx eslint src/domain/chart-definitions.ts src/domain/query-aggregation-build.ts src/services/chart-definitions.ts src/services/ipc.ts src/features/query/useChartDefinitions.ts src/features/query/ChartDefinitionsDialog.tsx src/features/query/QueryAggregationBuildDialog.tsx src/features/query/QueryWorkspace.tsx src/locales/chart-definitions.ts src/locales/index.ts src/app/App.tsx tests/unit/chart-definitions.test.ts tests/unit/chart-definitions-service.test.ts tests/unit/chart-definitions-ui.test.tsx tests/unit/chart-definitions-build-ui.test.tsx tests/unit/app-chart-definitions.test.tsx
npm run build
```

红绿证据（均为测试或夹具自身问题，未放宽断言语义）：领域用例先以只读属性做突变断言，
改为断言每次 `load()` 返回脱离引用；定义面板 8 项失败源于 `getAllByRole` 在空列表时抛错、
异步库未就绪即断言按钮状态、以及用 `element.getByRole` 而未用 `within()`，逐项加等待与 `within` 后通过；
构建弹窗 6 项失败源于把复用的连接 ID 与目标接到了不匹配的草稿标签、`<summary>` 当 label 查询、
空度量选项与状态行文案重复导致 `getByText` 命中多处，以及用相同字段值触发“行变化”断言，
改为独立文案 `noMeasure`、匹配目标构造草稿、真实改动字段后通过；
工作台集成先以旧 `initial` 快照重挂，导致删除连接后仍显示 Alpha，改为每次 `mount()` 重新 `storage.load()`，
并据此发现复用门控缺少“连接仍存在”条件，补为 `reuseNoConnection` 提示。
Rust 侧首轮 4 项编译错误（move 后用值、`format!` 拼接、越界 revision 被 SQL CHECK 拒绝、
`let-else` 移动语义）与 3 项期望修正（含点字段属门控而非存储、字节上限需真实越界夹具、
反序列化层拒绝当作验证层拒绝）按实际行为调整断言口径，未放宽约束。

主代理独占实现、diff 审查与验证；无 OMP、worktree、用户数据库或真实服务操作。
未启动浏览器/WebView/预览服务，未构建安装包；未改原型与依赖，不重复其全量/fmt/clippy/审计。

## 未交付与待验

**本批不含 Q06a 本地交换**：图表定义的导出/导入与逐项连接映射尚未实现，
UI 也未提供任何占位入口；后续批次按既有查询交换合同实现
（只带定义、不带端点/真实连接 ID/认证/结果/历史，同名只新增，已知敏感键拒绝，字面量仍需核对）。

[集中人工清单](manual-acceptance.md) 保留：

- 真实桌面 SQLite：v8 → v9 迁移在已有工作区/固定筛选/Data Views/查询库数据上的往返与失败回滚、
  真实文件锁与并发写、只读存储与损坏文件的报错呈现、重启后定义仍在且不自动执行。
- 真实 ES：复用并应用定义后的聚合与图表在授权目标上能否执行（doc values/FLS/权限、间隔与时区写法、
  `size` 放大），验证“保存/复用不执行、应用后才运行”的边界。
- 原生：定义面板与构建弹窗保存区的焦点顺序、`<datalist>` 与 IME、删除确认对话框的键盘可达、
  屏幕阅读器对复用禁用原因的播报、200%/窄窗下条目行与图标按钮的布局、日夜与高对比。
- 跨平台：Windows WebView2/macOS/Linux 上 `chart_definitions_*` IPC 的真实往返。

下一批 **Q06a 本地交换**：图表定义导出/导入 + 逐项连接映射或未绑定 + 追加式 CAS 写入 +
原生对话框与浏览器下载语义区分；随后再扩公式/同比环比/双轴/图层。
Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、
nested runtime/深层条件、完整 Q02/Q03/F07 与 W01/W04 不被本批跳过或关闭。
本批本地提交后由用户开新会话接续（平台禁止本会话再创建嵌套会话），不推送、不提前睡眠。
