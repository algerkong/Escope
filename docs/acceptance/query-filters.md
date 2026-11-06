# 查询筛选 验收记录

## 共同说明

- 范围：Q02 第二、四至十批（均为 2026-10-10）——单元格条件、布尔组、显式 nested、启停、会话绑定与固定定义 v1–v3。首批时间范围与第三批服务器排序见 [查询编辑器与参数](query-editor-and-parameters.md)，依赖安全见 [基础与连接](foundation-and-connections.md)，查询期字段见 [Data Views](data-views.md)。
- 状态：各批开发、JSDOM、lint/typecheck 与正式构建自动化通过（第二、四、五批另有 Rust 请求/时间合同，第八至十批另有临时 SQLite）；真实 ES、原生、性能与跨平台未验，无截图或人工通过声明，原生项见 [集中人工清单](../manual-acceptance.md)。Q02 及 Q01/Q03/Q04/Q05/Q09/F07、六方向父任务均不关闭。第五、十批外部只读复核 8 分钟超时、仅空报告，不计为独立审查。
- 环境：干净基线、沿用 `main`；无新依赖、持久服务、worktree 或原型改动，不碰用户数据库、真实 ES/模型、系统密钥库、浏览器/WebView 或 dev 服务；未受影响的全量前端/Rust、clippy、原型、安装包与依赖审计未重跑，历史结果不作本批证据。
- 测试：未提高默认 5 秒超时或阈值，未放松类型、删改断言或改生产行为来规避；重叠数量只取最终有效结果，不相加；原有 500 kB 大包警告保留。JSDOM/mock/会话重挂载/协议 fixture/临时 SQLite 不等于原生重启、系统密钥库或真实 ES；布尔/nested 真值表是有界逻辑 oracle，不模拟 ES 索引与空对象存储、缺失、analyzer、权限或评分。
- 命令简写：前端 `npm test -- --maxWorkers=2 tests/unit/<文件>`，下文只列文件名并省略 `.test.ts(x)`；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib <参数>`；fmt 即 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`；build 即 `npm run build`。Elastic 官方文档（读取时 HTTP 200）只作语义依据，不替代授权环境联调。
- 共同待验：真实 ES 的缺失/null_value/多值、analyzer/normalizer、评分、FLS、别名/数据流/多索引漂移与冲突、runtime 输出/成本/权限、部分失败、PIT 时序与查询成本；原生双语/日夜/窄窗口/200%/高对比、键盘/焦点/IME/屏幕阅读器、长字段与值滚动、关闭/重启/升级、跨平台。批内只列特有项。截至第十批仍开放：nested runtime 固定、深层条件、其他数据探索与 W01/W04 写入审核前置。

| 合同 | 取值 |
| --- | --- |
| SQLite schema | 第二至七批 v7；第八批 v7→v8，其后 v8 |
| 恢复/查询文档；DSL 快照合同 | v1；v4，各批不变 |
| 固定库文档 | 第八批 v1（平面 mapped）→ 第九批 v2（+mapped nested）→ 第十批 v3（+平面 runtime） |
| 固定库不含 | 结果正文、执行/PIT 身份与证据、端点、认证、凭据引用、整份 DSL、时间/参数/视图元数据、会话基线/绑定 |
| IPC | 仅第八批新增类型化 `pinned_filters_load`/`pinned_filters_save` |
| 共享 fixture（`tests/fixtures/`） | `query-filters-time-v1.json`、`query-filter-groups-v1.json`、`query-nested-filters-v1.json`、`pinned-filters-v1/v2/v3.json` |

| 筛选通用上限（第六批起禁用项也计入） | 值 |
| --- | --- |
| 条件/组 | 每标签 32 条；最多 8 个非空布尔组 |
| 值 | 单值 4 KiB；数组最多 32 个返回元素；单元格 64 KiB |
| DSL | 最终 DSL 256 KiB；既有解析深度上限 |
| nested 证据 | Mapping 2 MiB / 128 索引 / 4,096 检查字段 |
| 固定库 | 100 组 / 256 KiB；每组 32 条 / 8 个非空布尔组、值 4 KiB；字段 1,024 字节（v2 起含路径）；名称 120 字符；ID 64 ASCII 字符；v3 起脚本 4 KiB、每组去重 runtime 声明 32 项 / 64 KiB |

各批自动化汇总（均含 typecheck 与 build；有 Rust 的批次另跑 fmt；lint 列为变动/受影响的 TS/TSX/测试文件数，第七批含夹具；文档列为 Markdown 文档/本地链接/表格数，以及 UTF-8/LF 与 `git diff --check` 覆盖的文件数）：

| 批次 | 前端有效覆盖 | Rust | lint | build JS / CSS（kB） | 文档/diff |
| --- | --- | --- | --- | --- | --- |
| 二 | 19 文件 272 项 | 时间/查询 31 | 14 | 约 1,294.28 / 105.36 | 7/149/41；25 文件 |
| 四 | 12 文件 332 项（去重） | 查询/时间 33 | 7 | 1,322.17 / 108.77 | AST 7/166/43；17 文件 |
| 五 | 13 文件 438 项 | 查询 25 + 时间 9 | 11 | 1,338.45 / 109.69 | AST 9/186/55；23 文件 |
| 六 | 9 文件 312 项 | 无变更 | 10 | 1,342.46 / 110.48 | 9/196/57；20 文件 |
| 七 | 14 文件 445 项 | 无变更 | 10 | 1,349.38 / 110.25 | 9/204/57；20 文件 |
| 八 | 21 文件 481 项 | 96 定向：固定库 10、storage 47、data_views 17、workspace_recovery 22 | 24 | 1,367.22 / 111.30 | 9/213/57；40 文件，提交前复核暂存范围 |
| 九 | 18 文件 391 项 | 86：固定库 17、storage 47、workspace_recovery 22 | 14 | 1,367.77 / 111.30 | 10/227/60（GFM）；28 文件 |
| 十 | 20 文件 450 项 | 150：固定库 24、runtime 6、storage 47、恢复 22、查询主模块 25、导出主模块 26 | 15 | 1,371.95 / 111.75 | 8/227/57（GFM）；30 文件，diff 空白检查 |

