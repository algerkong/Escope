# Q03 首批：Monaco DSL 编辑器

日期：2026-10-10。从干净 `6dc36b4` 接手，沿用 `main`。
状态：开发、真实 Monaco 模型/JSDOM 与构建自动化通过；原生、跨平台和性能未验。
前置见 [固定 runtime QA](pinned-runtime-filters-qa.md) 与执行计划第 10.25 节。
本批只替换正式查询 DSL 编辑面，不替换审核对话框、结果 JSON 或独立原型，不关闭完整 Q03。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 编辑面 | Monaco 0.57.0 的 JSON 词法着色、选区、基础行/词操作、撤销/重做、紧凑工具栏 | 原始 DSL 为事实来源，不通过 JSON 数值重序列化，未知 DSL 保留；不提供通用 REST/多请求 Console |
| 模型 | 每工作区按稳定查询标签 ID 持有独立模型、撤销栈与视图，匿名 URI 不带连接/索引/文本 | 切换标签/首页/设置不释放模型；关闭标签/工作区才释放；模型、搜索词和撤销栈不持久化 |
| 同步 | 控制器把外部审核/可视化/格式化结果作为可撤销编辑，抑制反向回调 | 不重复修改草稿修订号或自动执行；挂载不回写模型的换行/BOM 规范化文本，原文版本可精确撤销恢复 |
| 校验 | 沿用 `query-dsl.ts` 的严格 JSON、重复键、参数/runtime 合同，显式校验后显示双语行列和 Monaco marker | marker 不携带解析器原始报错或输入片段；编辑后旧诊断失效；不把本地合法当 ES 授权/脚本编译成功 |
| 格式化 | 沿用 jsonc-parser 的空白编辑，独立撤销点，支持重做 | 未加载/只读/可视化模式不格式化；长整数、小数、指数、转义和未支持条件不丢失 |
| 查找 | 当前模型字面量查找、大小写开关、前后匹配、Enter/Shift+Enter/Esc 与 Ctrl/Cmd+F | 搜索词最多 4,096 字符，计数超过 1,000 明示，导航仍可查完整模型；不解释正则，不修改草稿或执行 |
| 偏好/焦点 | 主题 token、代码字体/字号、密度、换行、减少动态、高对比基色、可见焦点，界面词条中英文 | 设置/语言变化不重建模型；异步完成仅在仍持有加载面焦点时进入编辑器，不抢其他控件焦点 |
| 失败 | 编辑器加载失败保留只读原文和显式重试；旧加载完成不复活已关闭视图 | 不降级到可编辑 textarea 冒充 Monaco；worker 失败显示独立提示，不回显底层错误详情 |

普通索引标签仍使用锁定预览，不创建可编辑索引模型。执行快捷键在编辑器之前仲裁，
继续使用同一个 canRun/快照入口；对话框、IME/229、长按和隐藏工作区保护保持。
没有变化的设置、恢复、查找和标签切换不调用查询/PIT。
模型内部使用 LF；用户实际编辑产生的换行是 LF，未编辑的草稿不会因此被重写。

## 资源与安全

- 新增唯一直接依赖 `monaco-editor: 0.57.0`，不升级现有框架。
  初次安装发现其精确 DOMPurify 3.4.15 有两项 low 公告，使用仅限 Monaco 的 3.4.16 override；
  未运行 `audit fix --force`。最终 `npm audit` 和 `npm audit --omit=dev` 均为 **0**。
- 使用 Monaco 已有 JSON tokenizer（依赖内 jsonc-parser），不自己实现 JSON 语法或数值解析。
  针对锁定版本补充该 tokenizer 导出的窄类型声明，并以真实词法测试验证。
- 不导入默认 JSON 注册入口：该入口即使关闭服务仍把 JSON 语言服务/worker 带进产物。
  最终仅注册词法着色及括号配置，无 schema resolver、JSON worker、补全/远程 hover 或格式服务。
  `$schema` 仅是草稿文本；不请求 URL。字段/参数补全留到下一有界批次。
- Monaco 由查询编辑面首次加载，独立 chunk；editor worker、Codicon 与原有字体都从本地资源加载。
  `getWorker` 仅接收 `editorWorkerService`，其他标签拒绝，无 CDN/任意 worker 地址配置。
  CSP 明确 `worker-src 'self'`，既有 `script-src 'self'` 和 IPC-only connect-src 不变；
  未增加 blob、unsafe-eval 或远程脚本来源。
- 关闭跨文档词语建议、外部链接、隐式格式化、富粘贴/拖入与默认上下文菜单。
  自有查找控件采用 Lucide、双语和既有 token，不引入第二套页面或权限入口。
- Rust 业务实现、schema v8、恢复/查询文档 v1、固定库 v3、DSL 快照 v4 和 IPC 合同不变。
  只调整 Tauri CSP 的本地 worker 显式来源，无真实 ES、用户数据库或系统密钥库操作。

最终构建产物（Vite 十进制 kB）：

| 资源 | 大小 | 说明 |
| --- | --- | --- |
| 主 JS | 1,385.28 kB | 保留原有工作台主包警告 |
| 延迟 Monaco JS | 2,994.85 kB | 不在初始 HTML 中加载，仍有大包警告 |
| editor worker | 275.63 kB | 独立本地文件，不是内联 blob |
| 主 CSS / Monaco CSS | 112.41 / 124.30 kB | 编辑器布局隔离全局表单样式 |
| Codicon | 153.23 kB | 本地 TTF，未引用外部字体地址 |

产物引用检查确认主包引用延迟 Monaco、Monaco 引用实际 worker 文件、编辑器 CSS 引用实际字体；
没有 jsonMode/json.worker 产物。构建与引用存在不代表 WebView/CSP 下 worker 已成功运行。

