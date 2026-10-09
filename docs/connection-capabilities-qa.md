# 版本、部署与许可能力验收

日期：2026-10-10。任务：C02 第二批。接手提交：`2d6571b`，`main`，工作区干净。
状态：开发、临时 SQLite、受控回环 HTTP 与组件自动化通过；真实 ES、许可和原生验收未完成。
本批没有新增依赖、数据库迁移、持久服务、worktree 或 OMP 派发，未修改独立原型。
SQLite schema v6、查询库与恢复文档 v1、参数子对象 v1 保持不变。

## 实际范围

| 范围 | 已交付 | 边界 |
| --- | --- | --- |
| 服务信息 | 精确报告版本、发行/预发布/未识别、构建类型、集群 UUID、Serverless 标记 | `build_flavor=serverless` 才识别 Serverless；默认构建/主机名不推断自建、Hosted、ECE 或 ECK |
| 许可 | 固定只读许可元信息，报告类型、active/expired/invalid、原始精确到期毫秒 | 许可读取成功不等于许可有效或目标操作已授权；未报告到期时间不写成永久有效 |
| 功能证据 | 搜索、PIT、SQL、EQL、ES\|QL、Graph 的证据状态和来源 | 搜索/PIT 不按主版本标可用；四类功能仅解释服务报告，未实际探测操作 |
| 会话缓存 | 只缓存许可和功能报告，单调时钟 60 秒 TTL、最多 16 个连接槽位、显式刷新 | 不缓存身份、角色、目标权限或秘密；不落 SQLite、恢复文档或导出 |
| 交互 | 原身份权限对话框内显示元信息、许可、功能、来源/时间及过期状态 | 打开/关闭/重开、语言/外观变化与过期均不发请求；图标刷新明确绕过缓存 |

C02/D05 父任务继续开放。Q08/G05 的语言或 Graph 执行、写入授权、Cloud ID、多节点与控制面
未在本批开放；这些模块不能把本次报告缓存当作许可或后端授权票据。

## 受限请求

`connection_access` 请求只含 `requestId`、`connectionId`、可选 `index` 和可选布尔 `refresh`。
不接受路径、方法、认证头、正文、权限列表、缓存键或前端声明的版本。
新增 `diagnosticsStale` 错误，连接变化或同连接更新的诊断意图会阻止旧完成结果回填。

一次检查最多五个固定请求，共享现有传输的四并发、单响应 1 MiB 和单请求 10 秒限制，
诊断网络阶段另有 30 秒总预算。总预算耗尽后未发出的检查显示 unknown/timeout，
保留已获得的身份与权限；没有自动重试或写入探测。

1. `GET /_security/_authenticate`。
2. `POST /_security/user/_has_privileges`，仅固定 monitor/read/view_index_metadata。
3. `GET /`，重新读取集群身份与精确报告版本。
4. `GET /_license?local=true`；只有已识别的普通 7.6.0–7.x 发行版固定附加
   `accept_enterprise=true`，避免旧兼容行为把 Enterprise 报成 Platinum。
5. `GET /_xpack?categories=features&human=false`，只选取 sql/eql/esql/graph 的布尔字段。

第四、五步可使用仍有效的报告缓存，前三步始终重新检查。新操作只在内部注册，
不通过 `resource_read` 或任意操作名称扩大公开代理面。全部请求沿用不可变
`TransportSnapshot`、凭据解析、公共 CA、产品响应头、禁止重定向/环境代理和取消约束。
返回前重新核对数据库中的连接/端点/认证引用/CA；删除或变化不回填为当前结果。

许可响应中的 UID、持有者、签发者和额外字段不送入 IPC；构建 hash 只用于内部缓存隔离。
到期毫秒以十进制字符串传输，`u64::MAX` fixture 不被 JavaScript 舍入。
未知/损坏格式、缺失布尔值与重复已知字段不会被当作可用证据。

## 状态解释

