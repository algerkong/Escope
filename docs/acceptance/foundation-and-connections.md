# 工程基础与连接 验收记录

## 共同说明

- 平台：当前 Windows x64 开发主机。除批次内特别注明外，不使用真实 ES、真实 Windows 密钥库、模型服务、
  用户 SQLite 或凭据。Rust 证据来自临时 SQLite（tempfile/内存库/触发器）、假密钥库与回环 HTTP/TLS fixture；
  前端证据来自 mock IPC、显式内存 session 适配与 JSDOM 组件测试，不代替真实服务、桌面 WebView IPC 或原生验收。
- 共同未验（批次内不再重复）：带认证/TLS 的真实 ES 7.17/8.x/9.x、企业 CA、代理网关与证书吊销；
  真实 Windows 密钥库往返及系统拒绝/锁定；浏览器/WebView/桌面 exe 中的双语、窄窗口、200% 缩放、大字号、
  焦点/键盘、原生 IME/密码输入/对话框；macOS/Linux（非 Windows 密钥库显式 `Unavailable`）、跨平台 TLS；
  远端 CI、安装包与签名。人工项见 [集中人工验收](../manual-acceptance.md)。各批均不关闭 F/C/R 父任务。
- 测试约定：2026-10-09 起 Vitest 使用 `--maxWorkers=2`；不提高超时阈值、不放宽 lint/类型/clippy 规则；
  真实 ES、真实 Windows 密钥库与模型网关用例默认 `ignored`；正式构建 >500 kB 的 chunk 警告保留，未调阈值。
  下文 `cargo` 命令均带 `--manifest-path src-tauri/Cargo.toml`。
- 用户授权 ES 实例：`D:\es\elasticsearch-7.17.25`，`http://127.0.0.1:9200`，single-node、认证关闭；
  只读取非敏感配置键。不得操作已有业务数据；需要 fixture 时使用独立资源范围，不把已有索引当可删除样本。

## 2026-09-30 F01–F09 正式工程首轮

范围：工程、交互、无认证连接元信息与 SQLite 首个子集；不是 ES 查询版或完整管理平台验收。
本节为首轮历史证据，“未接入网络/ES 未启动”指当时状态，后续以下文各批为准。

| 子项 | 实现位置 | 状态 |
| --- | --- | --- |
| F01.1 | 根目录工具链、`src/`、`src-tauri/` | 正式前端、Rust、Windows exe 构建；原型保持独立 |
| F01.2 | `tests/unit/`、Rust 模块测试、`.github/workflows/checks.yml` | 本机质量门禁通过；远端 CI 未运行 |
| F05.1 | `src/domain/query.ts`、`src/services/ipc.ts` | 草稿/不可变快照、原始数值文本、旧响应/跨连接/取消状态规则；真实请求取消未接入 |
| F03.1 | `src/styles/`、`src/locales/`、`PreferencesPanel.tsx` | token、字体、本地资源、语言、主题、偏好验证与局部重置 |
| F02.1/F02a | `src/app/`、`QueryWorkspace.tsx` | 查询首页、固定设置导航、六个右侧管理路由、草稿保持 |
| F02b.1 | `connection.ts`、`storage.ts` | 稳定 ID、零/单/多、名称无关、顺序、失效/删除回退 |
| F04.1/F09.1 | `CommandPalette.tsx`、组件测试 | 基础快捷键、IME、模态优先级、焦点恢复、显式 session adapter |
| F07.1/C05.1 | `src-tauri/src/storage.rs`、迁移 001 | SQLite 偏好/选择/无认证元信息 CRUD；不接受凭证 |
| F06.1 | `operation.rs`、CSP/capabilities | 未知/写操作拒绝；无任意网络代理；未实现实际 ES 端点授权 |

F07.1/C05.1 仅为无认证元信息存储子项，不表示 F08 密钥库或完整 C05。生产应用无演示连接；
浏览器 preview 是显式内存会话，不是桌面失败降级。

| 本机检查 | 结果 |
| --- | --- |
| `npm run check` | ESLint、TypeScript strict、Vite 构建通过；正式 45 项、原型 16 项通过 |
| `cargo test --locked` | 7 项通过 |
| `cargo clippy --all-targets --locked -- -D warnings` / `cargo fmt --check` | 通过 / 交付前检查格式 |
| `npm audit` | Vitest 升级至 4.1.11 后无已知漏洞；生产依赖审计 0 |
| `npm run build:desktop` | Windows release exe 约 10.8 MB；无安装包、无签名 |
| 启动 exe | 进程存在，窗口标题 `EScope`，非零窗口句柄，`Responding=True`，应用数据目录生成 20 KB SQLite；只确认窗口与数据库创建，**不等于桌面内 IPC/交互已实测** |

工具链：Node 24.9.0、Rust 1.93.1、Vite 7.3.6、Tauri 2.12.0、WebView2 153.0.4234.19、Windows SDK 10.0.26100.0。

