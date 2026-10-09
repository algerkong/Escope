# 模型配置接入与查询分页验收

日期：2026-10-08。范围：A01 模型设置页接入、Q04 PIT/search_after 分页、界面修复与本地 ES 7.17.25 联调。
本记录只描述本轮实际完成与验证；未联调、未人工验收的部分单独列出，历史记录不用于本轮通过声明。

## 实现内容

### A01 模型配置接入（阶段性完成）

- `src-tauri/src/lib.rs` 注册 `models_load` / `models_save` / `models_delete` / `models_select`；
  `models.rs` 头部说明同步为已注册。命令仍是纯配置：无凭据字段、不发送请求、不报告连接状态。
- 前端接入：`locales/index.ts` 注册 `models` 词条；`SettingsView` 的“AI 模型”路由渲染 `ModelPanel`；
  `App` 启动时创建一次 `createModelService()`（桌面走类型化 IPC，浏览器预览走显式会话内存），
  失败不回退。占位文案随替换删除。
- 审查项修复：`validateModelInput` 拒绝额外字段（对齐后端 `deny_unknown_fields`）、按码点计数
  （对齐 Rust `chars().count()`）；`ModelEditor` 增加同步提交锁（同帧双击不会写两次）。
- 新增测试：领域严格校验与码点边界、服务层拒绝额外字段、App 级模型页渲染与跨设置往返保留。

### Q04 快照分页（PIT + search_after）

- 只读操作注册表新增 `resource.pitOpen`（POST `{target}/_pit?keep_alive=1m`）与
  `resource.pitClose`（DELETE `_pit`，body 由已校验 id 组装）；新增内部 `PitSearch`（POST `_search`，无目标）。
  快照生命周期不经元数据读取规划器，绑定凭据的连接一律拒绝。
- `query_execute` 支持可选 `pitId` + `searchAfter`（必须成对出现）：快照 id ≤512 可打印 ASCII；
  `search_after` 为严格 JSON 标量数组（≤16 项、≤4KB）；组合 body 时数字字面量原样保留
  （`arbitrary_precision` + `preserve_order`），草稿自带 `pit`/`search_after` 时拒绝而非覆盖；
  响应回读 `pit_id`（最新值优先，出现但不可用即 `invalidResponse`）。
- 前端结果页新增“加载更多”：首次续页按需开启快照，后续复用最新返回的 id；行按页累积，
  详情弹层按命中来源页切片原文，JSON 视图在多页时标注仅显示最新一页；无 `sort` 的草稿显示
  继续加载所需的说明；快照过期（`notFound`）提示重新执行并丢弃失效 id；重新执行、取消、
  关闭标签、连接变更或卸载都会尽力关闭快照。
- 新增测试：Rust 组合/边界/回读用例 4 项；TS 快照解析 2 项、分页交互 4 项、IPC 2 项；
  新增真实 ES 忽略用例 `local_elasticsearch_71725_pit_pagination_round_trip`
  （开快照 → 续页搜索 `size:0` → 关闭，不读取文档）。

### 界面与工程修复

- 设置页标题焦点框改为贴合内容宽度（此前为整行宽度的黑色描边）；浏览器预览补 favicon，消除 404。
- 桌面实机验证（Windows、本地 ES 7.17.25）：恢复已保存连接并实时加载索引（`.tasks` 系统索引）、
  连接身份确认、集群概览页真实健康数据渲染、融合标题栏窗口按钮在位。截图保存在本机
  `work/shots/desktop-*.png`（work/ 不纳入仓库）。会话随后被系统锁定，剩余 GUI 步骤以自动化覆盖。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | lint / typecheck / 构建通过；正式 324 项、原型 16 项通过 |
| `cargo test --locked` | 121 通过、5 ignored |
| `ESCOPE_TEST_ES_71725=1 cargo test --locked -- --ignored` | 5 通过（身份、资源+查询、集群资源、PIT 往返、Windows 凭据库） |
| `cargo fmt --check` / `clippy --all-targets -D warnings` | 通过 |
| `npm run build:desktop` | Windows release exe 构建成功（约 14.1 MB，未签名，非安装包） |
| 浏览器预览截图 | 查询工作台、设置各页、日夜主题、英文、1024 宽（`work/shots/*.png`，未纳入仓库） |

真实 ES 验证使用用户授权的本机 7.17.25（无认证、只读；未写业务数据、未输出索引名或文档）。
桌面会话在验证中途被系统锁定，锁定后未再驱动 GUI。

## 未完成与边界

- AI 面板仍是配置态：没有模型协议调用、流式输出或取消，模型页也不拉取模型列表（A02 及以后）。
- 分页为顺序前进；没有导出、聚合或可视化条件。`search_after` 需要草稿自带 `sort`，界面已明确提示。
- 快照在首次“加载更多”时才开启：第一页与续页之间可能有窗口外写入；快照过期按提示重新执行。
- 未构建 NSIS 安装包、未做三平台实机验收；本批 UI 与分页的桌面人工验收场景见
  [人工验收清单](manual-acceptance.md)。

## 人工验收待办（摘要）

1. 桌面端在真实索引（含 `sort` 的 DSL）上执行查询并连续“加载更多”，核对行累积、页数提示与 JSON 视图标注。
2. 等待快照过期（约 1 分钟无请求）后再点“加载更多”，确认提示与重新执行路径。
3. 模型页在桌面端新增/编辑/删除/设默认，重启后保留；浏览器预览显示会话内存提示。