共同语义（第二批确立，括注者后续加入；批内不再重复）：

- 条件：keyword/constant_keyword/wildcard 用 `term`；text/match_only_text 用 `match_phrase`（UI 标为分析短语而非精确相等，空分析输入拒绝）；数字/布尔用原值；日期/IP 仅存在性；不猜 `.keyword`。`exclude` 即 `must_not`（含无索引值文档，不偷加 exists）；`exists`/`missing` 为显式索引存在性/`must_not exists`；`_source` 省略、null、空数组或未返回字段不证明索引缺失。
- 合并：`jsonc-parser` 位置编辑只替换原 `query`（或托管时间 wrapper 内的原 query，时间外层与边界保留）；原 query 按原 token 作 `bool.must` 单个子项，新增正向条件进 `filter`、排除进 `must_not`，均不评分；无原 query 时保留 match_all 默认评分。原 should 隐式/显式 MSM、boost、constant_score/function_score/dis_max、精确数值/转义及 post_filter/sort/min_score/聚合/runtime 声明按原作用域保留；同字段已有条件取交集、不覆盖或简化；global 等独立作用域聚合不改写、不宣称受限。新增 OR 显式整数 `minimum_should_match: 1`（第四批起）；生成的 nested 为 `score_mode: none`、`ignore_unmapped: false`（第五批起）。
- 拒绝组合：未知顶层选项、knn/retriever 等混合检索、手写游标/PIT、无效/重复键、未替换参数、失效时间绑定、超限 DSL；可视化子集不能表达新 wrapper 时保留原文，应用后进入 DSL 模式。
- 字段证据：只读原执行稳定连接 ID/端点/目标的缓存，作为明确动作检查；刷新中/失败不复用旧成功；未检查、目录缺失、类型冲突、非全部可搜索、不支持分别显示。runtime 名称只取执行 `rawDsl`，与本次草稿 `runtime_mappings` 比较类型/脚本文字，未应用 Data View 定义不作证据；取值只来自执行返回的 `fields`，不回填 `_source`；PIT 不冻结脚本输出，版本/脚本成本/权限由后端与 ES 判断。证据不是授权、凭据、Mapping/索引解析锁或 PIT 冻结证明，不限制手写 DSL 的原执行通道，不增加 Mapping 写入、任意 REST 代理或授权绕过；后端认证/只读授权/全量导出限制不变。
- 审核：完整当前/最终 DSL 预览后显式应用，不自动执行。列表固定源草稿、执行请求、端点；结构/成员/输入/启停/源草稿/执行/端点/字段读取变化作废预览；应用时再核对标签/源草稿/端点，CAS 失败保持错误、不丢列表、不伪装成功。有待应用条件时禁用运行、保存草稿、服务器排序审核与索引刷新（显示原因）；无效可视化草稿时不能新建条件或经列表绕过。
- 时间与参数：无原 query 时 `hadQuery` 提升为 true，移除时间仍保留新增筛选，运行前冻结合同不变；参数模板不自动改写。
- 隔离：未应用状态只在会话（跨设置/主题/语言/标签切换保留），不进工作区/查询库/历史或 IPC，关标签或重启不恢复；应用后 DSL 按既有草稿/查询库规则保存恢复。旧结果的本地分页/排序（仅已加载行）/复制/导出与旧 PIT 续页仍取原执行；索引标签只在审核后显式生成同目标新查询，原标签与结果不变；已删连接、关闭标签、结果替换或端点变化不经新连接选择重绑。UI 沿用 Lucide、主题语义 token、紧凑原生控件、双语与可见焦点。

## 2026-10-10 Q02 第二批：单元格条件与筛选草稿

基线 `5fa825c`。无生产 Rust 变化；各标签独立的待应用列表可添加/移除/清空。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 单元格入口 | 表格内 Lucide 筛选按钮，悬停/键盘焦点显示、触屏常显；取排序前稳定原行与字段名的 `ResultColumn.value` | 不读 DOM 显示、Data View 格式或截断 preview；不改行选择、本地排序、列宽或加载页 |
| 条件与数组 | 共同语义的条件种类；数组选一个原始标量元素，保留 JSON token | 仅平面顶级字段，未知类型/对象/nested/含点真实键或路径拒绝，不凭 `_field_caps` 推断路径；不生成数组相等或隐式多值 terms |
| 索引标签 | 审核后生成绑定相同目标的新查询 | 不放开索引 DSL/目标编辑；关闭带待应用条件的索引标签先确认，重开不沿用 |

- 精确值：数值与数组元素保持 JSON token，字符串重新 JSON 转义不改值，字段名 JSON 编码；整数按十进制文本/BigInt 校验 byte/short/integer/long/unsigned_long 范围，拒绝小数截断，数学整数的指数/小数写法保留原 token；浮点只查有限性，不输出 JS 转换值；索引数值表示、normalizer、ignore_above、ignore_malformed、null_value 由实际 Mapping 决定。
- 参数化查询定义交换仍导出模板，不宣称含后加的字面量条件。