浏览器（Codex 内置，正式 Vite `http://127.0.0.1:1420`）：原型 `file://` 被工具策略阻止，未绕过，正式页面不替代原型 D01。
覆盖 1440×900（首页、设置、六路由、无连接、命令面板）；1024×700（英文、夜间、20px、紧凑，可滚到全部设置）；
390×844（英文 20px，无横向/导航文字溢出）；2 外观 × 4 强调色 × 2 语言 16 种切换（语言/token 正确、草稿保留、无溢出）；
session 内用 `qa.example.test` 元信息保存/编辑显示“未测试”、不发请求、刷新清除；设置返回保留 `9007199254740993` 原文且焦点回编辑器；
命令面板搜索/空结果/键盘进入/关闭，Esc 只关浮层、焦点回入口。发现并修复：无 Radix Trigger 时焦点丢失、大字号导航溢出、
连接切换失败重试误操作偏好、启动默认视图提前影响新标签、根模块 HMR 重复创建 React root（修复后替换入口，6 个控制台事件无 exception/error）。
证据 [`../evidence/2026-09-30/`](../evidence/2026-09-30/)：`query-desktop.png`、`settings-general-desktop.png`、`typography-1024-english-20px.png`、
`settings-mobile-english-20px.png`、`command-palette.png`、`theme-matrix.json`、`mobile-layout.json`、`hmr-check.json`。
浏览器缩放曾为 130%，以实际 `innerWidth/innerHeight` 为准。特有未验：全量对比度数值审计、屏幕阅读器、其他平台 WebView；主题切换正确不等于全部颜色状态达 WCAG。

ES：检查时 9200 未监听；未启动服务、请求集群、读取文档或修改索引。

首轮限制（后续批次已部分解决）：查询执行/可视化/资源发现/模型调用未实现且控件不可用；无凭证库，不能用地址内秘密替代；
草稿不持久到重启；SQLite 仅测事务/坏配置/未知版本/只读失败，无配额、备份恢复、升级演练；默认只读靠不暴露写入口与拒绝未知命令，
接网络须补方法/路径/资源/权限校验；CI 仅配置、无远程仓库，不能称三平台通过；Git 用本机身份、`main`、LF，原型基线与开发分提交，未推送。

## 2026-09-30 F06.2/C01.1 无认证只读连接后端

范围：后端与类型化 IPC；不是完整连接向导、查询版或 F06/C01/C02 父任务验收。

| 位置 | 能力 |
| --- | --- |
| `src-tauri/src/operation.rs` | 仅注册 `connection.test`：固定 GET 已保存基础路径的根端点，无请求体；未知/写/查询操作拒绝 |
| `src-tauri/src/storage.rs` | 按稳定 ID 读取已校验配置，返回独立快照，不改当前选中项 |
| `src-tauri/src/connection.rs` | 无认证 HTTP/HTTPS 客户端、身份响应解析、请求与连接 ID 绑定 |
| `src-tauri/src/lib.rs` | `connection_test` 先查 SQLite，网络 await 前释放数据库锁；不接收 URL/方法/认证头 |
| `src/services/ipc.ts` | `testConnection` 只传 ID，捕获调用时身份并校验响应归属；浏览器拒绝，不自动重试或回退 |
| `src/locales/` | 双语诊断错误；服务端 403 为 `serverForbidden`，与本地只读 `permissionDenied` 分开 |

传输边界：禁重定向、不发 Referer、不继承环境代理、不支持认证秘密、不关闭默认 TLS 校验；
最多 4 并发，连接超时 3 秒、请求总超时 10 秒，响应最大 1 MiB，不依赖 Content-Length 做大小检查。
仅 7.17.25 标记已测试，未知版本不声称已验证。错误不回传 reqwest 原文、响应体或认证内容。
根身份成功/无权限不等于索引搜索权限。当时设置 UI 尚未调用该服务。

| 命令 | 结果 |
| --- | --- |
| `npm test -- tests/unit/ipc.test.ts tests/unit/domain.test.ts` | 43 项通过 |
| `npm run check` | lint/typecheck/正式与原型构建通过；正式 51、原型 16 |
| `cargo test --locked` | 20 通过，真实 ES 1 项默认忽略 |
| `cargo fmt --check`、严格 clippy、`git diff --check` | 通过；被用户中断的 clippy 调用不作证据，恢复后重跑成功 |
| `npm run build:desktop` | 产物 `src-tauri/target/release/escope.exe`；未运行原生交互验收 |

Rust 新覆盖：GET/基础路径/无认证头、未知操作拒绝、非法 ID/连接不匹配/认证模式无网络、401/403/429/500、
跨主机重定向目标未被联系、错误脱敏、产品标识/JSON/身份字段错误、有无 Content-Length 的大小限制、超时、
并发耗尽前不连接、其他版本不标已测试、保存 ID 查找/编辑前快照/删除后拒绝/选择不变。
前端 IPC 6 项：最小参数、浏览器拒绝、失败不回退、错请求/错连接拒绝、调用者修改输入不重绑定。

浏览器快速回归：复用 1420 的 Vite 与临时标签，未影响桌面 SQLite；实际 CSS 尺寸 688×836，未覆盖视口矩阵。
中文首页→英文→零连接连接中心→返回查询正常，`9007199254740993` 草稿保留，焦点回 DSL，
scrollWidth/clientWidth 均 688，无重叠，控制台 warning/error 0；未添加连接或发请求。
截图 [`connection-backend-browser-smoke.jpg`](../evidence/2026-09-30/connection-backend-browser-smoke.jpg)；不验证新诊断错误的 UI 呈现。

