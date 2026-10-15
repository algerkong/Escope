# main/dev 合并验收

日期：2026-10-15。范围：合并本地 main 与 origin/dev，并保留接手时未提交的图表工作。
本批是开发/自动化验证，不代表真实 ES、用户数据库、原生 UI 或跨平台验收通过。

## 基线与保留

- 共同基线 `17af981`；本地 `d5aab14`，远端 `491bf48`。未丢弃任一分支提交。
- 原本地图表/保存/面板工作先存入检查点 `3fccd6c`，此前 5 文件 22 项和 typecheck 通过。
- 接手时 README 简化、package.json 的 `seed:es` 与未跟踪 seeder 单独保留，不运行测试数据写入脚本，不纳入合并功能提交。
- OMP 存储任务异常退出，无有效实现报告；生成的两份分支原文件副本经 Git blob 哈希核对后移到系统临时报告目录。
  主代理完成全部冲突处理、兼容代码和独立验证，不把派发记作审查通过。

## 实际合并

| 范围 | 结果 | 边界 |
| --- | --- | --- |
| 图表与构建 | 统一接入 Visx 图表、受限分组/指标构建、定义保存/复用和本地交换；保留折线双轴 | 无重复主工具入口，原有本地实现/测试仍保留；原桶表继续可见，不自动查询 |
| 旧库 | 图表定义库中提供旧库兼容入口，保留旧定义原文与身份 | 同连接/精确目标且无损支持时仅播种审核；排序、min_doc_count、混合形状等不丢弃后复用 |
| 执行快捷保存 | 结构化核对执行 rawDsl 与原聚合定义，保存实际字段、请求 size、间隔/时区和主度量 | 不从响应桶数、指标名或当前草稿推断；未知选项/元数据拒绝；全文字面量确认，不存结果或第二度量 |
| 生命周期 | 新快照、离开结果视图、换接收页/聚合关闭保存对话框 | 旧执行来源与当前草稿分离；保存不执行、不改 DSL/PIT |
| 面板 | 保留结果拖动与最大化，修复隐藏编辑器被 flex 样式显示及跨索引筛选栏隐藏 | 仅逻辑/结构验证，原生布局与焦点待验 |

## 数据库兼容

两个历史 v9 分别使用 `009_saved_charts.sql` 和 `009_chart_definitions.sql`。
这两份历史迁移保持原样，新增 `010_merged_chart_libraries.sql`：

- 新建/v8 数据库走原 chart_definitions v9 后升 v10；任一已有 v9 或两表并存 v9 均只补齐缺表。
- 已有 JSON 字节、修订号、定义 ID、连接身份原样保留，不自动转化或合并库。
- 使用 SQLite 返回的已知历史 DDL 指纹核对结构；缺少两表、异常列/约束/同名视图拒绝，不自动修复。
- 两表保持原 singleton、256 KiB 和 JS 安全 revision CHECK，独立 CAS；保存/导入的连接检查保持。
- 迁移和版本变更同事务；损坏文档不被改写，相关库读取/写入继续拒绝，其他库不伪造旧数据。
- 未来 schema 拒绝，旧连接、凭据、视图、固定筛选与工作区数据不重写。

## 本轮验证

前端有效覆盖 **32 文件 483 项**，均使用 `--maxWorkers=2`：

```sh
npm test -- --maxWorkers=2 chart-definition query-aggregation query-chart saved-charts aggregation-builder results-resize-handle app-query-integration app-query-time-range app-query-sort app-query-filters app-index-tabs
npm test -- --maxWorkers=2 tests/unit/app-query-filters.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-query-filters.test.tsx -t "does not hide a locked-index"
```

第一条在与 Rust/build/lint 并行时为 481/482，筛选设置往返用例达到原 5 秒超时；
停止其他重检查后该文件 16/16 单独通过，未提高阈值。随后新增面板跨索引用例单独通过，
因此最终按 483 个唯一用例计数，不重复累加之前 7 文件 53 项或检查点 22 项。
最初图表/表格各自显示截断提示导致定位器不唯一，已改精确文案；测试桩参数类型和最大化按钮完整名称已修正。

Rust：

```sh
cargo test --manifest-path src-tauri/Cargo.toml storage::chart_library_merge_tests
npm run test:rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

新增迁移/回滚/异常结构/未来版本/独立 CAS **8/8**；
完整 Rust **458 通过、6 默认忽略**，包含上述 8 项，不另累加。真实服务和真实密钥测试未启用。

`npm run lint`、对应文件补充 lint、`npm run typecheck`、`npm run build`、`git diff --check` 通过。
保留主包/Monaco 大包警告；未做不相关依赖升级、严格 clippy、原型或安装包构建。

## 剩余验收

- 两个实际桌面 v9 数据库副本升级、重启、只读/磁盘故障与旧库读取。
- 原生长值、缩放、焦点、剪贴板、屏幕阅读器、最大化/拖动和 Monaco 布局。
- 真实 ES 聚合、FLS/权限、日期/DST、部分结果及双轴语义；不以 JSDOM 证明性能。
- 场景见 [集中人工清单](manual-acceptance.md)。Q06/Q06a 及六方向父任务继续开放。
- 合并提交后继续已登记的 Q06a terms 第二度量，不扩大到 Dashboard、写入或未授权真实环境。
