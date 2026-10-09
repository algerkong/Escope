# Q02 第二批：单元格条件与筛选草稿

日期：2026-10-10。接手基线 `5fa825c`，工作区干净，沿用 `main`。
状态：开发、JSDOM、正式构建与 Rust 定向合同自动化通过。
真实 ES、原生布局/键盘/剪贴板与跨平台未验，不关闭 Q02 或其他父任务。
前批时间合同见 [时间范围 QA](query-time-range-qa.md)，依赖安全见
[依赖 QA](dependency-security-qa.md)。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 单元格入口 | 现有表格内的 Lucide 筛选按钮，悬停/键盘焦点显示，触屏常显；操作取原始行和值 | 不读取格式化显示，不改变行选择、本地排序、列宽或加载页 |
| 条件 | keyword 类的 term、text 类的 match_phrase、数字/布尔原值；显式 exists/missing | 不猜 `.keyword`；日期和 IP 此入口仅支持存在性，未知类型/对象/nested/含点路径拒绝 |
| 数组 | 用户选择一个原始标量元素，保留原 JSON token | 最多 32 个返回元素；不生成数组相等或隐式多值 terms，不把 null/空数组视作索引缺失 |
| 待应用列表 | 各标签独立添加/移除/清空、完整 DSL 预览与显式应用 | 32 条/每值 4 KiB，单元格 64 KiB，最终 DSL 256 KiB；未应用列表仅存当前会话 |
| 目标与执行 | 原执行连接 ID/端点/目标、原值及实际 runtime 声明；字段证据显式检查 | 草稿/执行/目标改变或无效可视化草稿阻止应用；不自动执行，不重绑旧结果 |
| 索引标签 | 审核后生成一个绑定相同目标的新查询，原索引标签与结果不变 | 不放开索引 DSL/目标编辑；关闭带待应用条件的索引标签先确认，重开不沿用旧条件 |
| 时间兼容 | 只替换经过校验的时间 wrapper 内原查询，原外层和边界保留 | 无原 query 时将 `hadQuery` 提升为 true，之后移除时间仍保留新增筛选；运行冻结合同不变 |

待应用条件跨设置、主题、语言及标签切换保留，但不加入工作区/查询库/历史恢复文档。
运行和保存草稿在有待应用条件时禁用，避免执行或保存屏幕上未应用筛选之前的 DSL；
索引刷新也显示对应禁用原因。已有结果的本地分页/排序、复制和导出仍针对原执行。
关闭标签或应用重启不恢复待应用列表；**应用后的 DSL** 仍按既有草稿/查询库规则保存。
参数模板不自动改写；参数化查询定义交换仍导出模板，不宣称包含后来追加的字面量条件。

## 值与证据

- 表格回调传入排序前的稳定原行与字段名，再读取 `ResultColumn.value`；不是 DOM 显示、
  当前 Data View 格式或截断 preview。原始数值与数组元素始终保留为 JSON token，
  字符串重新 JSON 转义不改变字符串值，字段名也使用 JSON 编码。
- 整数按十进制文本/BigInt 比较 byte/short/integer/long/unsigned_long 范围，拒绝小数截断。
  数学上为整数的指数/小数表示仍保留原 token。浮点只检查有限性，不把 JS 转换结果输出；
  ES 的索引数值表示、normalizer、ignore_above、ignore_malformed 和 null_value 仍由实际 Mapping 决定。
- keyword/constant_keyword/wildcard 使用 `term`；text/match_only_text 使用 `match_phrase`，
  UI 标明分析短语而非精确相等。不自动改为某个同名子字段；空分析输入拒绝。
- `exclude` 用 `must_not`，包括没有索引值的文档；不偷偷增加 exists。
  `missing` 为显式 `must_not exists`，`exists` 为显式索引存在性。
  `_source` 省略、null、空数组或没有返回字段不能证明索引缺失。
- field caps 只读取原执行的稳定连接、端点和目标缓存；检查为明确动作，刷新中/失败不复用旧成功
  来批准新预览。未检查、目录缺失、类型冲突、非全部可搜索与不支持分别显示，不能覆盖手写 DSL 的执行权限。
  它是当前字段证据，不是 PIT 中冻结的 Mapping、凭据或授权证明。
- runtime 名称只取执行 `rawDsl`，并与本次草稿实际 `runtime_mappings` 的类型/脚本文字一致性比较。
  未应用 Data View 定义不作为证据；取值只能来自执行返回的 `fields`，不回填旧 `_source`。
  PIT 不冻结脚本输出；真实版本、脚本成本及权限继续由后端/ES 判断。

该入口只支持平面顶级字段。含点的真实键、对象路径、nested 祖先及未知类型需后续 Mapping
证据与相应查询构建，不能凭 `_field_caps` 推断完整路径。
类型检查不增加任何 Mapping 写入、任意 REST 代理或授权绕过。

## DSL 与隔离

