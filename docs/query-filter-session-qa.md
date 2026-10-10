# Q02 第七批：已应用筛选会话绑定

日期：2026-10-10。接手干净 `d2a66da`，沿用 `main`。
状态：开发、JSDOM、类型/静态检查与正式构建通过；真实 ES、原生和跨平台未验。
前置见 [启停 QA](query-filter-enablement-qa.md)、[nested QA](query-nested-filters-qa.md)
和 [布尔组 QA](query-filter-groups-qa.md)。Q02 及六方向父任务保持开放。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 显式绑定 | 基线/已应用文档、目标端点、观察快照、定义与分组深拷贝并冻结；本地创建身份核对 | 不从任意 DSL 推断托管部分；反序列化副本不成为有效绑定，不含结果正文/PIT/认证 |
| 再次编辑 | 紧凑会话条与原弹窗；待应用副本和已应用定义独立，混合应用保留禁用项 | 32 条/8 组/值 4 KiB/最终 DSL 256 KiB 不变；替代第六批弃用确认，不静默删除禁用定义 |
| 基线重建 | 完整 DSL 预览后替换本绑定贡献；全禁用逐字恢复基线并保留定义 | 不重复追加 wrapper；已有手写 query/should/MSM/评分、精确 token 和非 query 选项保留 |
| 移除与取消 | 移除最后一项也须预览/应用；零项编辑仍保护运行/保存；取消只丢待应用副本 | 未编辑的绑定审核直接关闭不产生待应用列表；未绑定全禁用仍不能提交空操作 |
| 失配与解除 | DSL/目标/时间/排序/参数/视图定义等修订失配时阻止覆盖；明确确认解除 | 解除只遗忘会话定义，当前 DSL/结果不变；不把相同文本重输视为恢复旧修订，结果视图切换不破坏绑定 |
| 观察与索引 | 接纳新条件后保留实际核对的观察快照；索引明确创建同目标查询并保留真实来源身份 | 不伪造新查询已执行；来源索引关闭后仍可审核新查询绑定；失败重跑不变成成功证据 |
| 时间与恢复 | 基线时间意图/hadQuery 保留；明确运行才重新冻结；旧 PIT/历史独立 | 参数模板不自动回写；定义/基线/绑定不进 IPC 或恢复存储，重启仅恢复实际已应用 DSL |

没有新依赖、Rust、IPC/schema 或原型变化。SQLite schema v7、恢复文档 v1、DSL 快照合同 v4 保持。
本批状态只在 QueryWorkspace 会话内；固定/持久化并未实现，也不能把本地 WeakSet 身份作为
后续持久恢复校验。任何后续定义复用仍须区分历史原值与当前字段证据，不默认注入或执行。

## 关键边界

- 每次预览从原始基线重新编译，而非在上一次应用结果上追加。原查询即使包含与生成结果
  相似的 bool/nested/term 也保持原样；全部禁用只撤去有绑定的新增贡献。
- 全禁用的“保留定义”和移空的“遗忘定义”分开。对尚未应用的列表，全禁用仍是无操作；
  对已应用绑定，全禁用可以撤去已加入的条件。只有分组/定义变化时才允许会话内同 DSL 提交。
- 字段与 Mapping 刷新、启停、源草稿、执行和端点变化仍作废审核。重新启用按当前证据校验，
  不把旧成功、禁用状态或固定来源身份当作权限。
- 手改 DSL、服务器排序、时间、参数或 Data View 等修改可以正常保留，但旧筛选绑定不再
  有权还原基线。用户可查看失配状态并明确解除；不解析修改后的 DSL 猜测哪些条件仍归绑定。
- 新查询没有自己的执行时，只使用被明确转交的索引观察，不改写 requestId/queryId；
  其新执行和原索引旧 PIT 仍独立。无效可视化草稿、零项编辑和迟到请求守卫继续有效。
- 会话深冻结副本不是历史/导出数据。运行只发送最终 DSL；保存/重挂载只还原 QueryDocument，
  不恢复绑定或自动执行，不从当前查询库回填旧绑定。

## 本次验证

有效覆盖 **14 个测试文件、445 项**，由本轮已通过的 **12 文件 423 项**与最终拆分后的
**2 个工作台文件 22 项**组成。不是一次 445 项命令全绿，早期 50/64/72 项均重叠，不相加。

