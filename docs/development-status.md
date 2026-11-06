# EScope 开发状态与能力记录

> 记录当前正式能力、未完成与待验收边界、检查命令与本机测试环境。产品概览见 [README](../README.md)；
> 批次索引见 [开发执行计划](development-plan.md)；任务与验收标准见 [Backlog](development-backlog.md)；逐批证据见第 3 节。

## 1. 当前已正式接入能力

截至 2026-11-06（v0.1.0）开发自动化通过的能力。以下共同约束各项不再重复：

- 时间、筛选、排序、视图、runtime、参数、聚合构建与固定定义加载均先完整 DSL 预览再显式应用，变化后需重审。
- 启动、切换连接、设置/语言/主题、恢复与加载均不自动执行；索引标签目标锁定，基于索引新建同目标查询为明确动作。
- 字段/Mapping/runtime 证据不当授权；旧快照与旧 PIT 不被后续编辑改写；会话态不持久化、不额外查询；超限整次拒绝，原 token/原文保留。

### 1.1 查询工作台与多标签

- **标签**：无恢复记录时默认显示索引打开入口；打开索引新增独立只读预览标签，同连接 ID + 索引只定位不重查，各标签状态互不覆盖；AI 默认收起。按打开顺序排列，有效标签同步顶部与资源栏连接；关闭回退相邻标签并清理请求/PIT，中键后台关闭不抢焦点，支持方向键与 Ctrl/Cmd+W。
- **工具栏与顶栏**：状态、精确命中数与视图/刷新收拢于单一工具栏，表格/JSON 底栏合并计数与操作。Windows/Linux 自定义窗口控制、macOS 原生交通灯 overlay 融入 header；浏览器不模拟窗口按钮。

### 1.2 Monaco 编辑器与补全

- **编辑器**：延迟加载，本地 JSON 着色/校验（重复键拒绝、双语行列 marker）、无损格式化、撤销/重做、字面量查找；每标签独立模型/撤销栈/选区/滚动，关闭释放、不跨重启。长整数/小数/转义/未知 DSL 不经数值重序列化；本地 worker/字体，无 JSON 语言服务/远程 schema；加载失败保留原文；本地校验不代表脚本编译或授权。
- **补全**：已知 query/sort/fields/_source 字段与整值参数占位内的名称，只用同连接 ID/端点/目标的当前 field caps、当前 DSL runtime/参数定义；旧目标/失败不回填，单 token 无损插入。DSL 256 KiB/64 层、目录 4,096 字段、100 候选；不猜子字段/nested、不改模板，无跨标签词语/snippet。
- **可视化/DSL 双模式**：AND/OR、term/match、单边界 range、exists/missing、数量与单字段排序；不支持的复杂/nested/脚本语法保留原文；未完成条件跨标签保留并阻止执行旧 DSL。

### 1.3 时间范围与筛选

- **时间范围**：最近 N 秒/分/时/天（天固定 24 小时）或绝对本地起止，UTC/IANA/固定偏移；≤ 10,000 单位、总跨度 ≤ 3,660 天；左闭右开，date 不舍入毫秒、date_nanos 保留纳秒，无效/歧义本地时间拒绝。有界 wrapper，手写同字段范围不覆盖；相对时间在执行/开 PIT 前冻结，手改 DSL/目标解除托管；索引标签不接受时间配置，无自动刷新、日期数学或日历取整。解析用 Temporal 0.5.1 与 chrono/chrono-tz。
- **单元格筛选**：取执行原值，顶级 keyword/数字/布尔包含/排除、text 分析短语、独立 exists/missing；数组明确选元素，不猜 `.keyword`；未知/冲突/nested/含点路径拒绝；≤ 32 条、每值 4 KiB，待应用列表不恢复。
- **布尔组与 nested**：≤ 8 非空组/共 32 条，组内/组间 AND/OR，每个 OR 显式 `minimum_should_match: 1`，新增组与原 query 取 AND 交集不评分。显式 nested 仅顶级路径与直接标量字段，同目标 Mapping/field caps 索引集合须一致，对象内排除与父文档排除分开，`score_mode: none`、`ignore_unmapped: false`；日期/IP 仅存在性，别名/深路径/路径下 runtime 拒绝。无任意深层组、组级 NOT、自定义 MSM。
- **启停与会话绑定**：禁用保留定义/归属并计配额，无启用成员的组不编译；已应用筛选以深冻结基线/已应用文档/真实观察绑定，从基线重建不重复包裹，全禁用/移空经审核恢复精确基线；失配阻止覆盖，解除只遗忘定义；绑定不进 IPC/恢复存储。
- **固定筛选库**：平面 mapped、顶级 mapped nested、平面 runtime 可固定/删除/同目标复用（nested runtime 拒绝）。库 v3 兼容 v1/v2 读取不改写，显式新增升级、不降级；100 组/256 KiB、每组 32 条/8 组、每值 4 KiB；schema v8 独立行串行 CAS。runtime 只取当前已应用 DSL 声明，脚本每段 4 KiB、声明 32 项/64 KiB、七类型，完整源码另行确认。加载为同连接 + 同目标待审字面量副本，nested 审核时新取 Mapping/field caps，runtime 不注入/运行脚本；不覆盖已有待应用/绑定筛选。
- **服务器排序**：≤ 8 个平面标量字段，方向/优先级/缺失位置/兼容 `unmapped_type`，不猜 keyword；复杂手写 sort 不覆盖；表头排序仍仅已加载行，旧 PIT 续页沿用原排序。

