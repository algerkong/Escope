# 无认证只读连接子项验收

日期：2026-09-30。平台：当前 Windows 主机。范围：F06.2/C01.1 后端与类型化 IPC。
收尾上轮未提交的网络改动并补回归；不是完整连接向导、查询版、F06/C01/C02 父任务验收。

## C01.2 本轮续交付（OMP）

本节为同日最新结果，下文保留 F06.2/C01.1 历史记录。下文“UI 尚未接入”仅描述当时状态。

- 接手时已有未提交的测试按钮、身份展示、App 生命周期/跨连接状态与 14 项连接测试；
  保留这些代码、截图和浏览器探针，不把它们算成本轮重新实现。
- OMP-A 审查并补 5 项回归：未测试连接失效不产生虚假状态、主题切换不请求、
  删除后迟到失败、在途改地址拒绝旧响应、未知错误与 UTC 显示。
- 审查发现非结构化连接异常误报 SQLite 失败，增加 `errorCode(error, fallback)`，
  连接测试显式使用 `unexpected`；存储调用默认行为不变。再补连接 2 项、IPC 2 项回归。
- 连接生命周期覆盖 requestId/connectionId/endpoint 绑定、重复抑制、重测、卸载、
  删除、编辑成功/失败、设置往返与语言/主题变化。身份成功不代表搜索授权。
- 本轮不改布局，不启动浏览器、Vite、WebView 或 ES；真实后端取消仍未实现。

主代理独立执行：

| 命令 | 本轮实际结果 |
| --- | --- |
| `npm run check` | lint、类型、正式/原型构建通过；正式 74 项、原型 16 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 含 F08.1：29 项通过、2 项忽略（真实 ES / Windows 密钥库） |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 通过 |
| `git diff --check` | 通过 |

正式测试合计以主代理完整输出为准：连接 21、IPC 8，加其他原有测试共 74。
OMP 续跑报告内把定向总数 29 的分项 IPC 误写为 10，未采纳该分项数字。
UI/原生快捷键/缩放/真实桌面 IPC 留至 [集中人工验收](manual-acceptance.md)，没有新截图。
新凭证模块详情见 [F08.1 验收](credentials-qa.md)。

OMP 本轮两个前端 relay 均 `completed` / exit 0；会话
`01a0f13f-c16d-7000-8f18-dc902cb9d844`。
本机归档根 `C:/Users/Administrator/AppData/Local/Temp/delegate-relay/`，
初轮 `EScope-2026-09-30T07-37-59-562Z`，审查续跑 `EScope-2026-09-30T07-46-44-111Z`。
归档仅用于本机追溯，测试成功以独立执行结果为准；不提交或公开日志。

## 实现范围

| 位置 | 本次能力 |
| --- | --- |
| `src-tauri/src/operation.rs` | 仅注册 `connection.test`；固定 GET 已保存基础路径的根端点，无请求体；未知/写/查询操作拒绝 |
| `src-tauri/src/storage.rs` | 按稳定 ID 读取已校验的保存配置，返回独立快照，不更改当前选中项 |
| `src-tauri/src/connection.rs` | 无认证 HTTP/HTTPS 客户端、身份响应解析、请求与连接 ID 绑定 |
| `src-tauri/src/lib.rs` | `connection_test` 命令先查 SQLite；网络 await 前释放数据库锁，不接收 URL/方法/认证头 |
| `src/services/ipc.ts` | `testConnection` 只传 ID，捕获调用时身份并校验响应归属；浏览器拒绝，不自动重试或回退 |
| `src/locales/` | 双语诊断错误；服务端 403 使用 `serverForbidden`，与本地只读 `permissionDenied` 分开 |

边界：禁重定向、不发送 Referer、不继承环境代理、不支持认证秘密；默认 TLS 校验未关闭。
客户端最多 4 个并发，连接超时 3 秒、请求总超时 10 秒，响应最大 1 MiB，
不依赖 Content-Length 才执行大小检查。未知版本不声称已验证；仅 7.17.25 标记已测试。
错误不回传 reqwest 原始信息、响应体或认证内容。根身份无权限不等于没有索引搜索权限。

设置 UI 尚未调用该服务；原有测试按钮仍不可用。打开设置、切换连接、修改偏好不会自动探测。
没有改动页面布局或连接控件；浏览器基础回归见下文，新的诊断错误词条还须随 C01.2 做真实界面验收。

## 本轮命令

