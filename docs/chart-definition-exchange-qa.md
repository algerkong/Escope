# Q06a 图表定义本地交换（首批：导出 / 导入 / 逐项连接映射）

日期：2026-10-11。任务：Q06a 本地交换首批。接手 HEAD `43aa301`，复用 `main`，不建 worktree。
状态：开发、Rust/TS 自动化与 lint/typecheck/正式构建通过；真实桌面文件与 SQLite、真实 ES、
原生交互与跨平台待验。**未绑定导入按存储不变量拒绝，见“边界与偏差”。**

本批把上一批的本地图表定义库接成一个可审阅的交换闭环：选中定义 → 生成文档 → 原生保存或浏览器下载；
选择文件 → 逐个来源显式映射 → 审核 → 追加式写入。文档只带定义本身，导入只新增，
全程不发请求、不开 PIT、不执行；导入后的定义仍需匹配标签 + 显式复用 + 完整 DSL 预览 + 显式应用。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 交换格式 | `escope-chart-definitions` v1：`{format,version,connections[{key,label}],definitions[{key,name,connectionKey,index,draft,measure}]}`，最多 100 条/1 MiB | 封闭形状：定义体沿用上一批的存储定义校验，未知键、非字面量选项、未知指标类型、度量不归属整次拒绝，不修复、不规范化放行 |
| 内容范围 | 只带目标模式、分组与指标的名称/类型/字段、size/间隔/时区字面量、绘图度量与不透明来源标签 | 不带端点、真实连接 ID、认证类型、凭据引用、密钥、解析结果、绘制数值、字段能力证据、时间边界、结果正文、PIT、执行历史或草稿 DSL；定义本身的边界不因交换放宽 |
| 导出 | 定义面板新增“导出图表定义”，按已冻结的库快照选择、审核完整文档，再显式保存 | 未选中不生成文档；选中项在库里已消失报 `chartDefinitionConflict` 而非猜测；导出绝不改写库 |
| 导入 | “导入图表定义”读取文档、逐来源映射、审核后一次追加，全部新 ID | 不覆盖既有 ID/定义/草稿/收藏；同名与同形状允许重复新增；导入不打开标签、不执行、不改复用门控 |
| 目标映射 | 每个来源必须映射到本地连接 ID + 端点；按 profiles 现场核对 | 不按名称/当前选择/来源标签重绑；映射不全、重复、未知键或形状不符整次拒绝；profiles 变化后 `exchangeTargetChanged` 作废需重审 |
| 写入 | 桌面 `chart_definition_exchange_import` 在同一 immediate 事务内读回、比较 revision、再核对映射的 ID/端点，通过后一次追加 | `chartDefinitionConflict`/`exchangeTargetChanged`/`exchangeTooLarge`/`invalidResponse` 都不写盘；损坏或未知版本存储不被修复覆盖；未知完成需显式重载 |
| 文件语义 | 桌面原生打开/保存对话框，路径由对话框决定；写入沿用既有原子替换：同目录隐藏临时文件 `.<名称>.tmp-<uuid>`（`create_new`）→ 全量写入 + `flush` + `sync_all` → `rename` 覆盖目标，失败只清理自己创建的临时文件 | 浏览器为 session 内存适配与显式下载请求，标注不跨重启、不验证磁盘；取消/失败/超限/未知各自可辨，不静默降级 |
| 复用链路 | 导入后面板显示新定义；复用仍要求连接 ID 与目标完全一致且连接仍存在 | 复用只播种构建行，仍需显式预览与应用；应用后才可能运行 |
| IPC | 新增 `chart_definition_exchange_read` / `_save` / `_import` 三条受限命令，请求体封闭类型 | 不接收任意路径/URL/方法/认证头；不读取密钥库；错误码沿用既有交换集合 |
| UI | 沿用查询交换的紧凑 token 样式、Lucide 图标、中英双语键齐全与可见焦点；`primary/secondary/danger` 仅用于动作按钮 | 不新建 Dashboard 或管理首页；索引标签仍不出现定义/构建工具条；不承诺 Kibana Saved Objects 兼容 |

## 边界与偏差

- **图表定义不支持“未绑定导入”。** 定义库的既有不变量是`connectionId` 必填且为合法 ID、
  新增 ID 必须在同事务内确认连接仍存在、同 ID 永不换绑。未绑定导入会产生一条永不匹配任何标签、
  又永远不能重新绑定的死定义，因此本批把映射定为**必须**：TS 的映射类型收紧为非空 target，
  Rust 侧 `target: null` 在反序列化层即被拒绝。删除连接的**历史**定义仍按上一批保留为未绑定显示、
  复用禁用，交换不改写其连接 ID。若将来要支持未绑定定义，需要先版本化定义库本身（v2 可空绑定），
  不属于本批范围。