自动化：首轮领域 41 项（精确 token、类型/runtime 证据、缺失、时间兼容）；组件/应用 4 文件 62 项中 2 项失败（夹具未记忆连接标签、错误空状态文案断言），修正后 62/62。跨模块 19 文件 272 项（筛选、时间、结果表格/格式、执行、编辑器、标签、恢复、查询库、runtime），首轮 271/272 系旧测试在 rAF 前断言焦点，孤立复跑通过，改为等待实际焦点后全过。新用例先复现未完成可视化条件可经待应用列表绕过，加守卫后 5 文件 96 项通过（重叠）。Rust 仅增时间合同测试，参数 `-- query_time_range::tests query::tests --test-threads=2`。`query-filters-time-v1.json`：原无 query 的时间草稿追加条件后，草稿与执行仍接受同一严格 wrapper，冻结只移动时间，精确数字与筛选保留。JSDOM：格式化原值、数组选择、双语、失败字段检查、刷新重审、CAS 失败、部分结果、多条件累加、旧结果、设置/连接/标签隔离、索引新查询、关闭重开、未应用列表不恢复。

依据：[Term](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-term-query)（索引 term 与 text 分析区别）、[Match phrase](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-match-query-phrase)（分析后短语，空 token 默认不命中）、[Exists](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-exists-query)（索引值存在性与 `must_not exists`）、[Boolean](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-bool-query)（filter/must_not 评分边界与 minimum_should_match）。

特有待验：keyword ignore_above、text 短语、源过滤、数值类型边界；原生悬停/触屏、剪贴板。

## 2026-10-10 Q02 第四批：有界布尔筛选组

基线 `09a23aa`。无生产 Rust 变化。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 布尔定义 | 组内、组间各选 AND/OR；单成员 OR、组间 OR 也显式 MSM=1 | 每条恰属一组；无更深组、组级 NOT、自定义 MSM；不依赖 bool 有无 must/filter 的默认 MSM |
| 编辑 | 原审核弹窗内分段 radio、所属组下拉、新组/移组；最后一条移出或删除即移除空组 | 不预建空组、不复制或丢弃条件；移组保留行身份与下拉焦点，高对比用原生 radio |
| 合并 | 新组合与完整原 query 取 AND；组间 OR 也在外层 filter，text/should 分支不加分 | 单一 AND 组保持第二批平面输出；组对象只在会话，不进查询/PIT、工作区/查询库或历史 schema |

- 分支：AND 组正向条件进 `filter`，排除/missing 进该组 `must_not`；OR 组每条排除是独立 `bool.must_not` 分支，不上提为全局排除（`A OR NOT B` ≠ `(A OR B) AND NOT B`，`NOT A OR NOT B` ≠ `NOT (A OR B)`）；OR 可能因负向分支匹配大量文档，不偷加 exists 或改变分支含义。
- 结构：每条筛选恰出现一次；遗漏/重复/未知引用、重复组 ID、空组、未知操作/额外属性、更深结构均拒绝，不忽略成员或近似展开；同字段/操作/原值的重复筛选仍拒绝，不支持跨组共享叶节点的任意布尔表达式。

自动化：开发定向 3 文件 99 项、补分组 UI/工作台后 2 文件 30 项；筛选子集（命令①）5 文件 117 项、受影响回归（命令②：排序、时间/恢复、执行、编辑器、受限反向转换、分组弹窗）8 文件 237 项，分组弹窗 22 项重叠，去重 332 项而非 354；无失败重跑。Rust 仅增共享分组请求 fixture 测试。领域：8 种组间/组内 AND/OR 组合的 16 行真值表、全负向 OR、显式缺失、单成员 MSM、原评分 query 字节保留、精确 runtime/短语、时间冻结/移除、参数保留、边界拒绝。`query-filter-groups-v1.json`（前端生成合同与 Rust 请求组装共享）：普通搜索、PIT 首页/续页保留 query/sort/min_score/runtime/fields 与多项精确游标，分组/时间元数据不进请求；旧平面/时间 fixture 回归通过。JSDOM：分组/移组/合并/清空、上限、键盘 radio、焦点、双语、预览失效、字段刷新、源草稿/目标/执行变化、CAS 失败、设置/连接/标签往返、索引新查询、未应用守卫。

命令：① `query-filters query-filter-groups query-filters-ui app-query-filters query-filters-grid`；② `query-sort app-query-sort query-time-range query-time-range-recovery query-executions query-editor visual-query query-filters-ui`；Rust `-- query::tests query_time_range::tests --test-threads=2`；fmt；build。

依据：[Boolean query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-bool-query)：must/filter/must_not/should、MSM 默认值、filter 评分边界。

特有待验：不同 bool/boost/函数评分下筛选前后的 `_score`、全负向 OR；原生 radio/select。

## 2026-10-10 Q02 第五批：有界显式 nested 条件组

基线 `69c4ca3`。无生产 Rust 变化。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 入口 | 成功/部分结果工具栏的 nested 图标，复用筛选弹窗；路径/字段/类型化值/组选择 | 依附已有执行快照，打开不读 Mapping、不查询；不是任意 DSL 编辑器或源对象展开器 |
| 路径证据 | 同连接 ID/端点/目标的 Mapping 原文按真实 properties 层级核对；field caps 非空实际索引集合与 Mapping 一致 | 不截断后称完整；缺失/冲突/不可搜索/失败拒绝 |
| 条件 | 顶级 nested 下直接标量，条件种类同第二批 | 输入值不冒充执行原值，不从源缺失/null/数组/格式化值推断；单元格入口仍只处理平面执行原值 |
| 分组与否定 | 一个 nested 查询对应一组，组内/组间 AND/OR；对象内排除与父文档“无匹配对象”分别选择 | 只可同路径移组，同组重复拒绝、独立组可重复叶子；父排除以外层 must_not 包住 nested，留在所属父层 OR 分支；无通用组 NOT |

