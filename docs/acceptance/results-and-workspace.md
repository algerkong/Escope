# 结果与工作台 验收记录

## 共同说明

- 共同未验项（各批均适用，批内不再重复）：真实 ES/认证/TLS/权限、原生 WebView 像素与布局、
  日夜/强调色/中英文/大字号/窄窗/100%–200% 缩放/高对比、原生焦点/键盘/IME/触控/屏幕阅读器、
  原生剪贴板、桌面重启、安装包与 macOS/Linux。JSDOM、DOM 计数、几何替身、mock 与临时 SQLite
  不冒充原生、性能或人工验收；人工流程统一见 [集中人工清单](../manual-acceptance.md)。
- 共同测试约定：前端定向测试使用 `--maxWorkers=2`（或进程级 `VITEST_MAX_WORKERS=4`），未提高业务超时、
  未跳过断言；重叠的多轮运行不累加，首轮失败如实记录；旧截图与历史批次数字不作本批证据。
- 自 Q07 起每批由主代理独占实现、diff 复核与验证，无 worktree、无用户数据库操作；本地提交，不推送。
- 本文件各批只为父任务（F02/F03/Q04/Q05/Q07/O05 等）的子项，不代表父任务关闭。
- 未特别说明时，每批无新依赖/Rust/IPC/schema 变化；Q05 各批期间保持 schema v8、恢复/查询/视图文档 v1、
  固定库 v3、DSL 快照 v4。

## 2026-09-30 F02.2/Q01.2 融合标题栏与查询编辑辅助

### F02.2

- `App.tsx` header 改由 `WindowTitleBar` 封装；品牌、工作区、连接选择与三个操作入口保留，不增第二条标题栏。
  浏览器模式无假窗口按钮、不调用桌面窗口 API。
- Windows/Linux `decorations:false`；按钮调用真实 minimize/toggleMaximize/close，不用 destroy 跳过 close 事件。
  Windows 热区宽 46px、移除头部上下外垫以触及右上边缘；Linux/未知平台为紧凑右侧 CSD，不承诺匹配各发行版位置。
- macOS `tauri.macos.conf.json`：`decorations:true`、`titleBarStyle:Overlay`、`hiddenTitle:true`；保留真交通灯，
  左侧预留安全区。平台配置替换 windows 数组，故重复全部窗口尺寸/label/minima。
- 使用锁定 Tauri 2.12 的 `data-tauri-drag-region="deep"`；交互元素阻断拖拽，空白双击走系统 API，无第二套 JS 双击。
- 初始状态与 resize/focus/blur 共用订阅；generation 拒绝旧最大化/全屏状态，卸载清理注册与在途读取；
  同步句柄错误包装为 Promise 拒绝，失败显示本地化提示。
- 最小授权仅 main 本地窗口：minimize、toggle-maximize、close、is-maximized、is-fullscreen、start-dragging、
  internal-toggle-maximize、event listen/unlisten；无 default/通配权限。单测校验精确授权集合且无远程来源授权，
  不依赖未跟踪的 `src-tauri/gen/schemas/acl-manifests.json`（权限名由 Tauri 编译验证）。

### Q01.2

- `query-dsl.ts` 用精确固定的 `jsonc-parser 3.3.1` 严格校验：相同值/不同值/嵌套/Unicode 转义等价的重复键均拒绝；
  数组中不同对象同名属性允许。
- 格式化只应用空白 edits，长整数、小数、指数、转义、键序、`__proto__` 保留；首版 lossless-json 的同值合并/字段丢失
  不被接受，依赖已移除。原始 DSL 文本始终是数据来源。
- `createValidatedSnapshot` 返回冻结快照，保留逐字 rawDsl、JSON 合同版本 2；非法日期等返回稳定错误码；旧 createSnapshot 不变。
- `QueryWorkspace` 接入校验/格式化/撤销格式化图标按钮、中英文错误与行列、aria-invalid/诊断关联；编辑后隐藏旧诊断，
  撤销不跨标签，设置往返保留状态；格式化不发网络请求，执行按钮仍禁用。状态栏可换行。

### 证据

| 检查 | 结果 |
| --- | --- |
| 窗口/DSL/编辑器定向 | 5 文件 67 项（补最后窗口句柄用例前） |
| `npm run check` | lint/typecheck/正式与原型构建通过；正式 141、原型 16 |
| 句柄同步异常防护后 `npm test` / lint | 正式 142 项；lint 通过 |
| `npm test -- tests/unit/window-config.test.ts`（去除生成文件依赖后） | 6 项 |
| `cargo test --locked` | 含凭据编排 56 通过、2 忽略；fmt、`clippy --all-targets -D warnings` 通过 |
| `npm run build:desktop` | 通过；`src-tauri/target/release/escope.exe` 未签名内部构建，非安装包，未启动 |
| `git diff --check` | 通过 |