- 来源标签是显示提示，可能带用户自定义名称；`buildChartDefinitionExchange` 只读 `id/displayName`，
  端点/认证字段在类型上就进不来。
- 已知敏感键与疑似认证文本检查沿用查询交换的同一份实现（TS `SENSITIVE_KEYS`/`SENSITIVE_TEXT`
  导出复用，Rust `sensitive_text`/`SENSITIVE_KEYS` 改 `pub(crate)` 共享），文档任意层级的
  键名命中已知集合、任意字符串命中认证样式，都整次拒绝 `exchangeSensitive`。
  这不能自动识别所有无标签字面量，名称/目标/字段仍要用户在预览里核对。

## 配额

| 对象 | 限制 | 超限行为 |
| --- | --- | --- |
| 文档字节 | 1 MiB（读取前按字节判定，解码后再判定序列化长度） | `exchangeTooLarge`，不部分导入 |
| 文档定义/来源数 | 各 ≤100 | `exchangeTooLarge` |
| 合并后库 | ≤100 条且序列化 ≤256 KiB | 整次拒绝 `exchangeTooLarge`，既有条目一条不动 |
| 名称/目标/字段/度量/size/间隔/时区 | 与上一批定义库完全一致（名称 ≤120 码点、目标 ≤1024 字节且守索引语法、字段与度量 ≤1 KiB、指标 ≤31、size 1–1000 token、间隔 ≤64 字符、时区 ≤100 字符） | 拒绝，不 trim、不转数字、不改默认值 |
| 来源标签 | ≤120 码点、非空、无控制字符 | 拒绝 |
| 映射端点 | ≤2048 字符（校验用提示，不写入定义） | `exchangeMappingRequired` |

这些边界只是本地存储、形状与交换约束，不构成真实 ES 聚合可行性、成本或原生交互达标的证据。

## 本次验证

Rust：**14 项**新增 `chart_definition_exchange` 测试通过（共享夹具只含定义体且无端点/连接 ID/DSL/结果、
版本与重复键与封闭形状拒绝、任意深度敏感键与认证样式字面量在文本与类型化两条路径都拒绝、
文档用存储定义规则校验、来源未用/未知/重复/空定义/超限拒绝、未绑定在链路上即被拒、
映射缺失/重复/未知/非法 ID 拒且不写盘、映射的连接在写事务内重检端点变动与删除都 `exchangeTargetChanged`、
陈旧 revision 先冲突、一次追加新 ID 且既有条目逐字保留且其他存储不受影响、
重载后重复导入再追加而不改首批、条数与字节上限无部分追加、损坏或未来存储不被修复、
文件限额与非 UTF-8 与缺失与目录各自失败、原子写入回读不规范化字面量）。
按项目精简约定改跑受影响模块，Rust 合计 **189 项通过**：`chart_definition_exchange` 14、
`chart_definitions` 14、`storage::` 47、`data_views` 19、`pinned_filters` 27、`workspace_recovery` 28、
`saved_queries` 13、`query_exchange` 11、`runtime_fields` 7、`query_time_range` 9；`cargo fmt --check` 干净。
`cargo test --lib` 全量在本机仍不能收尾：既有 `connection::tests` 两条裸 TCP/https 握手用例各等读超时 >60s，
与本批无关，记为未运行待补，不用模块通过冒充全量通过。