- 路径：用资源缓存的 Mapping 原始响应，不用展示用 `MappingField.path`；每个实际索引须有顶级 `type: nested` 与同类型直接叶子，字段单一类型、可搜索、非元数据，任一索引缺失/冲突即拒绝。普通 object、字面点键/路径碰撞、多层 object/nested、多字段子项、alias 不推断；`enabled`/`subobjects` 为 false 或形状未知拒绝；旧 typed Mapping 不证明路径。查询前后 DSL 或服务器 Mapping 的 runtime 覆盖该路径/子字段时拒绝，不把平面 runtime 当 nested，无关路径 runtime/fields 原文保留。
- 连接/端点/目标键与请求 ID 校验仍由 `useQueryResources` 负责；执行时别名/数据流变化、FLS、版本差异由后端/ES 返回真实状态，不自动删条件、忽略未映射或转平面查询。分组/输入状态与 Mapping AST 不独立持久化、不进 IPC，仅已应用 DSL 携带条件值；不扩大写入权限。
- 量词：同组 `author = alice AND n = 2` 只生成一个 nested、须同一对象满足，`[{author: alice, n: 1}, {author: bob, n: 2}]` 不匹配；同路径不同组是独立存在量词，可由不同对象满足，故同一叶子可在不同组各出现一次，移入已有相同叶子的组拒绝，不靠去重丢失对象约束。负向 OR 叶子保留局部 bool.must_not；手写 nested 不导入编辑器或反向转换，不支持的 DSL 保留原文。

| 条件/对象（测试子集反例） | `[alice, bob]` | `[alice]` | `[bob]` | `[{}]` | 无对象/空数组 |
| --- | --- | --- | --- | --- | --- |
| nested 内 `NOT author = alice` | 匹配 | 不匹配 | 匹配 | 匹配 | 不匹配 |
| 外层 `NOT nested(author = alice)` | 不匹配 | 不匹配 | 匹配 | 匹配 | 匹配 |

自动化：早期定向领域 3 文件 125 项、旧弹窗/工作台 2 文件 30 项、新弹窗/工作台 2 文件 24 项；筛选子集 7 文件 174 项，补未知 Mapping 标志等边界后 177 项纳入最终范围；最终回归（命令①：筛选 7 文件 + 资源、查询结果、执行、时间、排序、受限反向转换 6 文件）13 文件 438 项。复审红绿：数组型 `nested.match` 暴露字符串转换问题，改为严格只接受 include/exclude 字符串后 4 文件 121 项复验（命令②，重叠），3 个文件 lint 复验。Rust 两条命令只有共享请求 fixture 测试变化。`query-nested-filters-v1.json`：普通搜索、PIT 首页/续页的完整 query、sort/min_score/runtime/fields 与精确游标原文，本地 nestedPath/composition/Mapping 不进请求。组件：同对象组、父排除、同路径移动限制、跨组重复、证据失效、拒绝其他端点响应、布尔/短语/存在性、原生控件焦点、双语、索引新查询、工作区恢复/旧 PIT、精确字面量、时间冻结/移除、参数模板、未应用守卫。

命令：① `query-nested-filters query-nested-filters-ui query-filter-groups query-filters query-filters-ui query-filters-grid app-query-filters resource query-live query-executions query-time-range query-sort visual-query`；② `query-nested-filters query-filter-groups query-filters-ui query-nested-filters-ui`；Rust `query::tests`、`query_time_range::tests`（各一条）；fmt；build。

依据：[Nested query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-nested-query)：nested 父命中、score_mode、ignore_unmapped 与内部/外部 must_not；未执行文档中的建索引/写入样例。

特有待验：同对象/独立对象/空对象/全负向 OR、runtime 遮蔽；原生菜单/输入/radio、长 DSL。

## 2026-10-10 Q02 第六批：待应用会话筛选启停

基线 `48bdd5c`。无 Rust 变化。本节为当时行为：仅待应用草稿内启停，不是已应用 DSL 的可逆托管；混合应用弃用确认与该限制已由第七批取代（应用后保留禁用定义，可信绑定的全禁用/移空可经审核恢复基线），本批数量不作第七批结论。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 定义 | `QueryFilter` 可选 `enabled`（缺省启用，仅布尔）；切换不删原值、操作或组归属 | 禁用项计配额；重复 ID/同组重复/遗漏/未知成员/非法值仍拒绝 |
| 弹窗 | 原生 switch、组/总启用数、不只靠颜色的禁用标签、操作/原值可访问描述 | 复用高对比控件；不新建管理页或网络入口 |
| 编译 | 只取启用叶子，有效空组从 AND/OR/nested 父排除中省略 | 不生成空 bool/should/nested，不把禁用组变成 match_all/match_none 或独立存在性 |
| 全禁用 | 逐字预览原 DSL，时间 hadQuery/边界保持 | 不提交空操作或无变化索引查询，只能保留、重新启用或明确丢弃；列表未结束仍阻止运行/保存/索引刷新 |
| 证据 | 禁用项只验本地字段/类型/原值/作用域形状，不需当前证据；缺当前 Mapping 仍可预览其余启用项 | 重新启用全面重查，缺失/失败/目标漂移阻止预览；禁用不视为授权 |
| 混合应用 | 沿用应用后清空列表；含禁用定义须完整预览后另行确认丢弃 | 不借“应用”静默删除；确认只绑定当前预览，切换语言不重发 |

