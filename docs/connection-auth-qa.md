# ES 只读认证传输验收

日期：2026-10-09。任务：C01.3。平台：当前 Windows 主机。
状态：内部实现、复审与 mock 自动化通过；用户可见认证流程和真实环境仍待后续验收。

本页保留 C01.3 当时的实现与验证范围。后续认证表单、CA、权限诊断及保存导出的实际进度
见 [合并批次验收](connection-library-batch-qa.md)，不把本页历史限制当作最新界面状态。

## 范围

- 仅 Basic、API Key、Bearer 的内部秘密表示、编码、可信连接记录解析与只读传输。
- 覆盖现有根身份、索引/Mapping/字段/集群资源、搜索与 PIT 打开/续页/关闭。
- 秘密留在系统密钥库；元信息只保留引用，调用方不能指定任意引用、URL、方法或认证头。
- 连接 ID、端点和凭据绑定同一请求快照，保留取消、迟到隔离及现有超时/并发/大小限制。
- 保留旧连接元信息 IPC 的合同和认证记录拒绝，不开放认证表单、秘密 IPC 或明文保存。

本子项不代表 C01/C04/C05/F08 父任务完成。自定义 CA、代理、权限能力、
用户/API Key 管理与写操作不在本轮范围。

## 实现合同

| 位置 | 实际交付 |
| --- | --- |
| [connection_auth.rs](../src-tauri/src/connection_auth.rs) | `EsAuthMaterial`、版本化密钥库负载、三种编码、敏感头与脱敏错误；解析只接受数据库生成的 `TransportSnapshot` |
| [storage.rs](../src-tauri/src/storage.rs) | `Database::transport_snapshot` 按稳定 ID 读取并封闭已校验记录；不增加 schema 或改变旧元信息合同 |
| [connection_credentials.rs](../src-tauri/src/connection_credentials.rs) | `bind_auth` 复用原有准备/写库/绑定/清理流程，类型与负载由同一材料生成；未开放秘密 IPC |
| [operation.rs](../src-tauri/src/operation.rs) | 计划固定连接 ID、归一化端点、认证类型与引用；未解析的认证计划拒绝发送，不允许跨目标附加认证 |
| [connection.rs](../src-tauri/src/connection.rs)、[lib.rs](../src-tauri/src/lib.rs) | 身份、资源、搜索与 PIT 均从可信快照解析认证并复用现有只读发送路径；数据库锁不跨网络 await |
| [ipc.ts](../src/services/ipc.ts)、[中英文词条](../src/locales/index.ts) | 补齐三种凭据错误码与双语诊断；请求/响应字段、命令注册、认证表单均未扩大 |

密钥库负载为 `ESC` 标记、版本 `1`、认证类型和 u16 大端长度前缀 UTF-8 字段；
版本/类型不符、字段越界、空字段、损坏 UTF-8、尾部多余字节均拒绝。
Basic 使用用户名/密码的 UTF-8 字节并编码一次，用户名不能含冒号；
API Key **保存 ID 与 key 两个组件**，只进行一次标准 Base64 编码，不把预编码字符串再次编码；
Bearer 保存 token 并原样承载，拒绝非可打印 ASCII 和头注入。
本子项用户名/API Key ID 上限各 256 字节，密码/key/token 上限 1536 字节，
最大编码负载 1801 字节，仍受既有 `Secret` 的 2048 字节上限约束。

所有自有材料字段，包括用户名与 API Key ID，使用 `Zeroizing`；
负载、待编码材料与头的拼接缓冲预先定容，敏感内容写入后不再扩容。
`ResolvedAuth` 字段私有，只提供只读访问器；没有接收原始头或任意引用的生产构造入口。
测试专用快照构造器明确以 `#[cfg(test)]` 隔离，不进入生产构建。
每个请求重新读取自己的密钥库引用，无凭据缓存、跨目标回退或自动重试。

旧 `load`、单条元信息读取、保存和删除入口仍拒绝已绑定凭据的记录，
不把它们序列化为已可用的 `auth:none` 配置。当前不能从应用表单创建认证连接；
内部 HTTP 传输的可用性不等于已交付带风险提示的用户认证流程。
Cargo 只把既有锁文件中的 `base64 0.22.1` 声明为直接依赖，没有升级其他依赖或迁移数据库。

## 验证矩阵

下表证据来自当前工作区的单元测试、临时 SQLite、假密钥库与回环 HTTP fixtures，
不使用真实 ES、模型服务或系统密钥库。

| 边界 | 要求 | 当前证据 |
| --- | --- | --- |
| 编码 | 三种精确编码、Basic UTF-8、用户名分隔符、边界与严格解析 | codec 往返与字面量、损坏/版本/类型/尾部拒绝测试通过 |
| 密钥库 | 缺失、不可用、损坏、不匹配类型不降级 | 假后端错误映射通过；缺失秘密前不打开 socket |
| 目标 | 跨连接/端点/基础路径/类型/引用不得复用；重命名保留绑定 | 可信 SQLite 快照、复制篡改拒绝、端点变更不再读取旧引用通过 |
| 请求 | 身份、全部资源、搜索、PIT 使用受限操作和同一认证路径 | 身份、7 种资源、搜索、PIT 开/查/关的路径、头与原始字节 fixture 通过 |
| 传输 | 禁重定向/环境代理、超时/并发/响应限额不退化 | 重定向、独立进程代理环境、共享超时/4 并发/1 MiB 限额 fixture 通过；TLS 默认配置静态核对，非证书实测 |
| 错误与隐私 | 401/403 区分；头注入拒绝；错误、Debug、元信息不回显秘密 | Rust 脱敏与注入拒绝、前端双语诊断和不显示原始详情通过 |
| 生命周期 | 取消/迟到隔离；精度、部分失败与原始字节合同保持 | 认证请求取消释放许可，既有请求注册/响应快照与前端生命周期回归通过 |
| 兼容 | 不新增秘密或任意引用字段；旧元信息合同仍拒绝认证记录 | 5 类读取信封拒绝额外字段；旧存储拒绝与当前前端合同回归通过 |

