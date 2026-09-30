# 第三批手测反馈收口

日期：2026-09-30。用户下班要求停止新增开发，将项目代码和文档分别提交至指定 GitHub 仓库。
本记录是阶段性收口，不将模型准备代码、配置文件或 mock 自动化写成完整产品能力。

## 已集成

- F07/F03：真实 serde 测试复现 `start_ai` 自动映射成 `startAi`，拒绝前端 `startAI`；
  明确 rename/alias 修复，共享 JSON fixture、SQLite 重开/旧数据/失败保留验证，偏好错误改对话框。
- C02/O05/Q04/Q05：封闭 operation 与类型化 IPC；索引、field caps、Mapping、首次 `_search`；
  10 秒/1 MiB/并发限制、禁代理/重定向、取消 future 与有界提前取消记录、部分结果。
  前端固定快照/请求/连接/端点、取消和旧响应隔离、JSON 原文/表格/详情、字段筛选与命令执行。
  被拒绝的异源响应不会保留到 JSON 视图；结果显示原始执行目标。
- O02～O05：设置右侧健康、节点、分片、索引详情，无后台轮询；
  修复标准 `thread_pool.*.rejected` 字段，BigInt 累计、缺失/部分失败、详情原文绑定、分页。
- F03/R01：非数据控件禁选、数据区域可复制；NSIS 当前用户级配置及
  `build:installer:windows`，保留 `build:desktop --no-bundle`。安装包仍未实际构建/安装，未签名。
- 保留之前的融合标题栏、JSON 编辑辅助、Windows 密钥库与凭据生命周期内部编排。

## 独立验证

| 本轮主代理实际执行 | 结果 |
| --- | --- |
| `npm run check` | lint/typecheck/正式构建通过；Vitest 25 文件 314 项通过；原型构建与 16 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 117 通过、4 ignored（3 个真实 ES 用例、1 个真实密钥库用例） |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 通过 |
| 主入口/偏好/查询/打包配置定向 Vitest | 7 文件 72 项通过，随后纳入完整 314 项 |
| 本机 ES 最小只读形状核对 | `_resolve/index/*` 字段形状、受 filter_path 约束的节点线程池字段名通过；未输出索引名/文档 |

没有启动浏览器、WebView、ES 或额外 Vite；1420/9200 原有监听保留。
没有运行本轮 Windows release、NSIS、安装/卸载、真实查询完整用例或跨平台验证。
历史截图继续保留为历史，不能用于证明本轮布局、焦点或桌面 IPC 已通过。

## 未完成

- A01 模型仅准备代码：schema v3 迁移/模型 CRUD、独立服务/组件/词条在仓库；
  `src-tauri/src/models.rs` 尚未被 lib 注册，ModelPanel 和词条未接入应用。
  因而当前 Rust 全量结果不包含该未注册命令模块的正式编译验收。
- 模型下一轮审查项：TS 对额外秘密字段应明确拒绝而非剥离；Unicode 长度合同；
  同步提交锁与写后重读排序；重读失败提示不应暗示成功写入被回滚；陈旧列表防止误覆盖。
  第二轮模型审查简报未派发，没有后台任务在继续处理。
- 模型凭据、真实协议/流式/取消、候选审核与数据授权未实现；没有外部模型请求。
- 查询无 PIT/search_after、导出、可视化条件和虚拟化；当前为返回集合的本地分页。
- 资源读取有响应限额；无完整采样、权限账号矩阵、认证/TLS、恢复诊断或会话曲线。
- 取消只停止本地 HTTP future，不声称 ES 服务端任务已经终止；取消/完成 ID 记录各保留 64 条。
- 索引目标目前限 ASCII 字符集合的名称/通配符/多目标；不支持跨集群或任意 URL/path。
- schema v3 不支持旧版直接降级打开。用户数据库未被读取、删除或重写；迁移测试使用临时库。

## 协作与提交

所有已派发 OMP 及审查续跑均已退出。后端第一轮 relay 的毫秒目录名与打包线碰撞，
worker 正常退出但归档 rename 报错；已从独立临时结果恢复状态，后续使用显式独占目录正常续跑。
临时简报/事件/报告不提交。`.vscode/`、`.claude/`、数据库、凭据、构建产物不提交。
本轮用户授权远程为 `git@github.com:algerkong/Escope.git`，非强制推送；CI 运行结果尚未核验。
