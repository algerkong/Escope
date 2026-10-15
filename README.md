# EScope

<div align="center">

**本地优先的高性能现代化 Elasticsearch 桌面工作台与数据探索套件**  
*Local-First, Secure & Lightweight Elasticsearch Desktop Client & Workbench*

<p align="center">
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" height="20" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19" height="20" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" height="20" /></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-1.77+-orange?logo=rust&logoColor=white" alt="Rust" height="20" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS-4.x-38B2AC?logo=tailwind-css&logoColor=white" alt="Tailwind CSS 4" height="20" /></a>
  <a href="#-技术架构-tech-stack"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" height="20" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" height="20" /></a>
</p>

</div>

---

## 📖 简介 (Overview)

**EScope** 是一款为开发者、SRE 工程师与数据分析师打造的现代化、本地优先（Local-First）Elasticsearch 桌面客户端。

传统 Elasticsearch 管理工具通常面临资源占用高、缺乏离线能力、凭据明文存储、DSL 编写体验粗糙以及大结果集渲染卡顿等痛点。EScope 基于 **Tauri 2 + Rust + React 19** 构建，以原生级极速启动、毫秒级响应、严苛的本地隐私保护和媲美专业 IDE 的交互体验，重新定义 Elasticsearch 桌面工具的使用感受。

---

## ✨ 核心特性 (Key Features)

### 🛡️ 本地优先与凭据安全 (Local-First & Enterprise Security)
- **系统级密钥隔离**：敏感凭证（Basic 认证口令、API Key、Bearer Token）均通过操作系统原生密钥库（Windows Keyring、macOS Keychain、Linux Secret Service）安全存储，绝不明文落盘。
- **本地 SQLite 元数据驱动**：连接配置、查询收藏、执行历史与工作区状态持久化于本地 SQLite，无外部依赖，断网可用。
- **默认只读与写保护**：设计上严格推行安全只读与防御机制，拦截高危破坏性操作，写操作需经过前置审查。
- **零遥测与网络隔离**：不含任何第三方跟踪代码与遥测探针，数据不经过外部云服务，充分保障内网环境安全性。

### 🚀 专业多标签查询工作台 (Advanced Query Workbench)
- **Monaco Editor 深度融合**：内置轻量本地 Monaco 编辑器，支持语法着色、实时错误校验、无损格式化、撤销重做以及针对索引字段与参数占位符的智能词法补全。
- **双模式自由切换**：支持在直观的表单可视化构建器与原始 JSON DSL 之间平滑无损切换。
- **多会话标签隔离**：支持针对不同集群、不同索引并行开启独立查询与预览标签页，互不干扰，支持显式上下文锁定与后台请求主动取消。
- **PIT (Point-in-Time) 游标保障**：原生支持 Elasticsearch PIT 机制，大规模分页数据稳定一致。
- **高精度时间范围审核**：提供最近相对时间与绝对时间范围过滤，支持 UTC / IANA 时区与纳秒级时间解析，PIT 开启前客户端时钟严格冻结。

### 🔍 深度数据探索与交互分析 (Interactive Data Exploration)
- **超宽表虚拟化渲染**：结合 TanStack Table 与 TanStack Virtual，支持多达数十甚至上百列的平滑水平窗口化虚拟滚动；支持列宽自适应、拖拽调序与列配置持久化保存。
- **多维组合筛选系统**：
  - **单元格快捷筛选**：右键或点击单元格值快速生成精确 Term 或短语 Phrase 过滤条件；
  - **布尔条件编排**：最多支持 8 个独立的 AND / OR 布尔组条件编排；
  - **嵌套对象 (Nested) 筛选**：显式解析顶级 Nested 路径与对象内/父文档排除；
  - **条件逐条启停与会话基线绑定**：随时启停单条过滤条件，支持与基线 DSL 深度对比重构。
- **固定筛选规则库 (Pinned Filters)**：将常用的标量过滤、Nested 规则与 Runtime 字段筛选沉淀至本地库，跨会话快捷加载复用。
- **单文档结构化详情**：提供基于 JSON Pointer 路径快速导航、容器折叠以及原始 token 复制。
- **双文档无损对比**：原子级比较同一次执行中两条真实文档的元数据、`_source` 与 `fields` 差异。
- **即席基础聚合展示**：从执行结果中直接提取并展示常见单值指标（Sum、Avg、Min、Max、Cardinality 等）以及单层 Terms / Date Histogram 桶分布。

