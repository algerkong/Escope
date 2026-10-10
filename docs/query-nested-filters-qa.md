# Q02 第五批：有界显式 nested 条件组

日期：2026-10-10。接手基线 `69c4ca3`，工作区干净，沿用 `main`。
状态：开发、JSDOM、正式构建与 Rust 请求合同自动化通过；真实 ES、原生与跨平台未验。
前置见 [布尔筛选组 QA](query-filter-groups-qa.md)、[单元格筛选 QA](query-cell-filters-qa.md)
和 [时间范围 QA](query-time-range-qa.md)。Q02 与六方向父任务不关闭。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 入口 | 成功/部分结果工具栏的 nested 图标，复用原筛选弹窗；路径/字段/类型化值/组选择 | 依附已有执行快照，打开不读取 Mapping、不查询；不是任意 DSL 编辑器或源对象展开器 |
| 路径证据 | 同连接 ID/端点/目标的 Mapping 原文，按真实 properties 层级核对；field caps 实际索引集合一致 | 2 MiB/128 索引/4,096 检查字段，不截断后称完整；缺失/冲突/不可搜索/失败明确拒绝 |
| 条件 | 顶级 nested 及直接标量字段；keyword term、text 短语、精确数字/布尔、显式 exists/missing | 日期/IP 仅存在性；输入值不冒充执行原值，不从源缺失/null/数组或格式化值推断 |
| 分组 | 一个 nested 查询对应一组，组内 AND/OR、组间 AND/OR；每个 OR 明确 MSM=1 | 8 非空组/总 32 条，每值 4 KiB；只可同路径移组，同组重复拒绝，独立组可重复相同叶子 |
| 否定 | 对象内排除与父文档“无匹配对象”独立选择 | 外部 must_not 包住 nested，并留在所属父层 OR 分支；不支持任意通用组 NOT |
| 应用 | 完整当前/最终 DSL 预览与显式应用；结构/输入/读取状态变化作废预览 | 256 KiB 最终 DSL；手写 query/评分/时间/排序/参数保留，无效可视化或过期源草稿不能绕过 |
| 隔离 | 已应用 DSL 按既有规则恢复，旧 PIT 继续原快照；索引只生成同目标新查询 | 分组/输入状态及 Mapping AST 不独立持久化/进入 IPC；仅已应用 DSL 携带实际条件值，不自动执行或扩大写入权限 |

UI 沿用 Lucide、语义 token、紧凑原生 select/input/radio、双语和可见焦点。
无新依赖、迁移、生产 Rust 或 IPC 变更；schema v7、文档 v1、DSL 快照合同 v4 保持。
旧单元格筛选仍只处理平面执行原值；显式 nested 输入不绕过该原值约束。

## 路径与权限

- Mapping 使用现有资源缓存的原始响应，不使用展示用 `MappingField.path` 作为嵌套证据。
- 每个实际索引均须声明顶级 `type: nested` 和同类型直接叶子；field caps 的非空索引集合
  与 Mapping 精确一致，且字段单一类型、可搜索、非元数据。任一索引缺失或冲突都拒绝。
- 普通 object、字面点键/路径碰撞、多层 object/nested、多字段子项和 alias 不推断；
  `enabled/subobjects` 的 false 或未知形状拒绝，旧 typed Mapping 不能证明路径存在。
- 查询前后 DSL 或服务器 Mapping 的 runtime 声明覆盖该路径/子字段时拒绝，
  不把平面 runtime 当 nested；无关路径的原 runtime/fields 原文保留。
- 刷新/失败/新的读取状态均作废预览；错误不回用缓存中的旧成功作为当前证据。
  连接/端点/目标键和请求 ID 校验仍由既有 `useQueryResources` 负责。
- 证据不等于授权、Mapping 锁或索引解析锁。执行时仍可能有别名/数据流变化、FLS 或版本差异；
  由后端/ES 返回真实状态，不自动删条件、忽略未映射或转为平面查询。

## 对象与否定语义

同组 `author = alice AND n = 2` 只生成一个 nested，必须由同一对象满足；
`[{author: alice, n: 1}, {author: bob, n: 2}]` 不匹配。
不同的同路径组表示独立存在量词，可由不同对象满足；因此同一叶子允许在不同组各出现一次，
移入已有相同叶子的组会拒绝，不因自动去重丢失对象约束。

| 条件/对象 | `[alice, bob]` | `[alice]` | `[bob]` | `[{}]` | 无对象/空数组 |
| --- | --- | --- | --- | --- | --- |
| nested 内 `NOT author = alice` | 匹配 | 不匹配 | 匹配 | 匹配 | 不匹配 |
| 外层 `NOT nested(author = alice)` | 不匹配 | 不匹配 | 匹配 | 匹配 | 匹配 |

