# Kibana 功能对照与 EScope 缺口盘点

盘点日期：2026-10-09。源码基线 `cb1a4db`，应用版本 `0.1.0`。
性质：D05 的功能范围调研，不是开发完成声明，也不自动扩大已批准的产品范围。

同日用户确认**连接与权限、数据探索、保存与导出、聚合与图表、数据管理、地图与关系**六方向；
主线见 [执行计划第 10 节](development-plan.md)，新增 Q06a/Q09-Q11/G01-G05 及验收见 [backlog](development-backlog.md)。
下文实现状态是 `cb1a4db` 快照，不因纳入计划或后续交付而改写，后续进展以 backlog 与验收记录为准。
例：同日 C01.3 内部只读认证传输已通过复审与 mock（见 [验收记录](acceptance/foundation-and-connections.md)），
但“ES 网络仍拒绝认证”等描述保留基线；认证表单、真实认证/TLS 与父任务当时未完成。

## 1. 结论与口径

**EScope 已具备桌面查询工作台和基础只读资源浏览，但还不是 Kibana 的完整分析、管理与协作替代品。**
最影响日常使用的缺口：ES 认证连接、查询保存与导出、时间/字段分析、聚合图表、完整查询编辑辅助、
索引和运维管理闭环。Fleet、APM、SIEM、团队协作等是独立的平台级能力。

按 Kibana 主要功能族（[总览][overview]）盘点：Discover、Lens、Dashboard、Maps、Graph、Dev Tools、
Stack Management、报表、告警、Cases、ML、AI、Fleet、Observability、Security。第 3 节 16 个领域、
150 条对照含已有能力与外部依赖，不是“150 个缺失功能”，也不穷举所有插件、API 参数或历史菜单。

边界：

- 当前能力以正式 `src`、Rust IPC/操作注册及数据库迁移为准，不以原型、设计稿或任务名作证据。
- 依据为本次直接读取的 Elastic 文档；GA/Preview/Beta/Experimental/Planned/弃用按具体功能解读，不拼成“所有版本都有”的 Kibana。
- 真实 ES 证据主要是 **7.17.25 无认证环境**，不能推导 8.x/9.x/Serverless/带认证 TLS；本次未重跑服务或测试。
- Kibana 页面、ES API、Elastic Agent/采集器、Cloud 控制台不是同一层；“缺失”不表示加个页面即可，也不表示必须在 EScope 内重做。
- 任务 ID 是 backlog 的关联或前置，不代表承诺整列能力；“待决策”需先定范围和验收再编号。
- 不按菜单数计算完成百分比；编辑器、端点适配、服务端调度、整套 SIEM 的成本不可等量相加。

状态：**已有** = 正式代码已有该能力（仍受人工/跨平台验收限制）；**部分** = 有可用子集，主要工作流/持久化/协议/验收不完整；
**DSL** = 可随合法 `_search` body 提交，缺专用 UI/解析，须目标 ES 支持且未逐项联调；
**缺失** = 无完整正式入口、状态模型与受限后端；**外部** = 需 Kibana、常驻服务、采集器或其他产品，可选集成而非本地界面待补。

六个易误判处：

1. **可视化查询条件不是 Lens**：AND/OR 条件编辑不能生成聚合图表或仪表盘。
2. **模型 API Key 不是 ES 认证**：模型凭据已接入，ES 网络仍拒绝带认证配置的连接。
3. **不是完全不支持聚合、profile、highlight**：原始 body 可携带，缺专用工作流，语义与版本由服务器决定。
4. **别名、数据流并非没有**：设置索引页有基础目录和部分关联，不能管理生命周期。
5. **表头排序不是全索引排序**：只排已加载结果；服务器排序需明确修改并执行 DSL。
6. **有聊天≠数据 Agent 或 ES ML**：不自动检索文档、不自动验证/应用候选，无 ML 作业或 Inference endpoint 管理。

## 2. 当前实现证据（`cb1a4db` 静态核对）

测试文件存在或历史成功不等于本次重跑。

| 核对点 | 代码证据 | 实际边界 |
| --- | --- | --- |
| 页面 | `src/app/routes.ts`、`SettingsView.tsx` | 管理路由为连接、模型、集群、节点、分片、索引；无 Dashboard/Fleet/ML |
| ES 后端 | `src-tauri/src/operation.rs` `ReadOnlyOperation`、`lib.rs` `generate_handler!` | 固定身份、资源、搜索及 PIT；无任意 REST、管理写入或 Kibana 代理 |
| ES 认证 | `operation.rs` `base_url`、`ConnectionPanel.tsx` | 非 `none` 认证被拒；凭据内部编排≠认证网络/UI 接通 |
| 原始 DSL | `query.rs` `validate_search_body`、`src/domain/query-dsl.ts` | 校验 JSON/重复键/资源上限，合法 body 保留原文；非 ES 语义白名单 |
| 可视化 | `visual-query.ts`、`VisualQueryEditor.tsx` | 类型感知条件、平面 AND/OR、size、单字段 sort；nested/复杂 bool 留 DSL |
| 编辑器 | `QueryWorkspace.tsx` | `textarea` + JSON 校验/格式化，非 Monaco/API 补全 |
| 结果 | `QueryResults.tsx`、`QueryResultGrid.tsx`、`useQueryExecutions.ts`、`query-result.ts` `QuerySummary` | 表格/JSON/详情、复制、列交互、部分结果、快照隔离、PIT 续页；只解析 hits/总数/分片/执行信息，无聚合/profile 展示或全量导出 |
| 资源与监控 | `resource.ts`、`IndicesPanel.tsx`、`useClusterResources.ts`、`ClusterOverview.tsx` | 索引/别名/数据流目录，Mapping/Settings 只读；手动读取与请求隔离，无周期采样或历史 |
| 持久化 | `src-tauri/migrations`、`storage.ts`、`App.tsx` | SQLite 存偏好、连接/模型元信息、选择、凭据引用；查询/结果/聊天不跨重启 |
| AI | `AiChatPanel.tsx`、`ai.rs`、`models.rs` | 兼容协议/Ollama、流式多轮、取消、显式草稿附件、模型凭据；无候选审核执行或检索工具链 |
| 现有验收 | [AI 与工作台](acceptance/ai-models-and-feedback.md)、[索引标签与行选择](acceptance/results-and-workspace.md) | 子项与未验边界保留；本次不覆盖人工验收 |

