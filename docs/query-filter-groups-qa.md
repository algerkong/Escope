# Q02 第四批：有界布尔筛选组

日期：2026-10-10。接手基线 `09a23aa`，工作区干净，沿用 `main`。
状态：开发、JSDOM、正式构建与 Rust 请求合同自动化通过；真实 ES、原生与跨平台未验。
前置见 [单元格筛选 QA](query-cell-filters-qa.md)、[服务器排序 QA](query-sort-qa.md)
和 [时间范围 QA](query-time-range-qa.md)。Q02 与六方向父任务不关闭。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 布尔定义 | 组内、组间分别选择 AND/OR；每个 OR 显式写 `minimum_should_match: 1` | 最多 8 个非空组、总计 32 条；每条筛选恰属一组，无更深组、组级 NOT、自定义最少匹配数 |
| 编辑 | 原审核弹窗内分段单选、条件所属组下拉、新组与移组；最后一条移出或删除后移除空组 | 不预建空组，不复制或丢弃条件；改变结构、成员或字段读取状态均作废旧预览 |
| 语义 | 新组合与完整原 query 取 AND 交集；正向、排除、存在性在所属分支解释 | 全部新增条件在 filter 上下文，不参与评分；不合并或重写原 should/MSM |
| 审核 | 显示当前/完整最终 DSL，显式应用；同目标字段与实际 runtime、精确原值校验复用 | 不自动执行，未应用筛选继续阻止运行/保存/排序；无效可视化草稿不能绕过 |
| 快照与恢复 | 时间 wrapper、绑定、排序、参数模板和旧结果保留；旧 PIT 续页仍取原执行 | 分组仅保存在当前会话，只有应用后的 DSL 按既有规则恢复；索引仍只生成同目标新查询 |

分组控件沿用主题 token、紧凑尺寸、原生 radio/select、双语、Lucide 动作与可见焦点。
移组保留条件行身份和下拉焦点；高对比模式提供原生 radio。
布局、屏幕阅读器、原生键盘与高对比实机表现仍是待验项，不以 CSS/JSDOM 断言代替。

## 查询语义

- AND 组的正向条件进入 `filter`，排除与 missing 进入该组的 `must_not`。
  OR 组的每一条排除生成独立 `bool.must_not` 分支，不上提为其他分支的全局排除。
  例如 `A OR NOT B` 不是 `(A OR B) AND NOT B`；`NOT A OR NOT B` 也不是 `NOT (A OR B)`。
- `exclude` 继续包含没有索引值的文档，missing 仅在明确选择后生成 `must_not exists`。
  OR 可能因负向分支而匹配大量文档；不偷偷增加 exists 或改变任一分支的含义。
  数组仍只选择一个执行原值，text 仍是分析短语而非精确相等，不猜 keyword 子字段。
- 每个新增 OR 都有整数 `minimum_should_match: 1`，包括单成员 OR；
  不依赖 bool 是否含 must/filter 的默认值。组间 OR 也放在外层 filter 中，
  不能使 text 或 should 分支增加分数。没有原 query 时保留 match_all 的默认评分。
- 原 query 按原始 token 完整放入 must；原 should 的隐式/显式 MSM、boost、
  constant_score、function_score、dis_max 与精确数值/转义不被改写。
  原 post_filter、sort、min_score、聚合与 runtime 声明仍按原作用域生效，
  不声称 global 聚合也受新增筛选限制。
- 同一待应用筛选恰好出现一次；遗漏、重复引用、未知引用、重复组 ID、空组、
  未知操作/额外属性或更深层结构均拒绝，不能通过忽略成员或展开近似逻辑“修复”。
  相同字段/操作/原值的重复筛选仍拒绝，不提供跨组共享叶节点的任意布尔表达式。
- 既有 4 KiB 单值、32 数组元素、64 KiB 单元格、256 KiB 最终 DSL 和解析深度上限保留。
  未知顶层、混合检索、手写游标/PIT、未替换参数、失效时间绑定继续拒绝组合。
  这些 UI 证据不限制合法手写 DSL 的原执行通道，也不构成权限证明。

领域层只进行 JSON AST 位置编辑，替换原 query 或托管时间 wrapper 内的原 query。
单一 AND 组保留上一批平面筛选的输出合同。组对象不进入查询/PIT、工作区/查询库或历史 schema。
时间运行前冻结、移除时间后保留已应用组合、参数模板不被自动改写的规则保持。
执行用实际 rawDsl；未应用 Data View runtime 不作为证据，runtime 原值仍只能来自 fields。
PIT 不冻结脚本输出，后端的认证、只读授权和全量导出限制没有变化。