### 🌐 集群拓扑与环境诊断 (Cluster & Environment Diagnostics)
- **连接管理与 CA 证书**：支持多连接统一管理，提供 Basic / API Key / Bearer 鉴权，支持导入并绑定公共自定义 CA 根证书以满足企业级 TLS 安全需求。
- **只读集群观测**：实时查看集群健康级别、节点明细、分片（Shards）拓扑分布矩阵以及索引元数据与 Mapping 配置。
- **显式能力与权限探测**：只读探测当前身份的角色权限（Monitor, Read, View Index Metadata）与服务端版本、部署类型、Serverless 标记及许可证能力。

### 📐 本地数据视图与字段增强 (Data Views & Field Formats)
- **Data Views**：支持本地创建并管理包含通配符索引模式、别名与数据流的数据视图，关联默认时间字段。
- **安全字段格式化**：纯前端白名单展示格式化（千分位数字分组、百分比、IEC 存储字节单位、标准 UTC 日期转换），始终保留原始值并支持一键还原。
- **运行时字段 (Runtime Fields)**：支持在查询时定义 keyword/numeric/date/boolean/ip/geo_point 等类型的运行时字段，支持同名 `_source` 映射或内联 Painless 脚本。

### 💾 查询资产与全量导出 (Asset Exchange & Export)
- **查询定义与参数模板交换**：支持参数化模板（`{"$param": "field_name"}`）定义，可在不同环境间安全导出与导入 JSON 格式查询定义，敏感凭证严格脱敏。
- **结果就地导出**：已加载的数据行可直接导出为 CSV 或 JSONL，内建针对 CSV 公式注入攻击的防御机制。
- **基于 PIT 的全量流式导出**：支持后台任务级流式全量导出，受控扫描配额预算，原生临时文件写入完成后原子替换，保证数据完整性。

### 🤖 隐私受控 AI 助手 (Privacy-First AI Assistant)
- **通用模型协议兼容**：支持自定义 OpenAI Chat Completions 协议接口以及本地 Ollama 实例。
- **严格最小权限**：仅在用户显式发送时携带当前查询 DSL 快照，不自动偷传检索结果与集群敏感数据，绝不自动越权执行查询。

### 🎨 极致桌面端工艺 (Refined Desktop Experience)
- **融合式原生顶栏**：深度融合标题栏与应用 Header，macOS 端原生呈现交通灯控件，Windows 与 Linux 端采用原生契合的定制化窗口控制。
- **精细视觉主题**：精心设计的明亮（Light）与暗色（Dark）主题，提供 4 种强调色选择，支持界面排版间距与字体微调。
- **完整双语支持**：中文与英文全界面无缝切换，包含完整的可访问性（a11y）标签支持。

---

## 🛠️ 技术架构 (Tech Stack)

```
┌─────────────────────────────────────────────────────────────┐
│                       EScope Desktop                        │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ┌───────────────────────┴───────────────────────┐
       ▼                                               ▼
┌─────────────────────────────┐         ┌─────────────────────────────┐
│     Frontend (UI/Web)       │  IPC    │      Backend (Native)       │
│                             │ ◄─────► │                             │
│ • React 19 + TypeScript     │(Typed)  │ • Tauri 2 Core              │
│ • Vite + Tailwind CSS 4     │         │ • Rust Core                 │
│ • Monaco Editor (Local)     │         │ • Rusqlite (Local SQLite)   │
│ • TanStack Table & Virtual  │         │ • OS Keyring (Credentials)  │
│ • dnd-kit & Lucide Icons    │         │ • Reqwest (ES Client / TLS) │
└─────────────────────────────┘         └─────────────────────────────┘
```