## 3. 功能对照

### 3.1 连接、身份与兼容性

不把 Kibana 部署配置说成连接管理 UI。参考：[部署管理][manage]、[许可证][license]。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 多连接目录、环境标记、稳定身份 | 已有 | 增删改、选择恢复、标签绑定、响应隔离；不必复制 Kibana 登录 | C05、F02b/F02c |
| ES Basic/API Key/Bearer | 缺失 | 内部凭据生命周期已有，表单与请求接线未完成；安全集群受阻 | C01.3、F08.2/C05.2 |
| HTTPS/TLS | 部分 | HTTPS 保留证书校验；自定义 CA、企业证书、mTLS、认证 TLS 未完成 | C04、E01 |
| 当前用户、角色、权限诊断 | 缺失 | 集群名/版本≠登录身份；缺 `_authenticate`、权限检查、能力状态 | C02、W09 |
| 版本/部署/许可证能力矩阵 | 部分 | 有部分版本信息；缺能力缓存、许可证/Serverless 差异、功能门控 | C02、D05、E05 |
| Cloud ID、多节点故障切换 | 缺失 | 无 Cloud ID 解析、节点集群身份一致性、重试策略 | C03 |
| 代理、SSH、企业登录 | 缺失 | 禁用环境代理；HTTP/SOCKS/SSH/mTLS、SSO 不能用任意认证头代替 | E01；SSO 待细化 |
| 跨集群/跨项目搜索 | 缺失 | 多本地连接≠CCS；拒绝 `remote:index`；Serverless CPS 另一套 | E04；CPS 待决策 |

### 3.2 Discover 与日常数据探索

参考：[Discover][discover]、[文档表格][document-explorer]、[Data Views][data-views]。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 打开索引、查询、文档查看 | 已有 | 独立标签、JSON/表格、详情与原文复制、结果快照 | Q01/Q04/Q05、F02 |
| 列宽、顺序、显隐、行选择 | 已有 | 标签内保持；完整虚拟化、大数据性能、跨重启未完成 | Q05、Q07 |
| Data View/索引模式 | 部分 | 可手填多索引/通配符；缺命名视图、默认时间字段、字段格式 | Q09 已纳入 |
| KQL 查询栏 | 缺失 | 无编辑/解析；KQL 不能原样塞进 `_search` | Q10 已纳入 |
| Lucene 查询栏 | DSL | 可用 `query_string`；无语言切换、补全、快捷检索 | Q10 |
| ES\|QL/SQL/EQL | 缺失 | 缺端点、编辑器、结果协议、游标/异步；不能借 hits 解析冒充 | Q08 |
| 全局时间选择器 | 缺失 | 缺相对/绝对/快捷范围、默认时间字段、时区；手写 `range` 不等价 | Q02 |
| 自动刷新、实时追踪 | 缺失 | 无周期查询；将来仅显式启用，不改启动/切换不自动执行 | Q11 |
| 筛选条与固定筛选 | 部分 | 受限条件编辑；缺单元格包含/排除、启停、固定、跨视图携带 | Q02 |
| 复杂布尔组、nested、类型语义 | 部分 | DSL 可写；可视化缺任意嵌套、完整 nested、复杂排序、无损往返 | Q01/Q02/Q03 |
| 服务器多字段排序 | 部分 | DSL 可写；可视化单字段，表头只排已加载 | Q02/Q05 |
| 时间直方图、快速字段图表 | 缺失 | 缺命中分布、刷选、字段转图表；当前页行数≠全查询统计 | Q06 |
| 字段统计与分布 | 部分 | 有类型、searchable/aggregatable、冲突；缺 Top values、覆盖率、空值、基数 | O05、Q06 |
| Runtime fields、字段格式器 | DSL | body 可带 `runtime_mappings`；无字段编辑、脚本预览、格式管理 | Q09；Mapping 更新归 W04 |
| 文档对比、周边文档、详情跳转 | 部分 | 有单文档详情；缺多文档差异、时间上下文、稳定文档链接 | Q05/Q07 相关 |
| 保存搜索、后台搜索、会话恢复 | 缺失 | 标签保持≠Saved Session；缺命名保存、跨重启恢复、后台搜索 | Q07、Q11 |
| 日志模式/变化点/相关性 | 缺失 | 无模式聚类、变化点、相关性；部分依赖新版与 ML | E05 相关；待决策 |

### 3.3 聚合、Lens 与图表

