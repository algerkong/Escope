# Q02 第八批：平面固定筛选定义

日期：2026-10-10。从干净 `8ca5ccc` 接手，沿用 `main`。
状态：开发、JSDOM、临时 SQLite 和构建自动化通过；真实 ES、原生与跨平台未验。
前置见 [会话绑定 QA](query-filter-session-qa.md)。本批不关闭 Q02/F07 或六方向父任务。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 固定定义 | 显式命名、完整本地定义预览和字面量确认；保存、筛选列表、删除确认、同目标加载 | 仅平面 mapped 条件；任一 runtime/nested（包括禁用项）均整组拒绝，不截断 |
| 本地合同 | 固定库 v1：100 组/256 KiB，每组 32 条/8 个非空布尔组，值 4 KiB、字段 1,024 字节；名称 120 字符、ID 64 ASCII 字符 | enabled 必填布尔，保留 AND/OR、组归属及精确原 token；未知键、重复条件/成员、未归组等均拒绝 |
| 身份与存储 | SQLite schema v7→v8、独立 `pinned_filter_library` 行，`pinned_filters_load/save` 类型化 IPC；串行 CAS、同事务连接存在性检查 | 既有定义 ID 整体不可覆盖或改目标；另存使用新 ID。已删连接的定义保留身份且可删除，不重绑 |
| 加载与审核 | 只生成同连接 ID + 完全相同目标的会话待审副本，标明“已保存字面量”；没有执行时 snapshot 明确为 null | 不伪造当前结果或持久化恢复绑定；已有待应用/已绑定定义不被覆盖，禁用项仍计配额 |
| 应用与快照 | 启用项核对当前 mapped 字段证据与类型，runtime 遮蔽拒绝；完整 DSL 审核后显式应用 | 旧 query/评分/时间/排序/参数与 PIT 保持，应用不执行。索引只生成同目标新查询 |
| 恢复与失败 | 库删除不改已加载/已应用副本；重挂载只恢复已应用 DSL，不恢复绑定/待应用编辑 | 损坏/未知版本/冲突不覆盖；未知保存结果不重试或放行后续排队写入，须显式重载 |

保存只包含稳定连接 ID、目标、名称和条件定义。结果正文、执行/PIT 身份、端点、认证、
凭据引用、时间/参数/视图元数据与会话基线都不在固定库合同中。
字面量本身可能是业务数据，因此必须全文核对后确认本地保存；本批没有新增定义交换或自动注入。
浏览器使用明确 session 适配，桌面失败不降级。查询/恢复文档 v1、DSL 快照合同 v4 保持。

固定字面量不是当前执行值。它可在从未执行的查询中加载，但启用时仍需字段证据；
缺失/冲突/不可搜索/不支持与未检查保持区分，不由固定定义证明授权。
全禁用首次加载不能提交无变化应用；会话绑定成立后，全禁用/移空沿用第七批完整基线审核。
固定库更新不自动更新旧副本；会话编辑仍需另行固定新定义。

原索引生成查询后，真实后续观察仍保存自己的 query/request ID。本批编译已核对的基线时，
使用实际观察所属文档的身份核对，不改写观察对象，也不把早期索引观察冒充新查询已执行。
新增领域用例覆盖从 null 观察到两次真实执行，再次应用/禁用时基线身份不变。

## 本次验证

最终有效覆盖 **21 个前端文件、481 项**，由两个互不重叠的范围命令
**16 文件 428 项 + 5 文件 53 项**组成；不是全仓测试。Rust **96 项定向**通过。
后续补齐连接测试夹具字段，UI **7 项**复验与上述范围重叠，不累加。

