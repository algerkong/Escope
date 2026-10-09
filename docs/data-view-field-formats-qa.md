# Q09 第二批：字段格式与执行副本

日期：2026-10-10。接手基线 `49e334a`，工作区干净，沿用 `main`。
状态：开发、临时 SQLite 与 JSDOM 组件自动化通过；真实 ES、原生交互与重启待验。
主代理独占，无 OMP、新依赖、schema 迁移、worktree、原型修改或额外持久服务。
首批视图库/绑定/选择与默认时间字段证据保留在 [Data Views QA](data-views-qa.md)。
同日后续第三批查询期字段已增量，见 [runtime fields QA](data-view-runtime-fields-qa.md)；
本文保留第二批的范围与当次证据，不将后续实现或真实/原生待验项算入本批通过结果。

## 交付范围

| 范围 | 本批实际实现 | 边界 |
| --- | --- | --- |
| 本地格式 | 原视图管理器内添加/编辑/移除；数字分组、百分比、IEC 字节、UTC 日期 | 每视图 32 项/16 KiB；不接受 JS、HTML、URL、任意模板或小数舍入选项 |
| 类型证据 | 复用显式字段发现，未验证/缺失/冲突/非数值/非日期/兼容分别显示 | 仅显示配置证据，不门控 DSL、不隐式请求字段，不以保存成功当真实字段可用 |
| 表格显示 | 现有字段列精确格式化、原始值 tooltip 与开关、有界标量数组 | 不展开嵌套列/对象，不自动转换字符串数字；无效、混合结构或超限时保留原值 |
| 执行副本 | 执行前深冻结 Data View 定义及每个格式对象；续页继续原副本 | 库/草稿变更、删除、语言/设置往返不更新旧结果或执行请求 |
| 历史与恢复 | 工作区、查询库及查询/续页历史保留定义副本；历史恢复为新草稿 | 恢复不执行、不读当前视图库、不重绑已删连接；不保存结果/PIT/页码/行选择 |
| 原始数据 | 本地排序按原值，格式化单元格复制原值，JSON/文档/CSV/JSONL 不变 | 搜索/PIT 请求和全量导出 DSL 不带格式；查询定义交换继续排除整个 Data View 配置 |

沿用原有紧凑工具界面、Lucide、双语、主题 token 和可见焦点；未新增管理首页、装饰页面或外部资源。
原值开关仅属于当前结果显示，新执行重新启用其冻结配置，不保存到工作区或作为查询选项。
原有列宽/顺序/显隐/已加载行排序和行选择规则不变。

## 数值与日期

- 数字格式按原始十进制 token 分解符号、数字和指数；整数分组使用 `Intl` 的 BigInt 输入，
  不将大整数或高精度小数转为浮点数。百分比只精确移动两位小数点。
- IEC 字节范围为 `B` 至 `EiB`，按绝对值选择单位。除以 `1024^n` 使用
  `5^(10n)` 与十进制指数的精确变换，不四舍五入；负值保留符号。
  例如 `1537` 显示为 `1.5009765625 KiB`，原值仍是 `1537`。
- 日期必须显式选择来源。ISO 只接受含 `Z` 或明确偏移的完整时间戳，
  验证真实日历、时分秒与偏移，保留 1-9 位小数；无时区、非法日期、闰秒、
  `-00:00` 未知偏移或更多小数位保留原值，不猜本地时区。
- Unix 毫秒只接受整数数值 token，先用 BigInt 校验 Date 范围，再安全转为毫秒。
  字符串数字、指数写法、非整数、超范围大数均回退，不截断纳秒或高精度小数。
- 数值输入最多 1,024 字符，展开的十进制部分最多 2,048 字符；
  超大正/负指数在分配展开字符串前拒绝，不用科学计数法浮点回退。
- 标量数组最多 32 项，JSON 输入最多 16,384 个 UTF-16 码元，显示输出最多 4,096 字符；
  使用已有严格 JSON 解析器与原文切片。格式化项用带引号的展示字符串维持元素边界，
  `null` 保留；混合不兼容类型、嵌套结构、输入/输出超限时整列值回退原样。
  不把格式化数组当作新的原始 JSON 数据。
- 字段按现有结果列的精确名称匹配；名称含点号不意味着自动展开 `_source` 对象。
  `fields` 的已有顶级标量数组可显示，`_source` 与 `fields` 的原优先级不变。

## 保存与边界

SQLite **schema v7 不变**，视图库/恢复/查询库文档仍为 v1。
定义增加可选字段，不进行全库修补或迁移：

```json
{
  "fieldFormats": {
    "version": 1,
    "entries": [
      { "field": "sequence", "format": { "kind": "number", "grouping": true } },
      { "field": "ratio", "format": { "kind": "percent", "grouping": false } },
      { "field": "size", "format": { "kind": "bytes", "grouping": true } },
      { "field": "@timestamp", "format": { "kind": "date", "input": "iso" } }
    ]
  }
}
```

数字类仅接受 `kind` 与布尔 `grouping`，日期仅接受 `kind` 与 `iso`/`epoch_millis` 输入枚举。
选项必填，不默认为可执行格式；字段名唯一、无控制字符/首尾空白、最多 1,024 UTF-8 字节。
格式集合总序列化上限 16 KiB，整个视图库仍受 100 项/256 KiB 限制。
旧无格式记录可读；`null`、未知版本、重复字段/JSON 键、额外选项和超限整体拒绝。
已有串行 CAS、未知完成和损坏存储不覆盖规则保留，桌面失败不降级内存。