| 检查 | 本次结果 |
| --- | --- |
| 领域/弹窗/执行/时间/排序 | 范围回归的其余 12 文件 423 项通过；包含 22 项新绑定领域用例 |
| 工作台最终复验 | 拆分后的待应用/已绑定 2 文件 22 项通过，仍为 `--maxWorkers=2` 和默认 5 秒限制 |
| 静态与类型 | 10 个变动 TS/TSX/测试/夹具文件 lint 通过；最终 typecheck 通过 |
| 正式构建 | 源码最终版本构建通过；JS 1,349.38 kB、CSS 110.25 kB，原有大包警告保留 |
| 文档与 diff | 20 文件 UTF-8/LF、9 文档/204 本地链接/57 张表格与 diff 检查通过 |
| Rust/原型/服务 | 本批未改 Rust/原型，不重跑其回归；无真实 ES、模型、用户数据库、浏览器/WebView 或安装包操作 |

开发中如实保留以下修正记录：

1. 新测试尝试写只读参数叶子、在函数内读取宽联合 Loadable 的 data，首次类型检查拒绝；
   改为合法替换参数副本及 `satisfies` 保留具体夹具类型，最终通过。
2. 复核新增两个红例：接纳较新 runtime 条件后仍保留过早观察快照、移空时 null 分组抛异常。
   改为编译和绑定共用实际核对的观察选择，并拒绝非法分组形状；范围回归领域 22 项全过。
3. 与构建并行的首轮范围回归为 **442/444**：原有组合流程触到 5 秒，随后重挂载造成下一例
   重复 DOM。先把保存/重挂载集中到独立用例；整文件复验又有最后一条移空场景超时，
   该场景隔离运行 **1/1**、测试体 2.63 秒通过。
   最后共享原夹具，将已绑定与待应用拆为两个测试文件，并集中重复恢复断言；
   最终 **22/22** 通过。未提高阈值、降低功能断言或改生产行为规避测试。

本次实际执行的主要命令（第一条为上述部分失败的范围回归，第二条为最终工作台复验）：

```sh
npm test -- --maxWorkers=2 tests/unit/query-filter-session.test.ts tests/unit/query-filter-enablement.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-nested-filters.test.ts tests/unit/query-filters.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/query-executions.test.tsx tests/unit/query-live.test.tsx tests/unit/query-time-range.test.ts tests/unit/query-sort.test.ts tests/unit/app-query-sort.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-query-filters.test.tsx tests/unit/app-query-filter-session.test.tsx
npx eslint src/domain/query-filter-session.ts src/domain/query-filters.ts src/features/query/QueryFiltersDialog.tsx src/features/query/QueryWorkspace.tsx src/locales/query-filters.ts tests/unit/query-filter-session.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/app-query-filter-session.test.tsx tests/unit/query-filter-workspace-fixture.tsx
npm run build
npm run typecheck
```

复核包括连续 12 次启停/重建、精确 token 与原 should/MSM、nested 父排除、时间 hadQuery、
新旧快照、runtime 新观察、伪造/克隆绑定、字段证据缺失、零项编辑、参数模板不变、
失败重跑、原索引关闭、取消/解除和会话恢复隔离。JSDOM 不是原生窗口或 Elasticsearch。
主代理完成实现、复核和验证，无 OMP、worktree、持久服务或外部服务操作。

## 待验与接续

真实 ES 仍须核对缺失/null_value/多值、should/MSM/评分、nested 内外否定、FLS/runtime、
别名/多目标漂移、PIT/部分失败与性能。原生仍须核对日夜/双语/窄窗口/200%/高对比、
开关和解除确认的焦点/键盘/屏幕阅读器、长字段/原值、关闭/重启及跨平台。
见 [集中人工清单](manual-acceptance.md)，没有新增截图或人工通过声明。

下一批为 **Q02 有界固定筛选定义首批**：先限定平面 mapped 条件的显式保存/删除与同目标复用，
保留布尔组/启停，使用稳定连接 ID 和严格有界的版本化本地合同；含 runtime/nested 时明确
拒绝本批固定，不截断为部分定义。加载仅产生待审定义，区分保存的字面量和当前执行原值，
不伪造执行快照，不直接序列化本批会话绑定，不跨目标注入或自动执行。
共享 IPC/schema 变更须补 Rust/恢复/CAS 回归；固定 runtime/nested、完整 Q02 与 W01/W04 继续开放。
交接、本地提交后只创建一个 local 后继并更新既有监控，不推送，不提前睡眠。
