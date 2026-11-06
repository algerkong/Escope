# EScope 开发协作规范

适用范围：项目根目录及所有子目录。子目录有更具体的 `AGENTS.md` 时遵循其局部约定。

## 开发前

1. 阅读 `docs/development-plan.md`（顺序以其为准），确认当前阶段、下一任务及前置条件。
2. 对照 `docs/development-backlog.md`（任务与验收以其为准）的任务 ID 和验收标准，只推进明确的小范围子项。
3. 检查现有文件与工作区变更，保留用户修改，不覆盖或删除无关内容。
4. 开始修改前简要说明任务、影响范围与验证方式。

## 设计依据

- 产品范围 `docs/platform-design.md`（优先于旧文档的只读定位）。主线（2026-10-09）：连接与权限、数据探索、
  保存与导出、聚合与图表、数据管理、地图与关系，按执行计划第 10 节与 backlog 推进；未选方向不自动纳入，
  保留原有 AI/只读观测；图表不等于 Dashboard，Graph/地图守版本/许可/外部数据边界。
- 文档（`docs/` 下）：工程契约 `engineering-contracts.md`、查询语义与执行 `product-design.md`、设置与连接
  `settings-and-shortcuts.md`、视觉/主题/国际化 `competitive-and-visual-design.md`、能力/技术边界/历史 `development-status.md`、
  原型入口 `theme-preview.html`（验证记录 `prototype-qa.md`）。
- 验收记录按领域在 `docs/acceptance/`，批次索引在 `docs/development-plan.md`。

## 实现约定

- 技术路线 React + TypeScript + Vite + Tailwind 4 + Tauri 2/Rust；完成范围以交接状态与验收记录为准，路由占位不算真实能力。
- 保留独立原型及其构建/测试；迁移布局、token、文案与测试场景，不搬用全局 DOM 脚本。
- 代码按 `app`/`features`/`components`/`domain`/`services`/`locales`/`styles` 与 Rust 后端职责分层，目录遵循执行计划；
  复用已有约定，只引入所需依赖，不顺带重构无关模块。
- UI 文案、错误、tooltip、可访问名称同步中英文；界面为简洁紧凑的专业工具风格、无装饰性页面，
  语义 token、Lucide 图标、可见焦点一致，不重新设计既定原型；`primary`/`secondary`/`danger` 只用于动作按钮，
  数据角色用局部类或 `data-*`，标签不继承按钮背景。
- 功能契约见 `docs/engineering-contracts.md`，开发前必须阅读相关章节。

## 交互与安全边界

硬性底线（全文见契约文档）：

- 默认只读，未知操作拒绝；写入须经后端权限校验与绑定目标、最终请求的审核。
- 只经受约束的类型化 IPC 访问后端，不提供任意 URL、方法和认证头代理。
- 密钥只存系统密钥库，不进前端持久化、日志、文档或导出；密钥库不可用或凭据缺失/损坏时不降级为明文或无认证发送。
- 保留默认根、证书与主机名验证，自定义 CA 仅公共 PEM，不加忽略证书校验开关。
- 启动、恢复、连接切换、设置往返、外观/语言变化不自动执行；改写 DSL 须完整预览并显式应用，应用不等于执行。
- 不注入演示连接或数据；真实失败不静默回退 mock，桌面存储失败不降级为内存保存。
- JSON 数值精度、部分失败、取消、数据过期与结果未知按契约处理，不伪装完整成功。
- AI 候选不自动执行，数据发送需授权，跨提供方不静默转发历史或失败请求。

## 验证约定

```sh
npm run dev
npm run build
npm test
npm run check
npm run test:rust
npm run test:ai:gateway
npm run build:desktop
npm run build:installer:windows
npm run build:prototype
npm run test:prototype
```

- `build`/`test`/`check`：正式前端构建、Vitest、lint/typecheck/构建与两类前端测试；末两条仅用于原型；Rust 测试与
  Windows release 构建独立运行；`build:desktop` 出无安装包开发 exe，`build:installer:windows` 出未签名的当前用户级 NSIS 安装包。
- `test:ai:gateway` 为明确授权的本机模型联调：密钥经隐藏输入只传入测试进程，不写入命令/脚本/配置/日志，
  默认 Rust 回归不调真实模型。`tauri dev` 需 1420 端口，已有 Vite 时勿重复启动，换端口 `npm run dev -- --port 1421`。
- 最小充分验证（2026-10-09）：受影响单元/组件测试与对应 lint/typecheck，Rust 跑受影响模块与 fmt，UI/构建链按需构建；
  前端测试 `--maxWorkers=2`、不提高超时阈值；共享 IPC/schema、认证/权限/写入安全保留必要跨模块回归，
  全量测试/严格 clippy 仅在高风险批次或阶段收口，未改原型不重跑。
- 手动测试在功能开发后统一进行（2026-09-30），不反复启动浏览器/WebView/服务巡检；布局、缩放、焦点与原生键盘
  等人工待验场景列入 `docs/manual-acceptance.md`；自动化通过不代表人工验收通过，后者未完成不阻塞无依赖的开发。