有效空组即定义非空、成员全禁用的组：定义与组 ID/模式/父匹配保留，仅本次 DSL 省略；真正空的 filterIds、遗漏成员或重复归属仍拒绝。禁用叶子的数组/对象/错误状态、超限值与错组不能逃逸校验。

| 定义 | 启停 | 实际筛选贡献 |
| --- | --- | --- |
| A AND B | A 禁用 | B |
| A OR B | A 禁用 | B，仍显式 MSM=1 |
| G1 OR G2 | G1 全禁用 | 只有 G2，G1 不变成恒真 OR 分支 |
| G1 AND G2 | G1 全禁用 | 只有 G2，G1 不变成恒假占位 |
| nested 内 A AND NOT B | A 禁用 | 同一对象内 NOT B，仍可能由另一对象匹配 |
| NOT nested(A AND B) | A 禁用 | NOT nested(B)，排除只在原父层分支内 |
| NOT nested(A) | A 禁用 | 整组无贡献，不变成“没有任何 nested 对象” |
| 所有组 | 全禁用 | 原 DSL 逐字不变，无新增 wrapper；UI 不提交空操作 |

自动化：首轮领域 4 文件 179 项（启停、布尔组、nested、单元格）、组件/工作台 3 文件 57 项，均与最终 9 文件 312 项（另含执行/实时结果）重叠。初轮 typecheck 因新量词 oracle 的空对象数组被推断为 `{}` 失败，显式标注 TestDocument 后通过。oracle：布尔 8 种组内/组间模式、16 种启用掩码、16 种叶子真值；nested 8 种根/对象/父匹配组合、8 种启用掩码与无对象/空数组/空对象/多对象反例。组件：原生空格切换与焦点、可访问描述、禁用定义/分组保持、有效空组、省略父排除、全禁用逐字预览/禁止提交、混合应用额外确认、源/快照/端点/证据变动后确认失效、双语。工作台：全禁用时按钮/快捷键/保存/排序/索引刷新保护、设置/连接往返、无效可视化草稿、同目标新查询、时间/排序与旧 PIT、只恢复已应用 DSL。

命令：`query-filter-enablement query-filter-groups query-nested-filters query-filters query-filters-ui query-nested-filters-ui app-query-filters query-executions query-live`；`npx eslint src/domain/query-filters.ts src/features/query/QueryFiltersDialog.tsx src/features/query/QueryWorkspace.tsx src/locales/query-filters.ts` 加 `tests/unit/` 下 `query-filter-enablement query-filter-groups query-nested-filters query-filters-ui query-nested-filters-ui app-query-filters`；build。

特有待验：全负向 OR、nested 同对象/独立对象/空对象/父排除；原生 Tab/空格切换与弃用确认。

## 2026-10-10 Q02 第七批：已应用筛选会话绑定

基线 `d2a66da`。无 Rust/IPC/schema 变化。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 显式绑定 | 基线/已应用文档、目标端点、观察快照、定义与分组深拷贝并冻结，本地创建身份核对 | 不从任意 DSL 推断托管部分；反序列化副本不成有效绑定；不含结果正文/PIT/认证 |
| 再次编辑 | 紧凑会话条与原弹窗；待应用副本与已应用定义独立，混合应用保留禁用项 | 取代第六批弃用确认 |
| 基线重建 | 每次预览从原始基线重编译、替换本绑定贡献；全禁用逐字恢复基线并保留定义 | 不在上次结果上叠 wrapper；原 query 含相似 bool/nested/term 也保持原样 |
| 移除与取消 | 移除最后一项也须预览/应用；取消只丢待应用副本 | 零项编辑仍保护运行/保存；未编辑的绑定审核直接关闭，不产生待应用列表 |
| 失配与解除 | DSL/目标/时间/排序/参数/视图定义等修订照常保留，但旧绑定失去还原基线权并阻止覆盖；可查看失配后确认解除 | 解除只遗忘定义，DSL/结果不变；不解析修改后 DSL 猜归属；相同文本重输不算恢复旧修订；切换结果视图不破坏绑定 |
| 观察与索引 | 接纳新条件后保留实际核对的观察快照；索引明确创建同目标查询并保留真实来源身份 | 新查询未执行时只用明确转交的索引观察，不改 requestId/queryId、不伪造已执行，其新执行与原索引旧 PIT 独立；来源索引关闭后仍可审核；失败重跑不成为成功证据 |
| 时间与恢复 | 基线时间意图/hadQuery 保留，明确运行才重新冻结；旧 PIT/历史独立 | 运行只发送最终 DSL；定义/基线/绑定不进 IPC 或恢复存储，保存/重挂载只还原 QueryDocument，不恢复绑定、不执行、不从当前查询库回填 |

- 全禁用“保留定义”与移空“遗忘定义”分开：未绑定列表全禁用仍是无操作，已绑定全禁用可撤去已加入条件；只有分组/定义变化时才允许会话内同 DSL 提交。重新启用按当前证据校验，不把旧成功、禁用状态或固定来源身份当权限；迟到请求守卫有效。
- 状态只在 QueryWorkspace 会话内，深冻结副本不是历史/导出数据；本地 WeakSet 身份不能作后续持久恢复校验，后续复用须区分历史原值与当前字段证据，不默认注入或执行。

自动化：有效 445 项 = 范围回归其余 12 文件 423 项（领域/弹窗/执行/时间/排序，含 22 项新绑定领域用例）+ 拆分后待应用/已绑定工作台 2 文件 22 项；不是一次 445 项命令全绿，早期 50/64/72 项重叠；build 为源码最终版本。修正记录：

