# Kibana 功能对照与 EScope 缺口盘点

盘点日期：2026-10-09。EScope 源码基线：`cb1a4db`，应用版本 `0.1.0`。
性质：D05 的功能范围调研，不是开发完成声明，也不自动扩大已批准的产品范围。

同日后续决策：用户已确认**连接与权限、数据探索、保存与导出、聚合与图表、数据管理、
地图与关系**六方向。当前主线见 [执行计划第 10 节](development-plan.md)，
新增 Q06a/Q09-Q11/G01-G05 及验收见 [backlog](development-backlog.md)。
本次只确认范围，下面的实现状态仍是源码基线快照，不因纳入计划而变为已实现。

同日开发增量：随后 C01.3 内部只读认证传输通过复审与 mock 自动化，
见 [认证底座验收](connection-auth-qa.md)。下面“ES 网络仍拒绝认证”等描述保留 `cb1a4db`
盘点时基线；认证表单、真实认证/TLS 和父任务仍未完成，不由该内部子项推导完整支持。

## 1. 结论与口径

**EScope 已具备桌面查询工作台和基础只读资源浏览，但还不是 Kibana 的完整分析、管理与协作替代品。**
最影响日常使用的缺口，是 ES 认证连接、查询保存与导出、时间/字段分析、聚合图表、
完整查询编辑辅助，以及索引和运维管理闭环。Fleet、APM、SIEM、团队协作等则是独立的平台级能力。

本次按 Kibana 的主要用户功能族盘点，覆盖 Discover、Lens、Dashboard、Maps、Graph、
Dev Tools、Stack Management、报表、告警、Cases、ML、AI、Fleet、Observability 和 Security。
第 3 节共 16 个领域、150 条功能对照，包含已有能力与外部依赖，不是“150 个缺失功能”。
“全面对照”不等于穷举所有插件、每个 API 参数或所有历史版本的菜单。

### 对照边界

- 当前能力以正式 `src`、Rust IPC/操作注册及数据库迁移为准，不以原型、设计稿或任务名称作证据。
- 官方依据为本次直接读取的 Elastic 文档。在线文档同时包含 GA、Preview、Beta、Experimental、
  Planned 及弃用能力，必须按具体功能的版本标记解读，不能拼成一个“所有版本都有”的 Kibana。
- 仓库已有真实 ES 证据主要针对 **7.17.25 无认证环境**；8.x、9.x、Serverless、
  带认证/TLS 的运行状态不能由此推导。本次没有重新运行这些服务或测试。
- Kibana 页面、Elasticsearch API、Elastic Agent/采集器、Cloud 控制台不是同一层。
  标记“缺失”不表示只加一个前端页面就能补齐，也不表示必须在 EScope 内重新实现。
- 表中的任务 ID 是现有 backlog 的关联或前置，不代表该任务已承诺整列能力。
  “待决策”表示现有任务没有完整覆盖，需先定范围和验收，再编号排期。
- 不按菜单数量计算完成百分比。查询编辑器、端点适配、服务端调度和整套 SIEM 的成本不可等量相加。

### 状态说明

| 状态 | 含义 |
| --- | --- |
| 已有 | 正式代码已有这项具体能力；仍遵守原有人工/跨平台验收限制 |
| 部分 | 有可用子集，但主要工作流、持久化、协议或验收尚不完整 |
| DSL 通道 | 可随合法 `_search` JSON 请求体提交，缺少专用 UI/解析；目标 ES 必须支持，未逐项联调 |
| 缺失 | 未发现完整正式入口、状态模型与受限后端实现 |
| 外部依赖 | 缺失能力需要 Kibana、常驻服务、采集器或其他产品；可选择集成，不等于本地界面待补 |

### 六个容易误判的地方

1. **可视化查询条件不是 Lens。** 当前 AND/OR 条件编辑不能生成聚合分析图表或仪表盘。
2. **模型 API Key 不是 ES 认证。** 模型凭据已接入；ES 网络仍拒绝带认证配置的连接。
3. **不是完全不支持聚合、profile 或 highlight。** 原始 `_search` body 可携带这些参数；
   缺的是专用工作流，具体语义与版本支持仍由服务器决定。
4. **别名、数据流并非完全没有。** 设置索引页能展示基础目录和部分关联信息，不能管理其生命周期。
5. **表头排序不是全索引排序。** 当前排序只处理已加载结果；服务器排序需要明确修改并执行 DSL。
6. **有聊天不等于有数据 Agent 或 Elasticsearch ML。** 当前不会自动检索文档、
   自动验证/应用候选，也没有 ML 作业或 Inference endpoint 管理。

## 2. 当前实现证据

以下是本次静态核对的位置；测试文件的存在或历史成功记录不等于本次重新执行测试。

