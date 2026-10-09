# Q09 第一批：本地 Data Views

日期：2026-10-10。接手基线 `1dc9f7d`，工作区干净，沿用 `main`。
状态：开发、临时 SQLite 与组件自动化通过；真实 ES、原生交互与桌面重启待验。
主代理独占实现，无 OMP、新依赖、worktree、原型修改或额外持久服务。

本文保留首批历史证据。随后 Q09 第二批已加入有界字段格式与执行/历史定义副本，
见 [字段格式 QA](data-view-field-formats-qa.md)；当前下一项为查询期 runtime fields，父任务仍开放。

## 交付与边界

| 范围 | 本批实现 | 不包含或不能推断 |
| --- | --- | --- |
| 本地视图库 | 新建、编辑、筛选、删除确认；名称、稳定连接 ID、索引/别名/数据流/多目标模式、可选默认时间字段 | 不兼容 Kibana Data Views/Saved Objects，不同步服务器配置 |
| 草稿选择 | 查询标签下明确选择同连接视图；管理入口可为其他有效连接新建查询；手改目标解除视图关联 | 不把已有标签改绑另一连接，不修改 DSL、不执行、不打开 PIT |
| 副本隔离 | 所选定义复制入草稿；库中修改/删除后旧副本和原结果保留，有变更/删除提示；重新选择才应用新定义 | 不从当前视图库回填历史执行，不让索引标签携带或应用视图 |
| 默认时间字段 | 复用明确请求的 `_field_caps`；未检查、缺失、类型冲突、非日期、不可搜索与可用证据分开 | 本批只保存字段，不自动生成时间范围；未检查不等于可用或有权限 |
| 恢复与交换 | 可选 `dataView` v1 副本随工作区/命名查询文档 v1 保存；恢复不执行，连接删除仍保留原 ID | 查询交换仍只包含选中的查询定义/模板，不导出本地视图 ID、绑定或时间字段配置 |

入口沿用查询工作台的紧凑工具栏、原生主题下拉和局部对话框；使用 Lucide、双语、
主题 token 和可见焦点，没有新增管理首页或装饰页面。
管理器保存只写本地元信息，不调用 Mapping 或任何 ES 写入 API。

默认时间字段允许 `date` 与 `date_nanos` 的单一、可搜索类型；多类型（包含 date/date_nanos 混合）
仍作为冲突解释。`non_searchable_indices` 非空时不标全目标可搜索。
刷新中/失败不把保留的旧字段目录当本次验证成功；没有权限或浏览器无字段读取时可保存
标为未验证的定义，已知无效字段需清除或改正。该证据不门控原始 DSL 查询。
字段建议使用一次线性筛选，不对每个候选重复查找完整目录；本批未做大字段量性能基准。

## 本地合同

- SQLite schema **v6 → v7**，新增 `data_view_library` 单行表，不改原恢复/查询库数据。
  迁移与版本号在同一事务；失败保留 v6，成功重开不重复建表，不插入演示视图。
  新版本数据库不能交给仅识别 v6 的旧版本打开，禁止手改 `user_version` 绕过检查。
- 视图库文档 v1：`version`、`entries`；每项只有
  `id`、`name`、`connectionId`、`index`、`defaultTimeField`。
  最多 100 项，总序列化 UTF-8 **256 KiB**；ID 为 1-64 个 ASCII 字符，
  名称最多 120 个字符，目标/时间字段各最多 1,024 字节。
- 目标复用现有 `IndexTarget`：最多 64 个逗号分隔目标，每项最多 255 字节；
  支持 `*`，不接受路径、URL、查询片段、排除表达式或远程集群冒号语法。
  不因此声明任意真实目标已存在、可见或可查询。
- `data_views_load` 返回 `{ revision, library }`；只有未保存过才返回修订 0/空库。
  `data_views_save` 只接收 `expectedRevision` 和完整库，返回新的修订号。
  修订限 JS 安全整数；持久行从 1 开始，写满上界拒绝继续增加。
- 保存使用 SQLite immediate 事务：先校验现存文档，再核对 CAS、既有 ID 的连接归属，
  最后写入。新视图必须绑定仍存在的连接 ID；已有视图在连接删除后保留原归属，可删除，
  不因同名新连接或当前选择而重绑。前端也核对编辑/删除时读到的完整条目副本。
- 未知版本、重复键/ID、额外字段、超限与损坏持久行整体拒绝，既有字节不修补或覆盖。
  无端点、认证对象、凭据引用、结果正文、PIT 或任意传输字段。