1. 首次 typecheck 拒绝新测试写只读参数叶子、在函数内读宽联合 Loadable 的 data：改为合法替换参数副本，用 `satisfies` 保留夹具类型。
2. 复核两个红例：接纳较新 runtime 条件后仍保留过早观察快照；移空时 null 分组抛异常。改为编译与绑定共用实际核对的观察选择、拒绝非法分组形状，领域 22 项全过。
3. 与构建并行的首轮范围回归 442/444：原组合流程触到 5 秒，随后重挂载使下一例重复 DOM。保存/重挂载集中到独立用例后，整文件复验最后一条移空场景超时，隔离运行 1/1（测试体 2.63 秒）通过；最终共享原夹具，拆为已绑定/待应用两个测试文件并集中重复恢复断言，22/22。

复核：连续 12 次启停/重建、精确 token 与原 should/MSM、nested 父排除、时间 hadQuery、新旧快照、runtime 新观察、伪造/克隆绑定、字段证据缺失、零项编辑、参数模板不变、失败重跑、原索引关闭、取消/解除、会话恢复隔离。

命令：①（442/444 那次范围回归）`query-filter-session query-filter-enablement query-filter-groups query-nested-filters query-filters query-filters-ui query-nested-filters-ui app-query-filters query-executions query-live query-time-range query-sort app-query-sort`；②（最终工作台）`app-query-filters app-query-filter-session`；`npx eslint src/domain/query-filter-session.ts src/domain/query-filters.ts src/features/query/QueryFiltersDialog.tsx src/features/query/QueryWorkspace.tsx src/locales/query-filters.ts` 加 `tests/unit/` 下 `query-filter-session query-filters-ui app-query-filters app-query-filter-session` 与 `query-filter-workspace-fixture.tsx`；build；`npm run typecheck`。

特有待验：should/MSM、nested 内外否定；原生开关与解除确认的焦点/键盘/屏幕阅读器。

## 2026-10-10 Q02 第八批：平面固定筛选定义

基线 `8ca5ccc`。schema v7→v8、固定库 v1、新增类型化 IPC；本批的加载、应用与隔离规则由第九、十批沿用。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 固定定义 | 显式命名、完整定义预览与字面量确认；保存、筛选列表、删除确认、同目标加载 | 仅平面 mapped；任一 runtime/nested（含禁用项）整组拒绝，不截断 |
| 合同 | 稳定连接 ID、目标、名称与条件定义；`enabled` 必填布尔，保留 AND/OR、组归属与精确原 token | 未知键、重复条件/成员、未归组等拒绝；字面量可能是业务数据，须全文核对后确认保存；无定义交换或自动注入 |
| 存储 | 独立 `pinned_filter_library` 行与 `pinned_filters_load/save`；串行 CAS，同事务核对连接存在 | 既有 ID 整体不可覆盖或改目标，另存用新 ID；已删连接的定义保留身份、可删除、不重绑；无默认插入；浏览器为明确 session 适配，桌面失败不降级 |
| 加载 | 仅同连接 ID + 完全相同目标，生成标“已保存字面量”的会话待审副本；无执行时 snapshot 为 null | 不伪造当前结果或持久恢复绑定；不覆盖已有待应用/已绑定定义；库更新不改旧副本，会话编辑须另行固定 |
| 应用 | 启用项核对当前 mapped 字段证据与类型，runtime 遮蔽拒绝；未执行查询也可加载 | 字面量不是当前执行值，不证明授权；全禁用首次加载不能提交无变化应用，绑定成立后沿用第七批；保存/加载/应用及语言/设置往返均不执行 |
| 恢复与失败 | 库删除不改已加载/已应用副本；重挂载只恢复已应用 DSL | 不恢复绑定/待应用编辑；损坏/未知版本/冲突不覆盖；保存结果未知时不重试、不放行排队写入，须显式重载 |

索引生成的查询，真实后续观察保存自己的 query/request ID；编译已核对基线时按实际观察所属文档身份核对，不改写观察，不把早期索引观察冒充新查询已执行（领域用例覆盖 null 观察到两次真实执行，再次应用/禁用时基线身份不变）。

自动化：前端为两条互不重叠的范围命令（非全仓）①16 文件 428 项（固定合同、原筛选/布尔/nested/启停/绑定、时间/排序、恢复、查询库）+ ②5 文件 53 项（本批工作台 7、既有筛选 22、执行 24）；补连接夹具后 UI 7 项复验（命令③，重叠）。Rust 固定库覆盖共享 fixture、精确数值、严格形状、配额、CAS/不可替换 ID、已删连接、损坏/未知/只读、重开；跨模块覆盖 v7→v8、失败回滚、旧行/凭据引用/偏好保留、无默认插入。修正记录：① 初轮 typecheck：新测试错误导入、只读夹具赋值、旧断言访问可空 snapshot，改为正确契约与可空断言；Rust 计数边界夹具默认推断 i32，补 i64 后 10 项通过。② 首轮 UI/工作台 8/11：按唯一“Close”定位，而既有 Modal 同时有关闭图标与底部按钮，改用底部文本按钮选择器，未改生产关闭行为。③ 生命周期首轮 38/39：用了不存在的“Load next page”，改为已有“Load more”。④ 最终构建类型检查：新 UI 连接夹具缺 `sortOrder`/`auth`，补齐后 UI 7 项与 build 通过；同时补强真实后续观察身份保留（领域与工作台），未新增或伪造执行快照。