| 核对点 | 代码证据 | 实际边界 |
| --- | --- | --- |
| 页面范围 | [routes.ts](../src/app/routes.ts)、[SettingsView.tsx](../src/app/SettingsView.tsx) | 正式管理路由为连接、模型、集群、节点、分片、索引，没有 Dashboard/Fleet/ML 等入口 |
| ES 后端能力 | [operation.rs](../src-tauri/src/operation.rs) 的 `ReadOnlyOperation`、[lib.rs](../src-tauri/src/lib.rs) 的 `generate_handler!` | 固定身份、资源、搜索及 PIT 接口；没有任意 REST、管理写入或 Kibana API 代理 |
| ES 认证 | [operation.rs](../src-tauri/src/operation.rs) 的 `base_url`、[ConnectionPanel.tsx](../src/features/connections/ConnectionPanel.tsx) | 非 `none` 认证被拒绝；凭据内部编排不等于认证网络/UI 已接通 |
| 原始 DSL | [query.rs](../src-tauri/src/query.rs) 的 `validate_search_body`、[query-dsl.ts](../src/domain/query-dsl.ts) | 校验 JSON/重复键/资源上限，合法 body 保留原文；不是按所有 ES 查询语义做白名单校验 |
| 可视化子集 | [visual-query.ts](../src/domain/visual-query.ts)、[VisualQueryEditor.tsx](../src/features/query/VisualQueryEditor.tsx) | 类型感知条件、平面 AND/OR、size、单字段 sort；任意 nested/复杂 bool 等保留 DSL |
| 编辑器 | [QueryWorkspace.tsx](../src/features/query/QueryWorkspace.tsx) | 正式 DSL 输入仍是 `textarea`，有 JSON 校验/格式化，不是 Monaco/API 补全 |
| 结果与分页 | [QueryResults.tsx](../src/features/query/QueryResults.tsx)、[QueryResultGrid.tsx](../src/features/query/QueryResultGrid.tsx)、[useQueryExecutions.ts](../src/features/query/useQueryExecutions.ts) | 表格/JSON/详情、复制、列交互、部分结果、快照隔离及 PIT 顺序续页；不是聚合图表或全量导出 |
| 结果解析 | [query-result.ts](../src/domain/query-result.ts) 的 `QuerySummary` | 重点解析 hits、总数、分片与执行信息；其他响应内容保留在原始 JSON，没有专门聚合/profile 展示 |
| 资源目录 | [resource.ts](../src/domain/resource.ts)、[IndicesPanel.tsx](../src/features/cluster/IndicesPanel.tsx) | 索引、别名、数据流目录；Mapping/Settings 只读详情，非模板/生命周期管理 |
| 监控行为 | [useClusterResources.ts](../src/features/cluster/useClusterResources.ts)、[ClusterOverview.tsx](../src/features/cluster/ClusterOverview.tsx) | 手动读取、刷新和请求隔离，没有周期采样或监控历史 |
| 持久化 | [migrations](../src-tauri/migrations)、[storage.ts](../src/services/storage.ts)、[App.tsx](../src/app/App.tsx) | SQLite 保存偏好、连接/模型元信息、选择和凭据引用；查询/结果/聊天尚不跨应用重启保存 |
| AI | [AiChatPanel.tsx](../src/features/ai/AiChatPanel.tsx)、[ai.rs](../src-tauri/src/ai.rs)、[models.rs](../src-tauri/src/models.rs) | 兼容协议/Ollama、流式多轮、取消、显式草稿附件、模型凭据；没有候选审核执行或检索工具链 |
| 现有验收 | [工作台 QA](workspace-grid-and-ai-qa.md)、[索引标签 QA](index-tabs-and-controls-qa.md)、[行选择 QA](preview-and-row-selection-qa.md) | 已有子项和未验边界保留；本次调研不覆盖原有人工验收 |

## 3. 功能对照

### 3.1 连接、身份与兼容性

这一组主要是 EScope 作为独立客户端的前置缺口，不把 Kibana 的部署配置直接说成它的连接管理 UI。
官方参考：[权限与部署管理][manage]、[许可证][license]。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 多连接目录、环境标记、稳定身份 | 已有 | 保存/编辑/删除、选择恢复、标签绑定与响应隔离；是桌面工作台已有能力，不必复制 Kibana 登录界面 | C05、F02b/F02c |
| ES Basic/API Key/Bearer | 缺失 | 内部凭据生命周期已有，认证表单和请求接线未完成；普通启用安全的集群仍受阻 | C01.3、F08.2/C05.2 |
| HTTPS/TLS | 部分 | 已能配置 HTTPS，客户端保留证书校验；自定义 CA、企业证书、mTLS 与认证 TLS 联调未完成 | C04、E01 |
| 当前用户、角色、权限诊断 | 缺失 | 集群名称/版本不等于当前登录身份；缺 `_authenticate`、权限检查和可解释能力状态 | C02、W09 |
| 版本/部署/许可证能力矩阵 | 部分 | 根身份提供部分版本信息；缺稳定能力缓存、许可证/Serverless 差异与功能门控 | C02、D05、E05 |
| Cloud ID、多节点故障切换 | 缺失 | 没有 Cloud ID 解析、节点集群身份一致性和重试策略 | C03 |
| 代理、SSH、企业登录 | 缺失 | 当前 ES 客户端禁用环境代理；HTTP/SOCKS/SSH/mTLS、SSO 生命周期不能用任意认证头代替 | E01；SSO 待细化 |
| 跨集群/跨项目搜索 | 缺失 | 多个本地连接不等于 CCS；当前目标校验拒绝 `remote:index` 的冒号语法；Serverless CPS 是另一套能力 | E04；CPS 待决策 |

### 3.2 Discover 与日常数据探索

官方参考：[Discover][discover]、[文档表格][document-explorer]、[Data Views][data-views]。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 打开索引、查询、文档查看 | 已有 | 独立索引/查询标签、JSON/表格、文档详情与原文复制，保留结果快照 | Q01/Q04/Q05、F02 |
| 列宽、顺序、显隐、行选择 | 已有 | 已有本地交互和标签内保持；完整虚拟化、大数据性能、跨重启恢复仍未完成 | Q05、Q07 |
| Data View/索引模式管理 | 部分 | 可手填多索引与通配符；缺命名视图、默认时间字段、字段格式和可复用视图定义 | Q09，已纳入待开发 |
| KQL 查询栏 | 缺失 | 没有 KQL 编辑/解析；KQL 不是可以原样塞进 `_search` 的 JSON | Q10，已纳入待开发 |
| Lucene 查询栏 | DSL 通道 | 可在 DSL 中使用 `query_string` 等服务器语法；没有 Kibana 式语言切换、补全和快捷检索 | Q10 |
| ES\|QL/SQL/EQL | 缺失 | 缺各自执行端点、编辑器、结果协议、游标/异步语义；不能复用 hits 解析冒充支持 | Q08 |
| 全局时间选择器 | 缺失 | 缺相对/绝对时间、快捷范围、默认时间字段和时区联动；手写 `range` 不等于该体验 | Q02 |
| 自动刷新、实时追踪 | 缺失 | 目前无周期查询；未来只能用户显式启用，不改变启动/切换不自动执行的约定 | Q11 |
| 筛选条与固定筛选 | 部分 | 有受限条件编辑；缺从单元格添加包含/排除、筛选启停、固定与跨视图携带 | Q02 |
| 复杂布尔组、nested、类型语义 | 部分 | DSL 可手写；可视化不支持任意嵌套、完整 nested、复杂排序和无损往返 | Q01/Q02/Q03 |
| 服务器多字段排序 | 部分 | DSL 可显式指定多字段 sort；可视化仅单字段，表头只排序已加载数据 | Q02/Q05 |
| 时间直方图、快速字段图表 | 缺失 | 缺命中分布、区间刷选、一键从字段转图表；不能用当前页行数替代全查询统计 | Q06 |
| 字段统计与分布 | 部分 | 有类型、searchable/aggregatable 和冲突标记；缺 Top values、覆盖率、空值、基数和分布 | O05、Q06 |
| Runtime fields、字段格式器 | DSL 通道 | 搜索体可携带 `runtime_mappings`；没有字段编辑、类型/脚本预览或 Data View 字段格式管理 | Q09；Mapping 更新归 W04 |
| 文档对比、周边文档、详情跳转 | 部分 | 有单文档详情；缺多文档字段差异、按时间看上下文、可分享的稳定文档链接 | Q05/Q07 相关 |
| 保存搜索、后台搜索、会话恢复 | 缺失 | 当前标签内保持不是 Saved Discover Session；缺命名保存、跨重启恢复及持久后台搜索 | Q07、Q11 |
| 日志模式/变化点/相关性探索 | 缺失 | 无模式聚类、AIOps 变化点或专用相关性分析；部分官方能力依赖新版本和 ML | E05 相关；专用分析待决策 |