特有待验：macOS/Linux 编译与原生窗口、Windows Snap/边缘缩放、交通灯垂直对齐/全屏菜单、Wayland/X11。
OMP 会话：窗口 `01a0f153-79b7-7000-bf35-46cc98f75ff8`，查询 `01a0f153-7b0f-7000-8da2-1c1c86228a66`，
均 completed/exit 0；主代理另修编辑器接线、句柄错误与干净检出测试。

## 2026-10-08 F02/F02c/F03/Q01/Q04/Q05/O05 索引多标签与控件优化

将共享数据预览改为独立索引标签并排查控件问题。上一轮共享预览实现见
[AI 与反馈记录](ai-models-and-feedback.md) 的工作台批次。

| 范围 | 实现与边界 |
| --- | --- |
| 索引标签 | 稳定连接 ID + 去空白精确索引目标对应一个标签，与查询按打开顺序排列；重复点击只激活不重跑，首次明确打开才执行只读预览 |
| 空入口 | 只保留索引打开入口，无共享执行槽；手填索引/模式也开独立标签；目标不可编辑，有刷新与“基于该索引新建查询” |
| 连接上下文 | 激活标签同步顶部/资源栏/新查询目标；连接选择写入串行化，按最后用户意图接收，迟到选择不覆盖新标签；已移除连接的标签不重绑 |
| 状态保持 | 各文档独立保留结果视图、本地排序、列顺序/宽度/显隐、页码、表格与 JSON 滚动；刷新只重置该执行页码；设置/语言/主题/切标签不执行 |
| 关闭与焦点 | 关闭活动标签回退相邻，最后一个回空入口；后台关闭不抢焦点；中键、方向键/Home/End/Delete、文档区 Ctrl/Cmd+W，保留 IME/模态保护和 macOS Control-W |
| 查询草稿 | 未完成可视化条件/校验问题跨标签保留并阻止执行旧 DSL，参与关闭确认；格式化撤销与诊断按文档保存 |
| 请求生命周期 | 关闭只取消对应文档并释放 PIT；重开用新文档 ID；旧搜索/续页/迟到 openPit 不覆盖新标签，迟到 PIT 尽力清理 |
| 表格 | 继续 TanStack Table/dnd-kit；自适应列宽为拖动柄/排序图标/文档按钮留位；隐藏排序列仍可清除排序；大字号表头受约束 |
| 统一控件 | 真实 select 的主题外壳 + Lucide 箭头，支持的 Chromium 用 `appearance: base-select` 渐进增强，其他引擎保留原生弹层；复选/单选/滑块、禁用/错误/焦点/高对比回退；接入设置/模型/连接/AI/分片/可视化/顶栏 |
| 样式 | 降低基础 input 选择器特异度；长模态标题/按钮换行；下拉/表格/对话框滚动边界；可视化去重复横向内边距 |
| 其他 | 元数据刷新中/失败保留列表并标记旧数据；字段目标 trim；分片状态消失重置筛选；取消续页显示停止；命令执行恢复焦点；复制回调按作用域隔离 |

| 检查 | 结果 |
| --- | --- |
| 定向回归 | 8 文件 137；多标签集成初版 9 项后扩展；查询/表格/资源 5 文件 105；连接上下文 2 文件 33 |
| 最终 `npm run check` | 42 文件 678 项正式、16 项原型，lint/typecheck/两套构建通过 |
| `npm run test:rust` / fmt / 严格 clippy | 192 通过、6 默认忽略；通过 |
| 本机 ES 7.17.25 只读 | 4 项通过：身份、资源/搜索、集群资源、PIT 首屏与续页（`size:0`/`_source:false`，不输出正文） |
| `npm run build:installer:windows` / `git diff --check` | 通过；分片测试文件统一 LF |

新增测试：`workspace-tabs.test.ts`、`app-index-tabs.test.tsx`、`controls-polish.test.tsx`。
安装包 `src-tauri/target/release/bundle/nsis/EScope_0.1.0_x64-setup.exe` **4,201,624 bytes**，
`escope.exe` **14,569,472 bytes**，构建 **2026-10-08 22:03:35（Asia/Shanghai）**，
SHA-256 `B2E26FEA754BCBE60392EFC1A8D215322A78D02D61FD3C753CE3BEEF2546D869`，Authenticode `NotSigned`；
未安装/升级/卸载/签名。前端 JS **877.66 kB**（gzip **269.25 kB**），CSS **78.08 kB**，大包警告保留。

边界：浏览器预览为会话内存模式不查询 ES；未调用真实模型认证、未重跑密钥库；标签/草稿/结果/列状态仅会话内存，
不跨重启；排序仅已加载行，非全索引排序或完整虚拟化；任意 DSL、导出、收藏、认证 ES、写管理属开放父任务。
上一轮依赖审计不作本轮证据。

## 2026-10-09 F02/F03/Q05/O04/O05 预览精简、设置黑块与表格行选择

