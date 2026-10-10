# Q05 已加载文档对比

日期：2026-10-10。从干净 `7d1cd15` 接手，沿用 `main`。
状态：开发、领域/JSDOM 与构建自动化通过；真实 ES、原生、性能和跨平台待验。
本批仅比较同一执行的两条已加载记录，不包括时间上下文、额外文档读取或完整 Q05。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 入口 | 查询和索引结果底栏的 Lucide 对比按钮，恰好选中两条时启用；可跨已加载页、本地分页与排序 | 不按显示序号、`_id` 或 `_source._id` 找记录，不自动查字段、取文档或续页 |
| 身份 | 内部 `ResultHit.raw` 指向接收页的完整 hit；核对原 hit 对象及页/行位置，捕获稳定连接 ID/端点/请求目标/执行 ID/开始时间 | 相同 `_index`/`_id` 的不同接收记录保持独立；真实 `_id` 未返回时不把位置回退值冒充它 |
| 内容 | 元数据、`_source`、`fields` 分开；顶级字段逐项比较，嵌套对象/数组作为完整值 | 不扁平化点键或猜 ES nested/Mapping；当前执行 DSL 的 runtime 仅标记 fields 来源，不从草稿/视图库推断或回填 source |
| 语义 | 未返回、null、空字符串/数组/对象、类型变化、单侧返回、值相同/不同 | 缺失不等于索引字段不存在；两侧均未返回为未知而非相同；不代表未加载或被投影/FLS 隐藏的数据 |
| 操作 | 来源分段、仅差异开关、字段查找、50 项分页、左右交换、原值/整条原始 hit 复制及剪贴板失败 | 仅改变本地对比视图；不修改 DSL、结果、时间/参数、列布局或 PIT，不发送模型内容 |
| 生命周期 | 仅点击时生成深冻结副本；草稿/端点变化仍显示旧执行来源和提示，续页不替换副本 | 新执行在渲染时阻断旧弹窗，离开标签/设置关闭且不自动重开；关闭释放，不进入恢复/查询库/历史 |
| 交互 | 原生控件、双语可访问名称、共享 Modal/焦点和主题 token；长 ID/字段/值有有界滚动 | JSDOM 的焦点/事件与 CSS 约束不是原生像素、屏幕阅读器或剪贴板证据 |

JSON 对象属性顺序、容器空白、字符串等价转义不影响值相等；数组顺序必须一致。
数值复用精确十进制/BigInt 比较，`1E400` 与 `10e399`、`1.0` 与 `1`、`-0` 与 `0` 为值相同，
相邻超大整数与长小数不能因浮点舍入变相同。显示和复制仍分别保留两边原始 token；
这不是逐字节 diff，也不从数字文本推断 ES Mapping 类型。仅差异开关按值语义筛选。
原文以 React 文本渲染，不执行 HTML、脚本或外部链接。

## 有界合同

- 每条原始 hit 最多 **1 MiB UTF-8**，两条最多 **2 MiB**；不重新解析整页响应。
- 先扫描再解析：最多 **64 层 JSON 容器**、每 hit **100,000 token**，数字最多 **4,096 字符**，
  在精确 BigInt 指数计算之前限额。严格 JSON reader 继续拒绝重复/转义重复键、注释、尾逗号和无效文本。
- 元数据/source/fields 的对比项合计最多 **4,096**，含必要的容器状态和未返回 runtime 项。
  任一侧超限整次拒绝，不显示截断的“完整对比”；表内每页最多 **50** 项。
- 空 `fields` 与完全未返回 `fields` 即使存在 runtime 声明仍分别保留；非对象容器原样整项比较。
- 无新依赖、Rust、IPC 命令或 schema 迁移。schema v8、恢复/查询/视图文档 v1、
  固定库 v3、DSL 快照 v4 保持。`ResultHit.raw` 只是前端解析范围，不进入请求或持久化。

## 本次验证

最终前端 **11 文件 243 项**全部通过，**11 文件 lint**、typecheck/正式构建通过。
先前 10 文件 237 项与最终范围重叠，不累加。末轮英文计数文案改为标签形式，
**3 文件 70 项**复验及 lint/typecheck/构建重新通过，覆盖重叠不相加。
测试均使用 `--maxWorkers=2`，未提高默认超时。

