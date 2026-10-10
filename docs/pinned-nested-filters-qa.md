# Q02 第九批：固定 mapped nested 定义

日期：2026-10-10。从干净 `7f604fa` 接手，沿用 `main`。
状态：开发、JSDOM、临时 SQLite 和构建自动化通过；真实 ES、原生、性能与跨平台未验。
前置见 [平面固定 QA](pinned-filters-qa.md) 和 [nested 语义 QA](query-nested-filters-qa.md)。
本批不关闭完整 Q02/F07 或六方向父任务。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 固定合同 | 库文档 v2，条件可选 nestedPath、组可选 nested 的 path/match；保留平面条目 | 只接顶级路径与直接 mapped 标量，不从点路径/源对象猜 nested；runtime 固定仍整组拒绝 |
| 兼容 | v1 平面库原样读取，读取/重开不写库；显式新增时升级为 v2，保留原定义 | 删除 v1 条目不升级；已存 v2 不允许降级。未知版本/字段、显式 null、非法形状与不完整成员整库拒绝 |
| 组语义 | 同组对应同一对象、内部否定与父文档排除分离；组内/组间 AND/OR、MSM=1、启停 | 同组重复拒绝，独立 nested 组可重复相同条件；禁用仍计配额，无启用成员不产生空 nested 或父排除 |
| 保存 | 全文定义/字面量确认，精确 JSON token、组和启停深拷贝；既有 ID 不覆盖 | 100 组/256 KiB，每组 32 条/8 非空组、值 4 KiB、字段/路径 1,024 字节；不保存结果、证据、端点、DSL、PIT 或绑定 |
| 加载审核 | 同连接 ID + 完全相同目标，载入标明已保存字面量的副本；无执行观察为 null | 启用 nested 项须本次显式新查 Mapping/field caps；不使用旧缓存、更早在途请求的完成或保存时证据，不覆盖已有会话定义 |
| 当前证据 | 复用有界 Mapping 解析，核对实际索引非空且一致、顶级 nested/直接叶子类型及 searchable | 缺失/冲突/不可搜索、失败/漂移、未知对象标志、runtime 遮蔽分别拒绝；不是权限、脚本可用或实际查询成功证明 |
| 应用隔离 | 完整 DSL 预览后显式应用；旧 query/评分/时间/参数/排序与 PIT 保持 | 不执行；索引只生成同目标新查询，后续真实观察不改身份；库删除不改副本，重启只恢复已应用 DSL，不恢复可信绑定 |

schema v8、恢复/查询文档 v1、DSL 快照合同 v4 及 `pinned_filters_load/save` 命令名保持。
没有新依赖、额外管理页或新网络接口；浏览器仍为明确 session 适配，不作桌面失败降级。
保存只记录定义和可能具有业务含义的字面量，仍须本地保存确认。
读取 v1 不改写的临时 SQLite 用例保留原有 JSON 空白；显式升级只改变库版本和新增条目，
旧定义 ID 的字段、组、启停或目标都不能趁升级覆盖。

saved 字面量只根据当前 DSL 与当前 Mapping/field caps 判断，旧执行中的 runtime 声明
不被套用；当前路径或其下任一平面 runtime 仍拒绝。没有观察时不造 ExecutionSnapshot。
已有会话绑定继续从精确基线重建，禁用/移空不叠 wrapper，反序列化副本不能恢复信任。

## 本次验证

前端有效覆盖 **18 文件 391 项**，不是一次全仓命令：
四组初始范围分别为 **4 文件 157 项、5 文件 39 项、3 文件 11 项、6 文件 182 项**；
补强 v2 限额后，新增领域文件 **47 项**复验替换其原 46 项；
复审新增旧在途证据反例后，新增 UI 文件 4 项替换其原 3 项，与工作台 4 项/原 nested UI
15 项合并为 **3 文件 23 项**重叠复验，不重复累加。
Rust 最终 **86 项**：固定库 **17**、storage **47**、workspace_recovery **22**。