| 反馈 | 实现 | 边界 |
| --- | --- | --- |
| 预览头部冗余 | 只保留一个 `preview-toolbar`：连接/索引、成功图标或异常、命中数、耗时、视图与操作；去重复标题、地址行和文档计数 | 查询编辑器仍保留执行来源；过期/部分失败/取消提示不隐藏 |
| 预览底部冗余 | 已加载行数、本地排序范围、分页、列设置、加载更多合入表格底栏；快照说明与服务页数进按钮 tooltip；JSON 底栏保留最新响应页与复制 | 本地页与 ES 续页语义不变，原始响应不重写 |
| 全局底栏 | 只读缩为带可访问名称与 tooltip 的盾牌；无连接/实际测试结果仍可见，不再重复“未测试” | 不把已读到文档误报为身份测试通过 |
| 设置黑块 | 主分片用 `cluster-role` 与 `data-role`，不复用通用 `primary` 类；全局三类动作样式以 `:where(button)` 限定且维持特异度 | 主/副本/未知角色为主题文字，按钮样式不变 |
| 持久行选择 | 查询/预览用 TanStack 受控行选择；节点/分片/索引/Mapping 共用行手势；选中背景+左侧细标记用主题色 | 排序/分页/JSON/标签/设置往返保留选中 ID；新执行或元数据刷新清空 |
| 多选与拖动 | 左键跨行拖动连续选择（可反向/缩小）、Ctrl/Cmd 追加、Shift 范围、方向键/空格/全选/清除；边缘滚动限当前页 | 不执行/续页/改数据；按钮、列头、拖列、列宽、文本编辑不参与 |

- 命中数以 `Intl.NumberFormat` 格式化 `BigInt`，遵循千分位偏好；未知总数不变 0，`gte` 标为下界。
- 选中独立于 hover；查询选中用接收页号+页内位置，同索引同 ID 的不同行不合并；分片行在同一响应内用独立稳定 ID，
  相同未分配副本不合并；Shift 按当前筛选/排序顺序；Ctrl/Cmd+A 只涵盖已加载且展示的数据。
- 单行内保留原生文字拖选，跨行后切为行范围并清冲突高亮；Alt 拖动保留原生文本；松开/失焦/隐藏/卸载/新执行终止拖动与边缘滚动。
- 行内详情按钮/双击详情保留；Ctrl/Cmd+Enter 仍是执行快捷键；高对比用 Highlight/HighlightText，不改列宽。

| 检查（`VITEST_MAX_WORKERS=4`） | 结果 |
| --- | --- |
| 预览精简 / 黑块隔离 / 行选择定向 | 4 文件 99；2 文件 38；5 文件 123 |
| 最终 `npm run check` | lint/typecheck/正式构建、43 文件 712 项、原型构建与 16 项通过 |
| `git diff --check`；复用 1420 Vite | 通过；HTTP 200，分片模块返回新 `data-role` |

首次完整测试在默认高并发下一个既有设置往返用例超时，改 4 worker 后通过。生产 JS 约 893.48 kB 警告保留。
特有待验：原生连续拖选/边缘滚动/文本复制。

**分类提交**（同日用户授权，未推送）：`1a3f5ef` 依赖与资源（表格/拖动/Markdown 依赖、锁文件、favicon、AI 网关联调脚本）；
`500ef78` 模型与 AI（密钥与补偿清理、模型发现、流式/多轮服务）；`596c794` 查询工作台（PIT、独立索引标签、可视化、结果表格/选择/面板、AI 与设置接线）；
`a162ce7` 设置与交互（角色/按钮样式隔离、选择框迁移、资源与 Mapping 行选择）；另一提交为文档。共享注册/样式仅在暂存区按功能拆分；
唯一格式修正为移除 `visual-query.css` 末尾空行。提交前复验：`npm run check` 43 文件 712 + 原型 16；
`cargo test --locked` 192 通过 6 忽略（真实 ES/模型网关/Windows 密钥库未解禁）；fmt、`clippy --all-targets -D warnings` 通过；
每批 `git diff --cached --check` 及私钥/API token 模式检查未命中（非绝对保证）。

## 2026-10-09 Q07 历史与工作区恢复

基线 `f6033b8`，Q07 第二批，复用 F07/F02/Q05。

| 范围 | 完成内容 | 安全与容量边界 |
| --- | --- | --- |
| 执行历史 | 不可变执行快照、名称、首屏/索引预览/续页类型、状态与起止时间；搜索、删除、恢复为新查询 | 最多 100 项/4 MiB，淘汰最旧；无结果正文、PIT、游标、认证对象；非审计日志 |
| 状态语义 | 成功/部分/失败/取消分开，续页独立记录 | 本地校验拒绝不算执行；迟到响应不改终态；重启时 running → interrupted，结束时间未知 |
| 标签/草稿 | 标签顺序/活动上下文、DSL 原文、未完成可视化表单、结果视图 | 最多 50 标签、单份 DSL 256 KiB、工作区 4 MiB；失效连接不重绑；恢复不执行 |
| 结果布局 | 每标签列顺序/宽度/显隐/本地排序 | 不保存结果/页码/行选择/滚动；新执行从第一页开始 |
| 存储 | schema v6 新增 `workspace_recovery`，文档 v1；固定 load/save IPC + 修订号 CAS | v5 数据保留；严格字段/版本/大小/重复键校验，无任意 JSON/路径/网络代理 |
| UI | 标签下紧凑状态及查询库/历史图标；错误重试/明确重载、历史搜索/清理/恢复 | 浏览器明确仅 session；坏库不被空状态覆盖，无明文降级 |

