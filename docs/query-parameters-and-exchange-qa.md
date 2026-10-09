# Q07 参数与本地查询定义交换验收

日期：2026-10-09。起点为干净的 `main` / `155b4fd`。
主代理独占完成实现、审查和定向验证；本批未派发 OMP、未创建 worktree、未推送。
无依赖新增、schema 迁移、原型改动、浏览器/WebView 巡检、真实 ES 或额外持久服务。
状态：**开发/组件/临时 SQLite 与文件自动化通过；原生、真实环境及人工验收未完成。**

## 实际交付

| 子项 | 交付 | 限制 |
| --- | --- | --- |
| 参数定义 | 可选 v1 模板、名称/类型列表；字符串/数值/布尔/空值/对象/数组 | 32 参数；未完成模板可保存，不能预览/交换 |
| 精确应用 | `{"$param":"name"}` 整值节点替换，最终 DSL 预览、当前草稿可检查，显式应用 | 不插值键名/字符串片段/目标；草稿变化拒绝旧预览，应用不执行 |
| 精度与资源 | jsonc-parser 节点偏移和原 token；结构/重复键/类型/未知参数/嵌套占位拒绝 | 模板/最终 DSL 256 KiB、单值 64 KiB、1,000 占位、深度 64/节点 200,000 |
| 恢复 | 查询库/工作区文档 v1 的可选参数子对象，SQLite schema v6 不变 | 只恢复定义；不独立持久化输入值/预览；已应用 DSL 按原草稿/历史规则保存 |
| 交换格式 | `escope-query-definitions` v1，选择查询、审核 JSON、本地读写 | 100 定义/4 MiB；参数化条目导出模板，不导出已应用参数值 |
| 目标映射 | 来源临时 key + 显示标签，本地稳定 ID + 端点或明确未绑定 | 不按名称、当前连接或来源 ID 重绑；写事务内再次核对 |
| 导入存储 | 新 UUID、全量原子追加，同名查询不覆盖；不打开标签或执行 | 普通保存和导入均 CAS，旧/坏/未知库不修复覆盖；未知完成后重试不重复新增 |
| 文件交互 | 原生 JSON 选择、有限读取、UTF-8 校验，同目录临时文件完整刷盘后替换 | 不接收任意路径；取消/失败/已保存分开，处理未返回前不关闭 |

入口与实现：
[参数领域](../src/domain/query-parameters.ts)、
[参数对话框](../src/features/query/QueryParametersDialog.tsx)、
[交换领域](../src/domain/query-exchange.ts)、
[受限服务](../src/services/query-exchange.ts)、
[Rust 交换](../src-tauri/src/query_exchange.rs)、
[查询库存储](../src-tauri/src/saved_queries.rs)。

交换仅含查询定义、模板和来源标签，不含实际连接 ID/端点、认证、凭据引用、CA、
模型、偏好、工作区、执行历史或结果正文；不是完整配置备份或 Kibana Saved Objects 兼容。
嵌套未知字段、已知敏感键和认证形式被拒绝；Rust 使用原始结构切片，特殊数字解析器键名
不能掩盖敏感字段或占位。此检查不是通用秘密扫描器：无标签敏感字面量仍需用户审核，
合法但同名的敏感字段也可能被保守阻止；不自动删字段或改写原查询来通过检查。

输入值关闭后不单独保留，不意味着已应用到 DSL 的值不会被原有草稿/历史保存。
浏览器显式使用 session 内存和用户选定文件；下载请求不代表磁盘已保存，
桌面失败不回退为浏览器/内存成功。原有两类数据导出和执行快照不复用此导入路径。

## 本次自动化

| 检查 | 实际结果 |
| --- | --- |
| 前端定向 | 最终 19 文件 **240 项通过**，`--maxWorkers=2`，未更改超时 |
| Rust `query_exchange::tests` | **11 项通过**：共享格式、精度、秘密排除/私有解析标签、映射、原子新增、CAS、损坏与文件限额 |
| Rust `query_parameters::tests` | **1 项通过**：闭合定义、未知字段/版本/类型、限额与 debug 脱敏 |
| Rust `query::tests` | **20 项通过**：未替换参数拒绝，原有精度、分页、计划/认证合同 |
| Rust `saved_queries::tests` | **10 项通过**：查询库兼容/损坏/限额与已有原子文件 helper |
| Rust `workspace_recovery::tests` | **18 项通过**：可选定义往返、输入值拒绝、v1/修订/隔离及错误 |
| Rust `storage::tests` | **42 项通过**：SQLite/迁移/元信息与恢复跨模块边界 |
| Rust `query_export::tests` | **26 项通过**：受共享查询校验影响的流式导出主模块，非前批整个导出子树 31 项 |
| lint / typecheck | 受影响路径 ESLint、全工程 TypeScript 通过 |
| 正式构建 | `npm run build` 通过；JS 1,026.74 kB，保留 >500 kB chunk 警告 |
| Rust 格式/检查 | `cargo fmt --manifest-path src-tauri/Cargo.toml --check`、生产库 `clippy --lib --locked -- -D warnings` 通过 |
| 文档与补丁 | remark/remark-gfm 检查 9 份文档、113 个本地链接、44 张表格；48 个改动文件 LF/末尾换行及 diff 检查通过 |