### 1.4 结果、对比与聚合

- **执行与 PIT**：索引/字段/Mapping 读取、快照查询/取消、部分结果、无损表格/JSON/详情，均用可信连接快照；显式 sort 查询首页前开 PIT，按最新 ID 与原游标续页，过期从首页重跑；迟到响应隔离。
- **表格与行选择**：TanStack Table 升降序、拖拽/键盘换序、列宽、显隐与重置；排序仅已加载文档、50 行分页，布局/页码/滚动按标签保持；超过 24 个可见列时 TanStack Virtual 窗口化。各结果与管理表格支持持久选中、拖动/修饰键/键盘多选与边缘滚动，按稳定记录保存。
- **对比与详情**：恰选两条按原接收页/行本地对比，元数据/`_source`/`fields`/runtime 分离，差异/字段筛选、分页、交换与原文复制，每记录 1 MiB。结构化详情含 JSON Pointer 搜索/复制、折叠与 50 项分页，1 MiB/hit、目录 4,096 节点/路径 1 MiB。
- **字段能力**：名称与类型默认显示，按类型展开报告/限制索引/未知；报告与保守门控分离，来源核对同连接/端点/目标，刷新中/失败不展示旧能力；索引成员每页 20，150 字段上限。
- **聚合结果**：按执行 DSL 读取六类单值指标与单层 terms/date_histogram 及直接指标；原值/null、近似/误差/遗漏、页级部分状态可辨；每次选一个原接收页与聚合，50 桶分页，不累加 PIT 页，不补桶；DSL 256 KiB/接收页 1 MiB、32 定义/4,096 桶。
- **图表与定义**：延迟 Visx 单值/terms 条形/date_histogram 折线，原桶表保持可用，200 桶上限；统一构建/保存/交换入口，结果快捷保存读取原执行字段、size/间隔并审核，旧库可同目标无损复用。会话级参考线每图 ≤ 4 条、显式左/右轴（无第二度量不能选右轴），轴外不绘制不钳边，不改几何，离开即清，不进定义/恢复/交换。

### 1.5 连接、安全与设置

- **设置与外观**：固定左侧导航，管理页在右侧切换且返回不丢草稿；资源栏 160–340px、AI 280–640px，窄窗口 AI 为覆盖层。系统/日夜、四种强调色、中英文、字号/字体/密度、局部重置、启动偏好；命令面板、键盘导航、IME 保护、未保存草稿关闭确认。
- **只读集群页**：健康/节点/分片/索引经受限 IPC，无自动轮询，刷新失败保留旧列表并标记；主题化控件，Chromium 外原生回退。
- **连接与凭据**：Basic/API Key/Bearer 添加/编辑/替换/解绑/删除，稳定 ID、顺序与回退；秘密不回填前端，HTTP 提示未加密，浏览器拒绝保存认证材料；旧凭据清理未完成单独提示并可有界重试。自定义公共 CA PEM，默认验证保留、无跳过开关，换端点不沿用旧凭据或 CA。
- **认证与密钥库**：负载版本化，API Key 仅编码一次；认证只从数据库生成的不可变快照解析，秘密缺失/密钥库不可用/损坏不降级为无认证。Windows keyring、脱敏错误，schema v2 凭证引用与清理队列；macOS/Linux 密钥库明确不可用。
- **能力诊断**：显式身份/角色与 monitor/read/view_index_metadata，不足/未知/不支持分开，monitor 不阻止搜索；精确版本/Serverless、许可与功能证据，404 为未知；许可/功能报告后端缓存 60 秒、最多 16 连接，身份/权限每次重查；不开放 Graph/语言或写入 API。

