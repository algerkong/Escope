# Q02 首批：有界时间范围与执行冻结

日期：2026-10-10。接手基线 `6c0cab0`，工作区干净，沿用 `main`。
状态：开发、JSDOM、临时 SQLite 和协议自动化通过；真实 ES、原生交互/升级与跨平台未验。
前批见 [查询期字段 QA](data-view-runtime-fields-qa.md)，后续见
[执行计划](development-plan.md) 第 10.15 节。

## 交付

| 范围 | 实际实现 | 边界 |
| --- | --- | --- |
| 时间定义 | 最近 N 秒/分钟/小时/天，或完整本地绝对起止时间；UTC、IANA 或固定偏移 | N 为 1-10,000 整数，总跨度最多 3,660 天；天固定为 24 小时，无月份/日历取整 |
| 类型与精度 | 显式 `date` / `date_nanos`，完整 ISO 输入，UTC 九位小数边界 | `date` 拒绝非整毫秒；`date_nanos` 限非负有符号 64 位纳秒；不经浮点转换 |
| 审核与应用 | 字段证据、预览时刻、起止与完整 DSL；显式应用或预览移除 | 不自动查询；冲突/草稿/目标变化拒绝，不覆盖手写范围 |
| 执行 | 点击执行时按客户端时钟冻结相对范围，早于 PIT 打开；续页使用原绝对 DSL | 不重新读取视图库、不发送时间元数据，不用服务器 `now` 重算托管范围 |
| 保存与恢复 | 查询/收藏保留相对意图，执行历史保存当次边界；严格嵌套与串行 CAS | schema v7、文档 v1 不变；恢复不执行；历史恢复不重新启用相对时间 |
| 交换与导出 | 原执行 DSL 可走原有稳定性检查/独立 PIT 导出；交换增加时间语义确认 | 交换不带本地时间托管；普通定义导出草稿预览绝对边界，参数化定义仍导出模板 |

入口是现有查询工具栏的时钟图标，不增加管理首页。索引标签不接受时间配置。
应用/移除均检查源草稿、稳定连接 ID、索引和当前端点；保存冲突不会关闭为成功。
设置/语言/主题往返、打开审核、预览、保存和恢复都不执行。
原有可视化反向转换不支持新增 wrapper 时保留 DSL，不删条件或假装完整转换。

## 定义与时间

可选 `QueryDocument.timeRange` v1 含 `definition`、`bounds`、`binding` 和 `hadQuery`。
定义含字段、明确日期类型、时区、相对时长或绝对本地时间；绑定使用连接 ID + 精确索引。
`bounds` 为 `resolvedAt`（UTC 毫秒）及 `from`/`to`（UTC 九位小数）。
执行副本只含版本、定义与边界，不保存另一份基础 DSL、PIT、正文、认证或端点。

条件固定左闭右开 `[from, to)`，使用 `gte` / `lt` 和
`format: "strict_date_optional_time_nanos"`。缺失秒、非法日期、闰秒、24:00、年份 0000、
超过九位小数、日历标注和带另一时区的本地输入拒绝，不让 ES 补齐缺失日期分量。
`date` 的有界年份为 0001-9999；`date_nanos` 还须落在 `[0, 9223372036854775807]` 纳秒。
边界必须严格递增，绝对范围也受 3,660 天限额约束。

绝对输入按显式时区解释；夏令时跳跃中不存在的时间和回拨中的双义时间拒绝，
不自动选择早/晚一侧。指定某次偏移可选择固定 `+HH:MM` / `-HH:MM`，拒绝 `-00:00`。
不接受会随宿主变化的 `system` / `local` 定义。
设置时区只作为首次打开审核表单的初值，不修改保存定义、执行快照或结果。

相对时间只是有界持续时长，不支持 `now/d`、自然月、任意日期数学或自动刷新。
预览给出当下具体边界，应用保存相对意图；每次明确运行才冻结新的边界。
冻结发生在首个网络等待之前，PIT 打开延迟、续页、失败或取消不重新读取当前时钟。
客户端和 ES 时钟可能不同，本批不校时、不查询远端时间，不承诺时钟偏差已验证。