真实 ES：开始时 9200 未监听，用安装目录自带 JDK 隐藏启动一次，因 `UnixDomainSockets.connect` /
`Invalid argument` 在 Netty 初始化失败；后由用户启动，复核端口监听，未再改配置。用户提供的 green 状态未经本轮健康 API 复核。
以下用例通过 1 项，不输出集群名、UUID、文档或完整响应：

```powershell
$env:ESCOPE_TEST_ES_71725 = '1'
cargo test --manifest-path src-tauri/Cargo.toml --locked local_elasticsearch_71725_read_only_identity -- --ignored
```

另在独立进程把 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 设为 `http://127.0.0.1:9`、清空 `NO_PROXY`，同一用例再次通过，
验证 Rust `.no_proxy()`，未改用户/系统代理；手工诊断用 `Invoke-RestMethod -NoProxy` 或 curl `--noproxy`。
两次只发 `GET /`，核对版本 7.17.25 与非空集群身份，不调用健康/搜索/扫描/写 API，不读业务文档，不改索引/文档/配置。
服务自身启动日志/恢复不算应用写入。

特有未验：传输错误（DNS/TCP/TLS）当时统一为 `networkError`；真实取消与界面过期结果处理未实现，请求 ID 字段不代表全链路完成；
资源发现/查询执行未接入，新增端点须先扩充后端注册与专用验证。

## 2026-09-30 F08.1 凭证存储原语

范围：Rust 存储原语；不是认证连接、凭证生命周期或 F08 父任务完成。

- `src-tauri/src/credentials.rs`：`CredentialRef` 为规范 UUID，固定 service namespace；`Secret` 非 Serialize/Clone、
  Debug 隐藏、`Zeroizing` 持有，拒绝空或超过 2048 字节输入。审查要求无效输入先接管再校验，拒绝路径显式 `zeroize()`；
  实现 `Zeroize` 不等于 Drop 自动清理。
- `CredentialStore` 提供 set/get/delete；Windows `SystemCredentialStore` 经 `BackendStore` 与 `KeyringBackend` 调用系统凭据管理器。
  缺失与不可用/失败区分，删除缺失幂等，非法 blob 拒绝；错误仅稳定 code，不回显 OS/keyring 原文；
  无返回秘密的 IPC，不落文件，无生产内存回退。
- `lib.rs` 仅声明模块；Cargo 新增直接 `zeroize` 与 Windows 专用 `keyring`（锁定 3.6.3，禁用默认 feature，仅 `windows-native`），无前端依赖。
- namespace 只限制寻址，不证明引用属于某连接；F08.2 起必须从可信 SQLite 行读取引用，前端不能指定或读取秘密。

| 命令 | 结果 |
| --- | --- |
| `cargo test --locked` | 29 通过、2 忽略；凭证模块 9 执行、1 忽略 |
| `cargo fmt -- --check`、严格 clippy、`git diff --check` | 通过 |
| `npm run check` | 正式 74 / 原型 16，lint/typecheck/两类构建通过 |

`cargo test credentials` 过滤还会匹配 `storage::tests::credentials_urls_*`，其通过数不能记为本模块新增数。
覆盖：trait 假后端合同（写读替换、删除、故障传播、无降级，fake 仅测试可用）；生产 `BackendStore` + 脚本后端
（缺失、幂等、不可用/失败、超限/空 blob、字节传递）；错误映射 `NoEntry`、`NoStorageAccess`、平台失败与超长错误脱敏；
引用规范化、秘密大小边界、Debug 脱敏、拒绝路径所有权释放（不用 unsafe 探测已释放内存）。
真实往返用例默认 ignored，使用随机独立引用与 Drop 清理守卫，未执行。

## 2026-09-30 C01.2 连接测试界面接线

接手已有未提交的测试按钮、身份展示、App 生命周期/跨连接状态与 14 项连接测试（不算本批重新实现）。

- 补 5 项回归：未测试连接失效不产生虚假状态、主题切换不请求、删除后迟到失败、在途改地址拒绝旧响应、未知错误与 UTC 显示。
- 审查发现非结构化连接异常误报 SQLite 失败：新增 `errorCode(error, fallback)`，连接测试显式用 `unexpected`，
  存储调用默认行为不变；再补连接 2 项、IPC 2 项回归。
- 生命周期覆盖 requestId/connectionId/endpoint 绑定、重复抑制、重测、卸载、删除、编辑成功/失败、设置往返与语言/主题变化。
  身份成功不代表搜索授权。不改布局，未启动浏览器/Vite/WebView/ES，无新截图；真实后端取消仍未实现。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | lint、类型、正式/原型构建通过；正式 74（连接 21、IPC 8）、原型 16 |
| `cargo test --locked` | 含 F08.1：29 通过、2 忽略（真实 ES / Windows 密钥库） |
| `cargo fmt -- --check`、严格 clippy、`git diff --check` | 通过 |

## 2026-09-30 F08.2/C05.2 凭证引用与清理后端

- schema v2 增加 `auth_kind`、`credential_ref` 与持久 `credential_cleanup` 队列；迁移按版本事务执行，
  v1 数据/偏好/选择保留，未知版本、损坏引用和不匹配组合 fail closed。