| 检查 | 本次结果 |
| --- | --- |
| 领域/组件/存储前端 | 16 文件 428 项通过：固定合同、原筛选/布尔/nested/启停/绑定、时间/排序、恢复和查询库 |
| 工作台/执行 | 5 文件 53 项通过：本批 7 个工作台用例、既有筛选 22 项及执行 24 项 |
| Rust 固定库 | 10 项通过：共享 fixture、精确数值、严格形状、配额、CAS/不可替换 ID、已删连接、损坏/未知/只读和重开 |
| Rust 跨模块 | storage 47、data_views 17、workspace_recovery 22 项通过；包含 v7→v8、失败回滚、旧行/凭据引用/偏好保留及无默认插入 |
| 静态与类型 | 24 个受影响 TS/TSX 文件 lint；最终 typecheck 通过 |
| 正式构建 | JS 1,367.22 kB、CSS 111.30 kB，原有 500 kB 大包警告保留；未提高阈值 |
| 格式与文档 | Rust fmt、40 文件 UTF-8/LF、9 文档/213 本地链接/57 张表格与 diff 检查通过；提交前再次核对暂存范围 |
| 环境 | 无 OMP、新依赖、worktree、持久服务、原型改动、用户数据库、真实 ES/模型或浏览器/WebView 操作 |

主要范围命令：

```sh
npm test -- --maxWorkers=2 tests/unit/pinned-filters.test.ts tests/unit/pinned-filters-service.test.ts tests/unit/pinned-filters-hook.test.tsx tests/unit/pinned-filters-ui.test.tsx tests/unit/query-filters.test.ts tests/unit/query-filter-session.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-filter-enablement.test.ts tests/unit/query-nested-filters.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx tests/unit/query-time-range.test.ts tests/unit/query-time-range-recovery.test.ts tests/unit/query-sort.test.ts tests/unit/workspace-recovery.test.ts tests/unit/query-library.test.ts
npm test -- --maxWorkers=2 tests/unit/app-pinned-filters.test.tsx tests/unit/app-pinned-filter-lifecycle.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/app-query-filter-session.test.tsx tests/unit/query-executions.test.tsx
npm test -- --maxWorkers=2 tests/unit/pinned-filters-ui.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib pinned_filters::
cargo test --manifest-path src-tauri/Cargo.toml --lib storage::tests::
cargo test --manifest-path src-tauri/Cargo.toml --lib data_views::
cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_recovery::
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run build
```

开发中修正记录：

1. 初轮类型检查发现新测试错误导入、只读夹具赋值和旧断言对可空 snapshot 的访问；
   改为正确契约和可空断言。新 Rust 计数边界夹具默认推断为 i32，补 i64 后 10 项通过。
2. 首轮 UI/工作台为 8/11：新测试用唯一“Close”定位，但既有 Modal 同时有关闭图标和底部按钮。
   改为明确的底部文本按钮选择器后工作台通过；没有修改生产关闭行为。
3. 生命周期首轮为 38/39：测试使用了不存在的“Load next page”，改为已有“Load more”后通过。
   未发生或放宽默认 5 秒超时，不删除流程断言。
4. 最终构建类型检查发现新 UI 连接夹具缺 `sortOrder`/`auth`，补齐后 UI 7 项及正式构建通过。
   复核同时补强真实后续观察的身份保留，领域与工作台均覆盖；没有新增或伪造执行快照。

未运行未受影响的全量前端/Rust、原型、严格 clippy、安装包或真实服务回归。
自动化依靠 JSDOM、受限 mock 和临时数据库，不等于原生窗口、系统密钥库或真实 ES 验收。

## 待验与下一批

真实 ES 仍需核对 keyword/短语/缺失/多值、评分、FLS、别名/多目标漂移及部分失败；
固定定义不能证明当前字段可用或查询授权。原生需核对长名称/值、日夜/双语/窄窗口/200%/
高对比/键盘/焦点/屏幕阅读器、桌面重启/升级/保存失败和跨平台。
具体入口见 [集中人工清单](manual-acceptance.md)，没有新增截图或人工通过声明。

后续 **Q02 固定 mapped nested 定义的有界扩展**已完成，见 [第九批 QA](pinned-nested-filters-qa.md)：
v2 兼容读取本批 v1、不自动改写；保留路径、对象内/父文档否定和布尔组，加载后新取
Mapping/field caps 并完整审核，不伪造观察或套用 runtime。本文件以上仍是第八批历史范围和证据。
固定 runtime、深层条件、完整 Q02 与 W01/W04 继续开放；最新接续见第九批 QA 和执行计划。