## 独立检查

主代理在 OMP 正常退出和复审后独立执行：

| 命令 | 实际结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib -- connection_auth:: connection:: operation:: resources:: query:: storage:: connection_credentials::` | 最终 131 通过、4 个真实 ES 用例默认忽略；首轮 126 通过记录不代替最终结果 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline` | 216 通过、6 默认忽略；main 与 doc-tests 均正常退出 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked --offline -- -D warnings` | 通过，无告警 |
| 独立进程代理环境 + `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib -- connection::tests::` | 32 通过、4 默认忽略 |
| `npm test -- tests/unit/ipc.test.ts tests/unit/connection-tests.test.tsx` | 2 文件、47 项通过 |
| `npm run check` | lint/typecheck/正式构建通过；正式测试 709 通过、8 项触发 5 秒超时，后续原型步骤未执行 |
| `npm test -- --maxWorkers=2` | 43 文件、717 项通过；未修改超时阈值或测试配置 |
| `npm run build:prototype` | 单独补跑通过 |
| `npm run test:prototype` | 单独补跑 16 项通过 |
| `git diff --check`、Markdown 解析/本地链接/LF 检查 | 通过 |

代理检查仅在当次子进程把 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 设为
`http://127.0.0.1:9` 并清空 `NO_PROXY`，没有修改用户或系统代理，也没有启动代理服务。
6 项默认忽略分别为 4 个真实 ES 用例、1 个真实 Windows 密钥库用例和 1 个模型网关用例。

`npm run check` 的默认并发运行未整体通过，不能以受限并发复跑掩盖该记录。
超时集中在既有 UI 交互用例，两个 worker 下全部通过；没有修改相关业务逻辑、超时或全局并发配置。
正式构建仍有大于 500 kB 的 chunk 警告（当前 JS 约 894 kB），本轮未做打包拆分。

## 审查记录

- 首轮实现覆盖三种编码和请求族；复审已将用户名/API Key ID 纳入自动清零缓冲区，
  并预分配秘密负载与头拼接缓冲，避免扩容遗留含敏感字段的旧分配。
- 首轮解析器仍接收可修改的 `ConnectionProfile`，`ResolvedAuth` 字段在 crate 内可构造；
  续跑改为数据库独占生产构造的 `TransportSnapshot` 和私有认证字段，封闭头与绑定的独立替换。
- 认证 wire 测试改为经过真实临时 SQLite 与同一快照/解析器，不只测试手工组装的 profile。
  无认证和损坏状态的少量底层单测仍有显式测试构造器，不属于生产入口。
- 前端补齐 `credentialNotFound`、`credentialUnavailable`、`credentialFailure` 类型与中英文词条，
  覆盖身份/资源/搜索/PIT 错误传播与诊断显示，不开放认证配置。
- 原生诊断显示场景已列入 [集中人工验收](manual-acceptance.md)，待后续认证入口接通后执行。
- 零化保证针对自有材料与 scratch 缓冲的 Drop 语义；不通过读取已释放内存验证，
  不宣称第三方 HTTP/TLS 库的所有内存副本都能被应用清零。

## 未验证边界

- 未使用真实凭据、Windows 密钥库、用户 SQLite、ES/模型服务或生产资源。
- 未启动浏览器、WebView、Vite 或持久服务；未构建/运行安装包。
- 带认证 HTTPS 的真实 ES 7.17/8.x/9.x、企业 CA 与代理环境仍需单独授权和验收。
- macOS/Linux 密钥库适配与桌面跨平台仍未验收，不由 Windows mock 自动化推导。
- C05.3/C01.4 后续接认证表单、替换/解绑/删除与诊断，明确 HTTP 未加密风险；
  C04.1 接自定义 CA，C02 接身份/权限/能力，均不在本轮实现声明内。

## 协作与工作区

复用 `E:/project/EScope`，保留接手时六份未提交文档。OMP 独占本子项 Rust 实现，
主代理负责复审、前端错误合同、独立验证和进度文档；没有修改其他业务模块或原型。
没有提交、推送、部署或新建 worktree；没有仍在运行的 OMP 任务。

OMP 会话 `01a11f79-cc9e-7000-b300-641c2a4ba1fc`，初轮与复审续跑均 `completed` / exit 0。
本机归档根为 `C:/Users/Administrator/AppData/Local/Temp/delegate-relay/`，
目录为 `EScope-2026-10-09T07-03-56-380Z` 和 `EScope-2026-10-09T07-41-41-050Z`。
仅用于本机追溯，不提交或公开原始事件日志；实际验证以主代理的独立执行结果为准。

下一小项：C05.3/C01.4 先固定凭据修改、元信息与清理结果的受限 IPC 合同，再接认证表单；
仍需明确 HTTP 未加密提示，不能把内部只读认证通过当作该流程完成。
