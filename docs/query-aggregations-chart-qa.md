# Q06 基础图表验收记录

日期：2026-10-13。依据 `docs/development-plan.md` 第 10.33 节及用户指令推进。
交付范围：单值指标卡片（Metric Stat Card）、单层 Terms 柱状/条形图（Terms Bar Chart）与单层 Date Histogram 日期折线图（Date Histogram Line Chart）。

---

## 1. 交付功能与设计边界

| 模块 | 交付能力 | 边界与安全规则 |
| :--- | :--- | :--- |
| **单值指标** | `sum` / `avg` / `min` / `max` / `value_count` / `cardinality` 测量卡片 | 保留精确原始文本 token，`cardinality` 显式标注近似值，`value_count` 显式标注值数量而非文档数；支持一键复制，缺失或 null 明确显示 |
| **Terms 条形图** | 矢量 SVG 条形图，支持 `doc_count` 与桶内直接子指标切换 | 自动计算比例尺，桶标签 strip 外层引号，超出视口支持横向滚动；随图展示 `doc_count_error_upper_bound` 与 `sum_other_doc_count`（截断桶）告警；非有限数字独立标记为未绘制（unplottable），不静默归零 |
| **Date Histogram 折线图** | 矢量 SVG 折线与渐变面积填充，数据点高亮与悬浮 Tooltip | 严格遵守**不自动补桶**、**不推算结束边界**；保持时间轴原始顺序；支持在 `doc_count` 与子指标间切换；清晰标注未补桶免责声明 |
| **视图切换** | 桶聚合提供「聚合表格 / Bucket table」与「图表 / Chart」双模式切换 | 默认进入表格视图，状态仅在会话中保留；切换不发起新查询，不修改或执行 DSL，不修改 PIT 状态 |

---

## 2. 自动化验证覆盖

- **单元与组件测试**：
  - `tests/unit/query-chart.test.ts`（5 项测试全部通过）：
    - `parsePlottableNumber` 精度保留与非有限数字拒绘；
    - `buildMetricChartData` 近似与值计数标注；
    - `buildTermsBarChartData` 桶映射、子指标选择、截断桶统计与拒绘项计数；
    - `buildDateHistogramChartData` 不补桶验证与选项提取。
  - `tests/unit/query-aggregations-chart-ui.test.tsx`（2 项 UI 测试全部通过）：
    - Terms 表格与条形图双向切换、SVG 元素与截断桶提示；
    - Date Histogram 折线图、时间轴文本与免责声明验证。
  - `tests/unit/query-aggregations.test.ts`（88 项回归全部通过）。
  - `tests/unit/query-aggregations-ui.test.tsx`（21 项回归全部通过）。
  - **总计**：4 测试文件、116 项测试全部通过（0 失败）。
- **代码规范检查**（`npm run lint`）：0 error, 0 warning，通过。
- **类型检查**（`npm run typecheck`）：Strict 模式通过。
- **前端生产构建**（`npm run build`）：通过。
- **依赖安全审计**（`npm audit --omit=dev`）：0 漏洞。

---

## 3. 待人工验收事项

以下事项列入后续集中人工验收：
- 真实多屏高 DPI 下 SVG 柱状图与折线图的抗锯齿与像素渲染；
- 超多桶（上百桶）横向滚动时的平滑度与性能；
- 原生高对比度模式与屏幕阅读器（a11y）的可访问性；
- 复杂时区与 DST 夏令时时间戳标签的本地化排版。
