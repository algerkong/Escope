# Q02 第六批：待应用会话筛选启停

日期：2026-10-10。接手基线 `48bdd5c`，工作区干净，沿用 `main`。
状态：开发、JSDOM、类型检查与正式构建自动化通过；真实 ES、原生与跨平台未验。
前置见 [布尔筛选组 QA](query-filter-groups-qa.md)、[nested QA](query-nested-filters-qa.md)
和 [单元格筛选 QA](query-cell-filters-qa.md)。Q02 与六方向父任务保持开放。

本文件记录第六批当时的行为。随后第七批已接入[已应用会话绑定](query-filter-session-qa.md)，
应用后保留禁用定义，替代下文的混合应用弃用确认；可信绑定的全禁用/移空可以经审核恢复
基线。第六批的测试数量和“仅待应用”限制不作为第七批验收结论。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 会话定义 | QueryFilter 可选 enabled，缺省启用，显式状态仅布尔值；逐条切换不删除原值、操作或组归属 | 禁用项仍计 32 条/8 组、值 4 KiB；重复 ID/同组重复/遗漏/未知成员和非法值继续拒绝 |
| 原弹窗 | 原生 switch、组/总启用数、非颜色单一的禁用标签、操作/原值可访问描述 | 复用 token、双语、焦点与高对比控件；不新建管理页面、不开新网络入口 |
| 编译 | 只取启用叶子；有效空组从 AND/OR/nested 父排除中省略 | 不生成空 bool/should/nested，不把被禁用的组转换成 match_all/match_none 或独立存在性 |
| 全禁用 | 逐字预览原 DSL，时间 hadQuery/边界保持；不提交空操作或创建无变化索引查询 | 真正没有定义的空组仍非法；会话列表未结束前依然阻止运行/保存/索引刷新 |
| 证据 | 禁用定义验证本地字段/类型/原值/作用域形状，暂不要求当前字段证据；重新启用全面重查 | 当前 Mapping/field caps/runtime 必须满足既有约束；失败不回用旧成功，不把禁用视为授权 |
| 审核 | 启停/组/会话对象/源/执行/证据变化作废预览；混合列表另行确认丢弃禁用定义后才可应用 | 确认只绑定当前预览，不因语言切换重发，不自动执行或改参数模板；CAS 失败不丢列表 |
| 隔离 | 设置/标签/连接往返保持待应用状态；应用只更新 DSL，旧 PIT/结果不改 | 未应用状态不进恢复/IPC/历史；索引只显式生成同目标查询，原索引标签不变 |

**本批限待应用会话草稿内启停，不是已应用 DSL 的可逆托管。**
沿用应用后清空待应用列表的生命周期：如果还有禁用定义，必须在完整预览后另行确认其丢弃，
不能借“应用”静默删除。全禁用时只有保留、重新启用或明确丢弃，应用按钮不提交无变化操作。
后续用显式基线/已应用文档绑定保留已应用定义，不能反向猜测手写 DSL 中哪些部分可管理；
固定/持久化仍另批增量。没有新依赖、Rust、IPC 或 schema 变化：
schema v7、文档 v1、DSL 快照合同 v4 不变。

## 空组与否定

这里的“有效空组”是定义非空、但所有成员均禁用的组。定义与组 ID/模式/父匹配仍保留，
只有本次生成的 DSL 省略它；真正空的 filterIds、遗漏成员或重复归属仍拒绝。

| 定义 | 启停状态 | 实际筛选贡献 |
| --- | --- | --- |
| A AND B | A 禁用 | B |
| A OR B | A 禁用 | B，仍显式 MSM=1 |
| G1 OR G2 | G1 全禁用 | 只有 G2，不把 G1 变成总是成立的 OR 分支 |
| G1 AND G2 | G1 全禁用 | 只有 G2，不把 G1 变成总是失败的占位 |
| nested 内 A AND NOT B | A 禁用 | 同一 nested 对象内 NOT B，仍可能由另一个对象匹配 |
| NOT nested(A AND B) | A 禁用 | NOT nested(B)，排除只在原父层分支内 |
| NOT nested(A) | A 禁用 | 整组无贡献，不能变成“没有任何 nested 对象” |
| 所有组全禁用 | 全禁用 | 原 DSL 逐字不变，无新增 wrapper；UI 不提交空操作 |

