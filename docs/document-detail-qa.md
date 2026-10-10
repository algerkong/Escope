# Q05 已加载文档结构化字段详情

日期：2026-10-10。从干净 `82ee245` 接手，沿用 `main`。
状态：开发、领域/JSDOM/类型检查与构建自动化通过；真实 ES、原生、性能和跨平台待验。
本批扩展既有单条详情，不包含时间上下文、完整字段能力说明或额外文档请求，不关闭 Q05。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 读取 | 从文档对比提取共享 `loaded-document` reader；真实接收页/行与 hit 对象核对，捕获原文和来源 | 不按相同 `_id` 合并或重查，不用显示排序序号定位；真实 ID 未返回时不把位置回退当 ID |
| 目录 | 每个返回容器、数组成员与叶子的 JSON Pointer、实际父子关系、JSON 类型和原文范围 | 相对完整 hit，`~`/`/` 分别转义为 `~0`/`~1`，字面点键不拆分；不猜 ES Mapping/nested 或类型 |
| 来源 | 元数据、`_source`、`fields` 分离；执行 DSL 的 runtime 标记仅附在对应 fields 及子值 | 不从当前草稿/未应用视图推断，不展示脚本文字，不用 source 回填缺失 fields |
| 缺失 | source/fields 容器状态、核心元数据未返回、未返回 runtime 诊断，独立于 null/空数组/空对象 | 缺失只表示未返回；缺失 runtime 为独立诊断行，不伪造空/缺失容器的成员 |
| 交互 | 默认结构化、完整 hit JSON、路径来源筛选/搜索、逐容器/全部折叠与 50 项分页 | 搜索只匹配已加载路径，覆盖折叠项；搜索期间显示匹配项而不改变原折叠状态，不匹配值或扫描索引 |
| 复制 | JSON Pointer、原值/完整容器、完整原始 hit、原接收页，以及原有“复制文档” | 均保留原 token，不受字段显示格式影响；显示缩进不影响复制，剪贴板拒绝可见 |
| 生命周期 | 打开时冻结小型执行来源、完整 hit 和原接收页；新成功快照或离开关闭、关闭释放 | 续页/草稿/端点变化不替换捕获，过期/部分来源可辨；不改 DSL/PIT/结果/列布局或保存目录/搜索 |
| 交互基础 | 原生表格/搜索/分段控件、Lucide 图标、共享 Modal/焦点、双语与主题 token | 字段/值/原文以文本渲染，无 HTML/脚本/外链执行；原生像素/剪贴板/屏幕阅读器仍待验 |

`Copy document` 延续 source 优先、未返回时取 fields 的负载复制；本批也能保留明确返回的
`_source: null` 或其他非对象值，不把 null 当未返回。`Copy raw hit` 单独复制完整 hit；
`Copy raw response` 复制该记录最初的整页，不取后来续页。原接收页只保留已有字符串引用，
不重解析整页，也不作为持久化载荷。结构行只存原文范围，不重复存储祖先/子容器正文。
完整 hit JSON 视图按需使用已有无损缩进器；结构化标量与显式复制继续取原 token。

仅 `fields` 为对象或未返回时增加未返回 runtime 诊断；非对象 fields 原样展现真实 JSON，
不按声明猜字段位置。对象下对应 runtime 的数组/对象子值继承来源标记，`_source` 同名值仍独立。
标题最多显示 160 个字符及省略号，完整 ID 留在元数据与原始 hit；缺失真实 ID 使用通用标题。

## 有界合同

- 单 hit **1 MiB UTF-8**、**64 层容器**、**100,000 token**、数字 **4,096 字符**；
  先扫描再解析，沿用严格 JSON reader，拒绝重复/转义重复键、注释、尾逗号、无效/非对象 hit。
- 目录最多 **4,096 节点**，包括容器、数组成员及必要的未返回诊断；累计 JSON Pointer
  最多 **1 MiB UTF-8**，避免长祖先名称在多条路径中重复放大。显示每页 **50** 项。
- 任一限额超出整次拒绝，不显示截断目录或暗示完整；原结果页的 JSON 入口仍独立存在。
  搜索输入最多 1,024 字符，仅本地目录匹配；这些限额不是原生耗时/内存达标证据。
- 比较仍保留自身的 4,096 项联合上限和精确十进制比较，旧公共限额名称从共享模块重导出；
  本批不改变它的比较语义。无新依赖/Rust/IPC/schema，schema v8、文档 v1、固定库 v3、快照 v4 保持。

## 本次验证

