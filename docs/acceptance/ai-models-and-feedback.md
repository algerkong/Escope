# AI、模型与手测反馈 验收记录

## 共同说明

- 共同未验项：原生 WebView 布局/焦点/IME/主题/缩放、桌面流式与真实模型认证服务、模型密钥保存后重启端到端、
  Windows 安装/升级/卸载、macOS/Linux 原生与密钥库。mock/fixture/JSDOM 通过不冒充真实服务或人工验收；
  人工流程见 [集中人工清单](../manual-acceptance.md)。
- 真实 ES 均为用户授权的本机 `127.0.0.1:9200` ES **7.17.25**（无认证、只读），不写业务数据、不输出索引名/文档；
  1420/9200/8788 已有监听，不重复启动服务。历史批次结果不作后续批次证据。
- 未签名安装包、WebView2 缺失时需联网引导须披露；生产 JS 大包警告一律保留，不提高阈值。

## 2026-09-30 用户手测反馈（原始清单）

用户负责手测、不反复启动浏览器页面；主代理规划/审查/验证。

| # | 原始问题 |
| --- | --- |
| 1 | 连接 `http://127.0.0.1:9200` 后，首页仍“尚未加载索引 / 尚未加载字段”，无法查询 |
| 2 | 修改设置后显示“更改未能保存，当前填写的值仍然保留。本地存储不可用或包含无效数据，原有数据未被覆盖。”需修复实际保存失败，并用弹窗显示错误，不占顶部空间推动页面 |
| 3 | 打包只得到可执行 exe，需要真正的安装包 |
| 4 | 侧栏、标题、设置按钮/标签等非数据区域禁止选中文字 |
| 5 | AI 模型、集群概览、节点、分片、索引页面都“尚未接入”，需实现真实功能 |

| 优先级/任务 | 边界 |
| --- | --- |
| P1 F07/F03 设置持久化 | 先查类型化 IPC 与 Rust serde 合同、SQLite 错误、迁移与旧数据兼容；不删库、不清配置、不静默降级内存。线索：TS `startAI` vs Rust `start_ai` 在 camelCase 下为 `startAi`，须合同测试确认 |
| F03 错误呈现 | 非破坏性对话框，保留填写值、重试/关闭、焦点回归、中英文；header/查询区不因错误下移 |
| C02/O05/Q04/Q05 | 根身份 GET 成功≠资源发现/查询；按受限 IPC/后端操作注册实现索引、Mapping/field caps、查询执行/取消；可读最小必要数据联调，不写业务索引、不记录真实文档、不自动反复查询，切连接不执行 |
| R01 Windows | 原 `bundle.active=false`、`build:desktop` 为 `tauri build --no-bundle`，exe 是预期开发构建；新增真实安装包（如 NSIS），保留开发入口，同步 README，披露未签名，macOS/Linux 另验 |
| F03 非数据区域 | 仅导航/标题/按钮/标签 `user-select:none`；输入、textarea、DSL、错误详情、连接地址、表格/JSON/文档数据保留选择复制 |
| O/A 真实页面 | 先集群概览/节点/分片/索引只读，再模型配置、凭证 IPC、兼容协议/Ollama 与 AI 候选/授权；不得只删占位换 mock，无端点/凭据时不伪造连通、不外发真实文档 |

当时状态：F02.2 与 Q01.2 已实现（见 [结果与工作台记录](results-and-workspace.md)）；凭证内部编排与 schema v2 完成
（见 [基础与连接记录](foundation-and-connections.md)），秘密 IPC/认证网络未开放。

## 2026-09-30 第三批手测反馈收口

用户要求停止新增开发并提交到 `git@github.com:algerkong/Escope.git`（非强制推送；CI 未核验）。