各 Rust 行使用独立模块过滤，不标为全量测试或全目标 clippy；
没有重跑原型、完整旧前端/Rust 基线、真实服务、安装包、audit 或 CI。
前端最终命令：

```sh
npm test -- --maxWorkers=2 tests/unit/query-parameters.test.ts tests/unit/query-parameters-ui.test.tsx tests/unit/query-exchange.test.ts tests/unit/query-exchange-service.test.ts tests/unit/query-exchange-ui.test.tsx tests/unit/query-library.test.ts tests/unit/query-library-ui.test.tsx tests/unit/workspace-recovery.test.ts tests/unit/workspace-recovery-hook.test.tsx tests/unit/app-workspace-recovery.test.tsx tests/unit/app-library-integration.test.tsx tests/unit/app-query-integration.test.tsx tests/unit/query-dsl.test.ts tests/unit/query-executions.test.tsx tests/unit/query-editor.test.tsx tests/unit/domain.test.ts tests/unit/workspace-tabs.test.ts tests/unit/query-export-ui.test.tsx tests/unit/query-export.test.ts
```

Rust 各行命令为 `cargo test --manifest-path src-tauri/Cargo.toml <模块>::tests --lib`，
`<模块>` 分别为表中七个模块。共享格式样本为
[query-exchange-v1.json](../tests/fixtures/query-exchange-v1.json)，不含真实数据或秘密。
定向前端覆盖恢复不执行、应用不改旧快照、值/模板改变使预览失效、主机迟到冲突、
同名连接不预选、端点变化阻止导入、文件处理中不能关闭、未知导入回执不伪报/重复新增。

## 失败与修正

- 首轮领域 4 文件 75 项通过；新增 UI/交换测试首跑遇到 fixture URL 被 JSDOM 转为 HTTP、
  测试对象括号错误和包含语法示例的可访问名称不匹配，修正路径/语法并明确模板可访问名称。
- 类型检查先发现测试 mock/UUID 工厂类型和新增 CAS 参数的旧调用缺失；
  Rust 测试编译发现测试 ID 所有权与 `Value` 限定路径问题。修正后相关检查通过。
- 首轮定向 lint 提示 effect 清理中读写变化的 ref；改为稳定的失效回调，复跑通过。
- 复审补充最终净字节/组合深度的限额验证、来源标签冻结，以及 Rust 原始 JSON 切片检查；
  不将中间替换顺序当最终限额，不让数字解析器内部标签跳过秘密检查。
- 新功能 5 文件 63 项、跨模块 19 文件 237 项曾通过；加入最终解析标签回归后为
  19 文件 238 项。交接复查发现未知导入回执关闭后缺少查询库重载入口，补充
  `importUnconfirmed` 状态和重载动作；定向先通过 239 项，再补确定拒绝与未知提交的区分。
  最终 **19 文件 240 项通过**，构建/typecheck/定向 lint 复跑通过。
  这些数字是各轮证据，不相加；所有测试保持原超时阈值。

## 待验与接续

- 原生文件选择、取消/覆盖、实际不可写/磁盘满/系统中断、退出中保存、桌面重启与多进程 CAS。
  临时文件/SQLite 测试不替代这些系统行为。
- 真实 ES 的参数化 DSL、认证/TLS/系统密钥库、性能基准和安装包/跨平台，均未在本轮运行。
- 中英文/主题、窄窗口/大字号/200%、长名称/端点/JSON、原生下拉/IME、快捷键和焦点返回。
  无本轮截图；详见 [人工清单](manual-acceptance.md)，不复用历史截图标通过。
- Q07/F07/Q01 和六方向父任务仍开放。下一批为 C02 精确版本/部署/许可能力子项，
  然后按 [执行计划第 10 节](development-plan.md) 推进；本批提交后只创建一个 local 后继，
  不推送、不提前睡眠。