| 情况 | 实际状态 | 不代表什么 |
| --- | --- | --- |
| 身份/许可/功能端点 401 或 403 | 该诊断 denied；错误码保留 | 不代表其他已授权索引不能搜索 |
| 404、超时、429、非 ES 产品头、损坏响应 | 该诊断 unknown，保留原因 | 404 不证明 API 被移除，许可启动期也可能暂态 404 |
| 已识别普通 7.x 发行版早于 7.10.0 | PIT unsupported，来源为版本边界 | 7.10.0 及以后仍只是未探测，不自动标可用 |
| 功能 available=true、enabled=true | reported，来源为服务功能报告 | 不等于目标读权限或真实操作验证通过 |
| 功能 available=false、enabled=true | unlicensed | 不等于 HTTP 权限拒绝 |
| 功能 enabled=false | disabled，同时显示两个原始布尔值 | 不把未启用混为 API 不存在 |
| 功能缺失 | unknown / featureMissing | 不按许可类型补造功能，也不把缺失当不支持 |
| Serverless | 版本明确标为兼容性编号；Graph 按部署 unsupported | 不用该版本套发行版规则；若同时报告 Graph 就绪则标证据冲突/unknown |

所有结果都带 `operationVerification=notRun`。前后端共同 fixture 校验上述状态及字段形状；
前端拒绝把版本、许可档位或矛盾的布尔值包装成已验证能力。
本批没有修改已有查询/PIT 执行入口，也没有新增诊断前置门槛。

## 缓存隔离

- 绑定稳定连接 ID、归一化完整端点、认证类型/系统引用、公共 CA 内容。
  更换任一项不复用；重命名不改变后端绑定。
- 再核对本次根响应的集群 UUID、精确版本、构建类型/hash/快照标记。
  UUID 缺失/`_na_`、未知构建或预发布没有可复用指纹。
- 每次新诊断有独立内部代次；旧结果和旧取消不能覆盖新代次的缓存。
  容量淘汰后旧请求不能重新创建已淘汰的槽位。
- 当前身份与 monitor 检查均成功才可复用；拒绝/未知、指纹变化、过期或强制刷新清除旧报告。
  新的许可/功能读取失败不回退到旧成功报告。目标索引权限始终单独按本次输入读取。
- 缓存命中不续期。前端显示原读取时间和缓存来源，并将 IPC 交付延迟计入显示有效期；
  过期只更新本地状态，不后台轮询。
- 服务器侧权限/许可变化不能被离线提前知道。60 秒内的报告仍是历史观测，
  后续真实操作必须重新执行自身的后端权限、目标和许可校验。

## 本次自动化

前端最终命令：

```sh
npm test -- --maxWorkers=2 tests/unit/connection-access.test.tsx tests/unit/connection-tests.test.tsx tests/unit/connection-settings.test.tsx tests/unit/connection-security-service.test.ts tests/unit/ipc.test.ts tests/unit/app-query-integration.test.tsx tests/unit/controls-polish.test.tsx
```

结果：**7 文件 138 项通过**，其中 C02 文件 40 项。覆盖严格 IPC、拒绝伪造支持、
字段排除、精确数字、双语、显式刷新、过期/迟到/取消/卸载和原查询/设置入口。
首轮 C02 38 项，随后增加 IPC 交付延迟用例至 39、删除连接与端点 404 的文案区分至 40；
七文件先后为 136、137、最终 138 项，均通过。连接查找失败使用连接不存在文案，
只有诊断子结果的 404 使用端点支持未知文案。