- 串行写队列取最新意图，旧完成不回滚编辑，CAS 防旧实例覆盖新实例；迟到恢复遇新编辑则保留本地并报冲突；
  显式重载等待既有写入，成功后才清理当前结果与在途请求；首次恢复不重挂载工作台，恢复中不允许启动查询；
  未收到保存确认的退出/崩溃不承诺落盘。
- 文档 v0/未来版本/未知嵌套字段拒绝，不猜迁移；坏库重载只重新读取。升级 v6 后只识别 v5 的旧版应拒绝打开，
  回退须兼容版本与有效备份。
- 复审修正：存储区分 SQL 不可用与非法正文，SQL 层按字节先屏蔽超大正文；`columnSizing`/`columnVisibility`/
  `lastTabByConnection` 重复键拒绝；腐坏字节修订号匹配也不被空状态覆盖；历史错误 tooltip 双语映射；
  显式重载失效旧连接选择回调。

| 检查 | 结果 |
| --- | --- |
| 18 份前端定向测试 | **219** 通过（首轮 181/182：fixture 用 `import.meta.url` 被 Vite 转 HTTP，改仓库路径后通过） |
| `cargo test --lib workspace_recovery` / `storage::tests` / `saved_queries::tests` | 23 / 42 / 10（有重叠） |
| eslint、`npm run build`、fmt | 通过；JS 970.53 kB / gzip 294.83 kB 警告保留 |
| Markdown/链接/LF、`git diff --check` | 8 文档、86 本地链接、34 表格、33 份文本通过 |

前端文件（`tests/unit/`）：workspace-recovery、workspace-recovery-hook、app-workspace-recovery、query-executions、query-live、
app-query-integration、app-library-integration、result-grid-ui、visual-query-editor、query-library-ui、ipc、workspace-tabs、
preferences-storage、app-index-tabs、app、app-ai-integration、query-editor、preferences-save-error。
共用 [v1 fixture](../../tests/fixtures/workspace-recovery-v1.json)（含 `9007199254740993`、无效可视化输入、列设置、已删目标）
同时用于前端解析与 Rust SQLite 保存/重开。OMP 后端线阶段报告定向 20、全量 281（6 忽略）早于最终补强，不作最终证据。
特有待验：原生退出时的未确认写入、真实桌面重启。

## 2026-10-09 Q07 独立 PIT 流式导出

基线 `4241092`；保留已加载 CSV/JSONL、草稿/收藏/历史与恢复。

| 范围 | 合同 |
| --- | --- |
| 显式入口 | 查询与索引结果的全量导出按钮；打开、改选项、展开 DSL、切语言不请求 ES；确认后才选文件并扫描 |
| 不可变目标 | 捕获所选执行的连接 ID、端点、索引与 DSL；独立 PIT，不借结果页 PIT/游标 |
| 最终 DSL | 显示实际扫描正文；仅显式更换批大小、补 `_shard_doc` 决胜排序，其余原 token 保留 |
| 支持边界 | 拒绝非零 from、size 0、PIT/search_after、聚合、collapse、slice、提前终止、runtime/新型检索、未知顶层设置及自定义 sort format |
| 跨页稳定 | 动态 now、脚本、函数评分、外部文档引用等保守拒绝；相对时间需用户转为稳定条件后重执行，不改草稿 |
| 有界运行 | 单个全量导出；每批 1–1,000 行，最多 1,000,000 行/1 GiB/30 分钟；单响应 1 MiB，正文不经前端 IPC |
| 文件 | 原生对话框；完整读取、刷盘、替换后才报保存；未完成文件 `.partial-<uuid>`（可能缺完整末行），不覆盖原目标 |
| CSV / JSONL | CSV 固定 `_index,_id,_source,fields`，对象按原 JSON 单元格（与已加载导出的展开列不同）；JSONL 每行完整原始 hit，仅去字符串外空白 |
| 状态与进度 | saved/cancelled/limited/partial/failed 与 none/partial/complete/unknown 文件状态分开，PIT 关闭未确认单列 pending；有界阶段/行数/字节，不把命中下界当百分比 |
| 工作台 | 进度可收起并由标签下入口重开；切标签/设置/语言不重发；关闭原标签/目标失效停止导出 |
| 持久化 | 无新 schema、导出恢复或后台服务；部分文件不续传，不持久化 PIT/正文/凭据 |

关键词/数值排序按最终 DSL 方向与缺失位置比较，数值有界十进制精确比较不经 f64；自定义日期格式拒绝。
预算/取消在请求与写入安全边界检查；原生对话框与阻塞磁盘调用不可强制打断，须等其退出。