上表是测试子集的量词反例，不声称模拟 Elasticsearch 的 analyzer、评分、索引缺失或空对象存储。
每个 generated nested 明确 `score_mode: none`、`ignore_unmapped: false`；
负向 OR 叶子仍有局部 bool.must_not，所有新增条件在 filter 上下文，原 should/MSM/评分原文不变。
已有手写 nested 不导入编辑器或反向转换；不支持的 DSL 保留原文，不丢弃条件。

## 本次验证

| 检查 | 本次结果 |
| --- | --- |
| 早期定向 | 领域 3 文件 125 项、旧弹窗/工作台 2 文件 30 项、新弹窗/工作台 2 文件 24 项通过 |
| 筛选子集 | 7 文件 174 项通过；随后增加未知 Mapping 标志等边界，共 177 项纳入最终范围 |
| 最终定向回归 | 13 文件 438 项通过，包含筛选 7 文件及资源、查询结果、执行、时间、排序、受限反向转换 6 文件 |
| 复审红绿 | 数组型 nested.match 暴露字符串转换问题；严格只接受 include/exclude 字符串后，4 文件 121 项复验通过，与最终范围重叠、不相加 |
| 静态与构建 | 11 个变动 TS/TSX/测试文件 lint 通过；复审后 3 文件复验，typecheck/正式构建通过 |
| Rust | query::tests 25 项、query_time_range::tests 9 项、fmt 通过，只有共享请求 fixture 测试变化 |
| 文档与 diff | Markdown AST 检查 9 文档/186 本地链接/55 表格，23 个变更文件 UTF-8/LF 和 diff 检查通过 |

共享 `tests/fixtures/query-nested-filters-v1.json` 验证普通搜索、PIT 首页和续页的完整 query、
sort/min_score/runtime/fields 与精确游标原文；本地 nestedPath/composition/Mapping 不进入请求。
组件测试覆盖同对象组、父排除、同路径移动限制、跨组重复、证据失效、拒绝其他端点响应、
布尔/短语/存在性、原生控件焦点、双语，以及索引新查询和工作区恢复/旧 PIT。
精确字面量、时间冻结/移除、参数模板与未应用守卫均保留；会话重挂载不是原生重启验收。

```sh
npm test -- --maxWorkers=2 tests/unit/query-nested-filters.test.ts tests/unit/query-nested-filters-ui.test.tsx tests/unit/query-filter-groups.test.ts tests/unit/query-filters.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-filters-grid.test.tsx tests/unit/app-query-filters.test.tsx tests/unit/resource.test.ts tests/unit/query-live.test.tsx tests/unit/query-executions.test.tsx tests/unit/query-time-range.test.ts tests/unit/query-sort.test.ts tests/unit/visual-query.test.ts
npm test -- --maxWorkers=2 tests/unit/query-nested-filters.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml query::tests --lib
cargo test --manifest-path src-tauri/Cargo.toml query_time_range::tests --lib
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run build
```

最终构建 JS **1,338.45 kB**、CSS **109.69 kB**，原有 500 kB 警告保留。
主代理完成实现、diff 审查和独立验证；OMP 只读审查 8 分钟超时，仅空报告，
relay 已终止进程树并退出，未计为有效审查。
临时报告在本机 `delegate-relay/EScope-2026-10-09T23-57-02-104Z`，未纳入仓库。
没有持久服务、worktree、用户数据库、真实 ES 或密钥库操作。

## 依据与待验

本批实际读取 [Elastic Nested query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-nested-query)
（2026-10-10，HTTP 200），核对 nested 父命中、score_mode、ignore_unmapped 和内部/外部 must_not。
没有执行文档中的创建索引或写入样例；官方说明不能替代授权环境联调。

真实 ES 待验：同对象/独立对象/空对象/全负向 OR、缺失/null_value/多值、评分、
analyzer/normalizer、FLS、多索引/别名/数据流漂移、runtime 遮蔽、PIT/部分失败与查询成本。
原生待验：双语/日夜/窄窗口/200%/高对比、菜单/输入/radio/屏幕阅读器、长字段值和 DSL、
焦点/IME、原生重启/升级及跨平台。见 [集中人工清单](manual-acceptance.md)，没有本批截图通过声明。
未启动浏览器/WebView 或 dev 服务；未改原型，不重跑旧全量/原型/clippy/安装包。

随后待应用会话筛选启停已交付，见 [启停 QA](query-filter-enablement-qa.md)：保留定义与组归属，
明确有效空组/OR/内外否定，完整预览后显式应用、不执行；已应用托管/固定/持久定义
及 W01/W04 写入审核仍开放。
完成交接与本地提交后仅创建一个 local 后继，更新既有监控，不推送、不提前睡眠。