- 真实服务只用明确授权的测试环境，不做生产破坏性验证；mock、真实服务、桌面运行与跨平台验证分别记录，
  配置 CI 不等于 CI 通过；无法运行的检查写明原因、影响与补验步骤，不以历史成功冒充本次验证。
- Git：`main`、现有身份、LF，远端 `git@github.com:algerkong/Escope.git`（`origin`）；按 2026-10-09 授权，主代理每批
  验证与交接后提交相关代码/测试/文档，不自动推送；提交前核对暂存范围，排除无关修改、秘密与本机配置（`.claude/`、`.vscode/`）。

## 每次开发后的必做更新

1. 更新本文件「当前交接状态」（日期、任务 ID、实际完成、验证结果、剩余风险、下一步），规则未变也要更新，仅留最新摘要。
2. 在 `docs/development-plan.md` 批次索引追加一行，同步 backlog 受影响任务状态；
   子项通过不代表父任务完成，未联调/验收部分保持待完成。
3. 在 `docs/acceptance/` 对应领域文件追加本批自动化证据与特有待验项，人工验收后再补截图与实际结果，不复用历史截图；
   原型改动更新 `docs/prototype-qa.md`。
4. 命令、目录、架构或安全规则变化时同步本文件与 README，功能契约变化同步契约文档。
5. 最终回复说明实际交付、已运行检查、未验证事项和下一步，不把规划写成成果。

不写入密钥、认证头、真实文档数据或完整敏感日志；本文件不重复任务清单。

## 连续新会话开发

用户 2026-10-09 授权连续开发、不逐项等待确认，范围见设计依据，相邻小项可合并为可验收批次；
流程见 `docs/continuous-development.md`：

- 同一 checkout 仅一个会话写入；本批提交、交接且 OMP 全部退出后才新建恰好一个 local 后继（不建 worktree，
  继承本授权），当前会话随后不再写仓库。
- 未授权的真实服务、密钥、生产写入、签名或人工验收不得伪造完成；受阻时做其他可做项，只剩外部阻塞时明确通知，
  不空转建会话。
- 全部工作真正完成、提交、交接且无相关任务运行后，才按授权让电脑正常睡眠。

## OMP 协作

- 主代理负责依赖排序、简报、文件所有权、diff 审查、独立验证及三份进度文档；OMP 经 `omp-delegate` relay 派发，
  每次一个可验收子项，临时目录存简报与报告。
- 并行可写任务不改同一文件，共享 IPC/schema/依赖由单一任务拥有，其他任务待接口固定后接入；
  OMP 不自行提交、推送、部署或启动额外持久服务（除非该轮明确安排）。
- 状态分“开发中/自动化通过/待人工验收/阻塞”，派发、mock 或接口骨架不记为全功能完成。

## 当前交接状态

- 更新日期：2026-11-06。
- 本批任务：v0.1.0 首个公开版本收口，基线 `6968816`（未推送部分已线性化）；发布准备，不关闭六方向父任务。
- 实际交付：`src/domain/feature-flags.ts` 的 `AI_ASSISTANT_ENABLED = false` 隐藏 AI 面板/切换/模型路由/启动展开开关
  （实现与测试保留，测试以 `aiEnabled` 开启）；新应用图标（暗色 e 形放大镜，源 `src-tauri/icons/icon.svg` 与
  macOS 栅格 `icon-macos.svg`，`node scripts/generate-icon.mjs` 重新生成）与标题栏 logo；中英文 README、MIT LICENSE。
- 历史：未推送的检查点/合并提交整理为线性 `1144378`/`b884a44`/`6968816`（与原树一致），首次发布提交（含旧图标）
  丢弃重做；原提交保留在本地 `backup/pre-cleanup-2026-11-06` 与标签 `backup/v0.1.0-original`，已推送历史未改。
- 文档：功能契约迁入 `docs/engineering-contracts.md`；约 40 份批次 QA 按领域合并为 `docs/acceptance/` 7 份；
  plan/backlog/status/续接/人工清单/Kibana 对照去重，`docs` 与本文件 Markdown 由约 1.0 MB 降至约 0.57 MB。
- 本机 seeder 移至已忽略的 `scripts/local/`（`node scripts/local/seed-es-test-data.mjs`），`.vscode/`、`*.stackdump` 同样忽略。
- 验证：lint、typecheck/正式构建、Vitest 148 文件 2696 项、`cargo check`/fmt 通过；Rust 459 项（6 ignored）为同日
  图标替换前记录，Rust 代码未改。原型未改，不重跑。
- 未验证：安装包实机安装/卸载、真实 ES、原生布局/焦点/IME/高对比/性能、macOS/Linux、代码签名；大包警告保留。
- 下次手动接续：Q06a 会话级注释；AI 入口待运行时/上下文策略/拒绝处理完善后再开启；
  图例筛选、同比环比/公式与图层按服务端语义/定义版本依赖推进。