| 检查 | 结果 |
| --- | --- |
| 8 个前端定向文件 | **198** 项（首轮 6 文件 154/155 标签名写错，修正后 191 → 补强后 198） |
| eslint、`npm run build` | 通过；JS 992.72 kB 警告保留 |
| `cargo test --locked query_export` / `--lib query::tests` / `--lib cancel` / `--lib saved_queries::tests` | 31（首轮 24，`&String` 编译错修正）/ 19 / 26（真实网关 1 忽略）/ 10，有重叠 |
| fmt、`clippy --lib -D warnings` | 通过（仅生产库，非全目标；按建议简化一处布尔表达式） |
| 文档 | 9 文档、98 本地链接、43 表格；30 个文件 LF/BOM/末尾换行与 `git diff --check` 通过 |

前端文件：snapshot-export、snapshot-export-service、snapshot-export-ui、query-export-ui、query-export、query-live、ipc、
app-query-integration。共享样本 [query-export-v1.json](../../tests/fixtures/query-export-v1.json) 前后端共用（含超安全整数文本）。
写失败通过只读句柄注入，非真实磁盘满。OMP 后端任务约 40 分钟无可审查产出，主代理停止其进程树后接手（relay 失败退出）。
特有待验：真实 PIT/最新 PIT ID/游标/权限拒绝/过期与全量比对；原生对话框选择/取消/覆盖、不可写目录、磁盘满、长路径；
取消/断网/退出后的 `.partial-*`；凭据替换/连接删除/端点或 CA 变化/密钥库故障时不得转向新目标、缓存旧秘密或无认证降级；
最终 DSL 内部滚动与进度收起/重开。

## 2026-10-10 Q05 已加载文档对比

基线 `7d1cd15`；仅比较同一执行的两条已加载记录。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 入口 | 结果底栏 Lucide 对比按钮，恰好选中两条时启用；可跨已加载页/本地分页/排序 | 不按显示序号、`_id` 找记录，不查字段、取文档或续页 |
| 身份 | `ResultHit.raw` 指向接收页完整 hit；核对原对象及页/行，捕获连接 ID/端点/目标/执行 ID/开始时间 | 相同 `_index`/`_id` 的不同记录独立；未返回 `_id` 不以位置回退冒充 |
| 内容 | 元数据、`_source`、`fields` 分开；顶级字段逐项比较，嵌套对象/数组整值比较 | 不扁平化点键或猜 nested/Mapping；runtime 仅按当前执行 DSL 标记 fields，不回填 source |
| 语义 | 未返回、null、空串/数组/对象、类型变化、单侧返回、相同/不同 | 两侧均未返回为未知；不代表未加载或投影/FLS 隐藏的数据 |
| 操作 | 来源分段、仅差异、字段查找、50 项分页、左右交换、原值/整条 hit 复制及失败 | 只改本地视图；不改 DSL/结果/时间/参数/列布局/PIT，不发模型 |
| 生命周期 | 点击时生成深冻结副本；草稿/端点变化显示旧来源提示，续页不替换 | 新执行渲染时阻断旧弹窗，离开标签/设置关闭不自动重开；不进恢复/查询库/历史 |

值相等：忽略对象属性顺序、空白、等价转义；数组顺序必须一致；数值精确十进制/BigInt（`1E400`=`10e399`、`1.0`=`1`、`-0`=`0`，
相邻超大整数/长小数不因舍入相同）。显示/复制保留原 token，非逐字节 diff。原文以 React 文本渲染。

有界合同：每 hit **1 MiB UTF-8**、两条 **2 MiB**，不重解析整页；先扫描后解析，**64 层**、每 hit **100,000 token**、数字 **4,096 字符**
（在 BigInt 指数计算前限额）；严格 reader 拒绝重复/转义重复键、注释、尾逗号；对比项合计 **4,096**（含容器状态与未返回 runtime 项），
超限整次拒绝不截断，每页 **50**。空 `fields` 与未返回 `fields` 区分；非对象容器整项比较。

| 检查 | 结果 |
| --- | --- |
| 前端 11 文件 | **243** 项；11 文件 lint、typecheck、构建通过；末轮英文文案 3 文件 70 项复验 |
| 领域 53 / 新 UI 12 | 精确数字、嵌套与数组顺序、元数据阴影/点键/原型键、缺失 ID、runtime 来源、配额与身份、深冻结；两条选择/跨页/往返/续页冻结/复制失败/双语 |
| 构建 | 主 JS **1,410.87 kB**、CSS **116.32 kB**；Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB** |
| 文档/diff | 20 文件 UTF-8/LF、8 文档/250 链接/60 表格、秘密检查无命中 |

