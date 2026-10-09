# Q07 独立 PIT 流式导出

日期：2026-10-09。接手 `main` 的干净 `4241092`，本批只推进 Q07 全量导出，
保留原有已加载 CSV/JSONL、草稿/收藏/历史与恢复。参数和无秘密配置交换继续留给下一批。
状态：开发/mock/临时文件自动化通过，父任务继续开放；本批本地提交，不推送。
真实 ES、系统密钥库、桌面文件对话框/磁盘故障、原生布局和跨平台均未验收。

## 范围与合同

| 范围 | 本批合同 |
| --- | --- |
| 显式入口 | 查询与索引结果的全量导出按钮；打开、改选项、展开 DSL、切语言不请求 ES；确认后才选择文件并扫描 |
| 不可变目标 | 捕获所选执行的连接 ID、端点、索引与 DSL，不读取之后的编辑器文本；独立 PIT，不借用结果页的 PIT/游标 |
| 最终 DSL | 显示实际扫描正文；仅显式更换批大小、补充 `_shard_doc` 决胜排序；其他数值/转义原 token 保留 |
| 支持边界 | 拒绝非零 from、size 0、PIT/search_after、聚合、collapse、slice、提前终止、runtime/新型检索、未知顶层设置及自定义 sort format；不丢字段后继续 |
| 跨页稳定 | 动态 now、脚本、函数评分及外部文档引用等不稳定输入保守拒绝；不把 PIT 宣传为冻结所有外部查询依赖 |
| 有界运行 | 单个全量导出；每批 1–1,000 行、最多 1,000,000 行/1 GiB/30 分钟扫描预算；单响应仍为 1 MiB，结果正文不经前端 IPC |
| 文件 | 原生对话框选路径；只在完整读取、刷盘并完成替换后报保存；未完成文件带 `.partial-<uuid>`，不覆盖原目标 |
| CSV | 固定 `_index,_id,_source,fields`；对象按原 JSON 单元格编码，后续新增字段仍完整保留，不积累全局列集合 |
| JSONL | 每行完整原始 hit，仅移除字符串外空白；不重编码数字、负零、指数或字符串转义 |
| 状态 | saved/cancelled/limited/partial/failed 与 none/partial/complete/unknown 文件状态分开；PIT 关闭不确认时单列 pending |
| 进度 | 有界阶段、已写行数和字节数，不把总命中下界或进度百分比当完成；取消回执不是终态文件结果 |
| 工作台 | 进度可收起，由标签下紧凑入口重开；切换标签、设置和语言不重发，关闭原标签/目标失效停止原导出 |
| 持久化 | 不新增 SQLite schema、导出恢复或后台服务；退出后的部分文件不自动续传，不持久化 PIT/正文/凭据 |

CSV 全量文件使用固定文档列，与已加载导出的展开字段列不同；两条入口均保留各自格式合同。
`.partial-*` 文件可能没有完整末行，不因扩展名或已写行数就成为完整导出。
相对时间必须由用户明确转为稳定条件后重新执行；不自动改写原草稿。
关键词/数值排序按最终 DSL 的方向与缺失位置比较，数值使用有界十进制精确比较，不经 f64。
自定义日期排序格式无法按原文本可靠比较，因此本批拒绝，不暗中改成另一种格式。
扫描预算/取消在请求和写入安全边界检查；原生选择框及阻塞磁盘调用不能被强制打断，
已有写入必须等其退出，不以超时抛弃仍在写文件的后台线程。网络请求仍有原有超时和清理上限。

## 开发验证

主代理完成全部前后端、接线与独立验证。OMP 原先获得独占后端范围，但约 40 分钟未产出可审查代码；
主代理核对其专属进程树并停止该条任务，确认 worker、包装进程及 relay 全部退出后接手。
relay 退出状态为失败，记录保留在系统临时目录；其工作区 diff 列表包含主代理同期改动，
不能作为 OMP 的实现报告。本批没有恢复该 OMP 或派发第二条任务。

