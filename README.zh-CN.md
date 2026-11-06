<div align="center">

<img src="public/icon.svg" width="112" height="112" alt="EScope 应用图标" />

# EScope

**一个简单、顺手、开箱即用的开源 Elasticsearch 查询工具。**

[English](README.md) · [**简体中文**](README.zh-CN.md)

<p>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" height="20" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19" height="20" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" height="20" /></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-1.85+-orange?logo=rust&logoColor=white" alt="Rust 1.85+" height="20" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS-4.x-38B2AC?logo=tailwind-css&logoColor=white" alt="Tailwind CSS 4" height="20" /></a>
  <a href="#平台支持"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" height="20" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" height="20" /></a>
</p>

</div>

---

EScope 是一个轻量的 Elasticsearch 桌面客户端，围绕日常查询流程设计：连接集群、编写并执行 DSL、查看和筛选命中结果、快速做一次聚合或图表、导出需要的数据——不需要为此启动一套完整的可观测性平台。

它**不是** Kibana 的替代品，也不是 Dashboard 搭建器或完整的集群管理套件。EScope 只把“连上、查清、拿走”这条日常链路做得更快、更清楚、更顺手。

> **项目状态：** 早期开发（`0.1.0`）。查询工作流已经可用，但 API、存储 schema 和界面细节仍可能调整。当前版本为**只读**——不会写入文档、Mapping 或集群设置。

## 为什么选择 EScope

- **打开快，查询也快。** 原生 Tauri 外壳、本地 Monaco 编辑器和紧凑的工作区，把“启动到看到结果”的路径缩到最短。
- **本地优先。** 连接元数据、查询定义和工作区状态保存在本地 SQLite；凭据不会交给前端，也不会上传到云端。
- **精确呈现，不粉饰结果。** 原始 JSON token、缺失值、部分分页和近似统计信息保持可见，而不是被悄悄归一化。
- **围绕查询闭环设计。** 多标签、PIT 分页、单元格筛选、聚合、图表和导出彼此配合，而不是分散的管理页面。

## 功能

| 模块 | 可以做什么 |
| --- | --- |
| **连接** | 管理多个集群，支持 Basic Auth、API Key、Bearer Token；绑定自定义公共 CA；测试身份并查看集群、版本与许可证据。 |
| **查询** | 使用 Monaco 编辑原始 JSON DSL（本地 worker、语法高亮、格式化、撤销/重做）；用可视化构建器处理常见查询；多标签并行查询不同目标。 |
| **翻页** | 在支持的集群上使用 Point-in-Time（PIT）游标稳定翻页；关闭标签时取消请求并清理 PIT。 |
| **结果** | 在虚拟化表格中查看命中：列宽、拖拽换序、显隐、已加载行的精确排序与持久行选择；也可切换原始 JSON 或结构化文档视图。 |
| **筛选** | 从单元格生成 term/短语条件，组合 AND/OR 布尔组，添加显式 nested 条件，逐条启停待应用条件，并复用固定筛选组。 |
| **文档** | 打开分页的 JSON Pointer 结构化详情；对比同一次执行中的两条命中，元数据、`_source`、`fields` 与 runtime 值分开呈现。 |
| **聚合** | 查看单值指标以及单层 `terms` / `date_histogram` 桶；绘制条形图或折线图，不补造缺失桶。 |
| **数据视图** | 将索引模式、别名和数据流保存为本地视图；应用数字、百分比、IEC 字节和 UTC 日期的显示格式；定义有界 runtime fields。 |
| **集群洞察** | 只读查看集群健康、节点、分片、索引与 Mapping；检查字段能力与权限诊断，不触发写操作。 |
| **查询资产** | 保存带参数模板的查询，浏览有界执行历史，恢复上次工作区，并以本地 JSON 文件交换查询定义。 |
| **导出** | 将已加载结果复制为 CSV/JSONL，或使用独立的有界 PIT 扫描执行全量导出，明确展示目标、DSL 与行数/文件限额。 |
| **桌面体验** | 明暗主题、四种强调色、密度与字体控制、中英文界面、键盘优先的对话框，以及与顶栏融合的原生窗口控制。 |

## 快速开始

### 前置环境

| 依赖 | 版本 / 说明 |
| --- | --- |
| Node.js | `20.19+`（或 `22.12+`）及 npm |
| Rust | `1.85+`，建议通过 `rustup` 安装 |
| Windows | MSVC 构建工具与 WebView2 运行时 |
| macOS | Xcode Command Line Tools |
| Linux | `libwebkit2gtk-4.1-dev`、`build-essential`、`curl`、`wget`、`file`、`libxdo-dev`、`libssl-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` |

### 从源码运行

```sh
git clone https://github.com/algerkong/Escope.git
cd EScope
npm ci
npm run tauri -- dev
```

只想快速看看界面，不启动桌面外壳：

```sh
npm run dev
```

然后访问 `http://127.0.0.1:1420`。浏览器预览使用**内存会话**：刷新即丢失更改，真实凭据存储、系统密钥库和本地持久化需要在桌面端运行。

### 构建

```sh
# 桌面可执行文件
npm run build:desktop

# Windows NSIS 安装包（未签名，当前用户安装）
npm run build:installer:windows
```

产物位于 `src-tauri/target/release/`（Windows 下为 `escope.exe`）以及 `src-tauri/target/release/bundle/nsis/`。

## 技术架构