| 命令 | 本轮结果 |
| --- | --- |
| `npm test -- tests/unit/ipc.test.ts tests/unit/domain.test.ts` | 43 项通过 |
| `npm run check` | lint/typecheck/正式构建/原型构建通过；正式 51 项、原型 16 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 20 项通过；真实 ES 用例 1 项默认忽略 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 通过；此前被用户中断的调用不作证据，恢复后重新执行成功 |
| `npm run build:desktop` | Windows release 构建通过，产物 `src-tauri/target/release/escope.exe`；本轮未运行其原生交互验收 |
| `git diff --check` | 通过 |

新增 Rust 覆盖：GET/基础路径/无认证头、未知操作拒绝、非法 ID/连接不匹配/认证模式无网络、
401/403/429/500、跨主机重定向目标未被联系、错误脱敏、产品标识/JSON/身份字段错误、
有无 Content-Length 的大小限制、超时、并发耗尽前不连接、其他版本不标已测试、
保存 ID 查找/编辑前快照/删除后拒绝/选择不变。
前端 IPC 6 项覆盖：最小参数、浏览器拒绝、失败不回退、错请求/错连接拒绝、调用者修改输入不重绑定。
这是本地 HTTP fixture 与单元测试证据，不代替真实认证/TLS 或桌面 WebView。

## 浏览器快速回归

复用 1420 上的现有 Vite，使用新建的内置浏览器临时标签，未影响用户桌面 SQLite。
当前浏览器实际 CSS 尺寸为 688×836；未设置视口覆盖，不宣称覆盖完整桌面/移动矩阵。
中文查询首页、切换英文、连接中心零连接状态、返回原查询均正常，
`9007199254740993` 原始草稿文本保留，焦点回到 DSL；页面 scrollWidth/clientWidth 均为 688，
无横向溢出，布局目视无重叠，控制台 warning/error 为 0。
没有添加连接或发送 ES 请求。验收后关闭本轮标签；现有 Vite 和用户 ES 服务保持运行。
截图：`docs/evidence/2026-09-30/connection-backend-browser-smoke.jpg`。
此检查不验证新增诊断错误的 UI 呈现，不代替桌面 WebView、200% 缩放或原生键盘/IME 验收。

## 真实 ES

用户授权实例：`D:\es\elasticsearch-7.17.25`，`http://127.0.0.1:9200`，无认证单节点。
本轮开始时 9200 未监听；检查旧日志后用安装目录自带 JDK 隐藏启动一次，仍因
`UnixDomainSockets.connect` / `Invalid argument` 在 Netty 初始化失败。
后续用户确认服务启动，复核端口已监听，未再启动或调整配置。
用户提供的 green 健康状态未在本轮重新调用健康 API 验证，不作为根身份测试的输出。

以下命令已实际通过（1 项），不会输出集群名称、UUID、文档或完整响应：

```powershell
$env:ESCOPE_TEST_ES_71725 = '1'
cargo test --manifest-path src-tauri/Cargo.toml --locked local_elasticsearch_71725_read_only_identity -- --ignored
```

此外在独立测试进程中将 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 均设为
`http://127.0.0.1:9`，清空 `NO_PROXY`，同一用例再次通过。此结果验证 Rust `.no_proxy()`，
没有修改用户或系统代理设置。手工诊断用 `Invoke-RestMethod -NoProxy` 或 curl `--noproxy`。

两次真实用例只发 `GET /`，核对版本 7.17.25 与非空集群身份，不调用健康、搜索、扫描或写 API，
不读业务文档，不修改现有索引、文档和服务配置。不把服务自身启动产生的日志/恢复当成应用写入测试。

## 剩余事项

1. C01.2：设置右侧测试入口、加载/失败/身份展示、编辑/删除/切换/乱序响应隔离、真实桌面 WebView IPC 验收。
2. F08/C01/C04：系统密钥库、认证、自定义 CA、DNS/TCP/TLS 分层；当前这些传输错误统一为 `networkError`。
3. C02：权限能力缓存、无 monitor 仍可查授权索引；身份测试成功不授权其他操作。
4. F05/F02c：真实取消和用户界面过期结果处理尚未实现，不能把请求 ID 字段当成全链路已完成。
5. O05/Q04：资源发现与查询执行仍未接入，任何新增端点先扩充后端注册及专用验证。
6. 8.x/9.x、macOS/Linux、远端 CI、安装包/签名均未验收。此前底座截图与 exe 启动不作为本轮原生交互证据。