| 检查 | 本次证据 |
| --- | --- |
| 领域 53 项 | 精确数字/指数、嵌套结构与数组顺序、相同摘要但不同完整值；元数据阴影/点键/原型键、真实缺失 ID、runtime 来源和空容器 |
| 配额与身份 | 1 MiB 边界/UTF-8/64 层/token/数字/联合字段数；重复选择、旧 hit 对象、非法页/行/范围、无歧义 JSON；深冻结后草稿和页替换不改副本 |
| 新 UI 12 项 | 恰好两条、跨已加载页/本地分页/排序、JSON/设置/标签往返、同步关闭新执行、续页冻结、部分与旧目标提示、复制失败、查找/分页/双语 |
| 既有回归 | result reader/grid、执行/工作台、已加载导出/查询库、工作区恢复；新增字段格式用例证明百分比/分组显示不污染比较或复制 |
| 构建 | 主 JS **1,410.87 kB**，主 CSS **116.32 kB**；延迟 Monaco **3,125.21 kB**、CSS **142.38 kB**，worker **275.63 kB**；原大包警告保留 |
| 文档/diff | 20 文件 UTF-8/LF、8 文档/250 本地链接/60 张 GFM 表格及空白检查通过；秘密模式检查未发现命中，不含本机配置 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/document-comparison.test.ts tests/unit/document-comparison-ui.test.tsx tests/unit/query-result.test.ts tests/unit/result-grid.test.ts tests/unit/result-grid-ui.test.tsx tests/unit/query-live.test.tsx tests/unit/query-executions.test.tsx tests/unit/query-export.test.ts tests/unit/query-library.test.ts tests/unit/app-workspace-recovery.test.tsx tests/unit/field-formats-grid.test.tsx
npm test -- --maxWorkers=2 tests/unit/document-comparison.test.ts tests/unit/document-comparison-ui.test.tsx tests/unit/field-formats-grid.test.tsx
npx eslint src/domain/document-comparison.ts src/domain/query-result.ts src/features/query/DocumentComparisonDialog.tsx src/features/query/QueryResults.tsx src/features/query/QueryResultGrid.tsx src/locales/document-comparison.ts src/locales/index.ts tests/unit/document-comparison.test.ts tests/unit/document-comparison-ui.test.tsx tests/unit/query-export.test.ts tests/unit/field-formats-grid.test.tsx
npm run build
```

开发中修正：

1. 首轮领域/reader **80/81**；超限测试把空白加在 hit 外，未扩大实际记录。
   改为在 hit 内增加字节，并保留精确边界/UTF-8 断言；不调整配额。
2. 新增 runtime 空容器反例先红：只有声明、无返回值时漏掉空对象/缺失容器区别。
   加入独立容器项后通过；不将缺失 runtime 值回填 `_source`。
3. 新 UI 两处查询定位错误分别为 summary 内的 `bdi` 和详情两段原文均命中；
   改为核对真实 summary 与两段原文。新测试的多余 `exact` 参数及字符串转义 lint 同步修正。
   中间 2 文件 **61/64** 后的 10 文件 **237** 与最终 **243** 通过均有实际命令，不挪用历史记录。
4. 补充格式化表格的原值对比/复制回归，以及长 ID/字段名有界滚动与焦点约束后，
   最终范围和构建重跑通过。

主代理独占实现、diff 复核与验证；无 OMP、worktree、持久服务或用户数据库操作。
未启动浏览器/WebView/真实 ES/模型，未构建安装包；未改原型/Rust/依赖，不重复其全量/fmt/clippy/审计。
不声明本轮 CI、原生性能或真实权限验收通过。

## 待验与接续

[集中人工清单](manual-acceptance.md) 单列多选/键盘/焦点返回、长 ID/字段/JSON、
中英文/日夜/强调色/200%/高对比/屏幕阅读器、原生剪贴板失败/重启与跨平台。
授权真实环境补验 source 投影/FLS/runtime 缺失、同 ID 跨索引/跨页、部分结果、
端点变化/重跑和本地比较期间无额外请求；限额拒绝不是大文档性能达标证据。

下一批按第 10.2 节继续 **Q05 宽结果表格虚拟化首批**，先限定已加载列的窗口化和有界验证，
保留 TanStack/dnd-kit 的列交互、真实行选择、详情/对比/原值复制与本地排序，不通过滚动查询。
时间上下文、字段详情、行虚拟化/大结果原生基准、Q03 原生/深层建议和六方向其余任务仍开放。
本批本地提交后仅创建一个 local 后继，之后停止写仓库并更新既有监控，不推送、不提前睡眠。
