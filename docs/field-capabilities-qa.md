# Q05/O05 字段能力证据说明

日期：2026-10-10。从干净 `837336d` 接手，沿用 `main`。
状态：开发、领域/JSDOM/类型检查与构建自动化通过；真实 ES、原生、性能及跨平台待验。
本批只完善既有字段侧栏和它的共享读取证据，不查询 Top values、覆盖率或全索引统计，不关闭 Q05/O05。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 报告 | 保留 searchable/aggregatable/metadata 原布尔或未知状态、类型索引与两个限制索引清单 | 报告与供消费者使用的保守布尔门控分开；未知不伪装服务器明确返回 false |
| 清单 | 未分列、有效空清单、有成员、无效清单独立；保留原顺序/字面名称 | 不从响应根索引集合补类型索引，不从未返回成员推断不存在；坏成员不丢弃后放行 |
| 结构 | 每种类型分别展示能力，冲突可解释；字段的空类型集合仍可见 | 字段/类型非对象、显式类型与类型键矛盾、损坏根索引集合整次拒绝；不选择某一类型冒充全部 |
| 来源 | 会话资源状态记录请求 ID、连接 ID、经响应核对的端点和确切请求目标 | 目标来自发出的请求，不把返回的实际索引集合冒充请求目标；不改变 IPC 或数据库 |
| 当前性 | 侧栏另行核对来源 ID/端点/资源种类/精确目标；刷新中、失败或不匹配隐藏旧字段能力 | 旧缓存可能仍在内存，但不作为当前证据；同目标最近响应不保证集群仍未变化，也不是执行快照 |
| 展示 | 原紧凑字段/元数据展开行、双语/焦点/token；来源正文与索引成员按需挂载，每页 20 个索引 | 原 150 字段上限和名称筛选保持；长名可换行/选择，无 HTML、脚本、猜测子字段或第二套管理页 |
| 失败 | 字段能力拒绝单独提示，与索引列表拒绝和查询授权分开 | 字段诊断失败不阻止用户明确运行有效手写 DSL；不自动重试、执行或静默回退数据 |
| 消费者 | 时间/筛选/nested/排序/可视化/补全继续使用保守门控；格式与当前 DSL runtime 分开 | 本批不改变它们的审核、绑定、脚本或执行边界，不从当前报告解释旧执行值 |

`src/domain/resource.ts` 新增可选 `report`/`indexEvidence`，由实际解析器完整填充，
兼容现有本地类型化投影。侧栏对无报告的投影只显示未知，不从派生布尔重建原报告。
没有可用报告标记、无效类型索引或对应限制清单时，相关能力门控关闭；
存在有效非空限制清单时显示受限并关闭对应门控。明确 false 且没有限制成员时显示不可用。
有效 true 且没有报告限制成员时保留既有门控，但不作为权限、实际查询/排序成功的保证。
报告中的 `metadata_field` 缺失或非布尔独立标为未知。

根索引集合如有重复、空名、非字符串或不是数组则拒绝响应，不向 nested 审核提供部分集合。
可选类型/限制清单同类问题标为无效且不展示部分成员；缺省清单与有效 `[]` 保持不同。
字段类型可从服务已返回的类型键取得，显式 `type` 存在时须一致，不猜其他类型或 Mapping。
本批只按报告显示 `unmapped` 等字面类型；现有服务器排序的显式未映射策略不改变。

`Loadable` 增加可选会话来源，不持久化、不中转凭据；成功资源读取都会记录实际请求身份。
刷新沿用原来的在途取消/代次检查，只有经响应 ID/连接/端点核对后才发布新的成功来源。
更换端点重建侧栏，目标切换重建字段区域，避免同名字字段沿用上一目标的展开状态。
来源默认折叠且正文未挂载，不重新引入预览工具栏的端点；刷新后来源/索引页也不复用旧展开内容。

## 本次验证