前端有效覆盖 **31 文件 550 项**：新增 **4 文件 43 项**（领域 21、服务 8、交换对话框 11、工作台集成 3），
相邻图表定义/聚合构建/图表/查询交换 **17 文件 373 项**与共享应用回归 **10 文件 134 项**复跑通过；
**15 文件 lint**、typecheck 与正式构建通过；前端均为 `--maxWorkers=2`，没有提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 领域 21 项 | 与 Rust 共用 `tests/fixtures/chart-definition-exchange-v1.json`；导出只含定义体与来源标签，断言不含连接 ID/端点/凭据引用/`endpoint`/`dsl`/`results`/`updatedAt`/`revision`；同连接定义共用一个来源键且文档可回读；删除连接的来源标签回落为不透明键；映射缺失/重复/未知/`target:null`/额外键/非法 ID 各拒，同名不同 ID、端点变动、连接消失都是 `exchangeTargetChanged`；导入只追加新 ID、既有库逐字不变、同名允许重复、行是审阅副本；条数与字节超限整次拒绝且无部分追加；版本/重复键/未知字段/未用来源/空定义/空白标签/首尾空格/非索引语法/数字 size/未知类型/度量不归属/空草稿全拒；6 类敏感键与 4 类认证字面量在任意层级拒绝；中英键齐全 |
| 服务 8 项 | 桌面三条命令的请求体只带 `{bundle}`/`{bundle,reviewed}`/`{bundle,mappings,expectedRevision}`，多带 `path` 即 `invalidResponse`；未审不保存；导入返回逐字核对整段追加，改绑/少行/同 revision 都算未确认；映射缺失在 IPC 前拒；桌面 `storageUnavailable`/`exchangeTargetChanged` 不降级为内存；非 Tauri 全部 `unsupported`；浏览器只用所选文件、超限与非 UTF-8 各自失败；CAS 追加后重放同一审阅冲突且不加行，第二次审阅仍逐字保留首批；下载只报 `downloadRequested`；不可解析的文档不允许导出 |
| 交换对话框 11 项 | 导出：未选不产文档、按钮禁用、文档不含端点与真实 ID、审阅前禁保存、保存只报下载请求且不改库、全选用与取消选用；空库给明确文案；导入：来源必须逐个映射且**没有未绑定选项**、端点提示显示、未映射/连接变动禁用导入、坏文档给 `exchangeInvalid`/`exchangeVersion`/`exchangeSensitive` 且库不变、取消选择只报取消、审阅库被别处推进后导入不生效并报冲突、完成后二次点击不重复追加、中英切换不改变文档 |
| 工作台集成 3 项 | 构建→保存→导出（文档不含端点/连接 ID/DSL/结果）→下载请求，全程 `execute`/`openPit` 调用数不变且库不变；导入→逐来源映射→导入后 `execute`/`openPit` 仍为 0，只有目标精确匹配的那行启用复用；复用→本次证据检查→预览→应用只改 `aggs`（`by_host: terms host size 20`）且长整数 token 与原查询保持，应用仍未执行；重启后导入的定义仍在，删除连接后显示未绑定且复用禁用 |
| 相邻回归 | 图表定义领域/服务/面板/构建弹窗/工作台、聚合构建领域/UI、聚合读取领域/UI、图表领域/UI/chunk 加载、查询交换领域/服务/UI、库集成、面板标签 |
| 共享应用回归 | app.test、app-query-integration、app-index-tabs、app-data-views、app-pinned-filters、query-library-ui、workspace-tabs、domain、build-dependencies、packaging-config |
| 构建 | 主 JS **1,575.44 kB**（较上批 +20.99 kB）、主 CSS **132.84 kB**（+0.07 kB）、图表 chunk **40.45 kB** 不变、Monaco **3,125.21 kB** 不变，原大包警告保留 |
| 合同 | schema 仍 v9、无新迁移；恢复文档 v1、固定库 v3、快照 v4、Data Views/查询库/查询交换合同未改；新增三条 `chart_definition_exchange_*` 命令；零新增依赖 |