命令：① `pinned-filters pinned-filters-service pinned-filters-hook pinned-filters-ui query-filters query-filter-session query-filter-groups query-filter-enablement query-nested-filters query-filters-ui query-nested-filters-ui query-time-range query-time-range-recovery query-sort workspace-recovery query-library`；② `app-pinned-filters app-pinned-filter-lifecycle app-query-filters app-query-filter-session query-executions`；③ `pinned-filters-ui`；Rust `pinned_filters::`、`storage::tests::`、`data_views::`、`workspace_recovery::`（各一条）；fmt；build。

特有待验：keyword/短语（固定定义不证明当前字段可用或查询授权）；原生长名称、保存失败。

## 2026-10-10 Q02 第九批：固定 mapped nested 定义

基线 `7f604fa`。固定库 v2；schema v8 与 IPC 命令名不变，无额外管理页或网络接口。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 合同 | 条件可选 `nestedPath`，组可选 nested 的 path/match；保留平面条目；全文定义/字面量确认，精确 token、组与启停深拷贝 | 只接顶级路径与直接 mapped 标量，不从点路径/源对象猜 nested；runtime 固定仍整组拒绝 |
| 兼容 | v1 原样读取，读取/重开不写库；显式新增时升级为 v2，保留原定义 | 删除 v1 条目不升级；已存 v2 不降级；未知版本/字段、显式 null、非法形状与不完整成员整库拒绝 |
| 组语义 | 同组对应同一对象，内部否定与父排除分离；组内/组间 AND/OR、MSM=1、启停 | 同组重复拒绝，独立组可重复相同条件；无启用成员不产生空 nested 或父排除 |
| 当前证据 | 启用 nested 项须打开审核后本次显式新查 Mapping/field caps：实际索引非空且一致、顶级 nested/直接叶子类型、searchable | 不用旧缓存、更早在途请求的完成或保存时证据；缺失/冲突/不可搜索、失败/漂移、未知对象标志、runtime 遮蔽分别拒绝；不证明权限、脚本可用或查询成功 |

- 读 v1 不改写的临时 SQLite 用例保留原 JSON 空白；显式升级只改库版本与新增条目，旧 ID 的字段/组/启停/目标不能趁升级覆盖。
- saved 字面量只按当前 DSL 与当前 Mapping/field caps 判断，不套用旧执行的 runtime 声明，当前路径或其下任一平面 runtime 拒绝；无观察不造 ExecutionSnapshot。会话绑定仍从精确基线重建，禁用/移空不叠 wrapper，反序列化副本不恢复信任。

自动化：前端非一次命令——初始四组 ①4 文件 157、②5 文件 39、③3 文件 11、④6 文件 182 项均通过；补 v2 限额后 ⑤新领域文件 47 项替换原 46 项；复审加旧在途证据反例后新 UI 文件 4 项替换原 3 项，与工作台 4 项、原 nested UI 15 项合为 ⑥3 文件 23 项重叠复验。Rust 固定库先 16 项，加 v2 配额用例后 17；lint 中限额补强文件单独复验。覆盖——领域：v1/v2 共享 fixture、精确 token、严格路径/组/null/版本、配额、同组/独立组重复、当前 Mapping/类型/runtime、无观察绑定、时间/参数保持；弹窗/持久化：v1 不自动写库、显式升级/删除、嵌套深拷贝、CAS/未知完成守卫、新 Mapping/field caps 审核、失败/漂移作废、禁用/双语/焦点；工作台：未执行加载、删库不改副本、重挂载只还原 DSL、索引新查询与真实后续观察、旧 PIT 请求隔离、原平面/会话筛选回归；Rust：独立合同校验、临时 SQLite 原文读取不写/显式升级/重开、v2 降级拒绝、既有 ID 不覆盖、已删连接、CAS/损坏/未知/只读、恢复隔离。

修正记录：首轮 typecheck 发现新时间组合测试直接展开可空 QueryDocumentPatch（非合法完整 QueryDocument），改用已验证 DSL 与明确非空/缺省范围构造。提交前复审发现只比较缓存引用会接受较早在途请求在打开后的完成、未强制本次显式检查：定向 `-t "earlier in-flight"` 反例 1 项先失败（另 3 项未选运行）；改为弹窗内显式检查标记并捕获当时两份证据引用，未点击或两份新读取未完成时拒绝审核；随后原缓存、失败/刷新、禁用再启用与工作台 ⑥、相关两文件 lint 与 build 复验通过。

命令：① `pinned-filters pinned-nested-filters query-nested-filters query-filter-session`；② `pinned-filters-service pinned-filters-hook pinned-filters-ui pinned-nested-filters-ui query-nested-filters-ui`；③ `app-pinned-nested-filters app-pinned-filters app-pinned-filter-lifecycle`；④ `query-filters query-filter-groups query-filter-enablement query-filters-ui app-query-filters app-query-filter-session`；⑤ `pinned-nested-filters`；⑥ `pinned-nested-filters-ui app-pinned-nested-filters query-nested-filters-ui`；Rust `pinned_filters::`、`storage::tests::`、`workspace_recovery::`（各一条）；fmt；build。

特有待验：同对象/独立对象、空对象、内部否定/父排除、Mapping 漂移、runtime 遮蔽与 PIT 续页；原生长路径、桌面备份后的 v1→v2 升级、旧版本拒绝新库、保存失败。

## 2026-10-10 Q02 第十批：固定平面查询期 runtime 定义