| 任务 | 已集成 |
| --- | --- |
| F07/F03 | serde 测试复现 `start_ai` 映射为 `startAi`、拒绝 `startAI`；显式 rename/alias 修复，共享 JSON fixture、SQLite 重开/旧数据/失败保留；偏好错误改对话框 |
| C02/O05/Q04/Q05 | 封闭 operation + 类型化 IPC：索引、field caps、Mapping、首次 `_search`；10 秒/1 MiB/并发限制、禁代理/重定向、取消 future 与有界提前取消记录、部分结果；前端固定快照/请求/连接/端点、取消与旧响应隔离、JSON/表格/详情、字段筛选；被拒异源响应不留 JSON 视图 |
| O02–O05 | 设置右侧健康/节点/分片/索引详情，无后台轮询；修复 `thread_pool.*.rejected` 字段，BigInt 累计、缺失/部分失败、详情原文绑定、分页 |
| F03/R01 | 非数据控件禁选、数据区可复制；NSIS 当前用户级配置与 `build:installer:windows`，保留 `build:desktop --no-bundle`（安装包本批未构建/安装） |

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 25 文件 314 项、原型 16，lint/typecheck/构建通过（含定向 7 文件 72） |
| `cargo test --locked` | 117 通过、4 忽略（3 真实 ES、1 真实密钥库）；fmt、`clippy --all-targets -D warnings` 通过 |
| 本机 ES 形状核对 | `_resolve/index/*` 与受 filter_path 约束的线程池字段名通过 |

已知未完成：A01 仅准备代码（schema v3 迁移/模型 CRUD、服务/组件/词条在库，`models.rs` 未注册、ModelPanel 未接入）；
模型审查项：TS 拒绝额外秘密字段、Unicode 长度合同、同步提交锁与写后重读、重读失败提示、陈旧列表覆盖；
无模型凭据/协议/流式/候选；无 PIT/导出/可视化/虚拟化；取消只停本地 HTTP future，取消/完成 ID 各保留 64 条；
索引目标限 ASCII 名称/通配符/多目标，不支持跨集群/任意路径；schema v3 不支持旧版降级打开；资源无权限矩阵/认证/TLS。
后端 relay 毫秒目录名与打包线碰撞致归档 rename 报错，已从独立结果恢复。

## 2026-10-08 A01/Q04 模型配置接入与查询分页

### A01 模型配置

- `lib.rs` 注册 `models_load` / `models_save` / `models_delete` / `models_select`；纯配置，无凭据、不发请求。
- 前端注册 `models` 词条，“AI 模型”路由渲染 `ModelPanel`；`App` 启动创建一次 `createModelService()`
  （桌面类型化 IPC，浏览器显式会话内存，失败不回退）。
- `validateModelInput` 拒绝额外字段（对齐 `deny_unknown_fields`）、按码点计数（对齐 `chars().count()`）；`ModelEditor` 同步提交锁。

### Q04 PIT + search_after

- 只读注册表新增 `resource.pitOpen`（POST `{target}/_pit?keep_alive=1m`）、`resource.pitClose`（DELETE `_pit`）与内部 `PitSearch`
  （POST `_search` 无目标）；不经元数据规划器，绑定凭据的连接一律拒绝。
- `query_execute` 可选 `pitId`+`searchAfter` 必须成对：id ≤512 可打印 ASCII；`search_after` 严格 JSON 标量数组 ≤16 项/≤4KB；
  数字原样（`arbitrary_precision`+`preserve_order`）；草稿自带 `pit`/`search_after` 拒绝；回读 `pit_id`，不可用即 `invalidResponse`。
- “加载更多”首次续页才开快照（首页与续页间可能有窗口外写入），复用最新 id；行累积，详情按来源页切片，JSON 多页时标注仅最新页；
  无 `sort` 显示说明；过期（`notFound`）提示重跑并丢弃 id；重跑/取消/关标签/换连接/卸载尽力关闭。
- 界面：设置页标题焦点框贴合内容；浏览器预览补 favicon。桌面实机（Windows）恢复连接、加载 `.tasks` 索引、身份确认、
  集群概览与标题栏按钮在位；截图仅存本机 `work/shots/`（不入库），会话随后被锁定。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 正式 324、原型 16 |
| `cargo test --locked` | 121 通过、5 忽略；fmt/clippy 通过 |
| `ESCOPE_TEST_ES_71725=1 cargo test --locked -- --ignored` | 5 通过（身份、资源+查询、集群资源、PIT 往返 `local_elasticsearch_71725_pit_pagination_round_trip`、Windows 凭据库） |
| `npm run build:desktop` | release exe 约 14.1 MB，未签名，非安装包 |

新增测试：Rust 4、TS 快照解析 2、分页交互 4、IPC 2；模型领域/服务/App 级往返。
特有待验：含 `sort` 的连续加载更多、约 1 分钟后快照过期路径、模型增删改/设默认后重启保留。

