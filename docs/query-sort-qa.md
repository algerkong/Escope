# Q02 第三批：有界服务器多字段排序

日期：2026-10-10。接手基线 `44a9cfa`，工作区干净，沿用 `main`。
状态：开发、JSDOM、正式构建与 Rust 定向合同自动化通过。
真实 ES、原生界面、跨平台和性能未验，不关闭 Q02 或六方向父任务。
前批见 [单元格筛选 QA](query-cell-filters-qa.md) 与 [时间范围 QA](query-time-range-qa.md)。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 独立入口 | 查询工具栏 Lucide 排序按钮、紧凑双语审核弹窗，字段增删/方向/优先级上下移 | 不把表头 TanStack 排序变成服务器操作；索引标签仍锁定，沿用已有新建查询入口 |
| 排序子集 | 最多 8 个平面字段、升降序、默认/最前/最后缺失位置、显式兼容 unmapped_type | 字段 1,024 字节、源/最终 DSL 256 KiB；不猜 keyword 子字段、nested、geo、script 或类型转换 |
| 已有排序 | 支持单字段字符串/对象和有序数组、order/missing/unmapped_type 白名单 | 原 sort 的未知选项、复杂路径、重复字段或超限整体拒绝，不能用清空静默覆盖 |
| 字段证据 | 同连接/端点/目标的显式 field caps、当前实际 DSL runtime 声明 | 未检查/失败/缺失/未映射/冲突/不可排序/不支持分开；不是授权、doc values 或运行成功证明 |
| 应用与隔离 | 完整原/最终 DSL、显式应用或移除、草稿 CAS、字段刷新需重新预览 | 只改 sort；保留原条件、时间绑定、精确值、脚本文字和参数模板；不执行、不改旧结果 |
| 续页与恢复 | 旧 PIT 续页仍使用原执行 DSL；新运行冻结新排序和时间；应用 DSL 按原存储规则恢复 | 未应用选项只在弹窗中，取消丢弃；不新增持久定义、执行元数据或 IPC |

## 语义与安全

- 默认方向复用 `visual-query`：`_score` 降序，其他字段升序。`_doc` 与 `_shard_doc` 作为
  内置字段不接受 missing/unmapped；`_shard_doc` 只在当前请求可走首页 PIT 时获准生成，
  不偷偷改 `from`、`size` 或手写游标。PIT 的隐式 tiebreaker 不由前端注入。
- 缺失指没有排序值，不等同于 `_source` 缺键或 null。默认 `_last`，
  支持显式 `_first`/`_last`；自定义数值或字符串缺失值保留在手写 DSL，不由本入口改写。
  包括字面量 `"default"`，不能把它误当“省略 missing”而改变语义。
- 未映射默认让服务端失败；只有用户明确选择兼容类型才写入 `unmapped_type`。
  它不把冲突字段转换成一致类型，也不证明全部目标均已映射。
  若证据明确报告一部分未映射，须选择相容策略；只报告 unmapped 或目录缺失时不能猜字段类型。
- 已映射排序候选限 keyword/constant_keyword、数值、boolean、date/date_nanos 和 ip；
  要求报告可聚合且没有 `non_aggregatable_indices`。后者非空或格式异常时不能仍标全目标可用。
  可以接受不可搜索但可聚合的 doc-values-only 字段；聚合标志仍不是完整排序能力或授权证明。
  `constant_keyword`/`scaled_float` 不生成需额外配置的 unmapped 类型。
- text、geo、对象、nested 与含点路径不属于此子集；不猜 `.keyword`，
  不将 date/date_nanos 或 long/double 冲突静默转为 `numeric_type`。
  多值使用 ES 默认：升序 min、降序 max；显式 `mode`、`format`、`nested` 等选项保持手写路径。
- runtime 只取源草稿实际 `runtime_mappings`，不取未应用 Data View 定义或旧结果。
  类型只提供声明证据；脚本编译、权限、版本、性能仍由受限后端/ES 检查。
  不执行前端脚本，不因有 PIT 声称脚本输出冻结，不改变全量导出的 runtime 拒绝规则。
- 位置编辑只替换/插入/删除顶层 sort；未知顶层、手写 PIT/search_after、collapse、
  knn/retriever/rescore 等有独立排序语义的请求拒绝组合。原始 DSL 执行通道没有被新的 UI 证据门控。
  无修改时保留原 sort 字节，不为预览随意规范化；有修改时最终预览仅做无损空白格式化。
- 托管时间显式携带原绑定副本，保留 `hadQuery`，运行仍只冻结时间边界；
  移除时间不丢排序，新增单元格筛选也保留排序与原手写条件。
  参数模板不自动改写，本地参数化定义交换仍按既有模板规则处理。