所有保留的 OR 仍显式 `minimum_should_match: 1`，nested 仍为 `score_mode: none`、
`ignore_unmapped: false`。原 query 的 should/MSM/boost/精确数字、排序/聚合/时间 wrapper
不被展开、合并或反向转换。禁用 leaf 的数组/对象/错误状态、超限值与错组不能用作校验逃逸。
禁用时缺少当前 Mapping 可以预览其余启用条件；再次启用时缺失/失败/目标漂移照常阻止预览。

## 本次验证

| 检查 | 本次结果 |
| --- | --- |
| 首轮领域 | 4 文件 179 项通过，包含新增启停、布尔组、nested 与原单元格领域 |
| 首轮组件/工作台 | 3 文件 57 项通过 |
| 最终受影响回归 | 9 文件 312 项通过，包含前述范围及查询执行/实时结果；早期数量重叠，不相加 |
| 静态与构建 | 10 个变动 TS/TSX/测试文件 lint、typecheck/正式构建通过 |
| 初轮类型修正 | 新量词 oracle 的空对象数组推断为 `{}`，显式标注 TestDocument 后 typecheck 通过；未改测试超时或生产代码来规避 |
| 文档与 diff | 20 个变更文件 UTF-8/LF、9 文档/196 本地链接/57 张表格及 diff 检查通过 |
| Rust/原型 | 本批均无变更，不重跑旧全量、Rust、原型、clippy 或安装包；不引用旧通过记录作为本次证据 |

布尔测试覆盖 8 种组内/组间模式、16 种启用掩码、16 种叶子真值；
nested 测试覆盖 8 种根/对象/父匹配组合、8 种启用掩码与无对象/空数组/空对象/多对象反例。
这些是有界逻辑 oracle，不是 Elasticsearch 索引、缺失处理、analyzer、权限或评分模拟器。

组件验证原生空格切换与焦点、可访问描述、禁用定义及分组保持、有效空组、省略父排除、
全禁用逐字预览/禁止提交、混合应用额外确认、源/快照/端点/证据变动后确认失效和双语。
工作台验证全禁用的按钮/快捷键/保存/排序/索引刷新保护、设置/连接往返、
无效可视化草稿、同目标新查询、时间/排序与旧 PIT、只恢复已应用 DSL。
重挂载的 session 适配不是原生重启；mock 请求不是 ES 实际量词或权限结果。

```sh
npm test -- --maxWorkers=2 tests/unit/query-filter-enablement.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-nested-filters.test.ts tests/unit/query-filters.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/query-executions.test.tsx tests/unit/query-live.test.tsx
npx eslint src/domain/query-filters.ts src/features/query/QueryFiltersDialog.tsx src/features/query/QueryWorkspace.tsx src/locales/query-filters.ts tests/unit/query-filter-enablement.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-nested-filters.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx tests/unit/app-query-filters.test.tsx
npm run build
```

最终构建 JS **1,342.46 kB**、CSS **110.48 kB**；原有 500 kB 警告保留。
主代理独占实现/审查/验证，无 OMP、worktree、持久服务、用户数据库、真实 ES 或密钥库操作。

## 待验与下一批

真实 ES 仍需授权环境核对缺失/null_value/多值、全负向 OR、nested 同对象/独立对象/
空对象/父排除、评分、FLS/runtime、别名/多目标漂移、PIT/部分失败及成本。
原生仍需核对双语/日夜/窄窗口/200%/高对比、Tab/空格/屏幕阅读器、长字段/原值、
弃用确认、焦点、关闭/重启与跨平台。见 [集中人工清单](manual-acceptance.md)；
本批没有浏览器/WebView/截图或人工通过声明。

下一批 Q02 有界已应用筛选会话绑定：显式持有基线及已应用文档/定义副本，
完整预览后再次启停，处理手改失配或解除；不能解析任意手写 DSL 猜托管关系。
固定/持久定义随后，W01/W04 审核前置和六方向父任务保持开放。
本批必要验证/交接后本地提交，再只创建一个 local 后继并更新既有监控，不推送、不提前睡眠。