| 实际检查 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2`，下列 8 个定向文件 | 198 项通过，无失败 |
| 对应改动 TS/TSX 与测试的 `npx eslint` | 通过 |
| `npm run build`，含 `npm run typecheck` | 通过；JS 单包 992.72 kB 警告保留 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked query_export` | 31 项通过，0 忽略 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib query::tests` | 19 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib cancel` | 26 项通过，真实网关 1 项默认忽略 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib saved_queries::tests` | 10 项通过；本批复用文件名校验，故保留该回归 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --lib -- -D warnings` | 生产库通过，不是全目标 clippy |

前端定向范围：`snapshot-export.test.ts`、`snapshot-export-service.test.ts`、
`snapshot-export-ui.test.tsx`、`query-export-ui.test.tsx`、`query-export.test.ts`、
`query-live.test.tsx`、`ipc.test.ts`、`app-query-integration.test.tsx`，均在 `tests/unit/`。
Rust 各过滤集合有重叠，不相加为全量测试数量。

共享样本为 [query-export-v1.json](../tests/fixtures/query-export-v1.json)，前后端检查同一请求、
进度与结果字段及超安全整数文本。开发回归覆盖闭合 IPC、不可变目标、原连接逐请求认证、
修改连接后的原 PIT 清理、短页/gte/空页、精确多字段游标、数字/转义/无 source、CSV 防护、
字节/行数边界、取消/预算、部分分片/损坏响应/丢失 Channel、原文件保护与未知文件状态。
写失败通过只读文件句柄注入；这是自动化错误路径，不是耗尽真实磁盘的实测。

### 修正与复跑

首轮定向 6 文件 154/155 项通过，失败为新集成测试的标签名称写错；
修正为实际可访问名称后，集成 3 项复跑通过，随后定向 8 文件 191 项通过。
补强类型枚举、部分文件名称与分页排序格式校验后，最终同范围 **198 项**通过。
Rust 首轮导出 24 项通过；新增失败/清理用例一度因两处 `&String` 与现有 API 的 `String`
类型不匹配而编译失败，修正测试调用后 31 项通过。生产库 clippy 指出一处可简化布尔表达式，
按建议等价修正后 clippy/fmt 与导出 31 项复跑通过。未提高任何测试超时。

未重跑全量 Vitest/Rust、原型、恢复存储 219/23/42 或更早 805/261 基线；
不将这些历史记录作为本批证据。已有 remark/remark-gfm 解析器检查 9 份文档、
98 个本地链接与 43 张表格；30 个改动文件的 LF/BOM/末尾换行与 `git diff --check` 通过。
提交前另核对暂存路径，不纳入本机配置、relay 临时记录或秘密。

## 待人工与真实环境

以下均保持待验，详见 [集中人工清单](manual-acceptance.md)：

- 授权隔离 ES 上验证精确版本的独立 PIT、最新 PIT ID、稳定游标、权限拒绝及过期；
  全量行数与文件内容比对，不能用 mock 回应代替真实服务证据。
- 原生对话框选择/取消/覆盖，已存在文件、不可写目录、磁盘满、长路径与文件系统差异；
  取消/断网/退出后的 `.partial-*` 命名、数据留存与末行不完整提示。
- 真实凭据替换、连接删除、端点/CA 变化和系统密钥库故障；不得转向新目标、缓存旧秘密或无认证降级。
- 中英文、窄窗口、大字号、日夜与强调色；工具提示、最终 DSL 内部滚动、进度收起/重开、
  原生焦点/键盘及设置往返；自动化不代表像素通过。
- 桌面重启、WebView/IPC 中断、安装包和 macOS/Linux；旧安装包不包含本批源码。

## 下一批

Q07 参数定义与显式应用、无秘密配置交换：排除凭据、认证头和密钥库引用，
跨环境显式映射稳定连接 ID，不按名称重绑、不自动执行。之后按
[执行计划第 10 节](development-plan.md) 继续 C02 版本/许可与数据探索等六方向。
父任务 Q07/F07/Q04 不因本导出子项自动化通过而整体关闭。