| 检查 | 本次结果 |
| --- | --- |
| 领域 | v1/v2 共享 fixture、精确 token、严格路径/组/null/版本、配额、同组/独立组重复、当前 Mapping/类型/runtime、无观察绑定和时间/参数保持 |
| 弹窗与持久化 | v1 不自动写库、显式升级/删除、嵌套深拷贝、CAS/未知完成守卫；新 Mapping/field caps 审核、失败/漂移作废、禁用/双语/焦点 |
| 工作台 | 未执行加载、删除库不改副本、重挂载只还原 DSL、索引新查询和真实后续观察、旧 PIT 请求隔离；原平面和会话筛选回归通过 |
| Rust | 独立合同校验、临时 SQLite 原文读取不写/显式升级/重开、v2 降级拒绝、既有 ID 不覆盖、已删连接、CAS/损坏/未知/只读与恢复隔离 |
| 静态与类型 | 14 个受影响 TS/TSX 文件 lint 通过；限额补强文件单独复验，最终 typecheck 通过 |
| 正式构建 | 最终 JS 1,367.77 kB、CSS 111.30 kB；原有 500 kB 大包警告保留，未提高阈值 |
| 格式 | Rust fmt、28 文件 UTF-8/LF、10 文档/227 本地链接/60 张 GFM 表格及 diff 检查通过 |
| 环境 | 主代理独占实现/复核，无 OMP、新依赖、worktree、持久服务、原型、用户数据库或真实服务操作 |

主要范围命令：

```sh
npm test -- --maxWorkers=2 tests/unit/pinned-filters.test.ts tests/unit/pinned-nested-filters.test.ts tests/unit/query-nested-filters.test.ts tests/unit/query-filter-session.test.ts
npm test -- --maxWorkers=2 tests/unit/pinned-filters-service.test.ts tests/unit/pinned-filters-hook.test.tsx tests/unit/pinned-filters-ui.test.tsx tests/unit/pinned-nested-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-pinned-nested-filters.test.tsx tests/unit/app-pinned-filters.test.tsx tests/unit/app-pinned-filter-lifecycle.test.tsx
npm test -- --maxWorkers=2 tests/unit/query-filters.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-filter-enablement.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/app-query-filter-session.test.tsx
npm test -- --maxWorkers=2 tests/unit/pinned-nested-filters.test.ts
npm test -- --maxWorkers=2 tests/unit/pinned-nested-filters-ui.test.tsx tests/unit/app-pinned-nested-filters.test.tsx tests/unit/query-nested-filters-ui.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib pinned_filters::
cargo test --manifest-path src-tauri/Cargo.toml --lib storage::tests::
cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_recovery::
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run build
```

开发中首轮 typecheck 发现新时间组合测试直接展开可空 QueryDocumentPatch，
不是合法完整 QueryDocument；改用已验证 DSL 与明确非空/缺省范围构造测试文档后通过。
初始 Vitest 四组范围均通过。提交前复审发现只比较缓存引用会接受较早在途请求在打开后的完成，
未能强制本次显式检查；定向 `-t "earlier in-flight"` 的 1 项反例先失败（另 3 项未选运行）。
修正为弹窗内显式检查标记，同时捕获当时两份证据引用；无点击或两份新读取未完成时拒绝审核。
原缓存、失败/刷新、禁用再启用与工作台 3 文件 23 项随后通过，对应两文件 lint 和正式构建复验通过。
最终 build 内的 typecheck 再次通过，没有提高默认超时或删除流程断言。
Rust 固定库先 16 项通过，追加 v2 配额用例后 17 项通过，前述 86 项只取最终有效结果。

未运行未受影响的全量前端/Rust、原型、严格 clippy、安装包或真实 ES/模型服务。
JSDOM、协议 fixture 和临时 SQLite 不等于原生窗口、系统密钥库或实际 Elasticsearch 验收。

## 待验与接续

真实 ES 需逐项核对同对象/独立对象、空/缺失、内部否定/父排除及评分；
多目标解析/FLS/Mapping 漂移/runtime 遮蔽、部分失败和 PIT 续页保持待验。
原生需检查双语/日夜/高对比/200%/窄窗口、长路径和值、键盘/屏幕阅读器/焦点、
桌面备份后的 v1→v2 定义升级、旧版本拒绝新库、保存失败/重启和跨平台。
见 [集中人工清单](manual-acceptance.md)，没有新增截图或人工通过声明。

下一批为 **Q02 平面查询期 runtime 固定定义**：兼容 v1/v2，保存有界精确声明与字面量，
脚本文字另行确认；加载只检查当前已应用 DSL 中相同声明，不隐式注入或执行脚本，
不伪造执行 fields 或恢复可信绑定。nested runtime、深层条件、完整 Q02/F07 与 W01/W04
继续开放。本批交接、本地提交后仅创建一个 local 后继并更新既有监控，不推送、不提前睡眠。