`ExecutionSnapshot` 及持久历史可选包含 `dataView` v1 完整副本，校验连接 ID 与目标一致。
索引执行/索引标签不能携带该配置；历史只投影已允许字段，不携带传输/认证/正文。
查询/PIT IPC 仍显式投影原合同字段，不把展示配置发送给 ES。
本地查询定义交换仍排除视图 ID、连接绑定、默认时间字段和格式配置。

原生格式化文字选择没有可逆的“局部原值”映射，因此表格内单个范围触及格式化单元格时，
复制所选完整单元格的原值，多列/行使用制表符/换行连接；格式化数组复制原始数组文本。
未触及格式化单元格时保留已有原生文本复制。专用 JSON/文档复制始终返回原文，
CSV 公式防护、已加载导出不额外查询及独立 PIT 全量导出边界不变。

只测试临时数据库与 fixtures。早期不认识新增字段的程序应拒绝对应文档，
不通过手改版本或删字段来强制降级；需要旧版时使用已备份、与其兼容的数据。

## 自动化证据

Vitest 均使用 `--maxWorkers=2`，没有提高超时阈值。以下均为本批实际运行结果：

| 检查 | 结果 |
| --- | --- |
| 首轮领域 | 95 项中 94 通过；测试误认为所有单位的同一指数都超限，改为按变换后展开长度验证后通过 |
| 第一轮组件/执行 | 6 文件 **133 项通过**，含新旧格式、原值切换、DOM 剪贴板、历史/续页与无隐式执行 |
| 最终跨模块 Vitest | **21 文件 394 项通过**，覆盖格式、视图、执行、表格、原值/导出、恢复、查询库与交换 |
| Rust 首轮 | 45 项中 44 通过；新恢复 fixture 的 `orders` 副本与 `orders-*` 草稿不符被正确拒绝，修正 fixture |
| Rust 最终定向 | **76 项通过**：视图 15、恢复 20、查询库 10、查询 20、交换 11 |
| ESLint | 17 个变动 TS/TSX/测试文件通过 |
| TypeScript / 正式构建 | `npm run build` 通过；首轮仅测试辅助函数和 `getByRole` 选项的类型标注修正，未放松规则 |
| Rust 格式 / clippy | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过 |
| 文档与 diff | 8 份 Markdown、121 个本地链接、39 张表格通过解析检查；32 个变动文件 UTF-8/LF 与 `git diff --check` 通过 |

复审补强：数组末尾为 `null` 也逐项检查输出限额，防止前面的长数值已经接近上限时绕过检查。
新增用例已包含在最终 394 项中。构建 JS 单包约 **1,073.54 kB**，既有类 chunk 警告保留；
没有调整警告阈值或顺带拆包。不是全量回归/全目标 clippy，也未重新执行原型与历史旧基线。

前端定向文件位于 `tests/unit`：

```text
field-formats.test.ts              field-formats-grid.test.tsx
data-views.test.ts                 data-views-service.test.ts
data-views-hook.test.tsx            data-views-ui.test.tsx
app-data-views.test.tsx             query-executions.test.tsx
result-grid.test.ts                result-grid-ui.test.tsx
query-result.test.ts               query-library.test.ts
query-library-ui.test.tsx          query-exchange.test.ts
query-exchange-service.test.ts     workspace-recovery.test.ts
workspace-recovery-hook.test.tsx   app-workspace-recovery.test.tsx
query-live.test.tsx                domain.test.ts
workspace-tabs.test.ts
```

Rust 命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib -- data_views::tests workspace_recovery::tests saved_queries::tests query::tests query_exchange::tests --test-threads=2
```

共享 fixture 为 `tests/fixtures/data-view-field-formats-v1.json`。临时 DB、mock IPC、JSDOM 与
原生/真实服务证据分开；本批未访问真实 ES/模型、系统密钥库或用户数据库，未启动浏览器/WebView。

## 剩余与接续

- [集中人工清单](manual-acceptance.md) 的 Q09 项仍待验：原生 Ctrl/Cmd+C/系统剪贴板、
  32 行配置、长值/中英文/窄窗口/200%/大字号、下拉与焦点、重启/升级/退出期间保存。
- 真实 ES 多目标/别名/数据流、数字/日期返回、字段权限与类型变化需当次授权环境；
  DOM 剪贴板测试不代表原生剪贴板已验证，构建不代表安装或跨平台通过。
- 查询期 runtime fields、时间范围编译/冻结和视图定义独立交换仍未交付；
  不承诺任意数字模板、自动展开嵌套列、Kibana 对象兼容或 Mapping 写入。
- 下一可执行批次为 Q09 第三批有界查询期 runtime fields：先本地定义、类型/冲突边界、
  最终 DSL 预览与显式应用、执行副本，之后 Q02 时间。任何 Mapping 变更仍须 W01/W04。
  Q09/F07/Q01/Q05 与六方向父任务保持开放，不因人工项尚未完成阻塞独立本地开发。
- 本批交接后主代理本地提交、不推送；全部命令退出后创建恰好一个 local 后继，
  更新既有接续监控，创建后停止写仓库。不新增监控，不提前睡眠。