测试文件：document-comparison、document-comparison-ui、query-result、result-grid、result-grid-ui、query-live、query-executions、
query-export、query-library、app-workspace-recovery、field-formats-grid。
开发修正：首轮领域 80/81（超限测试空白加在 hit 外，改在 hit 内增字节，不调配额）；runtime 空容器反例先红后修；
UI 查询定位与 lint 修正（中间 2 文件 61/64 → 10 文件 237 → 243）；补格式化表格原值对比/复制与长 ID 滚动回归。
特有待验：投影/FLS/runtime 缺失、同 ID 跨索引/跨页、部分结果、端点变化/重跑、对比期间无额外请求；限额拒绝非性能证据。

## 2026-10-10 Q05 宽结果列窗口化

基线 `91e6a10`；只窗口化已加载结果的列，保留 50 行本地分页，非完整行列虚拟化。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 窗口 | 可见列 >24 时 TanStack Virtual 横向取范围，每侧 overscan 2；窄表全列 | 未测得宽度时先最多 8 列 + 必要保留项；非字段数上限 |
| 尺寸 | TanStack 列宽为事实来源；`colgroup` 与隐藏占位保留总宽，尺寸/顺序/显隐变化重估 | 不测量文字覆盖列宽；收窄钳制滚动，不按滚动查询 |
| 渲染 | 表头与行只挂载窗口及保留列，不建全列 cell 对象 | 数据、字段发现、排序仍在内存；列设置列表非虚拟 |
| 交互 | 排序/列宽/双击自适应、显隐/重置、dnd-kit 换序、详情/对比/筛选保持 | 排序仅已加载行；列操作不改 DSL/执行/续页 |
| 焦点 | 保留当前/上次焦点列、前后及首尾可聚焦列、拖拽源/目标邻列、按下列、选区端点 | 只保留离散少量列；离开结果面清理 |
| 复制 | 选区跨未挂载列或含格式化值时，按可见列顺序与真实行重建整单元格原值 | 不补隐藏列、不改行选择；普通原值局部选区仍原生复制 |
| 隔离 | 表格/JSON/标签往返各自保留滚动与选择；实例绑定查询与执行身份，新执行从原点开始 | 列偏好由父层保留；结果/选区/窗口/滚动不持久化 |
| 无障碍 | 表格报告完整可见列数，单元格报告逻辑 `aria-colcount`/`aria-colindex` | 非屏幕阅读器证明 |

新增内部 `useResultColumnWindow`；`QueryResultGrid` 仍用 TanStack Table **9.2.6**、dnd-kit 与精确十进制排序；记录键 `pageIndex:position`。
依赖：固定 `@tanstack/react-virtual` **3.14.14**（传递 `@tanstack/virtual-core` **3.18.0**，MIT，peer 含 React 19），锁文件仅新增这两个；
安装时审计与 `npm audit --omit=dev --json` 均 **0**。无 Rust/IPC/schema 改动，无 worker/远程资源。

| 检查 | 结果 |
| --- | --- |
| 9 文件 | **162** 项（含宽表 15），4 文件 lint、typecheck、构建通过 |
| 有界挂载 | 合成 320 字段/70 记录、可见列 323、每页 50 行；640 px 下最多 12 数据列/600 单元格（非 16,150） |
| 几何/列操作/身份/剪贴板 | ResizeObserver 替身；24/25 列启用、零宽/收窄钳制；键盘 dnd-kit 换序；70 条同 ID 记录；跨 66 列与反向选区 |
| 构建 | 主 JS **1,442.78 kB**、CSS **116.39 kB**；Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB** |
| 文档/diff | 15 文件 UTF-8/LF、8 文档/259 链接/61 表格 |

测试文件：result-grid-window、result-grid-ui、field-formats-grid、document-comparison-ui、query-live、query-executions、
app-workspace-recovery、query-export、result-grid；另 `npm audit --omit=dev --json`。
先红反例：原值/格式化选区漏未挂载列；替换执行沿用旧横向位置 6,752；已滚动小表首次启用窗口误取挂载初值——均修正后通过。
特有待验：粘性表头与列对齐、滚动条/触控板、跨窗口指针与键盘换序、单行横向/跨行/反向选择复制、旧结果/续页/重跑无额外请求；
真实大字段集、列设置列表与大结果内存/渲染基准、完整行虚拟化仍开放。

## 2026-10-10 Q05 已加载文档结构化字段详情

基线 `82ee245`；扩展既有单条详情。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 读取 | 从对比提取共享 `loaded-document` reader；核对真实页/行与 hit 对象 | 不按 `_id` 合并或重查；未返回 ID 不以位置冒充 |
| 目录 | 每个容器/数组成员/叶子的 JSON Pointer、父子关系、JSON 类型、原文范围 | 相对完整 hit，`~`→`~0`、`/`→`~1`，点键不拆；不猜 Mapping/nested |
| 来源 | 元数据/`_source`/`fields` 分离；runtime 标记仅按执行 DSL 附于 fields 及子值 | 不从草稿/未应用视图推断，不显示脚本，不以 source 回填 |
| 缺失 | 容器状态、核心元数据未返回、未返回 runtime 诊断，与 null/空容器分开 | 仅 `fields` 为对象或未返回时加 runtime 诊断 |
| 交互 | 结构化/完整 hit JSON、来源筛选/路径搜索、逐容器/全部折叠、50 项分页 | 搜索只匹配已加载路径，不改折叠状态，不扫描索引 |
| 复制 | JSON Pointer、原值/容器、原始 hit、原接收页、原有“复制文档” | 原 token，不受显示格式影响；剪贴板拒绝可见 |
| 生命周期 | 打开时冻结执行来源、hit 与原接收页；新成功快照/离开关闭 | 续页/草稿/端点变化不替换；不保存目录/搜索 |