- `connection_credentials.rs` 用真实 Database + 可注入 CredentialStore 编排：先持久 prepare 再写新 UUID 秘密；
  绑定与旧引用入队同事务；失败不覆盖旧秘密。解绑、删除、改 endpoint 先断开引用并入队再清理；重命名保留 ID 与秘密。
- metadata 已提交后，清理记账/读取/删除失败返回 `CleanupPass::Incomplete`（pending/unknown），不报普通写失败或填 0 假成功。
- 队列查询跳过在用与耗尽重试条目，保留全部待清理统计，每次最多 64 条。引用不出现在 Debug/序列化输出，秘密不进 SQLite。
- 旧 IPC 恢复纯元信息入口，已绑定行在事务修改前拒绝；legacy load/connection 拒绝认证配置，不伪报 `auth:none`。
  bind/unbind/outcome 仅在 Rust 内部，无秘密 IPC 可创建认证配置，无认证流程照常。
- 单一 Database/进程内 mutex 的单写者合同；无跨进程锁，不支持两个进程共享同一 DB 并发操作凭据。
- 首版接线丢失清理状态，经审查退回，最终未保留。

验证：Rust 56 通过/2 忽略，fmt、严格 clippy 通过；正式前端全量 142、原型 16；Windows release 构建通过未运行。
前端与构建命令见 [结果与工作区验收](results-and-workspace.md)。SQLite 故障用 tempfile/内存库与触发器验证，含提交后 attempt/queue delete 失败及恢复。

## 2026-10-09 C01.3 只读认证传输

范围：Basic、API Key、Bearer 的内部秘密表示、编码、可信记录解析与只读传输，覆盖根身份、索引/Mapping/字段/集群资源、
搜索与 PIT 打开/续页/关闭。不开放认证表单、秘密 IPC 或明文保存；自定义 CA、代理、权限能力、用户/API Key 管理与写操作不在范围。

| 位置 | 交付 |
| --- | --- |
| `connection_auth.rs` | `EsAuthMaterial`、版本化密钥库负载、三种编码、敏感头与脱敏错误；只接受数据库生成的 `TransportSnapshot` |
| `storage.rs` | `Database::transport_snapshot` 按稳定 ID 封闭已校验记录；无 schema 变化 |
| `connection_credentials.rs` | `bind_auth` 复用准备/写库/绑定/清理流程，类型与负载由同一材料生成 |
| `operation.rs` | 计划固定连接 ID、归一化端点、认证类型与引用；未解析的认证计划拒绝，不跨目标附加认证 |
| `connection.rs`、`lib.rs` | 身份/资源/搜索/PIT 从可信快照解析认证，复用只读发送路径；数据库锁不跨网络 await |
| `src/services/ipc.ts`、`src/locales/index.ts` | `credentialNotFound`、`credentialUnavailable`、`credentialFailure` 与双语诊断；请求字段/命令注册未扩大 |

合同：

- 密钥库负载：`ESC` 标记、版本 `1`、认证类型、u16 大端长度前缀 UTF-8 字段；版本/类型不符、越界、空字段、坏 UTF-8、尾部多余字节拒绝。
- Basic 用 UTF-8 字节编码一次，用户名不能含冒号；API Key **保存 ID 与 key 两个组件**，只做一次标准 Base64，不二次编码预编码串；
  Bearer 原样承载，拒绝非可打印 ASCII 与头注入。
- 上限：用户名/API Key ID 各 256 字节，密码/key/token 1536 字节，编码负载最大 1801 字节，仍受 `Secret` 2048 字节约束。
- 全部自有材料（含用户名、API Key ID）用 `Zeroizing`；负载与头拼接缓冲预先定容，写入敏感内容后不扩容。
  `ResolvedAuth` 字段私有、只读访问器，无接收原始头或任意引用的生产构造入口；测试构造器 `#[cfg(test)]` 隔离。
- 每请求重新读取自身引用，无凭据缓存、跨目标回退或自动重试。连接 ID、端点、凭据绑定同一快照，保留取消、迟到隔离及超时/并发/大小限制。
- 旧 `load`、单条读取、保存、删除仍拒绝已绑定凭据记录。Cargo 仅把锁文件中已有 `base64 0.22.1` 声明为直接依赖，无其他升级或迁移。

证据矩阵（临时 SQLite + 假密钥库 + 回环 HTTP）：三种编码往返/字面量及损坏/版本/类型/尾部拒绝；密钥库缺失/不可用/损坏/类型不匹配不降级，缺失秘密前不开 socket；
跨连接/端点/基础路径/类型/引用的复制篡改拒绝，端点变更不读旧引用，重命名保留绑定；身份、7 种资源、搜索、PIT 开/查/关的路径/头/原始字节；
重定向、独立进程代理环境、共享超时/4 并发/1 MiB 限额（TLS 默认配置仅静态核对，非证书实测）；401/403 区分、头注入拒绝、错误/Debug/元信息不回显秘密；
认证请求取消释放许可及生命周期回归；5 类读取信封拒绝额外字段，旧存储拒绝认证记录。