## 自动化证据

前端均使用 `--maxWorkers=2`，未提高超时；本批没有失败后提高阈值或隐藏失败的重跑。

| 检查 | 本批记录 |
| --- | --- |
| 开发定向 | 初轮领域/组件 3 文件 99 项通过；补齐分组 UI/工作台后 2 文件 30 项通过 |
| 筛选完整子集 | 5 文件 117 项通过：领域、布尔组、弹窗、工作台与表格原值入口 |
| 受影响回归 | 8 文件 237 项通过：排序领域/工作台、时间/恢复、执行、编辑器、受限反向转换与分组弹窗 |
| 去重覆盖 | 12 文件 332 项；上两组仅分组弹窗 22 项重叠，不相加为 354 项 |
| 静态与构建 | 7 个变动 TS/TSX/测试文件 lint、typecheck/正式构建通过 |
| Rust | 查询/时间 33 项、fmt 通过；仅新增共享分组请求 fixture 测试，无生产 Rust 变化 |
| 文档与 diff | Markdown AST 检查 7 文档、166 个本地链接、43 张表格；17 文件 UTF-8/LF 与 `git diff --check` 通过 |

新增布尔领域测试覆盖 8 种组间/组内 AND/OR 组合的 16 行真值表、全负向 OR、显式缺失、
单成员 MSM、原评分 query 字节保留、精确 runtime/短语、时间冻结/移除、参数保留与边界拒绝。
这只是生成子集的逻辑校验，不是 Elasticsearch 执行或评分模拟器。

`tests/fixtures/query-filter-groups-v1.json` 由前端生成合同测试和 Rust 请求组装测试共享。
普通搜索、PIT 首页、续页保留 query/sort/min_score/runtime/fields 及多项精确游标；
分组或时间元数据不进入请求。旧平面筛选和时间 fixture 回归保持通过。

JSDOM 覆盖分组/移组/合并/清空、上限、键盘 radio、焦点、双语、预览失效、
字段刷新、源草稿/目标/执行变化、CAS 失败、设置/连接/标签往返、索引新查询与未应用状态守卫。
真实后端未连接；会话恢复 fixture 和组件重挂载不等于原生 SQLite 重启验收。

```sh
npm test -- --maxWorkers=2 tests/unit/query-filters.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/query-filters-grid.test.tsx
npm test -- --maxWorkers=2 tests/unit/query-sort.test.ts tests/unit/app-query-sort.test.tsx tests/unit/query-time-range.test.ts tests/unit/query-time-range-recovery.test.ts tests/unit/query-executions tests/unit/query-editor.test.tsx tests/unit/visual-query.test.ts tests/unit/query-filters-ui.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib -- query::tests query_time_range::tests --test-threads=2
cargo fmt --manifest-path src-tauri/Cargo.toml --check
npm run build
```

正式构建 JS **1,322.17 kB**、CSS **108.77 kB**，原有 500 kB 警告保留，未调整阈值。
schema v7、文档 v1、DSL 快照合同 v4 保持。无新依赖、OMP、持久服务、worktree 或用户数据库操作。
未改原型，未启动浏览器/WebView、真实 ES/模型、密钥库或重建安装包；
未重跑全量前端/Rust、clippy、原型或依赖审计，不把历史结果当本批证据。

## 依据与待验

本批实际读取 [Elastic Boolean query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-bool-query)
（2026-10-10，HTTP 200）：must/filter/must_not/should、MSM 默认值及 filter 评分边界。
官方语义资料不替代真实授权环境联调。

真实 ES 待验：不同 bool/boost/函数评分的筛选前后 `_score`、全负向 OR 和字段缺失、
analyzer/normalizer/null_value、多值/FLS/多目标冲突、runtime 成本/变化、PIT/部分失败及性能。
原生待验：中英文/日夜/窄窗口/缩放/高对比、radio/select 与屏幕阅读器、长值滚动、
焦点/IME、关闭/重启及跨平台。详见 [集中人工清单](manual-acceptance.md)，无本批截图或原生通过声明。

后续有界显式 nested 条件组已交付，见 [nested QA](query-nested-filters-qa.md)：
同目标 Mapping/field caps、同一对象条件与外层父排除、完整审核应用，保留原查询/时间/排序。
筛选启停/固定/持久定义、其他数据探索与 W01/W04 写入审核仍开放。
本批交接后本地提交并创建一个 local 后继，更新既有监控，不推送、不提前睡眠。