### 3.3 聚合、Lens 与图表

官方参考：[可视化总览][visualize]、[Lens][lens]。
**Q06 尚未形成图表闭环，不能因为 body 支持 `aggs` 就记为 Lens 已实现。**

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 指标聚合 | DSL 通道 | 可手写 count/min/max/sum/avg/stats 等；缺构建器、指标卡与类型化结果 | Q06 |
| 桶与时间聚合 | DSL 通道 | 可手写 terms、range、histogram、date_histogram、nested 等；缺字段/间隔/层级编辑 | Q06 |
| 百分位、基数、管道聚合 | DSL 通道 | 缺近似值说明、桶截断、派生指标、移动统计与空桶语义的统一呈现 | Q06 |
| 常用图表库 | 缺失 | 柱/折线/面积/饼/环/指标/仪表/热力/树图/词云/聚合表等均无专用正式图表 | Q06 |
| Lens 拖字段与图表建议 | 缺失 | 缺维度/指标配置、类型建议和图表切换；表格列拖拽不是图表构建器 | Q06 分批，不承诺完整复刻 Lens |
| Formula、时间偏移、百分比比较 | 缺失 | 缺跨指标公式、同期比较、单位归一化、计算依赖与错误诊断 | Q06 相关；需拆范围 |
| 多图层、双轴、参考线、注释 | 缺失 | 缺跨数据视图图层、轴/单位、静态/查询注释与阈值线 | Q06 相关 |
| 图表交互与 Inspector | 部分 | 能看查询原文和原始响应；缺图例筛选、刷选、每图层请求/数据检查与 CSV | Q05/Q06/Q07 |
| 可复用可视化库 | 缺失 | 缺图表保存、引用、复制、标签、删除影响和复用关系 | Q06a；团队对象库仍待决策 |
| Vega/Vega-Lite 自定义图 | 缺失 | 缺声明式图表执行与权限边界；外部数据访问、表达式执行不得绕过受限 IPC | 待决策 |

### 3.4 Dashboard

官方参考：[Dashboards][dashboards]。当前集群概览是固定只读页面，不是可编辑仪表盘。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 仪表盘 CRUD 与持久化 | 缺失 | 没有仪表盘对象、面板定义、命名保存、复制与恢复 | 待决策；依赖 F07/Q06/Q07 |
| 多面板布局 | 缺失 | 缺拖拽、缩放、分节、折叠、响应式布局和编辑/查看状态 | 待决策 |
| 混合面板 | 缺失 | 不能组合图表、Discover 结果、地图、Markdown、图片、链接、SLO/告警 | 待决策 |
| 全局/面板级时间与筛选 | 缺失 | 缺共享上下文、面板覆盖规则、跨面板筛选与显式刷新策略 | 待决策；依赖 Q02 |
| Controls | 缺失 | 缺选项列表、范围/时间滑块、ES\|QL 变量控制和级联过滤 | 待决策 |
| Drilldown 与导航 | 缺失 | 缺仪表盘到仪表盘/Discover/URL 的参数传递和安全 URL 策略 | 待决策 |
| 分享、嵌入、报表 | 缺失/外部依赖 | 本地可以另做静态导出；权限分享、在线嵌入、定时报表需要共享服务或 Kibana | 待决策 |
| API/AI 生成仪表盘 | 缺失/外部依赖 | 没有声明式仪表盘导入校验、对象依赖、Agent Builder 生成与审核；官方部分接口有新版门槛 | 待决策 |

### 3.5 Maps 与 Graph

官方参考：[Maps][maps]、[Graph][graph]。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 地理查询与聚合 | DSL 通道 | 可手写目标 ES 支持的 geo 查询/聚合；没有地图呈现、绘制范围或空间筛选 | G01/G02，已纳入待开发 |
| 多图层地图 | 缺失 | 缺点/线/面、热力/聚类、区域着色、图层样式、tooltip、图层连接 | G01-G03 |
| 地图时间动画与资产追踪 | 缺失 | 缺轨迹、时间滑块、联动和地理围栏告警 | G03 时间/轨迹；服务端告警不在本次主线 |
| GeoJSON/shapefile 导入 | 缺失 | 导入包含真实写入，需文件解析、坐标/Mapping 校验和逐项失败处理 | G04，依赖 W03/W04 |
| 底图、EMS 与离线地图 | 缺失/外部依赖 | 需要地图源、网络/授权策略及离线方案，不能默认可访问外网地图资源 | G01；具体外部地图源在子项中确认 |
| Graph 关系探索 | 缺失 | 无 Graph API、节点/边展开、相关性/采样控制、阻断词、布局保存和回溯文档；官方标记 Serverless 不可用 | G05，已纳入待开发 |

### 3.6 Dev Tools 与查询诊断

官方参考：[Query tools][query-tools]。
Kibana 通过 Console 可访问的 API 不代表它为每个 API 都有专用表单。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| JSON 校验、格式化、原文保持 | 已有 | 重复键、定位错误、格式化撤销和数值字面量保持已有；不是 ES 语义校验 | Q01/Q03 |
| Monaco/API 补全 | 缺失 | 缺端点/字段/参数建议、语法高亮、内联文档、版本匹配与可靠编辑器工作流 | Q03 |
| REST Console | 缺失 | 缺多请求解析、执行当前/全部、变量展开后审核、请求历史、curl 导入/脱敏复制 | W11 |
| Kibana API Console | 缺失/外部依赖 | 没有 Kibana 服务连接、Space 路径与权限适配；不能把 Kibana API 发给 ES 地址 | 待决策；与 W11 分离 |
| Search Profiler | DSL 通道 | `_search` 的 `profile:true` 可手写；缺分片/阶段耗时树、聚合耗时与对比 UI | Q05/Q06 或 W11 子项待细化 |
| Explain、highlight、suggest | DSL 通道 | 搜索体可携带对应参数；缺评分树、高亮片段/建议的专用展示；独立 `_explain` 等端点未接入 | Q03/Q05、W11 |
| Grok Debugger、Analyze | 缺失 | 缺模式调试、token/position/offset、索引分析器绑定和错误定位 | W05/W11 |
| Painless Lab、脚本管理 | 部分 | 可在搜索体手写服务器允许的脚本；没有 Lab、执行上下文模拟、存储脚本管理或专门审查 | W05/W11；Lab 待决策 |