| 命令 | 结果 |
| --- | --- |
| `cargo test --locked --offline --lib -- connection_auth:: connection:: operation:: resources:: query:: storage:: connection_credentials::` | 最终 131 通过、4 真实 ES 忽略（首轮 126 不代替最终） |
| `cargo test --locked --offline` | 216 通过、6 忽略（4 真实 ES、1 Windows 密钥库、1 模型网关） |
| `cargo fmt -- --check`、`cargo clippy --all-targets --locked --offline -- -D warnings` | 通过 |
| 独立进程代理环境 + `--lib -- connection::tests::` | 32 通过、4 忽略（`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`=`http://127.0.0.1:9`，清空 `NO_PROXY`，未起代理） |
| `npm test -- tests/unit/ipc.test.ts tests/unit/connection-tests.test.tsx` | 2 文件 47 项 |
| `npm run check` | lint/typecheck/正式构建通过；正式 709 通过、**8 项触发 5 秒超时**，原型步骤未执行；该默认并发失败记录保留 |
| `npm test -- --maxWorkers=2` | 43 文件 717 项通过（未改超时或配置） |
| `npm run build:prototype` / `npm run test:prototype` | 补跑通过 / 16 项 |
| `git diff --check`、Markdown/链接/LF | 通过；JS 约 894 kB |

审查修正：首轮把用户名/API Key ID 纳入清零缓冲并预分配；首轮解析器接收可改 `ConnectionProfile` 且 `ResolvedAuth` 可在 crate 内构造，
续跑改为数据库独占构造的 `TransportSnapshot` 与私有字段；认证 wire 测试改走真实临时 SQLite 与同一解析器。
零化保证仅针对自有材料与 scratch 缓冲的 Drop，不验证已释放内存，不宣称第三方 HTTP/TLS 库副本被清零。

## 2026-10-09 C05.3/C01.4、C04.1、C02 首批、Q07 首批 连接安全与保存导出

| 子项 | 实现 | 边界 |
| --- | --- | --- |
| C05.3/C01.4 | 设置内 Basic/API Key/Bearer 创建、保留、替换、解绑、删除；HTTP 未加密提示；清理待完成与重试 | 未使用真实凭据/密钥库 |
| C04.1 | SQLite 保存每连接公共 CA；可信快照接入全部只读客户端；默认根与主机名验证保留 | 无跳过证书验证、代理、SSH、mTLS |
| C02 首批 | 显式当前身份、角色、monitor/read/view_index_metadata 与基础搜索/PIT 支持反馈 | 权限、未知、不支持分开；无 monitor 不阻止索引查询；非完整许可/版本矩阵 |
| Q07 首批 | 版本化命名草稿/收藏、恢复、删除；已加载命中 CSV/JSONL；原生文件保存 | 不恢复执行/PIT、不保存结果；历史、列布局跨重启、参数、全量流式导出与配置交换未交付 |

接口与持久化：

- `connections_load/save/delete/cleanup` 为受限合同；网络请求只接受稳定连接 ID，不接受 URL、方法、认证头、凭据引用或临时秘密。
- 元信息、凭据引用、CA 同一 SQLite 事务；新密钥写入前记 prepare，失败保留旧目标/凭据/CA，新孤立秘密由清理队列追踪，提交后才清理被替换秘密。
- 公开连接只返回认证类型、`hasCredential`、`hasCustomCa`（仅表示绑定元信息，不承诺密钥库可读或证书有效），不回显秘密、引用或 PEM。
- 清理返回 `complete/pending/incomplete`；`incomplete` 的 remaining 为 null 不能当零；达重试上限记录保留；保存已提交不因后续清理失败回滚。
- 换端点时 keep 不复用旧凭据/CA；重命名保留身份。CA 上限 64 KiB、16 个公共证书块，私钥与无效内容拒绝；自定义根只用于所属快照，客户端共享并发许可。
- schema **v4 → v5**：增加 `connections.ca_pem` 与 `saved_query_library`。查询库单行 4 MiB、最多 100 项，草稿 DSL 256 KiB，不完整 DSL 可保存；
  旧版本不能打开高版本 schema，不自动降级或覆写损坏库。
- `connection_access` 仅调用根信息、`_security/_authenticate` 与固定 `_security/user/_has_privileges`；角色按有界字段投影，不返回整份安全响应；
  版本反馈不代表权限或许可授权，也不门控搜索。
- `saved_queries_load/save/export` 无任意存储键或前端路径；恢复使用新查询 ID，仍绑定原连接 ID，原连接已删时不能执行、不按名称重绑。
- 桌面导出经 `tauri-plugin-dialog` 选择目标，同目录临时文件写完 flush/sync 后替换；取消/失败/已保存区分；浏览器仅报告下载已请求。
  导出上限 16 MiB，不隐式取下一页或重新查询。
- CSV 保留数值原始 token、文本公式防护、RFC 4180 转义（无类型信息，第三方表格自动转换不在无损保证内）；JSONL 每行完整原始 hit，仅去 token 间空白。
- 浏览器 session 只在内存保存元信息/草稿，刷新清除，拒绝秘密；桌面失败不静默切换至 session。