## 2026-10-08 F02/Q01–Q05/A02/A04 工作台预览、交互表格与 AI 布局

本批共享预览已被同日 [索引多标签](results-and-workspace.md) 取代，当前行为以其为准。

| 子项 | 实现与边界 |
| --- | --- |
| F02/Q01 数据预览 | 明确点击/提交索引才读文档；固定只读 `match_all`、25 条、`_shard_doc` 排序；按连接独立，不覆盖查询标签 |
| F02c 隔离 | 启动/切连接/设置往返/外观语言不自动执行；资源栏随工作区连接，查询绑原连接；已移除连接草稿不重绑 |
| Q02/Q03 可视化 | 条件行、AND/OR、term、match、单边界 range、exists/missing、size、单字段 sort；切换不执行；保留 filter/must 评分、数字字面量与未编辑顶层属性 |
| Q05 交互表格 | TanStack Table 9.2.6 + dnd-kit：排序三态、拖拽换序、列宽拖动/键盘、双击自适应、显隐、键盘换位、布局重置 |
| Q05 状态 | 每查询/每连接预览会话内列状态；JSON/标签往返保留页，重跑回第一页保留布局；新字段追加，缺失字段不丢偏好 |
| Q05 无损显示 | 不截断到 8/16 列；嵌套预览只压缩 token 间空白；JSON/详情两空格缩进，复制用原始响应/原文切片 |
| Q04 PIT | 显式 sort 时首页前开 PIT，续页只用原快照及最新 ID；过期保留行并要求重跑；PIT 上限 64 KiB 与 Rust 对齐 |
| Q04 生命周期 | openPit 同步占位；取消/关标签/换端点/卸载失效旧请求；迟到 PIT 尽力关闭 |
| O05 字段列表 | 默认名称+类型，能力详情按需展开，元数据字段收起；选中索引用强调色 |
| A02 布局 | 标题栏只放标题与会话工具，模型选择/刷新/设置移到输入区；内部滚动、固定网格高度 |
| F02 面板 | 资源栏 160–340px、AI 280–640px，中间至少 420px，窄窗 AI 覆盖层；拖动/键盘/边界/恢复默认 |
| A02/A04 发送 | Enter 直接发送并消费草稿与附件；Shift+Enter 换行、IME/重复键/弹窗保护 |

限制：表头排序只作用于全部已加载文档后再 50 行分页，不改 DSL/不请求；数字按十进制符号/有效数字/BigInt 指数比较，不用 `Number`；
字符串完整值 UTF-16 序；混合类型固定顺序、null 与缺失同值；对象/数组列不排序。可视化不支持复杂/nested bool、script、boost、
多边界 range、多字段 sort、OR 内负条件（保留原文）；nested 后代、字段冲突拒绝。AI 无候选/工具执行、费用统计、跨重启会话。

| 检查 | 结果 |
| --- | --- |
| 定向 | 5 文件 95；5 文件 47；6 文件 208；列设置跨 JSON/标签/重跑回归（修复切标签误重置页码） |
| `npm run check` | 39 文件 639 项、原型 16 |
| Rust | 192 通过、6 忽略；fmt、`clippy --all-targets -D warnings` 通过 |
| `npm audit --omit=dev` | 0；完整 audit 5 个 high 在开发工具链 |
| 安装包 | x64 当前用户 NSIS 4,200,340 bytes，`NotSigned` |
| ES 只读 `ESCOPE_TEST_ES_71725=1` | 4 项：身份、资源与搜索、集群资源、PIT 首屏+真实续页（`_source:false`、`size:1`，完成后关 PIT） |
| Windows Credential Manager | 随机引用读写/删除 1 项，自行清理 |

三个长工作流集成/历史压力用例超 5 秒上限，仅这三项放宽到 15 秒并去掉无关逐字输入模拟，未放宽业务超时。
主代理补修：match_all 反解、filter 切 OR 评分、nested 后代、失效 PIT 续游标、续页 JSON 读第一页、列宽被 min-width 撑大、
缺失字段换序无效；未完成本地条件阻止执行旧 DSL。JS 约 867 kB（gzip 266 kB）。
特有待验：原生列拖动/键盘拖拽/列宽边界、文本选择不误触；AI 宽度 280/360/480/640px、短窗口、长消息/代码/附件、footer 位置。