参考：[可视化][visualize]、[Lens][lens]。**Q06 尚未形成图表闭环，不能因 body 支持 `aggs` 记为 Lens 已实现。**

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 指标聚合 | DSL | 可写 count/min/max/sum/avg/stats；缺构建器、指标卡、类型化结果 | Q06 |
| 桶与时间聚合 | DSL | 可写 terms/range/histogram/date_histogram/nested；缺字段/间隔/层级编辑 | Q06 |
| 百分位、基数、管道聚合 | DSL | 缺近似说明、桶截断、派生/移动统计、空桶语义呈现 | Q06 |
| 常用图表库 | 缺失 | 柱/折线/面积/饼/环/指标/仪表/热力/树图/词云/聚合表均无 | Q06 |
| Lens 拖字段与图表建议 | 缺失 | 缺维度/指标配置、类型建议、切换；列拖拽不是构建器 | Q06 分批，不复刻 Lens |
| Formula、时间偏移、百分比比较 | 缺失 | 缺跨指标公式、同期比较、单位归一化、依赖与错误诊断 | Q06 相关；需拆范围 |
| 多图层、双轴、参考线、注释 | 缺失 | 缺跨视图图层、轴/单位、静态/查询注释、阈值线 | Q06 相关 |
| 图表交互与 Inspector | 部分 | 可看原文与原始响应；缺图例筛选、刷选、每图层请求/数据检查、CSV | Q05/Q06/Q07 |
| 可复用可视化库 | 缺失 | 缺保存、引用、复制、标签、删除影响、复用关系 | Q06a；团队库待决策 |
| Vega/Vega-Lite | 缺失 | 缺声明式执行与权限边界；外部数据/表达式不得绕过受限 IPC | 待决策 |

### 3.4 Dashboard

参考：[Dashboards][dashboards]。集群概览是固定只读页，不是可编辑仪表盘。全部缺失、待决策。

| 功能 | 缺口与边界 |
| --- | --- |
| 仪表盘 CRUD 与持久化 | 无对象、面板定义、命名保存、复制、恢复；依赖 F07/Q06/Q07 |
| 多面板布局 | 缺拖拽、缩放、分节、折叠、响应式、编辑/查看状态 |
| 混合面板 | 不能组合图表、Discover 结果、地图、Markdown、图片、链接、SLO/告警 |
| 全局/面板级时间与筛选 | 缺共享上下文、面板覆盖、跨面板筛选、显式刷新；依赖 Q02 |
| Controls | 缺选项列表、范围/时间滑块、ES\|QL 变量、级联过滤 |
| Drilldown 与导航 | 缺到仪表盘/Discover/URL 的参数传递与安全 URL 策略 |
| 分享、嵌入、报表（含外部） | 本地可另做静态导出；权限分享、在线嵌入、定时报表需共享服务或 Kibana |
| API/AI 生成仪表盘（含外部） | 无声明式导入校验、对象依赖、Agent Builder 生成审核；部分接口有新版门槛 |

### 3.5 Maps 与 Graph

参考：[Maps][maps]、[Graph][graph]。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 地理查询与聚合 | DSL | 可写 geo 查询/聚合；无地图呈现、绘制范围、空间筛选 | G01/G02 已纳入 |
| 多图层地图 | 缺失 | 缺点/线/面、热力/聚类、区域着色、样式、tooltip、图层连接 | G01-G03 |
| 时间动画与资产追踪 | 缺失 | 缺轨迹、时间滑块、联动、地理围栏告警 | G03；服务端告警不在主线 |
| GeoJSON/shapefile 导入 | 缺失 | 真实写入，需文件解析、坐标/Mapping 校验、逐项失败 | G04，依赖 W03/W04 |
| 底图、EMS、离线地图 | 缺失/外部 | 需地图源、网络/授权策略、离线方案，不默认访问外网 | G01；地图源子项确认 |
| Graph 关系探索 | 缺失 | 无 Graph API、节点/边展开、采样、阻断词、布局保存、回溯文档；Serverless 不可用 | G05 已纳入 |

### 3.6 Dev Tools 与查询诊断

参考：[Query tools][query-tools]。Console 能访问的 API 不代表都有专用表单。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| JSON 校验、格式化、原文保持 | 已有 | 重复键、错误定位、格式化撤销、数值字面量保持；非 ES 语义校验 | Q01/Q03 |
| Monaco/API 补全 | 缺失 | 缺端点/字段/参数建议、高亮、内联文档、版本匹配 | Q03 |
| REST Console | 缺失 | 缺多请求解析、执行当前/全部、变量审核、历史、curl 导入/脱敏复制 | W11 |
| Kibana API Console | 缺失/外部 | 无 Kibana 连接、Space 路径与权限适配；不能把 Kibana API 发给 ES | 待决策；与 W11 分离 |
| Search Profiler | DSL | 可写 `profile:true`；缺分片/阶段耗时树、聚合耗时、对比 | Q05/Q06 或 W11 子项 |
| Explain、highlight、suggest | DSL | 缺评分树、高亮/建议展示；`_explain` 等端点未接 | Q03/Q05、W11 |
| Grok Debugger、Analyze | 缺失 | 缺模式调试、token/position/offset、分析器绑定、错误定位 | W05/W11 |
| Painless Lab、脚本管理 | 部分 | body 可写允许的脚本；无 Lab、上下文模拟、存储脚本管理、审查 | W05/W11；Lab 待决策 |

### 3.7 索引、数据与生命周期管理

