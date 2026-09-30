# EScope

本地优先的 Elasticsearch 工作台，正式工程使用 React / TypeScript / Vite / Tauri 2 / Rust。

## 运行正式应用

```sh
npm ci
npm run dev
```

浏览器访问 `http://127.0.0.1:1420`。浏览器模式明确标记“仅本次会话”，
连接元信息与设置只保留在内存中，刷新即清除；不会在桌面存储失败时自动降级到此模式。

```sh
npm run tauri -- dev
npm run build:desktop
npm run build:installer:windows
```

`tauri dev` 自行启动 1420 端口的 Vite；已有同端口开发服务器时先关闭该服务器。
独立浏览器预览可用 `npm run dev -- --port 1421`。
Windows 产物在 `src-tauri/target/release/escope.exe`，是未签名的内部开发构建，不是安装包。
桌面运行需要 WebView2；编译需要 Rust/MSVC 和 Windows SDK。

`build:installer:windows` 使用锁定的 Tauri CLI 和 `src-tauri/tauri.windows.conf.json` 生成
NSIS 安装包，输出至 `src-tauri/target/release/bundle/nsis/`。
当前为当前用户级安装；缺少 WebView2 时下载官方引导程序，因此首次安装可能需要联网。
没有配置签名证书，安装包与应用均为 **unsigned（未签名）**，Windows 可能提示未知发布者。
本命令只构建，不自动安装或启动；安装/升级/卸载与 macOS/Linux 打包分别验收。
复现构建使用 `npm ci` 和仓库中的 `package-lock.json`、`src-tauri/Cargo.lock`，
不依赖全局 NSIS 或手工更改用户数据库。构建成功不代表原生安装已通过。

### 当前正式能力

- 查询工作台、独立查询草稿与标签、结果视图状态、默认收起的 AI 面板。
- 融合式桌面顶栏：Windows/Linux 自定义窗口控制，macOS 原生交通灯 overlay，与现有 header 同层。
  浏览器不模拟窗口按钮；各平台的原生拖拽、缩放和交通灯对齐仍待人工验收。
- 查询 DSL 本地 JSON 校验、无损格式化与撤销格式化；重复键拒绝、错误行列提示，
  长整数/小数/转义不经数值重序列化。校验成功只表示 JSON 合法，不代表查询已执行或 ES 授权。
- 源码已接入无认证 ES 索引/字段/Mapping 读取、快照查询/取消、部分结果与无损表格/JSON/文档详情；
  命令面板可执行当前查询，设置/语言变化不执行查询。仍无 PIT/search_after、收藏与导出。
- 设置健康/节点/分片/索引只读页面已接受限 IPC，无自动轮询；真实桌面与完整 ES 联调待验。
- 设置固定左侧导航，连接/模型/集群/节点/分片/索引在右侧切换，返回不丢草稿。
- 系统/日夜、四种强调色、中英文、独立字号/字体/密度、局部重置、启动偏好。
- 快速跳转、命令面板、键盘导航、IME 保护、对话框焦点与未保存草稿关闭确认。
- 无认证连接的元信息添加、编辑、删除、稳定 ID、顺序、选择与回退。
- 桌面 SQLite 保存偏好、连接元信息和选中 ID；修复 `startAI` 大小写合同，兼容历史 `startAi`，
  偏好保存错误使用可重试/关闭的对话框。schema v3 添加模型元信息表，但模型应用入口尚未接入。
- 后端与类型化 IPC 已支持保存连接 ID 的无认证根身份测试：固定 GET、禁止重定向与环境代理、
  超时/并发/响应大小限制、错误脱敏。设置右侧已接入手动测试、身份展示与过期响应隔离，
  浏览器会话适配不测试连接；真实桌面 UI 验收待用户统一执行。
- Rust 系统密钥库适配首个子项（F08.1）：Windows keyring 后端、秘密清理、固定命名空间和脱敏错误；
  schema v2 加入凭证引用与持久清理队列，Rust 内部已有保存/轮换/解绑/删除与失败恢复编排。
  尚未开放秘密 IPC 或认证表单；旧元信息入口拒绝已绑定凭证的行。macOS/Linux 密钥库仍明确不可用。
- 无默认演示连接，不伪造统计、查询结果或模型响应。

**尚未接入：可视化编辑/PIT/导出、凭证生命周期的 IPC/UI、认证网络、模型配置应用入口/协议和写入管理。**
连接保存不等于连通；本版本不接受认证秘密，查询草稿暂不跨应用重启保存。
模型独立组件/存储代码尚待审查与集成，不视为可用模型功能。最新阶段性状态见
[第三批记录](docs/feedback-batch-qa.md)。schema v3 升级后不能直接使用只识别 v2 的旧版应用打开。

## 质量检查

