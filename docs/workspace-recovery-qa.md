# Q07 历史与工作区恢复验收

日期：2026-10-09。开发起点 `f6033b8`，接手时 `main` 干净，无新 worktree。
状态：开发、临时 SQLite 与组件自动化通过；真实桌面和人工验收未完成。
本批为 Q07 第二批，复用 F07/F02/Q05，不关闭这些父任务，也不扩大到全量导出或配置交换。

## 实际交付

| 范围 | 完成内容 | 安全与容量边界 |
| --- | --- | --- |
| 执行历史 | 记录不可变执行快照、名称、首屏/索引预览/续页类型、状态与开始/结束时间；搜索、删除、恢复新查询 | 最多 100 项/4 MiB，淘汰最旧记录；无结果正文、PIT、游标、认证对象；不是审计日志 |
| 状态语义 | 成功/部分/失败/取消分开，续页独立记录，不把前页成功当作续页成功 | 本地校验拒绝不算执行；迟到响应不改终态；重启时 running 转 interrupted，结束时间未知 |
| 标签/草稿 | 查询与索引标签顺序/活动上下文、DSL 原文、未完成可视化表单、结果视图 | 最多 50 标签、单份 DSL 256 KiB、工作区 4 MiB；失效连接不重绑；恢复不执行 |
| 结果布局 | 每标签列顺序、宽度、显隐、本地排序保留 | 不保存结果/页码/行选择/滚动；新执行从第一页开始，本地排序不改 DSL 或执行 |
| 存储 | schema v6 新增独立 `workspace_recovery`，文档 v1；固定 load/save IPC 和修订号 CAS | v5 连接/模型/凭据引用/查询库保留；严格字段/版本/大小/重复键校验，不提供任意 JSON/路径/网络代理 |
| UI | 标签下紧凑状态及查询库/历史图标；错误重试/明确重载、历史搜索/清理/恢复 | 双语、Lucide、主题 token；浏览器明确仅 session；坏库不被空状态覆盖，无明文降级 |

串行写队列读取最新意图，旧完成不回滚当前编辑，CAS 同时防止旧应用实例覆盖新实例。
迟到恢复若遇到新编辑则保留本地内容并报告冲突；显式重载等待既有写入，成功前不丢草稿。
首次恢复不重挂载整个工作台，避免丢弃不属于恢复记录的临时输入；恢复进行中不允许启动查询。
明确重载成功才清理当前结果和在途请求。未收到保存确认的退出/崩溃，不承诺未确认写入已落盘。

恢复文档 v0/未来版本与未知嵌套字段均拒绝，不猜测迁移或修复；损坏库的重载按钮仅重新读取。
升级到 schema v6 后，旧版只识别 v5 的应用应拒绝打开；任何回退须使用兼容版本与有效备份，
不能通过删除表或重置空状态掩盖问题。

## 独立验证

主代理在最终代码上执行：

| 检查 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2`，下列 18 份受影响测试 | **219 通过**，未延长超时 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib workspace_recovery` | **23 通过** |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib storage::tests` | **42 通过** |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib saved_queries::tests` | **10 通过** |
| `npx eslint`，App、query feature、恢复领域/服务、IPC、locale 与新增/修改测试 | 通过 |
| `npm run build`（含 `tsc --noEmit`） | 通过；JS 970.53 kB / gzip 294.83 kB，既有大 chunk 警告保留 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| Markdown 解析/本地链接/LF、`git diff --check` | 8 文档、86 本地链接、34 张表格与 33 份变更文本通过 |

Rust 三组包含重叠，不合计成全量。未重复未修改的原型、前批 805/261 基线或真实服务。
OMP 后端线报告其阶段定向 20、全量 281（6 忽略）和 clippy 通过；
该结果早于主代理最终补强，不作为本批最终独立全量证据。

最终前端定向文件（均位于 `tests/unit/`）：

```text
workspace-recovery.test.ts       workspace-recovery-hook.test.tsx
app-workspace-recovery.test.tsx  query-executions.test.tsx
query-live.test.tsx              app-query-integration.test.tsx
app-library-integration.test.tsx result-grid-ui.test.tsx
visual-query-editor.test.tsx     query-library-ui.test.tsx
ipc.test.ts                     workspace-tabs.test.ts
preferences-storage.test.ts     app-index-tabs.test.tsx
app.test.tsx                    app-ai-integration.test.tsx
query-editor.test.tsx           preferences-save-error.test.tsx
```

新增共用 [v1 fixture](../tests/fixtures/workspace-recovery-v1.json) 同时进入前端解析和 Rust
SQLite 保存/重开合同测试，包含 `9007199254740993`、无效可视化输入、列设置和已删目标。
运行中的草稿编辑、迟到 PIT、续页失败/取消、坏库、只读写失败、修订冲突、退出队列及新实例隔离均有定向覆盖。
组件重挂载验证可恢复布局但没有旧正文/页码/行选择，明确执行后才产生新结果。

## 复审与修正

- 存储读取区分 SQL 不可用与非法字段/正文；SQL 层先按字节限额屏蔽超大正文，避免先复制到 Rust 再拒绝。
- `columnSizing`、`columnVisibility`、`lastTabByConnection` 重复键拒绝；
  腐坏字节即使修订号匹配也不能被新空状态覆盖。
- 历史错误 tooltip 使用双语错误映射；首次恢复保持临时 UI 生命周期，显式重载失效旧连接选择回调。
- 第一次共用 fixture 测试使用 `import.meta.url`，Vite 将其转换为 HTTP URL，导致文件读取失败。
  该轮为 181/182；改为仓库文件路径后最终 219 项通过。没有更改测试阈值或把失败记为成功。

## 未验证与后继

未启动浏览器、WebView、额外服务，也未执行真实 ES/认证/TLS/密钥库、原生保存或安装包检查。
临时 SQLite 的迁移/重开、DOM 组件重挂载不代表桌面实际重启，macOS/Linux 亦未测试。
原生退出时的未确认写入、缩放/焦点/列拖动、长文本与主题布局按
[人工清单](manual-acceptance.md) 集中验收，本批不复用历史截图。

一条 OMP 已正常退出；主代理拥有最终复审、补强、验证、文档和本地提交。无新依赖，不推送。
下一可执行范围为 Q07 独立 PIT 快照的流式全量导出，再参数/无秘密配置交换；
遵循 [连续交接](continuous-development.md) 提交后创建恰好一个 local 后继。
人工/真实环境关卡仍开放，其他六方向仍有可执行工作，不能宣称全部完成或提前睡眠。