参考：[Index Management][index-management]、[Ingest pipelines][pipelines]、[ILM][ilm]、[快照恢复][snapshots]。
写操作须先完成 W01/W02 的后端授权、审核和任务状态，不能只加按钮。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 索引/别名/数据流目录 | 部分 | 有目录、属性、部分关联；缺健康/容量/统计、生命周期、大目录体验 | O05 |
| Mapping/Settings | 部分 | 只读与复制；缺结构化编辑、diff、字段新增、设置校验、模板来源 | O05、W04 |
| 索引创建和操作 | 缺失 | 创建/删除/open/close、refresh/flush、清缓存、force merge、split/shrink | W04/W11 |
| 索引模板与组件模板 | 缺失 | 无只读页；缺版本/优先级/匹配/组合、模拟、增改删 | O05、W04 |
| 别名管理 | 部分 | 可见名称与目标；缺 filter/routing/write index、原子切换 | O05、W04 |
| 数据流管理 | 部分 | 可见名称、backing 数、时间字段；缺详情、写索引、rollover、保留期、失败存储 | W06；失败存储需细化 |
| 文档 CRUD/bulk | 缺失 | 详情只读；缺乐观并发、冲突、批量逐项错误、安全重试；Kibana 多靠 Console | W03 |
| 文件导入/导出 | 缺失 | 缺 CSV/JSONL 预览、类型/编码、Mapping、进度、流式导出；复制 JSON≠导出 | W03、Q07 |
| Ingest Pipeline | 缺失 | 缺 processor 编辑、顺序/条件、simulate、逐步结果、版本、失败分支 | W05 |
| Enrich、同义词 | 缺失 | 缺策略/集合、预览、执行、状态、版本；不同于查询条件 | W05 |
| ILM | 缺失 | 缺策略、阶段、rollover、explain、错误重试、关联索引；Serverless 不支持 | W06 |
| DSL Lifecycle/Downsampling | 缺失 | 缺保留期、降采样、数据层/部署差异；不与 ILM 或已弃用 Rollup 合成一个开关 | W06 相关；需细化 |
| Reindex/按查询更新删除 | 缺失 | 缺源目标校验、限速、异步追踪、冲突、结果核验；Kibana 多靠 Console | W03/W07/W11 |
| Transform | 缺失 | 缺 pivot/latest、预览、目标索引、checkpoint、启停、错误、持续同步 | W07 |
| 快照仓库、快照、SLM | 缺失 | 缺仓库注册/验证、列表/详情、创建、计划、保留、部分失败；本地文件夹≠服务端仓库 | W08 |
| 恢复、Searchable Snapshots | 缺失 | 缺重命名/冲突预检、全局状态/feature states 审核、完成追踪；部署/许可单列 | W08 |
| Remote Clusters/CCR | 缺失 | 缺远端连接、复制/auto-follow、lag、暂停恢复、版本/权限检查 | E04 |

### 3.8 Stack Monitoring 与运维诊断

参考：[Monitoring][monitor]。有当前统计≠有历史监控。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 集群分配健康 | 部分 | 健康页与状态语义；缺趋势、事件、证据链、深层诊断 | O02 |
| 节点指标/详情 | 部分 | 可读 JVM/磁盘/OS/进程/线程池；缺连续速率、GC 趋势、重启基线、热线程 | O01/O03/O06 |
| 分片列表/分配诊断 | 部分 | 主副本/状态/基础原因；缺矩阵、恢复进度、allocation explain、deciders | O04 |
| 分片修复与 reroute | 缺失 | 无 dry_run、重新核验、执行审核；不能拖动分片立即变更 | W10 |
| 采样、曲线、保留与配额 | 缺失 | 缺共享采样器、退避、断点、历史样本、速率、可控保留 | O01/O06 |
| 索引性能与集群任务 | 缺失 | 缺查询/写入速率、缓存/breaker、pending tasks、任务列表与取消 | O01/O03、W02/W11 |
| 慢日志、Query activity | 缺失 | 缺慢查询/查询日志、运行查询列表、来源追踪；Query activity 为预览 | O03/W11 相关；待决策 |
| 全 Stack 监控 | 外部 | 无 Kibana/Logstash/Beats/APM Server 监控，需采集与历史存储 | 待决策 |
| Upgrade Assistant | 缺失 | 缺弃用检查、兼容/旧索引迁移、升级阻塞诊断；不替用户升级 ES | D05/E04/R04 相关；待决策 |
| AutoOps | 外部 | 需 Elastic 服务/Cloud Connect 或自建体系，不能称本地规则等价 | O02 可参考；待决策 |

### 3.9 权限、安全管理与空间

参考：[部署与身份][manage]、[Spaces][spaces]、[许可证][license]。这是管理权限，不是 SIEM。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 只读与受限请求 | 已有 | 固定操作注册、未知拒绝、秘密分离、响应隔离；非完整用户授权系统 | F05/F06/F08 |
| 数据编辑/运维访问模式 | 缺失 | 缺模式升级、服务器权限校验、审核票据、有效期、最终请求绑定 | F06、W01 |
| 用户、角色、角色映射 | 缺失 | 无列表/编辑/权限 diff/保留身份保护；区分用户管理与外部 SSO | W09 |
| ES API Key 管理 | 缺失 | 缺创建、作用域/到期、失效、一次性展示；AI 模型 Key 不覆盖 | W09 |
| DLS/FLS、SSO、会话治理 | 缺失/外部 | 依赖服务器权限与订阅；本地隐藏列≠字段级授权，连接分组≠用户隔离 | C02/W09/E01；待决策 |
| Kibana Spaces/多用户共享 | 外部 | 无空间、对象级访问、团队身份；本地连接/标签≠Space | 待决策 |
| 审计与操作历史 | 缺失 | 无完整流水与主体/目标/最终状态；客户端记录不替代服务端审计 | W02、R04 |
| 许可证/功能权限管理 | 缺失 | 无许可证读取、到期提示、功能矩阵、受控变更 | C02/E05；变更需 W01 |