集成修正：认证设置接入公开元信息合同与提交后清理提示；凭据类型切换恢复密码遮蔽，关闭销毁瞬时输入，错误只显示受控双语消息；
身份测试与权限诊断走请求注册/取消，目标修改/删除/关闭后迟到结果丢弃；CA 补本机自签 TLS 握手（默认/错误 CA 拒绝、可信快照成功、错误主机名拒绝），
TLS 失败按 rustls 错误类型映射，不回显错误文本；保存导出修正聚焦恢复目标、提交反馈、导出快照与重复操作、字段重名及部分文件边界；
查询库内容去除大于 480px 弹窗的最小宽度，保存状态可换行（仅静态/组件验证）。

| 检查 | 结果 |
| --- | --- |
| 连接/权限/存储/设置定向 Vitest | 5 文件 67 项 |
| App 恢复集成 | 2 项；原目标/已删目标不自动执行或重绑 |
| C02 定向 Rust | 初轮 4 项；新增取消场景随全量通过 |
| 后端定向 | 初轮 117、修正后 124，4 忽略，含回环 TLS 握手 |
| 保存导出定向 | 领域/服务/组件 44；既有 query-editor/query-live 49；Rust 10 |
| 前端 lint/typecheck/build | `npm run lint`、`npm run build` 通过；行选择修正后定向复查，最终 CSS 以 `npx vite build` 通过；JS 948.18 kB |
| 完整 Vitest | 首轮 803/804（分片拖选失败）；新用例在旧代码稳定复现延迟清理，修正后定向 43；最终 51 文件 805 项 |
| `cargo test --locked --offline` | 261 通过、6 忽略 |
| Rust fmt / 严格 clippy（`--all-targets --offline`） | 首次仅新取消测试排版未过，格式化后通过 / 通过 |
| 文档 | Markdown 解析、116 个本地链接、LF、`git diff --check` 通过 |

首轮失败：保存导出测试 mock 的 TypeScript 签名错误、访问服务 `no-control-regex` lint 错误，均按实际问题修正。
分片拖选失败根因：passive effect 可清掉新作用域刚产生的选择，作用域清理移到布局提交阶段，未改分片读取/选择身份规则。
本批未运行含原型的 `npm run check` 与原型回归（未改原型）。旧安装包不含本批功能。

## 2026-10-10 C02 第二批 版本、部署与许可能力

基线 `2d6571b`。无新依赖、数据库迁移；SQLite schema v6、查询库与恢复文档 v1、参数子对象 v1 不变。

| 范围 | 交付 | 边界 |
| --- | --- | --- |
| 服务信息 | 版本、发行/预发布/未识别、构建类型、集群 UUID、Serverless 标记 | 仅 `build_flavor=serverless` 识别 Serverless；不由默认构建/主机名推断自建/Hosted/ECE/ECK |
| 许可 | 类型、active/expired/invalid、原始精确到期毫秒 | 读取成功不等于有效或已授权；未报告到期不写成永久 |
| 功能证据 | 搜索、PIT、SQL、EQL、ES\|QL、Graph 证据状态与来源 | 搜索/PIT 不按主版本标可用；四类功能只解释服务报告，未探测 |
| 会话缓存 | 仅缓存许可与功能报告，单调时钟 60 秒 TTL、最多 16 个连接槽位、显式刷新 | 不缓存身份/角色/目标权限/秘密；不落 SQLite/恢复/导出 |
| 交互 | 身份权限对话框显示元信息、许可、功能、来源/时间与过期 | 打开/关闭/重开、语言/外观、过期均不发请求；图标刷新绕过缓存 |

Q08/G05 的语言或 Graph 执行、写入授权、Cloud ID、多节点与控制面未开放，不能把报告缓存当许可或授权票据。

受限请求：`connection_access` 只含 `requestId`、`connectionId`、可选 `index`、可选布尔 `refresh`；新增 `diagnosticsStale`，
连接变化或同连接新诊断阻止旧结果回填。最多五个固定请求，共享 4 并发、单响应 1 MiB、单请求 10 秒，诊断网络阶段另有 30 秒总预算；
耗尽后未发检查显示 unknown/timeout，保留已得身份与权限，无自动重试或写入探测。

1. `GET /_security/_authenticate`
2. `POST /_security/user/_has_privileges`（固定 monitor/read/view_index_metadata）
3. `GET /`（重读集群身份与精确版本）
4. `GET /_license?local=true`；仅已识别普通 7.6.0–7.x 发行版附加 `accept_enterprise=true`，避免 Enterprise 报为 Platinum
5. `GET /_xpack?categories=features&human=false`，只取 sql/eql/esql/graph 布尔字段

第 4、5 步可用有效缓存，前三步始终重查。新操作仅内部注册，不经 `resource_read` 或任意操作名扩大代理面；沿用 `TransportSnapshot`、
凭据、公共 CA、产品响应头、禁重定向/环境代理与取消约束；返回前重核连接/端点/认证引用/CA。
许可 UID/持有者/签发者/额外字段不进 IPC，构建 hash 只用于缓存隔离；到期毫秒以十进制字符串传输，`u64::MAX` fixture 不被 JS 舍入；
未知/损坏、缺失布尔、重复已知字段不作证据。