### 1.6 Data Views 与字段增强

- **视图库**：≤ 100 项/256 KiB，绑定稳定连接 ID、目标模式与可选默认时间字段；同连接应用到草稿、跨连接新建查询；定义副本随草稿恢复，库修改不重绑旧草稿或结果；默认时间字段缺失/冲突/不可搜索分别提示。
- **字段格式**：每视图 32 项/16 KiB，数字分组、精确百分比/IEC 字节、UTC 日期；不符显示原值，执行前深冻结，原值开关不重查；无脚本/HTML/URL 格式器，不进入请求或导出 DSL。
- **查询期 runtime**：七类型，每视图 32 项/64 KiB，取同名 `_source` 或每段 ≤ 4 KiB 内联 Painless（无 lookup/composite/存储脚本/参数）；不覆盖不同的手写同名定义，后端独立校验首屏/PIT 白名单；只有执行 `rawDsl` 中字段生效，读 `fields` 原值不回填 `_source`；PIT 不冻结脚本输出。

### 1.7 导出、恢复与查询资产

- **参数模板**：整值 `{"$param":"name"}`，六类值，不插值键名/片段/索引；≤ 32 参数，模板/最终 DSL 256 KiB、单值 64 KiB；未应用输入值不持久化。
- **查询定义交换**：≤ 100 定义/4 MiB，参数化条目导出模板；不含连接 ID/端点/认证/凭据引用/结果/历史，已知敏感键阻止；导入逐项映射或保持未绑定，原子新增不覆盖，CAS 冲突需重载。Data View 绑定/格式/runtime 配置与时间托管不随交换（后者需额外确认）。
- **全量流式导出**：独立 PIT 的 CSV（`_index,_id,_source,fields`）/JSONL（完整 hit）；单任务，每批 ≤ 1,000 行/响应 1 MiB，总 ≤ 1,000,000 行/1 GiB/30 分钟；写 `.partial-*` 刷盘后替换，取消/限额/失败不报完整；原标签关闭即停止；拒绝 `runtime_mappings` 与脚本。
- **恢复与历史**：自动保存标签、活动上下文、未保存草稿、结果视图与列布局，只恢复定义，≤ 50 标签/4 MiB。历史区分首屏/预览/续页的成功/部分/失败/取消/中断，≤ 100 项/4 MiB，不存结果或认证；保存当次 Data View 副本，收藏恢复保留相对时间意图，历史恢复只还原当次绝对 DSL；修订号 CAS 防旧写覆盖。

### 1.8 存储与 AI

- **SQLite schema v10**：兼容 main/dev 两种 v9 图表表结构，补缺表不重写旧定义/连接 ID/修订号；保留 v8 固定筛选、v7 数据视图、v6 工作区恢复、v5 公共 CA/查询库、v4 模型凭据。各库独立 CAS，损坏/未知/冲突不覆盖；秘密只存系统密钥库；异常表结构不自动修复；定义文档版本与恢复合同不随 schema 变化。
- **多模型配置**：自定义 HTTP/HTTPS 地址/端口/基础路径/模型 ID；显式获取兼容 `/models` 或 Ollama `/api/tags`，也可手填；生成测试仅在完整非空回复后通过。
- **AI 对话面板**：兼容 Chat Completions/Ollama 流式、多轮历史、取消、失败重试、安全 Markdown；Enter 发送、Shift+Enter 换行、IME 不误发；仅显式附加才发送查询草稿快照，不带结果、不跨目标转发；会话仅内存。**v0.1.0 中由 `src/domain/feature-flags.ts` 的 `AI_ASSISTANT_ENABLED = false` 隐藏 AI 助手入口，实现与测试保留。**

## 2. 尚未完成与待验收边界