### 3.10 保存对象、组织、分享与报告

参考：[Saved objects][saved-objects]、[Reporting][reporting]。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 收藏、历史、参数化查询 | 缺失 | 查询名与内存标签不是收藏库；缺搜索/管理、参数、安全重开、保留 | Q07/F07 |
| 查询与聊天跨重启恢复 | 缺失 | 持久化不含草稿/结果/聊天；恢复不得自动查询或重传 AI 历史 | Q07；AI 会话需细化 |
| Saved Objects/NDJSON | 缺失 | 缺对象、依赖引用、冲突、迁移、导入导出；自有 JSON 不兼容 Kibana | 待决策 |
| Tags、Files、统一对象检索 | 部分 | 有命令面板与快速跳转；缺跨对象搜索、标签、收藏组织、共享资产 | F04/Q07 基础；待决策 |
| CSV/JSONL 数据导出 | 缺失 | 缺范围选择、流式写文件、取消、部分文件标记、数值精度、公式防护 | Q07 |
| PDF/PNG 报告 | 缺失 | 缺打印布局、渲染队列、下载与错误；官方为订阅功能，有 Serverless 限制 | 待决策 |
| 定时报表与分发 | 外部 | 无调度、后台任务、认证链接/邮件；本地即时导出可独立做，不承诺关机后执行 | 待决策 |
| 分享链接、短链、嵌入 | 外部 | 无共享托管与访问控制；导出文件/本机路径不是团队分享 | 待决策 |
| 高级设置与个性化 | 部分 | 主题、语言、字体/密度/启动偏好；无按空间配置、分析默认值、服务端设置 | F03/F03a；其余待决策 |

### 3.11 Alerting、Cases、Watcher 与 Workflows

参考：[Alerting][alerting]、[Cases][cases]、[Watcher][watcher]、[Workflows][workflows]。
**O07 是本地通知，不能等价覆盖 Kibana 服务端规则执行。**

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 阈值/查询/地理等规则 | 缺失 | 无规则定义、调度、分组、阈值、预览、执行状态 | O07 本地子集；规则待决策 |
| 告警生命周期 | 缺失 | 缺触发/恢复、去重、静默、snooze、维护窗口、执行历史、失败诊断 | O07 子集；服务端待决策 |
| Actions 与 Connectors | 外部 | 无 Email/Slack/Webhook/PagerDuty/Jira/ServiceNow 连接器、测试、秘密管理 | 待决策 |
| 可靠后台调度 | 外部 | 桌面关闭/休眠后不能可靠执行；需 Task Manager、Watcher 或常驻服务 | O07 边界；架构待决策 |
| 告警面板和检索 | 缺失 | 无规则/告警列表、筛选、实例详情、图表跳转 | 待决策 |
| Cases 事件协作 | 外部 | 无负责人/状态/评论/附件、告警关联、模板、自定义字段、工单同步 | 待决策 |
| Watcher | 缺失 | 无 watch 列表/编辑/模拟/执行记录；引擎在 ES，非 Kibana Alerting；Serverless 不可用 | E05/W11 |
| Elastic Workflows | 外部 | 无 YAML 编排、手动/计划/告警触发、条件/循环、重试、人工审批、运行追踪 | 待决策 |
| 实验性新版告警 | 外部 | ES\|QL rule events/alert episodes 为 Experimental，不与 GA 告警混算 | 待决策，非近期 |

### 3.12 Machine Learning 与 AIOps

参考：[ML][ml]、[Discover][discover]。模型聊天设置不属于 ML 管理；各项需单独确认角色、许可与部署。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| Data Visualizer | 缺失 | 无字段统计探索、采样配置、文件结构识别、ML 前检查 | Q06/W03 相关；待决策 |
| 异常检测作业与 datafeed | 缺失 | 无单/多指标、分类/总体分析、创建/启停、内存/延迟数据、状态 | E05 |
| Anomaly Explorer/Single Metric Viewer | 缺失 | 无异常分数、影响因子、swimlane、时间钻取、解释 | E05；图表待决策 |
| 预测、日历、过滤器、模型快照 | 缺失 | 无 forecast、日历事件、custom rules、快照恢复、作业配置导入导出 | E05 |
| Data Frame Analytics | 缺失 | 无离群点、分类、回归、训练评估/特征重要性、结果探索 | E05 |
| NLP/训练模型部署与测试 | 缺失 | 无下载/导入、部署/分配、推理测试、状态；聊天模型≠ES trained model | E05 |
| AIOps 日志模式/速率/变化点 | 缺失 | 无日志类别、波动解释、显著字段、变化点；新版 Discover 另有可用性标记 | E05 相关；待决策 |
| ML 告警与分析集成 | 缺失 | 无作业健康/异常告警、Dashboard 面板、受控诊断链 | E05；告警/仪表盘前置 |

### 3.13 搜索产品与 AI 工作流