`jsonc-parser` 的位置编辑仅替换原 `query`；原查询完整放入新的 `bool.must` 单个子项，
新增正向条件在 `filter`，排除在 `must_not`。不会把原 `should` 的默认
`minimum_should_match` 变成可选，原有评分、手写条件、排序、post_filter 和聚合均保留。
没有原 query 时保留 match_all 的默认评分。已有同字段条件仍保留并取交集，不做隐式覆盖或简化。
global 聚合/其他独立作用域不被改写，不能把筛选结果说成所有聚合都已受到同样限制。

未知顶层选项、knn/retriever 等混合入口、无效/重复键/未替换参数及超限 DSL 拒绝组合。
原可视化子集不能反向表达新 wrapper 时继续保留原文；应用明确进入 DSL 模式。
有无效可视化草稿时，既不能新建单元格筛选，也不能从已有待应用列表绕过该草稿。

待应用列表固定源草稿、执行请求和端点；预览绑定列表与字段读取状态，刷新证据或修改列表后
必须重新预览。最终应用再次核对当前标签、源草稿和端点，比较失败保持错误，不伪装成功。
已删除连接、关闭标签、结果替换、端点变化不通过新的连接选择重绑。
没有新增 IPC、schema 迁移或持久化定义：SQLite schema v7、文档 v1、DSL 快照合同 v4 保持。

## 自动化证据

前端统一 `--maxWorkers=2`，没有提高超时，未重跑未受影响的原型。

| 检查 | 本批记录 |
| --- | --- |
| 初轮领域 | 41 项通过，精确 token、类型/运行时证据、缺失与时间兼容 |
| 初轮组件/应用 | 4 文件 62 项中 2 项失败；夹具未记忆连接标签及错误空状态文案断言修正后，62 项全通过 |
| 跨模块回归 | 19 文件 272 项通过：新增筛选、时间、结果表格/格式、执行、编辑器、标签、恢复、查询库和 runtime |
| 焦点复审 | 首轮跨模块 271/272，旧测试在 rAF 前断言焦点；孤立复跑通过，改为等待实际焦点状态后 19 文件复跑全通过 |
| 可视化保护 | 新用例先复现未完成可视化条件可被待应用列表绕过，加入守卫后 5 文件 96 项复验通过；与前述有重叠，不相加 |
| 静态检查 | 14 个变动 TS/TSX/测试文件 ESLint、typecheck/正式构建通过 |
| Rust | 时间/查询 **31 项通过**，fmt 通过；仅增加时间合同测试，没有 Rust 生产代码变化 |
| 文档与 diff | 7 份 Markdown、149 个本地链接、41 张表格、25 个变动文件 UTF-8/LF 与 `git diff --check` 通过 |

前后端共用 `tests/fixtures/query-filters-time-v1.json`，验证原本无 query 的时间草稿追加条件后，
草稿与执行仍接受同一严格 wrapper；冻结只移动时间，原精确数字与筛选保留。
JSDOM 覆盖格式化原值、数组选择、双语、失败字段检查、刷新重审、CAS 失败、部分结果、
多条件累加、旧结果、设置/连接/标签隔离、索引新查询、关闭重开及未应用列表不恢复。

没有操作用户数据库、真实 ES/模型、密钥库、浏览器或 WebView，没有新依赖、持久服务或 OMP。
本地会话存储 fixture 不代表原生 SQLite/重启验收；官方文档读取不代表真实服务联调。
正式构建 JS 单包约 **1,294.28 kB**、CSS **105.36 kB**，原有 500 kB 警告保留，未提高阈值。
未重跑完整前端/Rust、生产库 clippy、原型、安装包或依赖审计；这些未变动部分的历史结果不冒充本次检查。

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib -- query_time_range::tests query::tests --test-threads=2
```

## 依据与待验

本批实际读取以下 Elastic 官方文档（2026-10-10，HTTP 200），只作语义依据：

- [Term query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-term-query)：
  索引 term 与 text 分析区别。
- [Match phrase query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-match-query-phrase)：
  分析后的短语与空 token 默认不命中。
- [Exists query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-exists-query)：
  索引值存在性及 `must_not exists`。
- [Boolean query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-bool-query)：
  filter/must_not 的评分边界与 minimum_should_match。

真实授权环境待验：keyword normalizer/ignore_above、text analyzer/短语、null_value、
缺失/源过滤、数值类型边界、FLS/多索引冲突、runtime 输出/权限、部分失败及 PIT 时序。
原生缩放、悬停/触屏、键盘焦点/IME、长值滚动、剪贴板与重启场景列入
[集中人工验收](manual-acceptance.md)。无本批截图或原生通过声明。

下一小批为 Q02 有界服务器多字段排序的审核/显式应用，继续保留本地表头排序语义；
复杂布尔/nested、筛选启停/固定/持久定义、其他数据探索及 W01/W04 写入审核仍开放。
完成本批提交与交接后，仅创建一个 local 后继并更新既有监控，不推送、不提前睡眠。