### 3.7 索引、数据与生命周期管理

官方参考：[Index Management][index-management]、[Ingest pipelines][pipelines]、
[ILM][ilm]、[Snapshot and restore][snapshots]。
以下写操作都要先完成 W01/W02 的后端授权、审核和任务状态，不能只加按钮。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 索引/别名/数据流目录 | 部分 | 已有目录、属性和部分关联；缺完整健康/容量/统计、生命周期状态与大型目录体验 | O05 |
| Mapping/Settings | 部分 | 已有只读详情与复制；缺结构化编辑、diff、字段新增、设置校验及模板来源分析 | O05、W04 |
| 索引创建和操作 | 缺失 | 创建/删除/open/close、refresh/flush、缓存清理、force merge、split/shrink 等未接入 | W04/W11 |
| 索引模板与组件模板 | 缺失 | 连只读管理页也没有；缺版本/优先级/匹配/组合、模拟、创建/编辑/删除 | O05、W04 |
| 别名管理 | 部分 | 可见名称与目标索引；缺 filter/routing/write index 详情和原子切换 | O05、W04 |
| 数据流管理 | 部分 | 可见名称、backing 数量和时间字段；缺详情、写索引、rollover、保留期及失败存储管理 | W06；新版失败存储需细化 |
| 文档 CRUD/bulk | 缺失 | 文档详情只读；缺乐观并发、冲突处理、批量逐项错误与安全重试；Kibana 对应部分主要通过 Console | W03 |
| 文件导入/导出 | 缺失 | 缺 CSV/JSONL 预览、类型/编码、Mapping、导入进度及流式导出；复制 JSON 不等于导出 | W03、Q07 |
| Ingest Pipeline | 缺失 | 缺 processor 编辑、顺序/条件、simulate、逐步结果、版本与失败分支 | W05 |
| Enrich、同义词 | 缺失 | 缺策略/集合、预览、执行、状态与版本能力；不能与普通查询条件混为一谈 | W05 |
| ILM | 缺失 | 缺策略、阶段、rollover 条件、explain、错误重试与关联索引；Serverless 不支持 ILM | W06 |
| Data Stream Lifecycle/Downsampling | 缺失 | 缺保留期、降采样、数据层/部署差异；不能将它与 ILM 或已弃用 Rollup 合并成一个开关 | W06 相关；降采样需细化 |
| Reindex/按查询更新删除 | 缺失 | 缺源目标校验、限速、异步追踪、冲突和结果核验；部分操作在 Kibana 主要使用 Console | W03/W07/W11 |
| Transform | 缺失 | 缺 pivot/latest 配置、预览、目标索引、checkpoint、启动/停止、错误与持续同步 | W07 |
| 快照仓库、快照、SLM | 缺失 | 缺仓库注册/验证、列表/详情、创建、计划、保留与部分失败；客户端文件夹不是服务端仓库 | W08 |
| 恢复、Searchable Snapshots | 缺失 | 缺重命名/冲突预检、全局状态/feature states 审核与完成追踪；部署/许可限制单独处理 | W08 |
| Remote Clusters/CCR | 缺失 | 缺远端连接、复制/auto-follow、lag、暂停恢复与版本/权限检查 | E04 |

### 3.8 Stack Monitoring 与运维诊断

官方参考：[Monitoring][monitor]。有当前统计不等于有历史监控。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 集群分配健康 | 部分 | 已有健康页和状态语义；缺趋势、事件、完整证据链和深层诊断 | O02 |
| 节点指标/详情 | 部分 | 能读 JVM/磁盘/OS/进程/线程池数据；缺连续速率、GC 趋势、重启基线、热线程和完整详情 | O01/O03/O06 |
| 分片列表/分配诊断 | 部分 | 已有主副本/状态/基础原因；缺矩阵、恢复进度、allocation explain、候选节点/deciders | O04 |
| 分片修复与 reroute | 缺失 | 无 dry_run、重新核验和执行审核；不能拖动分片立即变更 | W10 |
| 采样、曲线、保留与配额 | 缺失 | 缺共享采样器、退避、断点、历史样本、速率计算和可控保留 | O01/O06 |
| 索引性能与集群任务 | 缺失 | 缺查询/写入速率、缓存/breaker、pending tasks、服务端任务列表与取消状态 | O01/O03、W02/W11 |
| 慢日志、Query activity | 缺失 | 缺慢查询/查询日志来源、运行查询列表、来源追踪与诊断；新版 Query activity 有预览标记 | O03/W11 相关；专用页待决策 |
| 全 Stack 监控 | 外部依赖 | 无 Kibana/Logstash/Beats/APM Server 监控数据接入，需采集与历史存储；ES 节点页不能替代 | 待决策 |
| Upgrade Assistant | 缺失 | 缺弃用检查、版本兼容/旧索引迁移与升级阻塞诊断；不是替用户自动升级 ES | D05/E04/R04 相关；服务端升级辅助待决策 |
| AutoOps | 外部依赖 | 不是普通 Kibana 表格；需 Elastic 服务/Cloud Connect 或自建诊断体系，不能声称本地规则等价 | O02 可参考；完整集成待决策 |

### 3.9 权限、安全管理与空间