- 前端写入串行化，提交完成后才更新库列表；旧代次/服务完成不回填新状态。
  重载等待已派发写完成、跳过旧排队意图；失败/未知完成/CAS 冲突不强制重试。
  编辑内容在失败时保留，用户明确“放弃编辑并重新加载”才退出编辑并重新读取。
- 浏览器为独立 session 内存适配，刷新清除；桌面使用 SQLite，失败不降级。
  本批测试未读取或修改用户真实数据库。

草稿可选副本形状为 `{ version: 1, definition: ... }`；副本的连接 ID 和目标必须与草稿完全一致，
不可为 `null`，不能出现在索引标签。恢复和查询库原文档仍为 v1，旧无副本记录可读。
执行历史仍记录实际执行的连接/目标/DSL，不回查或恢复一个后来变动的视图库引用；
结果正文、页码、行选择和认证信息仍不持久化。

## 自动化证据

所有检查在本批代码上执行，Vitest 使用 `--maxWorkers=2`，未提高超时阈值。

| 检查 | 本次结果 |
| --- | --- |
| 新增领域/IPC 首轮 | 2 文件 40 项通过 |
| 新增组件/集成首轮 | 16/20 通过；4 个测试误将 session 恢复提示当桌面保存提示，修正测试适配后复跑 |
| 新增流程复跑 | 59/60 通过；普通无 sort DSL 不开 PIT，修正错误测试预期，不改执行行为 |
| 最终跨模块 Vitest | **19 文件 297 项通过**；包含本批 5 文件 64 项及受影响恢复/库/参数/交换/标签/资源/可视化回归 |
| Rust 定向 | **125 项通过**：Data Views 10、storage 44、恢复 19、查询库 10、交换 11、query 20、operation 11 |
| 定向 ESLint | 所有变动 TS/TSX 与新增测试通过；清理回调改为稳定 callback 后通过 hook lint |
| TypeScript / 正式构建 | `npm run build` 通过（含 typecheck）；JS 单包约 **1,059.13 kB** 的既有类构建警告仍保留 |
| Rust 格式 / 生产库 clippy | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过 |
| 文档与工作区 | 7 份 Markdown、110 个本地链接、36 张表格通过解析检查；39 个变动文件 LF 与 `git diff --check` 通过 |

Rust 定向命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib -- data_views::tests storage::tests workspace_recovery::tests saved_queries::tests query_exchange::tests query::tests operation::tests
```

前端定向文件：

```text
data-views.test.ts                 data-views-service.test.ts
data-views-hook.test.tsx           data-views-ui.test.tsx
app-data-views.test.tsx            domain.test.ts
workspace-tabs.test.ts             workspace-recovery.test.ts
workspace-recovery-hook.test.tsx   app-workspace-recovery.test.tsx
query-library.test.ts              app-library-integration.test.tsx
query-exchange.test.ts             query-exchange-service.test.ts
query-parameters-ui.test.tsx        app-index-tabs.test.tsx
resource.test.ts                   visual-query.test.ts
query-editor.test.tsx
```

以上文件位于 `tests/unit`，命令前缀为 `npm test -- --maxWorkers=2`。
共享 fixture 为 `tests/fixtures/data-views-v1.json`；Rust 使用临时目录数据库，
前端使用显式内存适配与协议 fixtures，不把它们记录为真实服务或原生通过。
未运行全量旧基线、原型、真实 ES/模型、浏览器/WebView、安装包、系统密钥库或跨平台检查。

## 剩余与接续

- [集中人工清单](manual-acceptance.md) 的 Q09 项保持待验：窄窗口/200%/大字号、
  长名称/字段、下拉与 datalist、键盘/焦点、桌面重启和隔离备份上的真实升级失败。
- 真实多索引/别名/数据流、field caps 权限与类型变化需当次授权环境；目录为空不代表目标不存在。
- 本首批未交付查询期 runtime fields、字段格式、时间范围编译/冻结、视图定义本地交换；
  字段格式与执行/历史副本已在 [第二批](data-view-field-formats-qa.md) 增量，其余仍待完成。
  Mapping 写入仍归 W04 和 W01 审核，不能由视图配置绕过。
- 首批接续的第二批字段格式已完成开发自动化；当前下一项为 Q09 第三批查询期 runtime fields，
  随后 Q02 时间与数据探索，继续保留原始值、精确数值、排序/复制/导出和执行副本语义。
  Q09/F07/Q01 及六方向父任务均保持开放。
- 本批验证/文档交接后由主代理本地提交，不推送；全部命令退出后只创建一个 local 后继。
  创建后本会话停止写仓库；更新既有接续监控，不新增监控，不提前睡眠。