| 本轮 Rust 命令选择器 | 结果 | 主要覆盖 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib connection_access` | 最终 20 通过 | 版本/Serverless、许可与功能解析、缓存/TTL/连接/代次、固定请求、预算、共享 fixture |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib operation::tests` | 11 通过 | 固定方法/路径/基础前缀、旧版许可参数、禁止目标/正文/任意操作 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib read_only::tests` | 9 通过 | 早到/迟到/重复/跨连接取消 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib query::tests` | 20 通过 | 不改变查询快照、只读计划、精确正文与参数拒绝 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib connection_auth::tests` | 12 通过 | 可信凭据绑定、类型/引用/端点隔离、脱敏和缺失凭据拒绝 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib connection::tests::authenticated` | 4 通过 | 认证搜索/PIT、HTTP 错误/重定向、响应上限和真实 socket 取消 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib connection::tests::every_authenticated_resource_family_carries_the_bound_header` | 1 通过 | 新许可/旧版许可/功能端点同样携带所属快照的唯一认证头 |

上述为 **77 项定向 Rust 测试**，不冒充全量测试，也没有执行 ignored 的真实环境用例。
C02 先后为 16、19、20 项；新增边界及最终 clippy 等价修正后已复跑 20 项。

对应 ESLint（服务、IPC、组件、词条与测试）、`npm run typecheck`、
最终 `npm run build`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、
`cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked -- -D warnings` 通过。
clippy 首轮因 `manual_range_contains` 失败，改为标准 `Range::contains` 后通过，
没有放宽规则或延长超时。复审还修正了未定义的字号 token、交付延迟过期显示和旧版许可参数。
最终 JS 单包约 **1,038.34 kB**，既有大 chunk 警告保留；未运行全目标 clippy、原型或安装包。
已有 remark/remark-gfm 解析 8 份文档、109 个本地文件链接和 39 张表格；
21 个改动文件的 UTF-8/LF/末尾换行与 `git diff --check` 通过，提交前再次核对暂存范围。

## 精确版本证据

| 范围 | 本轮实际证据 | 真实环境状态 |
| --- | --- | --- |
| 7.5.2、7.6.0、7.9.3、7.10.0、7.17.25 | 版本/旧版参数/PIT 边界单测；7.17.25 请求序列 fixture | 本轮未连接真实 ES；7.17.25 的历史只读记录不当作本轮许可通过 |
| 8.16.0、8.16.1、9.1.0、10.0.0 | 解析、精确补丁变化隔离和不猜测可用性 | 均未在本轮真实部署验证 |
| Serverless、未知构建、预发布、坏版本 | 合成响应与冲突/缺失分类 fixture | 未取得 Serverless/Hosted/企业许可环境，不宣称实测兼容 |

## 官方依据

以下页面于 2026-10-10 实际读取；当前 API 文档不能代替目标发行版或真实许可验证。

- [根信息 API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-info)：
  Serverless 通过 `build_flavor` 识别，报告版本不代表实际部署发行版。
- [8.16 功能 Info API](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/info-api.html)：
  固定 categories/human 参数、monitor/manage 前提及 available/enabled 的许可/启用语义。
- [8.16 许可读取](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/get-license.html) 与
  [7.17 许可读取](https://www.elastic.co/guide/en/elasticsearch/reference/7.17/get-license.html)：
  local 范围、monitor、暂态 404、旧版 Enterprise 兼容参数。
- [7.10 PIT API](https://www.elastic.co/guide/en/elasticsearch/reference/7.10/point-in-time-api.html)。
- [Graph 部署边界](https://www.elastic.co/docs/explore-analyze/visualize/graph)：
  Serverless 标为 unavailable。

## 未验证与下一步

- 未使用真实 ES/身份账户/许可、TLS/系统密钥库，没有真实 Graph 或查询语言探测。
  默认/OSS 发行版的部署位置不能仅凭数据面信息确定；跨节点/跨集群路由另属 C03。
- 未启动浏览器/WebView 或额外持久服务。窄窗口、200% 缩放、大字号、焦点/键盘、
  原生对话框滚动、重启缓存清空与跨平台均待 [集中人工验收](manual-acceptance.md)。
- 安装包未重建，真实支持矩阵及父任务不关闭。完整密钥库/部署/许可验收需明确环境和授权。
- 下一批 Q09：先交付稳定连接绑定的有界本地 Data Views 定义、显式选择目标及默认时间字段，
  复用字段发现/查询与恢复约束；字段格式/runtime fields 后续增量。视图恢复/切换不执行，
  修改定义不能重绑旧快照。按 [连续规则](continuous-development.md) 本地提交后创建一个 local 后继。