前端有效覆盖 **15 文件 616 项**：主体 **15 文件 611 项**全部通过，
随后拒绝诊断/空类型/请求身份补强的 **2 文件 72 项**通过，替换其原 **67 项**，不重复累加。
**11 文件 lint**、最终 typecheck/正式构建通过；前端均使用 `--maxWorkers=2`，未提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 资源领域 45 项 | 原索引/Mapping 回归，原布尔与门控分离、多类型/精确名称、空/缺省/无效清单、坏成员/重复/结构拒绝 |
| 消费者 14 项 | 真实 parseFieldCaps 输出进入平面/nested 筛选、默认时间/时间范围、服务器/可视化排序和补全；搜索/聚合互不冒充，格式与已应用/未应用 runtime 分开 |
| 资源 hook 7 项 | 请求来源与响应索引独立、精确目标顺序/连接/端点/资源键、响应身份拒绝、刷新/失败/替换、迟到/取消与卸载 |
| 新侧栏 19 项 | 类型/限制清单、未知/空状态、来源/页按需挂载、20 项分页、150 字段上限、换目标/新请求页重置、旧证据隐藏、双语/字面文本与拒绝诊断 |
| 工作台 53 项 | 真实前端接线、默认预览无端点 DOM、端点/目标/迟到/字段读取与执行分离；字段拒绝后仍可显式执行，原详情/导出/计数/补全回归保持 |
| 其他领域/UI 478 项 | Data Views、格式、runtime、时间、筛选/nested、排序、补全与可视化的已有有效回归 |
| 最终构建 | 主 JS **1,463.49 kB**、主 CSS **121.80 kB**；延迟 Monaco **3,125.21 kB**、CSS **142.38 kB**、worker **275.63 kB**，原大包警告保留 |
| 文档/diff | 20 文件 UTF-8/LF、8 文档/267 本地链接/57 张 GFM 表格及空白检查通过；暂存范围不含本机配置 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/resource.test.ts tests/unit/field-capability-consumers.test.ts tests/unit/field-capability-ui.test.tsx tests/unit/query-resource-evidence.test.tsx tests/unit/query-live.test.tsx tests/unit/data-views.test.ts tests/unit/data-views-ui.test.tsx tests/unit/field-formats.test.ts tests/unit/runtime-fields.test.ts tests/unit/query-time-range.test.ts tests/unit/query-filters.test.ts tests/unit/query-nested-filters.test.ts tests/unit/query-sort.test.ts tests/unit/query-completions.test.ts tests/unit/visual-query.test.ts
npm test -- --maxWorkers=2 tests/unit/field-capability-ui.test.tsx tests/unit/query-live.test.tsx
npx eslint src/domain/resource.ts src/features/query/useQueryResources.ts src/features/query/ResourceSidebar.tsx src/features/query/FieldCapabilityDetails.tsx src/features/query/QueryWorkspace.tsx src/locales/query-live.ts tests/unit/resource.test.ts tests/unit/field-capability-consumers.test.ts tests/unit/field-capability-ui.test.tsx tests/unit/query-resource-evidence.test.tsx tests/unit/query-live.test.tsx
npm run build
```

开发中修正：首轮四文件 **79/81**，新消费者测试遗漏快照时间，UI 查询把隐藏来源和展开字段的
同名文案混查；随后 typecheck 指出时间单位应为 `minutes`。扩展首轮 **606/611**，
新测试对未应用 runtime 的预期应为更保守的 `runtimeNotApplied`，另有四条原预览回归发现
端点提前进入 DOM。修正为来源正文按需挂载后，同一 15 文件 **611** 全部通过。
最终另补两种字段拒绝、空类型和拒绝后显式执行共四例，相关 UI **71**、lint/typecheck/构建再次通过。
独立复审再补新请求直接完成、加载态被批处理省略的反例，首次确实失败；
字段能力明细增加请求 ID key 后，索引页不再沿用旧请求的展开/分页，最终同一 UI 范围 **72** 项通过。
上述重跑有重叠，不以首次失败或旧批通过冒充最终结果。

主代理独占实现、diff 复查和验证，无 OMP、worktree、用户数据库、真实 ES 或额外持久服务操作。
无依赖/Rust/IPC/schema 变化，schema v8、文档 v1、固定库 v3、快照 v4 保持；
不更改 DSL、查询/PIT、导出/恢复和结果数据，也不保存证据/展开/页码。
未启动浏览器/WebView/预览服务、未构建安装包；未改原型/Rust/依赖，不重复其全量/fmt/clippy/审计。

## 待验与接续

[集中人工清单](manual-acceptance.md) 保留多索引/别名/类型冲突、FLS/诊断拒绝与授权查询分离，
不同 ES 版本和部署的实际返回形状；本批没有真实请求或权限验证。
原生 160px 侧栏、长字段/端点/索引、嵌套展开/内外滚动、20 项分页、键盘/焦点/200%/
高对比/双语/屏幕阅读器、端点替换与重启/跨平台均待验。150 字段和单页 20 索引的
JSDOM 数量不是解析/内存/帧率基准；大型 field caps 目录的整体性能仍开放。

下一有界批次按已满足的 Q02/Q04 依赖推进 **Q06 基础聚合结果读取与展示**：
先核对现有 DSL/结果合同，按执行 DSL/原接收页识别单层指标、terms/date_histogram，
保留原值、null、近似/截断/部分失败与未支持响应的原文入口，不拼合 PIT 续页为全量统计。
只在结果区域增量，图表构建及 Q06a 保存后续推进，不增加 Dashboard 或隐式请求。
Q05 时间上下文/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、nested runtime/深层条件、
W01/W04 与六方向剩余任务仍开放；不是因本子项通过而删除它们。
本批本地提交后创建一个 local 后继，停止仓库写入并更新既有监控，不推送、不提前睡眠。
