# Q03 第二批：有界字段与参数补全

日期：2026-10-10。从干净 `d6cb70d` 接手，沿用 `main`。
状态：开发、领域/真实 Monaco 模型与实例/JSDOM、构建及本地资源引用检查通过；
原生、跨平台、真实 ES 和性能未验。前置为 [编辑器首批](query-monaco-editor-qa.md)。
本批只补正式 DSL 编辑面，不引入 JSON 语言服务、任意 REST、查询执行或新存储合同。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 字段位置 | `query`/`post_filter` 内 term/terms/match/match_phrase/range 的字段键、exists.field；bool 子句与 constant_score.filter 的已知容器；sort、fields、_source 的已知字符串位置 | 不从未知 DSL、nested 查询、聚合、docvalue_fields、脚本或任意字符串猜字段位置；含点名称只使用真实返回的完整名称 |
| 字段证据 | 当前连接 ID、端点与完全相同请求目标的 ready field caps；刷新中/刷新失败/端点替换/连接删除不使用旧证据 | 不自动发现字段，不把证据当权限或 ES 查询/排序成功；保留既有显式目标/资源读取流程 |
| 类型边界 | 有界标量类型；冲突/未知类型不建议，查询位置排除不可搜索，排序排除不可聚合/text/geo_point，已知 nested 后代不作为平面条件建议 | 不猜 keyword 子字段、nested 路径、类型转换、权限或默认值；_source 不建议元数据字段 |
| Runtime | 只读取当前 DSL 的受限 runtime_mappings，显示类型与遮蔽来源，不从视图定义/旧执行补齐 | 无效声明不回退为同名映射字段；runtime 不进入 _source 建议；geo_point 仅返回字段/exists 位置，不显示或执行脚本文字 |
| 参数 | 只在非根、单属性 `{"$param": ...}` 整值占位中补全当前参数定义的名称与类型 | 不插入新占位对象，不补输入值、不修改已保存模板、不读取其他标签定义；未替换参数仍被原执行门控拒绝 |
| 编辑 | 以 jsonc-parser 的词法 token/节点位置生成一个 JSON 转义后的文本编辑，显式选择后可撤销/重做 | 不重序列化整份 DSL，不附加 command/action/additionalTextEdits/snippet；长整数、小数、指数、未知条件与未改转义原样保留 |
| 交互 | Lucide 图标和 Monaco 本地建议列表；无自动弹出/行内建议/共享选择记忆，默认不预选、不用 Enter 或提交字符自动接受 | 按模型 URI 与对象身份隔离；切换标签/目标/参数/字段证据/语言、隐藏/只读及卸载使旧 provider 失效并关闭旧列表；IME 开始关闭建议 |
| 双语 | 来源/类型、空/加载状态、列表与字段/参数可访问名称同步中英文，沿用主题 token | Monaco 0.57 冻结部分原生文案，本地视图适配只更新该实例的文字/ARIA；升级需复验，不改模型/建议内容或全局页面 |

字段键为空或尚无冒号时，只插入 `"字段": `，不猜值；草稿可能仍未完成，原 JSON 门控继续生效。
其余位置仅替换完整字符串 token，或在明确空值位置插入带引号的名称。
光标之外的 JSON 必须可严格解析；评论、重复键、无效转义、未闭合字符串和无法定位的结构不建议。
参数补全只改当前 DSL 文本；参数模板仍由既有参数对话框显式保存/预览/应用。
接受建议沿用普通手改 DSL 的修订号、托管解除和结果过期规则，不修改旧执行/PIT。

## 有界与资源

- DSL 最多 **256 KiB**、JSON 嵌套最多 **64** 层、扫描最多 **100,000** 个 token；
  字段名最多 **1,024 UTF-8 字节**，控制/方向覆盖/通配选择符不建议，转义前缀必须完整。
- field caps 超过 **4,096** 项时不提供该目录的映射字段建议，不截断为完整目录；
  当前 DSL runtime 和参数定义仍各自遵循原有 32 项等合同。
- 在有界目录内先按前缀筛选、去重、排除同对象已有字段键，再最多展示 **100** 项；
  显式列表内继续输入会重新读取当前模型，不使用其他标签的词语。
- 使用现有 jsonc-parser 和 Monaco，无依赖/锁文件、Rust、IPC、schema 变化。
  schema v8、恢复/查询文档 v1、固定库 v3、DSL 快照 v4 保持；补全数据不持久化。
- Monaco 0.57 的 `features/suggest/register` 只注册行内 provider，不能提供建议窗口；
  最终只引入锁定版本的 suggestController。其文本插入引擎处理显式普通文本，
  `${...}`、引号与反斜杠真实实例回归通过；没有启用 snippet 或行内补全来源。
- 延迟 runtime、editor worker/Codicon/字体均为本地文件；仍没有 JSON worker/jsonMode。
  CSP 未改，无新增网络来源、blob worker、unsafe-eval、schema resolver 或远程脚本。

最终构建产物（Vite 十进制 kB）：

| 资源 | 大小 | 说明 |
| --- | --- | --- |
| 主 JS | 1,395.78 kB | 保留大包警告 |
| 延迟 Monaco JS | 3,125.21 kB | 建议窗口在本地延迟包内；不是初始 HTML 脚本 |
| editor worker | 275.63 kB | 本地独立资源 |
| 主 CSS / Monaco CSS | 112.41 / 142.38 kB | 包含原生建议列表样式 |
| Codicon | 153.23 kB | 本地 TTF |