官方参考：[部署与身份管理][manage]、[Spaces][spaces]、[许可证][license]。
这一节是管理权限，不是后面的 SIEM 威胁分析。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 只读与受限请求 | 已有 | ES 固定操作注册、未知拒绝、秘密分离和响应隔离已有；不是完整用户授权系统 | F05/F06/F08 |
| 数据编辑/运维访问模式 | 缺失 | 缺模式升级、服务器权限校验、审核票据、有效期和最终请求绑定 | F06、W01 |
| 用户、角色、角色映射 | 缺失 | 没有列表/编辑/权限 diff/保留身份保护；需区分用户管理和外部 SSO 配置 | W09 |
| Elasticsearch API Key 管理 | 缺失 | 缺创建、作用域/到期、失效、一次性展示；AI 模型 Key 不覆盖此项 | W09 |
| DLS/FLS、SSO 与会话治理 | 缺失/外部依赖 | 依赖服务器权限与订阅；本地隐藏列不是字段级授权，连接分组不是用户隔离 | C02/W09/E01；完整治理待决策 |
| Kibana Spaces/多用户共享 | 外部依赖 | 没有空间、对象级访问或团队身份；本地连接/标签不能等同 Space | 待决策 |
| 审计与操作历史 | 缺失 | 没有完整操作流水、主体/目标/最终状态追踪；客户端本地记录也不能替代服务端审计 | W02、R04 |
| 许可证/功能权限管理 | 缺失 | 没有许可证读取、到期提示、功能可用性矩阵或受控变更 | C02/E05；变更需 W01 |

### 3.10 保存对象、组织、分享与报告

官方参考：[Saved objects][saved-objects]、[Reporting][reporting]。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 收藏、历史、参数化查询 | 缺失 | 查询名字和内存标签不是收藏库；缺搜索/管理、参数、安全重开和保留策略 | Q07/F07 |
| 查询与聊天跨重启恢复 | 缺失 | 当前持久化不包含草稿/结果/聊天；恢复后不得自动查询或重传 AI 历史 | Q07；AI 会话持久化需细化 |
| Saved Objects/NDJSON | 缺失 | 缺搜索/图表/仪表盘对象、依赖引用、冲突、迁移和导入导出；自有 JSON 不自动兼容 Kibana | 待决策 |
| Tags、Files、统一对象检索 | 部分 | 有命令面板和快速跳转；缺跨内容对象搜索、标签、收藏组织与可共享资产管理 | F04/Q07 基础；完整对象层待决策 |
| CSV/JSONL 数据导出 | 缺失 | 缺范围选择、流式写文件、取消、部分文件标记、数值精度和 CSV 公式防护 | Q07 |
| PDF/PNG 报告 | 缺失 | 缺打印布局、渲染队列、下载与错误；官方 PDF/PNG 为订阅功能，并有 Serverless 限制 | 待决策 |
| 定时报表与分发 | 外部依赖 | 无调度、后台任务、认证链接/邮件分发；本地即时导出可以独立做，不承诺关机后执行 | 待决策 |
| 分享链接、短链、嵌入、权限访问 | 外部依赖 | 没有共享托管和访问控制；导出文件/本机路径不等于可访问的团队分享 | 待决策 |
| 高级设置与个性化 | 部分 | 主题、语言、字体/密度/启动偏好已有；无 Kibana 级按空间配置、分析默认值和服务端设置管理 | F03/F03a；其余待决策 |

### 3.11 Alerting、Cases、Watcher 与 Workflows

官方参考：[Kibana alerting][alerting]、[Cases][cases]、[Watcher][watcher]、[Workflows][workflows]。
**O07 规划的是本地通知，不能按等价方式覆盖 Kibana 的服务端规则执行。**

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 阈值/查询/地理等规则 | 缺失 | 没有规则定义、调度、分组、阈值、预览和执行状态 | O07 本地子集；Kibana 规则待决策 |
| 告警生命周期 | 缺失 | 缺触发/恢复、去重、静默、snooze、维护窗口、执行历史和失败诊断 | O07 子集；服务端集成待决策 |
| Actions 与通知 Connectors | 外部依赖 | 无 Email/Slack/Webhook/PagerDuty/Jira/ServiceNow 等连接器、测试和秘密管理 | 待决策 |
| 可靠后台调度 | 外部依赖 | 桌面关闭/休眠后不能可靠执行；需要 Kibana Task Manager、ES Watcher 或独立常驻服务 | O07 边界；架构待决策 |
| 告警面板和检索 | 缺失 | 无规则/告警集中列表、筛选、实例详情与跳转图表 | 待决策 |
| Cases 事件协作 | 外部依赖 | 无负责人/状态/评论/附件、告警关联、模板、自定义字段、外部工单同步 | 待决策 |
| Watcher | 缺失 | 无 watch 列表/编辑/模拟/执行记录；运行引擎在 ES，不是 Kibana Alerting；Serverless 不可用 | E05/W11 |
| Elastic Workflows | 外部依赖 | 无 YAML 编排、手动/计划/告警触发、条件/循环、重试、人工审批和运行追踪 | 待决策 |
| 实验性新版告警 | 外部依赖 | 官方另有 ES\|QL rule events/alert episodes 体系，带 Experimental 标记；不能与 GA 告警混算 | 待决策，非近期基线 |

### 3.12 Machine Learning 与 AIOps

官方参考：[Machine Learning][ml]、[Discover 高级分析][discover]。
模型聊天设置不属于以下任何一种 ML 管理能力；各项需单独确认角色、许可与部署。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| Data Visualizer | 缺失 | 无字段统计探索、采样配置、文件结构识别和 ML 前数据检查 | Q06/W03 相关；专用页待决策 |
| 异常检测作业与 datafeed | 缺失 | 无单/多指标、分类/总体分析配置、创建/启停、内存/延迟数据和运行状态 | E05 |
| Anomaly Explorer/Single Metric Viewer | 缺失 | 无异常分数、影响因子、swimlane、时间钻取和解释 | E05；专用图表待决策 |
| 预测、日历、过滤器、模型快照 | 缺失 | 无 forecast、日历事件、custom rules、快照恢复和作业配置导入导出 | E05 |
| Data Frame Analytics | 缺失 | 无离群点、分类、回归、训练评估/特征重要性和结果探索 | E05 |
| NLP/训练模型部署与测试 | 缺失 | 无模型下载/导入、部署/分配、推理测试、状态/统计；聊天模型不等于 ES trained model | E05 |
| AIOps 日志模式/速率/变化点 | 缺失 | 无日志类别、波动解释、显著字段和变化点分析；新版 Discover 有单独可用性标记 | E05 相关；专用分析待决策 |
| ML 告警与分析集成 | 缺失 | 无 ML 作业健康/异常告警、Dashboard 面板或受控诊断链 | E05；告警/仪表盘为前置 |

### 3.13 搜索产品与 AI 工作流