- **尚未完成**：任意可视化 DSL、Monaco 深层语法建议、文档时间上下文/完整字段详情、完整虚拟化与大结果基准、进阶图表余项（注释/图例筛选/公式/同比环比/图层）、复杂条件/nested/日历时间、真实认证 TLS 与完整权限许可矩阵、AI 候选审核和写入管理；时间/runtime 的真实边界/权限/成本及字段格式、保存导出、参数交换的真实与原生验收。
- **待人工验收**：连接保存不等于连通；恢复类能力的桌面重启与退出期间保存；AI 会话不跨重启。schema 升级后不能用只识别旧版本的应用打开，不认识可选 v1 子对象（如时间）的旧版应拒绝而非删字段覆盖。IANA 宿主与锁定时区数据差异、真实环境、系统密钥库、原生导出及跨平台分开验收。

## 3. 开发主线与批次记录

2026-10-09 用户确认六方向：**连接与权限、数据探索、保存与导出、聚合与图表、数据管理、地图与关系**（边界见 [平台设计](platform-design.md)）。
仍有效的顺序：先认证/权限与保存导出，再数据探索和聚合；写管理先完成后端审核/任务框架；地图/Graph 在查询与能力合同稳定后可并行，
地理文件导入等待文档导入框架；图表限单查询分析与保存复用，不扩展 Dashboard、团队服务、Fleet/APM/SIEM。

批次索引见 [执行计划](development-plan.md)；逐批实现、测试数字与未验项见：
[工程基础与连接](acceptance/foundation-and-connections.md)、[Data Views](acceptance/data-views.md)、
[查询编辑器与参数](acceptance/query-editor-and-parameters.md)、[查询筛选](acceptance/query-filters.md)、
[结果与工作台](acceptance/results-and-workspace.md)、[聚合与图表](acceptance/aggregations-and-charts.md)、
[AI、模型与手测反馈](acceptance/ai-models-and-feedback.md)。

依赖基线：`npm audit` 与 `--omit=dev` 均为 0（watcher 2.5.1 → 2.5.6、移除 micromatch/braces 链、source-map-js 1.2.1 → 1.2.2）；
Monaco 0.57.0、DOMPurify 3.4.16、react-virtual 3.14.14 / virtual-core 3.18.0、Visx。主 JS 约 1,463 kB 与延迟 Monaco 约 3,125 kB 体积警告保留。

## 4. 核心检查命令

```sh
npm run check
npm run test:rust
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

- `check` 包括 lint、TypeScript strict、正式构建、正式单元/组件测试和原型构建/回归。
- 开发中只运行自动化并审查代码，不反复启动浏览器巡检；功能开发后统一执行 [人工验收清单](manual-acceptance.md)。未人工验证的 UI/系统集成不标通过。
- 底座历史截图、F06.2/C01.1 命令与真实服务证据见 [工程基础与连接验收](acceptance/foundation-and-connections.md)。

## 5. 本机 ES 与模型测试环境参数（开发者备忘）

- **本机 Elasticsearch**：目录 `D:\es\elasticsearch-7.17.25`，版本锁定 **7.17.25**，绑定 `127.0.0.1:9200`，单节点，关闭认证。
- **代理注意**：本机 `HTTP_PROXY` 可能导致回环请求走代理报 502；Rust 客户端已显式禁用环境代理。手工诊断：
  ```powershell
  # PowerShell 诊断
  Invoke-RestMethod http://127.0.0.1:9200 -NoProxy
  # curl 诊断
  curl.exe --noproxy 127.0.0.1,localhost http://127.0.0.1:9200/
  ```
- **显式授权的本机 ES 测试**（默认 Rust 测试会忽略此用例）：
  ```powershell
  $env:ESCOPE_TEST_ES_71725 = '1'
  cargo test --manifest-path src-tauri/Cargo.toml --locked local_elasticsearch_71725_read_only_identity -- --ignored
  ```
- **本地 AI 网关联调**：
  ```sh
  npm run test:ai:gateway
  ```
  这是用户授权的本机 8788/v1 联调入口，密钥通过隐藏输入读取，仅传入测试进程；切勿将密钥写入命令、脚本或配置中。

## 6. 独立原型说明

原型入口位于 `docs/theme-preview.html`，提供独立离线静态体验：
```sh
npm install
npm run build:prototype
npm run test:prototype
```
- 原型用于早期交互验证与主题调优，包含固定的集群概览、分片矩阵、DSL 切换与日夜主题。
- 原型使用浏览器 localStorage，仅包含固定演示数据，不连接真实后端与系统密钥库。