参考：[Elasticsearch solution][search-solution]、[Agent Builder][agent-builder]；Playground/Search Applications 见第 4 节。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 多模型对话与模型设置 | 已有 | 兼容协议/Ollama、手填/发现模型、系统密钥库、流式/取消、显式附件；原生协议未全覆盖 | A01/A02、E02/E03 |
| AI 查询候选审核 | 缺失 | 缺结构化候选、字段/schema 校验、版本冲突、diff、明确应用；聊天输出 DSL 不算闭环 | A03/A04 |
| AI 结果/诊断解释 | 部分 | 可聊天与附加草稿；缺授权的结果/统计上下文、证据溯源、样本范围、图表 schema | A04/A05 |
| 用途模型/参数/费用策略 | 部分 | 配置与选择已有；缺 UsagePolicy、能力感知参数、用途默认、费用与上下文预算 | A01、E02/E03 |
| 向量/语义/hybrid/rerank | DSL | body 内可写；缺向量输入、embedding 授权、评测、版本门控 | Q02/Q03/E05 相关 |
| Inference endpoints | 缺失 | 无服务/任务类型配置、部署、推理测试；与聊天 provider 不同 | E05 |
| Query Rules、同义词、相关性调优 | 缺失 | 无规则集、pin/exclude、条件、规则测试、检索评测 | W05 同义词；其余待细化 |
| Agent Builder/RAG/工具调用 | 外部 | 无检索工具、自定义 agents/tools/skills、MCP/A2A、会话 API、受权限执行链 | A03/A05 不完整覆盖；待决策 |

### 3.14 数据接入、Fleet 与 Integrations

参考：[Fleet][fleet]、[Ingest pipelines][pipelines]。

| 功能 | 状态 | 缺口与边界 | 任务 |
| --- | --- | --- | --- |
| 文件上传与接入向导 | 缺失 | 无格式探测、Mapping/时间字段建议、pipeline 预览、导入任务 | W03/W05 |
| 集成包目录和资产安装 | 外部 | 无 Integrations 搜索/安装/升级、预置 Dashboard/Pipeline/Data View 依赖 | 待决策 |
| Fleet agents 管理 | 外部 | 无 enrollment、状态、升级、unenroll、批量、日志与诊断 | 待决策 |
| Agent/Integration policies | 外部 | 无输入/输出、策略版本、下发状态、API key、Fleet Server 地址 | 待决策 |
| 数据流质量与采集诊断 | 缺失/外部 | 无吞吐/延迟/失败视图、字段质量、丢弃/失败文档、关联策略 | W06 相关；待决策 |
| Osquery | 外部 | 无 live query、pack、计划、结果、访问控制；不是发一条 SQL | 待决策 |
| Logstash 集中管道 | 外部 | 无配置/分发/监控，依赖 Logstash 与订阅；不同于 ES ingest pipeline | 待决策 |
| 内容连接器与爬虫 | 外部 | 无外部源同步、凭据/ACL/调度/增量；区分现代连接器与已退出的 Enterprise Search | 待决策 |

### 3.15 Elastic Observability

参考：[Observability][observability]。均无专用工作流；能搜日志索引≠支持可观测性产品。除 Logs（DSL，Q02/Q05/Q06 可复用）外均为外部、待决策。

| 功能 | 缺口与边界 |
| --- | --- |
| Logs 探索与排障 | 能查日志文档；缺专用视图、上下文、模式、数据集质量、跨信号关联 |
| Streams | 无日志流接入/结构解析/路由/保留/质量管理与 AI 辅助 |
| Infrastructure/Hosts/Containers | 无主机/容器/Kubernetes 清单、指标趋势、资产拓扑；ES nodes 只代表 ES 节点 |
| APM | 无 service inventory、transactions、trace/span waterfall、依赖图、错误关联、agent 配置 |
| RUM/User Experience | 无浏览器真实用户性能、地域/页面体验、会话与 Web 指标 |
| Synthetics | 无 HTTP/TCP/ICMP/browser journey、多位置探测、截图/步骤排障、证书到期监控 |
| Universal Profiling | 无持续 profiling、火焰图、堆栈对比、CPU 成本 |
| SLO/SLI/Error Budget | 无目标定义、SLI 聚合、预算消耗、burn-rate 告警、可靠性视图 |
| 事件响应、AI/LLM Observability | 无跨信号调查、专用助手、LLM 性能/用量/费用观测；聊天面板不等价 |

### 3.16 Elastic Security

参考：[Security][security]。依赖安全数据、检测引擎和响应组件的独立产品，不是用户/角色管理扩展；全部外部、待决策。

| 功能 | 缺口与边界 |
| --- | --- |
| SIEM 规则与检测引擎 | 无预置规则、自定义查询/EQL/阈值/ML 检测、例外、执行与告警管理 |
| Timeline/调查工作台 | 无事件证据编排、时间线模板、笔记、进程/事件关联、调查分享 |
| 主机/网络/用户/实体风险 | 无威胁情报、实体存储、风险分数、资产关联、异常行为分析 |
| Elastic Defend/EDR 响应 | 无终端策略、恶意软件防护、进程调查、主机隔离与响应；需 Endpoint/Agent |
| Cloud/Kubernetes Security | 无 CSPM/KSPM、漏洞、工作负载保护、基准检查、修复证据 |
| AI Assistant/Attack Discovery/EASE | 无安全上下文检索、跨告警攻击关联与分诊；部分为 Serverless 特有 |
| 安全 Cases 与外部响应平台 | 无团队案件、告警证据、流程联动、第三方同步 |

## 4. 版本、许可证与不宜照搬的功能

以下为官方文档描述，不推定用户环境或已发布版本。