## DSL 与字段

`jsonc-parser` 按位置只替换/新增顶层 `query`，不把原查询转成 JS 数值对象。
原查询完整放入外层 `bool.must` 的一个子项，时间范围放入该外层的 `bool.filter`，
保留原有评分和 `should` 的默认 minimum_should_match 上下文。
原本无 `query` 时保留 `match_all` 的评分默认；移除时只删除本批引入的成员。
大整数、指数、小数和转义保持原 token；预览格式化只改变空白。

只接受有界搜索根选项，不对 `knn` / `retriever` 或未知混合检索猜测筛选语义。
原查询或 `post_filter` 中已有同字段手写范围时拒绝，不替换，也不偷偷做交集。
已托管范围只有在定义、边界、目标和精确 wrapper 形状均匹配时才可更新/移除；
手改 DSL（含格式化）或目标会解除托管，保留当时草稿中的绝对字面量。
之后即使撤回到相同文本，也不隐式恢复相对时间管理。
其他手写日期数学、脚本、子查询或 global 聚合不在托管时间冻结范围内。

字段发现仅作证据；未检查和目录缺失分开，显式确认后可使用手填字段，
不把确认当 ES 授权。已知冲突、不匹配、不可搜索和 nested 字段拒绝该构建入口。
本地 runtime 同名字段尚未应用时不能当可用日期。实际 `runtime_mappings` 存在时，
只有 `type: "date"` 且选择 `date` 才可使用；不能用旧 field caps 覆盖实际 DSL 类型。
查询权限、脚本编译和成本仍由后端/ES 判定，不能从此入口访问 Mapping 写入。
PIT 稳定索引读取上下文，不冻结 runtime 脚本输出或其他手写动态值。

## 恢复与交换

查询库、工作区和历史深拷贝时间子对象；未知键/版本、null、重复键、
绑定/边界/wrapper 不匹配均拒绝，不覆盖存储。已删连接保留原 ID，不重绑。
续页历史的开始时刻可晚于原冻结时刻，但沿用原边界；首屏历史要求两者一致。
历史恢复得到当次具体 DSL，**不附带可重新计算的查询时间配置**；收藏恢复仍保留相对意图。
结果/历史时间摘要来自执行副本，不从当前草稿、设置或视图库回填。

交换文件不带时间绑定或相对托管配置，额外确认说明导出的是预览边界或参数模板；
更改选择/重新预览清除确认。交换 v1 不变，导入仍只新增且不执行。
已加载导出不重查；全量导出使用所选执行的绝对 DSL，继续拒绝 runtime mappings、
脚本和剩余手写动态时间，不复用结果页 PIT。

## 自动化

前端均 `--maxWorkers=2`，没有提高超时。Rust 只用 fixtures/临时数据库/临时文件，
没有访问用户数据库、真实 ES/模型、密钥库或原生窗口。

| 检查 | 本批结果 |
| --- | --- |
| 前端初轮时间领域 | 27 项通过 |
| 首轮旧查询合同回归 | 4 文件 81 项中 1 项失败：旧 `createSnapshot` 无效日期异常类型被改变；保留原 `RangeError` 后复跑通过 |
| 前端跨模块 | **24 文件 461 项通过**：时间、DSL、执行/PIT、编辑器、runtime、保存/恢复、交换/导出、应用生命周期 |
| 日期端点补强复验 | **3 文件 48 项通过**，与前述重叠，新增 0001/9999 年两例，不相加为一次全量 |
| Rust 初轮 | **63 项通过**：时间、查询、查询库和恢复 |
| Rust 跨模块 | **134 项通过**：上述模块加视图库、runtime、交换、导出、只读操作合同 |
| ESLint | **20 个变动 TS/TSX/测试文件通过** |
| TypeScript / 构建 | `npm run build` 通过；最终 JS 单包约 **1,272.16 kB**，原有 500 kB 警告保留，未调整阈值 |
| Rust 静态检查 | fmt 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过 |
| 依赖审计 | `npm audit --omit=dev` 为 0；完整审计仍报继承的 5 项开发依赖 high，见下节 |
| 文档与 diff | 8 份 Markdown、139 个本地链接、47 张表格、41 个变动文件 UTF-8/LF 及 `git diff --check` 通过 |