主要命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib chart_definition_exchange
cargo test --manifest-path src-tauri/Cargo.toml --lib chart_definitions
cargo test --manifest-path src-tauri/Cargo.toml --lib query_exchange
cargo test --manifest-path src-tauri/Cargo.toml --lib storage::
cargo fmt --check --manifest-path src-tauri/Cargo.toml
npm test -- --maxWorkers=2 tests/unit/chart-definition-exchange.test.ts tests/unit/chart-definition-exchange-service.test.ts tests/unit/chart-definition-exchange-ui.test.tsx tests/unit/app-chart-definition-exchange.test.tsx
npm test -- --maxWorkers=2 tests/unit/chart-definitions.test.ts tests/unit/chart-definitions-service.test.ts tests/unit/chart-definitions-ui.test.tsx tests/unit/chart-definitions-build-ui.test.tsx tests/unit/app-chart-definitions.test.tsx tests/unit/query-aggregation-build.test.ts tests/unit/query-aggregation-build-ui.test.tsx tests/unit/query-aggregation-charts.test.ts tests/unit/query-aggregation-charts-ui.test.tsx tests/unit/query-aggregation-chart-loader.test.tsx tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx tests/unit/query-exchange.test.ts tests/unit/query-exchange-service.test.ts tests/unit/query-exchange-ui.test.tsx tests/unit/app-library-integration.test.tsx tests/unit/workspace-panels.test.tsx
npm test -- --maxWorkers=2 tests/unit/app.test.tsx tests/unit/app-query-integration.test.tsx tests/unit/app-index-tabs.test.tsx tests/unit/app-data-views.test.tsx tests/unit/app-pinned-filters.test.tsx tests/unit/query-library-ui.test.tsx tests/unit/build-dependencies.test.ts tests/unit/packaging-config.test.ts tests/unit/domain.test.ts tests/unit/workspace-tabs.test.ts
npx eslint src/domain/chart-definition-exchange.ts src/domain/chart-definitions.ts src/domain/query-exchange.ts src/services/chart-definition-exchange.ts src/features/query/useChartDefinitions.ts src/features/query/ChartDefinitionExchangeDialog.tsx src/features/query/ChartDefinitionsDialog.tsx src/features/query/QueryWorkspace.tsx src/app/App.tsx src/locales/chart-definitions.ts tests/unit/chart-definition-exchange.test.ts tests/unit/chart-definition-exchange-service.test.ts tests/unit/chart-definition-exchange-ui.test.tsx tests/unit/app-chart-definition-exchange.test.tsx tests/unit/chart-definitions-ui.test.tsx
npm run build
```

红绿证据（均为测试自身或断言口径问题，未放宽实现语义）：领域首轮把本地 ID 写进定义名称，
导致“导出不含本地 ID”的断言命中自身夹具，改为独立名称与 ID；注入 ID 的夹具用 `Math.random()` 生成含点的
标识符被 `identifier` 语法拒绝，改为自增计数；配置文件少传一项使来源标签回落为不透明键，改为传齐；
Rust 侧首轮 5 项失败源于检查顺序——敏感字面量在结构校验之后才被扫描，会把“度量里的 `Bearer …`”报成
`exchangeInvalid`，改为 validate 先扫描原始文档，与 TS 的 `scanLiterals` 先行一致；
另有 4 项测试自身问题：把语法合法但未核对的 target 形状当作反序列化拒绝（改断言为导入阶段
`exchangeMappingRequired`）、未用的来源与空标签夹具口径、容量夹具用 3 条宽定义不足以越界
（改 4 条并在断言里显式算出合并字节数）、以及一次 `save_chart_definitions(0, …)` 在循环内重复而先冲突。
UI 首轮失败暴露真实缺陷：错误分支只翻译了 `common` 命名空间，未命中的交换码会把原始 key 显示到屏幕上，
改为所有交换错误都带 `chartDefinitions:` 前缀解析；另把“选择清空后审阅框消失”误断言成
“复选框取消勾选”（元素已卸载），改为断言文档与审阅入口都不再存在，并重新选择验证必须重审。
按此补出的实现约束：映射的 target 类型收紧为非空，浏览器与桌面共用同一份拒绝路径。

主代理独占实现、diff 审查与验证；无 OMP、worktree、用户数据库或真实服务操作。
未启动浏览器/WebView/预览服务，未构建安装包；未改原型与依赖，不重复其全量/审计。

## 未交付与待验

[集中人工清单](manual-acceptance.md) 保留：

- 真实桌面文件：原生打开/保存对话框的取消、覆盖已有文件、目标不可写/磁盘满/系统中断、
  `隐藏 `.<名称>.tmp-<uuid>` 临时文件不残留、导出文档在磁盘上的实际字节、处理未返回时关闭对话框。
- 真实桌面 SQLite：v9 单行文档上的追加写入、真实文件锁与并发写、只读存储与损坏文件呈现、
  重启后导入的定义仍在且不自动执行；浏览器下载与桌面保存的差别需要在同一份文档上人工对照。
- 真实 ES：导入并复用应用后的聚合与图表能否执行（doc values/FLS/权限、间隔与时区写法、`size` 放大），
  以及“导入不执行、应用后才运行”的边界。
- 原生：交换对话框的焦点顺序（选择列表 → 映射下拉 → 审阅复选框 → 主操作）、`<select>` 与 IME、
  屏幕阅读器对映射必填与禁用原因的播报、200%/窄窗下映射行的布局、日夜与高对比。
- 跨平台：Windows WebView2/macOS/Linux 上 `chart_definition_exchange_*` IPC 往返。

下一批按第 10.2 节继续扩展图型：公式/同比环比/双轴/图层，沿用同一精度与配额规则；
Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、
nested runtime/深层条件与 W01/W04 继续开放，不以此跳过未完成项。
本批本地提交后由用户开新会话接续（平台禁止本会话再创建嵌套会话），不推送、不提前睡眠。