| 项目 | 核实的边界 | 对 EScope 的建议 |
| --- | --- | --- |
| 7.17 与新版 | 本机实测为 ES 7.17.25，ES\|QL、Agent Builder、Workflows 不能在该基线承诺 | D05/C02 先锁精确版本、部署、权限，不因 UI 出现标可用 |
| Agent Builder | Stack 9.2 Preview、9.3 GA，需订阅/Serverless feature tier | 独立集成或自有 AI 路线决策，≠A02 聊天 |
| Workflows | Stack 9.3 Preview、9.4 GA | 需服务端执行、身份、审批、操作策略；不是桌面定时器 |
| 新版预览能力 | Query activity、部分图表/对象 API、实验性告警、Custom panels 各有 Preview/Experimental/Planned | 单列跟踪，不进跨版本默认清单 |
| Painless Lab | Beta | 可调研，不当稳定工具 |
| TSVB/传统聚合编辑器 | Legacy，推荐 Lens；部分入口仅对已有内容显示 | 优先基础聚合/现代图表 |
| Timelion | 7.10 起弃用、Serverless 不可用 | 不作优先项，最多旧资产查看/迁移 |
| Canvas | 仅升级且已有 workpads 的安装可用 | 不当必备入口，暂不复制自由画布 |
| Rollup | 8.11.0 弃用，建议 downsampling | 不新增路线；保留旧版兼容调查 |
| Uptime | 8.15 起弃用，建议 Synthetics，Serverless 不可用 | 扩展探测按 Synthetics 评估 |
| Playground | 9.4 弃用，正文列 9.6 移除，元数据仍有 Planned for removal | 记为弃用/移除路线，安装另核；优先看 Agent Builder |
| Search Applications | Beta；不推荐 9.x 新用户，9.2 起新用户 UI 隐藏，Serverless API-only | 与 App Search 分开，非首发必须 |
| App/Workplace Search、旧 Web Crawler | Enterprise Search 自 9.0 不再提供；现代内容连接器不因此消失 | 仅旧部署迁移需求再评估 |
| Serverless | 无节点/分片管理；ILM/Watcher/Graph 与部分报表不可用，CPS≠CCS/CCR | 独立能力门控，不把“平台不提供”报成权限错误或故障 |
| 订阅与 feature tier | ML、Graph、Watcher、DLS/FLS、部分连接器/报告需逐项核对；PDF/PNG 为订阅 | 不笼统写全免费/全付费；自建/Hosted 看许可证，Serverless 还看 tier/add-ons |
| Cloud 控制面 | 账单、组织、部署创建/扩缩容、区域/实例、ECK/ECE ≠ Kibana 数据面 | 非核心必补；集成需独立 API 与凭据边界 |

依据：[Timelion][timelion]、[Canvas][canvas]、[Rollup][rollup]、[Uptime][uptime]、[Playground][playground]、
[Search Applications][search-applications]、[升级准备][upgrade]、[许可证][license]。

## 5. 与计划的映射与范围决定

逐任务进度与验收以 [backlog](development-backlog.md) 为准；下表只记盘点日的能力组归属与用户范围决定。
范围确认只新增待开发任务，不将 D05/E05 或任何业务父任务标记完成。

| Kibana 能力组 | EScope 任务 | 决定 | 原因/边界 |
| --- | --- | --- | --- |
| 认证/CA、权限、Cloud/多节点、高级网络 | C01-C04、F08、E01 | 纳入 | 凭据内部编排与无认证联调只是子项 |
| Discover、Data Views、KQL、时间/字段、复杂条件 | Q01-Q03/Q05、Q09-Q11、O05 | 纳入 | 受限可视化与交互表格≠完整 Discover/Monaco；本地视图与各语言协议分开，不承诺 Kibana 对象互通 |
| 收藏/历史/参数、会话恢复、流式导出、本地数据/配置导出 | Q07、F07、F08 | 纳入 | 盘点时持久化不含这些对象；Kibana 兼容、共享服务、PDF/PNG/定时报表不在主线 |
| 聚合、图表、单查询图表定义保存复用 | Q06/Q06a、F07、Q07 | 纳入 | 原始 `aggs` 可提交≠图表 UI；先单图分析，不依赖 Dashboard |
| 文档/索引/加工/生命周期/备份/安全/REST、文件导入、ES Pipeline | W01-W11 | 纳入（受控） | 后端仍为固定只读；W01/W02 先行；W11 依赖 W01/W02/Q03，提前做只读 Console 须先定义受限子项，不开放任意 method/path/header 代理 |
| Maps/Graph | G01-G05 | 纳入 | 先空间显示/聚合与关系探索；导入等 W03；版本/许可/离线边界单列 |
| ES\|QL/SQL/EQL | Q08 | 已有任务 | 缺独立协议与目标版本验证 |
| 持续采样、诊断、曲线、本地通知 | O01-O07 | 保留 | 固定只读页不替代历史监控，不承诺 7x24 |
| 模型策略、候选审核、证据解释、原生协议 | A01-A05、E02/E03 | 保留 | 文本多轮与显式附件不是完整查询/诊断助手 |
| 跨集群、进阶 API、版本/许可、旧资产迁移 | E04/E05、D05、C02 | 已选方向逐项确认 | 需协议、权限与真实证据；E05≠整套 ML/Graph UI；未选能力不因版本更新纳入 |
| 发布、安全、性能、可访问性、支持矩阵 | R01-R04 | 继续执行 | 安装包曾构建，未实装/签名/跨平台 |
| Dashboard、Vega | Q06/F07 可复用 | 不扩展 | 多面板或任意自定义可视化需另行选择 |
| Saved Objects/Spaces/协作/报告 | — | 不扩展 | 需共享服务与对象模型 |
| 服务端规则/Connectors/Cases/Workflows | O07、W01/W02、E05 | 不扩展 | 不能由 O07 本地通知默默承担 |
| Fleet/Logstash/外部内容接入 | — | 不扩展 | 外部采集控制面 |
| Observability/Security/完整 ML/Agent Builder/MCP/RAG | O、Q06、A、E05 | 不扩展 | 不扩成 APM/SIEM/ML 产品；保留现有 AI，无自动检索或候选执行 |
| 遗留编辑器、Canvas/Timelion/Rollup、Enterprise Search、Cloud 账单/部署 | — | 暂不追平 | 见第 4 节 |

