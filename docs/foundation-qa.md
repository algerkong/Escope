# 正式工程首轮验收

日期：2026-09-30。平台：当前 Windows 主机。范围：工程、交互、无认证连接元信息与 SQLite 首个子集。
不是 ES 查询版或完整管理平台验收。

## 实现范围

| 子项 | 实现位置 | 状态 |
| --- | --- | --- |
| F01.1 | 根目录工具链、`src/`、`src-tauri/` | 正式前端、Rust、Windows exe 构建；原型保持独立 |
| F01.2 | `tests/unit/`、Rust 模块测试、`.github/workflows/checks.yml` | 本机质量门禁通过；远端 CI 未运行 |
| F05.1 | `src/domain/query.ts`、`src/services/ipc.ts` | 草稿/不可变快照、原始数值文本、旧响应/跨连接/取消状态规则；真实请求取消尚未接入 |
| F03.1 | `src/styles/`、`src/locales/`、`PreferencesPanel.tsx` | token、字体、本地资源、语言、主题、偏好验证与局部重置 |
| F02.1/F02a | `src/app/`、`QueryWorkspace.tsx` | 查询首页、固定设置导航、六个右侧管理路由、草稿保持 |
| F02b.1 | `connection.ts`、`storage.ts` | 稳定 ID、零/单/多、名称无关、顺序、失效/删除回退 |
| F04.1/F09.1 | `CommandPalette.tsx`、组件测试 | 基础快捷键、IME、模态优先级、焦点恢复、显式 session adapter |
| F07.1/C05.1 | `src-tauri/src/storage.rs`、迁移 001 | SQLite 偏好/选择/无认证元信息 CRUD；不接受凭证 |
| F06.1 | `operation.rs`、CSP/capabilities | 未知/写操作拒绝；没有任意网络代理；尚未实现实际 ES 端点授权 |

F07.1/C05.1 是在无认证元信息范围推进的存储子项，不表示 F08 密钥库或完整 C05 已验收。
生产应用没有演示连接，浏览器 preview 是显式内存会话，不是桌面失败降级。

## 本机检查

- `npm run check`：ESLint、TypeScript strict、Vite 构建通过；正式测试 45 项，原型测试 16 项通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：7 项通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`：交付前检查格式。
- `npm audit`：升级 Vitest 至 4.1.11 后无已知依赖漏洞；生产依赖审计也为 0。
- `npm run build:desktop`：Windows release exe 构建成功，约 10.8 MB；无安装包、无签名。
- 实际启动该 exe：进程存在，窗口标题 `EScope`，非零窗口句柄，`Responding=True`；
  应用数据目录生成 20 KB SQLite 文件。此证据只确认窗口与数据库创建，**不等于桌面内全部 IPC/交互已实测**。
- 当前运行工具链：Node 24.9.0、Rust 1.93.1、Vite 7.3.6、Tauri 2.12.0；
  WebView2 153.0.4234.19、Windows SDK 10.0.26100.0。

## 真实浏览器

使用 Codex 内置浏览器检查正式 Vite 应用，入口 `http://127.0.0.1:1420`。
原型的 `file://` 地址被浏览器工具安全策略阻止，没有通过换协议/浏览器绕过；原型 D01 完整验收仍保留。
正式页面是独立开发入口，不把正式页面检查替代原型 D01。

- 1440×900：查询首页、设置、六个右侧路由、无连接、命令面板。
- 1024×700：英文、夜间、20px 字号、紧凑密度；可滚动到全部设置。
- 390×844：英文 20px；页面没有横向溢出，导航文字没有溢出。
- 2 外观 × 4 强调色 × 2 语言共 16 种切换：根语言/token 正确，草稿文本保留，无页面横向溢出。
- 配置保存/编辑：仅在显式浏览器 session 中使用 `qa.example.test` 测试元信息，显示“未测试”；
  未发送 ES 请求；完成后刷新清除本轮临时配置。
- 设置返回：保留 `9007199254740993` 原始 DSL 文本，焦点返回编辑器。
- 命令面板：搜索/空结果/键盘进入/关闭；Esc 只关闭浮层，焦点恢复到入口。
- 发现并修复：没有 Radix Trigger 时的焦点丢失、大字号导航溢出、连接切换失败重试误操作偏好、
  启动默认视图提前影响新标签、根模块 HMR 重复创建 React root。
- HMR 修复后替换入口模块：采集 6 个控制台事件，没有新增 exception/error。

截图与机器记录位于 `docs/evidence/2026-09-30/`：

- `query-desktop.png`
- `settings-general-desktop.png`
- `typography-1024-english-20px.png`
- `settings-mobile-english-20px.png`
- `command-palette.png`
- `theme-matrix.json`、`mobile-layout.json`、`hmr-check.json`

浏览器当前缩放曾为 130%，设置工具的物理尺寸不等于 CSS 尺寸。
验收采用实际读取的 `innerWidth/innerHeight`，截图像素尺寸可能更大。
未完成全量控件对比度数值审计、200% 系统缩放、原生 IME、屏幕阅读器和其他平台 WebView。
主题组合切换正确不等于所有颜色状态都已达到 WCAG 验收。

## ES 环境

用户授权的安装目录：`D:\es\elasticsearch-7.17.25`。
只读取了非敏感配置键：HTTP `127.0.0.1:9200`、single-node、认证关闭。
检查时 9200 未监听；本轮没有启动服务、请求集群、读取真实文档或修改索引。
后续先以该实例完成无认证只读连接测试；不得操作已有业务数据。
需要 fixture 时使用独立资源范围并按任务安全边界执行，不能将已有索引当成可删除样本。

## 交接限制

1. 当前查询执行、可视化构建、资源发现、模型网络调用均未实现，相关控件明确不可用。
2. 凭证库未接入，连接只支持无认证元信息；不能把地址中的认证秘密当替代方案。
3. 查询草稿在视图往返中保留，但尚未持久化到桌面重启。
4. SQLite 首个 schema 通过事务/坏配置/未知版本/只读失败测试；尚无历史配额、备份恢复、后续版本升级演练。
5. 默认只读当前依靠不暴露网络写入口与拒绝未知命令；接入网络时必须补齐方法、路径、资源和实际权限校验。
6. CI 只是已提交的配置；无远程仓库，不能称三平台通过。
7. Git 使用本机已有身份、`main`、LF 规则，原型基线与本轮开发分提交；没有推送或创建远程仓库。
