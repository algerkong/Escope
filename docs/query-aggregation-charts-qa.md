# Q06 基础聚合图表

日期：2026-10-10。从干净 `17af981` 接手，沿用 `main`。
状态：开发、领域/JSDOM/工作台/类型检查与构建自动化通过；真实 ES、原生渲染、性能和跨平台待验。
本批只在既有会话聚合视图内增加绘图，不交付聚合构建、完整 DSL 预览应用、图表定义保存或 Dashboard，不关闭 Q06/Q06a。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 图型 | 单值指标卡、单层 terms 条形、单层 date_histogram 折线，按执行 DSL 已解析的条目类型自动确定 | 不从响应形状、当前草稿或字段证据猜类型；`unrequested`/`unsupported`/`missing`/`invalid` 明确说明不可绘图并保留原文与表格 |
| 输入 | 只消费上一批 `readAggregationPage` 的单个条目：所选聚合、所选原接收页 | 不重新解析 JSON、不合并接收页、不额外请求、不自动续页或重跑；新页到达时已打开的图仍绘原选择页 |
| 转换 | 独立严格十进制校验、有限性、下溢、安全整数和最短往返精度核对；绘制值与原 token 并列保留 | 精确性只保证 token→double 转换无损，不代表 ES 数学精确；缺失/null/非数字/超范围一律列为未绘制并给原因，绝不画成 0 |
| 桶序 | 条形保持返回顺序与槽位，被跳过的桶保留空槽；折线按数字 key 定位并在跳过处断开 | 不重排为其他语义、不补空桶、不推结束边界；折线段仅连接相邻返回行，缺口不代表 0 |
| 标签 | 优先返回的 `key_as_string`，否则数字/字符串 `key` 原 token；截断仅为显示 | 客户端不解析或格式化日期；`<title>`、复制与桶表格保留完整原 token |
| 度量 | `doc_count` 与执行 DSL 已解析的直接指标可选，默认 `doc_count`；未知或不存在的度量整体拒绘 | 不静默回退；cardinality 标近似、value_count 标“值数量不是文档数量”，与表格口径一致 |
| 提示 | 近似、误差未知/未报告、`sum_other_doc_count`、Top N 非完整分布、仅桶起点、断线、精度损失计数随图显示 | 接收页 partial/超时/提前终止/分片/跨集群/post_filter/脚本/runtime 仍在上方列出，图内明确这些限制同样适用；不据此宣称完整统计 |
| 标注 | 图范围标注冻结目标索引、接收页序号、所选度量、绘制/返回桶数与冻结绝对时间边界原文 | 时间与来源只作显示，不进入任何请求；索引/目标来自执行快照，非当前编辑器值 |
| 交互 | 条目标题栏显式“显示/隐藏图表”开关、度量选择器、可聚焦滚动区域、双语与可见焦点 | 无点击、无拖拽、无悬停查询、无导出、无持久化；不新建路由或管理首页，不改表格/JSON 视图与文档导出合同 |
| 生命周期 | 图表与解析结果只在会话内存，条目/接收页切换按既有 key 重挂载复位，新快照身份或离开视图即清理 | 不写入恢复存储；隐藏聚合页仍隐藏“导出已加载结果”，避免被误当成桶导出 |

## 图表库选型

| 项 | 结论 |
| --- | --- |
| 采用 | `@visx/scale`、`@visx/shape`、`@visx/group` 精确锁定 `4.0.0`，React 19 peer、纯 SVG、无 canvas 测量 |
| 许可 | visx 与 classnames 为 MIT，`@visx/vendor` 为 MIT and ISC，d3-* / delaunator / internmap 为 ISC，robust-predicates 为 Unlicense；3 个直接依赖另新增 29 个锁定条目 |
| 适配 | 只取尺度与路径生成，坐标轴由本项目自绘，避免依赖 DOM 文本测量；JSDOM 可断言结构与 `d` 属性，原生像素仍单列 |
| 安全 | 扫描 `@visx/{scale,shape,group,curve,vendor}` 产物无 `eval`/`new Function`；全部本地打包，符合 `script-src 'self'`，不新增远程脚本、worker 或 `unsafe-eval` |
| 体积 | 绘图运行时是动态加载的独立 chunk `AggregationChartCanvas` 40.45 kB（gzip 15.18 kB），只在明确打开条图/折线图时请求；单值卡不加载该库 |

## 配额

| 对象 | 本批限制 | 超限行为 |
| --- | --- | --- |
| 绘制桶数 | 单条目最多 200 个已返回桶 | 整次拒绘并报告返回数，指向桶表格；不截取前 200 个 |
| 坐标标签 | 每轴最多 12 个，含首尾；单个标签显示截断到 20 字符 | 仅显示截断，原 token 仍在 `aria-label`、`<title>` 与表格中 |
| 未绘制清单 | 逐条列出前 10 项 | 其余合并为“另见桶表格”的计数，不丢总数 |
| 数值 token | 沿用聚合读取的 4,096 字符数字上限与 256 KiB DSL/1 MiB 原页 | 读取阶段已整次拒绝者不进入绘图；绘图阶段按 token 判定为超范围并列出 |

不将上述边界或 JSDOM 元素数量当作原生内存、绘制耗时、滚动帧率与可访问性达标证据。

## 本次验证