官方参考：[Elasticsearch solution][search-solution]、[Agent Builder][agent-builder]。
旧 Playground/Search Applications 的版本限制见第 4 节。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 多模型对话与模型设置 | 已有 | 兼容协议/Ollama、手填/发现模型、系统密钥库、流式/取消和显式附件已有；原生供应商协议并未全覆盖 | A01/A02、E02/E03 |
| AI 查询候选审核 | 缺失 | 缺结构化候选、字段/schema 校验、草稿版本冲突、diff 和明确应用；聊天输出一段 DSL 不算闭环 | A03/A04 |
| AI 结果/诊断解释 | 部分 | 可以聊天和显式附加草稿；缺经授权的结果/统计上下文、证据溯源、样本范围和图表 schema | A04/A05 |
| 用途模型/参数/费用策略 | 部分 | 模型配置与选择已有；缺完整 UsagePolicy、能力感知参数、用途默认、费用和上下文预算治理 | A01、E02/E03 |
| 向量/语义/hybrid/rerank | DSL 通道 | 目标 ES 支持且位于 `_search` body 的语法可手写；缺向量输入、embedding 授权、评测与版本门控 | Q02/Q03/E05 相关 |
| Inference endpoints | 缺失 | 无服务/任务类型配置、模型部署和推理测试；与 EScope 的聊天 provider 不是同一对象 | E05 |
| Query Rules、同义词与相关性调优 | 缺失 | 无规则集、pin/exclude、条件、规则测试与系统性检索评测 | W05 同义词；Query Rules/评测待细化 |
| Agent Builder/RAG/工具调用 | 外部依赖 | 无索引检索工具、自定义 agents/tools/skills、MCP/A2A、会话 API 或受权限约束的执行链 | A03/A05 不完整覆盖；待决策 |

### 3.14 数据接入、Fleet 与 Integrations

官方参考：[Fleet and Elastic Agent][fleet]、[Ingest pipelines][pipelines]。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| 文件上传与数据接入向导 | 缺失 | 无格式探测、Mapping/时间字段建议、pipeline 预览和导入任务 | W03/W05 |
| 集成包目录和资产安装 | 外部依赖 | 无 Integrations 搜索/安装/升级、预置 Dashboard/Pipeline/Data View 的依赖管理 | 待决策 |
| Fleet agents 管理 | 外部依赖 | 无 enrollment、状态、升级、unenroll、批量操作、日志与诊断；需要 Fleet/Agent 运行体系 | 待决策 |
| Agent/Integration policies | 外部依赖 | 无输入/输出、策略版本、下发状态、API key、Fleet Server 地址管理 | 待决策 |
| 数据流质量与采集故障诊断 | 缺失/外部依赖 | 无吞吐/延迟/失败采集视图、字段质量、丢弃/失败文档处理与关联策略 | W06 相关；质量体验待决策 |
| Osquery | 外部依赖 | 无 live query、pack、计划、结果与访问控制；不是向 ES 发一条 SQL 就能实现 | 待决策 |
| Logstash 集中管道管理 | 外部依赖 | 无 Logstash pipeline 配置/分发/监控，依赖实际 Logstash 和对应订阅；不同于 ES ingest pipeline | 待决策 |
| 内容连接器与爬虫 | 外部依赖 | 无外部数据源同步、凭据/ACL/调度/增量同步；需区分现代连接器和已退出的 Enterprise Search 产品 | 待决策 |

### 3.15 Elastic Observability

官方参考：[Observability][observability]。
下面均无专用正式工作流。能够搜索日志索引，不等于已经支持可观测性产品。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| Logs 探索与排障 | DSL 通道 | 能查日志文档；缺日志专用视图、上下文、模式、数据集质量及跨信号关联 | Q02/Q05/Q06 可复用；专用模块待决策 |
| Streams | 外部依赖 | 无日志流接入/结构解析/路由/保留/质量管理和 AI 辅助体验 | 待决策 |
| Infrastructure/Hosts/Containers | 外部依赖 | 无主机/容器/Kubernetes 清单、指标趋势、资产拓扑；ES nodes 只代表 ES 节点 | 待决策 |
| APM | 外部依赖 | 无 service inventory、transactions、trace/span waterfall、依赖图、错误关联和 agent 配置 | 待决策 |
| RUM/User Experience | 外部依赖 | 无浏览器实际用户性能、地域/页面体验、会话指标和 Web 指标分析 | 待决策 |
| Synthetics | 外部依赖 | 无 HTTP/TCP/ICMP/browser journey 配置、多位置探测、截图/步骤排障、证书到期监控 | 待决策 |
| Universal Profiling | 外部依赖 | 无持续 profiling 采集、火焰图、堆栈对比、CPU 成本分析 | 待决策 |
| SLO/SLI/Error Budget | 外部依赖 | 无目标定义、SLI 聚合、预算消耗、burn-rate 告警和服务可靠性视图 | 待决策 |
| 事件响应、AI/LLM Observability | 外部依赖 | 无跨日志/指标/追踪调查、专用助手、LLM 性能/用量/费用观测；聊天面板不等价 | 待决策 |

### 3.16 Elastic Security

官方参考：[Security][security]。
这不是“用户/角色管理”的扩展表格，而是依赖安全数据、检测引擎和响应组件的独立产品体系。

| 功能 | EScope 状态 | 具体缺口与边界 | 关联任务 |
| --- | --- | --- | --- |
| SIEM 规则与检测引擎 | 外部依赖 | 无预置规则、自定义查询/EQL/阈值/ML 等检测、例外、执行与告警管理 | 待决策 |
| Timeline/调查工作台 | 外部依赖 | 无事件证据编排、时间线模板、笔记、进程/事件关联与调查分享 | 待决策 |
| 主机/网络/用户/实体风险 | 外部依赖 | 无威胁情报、实体存储、风险分数、资产关联和异常行为分析 | 待决策 |
| Elastic Defend/EDR 响应 | 外部依赖 | 无终端策略、恶意软件防护、进程调查、主机隔离及响应动作；需 Endpoint/Agent，不由桌面直接代替 | 待决策 |
| Cloud/Kubernetes Security | 外部依赖 | 无 CSPM/KSPM、漏洞、工作负载保护、基准检查和修复证据 | 待决策 |
| AI Assistant/Attack Discovery/EASE | 外部依赖 | 无安全上下文检索、跨告警攻击关联与分诊；部分能力为 Serverless 特有 | 待决策 |
| 安全 Cases 与外部响应平台 | 外部依赖 | 无团队案件、告警证据、流程联动和第三方系统同步 | 待决策 |

## 4. 版本、许可证与不宜照搬的功能

以下标记是本次官方文档的描述，不是对用户环境或已发布版本的推定。