## 2026-10-08 A01.2/A02.3/A02.1/A04.1/R01 AI 文本对话与 Windows 安装包

### 契约

- Enter/发送直接提交，无批准弹窗；Shift+Enter 换行，IME 不误发；提交即清空已消费输入与附件，旧请求回调不清新输入。
- 仅显式“附加查询”时冻结查询名称、索引与 DSL；不自动带连接 ID/地址/字段/文档/结果，附件本地身份不进 prompt。
- 每目标最多 20 条完整 user/assistant 历史；失败/取消/未完成交换不入历史。prompt 64 KiB、单条历史/输出 256 KiB、
  prompt+history 512 KiB，裁剪完整旧配对并标记；会话最多 30 交换、12 目标，仅内存。
- 用已保存模型稳定 ID，后端回读并核对协议/地址/模型 ID；会话/草稿/附件按目标隔离；隐藏 AI、进设置、删改目标停止旧请求。
- 协议：OpenAI-compatible Chat Completions SSE 与 Ollama `/api/chat` NDJSON；非 Responses、工具调用或候选审核。
  兼容 SSE 中间帧 `finish_reason:""` 为非终止；工具输出、冲突终止、空回复、截断拒绝或标记。
- IPC：类型化 `ai_chat` / `ai_chat_cancel` + 单次 Tauri Channel，只接受受限目标与有界消息，无任意方法/认证头/工具代理。
- 模型网络独立于 ES；浏览器预览不存密钥、不发模型请求、不回退模拟。
- 受限 Markdown：禁 raw HTML 与远程图片，代码只显示/复制；失败末条按原 prompt/history 重试，不消费新草稿。
- 密钥：schema v4 仅存凭据引用，密钥在系统密钥库，前端只得 `hasApiKey`；替换/清除/删除复用持久清理队列，清理失败不报成功；
  可选单次覆盖（A02.2）不进元信息/对话/日志。
- 用户要求充分自定义：允许任意 HTTP/HTTPS 地址/端口/基础路径/模型 ID，HTTP 仅非阻断提醒；发现用固定 `GET /models` 或 `GET /api/tags`，
  不可用时保留手填。其他认证方式与原生提供方另行实施；用量/费用、会话持久化、数据授权、候选应用不在范围。

依据：[OpenAI Chat Completions](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create)
（`stream: true`、`choices[].delta.content`、`finish_reason`、`[DONE]`）；[Ollama Chat](https://docs.ollama.com/api/chat)
（`/api/chat`、`messages`、NDJSON、`message.content`、`done`）。

| 子项 | 状态 |
| --- | --- |
| A02.1/A04.1 Rust（`ai*.rs`、受限 IPC、流/取消、多轮） | 自动化通过 |
| A02.1/A04.1 前端（侧栏、附件、Markdown、直接发送、底部工具、宽窄布局） | 自动化通过 |
| A02.2 单次认证（wire 覆盖与隐藏输入联调脚本，非主 UI） | 自动化通过 |
| A01.2/A02.3（schema v4、密钥/清理/发现、远程选择、保存凭据聊天） | 自动化通过；重启端到端待人工 |
| R01 Windows NSIS | 已构建、未签名、未安装 |

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 39 文件 639 项、原型 16 |
| Rust | 192 通过、6 忽略（默认不访问真实模型）；fmt/clippy 通过 |
| 本机 ES | 4 项只读通过 |
| Windows 密钥库 | 随机引用读写/删除 1 项 |
| 安装包（20:20） | 4,200,340 bytes；`escope.exe` 14,565,376 bytes；SHA-256 `F7391903508331752D5590F98FBEA2AC0B951A9EFBB24099E8CDA07D33CB62C2`（仅历史，已被 22:03:35 版本取代，见 [索引多标签](results-and-workspace.md)） |
| 授权模型实网 | 本轮未重跑 |

历史（不作本轮证据）：测试端点 `http://127.0.0.1:8788/v1`、模型 `glm-5.3-flash`；无认证列表探测返回 HTTP 401；
前会话隐藏输入脚本完成模型列表、完整生成、多轮回忆与首 delta 取消，约 8.79 秒。本轮未读取/输出该密钥。
审计：生产依赖 0、开发工具链 5 high 为上一轮结果。
特有待验：真实流、取消、模型加载耗时与服务差异。