前端有效覆盖 **13 文件 340 项**：新增 **3 文件 48 项**（领域 29、图表 UI 16、加载失败 3），
聚合读取/UI **2 文件 109 项**与相邻结果回归 **8 文件 183 项**复跑通过；
**10 文件 lint**、最终 typecheck/正式构建通过；前端均为 `--maxWorkers=2`，没有提高超时。

| 检查 | 本次证据 |
| --- | --- |
| 领域 29 项 | 槽位/顺序/真实 0、度量选择与未知度量拒绘、null/未返回/非数字/溢出/下溢、精度标记与原 token、断线与位置保留、误差/遗漏/近似口径、空桶与超预算整次拒绘、原型键名、纯函数不改输入 |
| 图表 UI 16 项 | 显式打开才挂载、条/线数量与 `d` 有限、冻结目标/页码/度量/时间边界标注、partial 与限制提示、跳过清单与超限汇总、 hostile 文本不入 DOM、双语键一致、新快照/离开/切视图清理、续页不换图 |
| 集成 5 项（含上表） | 复用既有 `QueryResults` 装配，验证不触发 run/loadMore/cancel/view/layout 回调与 `fetch`；预览与别的查询身份不出现图表入口 |
| 相邻回归 | query-aggregations 领域/UI、query-result、query-executions、result-grid UI、详情/对比 UI、query-library UI、workspace-recovery、query-live；未运行无关全量 |
| 构建 | 主 JS **1,501.89 kB**（较上批 +15.14 kB）、主 CSS **127.89 kB**（+2.66 kB）、图表 chunk **40.45 kB**；Monaco **3,125.21 kB** 不变，原大包警告保留 |
| 依赖 | `npm install` 后完整与生产 `npm audit` 均为 0；新增 3 个直接依赖与 29 个锁定条目，无 Rust/原型/CI 变更 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/query-aggregation-charts.test.ts tests/unit/query-aggregation-charts-ui.test.tsx tests/unit/query-aggregation-chart-loader.test.tsx tests/unit/query-aggregations.test.ts tests/unit/query-aggregations-ui.test.tsx
npm test -- --maxWorkers=2 tests/unit/query-result.test.ts tests/unit/query-executions.test.tsx tests/unit/result-grid-ui.test.tsx tests/unit/document-detail-ui.test.tsx tests/unit/document-comparison-ui.test.tsx tests/unit/query-library-ui.test.tsx tests/unit/workspace-recovery.test.ts tests/unit/query-live.test.tsx
npx eslint src/domain/query-aggregation-charts.ts src/features/query/charts src/features/query/QueryAggregations.tsx src/locales/query-aggregation-charts.ts src/locales/index.ts tests/unit/query-aggregation-charts.test.ts tests/unit/query-aggregation-charts-ui.test.tsx tests/unit/query-aggregation-chart-loader.test.tsx
npm run build
```

首轮 29 项领域测试有 1 例因夹具 JSON 少一个右括号被读取阶段拒绝，补齐后通过；
UI 首轮 16 项有 7 项失败，均为断言写法问题（插值模板当字面量匹配、`toHaveAttribute` 传正则、
同名文本命中坐标刻度与跳过清单两处、直方图夹具多余括号、把 Lucide 图标 SVG 当成图表 SVG），
改用作用域查询与 `.qac-*` 类选择器后 16 项通过，未修改断言语义。加载失败用例先断言瞬时 loading
态不稳定，改为断言失败提示、无 `.qac-state` 残留与重试计数，红绿证据见本节。

主代理独占实现、diff 审查与验证，无 OMP/worktree/用户数据库/真实服务或持久服务操作。
无 Rust/IPC/schema 或 DSL/PIT/恢复合同变更，schema v8、恢复文档 v1、固定库 v3、执行快照合同 v4 保持。
未启动浏览器/WebView/预览服务，未构建安装包；未改原型/Rust，不重复其全量/fmt/clippy/审计。

## 待验与接续

[集中人工清单](manual-acceptance.md) 保留：

- 原生 SVG 像素、日夜主题与高对比下的条形/折线/网格可读性、横向滚动与键盘焦点、200% 缩放与窄窗。
- 真实 ES 的 terms 误差/排序/遗漏、cardinality 近似、`value_as_string` 缺省、大 `doc_count` 溢出、
  date_histogram 真实 interval/时区/DST/keyed/缺桶与负 key。
- 200 桶条图/折线的原生绘制与切换耗时、内存和动态 chunk 实际加载时延。
- 原生 tooltip（SVG `<title>`）、屏幕阅读器对 `role="img"` 摘要与轴文本的朗读、剪贴板不参与本批交互。

下一批按第 10.2 节推进 **Q06 聚合构建与完整 DSL 预览/显式应用**：分组 + 指标形成待审 DSL，
保留手写条件/时间绑定/排序/参数模板，审核后不自动执行；随后 Q06a 图表定义保存/复用/本地交换，
再扩公式/同比环比/双轴/图层。进阶图表仍受本批同一精度与配额规则约束。
Q05 时间上下文/完整 Mapping/行虚拟化/原生基准、Q03 原生、Q08/Q10/Q11、
nested runtime/深层条件和 W01/W04 不被本批跳过或关闭。
本批本地提交后创建一个 local 后继，停止写仓库并更新既有监控，不推送、不提前睡眠。