## 本次验证

前端有效覆盖 **19 文件 213 项**：主体 **19 文件 212 项**全部通过，
随后真实 Monaco 视图补强及工作台 **2 文件 10 项**通过，替换 runtime 原 3 项为 4 项；
重复 9 项不累加。最后快捷键补强 **4 文件 72 项**复验通过，全部重叠，不增加覆盖总数。
另有开发过程中的较早定向复验，不冒充独立覆盖。

| 检查 | 证据与边界 |
| --- | --- |
| 真实模型 | 原始未知 DSL、长整数/小数/指数/转义、BOM/混合换行、单步格式化/重做、外部同步抑制、同 ID 跨工作区、关闭释放通过 |
| 编辑器组件 | 标签选区/滚动/撤销、偏好/双语 marker、只读/隐藏、异步换标签/卸载、失败重试、worker 提示、字面量查找/计数/IME 通过 |
| 真实实例 | 实际 `editor.create`、`executeEdits`、`trigger('undo'/'redo')` 与可访问名称通过；JSDOM 字体测量替身，不是像素/原生证据 |
| 工作台回归 | 查询/PIT/取消/快捷键、索引标签、AI 应用、收藏、恢复、排序/会话筛选、Data Views/runtime 固定、受限可视化与文本选择通过 |
| 静态/资源 | 18 文件 lint、最终 typecheck/正式构建、完整/生产审计 0、最终本地 worker/字体/延迟资源检查通过 |
| 文档/diff | 31 文件 UTF-8/LF、8 文档/230 本地文件链接/53 张 GFM 表格和 diff 空白检查通过；没有本轮原生截图声明 |

主要命令：

```sh
npm install --ignore-scripts
npm test -- --maxWorkers=2 tests/unit/query-editor-models.test.ts tests/unit/query-monaco-editor.test.tsx tests/unit/query-monaco-options.test.ts tests/unit/query-monaco-runtime.test.ts tests/unit/query-editor.test.tsx tests/unit/query-dsl.test.ts tests/unit/query-live.test.tsx tests/unit/app.test.tsx tests/unit/app-index-tabs.test.tsx tests/unit/app-query-integration.test.tsx tests/unit/app-workspace-recovery.test.tsx tests/unit/app-ai-integration.test.tsx tests/unit/app-library-integration.test.tsx tests/unit/app-query-sort.test.tsx tests/unit/app-query-filter-session.test.tsx tests/unit/app-data-views.test.tsx tests/unit/app-pinned-runtime-filters.test.tsx tests/unit/visual-query-editor.test.tsx tests/unit/text-selection.test.ts
npm test -- --maxWorkers=2 tests/unit/query-monaco-runtime.test.ts tests/unit/query-editor.test.tsx
npm test -- --maxWorkers=2 tests/unit/query-monaco-runtime.test.ts tests/unit/query-monaco-editor.test.tsx tests/unit/query-editor.test.tsx tests/unit/query-live.test.tsx
npx eslint src/features/query/editor src/features/query/QueryWorkspace.tsx src/app/App.tsx src/locales/en-US.ts src/locales/zh-CN.ts tests/unit/monaco-view-mock.ts tests/unit/setup.ts tests/unit/query-editor.test.tsx tests/unit/query-editor-models.test.ts tests/unit/query-monaco-editor.test.tsx tests/unit/query-monaco-options.test.ts tests/unit/query-monaco-runtime.test.ts
npm run build
npm audit --json
npm audit --omit=dev --json
```

开发期修正：新版 hover/selectionHighlight 类型差异；测试视图的自引用类型与未使用参数；
模型测试替身未注册 JSON 导致 plaintext 的夹具问题；视图先销毁后的清理顺序保护。
查找订阅真实模型版本，以免外部 DSL 更新后计数停留旧文本。初次完整 JSON 入口带来的额外
约 1,038 kB jsonMode、407 kB JSON worker 和重复样式已从最终构建移除。
最后新增两条断言复现长按执行键/查找框内重复查找键未拦截默认行为；修正后在捕获阶段
消费重复执行/关闭事件但不触发动作，查找框消费 Ctrl/Cmd+F 并保留焦点，防止落到插入行/浏览器查找。
两例先红后绿，4 文件 72 项及最终构建/lint 通过。
没有提高测试超时、删除安全断言或用替身宣称原生通过。

主代理独占实现、diff 复查和验证，本批没有派发 OMP。
未改原型/Rust 实现，不重复其测试、fmt/clippy 或旧全量回归；未构建桌面安装包，也没有 CI 通过声明。
未启动浏览器、WebView、预览服务或真实 ES/模型服务。

## 待验与接续

[集中人工清单](manual-acceptance.md) 单列 Windows WebView2、macOS/Linux：
离线启动及本地 worker/CSP、中文 IME/229、原生剪贴板、撤销分组/光标、快捷键冲突、
Tab/Esc/焦点、字体加载/窄窗口/200%/高对比/屏幕阅读器，以及大草稿性能。
桌面重启只恢复既有草稿定义，不承诺恢复模型或撤销栈；真实 ES 权限/runtime/PIT 未在本批重验。

下一有界批次为 **Q03 第二批字段/参数补全**：只用同目标当前字段证据、
当前已应用 DSL runtime 与参数定义，按 JSON 位置生成有界文本建议；不自动发现字段、
不请求远程 schema、不读取其他标签词语、不把证据当权限，不改写未知/手写 DSL 或自动执行。
完整 Q03、任意深层条件、nested runtime 与 W01/W04 保持开放。
本批按授权本地提交后创建恰好一个 local 后继并更新既有监控，不推送、不提前睡眠。