| 情况 | 状态 | 不代表 |
| --- | --- | --- |
| 身份/许可/功能端点 401/403 | denied，保留错误码 | 其他授权索引不能搜索 |
| 404、超时、429、非 ES 产品头、损坏响应 | unknown 并保留原因 | 404 不证明 API 移除，许可启动期可能暂态 404 |
| 已识别普通 7.x 早于 7.10.0 | PIT unsupported（版本边界） | 7.10.0 起仍仅未探测 |
| available=true、enabled=true | reported（服务报告） | 目标读权限或操作验证 |
| available=false、enabled=true | unlicensed | HTTP 权限拒绝 |
| enabled=false | disabled，显示两个原始布尔 | API 不存在 |
| 功能缺失 | unknown / featureMissing | 按许可补造或视为不支持 |
| Serverless | 版本标为兼容性编号；Graph 按部署 unsupported | 套用发行版规则；同时报告 Graph 就绪则标冲突/unknown |

所有结果带 `operationVerification=notRun`；前后端共享 fixture；前端拒绝把版本、许可档位或矛盾布尔包装为已验证能力；未改查询/PIT 入口，无诊断前置门槛。

缓存隔离：绑定稳定连接 ID、归一化完整端点、认证类型/系统引用、公共 CA 内容，任一变化不复用，重命名不影响；
再核对根响应集群 UUID、精确版本、构建类型/hash/快照标记，UUID 缺失/`_na_`、未知构建或预发布不可复用。
每次诊断独立代次，旧结果/旧取消不覆盖新代次，淘汰后旧请求不能重建槽位。身份与 monitor 均成功才复用；
拒绝/未知、指纹变化、过期或强制刷新清除旧报告，新读取失败不回退旧成功；目标索引权限每次单独读取。
命中不续期，前端显示原读取时间与缓存来源并把 IPC 交付延迟计入有效期，过期只更新本地状态不轮询。
60 秒内报告是历史观测，后续真实操作必须自行做后端权限/目标/许可校验。

前端：`npm test -- --maxWorkers=2 tests/unit/{connection-access,connection-tests,connection-settings}.test.tsx tests/unit/connection-security-service.test.ts tests/unit/ipc.test.ts tests/unit/{app-query-integration,controls-polish}.test.tsx`
→ **7 文件 138 项**（C02 文件 40；先后 38→39 IPC 交付延迟→40 删除连接与端点 404 文案区分；七文件 136→137→138）。
连接查找失败用“连接不存在”文案，仅诊断子结果 404 用“端点支持未知”。

| Rust `cargo test --lib` 选择器 | 结果 | 覆盖 |
| --- | --- | --- |
| `connection_access` | 20（先后 16、19、20） | 版本/Serverless、许可与功能解析、缓存/TTL/连接/代次、固定请求、预算、共享 fixture |
| `operation::tests` | 11 | 固定方法/路径/基础前缀、旧版许可参数、禁止目标/正文/任意操作 |
| `read_only::tests` | 9 | 早到/迟到/重复/跨连接取消 |
| `query::tests` | 20 | 查询快照、只读计划、精确正文与参数拒绝 |
| `connection_auth::tests` | 12 | 凭据绑定、类型/引用/端点隔离、脱敏、缺失凭据拒绝 |
| `connection::tests::authenticated` | 4 | 认证搜索/PIT、HTTP 错误/重定向、响应上限、真实 socket 取消 |
| `connection::tests::every_authenticated_resource_family_carries_the_bound_header` | 1 | 新许可/旧版许可/功能端点携带所属快照唯一认证头 |

共 **77 项定向**，非全量，未运行 ignored。ESLint（服务、IPC、组件、词条、测试）、`npm run typecheck`、`npm run build`、
`cargo fmt -- --check`、`cargo clippy --lib --locked -- -D warnings` 通过；clippy 首轮因 `manual_range_contains` 失败，改用 `Range::contains`。
复审修正未定义字号 token、交付延迟过期显示、旧版许可参数。JS 约 **1,038.34 kB**；未运行全目标 clippy、原型或安装包。
文档：8 份 Markdown、109 个本地链接、39 张表格；21 个改动文件 UTF-8/LF/末尾换行与 `git diff --check` 通过。

版本证据：7.5.2、7.6.0、7.9.3、7.10.0、7.17.25 有版本/旧版参数/PIT 边界单测与 7.17.25 请求序列 fixture（本批未连接，7.17.25 历史只读记录不算许可通过）；
8.16.0、8.16.1、9.1.0、10.0.0 仅解析、补丁变化隔离与不猜可用性；Serverless、未知构建、预发布、坏版本仅合成响应与冲突/缺失分类，无 Serverless/Hosted/企业许可环境。