核心新增为 `query-time-range` 领域/组件/测试和 `query_time_range` Rust 模块；
共享 fixture 为 `tests/fixtures/query-time-range-v1.json`。应用级覆盖在
`app-data-views.test.tsx`，延迟 PIT/续页时钟测试在 `query-executions.test.tsx`。
复审补强已知 nested 祖先检查，已应用 runtime 声明也不能绕过本批平面时间筛选的范围限制。
schema/文档版本未升级，没有修改原型、构建安装包或打开浏览器巡检。

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib -- query_time_range::tests saved_queries::tests workspace_recovery::tests query::tests runtime_fields::tests data_views::tests query_exchange::tests query_export::tests operation::tests --test-threads=2
```

## 依赖与协作

- 新增 `@js-temporal/polyfill` 0.5.1（ISC）和 `jsbi` 4.3.2（Apache-2.0），
  用成熟实现处理 ISO、IANA、夏令时和精确纳秒，不自建日期计算引擎。
- Rust 将已锁定的 `chrono` 0.4.45 声明为直接依赖，增加 `chrono-tz` 0.10.4 及
  `phf` / `phf_shared` 0.12.1；没有无关版本升级。
- 完整 npm 审计报告 5 项 high：`@tailwindcss/cli` 4.3.3、`@parcel/watcher` 2.5.1、
  `micromatch` 4.0.8、`braces` 3.0.3、`source-map-js` 1.2.1。
  对照 HEAD 锁文件，版本均未由本批引入/更新；生产依赖审计为 0，但不忽略开发链风险。
  下批 F01/R03 做最小依赖安全修复，不能凭 `audit fix` 输出声称构建/原型或漏洞已验收。
- 一条 OMP 仅获两个新 Rust 文件的所有权，25 分钟内只读取上下文、未产出代码；
  relay `timeout`/退出 1，确认退出与无相关遗留进程后，全部实现由主代理完成。
  relay 末尾的整个工作区 diff 清单不是 OMP 贡献清单。临时报告在
  `EScope-2026-10-09T20-15-03-075Z/result.json`，未归入仓库。

## 依据与待验

2026-10-10 实际读取的 Elastic 官方资料，仅作语义依据，不作为本机/版本支持证明：

- [Range query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-range-query)：
  `gte` / `lt`、日期格式覆盖、缺失日期补齐、IANA/UTC 偏移与 `now` 的边界。
- [Date nanoseconds](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/date_nanos)：
  毫秒/纳秒差异、有符号 long 范围及 `strict_date_optional_time_nanos`。

真实 ES 的边界命中、Mapping 日期格式、FLS/多目标/nested、runtime 编译/成本、PIT 过期、
部分/失败/取消均须当次授权环境验证，不以之前轮次结果替代。
前端 IANA 依赖宿主 Intl，Rust 使用锁定 tzdb；跨平台/升级规则差异未实测。
解析或保存的语义校验不一致则拒绝，不回退系统时区、不改写保存边界。
原生输入、IME、焦点、缩放、滚动、时区下拉、重启/退出和升级列入
[集中人工清单](manual-acceptance.md)，无本批截图或原生通过声明。

Q02/Q01/Q04/Q07/F07 及六方向父任务仍开放。依赖安全子项后继续 Q02
类型感知单元格包含/排除与筛选草稿；复杂布尔/nested、筛选启停/固定、
服务器多字段排序及其他数据探索按依赖增量，不扩展未选平台方向。
本批验证/交接后本地提交、不推送；命令退出后只创建一个 local 后继，不提前睡眠。