| 项目 | 核实的边界 | 对 EScope 的建议 |
| --- | --- | --- |
| 7.17 与新版 ES/Kibana | 当前本机历史实测是 ES 7.17.25，现代 ES\|QL、Agent Builder、Workflows 等不能在该基线上承诺 | D05/C02 先锁精确版本、部署与权限，不因 UI 出现而标可用 |
| Agent Builder | 官方标记 Stack 9.2 Preview、9.3 起 GA，并要求相应订阅/Serverless feature tier | 作为独立集成或自有受控 AI 路线决策，不直接等同 A02 聊天 |
| Workflows | 官方标记 Stack 9.3 Preview、9.4 起 GA | 需要服务端执行、身份、审批和操作策略；不是桌面定时器 |
| 新版预览能力 | Query activity、部分图表/对象 API、实验性告警和 Custom panels 等有各自 Preview/Experimental/Planned 标记 | 单列跟踪，不进入跨版本默认支持清单 |
| Painless Lab | Query tools 官方标记 Beta | 可调研，不作为所有目标集群都具备的稳定工具 |
| TSVB/传统聚合编辑器 | 官方归入 Legacy，推荐 Lens；部分旧面板入口仅对已有内容显示 | 优先基础聚合/现代图表，不逐个复制旧编辑器 |
| Timelion | 官方标记 7.10 起弃用、Serverless 不可用 | 不作为新功能优先项，最多考虑旧资产查看/迁移 |
| Canvas | 当前文档说明仅对升级且已有 workpads 的安装可用 | 不把它当所有全新 Kibana 的必备入口，暂不复制自由画布 |
| Rollup | 文档明确 8.11.0 弃用并建议迁移 downsampling | 不新增 Rollup 优先路线；保留旧版本兼容调查 |
| Uptime | 官方标记 8.15 起弃用，建议 Synthetics，Serverless 不可用 | 若扩展探测，按 Synthetics 方向评估，不复制旧 Uptime |
| Playground | 文档标记 9.4 弃用，正文列出 9.6 移除，元数据仍有 Planned for removal 描述 | 记录为弃用/移除路线，具体安装另核；优先看 Agent Builder，不复制旧页面 |
| Search Applications | Beta；不推荐 9.x 新用户使用，9.2 起新用户 UI 隐藏，Serverless 为 API-only | 与 App Search 分开，不列为首发必须补齐 |
| App Search/Workplace Search/旧 Elastic Web Crawler | 升级文档明确 Enterprise Search 自 9.0 起不再提供；现代内容连接器不因此全部消失 | 仅旧部署迁移需求再评估，不按现行 Kibana 基础功能实现 |
| Serverless | 不开放传统节点/分片管理；ILM/Watcher/Graph 与部分报表不可用，CPS 不等于传统 CCS/CCR | 使用独立能力门控，不把“平台不提供”报成权限错误或 EScope 故障 |
| 订阅与 feature tier | ML、Graph、Watcher、DLS/FLS、部分动作连接器/报告等需逐项核对；PDF/PNG 官方明确为订阅功能 | 不笼统写“全部免费”或“全部付费”；自建/Hosted 看许可证，Serverless 还看项目 tier/add-ons |
| Cloud 控制面 | 账单、组织、部署创建/扩缩容、区域/实例、ECK/ECE 管理不等于 Kibana 数据面 | 不列为 EScope 核心必补；即使集成，也需要独立 API 与凭据边界 |

历史/弃用依据：[Timelion][timelion]、[Canvas][canvas]、[Rollup][rollup]、
[Uptime][uptime]、[Playground][playground]、[Search Applications][search-applications]、
[升级准备][upgrade]。许可证依据：[Licenses and subscriptions][license]。

## 5. 与现有计划的关系

### 已有任务，但还没有完成

| 现有任务 | 对应的主要缺口 | 不能误记为完成的原因 |
| --- | --- | --- |
| C01/C02/C03/C04、F08、E01 | 认证/CA、权限能力、Cloud/多节点、高级网络 | 凭据内部编排与无认证联调只是子项 |
| Q01/Q02/Q03/Q05 | 完整编辑体验、复杂条件、字段交互、结果性能 | 有受限可视化和交互表格，不代表完整 Discover/Monaco |
| Q06 | 聚合、图表、范围/近似解释 | 原始 `aggs` 可提交，不代表图表 UI 已实现 |
| Q07/F07 | 收藏/历史/参数、会话恢复、流式导出 | 当前持久化不包含这些对象 |
| Q08 | ES\|QL/SQL/EQL | 缺独立协议与目标版本验证 |
| O01-O07 | 持续采样、诊断、曲线、本地通知 | 固定只读页不能替代历史监控，更不能承诺 7x24 |
| A01-A05、E02/E03 | 完整模型策略、候选审核、证据解释、更多原生协议 | 现有文本多轮与显式附件不是完整查询/诊断助手 |
| W01-W11 | 写入审核、任务中心、文档/索引/加工/生命周期/备份/安全/REST | 正式后端仍为固定只读接口 |
| E04/E05、D05 | 跨集群、进阶 API、版本/许可覆盖 | 需逐项协议、权限和真实环境证据；E05 不等于整套 ML/Graph UI |
| R01-R04 | 发布、安全、性能、可访问性、支持矩阵 | 安装包曾构建但未完成实装/签名/跨平台；本次调研没有补验 |

### 盘点新增缺口的最新去向

| 能力组 | 对应/可复用任务 | 同日用户选择后的归属 |
| --- | --- | --- |
| Data Views/KQL/数据探索 | Q09/Q10/Q11、O05、Q02/Q03/Q05/Q07 | 纳入，任务待开发；本地视图与各语言协议分开，不承诺 Kibana 对象互通 |
| 单查询图表定义保存复用 | Q06/Q06a、F07、Q07 | 纳入，先单图分析，不依赖 Dashboard |
| Maps/Graph | G01-G05 | 纳入，先空间显示/聚合与关系探索；导入等待 W03，版本/许可/离线边界单列 |
| Dashboard/Vega | Q06/F07 可复用 | 本次不自动扩展，多面板或任意自定义可视化需另外选择 |
| Saved Objects/Spaces/协作/报告 | Q07、F07、F08 | 本地数据/配置导出纳入；Kibana 兼容、共享服务、PDF/PNG/定时报表不在本次主线 |
| 服务端规则/Connectors/Cases/Workflows | O07、W01/W02、E05 | 本次不扩展，不能由 O07 本地通知默默承担 |
| Fleet/Logstash/内容接入 | W03/W05/W06 | 文件导入与 ES Pipeline 纳入；外部采集控制面本次不扩展 |
| Observability/Security/完整 ML UI | O 系列、Q06、E05 | 本次不扩展成 APM/SIEM/ML 产品，已有能力和历史任务保留 |
| Agent Builder/MCP/RAG | A 系列、E05 | 本次不新增，保留现有 AI；没有自动检索或候选执行 |
| 新版专属功能/旧版资产迁移 | C02、D05、E04/E05 | 已选方向逐项确认 ES 小版本/部署/许可，未选能力不因版本更新而自动纳入 |