依据（2026-10-10 读取，不代替目标发行版或真实许可验证）：
[根信息 API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-info)（`build_flavor` 识别 Serverless，报告版本不代表部署发行版）；
[8.16 功能 Info API](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/info-api.html)（categories/human、monitor/manage、available/enabled 语义）；
[8.16 许可读取](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/get-license.html)、[7.17 许可读取](https://www.elastic.co/guide/en/elasticsearch/reference/7.17/get-license.html)（local、monitor、暂态 404、旧版 Enterprise 参数）；
[7.10 PIT API](https://www.elastic.co/guide/en/elasticsearch/reference/7.10/point-in-time-api.html)；
[Graph 部署边界](https://www.elastic.co/docs/explore-analyze/visualize/graph)（Serverless unavailable）。

特有未验：真实身份账户/许可、真实 Graph 或查询语言探测；默认/OSS 发行版部署位置无法仅凭数据面确定；
跨节点/跨集群路由属 C03；原生对话框滚动、重启后缓存清空。

## 2026-10-10 F01/R03 开发依赖安全修复

基线 `d2436f6`。环境 Node 24.9.0、npm 11.6.0。前批发现见 [查询编辑与参数验收](query-editor-and-parameters.md)。
修复前 `npm audit --json` 5 项 high（其中三个是同一传递链影响），`--omit=dev` 为 0。

| 漏洞 | 审计证据 | 处理 |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | braces <=3.0.3 深层模式栈耗尽；最新 braces 3.0.3，micromatch 4.0.8 仍依赖 | watcher 2.5.6 改用 picomatch，移除 micromatch/braces 链 |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | source-map-js >=1.0.0 <1.2.2 indexed section offset 放大 | 原范围内锁定 1.2.2 |

依据为本次 npm 审计、`npm view` 与实际 `npm diff`，不凭 `fixAvailable` 推定；GitHub advisory API 两次读取因 TLS 握手/主机名校验失败未取得正文，
未关闭证书验证或改网络配置，该失败不作证据。

- `@tailwindcss/cli` 最新仍 4.3.3，精确依赖 watcher 2.5.1。`package.json` 仅加限定 override `@tailwindcss/cli > @parcel/watcher@2.5.1` → **2.5.6**
  （同 2.5 分支，未升 2.6.0，不影响其他调用方）。上游 CLI 不再依赖 2.5.1 后覆盖失效，届时复核移除并重新审计/构建。
- 锁文件：watcher 及 13 个可选原生包同步 2.5.6；`source-map-js` 1.2.1 → 1.2.2（开发依赖，供 PostCSS 与 Tailwind Node）；
  watcher 复用 picomatch 4.0.7 与 detect-libc 2.1.2，Linux libc 探测随上游改为 `familySync()`（未在 Linux 实测）；
  删除 micromatch、braces、fill-range、to-regex-range、is-number。生产依赖与 React/Vite/Tailwind/Vitest/TypeScript/Temporal/JSBI 版本不变；
  安装树 549 → 540，生产依赖仍 155。npm 自动补写的六个无关 WASM bundled 元数据条目已排除，`npm ci` 后无锁文件改动。
- 未改业务代码、原型、构建脚本、Rust、IPC、schema；生成的 `docs/assets`、`dist` 继续忽略。

新增 `tests/unit/build-dependencies.test.ts` 27 项：锁文件无 micromatch/braces、watcher 原生包版本一致且两依赖仅属开发链；
本机原生 watcher snapshot API 验证普通文件、子目录、隐藏文件、`**/*.{tmp,log}` 与目录忽略（仅临时文件，清理前校验绝对路径，无常驻监听）；
从 PostCSS 与 Tailwind Node 分别解析 source-map-js，验证普通映射/跨行序列化、indexed 偏移读取、源码保留；
拒绝超大/非法/非整数/字符串偏移及嵌套累计越界（构造阶段断言，不生成超大映射）。

| 检查 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 540 项，未忽略脚本，Windows 预编译原生依赖可加载 |
| `npm audit --json` / `--omit=dev --json` | 0 / 0（不等于发现全部供应链风险） |
| `npm ls ... --all` | watcher 2.5.6 overridden、source-map-js 1.2.2，picomatch/detect-libc 去重，无 invalid |
| `npm test -- --maxWorkers=2 tests/unit/{build-dependencies,packaging-config}.test.ts tests/unit/{controls-polish,app}.test.tsx` | **4 文件 59 项** |
| `npx --no-install eslint tests/unit/build-dependencies.test.ts` | 通过 |
| `npm run build` | typecheck 与正式构建通过；JS **1,272.16 kB** |
| `npm run build:prototype` / `npm run test:prototype` | Tailwind 4.3.3 与本地图标构建通过 / **16 项**（JSDOM，非像素） |
| 文档与 diff | 9 份 Markdown、146 个本地链接、44 张表格、12 文件 UTF-8/LF、`git diff --check`；26 条锁文件变化均在预定范围 |

首轮问题：按 CLI 具体版本限定 override 报 `EOVERRIDE`、未更新锁文件，改为 CLI 下限定 watcher 2.5.1 后通过；
首轮定向 57 项中 2 失败——indexed consumer 直接传入 `SourceMapGenerator.fromSourceMap` 触发既有 `sourceRoot` undefined 错误，
新旧包 diff 确认读取逻辑未变，不修补第三方库，改为分别验证 flat 序列化与 indexed 读取，新增两例后 59 项通过。
`npm ci` 仍提示 eslint 9.39.5、whatwg-encoding 3.1.1 弃用，不属本次漏洞，未升级。

未运行 Rust/全量前端/严格 clippy/安装包（无相应代码变化）。特有未验：跨平台 native watcher、持续 watch/热更新；
任意 indexed map 的 generator 转换仍有上游限制，审计 0 不是完整安全证明。R03 父任务与六方向范围保持开放。