```text
┌─────────────────────────────────────────────────────────────┐
│                        EScope Desktop                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        ▼                                             ▼
┌─────────────────────────────┐       ┌─────────────────────────────┐
│        前端（Web UI）        │  IPC  │        后端（原生）          │
│                             │ ◄───► │                             │
│ • React 19 + TypeScript     │       │ • Tauri 2 + Rust            │
│ • Vite + Tailwind CSS 4     │       │ • SQLite（rusqlite）         │
│ • Monaco Editor（本地）      │       │ • 系统密钥库（凭据）          │
│ • TanStack Table + Virtual  │       │ • reqwest + rustls（ES/TLS） │
│ • dnd-kit + Lucide + Visx   │       │ • 受限的类型化 IPC            │
└─────────────────────────────┘       └─────────────────────────────┘
```

- **桌面端：** [Tauri 2](https://tauri.app/) 与 Rust、`rusqlite`、`keyring-rs`、`reqwest`/`rustls`。
- **前端：** [React 19](https://react.dev/)、[TypeScript](https://www.typescriptlang.org/)、[Tailwind CSS 4](https://tailwindcss.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[TanStack Table](https://tanstack.com/table)、[TanStack Virtual](https://tanstack.com/virtual)、[dnd-kit](https://dndkit.com/)、[Lucide](https://lucide.dev/) 与 [Visx](https://airbnb.io/visx/)。
- **存储：** 本地 SQLite 保存元数据、查询/图表定义、工作区恢复与历史；Basic/API Key/Bearer 秘密存于操作系统凭据库。
- **IPC：** 只暴露类型化 Tauri 命令，不提供任意 URL、方法或请求头代理；未知操作直接拒绝。

## 平台支持

| 平台 | 状态 |
| --- | --- |
| **Windows 10/11** | 主要开发目标。自定义窗口控制、Windows 凭据库集成和 NSIS 安装包已接入。 |
| **macOS** | 构建配置与原生交通灯 overlay 已存在；真机窗口、密钥库和签名验收仍待完成。 |
| **Linux** | Tauri 依赖与构建路径已配置；原生验证和密钥库集成仍待完成。 |

凭据存储使用构建实际支持的操作系统密钥库。目前为 Windows 凭据库；macOS/Linux 暂不支持带凭据的连接，仅元数据连接仍可使用。

### Elasticsearch 兼容性

EScope 以 Elasticsearch **7.10+** 作为 PIT 分页和全量导出的目标版本，当前人工基线为 **7.17.25**。8.x 与 9.x 的兼容性仍在验证中；不要仅凭版本号推断全部功能可用。身份、权限和许可信息始终从集群读取，而不是按版本猜测。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 1420 端口的 Vite 预览 |
| `npm run build` | 类型检查并构建生产前端 |
| `npm test` | 运行 Vitest 单元与组件测试 |
| `npm run check` | Lint、类型检查、构建并运行两套前端测试 |
| `npm run test:rust` | 运行 Rust 后端测试 |
| `npm run build:desktop` | 构建原生 Release 可执行文件（不含安装包） |
| `npm run build:installer:windows` | 构建未签名的 Windows NSIS 安装包 |
| `npm run build:prototype` | 构建独立可视化原型 |
| `npm run test:prototype` | 运行原型回归测试 |
| `node scripts/generate-icon.mjs` | 由 `src-tauri/icons/icon.svg` 与 `icon-macos.svg` 重新生成桌面图标 |

## 目录结构

```text
src/
  app/          应用外壳、设置与路由
  features/     查询工作台、连接、集群视图与对话框
  components/   共享控件与窗口外观
  domain/       纯领域模型、校验与契约
  services/     类型化 IPC 与本地存储适配
  locales/      中英文界面文案
  styles/       设计 token 与功能样式
src-tauri/
  src/          Rust 后端、SQLite、凭据与 Elasticsearch 客户端
  icons/        图标源文件（icon.svg、icon-macos.svg）与生成的桌面图标
docs/           设计、计划与详细验收记录
public/         静态资源与应用图标
```

## 文档

详细设计、任务记录和验收材料位于 [`docs/`](docs/)：

- [开发状态](docs/development-status.md) —— 已实现能力、限制与测试记录
- [开发计划](docs/development-plan.md) —— 交付阶段与当前主线
- [任务清单](docs/development-backlog.md) —— 任务、依赖与验收基准
- [平台设计](docs/platform-design.md) —— 产品边界与长期架构
- [设置与快捷键](docs/settings-and-shortcuts.md) —— 设置项、快捷键与平台行为
- [人工验收](docs/manual-acceptance.md) —— 原生布局、焦点、IME 与跨平台检查

## 安全与隐私

- **默认只读。** EScope 不提供文档、Mapping 或集群设置的写入能力；未知操作会被拒绝，而不是猜测执行。
- **秘密只进系统密钥库。** 明文密码和 Token 不写入前端、日志、导出文件或文档；请求时从不可变传输快照解析凭据。
- **始终保持 TLS 校验。** 支持自定义 CA，但不提供“跳过证书验证”开关。
- **元数据只存本地。** 连接、查询、图表与工作区状态保存于本地 SQLite；没有遥测、埋点或第三方上传。
- **有界 I/O。** 结果页、文档详情、对比、聚合、图表和导出均有明确的大小、深度和数量限制，超限整次拒绝而不是静默截断。

## 参与贡献

欢迎提交 Issue 和 Pull Request。为了便于审查：

1. 较大的改动请先开 Issue，确认范围和契约。
2. 保持改动聚焦，并遵循现有的 domain/IPC 边界。
3. 行为变更需要新增或更新测试，然后运行 `npm run check`；涉及 Rust 时再运行 `npm run test:rust`。
4. 不要提交凭据、真实客户数据、本机配置或构建产物。

项目由维护者在业余时间开发，响应时间可能不固定。

## 许可证

基于 [MIT License](LICENSE) 开源。