选择 Kibana 集成时须有独立服务地址、凭据引用、Space/版本能力和类型化 IPC；不直接写 `.kibana*`、`.fleet*`
等内部索引仿造对象，不隐式扩大原连接权限，不静默把查询、文档或历史转发到其他服务。

初次盘点（选择六方向前）的建议顺序已由执行计划第 10 节取代，仅存档：① ES 认证/CA、权限与版本（401/403/TLS 分层、无秘密泄漏、
无 monitor 仍可查授权目标）；② 查询保存/历史/恢复与 CSV/JSONL 导出（重启不自动执行、数值无损、取消/部分文件、公式防护）；
③ 时间筛选、字段统计、完整编辑与结果性能（样本不当总体、大结果基准）；④ 基础聚合与图表，Dashboard 另立范围；
⑤ 持续只读诊断，W01/W02 先行后分批写管理；⑥ 进阶语言/AI 与 Kibana 集成取舍（Q08 版本门控、A03/A04 同验、优先集成已有告警/Fleet/APM/SIEM）。
不估算完成率、日期或工期。

## 6. 初次盘点的验证记录

- 静态核对：路由、IPC/ES 操作注册、认证拒绝、原始 DSL 通道、可视化范围、结果解析、索引/别名/数据流目录、采样、
  迁移、AI 调用范围；旧告警目录 404 后改用 `alerting/alerts` 与 `cases` 页面。
- 当次只改文档；未跑回归、未启动浏览器/WebView、未访问真实 ES/模型/密钥库、未重建安装包。`git diff --check` 通过；
  remark/remark-gfm 解析当时 5 份文档：74 个本地链接、78 处引用、22 张表无错误，37 个官方来源。712/16、Rust 192 属前轮证据。
- 实施前仍须针对目标 ES/Kibana 小版本、部署、许可、权限及 API/UI 稳定性重新核对，本盘点不是支持承诺。

## 7. 官方资料

Elastic 官方资料，读取日期 2026-10-09；版本以页面 `applies_to`、提示框和目标部署实际能力共同确认。

[overview]: https://www.elastic.co/docs/explore-analyze
[discover]: https://www.elastic.co/docs/explore-analyze/discover
[document-explorer]: https://www.elastic.co/docs/explore-analyze/discover/document-explorer
[data-views]: https://www.elastic.co/docs/explore-analyze/find-and-organize/data-views
[visualize]: https://www.elastic.co/docs/explore-analyze/visualize
[lens]: https://www.elastic.co/docs/explore-analyze/visualize/lens
[dashboards]: https://www.elastic.co/docs/explore-analyze/dashboards
[maps]: https://www.elastic.co/docs/explore-analyze/visualize/maps
[graph]: https://www.elastic.co/docs/explore-analyze/visualize/graph
[query-tools]: https://www.elastic.co/docs/explore-analyze/query-filter/tools
[index-management]: https://www.elastic.co/docs/manage-data/data-store/perform-index-operations
[pipelines]: https://www.elastic.co/docs/manage-data/ingest/transform-enrich/ingest-pipelines
[ilm]: https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management
[snapshots]: https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore
[monitor]: https://www.elastic.co/docs/deploy-manage/monitor
[manage]: https://www.elastic.co/docs/deploy-manage
[spaces]: https://www.elastic.co/docs/deploy-manage/manage-spaces
[saved-objects]: https://www.elastic.co/docs/explore-analyze/find-and-organize/saved-objects
[reporting]: https://www.elastic.co/docs/explore-analyze/report-and-share
[alerting]: https://www.elastic.co/docs/explore-analyze/alerting/alerts
[cases]: https://www.elastic.co/docs/explore-analyze/cases
[watcher]: https://www.elastic.co/docs/explore-analyze/alerting/watcher
[workflows]: https://www.elastic.co/docs/explore-analyze/workflows
[ml]: https://www.elastic.co/docs/explore-analyze/machine-learning
[search-solution]: https://www.elastic.co/docs/solutions/elasticsearch-solution-project
[agent-builder]: https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder
[fleet]: https://www.elastic.co/docs/reference/fleet
[observability]: https://www.elastic.co/docs/solutions/observability
[security]: https://www.elastic.co/docs/solutions/security
[license]: https://www.elastic.co/docs/deploy-manage/license
[canvas]: https://www.elastic.co/docs/explore-analyze/visualize/canvas
[timelion]: https://www.elastic.co/docs/explore-analyze/visualize/legacy-editors/timelion
[rollup]: https://www.elastic.co/docs/manage-data/lifecycle/rollup
[uptime]: https://www.elastic.co/docs/solutions/observability/uptime
[playground]: https://www.elastic.co/docs/solutions/elasticsearch-solution-project/playground
[search-applications]: https://www.elastic.co/docs/solutions/elasticsearch-solution-project/search-applications
[upgrade]: https://www.elastic.co/docs/deploy-manage/upgrade/prepare-to-upgrade