`Copy document` 为 source 优先、否则 fields，保留明确返回的 `_source: null`；`Copy raw response` 复制最初整页（只保留已有字符串引用）。
标题最多 160 字符加省略号。
有界合同：单 hit **1 MiB**、**64 层**、**100,000 token**、数字 **4,096 字符**；目录 **4,096 节点**、累计 Pointer **1 MiB UTF-8**、每页 **50**；
搜索输入 **1,024 字符**；超限整次拒绝。对比的 4,096 项上限与语义不变，旧公共限额名从共享模块重导出。

| 检查 | 结果 |
| --- | --- |
| 9 文件 | **222** 项（新领域 38、新 UI 17）；13 文件 lint、typecheck、构建通过 |
| 生命周期 | 新快照复用请求 ID 后旧详情重现的反例先红，改按结果快照身份清理；详情操作不增加 execute/readResource/PIT/cancel 调用 |
| 构建 | 主 JS **1,455.02 kB**、CSS **119.91 kB**；Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB** |
| 文档/diff | 22 文件 UTF-8/LF、8 文档/270 链接/62 表格 |

测试文件：document-detail、document-detail-ui、document-comparison、document-comparison-ui、field-formats-grid、result-grid-window、
query-live、query-executions、app-workspace-recovery。首轮 UI 100/101（漏导入 `within`）及 `exact` 参数/TS 收窄修正。
特有待验：长路径/值/ID、内外滚动、展开/分页、投影/FLS/runtime 多值、同 ID 跨页、详情期间无额外请求；深层/大数组耗时与内存无基准。

## 2026-10-10 Q05/O05 字段能力证据说明

基线 `837336d`；只完善既有字段侧栏与共享读取证据，不查 Top values/覆盖率/全索引统计。

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 报告 | 保留 searchable/aggregatable/metadata 原布尔或未知、类型索引与两个限制索引清单 | 报告与保守布尔门控分开；未知不冒充 false |
| 清单 | 未分列/有效空/有成员/无效独立，保留原顺序与字面名 | 不从根索引集补类型索引；坏成员不丢弃后放行 |
| 结构 | 每类型分别展示，冲突可解释；空类型集合可见 | 字段/类型非对象、显式 `type` 与键矛盾、坏根索引集整次拒绝 |
| 来源 | 会话资源状态记录请求 ID、连接 ID、核对过的端点与确切请求目标 | 不以返回索引集冒充目标；不改 IPC/数据库 |
| 当前性 | 侧栏核对来源 ID/端点/资源种类/目标；刷新中/失败/不匹配隐藏旧能力 | 同目标最近响应不保证集群未变，非执行快照 |
| 展示 | 紧凑字段/元数据展开行；来源正文与索引成员按需挂载，每页 20 索引 | 150 字段上限与名称筛选保持；无 HTML/猜子字段 |
| 失败 | 字段能力拒绝单独提示，与索引列表拒绝和查询授权分开 | 不阻止显式运行有效 DSL；不自动重试/回退 |
| 消费者 | 时间/筛选/nested/排序/可视化/补全继续用保守门控 | 不改其审核/绑定/脚本/执行边界 |

`src/domain/resource.ts` 新增可选 `report`/`indexEvidence`；无报告投影只显示未知。门控：无报告/无效类型索引/对应限制清单 → 关闭；
有效非空限制清单 → 受限并关闭；明确 false 且无限制 → 不可用；有效 true 保留门控但不保证权限。`metadata_field` 缺失/非布尔为未知。
根索引集合重复/空名/非字符串/非数组拒绝响应；可选清单同类问题标无效。`unmapped` 按字面显示。
`Loadable` 增加可选会话来源（不持久化、不中转凭据）；只在响应 ID/连接/端点核对后发布新来源；换端点重建侧栏、换目标重建字段区。

| 检查 | 结果 |
| --- | --- |
| 前端 15 文件 | 有效 **616** 项（主体 611 + 补强 2 文件 72 替换原 67）；11 文件 lint、typecheck、构建通过 |
| 分项 | 资源领域 45、消费者 14、资源 hook 7、新侧栏 19、工作台 53、其他 478 |
| 构建 | 主 JS **1,463.49 kB**、CSS **121.80 kB**；Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB** |
| 文档/diff | 20 文件 UTF-8/LF、8 文档/267 链接/57 表格 |