最终前端 **9 文件 222 项**通过，包括新领域 **38**、新 UI **17** 项；
**13 文件 lint**、typecheck/正式构建通过。所有前端测试使用 `--maxWorkers=2`，未提高超时。
此前领域 **91**、首轮 UI 范围 **100/101**、首次完整定向 **222** 与末轮均重叠，不累加。

| 检查 | 本次证据 |
| --- | --- |
| 领域 | 精确整数/小数/指数/负零/转义，字面点键/空名/原型键/斜杠/波浪号和数组关系；缺失/null/空容器/非对象、元数据阴影、runtime 返回/缺失与脚本排除 |
| 有界与身份 | 1 MiB/UTF-8/64 层/数字/token/目录/累计路径配额，重复键/错页/错行/旧 hit 拒绝；深冻结来源、范围与原接收页，后续替换不改副本 |
| 新 UI | 结构化/JSON、来源/路径搜索/折叠/分页、跨接收页/排序、原值/容器/记录/原页复制与失败、长标题/路径、部分结果/端点/草稿警告、双语/预览/焦点 |
| 生命周期 | 新快照复用请求 ID 后旧详情重现反例先红，改为按可用结果快照身份清理；新执行/设置/标签返回不重开，续页不替换内容 |
| 回归 | 原文对比、字段格式原值、宽结果列窗口、真实工作台后端调用计数、执行/工作区恢复保持；详情操作不增加 execute/readResource/PIT/cancel 调用 |
| 构建 | 主 JS **1,455.02 kB**、主 CSS **119.91 kB**；延迟 Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB**，大包警告保留 |
| 文档/diff | 22 文件 UTF-8/LF、8 文档/270 本地链接/62 张 GFM 表格及空白检查通过；无本机配置或秘密 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/document-detail.test.ts tests/unit/document-detail-ui.test.tsx tests/unit/document-comparison.test.ts tests/unit/document-comparison-ui.test.tsx tests/unit/field-formats-grid.test.tsx tests/unit/result-grid-window.test.tsx tests/unit/query-live.test.tsx tests/unit/query-executions.test.tsx tests/unit/app-workspace-recovery.test.tsx
npx eslint src/domain/loaded-document.ts src/domain/document-detail.ts src/domain/document-comparison.ts src/features/query/DocumentDetailDialog.tsx src/features/query/QueryResults.tsx src/locales/document-detail.ts src/locales/index.ts tests/unit/document-detail.test.ts tests/unit/document-detail-ui.test.tsx tests/unit/document-comparison-ui.test.tsx tests/unit/result-grid-window.test.tsx tests/unit/query-live.test.tsx tests/unit/field-formats-grid.test.tsx
npm run build
```

开发中修正：宽表测试新增 JSON 视图步骤时漏导入 `within`，首轮 UI **100/101**；
新测试两处 `getByRole` 不支持的 `exact` 参数、部分结果状态的 TypeScript 收窄同步修正。
这些夹具问题修正后完整 **222** 项通过；独立复审再补快照身份反例，实际失败后修正清理依赖，
最后同一 **9 文件 222 项**、**13 文件 lint** 和正式构建重新通过。

主代理独占实现、diff 复查与验证；无 OMP、worktree、用户数据库或真实服务操作。
未启动浏览器/WebView/预览服务、未构建安装包；未改 Rust/原型/依赖，不重复其全量/fmt/clippy/审计。
不将本次 JSDOM 事件、DOM 数量或构建视为原生、真实 ES、性能或 CI 结果。

## 待验与接续

[集中人工清单](manual-acceptance.md) 保留日夜/强调色/双语/窄窗/200%/高对比、
长路径/值/ID、表头与内外滚动、键盘/展开/分页/焦点返回/屏幕阅读器、原生剪贴板拒绝与重启。
真实授权环境补验投影/FLS/runtime 多值/缺失、同 ID 跨页、部分结果和详情期间没有额外请求。
深层/大数组/长路径的打开/搜索/复制耗时及内存尚无原生基准，不以整次限额拒绝代替性能验收。

下一有界批次 **Q05/O05 字段能力证据说明首批**：完善既有侧栏，同连接 ID/端点/
完全相同目标的当前 field caps；类型冲突、能力限制索引与未知状态分开，
证据不当权限或旧执行事实，不从 JSON Pointer/值猜 Mapping/nested，不统计全索引或自动执行。
共享字段合同若需增量，保留筛选/排序等保守门控并补足定向回归。
时间上下文、完整字段能力/行虚拟化/原生性能、Q03 原生、nested runtime/深层条件及六方向父任务继续开放。
本批本地提交后只创建一个 local 后继并停止仓库写入，更新既有监控，不推送、不提前睡眠。