基线 `b71bf6d`。固定库 v3；schema v8 与 IPC 命令不变，无新网络接口。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 版本 | 条件可选 `runtimeMapping`；v1 平面/v2 mapped nested 原样读取 | 读取/重开不写回；显式新增升级为 v3，删除保持原版本，已存版本不降级；未知/损坏/显式 null/未知键整库拒绝 |
| 声明 | 从已应用 source.dsl 提取该字段的受限声明：类型、精确脚本文字、可选语言 | 只接受七类型、同名 source 或有界内联 Painless；不从 Data View、旧库或未应用配置补齐，不保存整份 DSL |
| 字面量 | 精确 token、布尔组与启停；平面 runtime 可与 mapped/nested 条件共存 | date/IP/geo_point runtime 仅存在性，无 geo 等值/空间查询；nested runtime 及深层路径仍拒绝 |
| 确认 | 定义与字面量确认外，每个含脚本字段显示完整源码，另行确认全部脚本（含禁用项） | 名称或捕获草稿变化使两项确认失效；失败不报成功；脚本作为本地文本保存，前端不求值；Rust Debug 对脚本文字脱敏 |
| 加载 | 字面量副本标“已保存字面量/已保存 runtime”，声明可展开、双语可辨，snapshot 为 null；启用 runtime 项在全文预览时须与当前已应用 DSL 声明相同 | 不依赖旧执行 runtime；不注入/运行/替换脚本，不称“已执行 runtime”、不冒充当前 fields；缺失或不同声明可留待审但不能应用，可明确丢弃，不自动补脚本 |
| 隔离 | 已应用会话绑定深冻结声明，禁用/移空从原基线重建 | 手改/目标失配不能覆盖；旧库与重启不恢复可信绑定，后续执行的快照仍是真实请求身份 |

- `runtimeMapping` 与查询白名单同为类型化对象，不是任意脚本配置，字段类型须与声明一致；同一字段所有条件（含禁用项）须用相同声明，不混用 mapped/runtime 或不同脚本。
- 保存并比较解码后的精确 `script.source` 与可选 `lang`，空白/换行/制表符不改写；缺省语言与显式 `painless` 各保留形状、不互相替代；JSON 属性顺序、格式空白与等价字符串转义不改变声明；一般 runtime 合并的旧等价规则不变。转义膨胀计入序列化大小，重复脚本的实际字节计入库总限额，不截断或静默删除。
- 现场 runtime 值固定时保留真实快照身份，比较原执行与当前 DSL 声明，无快照不造观察；再次固定已保存字面量也核对当前声明（含禁用项），不按新脚本重解释旧字面量。禁用项仍校验结构/声明/值/成员/限额，只跳过当前字段证据，重新启用须重审。
- mixed mapped nested 的本次显式 Mapping/field caps 保护保持（较早在途完成不替代检查），实际索引集合、直接路径、类型、searchable 与 runtime 遮蔽检查均未降低。
- 索引标签锁定 DSL 缺少这些查询期声明时，加载后预览拒绝，不注入脚本或生成新查询；原“审核后显式生成同目标新查询”入口保持，固定库不能修改原索引标签。脚本文字和字面量可能有业务含义，须全文核对。PIT 不保证脚本输出稳定；全量导出仍拒绝 runtime mappings，已加载导出规则不变。

自动化：前端非一次命令——①领域首轮 7 文件 244 项；②UI/适配/控制器 5 文件 32 项；③新工作台与补强适配/控制器 3 文件 22 项；④旧固定/布尔/nested/工作台回归 8 文件 168 项；⑤补强混合 nested 与 v2 删除后 2 文件 41 项（领域原 29→30 项、控制器原 8/10→11 项）；服务最终 7 项；重复文件只取最终结果。覆盖——TS 合同：v1/v2/v3、全部七类型、精确值/源码/语言、深拷贝、未知/null/版本、配额/同字段冲突、无观察/不注入、混合 nested 证据、时间/参数/绑定；JSDOM：全文源码与双重确认、禁用脚本、声明来源文案、失配/刷新/启停/双语/焦点、失败存储、索引拒绝注入、旧 PIT/真实观察、删除与重挂载；存储/IPC：原命令与有界 v3、v1/v2 原文读取不写/新增升级/删除不升级、脚本深捕获、未知完成/串行 CAS/连接删除/既有 ID 不可变、损坏不覆盖；Rust：共享 v3 fixture、嵌套重复/转义重复键、禁用与 UTF-8/序列化限额、临时 SQLite 重开/升级/冲突及查询/恢复/导出跨模块。

修正记录：v3 共享 fixture 的单个读取用例先跑红，随后 29 项通过。早期 typecheck 发现新测试误用 DataViewSelection 形状、readonly 标签赋值与不存在的 integer 参数类型，改用既有 selectDataView、不可变更新与 number 合同；另修正新测试把 fieldCaps 资源写成 fields 的笔误并复验工作台，修正 lint 未使用解构变量。

命令：① `pinned-runtime-filters pinned-filters pinned-nested-filters query-filters query-filter-enablement query-filter-session runtime-fields`；② `pinned-runtime-filters-ui pinned-filters-ui pinned-nested-filters-ui pinned-filters-service pinned-filters-hook`；③ `app-pinned-runtime-filters pinned-filters-service pinned-filters-hook`；④ `app-pinned-runtime-filters app-pinned-nested-filters app-pinned-filters app-pinned-filter-lifecycle query-nested-filters query-filter-groups query-filters-ui query-nested-filters-ui`；⑤ `pinned-runtime-filters pinned-filters-hook`；Rust `-- pinned_filters:: runtime_fields::tests --test-threads=2`、`-- storage::tests:: workspace_recovery::tests query::tests query_export::tests --test-threads=2`；fmt；build。

特有待验：runtime 编译、昂贵查询设置、日期/IP/地理存在性、脚本非确定性、取消；原生长脚本滚动、字体、Tab/Esc、保存失败、v1/v2→v3 升级与旧版拒绝新库。