测试文件：resource、field-capability-consumers、field-capability-ui、query-resource-evidence、query-live、data-views、data-views-ui、
field-formats、runtime-fields、query-time-range、query-filters、query-nested-filters、query-sort、query-completions、visual-query。
修正：首轮 79/81（漏快照时间、同名文案混查，时间单位应为 `minutes`）；扩展首轮 606/611（未应用 runtime 应为 `runtimeNotApplied`、
端点提前进入 DOM）；复审补“新请求直接完成”反例先红，字段能力明细加请求 ID key 后 72 项通过。
特有待验：多索引/别名/类型冲突、FLS/诊断拒绝与授权查询分离、不同 ES 版本返回形状；160px 侧栏、长字段/端点/索引、20 项分页；
大型 field caps 性能开放。

## 2026-11-09 v0.1.1 发布工作流与三平台标题栏（R01/F02.2）

- 版本 0.1.1：已推送的 `v0.1.0` 标签指向 `2a91f29`，不移动；package.json/lock、tauri.conf.json、Cargo.toml/lock 同步，
  界面页脚与“关于”改由 `src/domain/app-version.ts`（读 package.json）提供，不再硬编码。
- `.github/workflows/release.yml`：推送 `v*.*.*` 或手动指定已有标签；先校验标签格式与三份清单版本一致，
  用 `docs/releases/<tag>.md` 建（或复用）草稿 Release，再以 tauri-action 构建 Windows NSIS、macOS arm64/x64 DMG、
  Linux（ubuntu-22.04）deb/AppImage 上传；不生成 updater JSON，不签名，草稿需人工核对后公开。
- 打包配置：`tauri.macos.conf.json` 加 `bundle` dmg，新增 `tauri.linux.conf.json`（deb/appimage）；基础配置仍不打包，
  `build:desktop` 继续 `--no-bundle`。
- 标题栏：macOS `trafficLightPosition` (20, 29) 使交通灯中线对齐 58px header，header 左内边距归零、安全区 78px，
  全屏时恢复内边距；Windows/Linux 控件增加按下态，Windows 图标线宽 1.5、关闭按下 `rgb(196 43 28 / 0.9)`。

| 检查 | 结果 |
| --- | --- |
| `npm run lint`、`npm run build` | 通过；大包警告保留 |
| Vitest 全量 `--maxWorkers=2` | **149** 文件 **2699** 项通过（新增 `app-version`，`window-config` 增发布打包断言） |
| `cargo fmt --check` | 通过；Rust 代码未改，仅版本号，未重跑 Rust 测试 |
| `npm run build:installer:windows` | `EScope_0.1.1_x64-setup.exe` 6,010,211 bytes，未签名，未实装 |

未验证：GitHub 工作流未运行（本机 `gh` 令牌无该仓库权限）；macOS 交通灯位置为按 tao `inset_traffic_lights` 推算，
需实机核对；DMG/deb/AppImage 未构建；安装/卸载与签名未做。待验项见 [人工清单](../manual-acceptance.md)。

## 2026-11-09 v0.1.1 Release 上传修复（R01）

- 现象：推送 `v0.1.1` 后 Release 运行 `42548461182` 全绿，草稿 `438679206` 却无资产。四路构建实际产出
  `EScope_0.1.1_x64-setup.exe`、`EScope_0.1.1_aarch64.dmg`、`EScope_0.1.1_x64.dmg`、`EScope_0.1.1_amd64.deb`、
  `EScope_0.1.1_amd64.AppImage`，均以 `No releaseId or tagName provided, skipping all uploads...` 结束。
- 原因：`prepare` 在 `gh release create` 后立即用 releases 列表回查 id，新草稿尚未出现在列表中，输出 `id=` 为空且不报错；
  事后同一查询可返回该草稿。
- 修复：新建分支改为 `gh api --method POST .../releases` 并从响应取 `.id`；复用分支仍按标签查列表；
  id 非纯数字时 `prepare` 失败，构建不再运行。标签存在性由前一步检出 `refs/tags/<tag>` 保证。

| 检查 | 结果 |
| --- | --- |
| js-yaml 解析 `release.yml`、`bash -n` 该步骤脚本 | 通过；`releaseId` 仍取 `needs.prepare.outputs.release-id` |
| 替身 `gh`（PATH 断言命中替身，`GH_TOKEN` 无效兜底）跑该步骤 | 6 场景符合预期：复用已有 id、多行取首个、新建取响应 id 并读到 `docs/releases/v0.1.1.md`、空 id 与 `null` 退出 1 且不写输出、缺发布说明退出 1 |

未验证：真实 API 的新建分支与补传未在 GitHub 运行；修复只在 main，`v0.1.1` 标签上的工作流不变，补传需从 main 手动触发。
另记：Checks 的 macOS `cargo test` 在 `connection::tests::oversized_search_responses_and_invalid_utf8_fail_closed` 与
`wrong_product_invalid_json_and_large_bodies_fail_closed` 超过 60 秒后不再结束，运行 `42181754453` 至 6 小时被取消，待单独排查。