文件存在与引用检查不等于 WebView2/CSP 下已成功加载或显示；原生验收继续开放。

## 本次验证

最终受影响前端 **14 文件 257 项**全部通过，**20 文件 lint**、typecheck/正式构建与本地资源引用检查通过。
早期 6 文件 139 项及单独复验均与最终结果重叠，不累加。

| 检查 | 证据 |
| --- | --- |
| 领域 | 20 个已知字段位置、未知/脚本/nested/聚合位置拒绝；空键/值、完整转义前缀、JSON 注入字符、重复键和 UTF-8/深度/目录/建议配额 |
| 证据 | 连接 ID/端点/目标精确隔离、未检查/刷新中/刷新失败/迟到响应/已删连接；当前 runtime 遮蔽、无效声明不回退、不读取脚本/模板值 |
| Provider/视图 | 匿名 URI、模型对象/cancel/dispose 守卫；目标/证据/语言变化关闭旧建议；只读/隐藏/IME/模态守卫、双语文字与 ARIA |
| 真实 Monaco | 真正 editor.create、建议窗口、显示与显式接受、单步撤销/重做；普通字段及含 `${...}`/引号/反斜杠字段均保留长数值与原文 |
| 工作台 | 显式字段读取后建议、跨标签隔离、刷新失败与旧端点迟到响应不回填；接受/撤销不查询或打开 PIT；原校验/参数/恢复/索引/可视化回归 |
| 构建/资源 | 主包引用延迟 runtime、runtime 引用实际 worker、CSS 引用实际 Codicon；没有 jsonMode/json.worker、远程 importScripts/资源 URL |
| 文档/diff | 25 文件 UTF-8/LF，9 文档/242 本地文件链接/57 张 GFM 表格和 diff 空白检查通过；未生成或复用截图作为本轮原生证据 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/query-completions.test.ts tests/unit/query-monaco-completions.test.ts tests/unit/query-monaco-editor.test.tsx tests/unit/query-monaco-options.test.ts tests/unit/query-monaco-runtime.test.ts tests/unit/query-editor.test.tsx tests/unit/query-editor-models.test.ts tests/unit/query-live.test.tsx tests/unit/query-dsl.test.ts tests/unit/query-parameters.test.ts tests/unit/query-parameters-ui.test.tsx tests/unit/app-workspace-recovery.test.tsx tests/unit/app-index-tabs.test.tsx tests/unit/visual-query-editor.test.tsx
npx eslint src/domain/query-completions.ts src/features/query/editor src/features/query/QueryWorkspace.tsx src/locales/en-US.ts src/locales/zh-CN.ts tests/unit/query-completions.test.ts tests/unit/query-monaco-completions.test.ts tests/unit/query-monaco-editor.test.tsx tests/unit/query-monaco-options.test.ts tests/unit/query-monaco-runtime.test.ts tests/unit/query-live.test.tsx tests/unit/monaco-view-mock.ts
npm run typecheck
npm run build
```

开发中修正：

1. 首轮 4 文件 83 项有 1 项预期错误：无前缀的 exists 空值应返回全部合格候选，不是只有 status；
   将该情形移入空值用例，保留精确插入断言。没有放松实现守卫。
2. 类型检查发现 jsonc-parser ambient const enum 不兼容 isolatedModules，改为本模块的具名词法常量；
   词法仍由现有解析器完成。lint 的控制字符正则改为有界字符码检查。
3. 新增真实建议窗口用例先红：默认 suggest feature 入口未注册触发动作。
   改为 suggestController 后真实显示/接受/撤销通过，避免把 provider 数据成功当作 UI 已接入。
4. 增加原生空状态/ARIA 的视图内双语适配、字面 `${...}` 接受回归和字段前缀集合检查；
   最终回归及构建重新通过。未提高超时或删除安全断言。

JSDOM 中模型与 editor.create 为真实 Monaco；字体测量和浏览器绘制环境仍有替身，
不代表原生像素、剪贴板、IME、worker 或性能通过。
本批主代理独占实现、diff 复查与验证，无 OMP、worktree、持久服务、用户数据库或真实服务操作。
未改 Rust/原型/依赖，不重跑无关全量、fmt/clippy、原型、审计或安装包，不声明本批 CI 已通过。

## 待验与接续

在 [集中人工清单](manual-acceptance.md) 单列：Windows WebView2/macOS/Linux 的本地资源、
Ctrl+Space 与 IME、方向键/Tab/点击/Esc/Enter、长字段与双语/200%/高对比/屏幕阅读器、
列表边缘定位及代码/标签焦点、离线/重启和大目录/大草稿性能。
不自动执行、未知 DSL 原文保留、参数模板独立与结果/PIT 不变需在授权真实环境补验。

下一有界批次按计划第 10.2 节推进 **Q05 已加载文档对比**：复用原始值/执行快照与现有详情，
先限定本地有界比较，不隐式获取额外文档或扩大写入/任意 REST。
Q03 完整原生/性能、深层语法建议、Q02 深层条件/nested runtime、完整六方向与 W01/W04 仍开放。
本批本地提交后仅创建一个 local 后继并更新既有接续监控；不推送，不提前睡眠。