范围确认只新增待开发任务，不将 D05/E05 或任何业务父任务标记完成。

## 6. 初次盘点的建议顺序（历史）

以下是用户选择六方向之前的建议；最新范围和实际执行顺序以
[开发执行计划第 10 节](development-plan.md) 为准，不按下表派发未选择的整套 AI/监控/平台任务。
不估算虚构完成率、发布日期或工期。

| 顺序 | 建议交付 | 为什么优先 | 验收要点 |
| --- | --- | --- | --- |
| 1 | ES 认证/CA、权限与版本能力 | 不先解决就难以进入正常启用安全的测试/生产集群 | 最小权限的认证测试集群、401/403/TLS 分层、无秘密泄漏、无 monitor 仍可查询授权目标 |
| 2 | 查询保存/历史/恢复、CSV/JSONL 导出 | 日常工具最直接的缺口，且可与认证后端按接口边界并行推进 | 重启恢复不自动执行；数值无损；取消/部分文件；CSV 公式防护 |
| 3 | 时间筛选、字段统计、完整查询编辑与结果性能 | 建立真正的数据探索闭环，不只查看 JSON | 时间范围明确、复杂 DSL 无损、不把加载样本当总体；大结果基准、原生编辑/选择验收 |
| 4 | 基础聚合与图表，再决定轻量 Dashboard | 数据分析收益高，但图表与保存对象应先稳定 | terms/date_histogram/指标、近似/截断、图表筛选明确；Dashboard 另立范围 |
| 5 | 持续只读诊断；审核/任务框架后分批写管理 | 与既有 EScope 定位一致；安全前置决定写入顺序 | 采样断点/退避；W01/W02 先行；文档/索引、pipeline/ILM、快照恢复分别验收 |
| 6 | 进阶语言/AI 与 Kibana 集成取舍 | 避免复制整个服务端产品，按真实使用场景追加 | Q08 版本门控；A03/A04 同验；优先集成已有告警/Fleet/APM/SIEM 而非重建引擎 |

任务 W11 当前依赖 W01/W02/Q03。若希望提前做只读 Console，需要先单独定义受限子项，
不能为了补齐 Kibana 功能而开放任意 method/path/header 代理。

### 用户确认后的产品边界

- **已确认主线**：连接与权限、数据探索、保存与导出、聚合与图表、受控数据管理、地图与关系。
- **已有能力保留**：AI 聊天、只读观测、主题语言与桌面交互；安全、发布和回归要求继续执行。
- **本次不扩展**：Dashboard、Vega、共享服务、服务器告警、Cases、Fleet、APM/SLO、
  Security、完整 ML/Agent Builder/Workflows。以后纳入时再决定集成或自建。
- **暂不追平**：遗留编辑器、Canvas/Timelion/Rollup、已退出的 Enterprise Search、Cloud 账单和部署控制面。

选择 Kibana 集成时，必须有独立的服务地址、凭据引用、Space/版本能力和类型化 IPC。
不直接写 `.kibana*`、`.fleet*` 等内部索引来仿造对象，不隐式扩大原连接权限，
也不静默把查询、文档或历史转发到其他服务。

## 7. 初次盘点的验证与未验证事项

本节是用户选择六方向之前的验证记录；同日范围变更的检查见执行计划第 10.4 节与 AGENTS。

- 已静态核对：正式路由、IPC 注册、ES 操作注册、认证拒绝、原始 DSL 通道、
  可视化范围、结果解析、索引/别名/数据流目录、采样行为、数据库迁移、AI 调用范围。
- 已读取官方页面及版本/部署提示；来源列在各节和下方引用。一次旧告警目录返回 404 后，
  改用当前 `alerting/alerts` 与 `cases` 页面，不以旧地址作为证据。
- 本次仅修改盘点、进度交接和文档入口，不修改正式代码、原型、依赖或数据库。
- 不运行前端/Rust 回归，不启动浏览器/WebView，不访问真实 ES/模型/密钥库，
  不重建安装包；未新增服务、自动化、提交或推送。
- 文档检查通过：`git diff --check`；使用已有 remark/remark-gfm 解析 5 份相关文档，
  74 个本地链接目标、78 处引用与本报告 22 张表格均无错误；
  新文档 LF、末尾换行与尾部空白检查通过，共 37 个官方来源定义。
- 既有 712/16、Rust 192 等属于前轮证据，不作为本次运行结果。
  原有人工/跨平台/带认证联调仍待补验。
- 后续实施每个功能前，仍须针对目标 ES/Kibana 小版本、部署类型、许可、权限，
  以及 API/UI 是否稳定重新核对，不能把这份功能盘点直接当支持承诺。

## 8. 官方资料

以下链接均为 Elastic 官方资料；本次读取日期统一为 2026-10-09。
版本信息以相应页面的 `applies_to`、提示框和目标部署实际能力共同确认。

- [Kibana 分析功能总览][overview]
- [Discover][discover]、[文档表格][document-explorer]、[Data Views][data-views]
- [可视化总览][visualize]、[Lens][lens]、[Dashboards][dashboards]
- [Maps][maps]、[Graph][graph]、[Query tools][query-tools]
- [Index Management][index-management]、[Ingest pipelines][pipelines]、[ILM][ilm]、[快照恢复][snapshots]
- [Monitoring][monitor]、[部署与权限管理][manage]、[Spaces][spaces]
- [Saved objects][saved-objects]、[Reporting][reporting]
- [Alerting][alerting]、[Cases][cases]、[Watcher][watcher]、[Workflows][workflows]
- [Machine Learning][ml]、[Elasticsearch solution][search-solution]、[Agent Builder][agent-builder]
- [Fleet][fleet]、[Observability][observability]、[Security][security]
- [许可证与订阅][license]
- [Canvas][canvas]、[Timelion][timelion]、[Rollup][rollup]、[Uptime][uptime]
- [Playground][playground]、[Search Applications][search-applications]、[升级准备][upgrade]

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