```sh
npm run check
npm run test:rust
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

`check` 包括 lint、TypeScript strict、正式构建、正式单元/组件测试和原型构建/回归。
按用户本轮要求，开发中只运行自动化并审查代码，不反复启动浏览器巡检；
功能开发后统一执行 [人工验收清单](docs/manual-acceptance.md)。未人工验证的 UI/系统集成不标通过。
底座历史截图与限制见 [正式应用验收记录](docs/foundation-qa.md)，
本轮 F06.2/C01.1 命令、真实服务证据与未验证边界见 [只读连接验收](docs/connection-qa.md)。
Git 使用 `main` 和现有身份；用户指定远程 `git@github.com:algerkong/Escope.git`。
CI 配置和推送不代表远端检查已通过。

## 本机 ES 测试环境

用户指定 `D:\es\elasticsearch-7.17.25`，首批真实测试版本锁定为 **7.17.25**。
配置读取确认绑定 `127.0.0.1:9200`、单节点、关闭认证；2026-09-30 用户启动后根身份测试通过。
仅请求 `GET /`，未读取业务文档、修改现有索引/数据或服务配置。
本机 HTTP_PROXY 可能导致回环请求走代理报 502；Rust 客户端显式禁用环境代理。
手工 PowerShell 诊断使用 `Invoke-RestMethod http://127.0.0.1:9200 -NoProxy`，
curl 使用 `curl.exe --noproxy 127.0.0.1,localhost http://127.0.0.1:9200/`。

显式授权的真实测试（只用于上述本机实例；默认 Rust 测试会忽略此用例）：

```powershell
$env:ESCOPE_TEST_ES_71725 = '1'
cargo test --manifest-path src-tauri/Cargo.toml --locked local_elasticsearch_71725_read_only_identity -- --ignored
```

8.x/9.x 支持仍需独立联调，不能从当前基线推断。

## 查看原型

```sh
npm install
npm run build:prototype
npm run test:prototype
```

使用浏览器打开 `docs/theme-preview.html`。构建后的 Tailwind 与图标位于本机，不需要 CDN。
无需开发服务器。使用 Ctrl+P / Ctrl+Shift+P / Ctrl+, 打开跳转、命令和设置；
浏览器保留快捷键时使用顶部图标入口。macOS 使用 Cmd。

## 原型可交互内容

- 集群概览、固定健康快照、磁盘指标、未分配副本诊断。
- 节点过滤与详情、分片矩阵/列表与详情、索引筛选与 Mapping/Settings。
- 已有查询展示、表格/JSON、可视化/DSL 切换。
- 模型协议与手填模型 ID、元信息本地保存、手动选择与移除。
- 连接配置草稿、名称编辑、认证类型与环境选择，不保存认证密钥。
- 工作区恢复上次选中连接，无有效记录默认第一项；多连接右上角/设置选择，单连接隐藏选择器。
- 日夜/主题色、中英文、字体字号、密度、设置与命令面板。

全部集群数据是固定演示数据；指标不是实时监控，没有后台采集。
模型与连接目录是本地元信息原型，未实现协议调用、连接测试、认证、写入或 Tauri 桌面包。
未选择的协议只表示配置项，不代表已支持该提供方真实接入。
原型使用浏览器 localStorage，不用于保存密钥；生产版需要后端系统密钥库与权限隔离。

## 设计

- `docs/development-plan.md`：当前执行入口，包含已核对的工程基线、分步交付与首轮开发清单。
- `docs/platform-design.md`：完整平台范围、权限、监控、多模型与阶段计划。
- `docs/settings-and-shortcuts.md`：设置、排版、快捷操作。
- `docs/competitive-and-visual-design.md`：竞品与视觉系统。
- `docs/prototype-qa.md`：原型检查结果、修复与待验收项。
- `docs/development-backlog.md`：详细开发任务、依赖、阶段与验收标准。

## 开发状态

开发前阅读根目录 `AGENTS.md`；每次开发后同步更新其中的交接状态、任务进度与验证结果。

当前已加入融合标题栏、JSON 编辑辅助、凭据引用/生命周期后端；完整父任务仍开放。
用户要求本轮停止新增开发并提交当前状态。下一次先收口模型配置审查/入口和真实只读联调、
NSIS 构建，再推进携带清理状态的凭证 IPC、认证网络、AI 与受控管理。
OMP 的分批任务、文件所有权和全部 backlog 推进顺序见 `docs/development-plan.md` 第 9 节。
不将演示数据迁入正式默认工作区，也不把根身份成功当成搜索权限或健康状态证明。

## 验证

`npm run test:prototype` 使用 JSDOM 验证页面跳转、资源筛选、详情、模型配置、输入安全、
连接草稿、排版、国际化和命令面板。它不替代真实浏览器的布局、焦点锁定和键盘兼容测试。
默认进入查询工作台；连接、模型、集群、节点、分片和索引直接显示在设置右侧，不打开独立配置窗口。
查询页支持内置样本的状态/金额筛选、执行、重置和空结果，DSL 是本次执行的只读预览。
2026-09-30 重新验证：16 项自动化测试通过，覆盖 16 种主题/语言状态组合；
原型构建成功，真实浏览器与三平台视觉验收尚未完成。