- **桌面运行时**：[Tauri 2](https://tauri.app/) (Rust 驱动，微型体积，极低内存消耗)
- **用户界面**：[React 19](https://react.dev/), [TypeScript 5](https://www.typescriptlang.org/), [Tailwind CSS 4](https://tailwindcss.com/)
- **核心组件**：
  - 查询编辑器：[Monaco Editor](https://microsoft.github.io/monaco-editor/)（本地 Worker 加载，无外部 Schema 依赖）
  - 表格与虚拟化：[@tanstack/react-table](https://tanstack.com/table) + [@tanstack/react-virtual](https://tanstack.com/virtual)
  - 拖拽排布：[@dnd-kit](https://dndkit.com/)
  - 图标体系：[Lucide React](https://lucide.dev/)
- **本地存储与安全**：[Rusqlite (SQLite v10)](https://github.com/rusqlite/rusqlite), [Keyring-rs](https://github.com/hwchen/keyring-rs)

两条历史 v9 分支的图表库均可升级到 v10，原定义与修订号保留。统一入口支持图表定义保存、
复用和本地交换，旧库单独可见，不自动转换或执行；详见 [分支合并验收](docs/main-dev-merge-qa.md)。

---

## 🚀 快速开始 (Getting Started)

### 前置环境 (Prerequisites)
1. **Node.js**: `>= 20.x` 及 npm
2. **Rust**: `>= 1.77`（桌面运行与构建所需，推荐使用 `rustup` 安装）
3. **平台依赖**：
   - **Windows**: Microsoft Visual Studio C++ 生成工具 (MSVC) 及 [WebView2 运行时](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
   - **macOS**: Xcode 命令行工具
   - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`

### 安装与运行 (Run & Development)

1. **克隆仓库与安装依赖**：
   ```sh
   git clone git@github.com:algerkong/Escope.git
   cd EScope
   npm ci
   ```

2. **以浏览器会话模式启动（轻量快速体验）**：
   ```sh
   npm run dev
   ```
   启动后访问 `http://127.0.0.1:1420`。  
   *注：浏览器模式为内存会话隔离模式，刷新后会话重置，真实生产凭证需在桌面端配合系统密钥库运行。*

3. **以 Tauri 桌面应用启动（完整原生体验）**：
   ```sh
   npm run tauri -- dev
   ```

---

## 📦 打包与构建 (Packaging & Building)

### 构建桌面可执行文件
```sh
npm run build:desktop
```
构建产物输出位于：`src-tauri/target/release/escope.exe`（Windows）或对应平台二进制文件。

### 构建 Windows NSIS 安装程序包
```sh
npm run build:installer:windows
```
产物输出位于：`src-tauri/target/release/bundle/nsis/`。

---

## 🧪 常用命令与质量检查 (Scripts & QA)

| 命令 | 描述 |
| :--- | :--- |
| `npm run dev` | 启动前端 Vite 开发服务器 (1420 端口) |
| `npm run build` | 构建正式生产前端产物 |
| `npm test` | 执行 Vitest 前端单元与组件测试 |
| `npm run check` | 执行全套前端质检（ESLint、TypeScript 类型检查、构建验证、前后端测试） |
| `npm run test:rust` | 执行后端 Rust 核心测试套件 |
| `npm run build:desktop` | 构建原生桌面 Release 可执行文件 |
| `npm run build:installer:windows` | 构建 Windows NSIS 安装包 |
| `npm run build:prototype` | 构建独立离线原型 |
| `npm run test:prototype` | 针对离线原型运行回归测试 |

---

## 📚 文档索引 (Documentation)

项目包含完善的架构设计、任务追踪与技术规约文档，均收录在 [`docs/`](docs/) 目录中：

| 模块 | 文档链接 | 说明 |
| :--- | :--- | :--- |
| **开发状态与任务** | [开发状态与能力记录](docs/development-status.md) | **原 README 迁移文档**：包含详细能力清单、限额、开发主线与批次跑分记录 |
| **分步执行计划** | [开发执行计划](docs/development-plan.md) | 包含各交付阶段、执行主线与具体实现边界 |
| **任务 Backlog** | [开发任务清单](docs/development-backlog.md) | 完整功能 Backlog、依赖拓扑与验收基准 |
| **协作规范** | [连续开发与交接指南](docs/continuous-development.md) | 自动化验收流水线、会话交接与无干扰开发规范 |
| **平台全景设计** | [平台设计方案](docs/platform-design.md) | 系统总体架构设计、权限模型与长远路线图 |
| **产品与执行契约** | [产品设计契约](docs/product-design.md) | 查询语义、结果处理契约与执行规范 |
| **交互与快捷键** | [设置与快捷键指南](docs/settings-and-shortcuts.md) | 详细设置项、键盘快捷操作与平台细节 |
| **设计语言** | [视觉与竞品设计](docs/competitive-and-visual-design.md) | 界面排版、设计 Token、竞品对比分析 |
| **人工验收规约** | [人工验收清单](docs/manual-acceptance.md) | 界面、平台集成与跨系统人工核查标准 |

---

## 🔒 安全与隐私原则 (Security Principles)

1. **凭证绝不明文落地**：任何连接密码、私有 Token 均必须经过操作系统级别密钥链存储，防止配置文件泄露导致安全隐患。
2. **默认只读，破坏性防护**：杜绝误操作删库风险，查询与探索默认置于严格受保护的只读上下文中。
3. **零外部数据依赖**：除用户明确配置的 Elasticsearch 实例与 AI 接口外，应用不向任何第三方发起网络请求。

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 授权许可。