- 源草稿/目标/端点/字段读取变化、无效可视化或待应用单元格筛选阻止应用。
  排序弹窗中禁止运行和保存旧 DSL，键盘入口同样受限。失败 CAS 不关闭弹窗或报告成功。
  索引标签只通过已有显式新建查询入口编辑，原索引结果/DSL 不变。

本批未新增依赖，Rust 生产代码、SQLite schema v7、文档 v1、DSL 快照合同 v4 与 IPC 不变。
只有 `FieldCatalog.aggregatable` 对部分不可聚合索引的解释得到修正，原字段能力形状不变。

## 自动化证据

所有前端调用使用 `--maxWorkers=2`，没有延长超时。

| 检查 | 本批记录 |
| --- | --- |
| 首轮领域 | 3 文件 154/155；新测试误用两个已有 helper 名称导致一例失败及 typecheck 报错，改为实际 API 后通过 |
| 领域/组件 | 4 文件 171 项通过，覆盖默认方向、原文/选项、字段证据、双语/审核/刷新/CAS |
| 应用/执行 | 4 文件 107 项通过，包含新排序与旧 PIT、时间、索引锁定、待应用筛选/无效可视化、存储恢复 |
| 跨模块 | 16 文件首轮 410/411；新增筛选/参数组合测试漏传 `createSnapshot` 的显式时钟，补测试输入后领域 65/65 通过 |
| 最终覆盖 | 其余 15 文件 346 项加最终领域 65 项，共覆盖 16 文件 411 项；复验有重叠，不相加成新总数，未重跑未受影响的 15 文件 |
| 静态与构建 | 12 个变动 TS/TSX/测试文件 lint、typecheck/正式构建通过；初轮两处测试 `it.each` 换行 lint 已修正 |
| Rust | 查询/时间 32 项通过，fmt 通过；仅新增共享 fixture 的首屏/PIT/续页请求组装测试 |
| 文档与 diff | 7 份 Markdown、157 个本地链接、42 张表格、22 个变动文件 UTF-8/LF 与 diff 检查通过 |

定向前端选择：`query-sort`、`query-sort-ui`、`app-query-sort`、`resource`、
`visual-query`、`visual-query-editor`、`query-executions`、`app-query-filters`、
`query-filters`、`query-time-range`、`query-time-range-ui`、`query-time-range-recovery`、
`app-index-tabs`、`query-editor`、`result-grid-ui`、`query-live`。

共享 `tests/fixtures/query-sort-v1.json` 由前端生成合同测试与 Rust 请求组装测试共同读取。
完整 sort 数组、长整数、小数、时间边界、runtime 源码和多项 `search_after` 原 token 保留；
UI 的 unmappedType/字段证据/时间元数据不进入请求。
JSDOM 验证应用不执行、旧结果不变、本地表头不改 DSL、旧 PIT 续页沿用旧排序、
新运行才使用新排序，以及取消/双语/设置/连接切换/恢复均不隐式执行。

```sh
npm test -- --maxWorkers=2 tests/unit/query-sort.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib -- query::tests query_time_range::tests --test-threads=2
cargo fmt --manifest-path src-tauri/Cargo.toml --check
npm run build
```

正式构建 JS **1,316.21 kB**、CSS **107.35 kB**，原有 500 kB 警告保留，未提高阈值。
本批主代理直接完成，没有 OMP、新依赖、持久服务、worktree、用户数据库或真实服务操作。
未修改原型，未重跑原型/全量前端/Rust/clippy/安装包/依赖审计，不以历史记录冒充本批验证。

## 依据与待验

本批读取的 Elastic 官方文档（2026-10-10，HTTP 200）仅作语义依据：

- [Sort search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/sort-search-results)：
  方向默认值、数组 min/max、缺失/未映射、nested 与 numeric_type 的差异。
- [Paginate search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)：
  续页保持同一 query/sort、PIT 隐式 `_shard_doc`、混合日期精度的显式要求。

真实授权环境待验：doc values、normalizer/null_value、多值 min/max、部分不可聚合索引、
多目标未映射/FLS、date/date_nanos 精度、runtime 成本/权限/变化、部分失败及 PIT 过期游标。
原生中英文/缩放/窄窗口/IME/焦点/下拉弹层/重启已列入
[集中人工验收](manual-acceptance.md)。本批没有浏览器/WebView、截图或原生通过声明。

下一小批为 Q02 会话筛选草稿的有界布尔组审核，明确 AND/OR 与 minimum_should_match，
保留原评分/手写条件/时间绑定/排序与快照；nested、筛选启停/固定/持久定义随后增量。
W01/W04 及六方向父任务保持开放，交接提交后创建一个 local 后继，更新既有监控，不推送、不提前睡眠。
