# Q06 聚合构建与定义保存 (Q06a) 验收记录

日期：2026-10-13。依据 `docs/development-plan.md` 第 10.34 节与 `docs/development-backlog.md` 推进。
交付范围：可视化聚合构建器（Aggregation Builder）、聚合/图表定义保存与复用（Saved Charts / Aggregations Library，Q06a）、SQLite Schema v9 迁移与后端 CAS 存储、以及执行结果聚合视图的一键存图表入口。

---

## 1. 交付功能与设计边界

| 模块 | 交付能力 | 边界与安全规则 |
| :--- | :--- | :--- |
| **可视化聚合构建器** | 单值指标（`sum` / `avg` / `min` / `max` / `value_count` / `cardinality`）与单层桶（`terms` / `date_histogram`，支持直接子指标）构建界面 | 仅支持有界单值与单层桶结构（最多 32 个顶层聚合定义，每桶最多 16 个直接子指标）；基于同连接与完全相同目标的已核对 field capabilities 提供字段适宜性提示与安全拦截（非数值字段阻断数值指标、非日期字段阻断 `date_histogram`、不可聚合与 text 字段提示 `fielddata` 风险、冲突字段明确标记） |
| **无损 DSL 预览与应用** | 纯文本与 JSONC 语法树解析并预览根 `"aggs"` / `"aggregations"` 变更对比（DSL Diff） | 生成 DSL 严格遵守 256 KiB 上限；仅精确替换或新增顶层 `"aggs"`，完全保留原 query、bool filter、高阶字段与时间范围绑定；显式点击应用，**不自动执行查询**，**不改动已执行快照与 PIT** |
| **定义保存与复用 (Q06a)** | 保存聚合与图表定义库（Saved Charts），包括名称、连接 ID、索引目标、默认图表偏好（metric / bar / line / table）与聚合子句 | 后端独立 SQLite 存储表 `saved_chart_library`（单例 ID=1，版本 CAS 递增修订号，单行 256 KiB 上限，最多 100 条定义）；删除连接时保留已保存定义身份而不级联删除（连接丢失明确标识不可重绑）；支持一键复制定义 JSON 到剪贴板与全量导出 |
| **查询结果快捷保存** | 在查询结果「聚合 / Aggregations」列表与图表卡片顶部提供「保存为图表定义 / Save as Chart」快捷入口 | 从真实已解释执行响应中提取字段、指标类型与桶类型，自动回填至保存对话框；冻结本次结果身份，不回填未返回字段或发起额外网络查询 |

---

## 2. 自动化验证覆盖

- **Rust 后端与存储迁移**（`cargo test --manifest-path src-tauri/Cargo.toml saved_charts`）：7 项测试全部通过
  - `saved_charts::tests::empty_library_is_valid`: 空库与初值校验；
  - `saved_charts::tests::valid_definition_validates_and_roundtrips`: 正常定义与子指标往返序列化；
  - `saved_charts::tests::invalid_chart_types_and_ids_are_rejected`: 非法图表类型、超长名称、脏字符 ID 拒绝；
  - `saved_charts::tests::invalid_aggregation_clauses_are_rejected`: 缺少必填字段、非法聚合类型拒绝；
  - `saved_charts::tests::invalid_sub_metric_is_rejected`: 非法子指标类型拒绝；
  - `saved_charts::tests::over_sized_stored_json_fails_closed`: 超过 256 KiB 单行安全拒绝；
  - `storage::tests::saved_charts_migration_preserves_v8_rows_and_reopens`: SQLite Schema v8 -> v9 升级迁移保持旧数据并成功创建 `saved_chart_library` 表。
- **Rust 代码格式验证**（`cargo fmt --check --manifest-path src-tauri/Cargo.toml`）：0 差异，通过。
- **前端领域模型与组件单元测试**：
  - `tests/unit/saved-charts.test.ts`（7 项全部通过）：
    - 结构解析、空库与边界校验；
    - 单子句与带直接子指标桶结构校验；
    - 超长 ID、名称与超过 32 子句上限拒绝；
    - ISO8601 时间戳严格验证与防篡改；
    - 变更比较函数 `sameChartDefinition`。
  - `tests/unit/query-aggregation-builder.test.ts`（6 项全部通过）：
    - 字段适宜性与能力筛选（numeric/date/keyword/text）；
    - 生成合法 Elasticsearch DSL 聚合对象；
    - 从现有 rawDsl 解析聚合子句与子指标；
    - JSONC 差异预览生成与无损根 aggs 替换，保留其他查询属性；
    - 超过 256 KiB 边界安全拒绝。
  - `tests/unit/saved-charts-ui.test.tsx`（2 项全部通过）：
    - 渲染保存图表列表、加载回查、复制与过滤；
    - 关键字搜索过滤交互与空状态展示。
  - `tests/unit/aggregation-builder-ui.test.tsx`（2 项全部通过）：
    - 构建器对话框渲染、添加 terms 聚合与应用 DSL 回调；
    - terms 聚合动态添加子指标与应用回调验证。
- **回归测试套件验证**：
  - `tests/unit/query-aggregations.test.ts`（88 项回归全部通过）；
  - `tests/unit/query-aggregations-ui.test.tsx`（21 项回归全部通过）；
  - `tests/unit/query-aggregations-chart-ui.test.tsx`（2 项回归全部通过）；
  - `tests/unit/query-chart.test.ts`（5 项回归全部通过）；
  - `tests/unit/app-query-integration.test.tsx`（5 项回归全部通过）。
- **代码规范检查**（`npm run lint`）：0 error, 0 warning，通过。
- **静态类型检查**（`npm run typecheck`）：Strict 模式 0 error，通过。
- **前端生产打包构建**（`npm run build`）：Vite 客户端生产构建成功通过。
- **独立原型回归**（`npm run build:prototype && npm run test:prototype`）：16 项测试全部通过。

---

## 3. 待人工验收事项

以下事项列入后续平台集中人工验收：
- 真实 Elasticsearch 集群下多索引模式通配符字段能力的下拉提示流畅度；
- 在极端深层 JSON DSL 下进行可视化聚合替换后 Monaco 编辑器的重绘与滚动位置保持；
- 桌面环境（Windows NSIS）SQLite 实际持久化写入与应用关闭重启后的图表库读取一致性；
- 高对比度主题与屏幕阅读器（a11y）中子指标嵌套折叠的语音读屏提示。
