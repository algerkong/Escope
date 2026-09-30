# 凭证安全子项验收

## F08.2/C05.2 本批后端（2026-09-30）

- schema v2 增加 auth_kind、credential_ref 和持久 credential_cleanup 队列；迁移按版本事务执行，
  v1 数据/偏好/选择保留，未知版本、损坏引用和不匹配组合 fail closed。
- 新 `connection_credentials.rs` 用真实 Database + 可注入 CredentialStore 编排：
  先持久 prepare 再写新 UUID 秘密；绑定与旧引用入队同事务；失败不覆盖旧秘密。
  解绑、删除和改 endpoint 先断开引用并入队，再清理；重命名保留 ID 与秘密。
- 审查修复提交后错误：metadata 已提交后，清理记账/读取/删除失败返回
  `CleanupPass::Incomplete`，明确 pending/unknown，不抛普通写失败或填 0 假成功。
- 队列查询跳过在用和耗尽重试条目，避免阻塞后面的可处理条目；保留全部待清理统计，
  后端每次最多 64 条。引用不出现在 Debug 或序列化输出，真实秘密不进入 SQLite。
- 旧 IPC 不丢弃新 outcome：恢复纯元信息入口，对已绑定行在事务修改前拒绝；
  legacy load/connection 拒绝认证配置，不伪报 auth:none。新 bind/unbind/outcome 编排只在 Rust 内部，
  当前没有任何秘密 IPC 能创建认证配置，现有无认证流程继续可用。
- 单一 Database/进程内 mutex 的单写者合同；没有跨进程锁，不支持两个进程共享同一 DB
  并发操作凭据。启动恢复接线、秘密载荷与认证协议、带状态的 IPC/UI 均留下一子项。

主代理独立验证：Rust 56 通过/2 忽略；fmt、严格 clippy 通过。
正式前端最后一次全量 142 通过，原型 16 通过；Windows release 构建通过但未运行。
详细前端与构建命令见 [本批验收](desktop-and-query-qa.md)。未访问真实密钥库、ES 或用户 SQLite。
真实 SQLite 故障用 tempfile/内存库和触发器验证，包括提交后 attempt/queue delete 失败及恢复。

OMP 会话 `01a0f153-79f4-7000-a447-4a52bd12ea26`，初轮与审查续跑正常退出：
归档目录 `EScope-2026-09-30T07-59-32-723Z`、`EScope-2026-09-30T08-20-56-293Z`，
位于下文同一临时归档根。第一次接线丢失清理状态的问题经主代理审查退回，最终版本未保留该接线。

## F08.1 历史记录

日期：2026-09-30。平台：Windows。状态：实现与自动化通过；真实密钥库待人工验收。
本轮是 Rust 存储原语，不是认证连接、凭证生命周期或 F08 父任务完成。

## 实现

- `src-tauri/src/credentials.rs`：`CredentialRef` 规范 UUID；固定 service namespace；
  `Secret` 非 Serialize/Clone、Debug 隐藏内容、`Zeroizing` 持有内存，拒绝空/超过 2048 字节输入。
- 主代理审查要求无效输入也先接管再校验，最终在拒绝路径显式 `zeroize()`；
  不能把实现 `Zeroize` 当成自动在 Drop 执行清理的保证。
- `CredentialStore` 为后续编排提供 set/get/delete；Windows `SystemCredentialStore`
  经 `BackendStore` 和 `KeyringBackend` 调用系统凭据管理器。
- 后端缺失与不可用/失败区分、删除缺失幂等、读取非法 blob 拒绝；错误仅稳定 code，
  不回显 OS/keyring 原文。不提供返回秘密的 IPC，不保存到文件或生产内存回退。
- 非 Windows 当前显式 `Unavailable`，不宣称 macOS/Linux 支持。
- `lib.rs` 仅声明模块；Cargo 新增直接 `zeroize` 与 Windows 专用
  `keyring`（锁定 3.6.3，禁用默认 feature，仅 `windows-native`），没有添加前端依赖。

namespace 仅限制寻址，不证明引用属于某连接。F08.2 必须从可信 SQLite 行读取引用，
前端不可任意指定或读取秘密。当前 SQLite 尚无凭据引用，连接输入仍不接受认证秘密。

## 自动化

主代理在 OMP 完成和审查修正后独立运行：

| 命令 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 29 通过、0 失败、2 忽略 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 通过，无告警 |
| `npm run check` | 正式 74 / 原型 16 通过，lint/typecheck/两类构建通过 |
| `git diff --check` | 通过 |

凭证模块 9 项执行、1 项忽略；`cargo test credentials` 过滤还会匹配原有
`storage::tests::credentials_urls_*`，因此不能把该命令的全部通过数记成本模块新增数。

覆盖层级分别为：

- trait 假后端合同：写读替换、删除、故障传播、无降级；fake 仅测试可用。
- 生产 `BackendStore` 配合脚本后端：缺失、幂等、不可用/失败、超限/空 blob、字节传递。
- 生产错误映射：`NoEntry`、`NoStorageAccess`、平台失败与超长错误脱敏。
- 引用规范化拒绝、秘密大小边界、Debug 脱敏、拒绝路径所有权释放；不使用 unsafe 探测已释放内存。

这些测试没有调用真实 Windows 密钥库。真实往返用例默认 ignored，
使用随机独立引用并带 Drop 清理守卫，未执行；系统拒绝/锁定与失败清理仍须真机验收。
无浏览器、WebView、release 打包或真实 ES 请求。

## 下一子项

F08.2/C05.2 需要单一后端任务实现 SQLite 迁移、秘密保存与引用绑定、轮换/删除顺序、
失败补偿及孤儿清理、端点变化隔离、受限 IPC 和中英文错误。
认证网络及 UI 在此合同固定后接入，不能先接受秘密再补安全存储。
跨平台后端、真实系统调用、完整 CSP/IPC 审计仍属于 F08 未完成范围。

## 委派追溯

OMP 会话 `01a0f13f-c1cd-7000-b7bf-0839044a265e`，初轮与审查续跑均 `completed` / exit 0。
本机归档根 `C:/Users/Administrator/AppData/Local/Temp/delegate-relay/`：
`EScope-2026-09-30T07-37-59-660Z`、`EScope-2026-09-30T07-45-03-190Z`。
范围为 credentials、新模块声明及必要 Cargo 依赖；未改变现有存储/网络行为。
所有完成状态以主代理 diff 审查和独立验证为准，没有提交、推送或部署。
