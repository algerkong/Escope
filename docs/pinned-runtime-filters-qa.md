# Q02 第十批：固定平面查询期 runtime 定义

日期：2026-10-10。从干净 `b71bf6d` 接手，沿用 `main`。
状态：开发、JSDOM、临时 SQLite 和构建自动化通过；真实 ES、原生、性能与跨平台未验。
前置见 [固定 nested QA](pinned-nested-filters-qa.md) 和 [查询期字段 QA](data-view-runtime-fields-qa.md)。
本批不关闭完整 Q02/Q09/F07 或六方向父任务。

## 实际交付

| 范围 | 已实现 | 边界 |
| --- | --- | --- |
| 版本 | 固定库 v3，条件可选 `runtimeMapping`，兼容 v1 平面/v2 mapped nested 原样读取 | 读取/重开不写回；显式新增升级为 v3，删除保持原版本，已存版本不降级；未知/损坏/显式 null/未知键整库拒绝 |
| 声明 | 从已应用 source.dsl 提取该字段的受限声明，保留类型、精确脚本文字和可选语言 | 只接受七类型、同名 source 或有界内联 Painless；不从 Data View、旧库或未应用配置补齐，不保存整份 DSL |
| 字面量 | 精确 JSON token、布尔组与启停，平面 runtime 可与 mapped/nested 条件共存 | date/IP/geo_point runtime 仅存在性；无 geo 等值/空间查询，nested runtime 及深层路径仍拒绝 |
| 确认 | 完整定义与字面量确认；每个含脚本的字段显示完整源码，另行确认全部脚本（含禁用项） | 名称或捕获草稿变化使两项确认失效；失败不报成功；脚本作为本地文本保存，前端不求值 |
| 加载审核 | 同连接 ID + 完全相同目标形成已保存字面量副本，snapshot 为 null | 启用 runtime 项须与当前已应用 DSL 声明相同；不注入、运行或替换脚本，不冒充当前 fields 原值 |
| 隔离 | 库删除不改副本；已应用会话绑定深冻结声明，禁用/移空从原基线重建 | 手改/目标失配不能覆盖；原 query/评分/时间/参数/排序、真实后续观察与旧 PIT 保持，绑定不恢复 |

schema v8、恢复/查询文档 v1、DSL 快照合同 v4 和 `pinned_filters_load/save` 命令保持。
没有新依赖、网络接口、持久服务、原型变更或用户数据库操作。

## 声明与证据

- `runtimeMapping` 是与查询白名单相同的类型化对象，不是任意脚本配置；字段类型须与声明一致。
  同一字段所有条件须使用相同声明，不得混用 mapped/runtime 或不同脚本，禁用项也参与检查。
- 保存并比较解码后的精确 `script.source` 字符串和可选 `lang`；源码空白、换行与制表符不改写。
  对固定声明，缺省语言与显式 `painless` 保留各自形状，不相互替代。
  JSON 属性顺序、格式空白及等价字符串转义不改变声明；不改变一般 runtime 合并的旧等价规则。
- 原限额保持：100 组/256 KiB，每组 32 条/8 非空组、每值 4 KiB；字段 1,024 字节，
  脚本 4 KiB。每组去重后的 runtime 声明集合仍限 32 项/64 KiB，转义膨胀计入序列化大小。
  重复脚本在固定库中占用的实际字节也计入总限额，不截断或静默删除。
- 现场 runtime 值固定时须保留真实快照身份，并比较原执行与当前 DSL 声明；无快照不造观察。
  再次固定已保存字面量也须核对当前声明，包括禁用项，不按当前新脚本重解释旧字面量。
- 加载本身只复制定义；启用项在全文 DSL 预览时核对当前声明，不依赖旧执行的 runtime。
  禁用项仍校验结构/声明/值/成员/限额，只跳过当前字段证据，重新启用须重审。
  声明缺失或不同可保留待审定义，但不能应用；失配后可明确丢弃，不能自动补脚本。
- mixed mapped nested 的本次显式 Mapping/field caps 读取保护保持，较早在途完成不替代检查；
  本批没有降低其实际索引集合、直接路径、类型、searchable 或 runtime 遮蔽检查。
- 固定值标为“已保存字面量/已保存 runtime”，声明可展开查看；不称为“已执行 runtime”。
  旧库和重启不恢复可信会话绑定，后续实际执行的快照仍是真实请求身份。
- 索引标签的锁定 DSL 不含这些查询期声明时，加载后预览拒绝，不注入脚本或生成新查询。
  原有“审核后显式生成同目标新查询”入口保持，不能通过固定库修改原索引标签。
- SQLite 保存的脚本文字和字面量可能包含业务含义，须全文核对；不附带端点、认证对象、
  凭据引用、结果正文、PIT、执行证据或基线。Rust Debug 对脚本文字保留脱敏。
  PIT 不保证脚本输出稳定；全量导出仍拒绝 runtime mappings，已加载导出规则不变。

## 本次验证

前端有效覆盖 **20 文件 450 项**，不是一次全仓命令：
领域首轮 **7 文件 244 项**；UI/适配/控制器 **5 文件 32 项**；
新工作台与补强适配/控制器 **3 文件 22 项**；旧固定/布尔/nested/工作台回归 **8 文件 168 项**。
最后补强混合 nested 与 v2 删除后 **2 文件 41 项**通过，替换领域原 29 项为 30 项、
控制器原 8/10 项为 11 项；服务最终 7 项。重复文件只取最终有效结果，不累加。
Rust **150 项**：固定库 24、runtime 6、storage 47、恢复 22、查询主模块 25、导出主模块 26。

| 检查 | 本次结果 |
| --- | --- |
| TS 合同 | v1/v2/v3、全部七类型、精确值/源码/语言、深拷贝、未知/null/版本、配额/同字段冲突、无观察/不注入、混合 nested 证据、时间/参数/绑定通过 |
| JSDOM | 全文源码与双重确认、禁用脚本、声明来源文案、失配/刷新/启停/双语/焦点、失败存储、索引拒绝注入、旧 PIT/真实观察、删除与重挂载通过 |
| 存储/IPC | 原命令与有界 v3、v1/v2 原文读取不写/新增升级/删除不升级、脚本深捕获、未知完成/串行 CAS/连接删除/既有 ID 不可变、损坏不覆盖通过 |
| Rust | 共享 v3 fixture、嵌套重复/转义重复键、禁用与 UTF-8/序列化限额、临时 SQLite 重开/升级/冲突及查询/恢复/导出跨模块通过 |
| 静态/构建 | 15 文件 lint、最终 build 中 typecheck、正式构建和 Rust fmt 通过；JS 1,371.95 kB、CSS 111.75 kB，原 500 kB 警告保留 |
| 文档/diff | 30 文件 UTF-8/LF、8 文档/227 本地链接/57 张 GFM 表格及 diff 空白检查通过；没有原生截图通过声明 |

主要命令：

```sh
npm test -- --maxWorkers=2 tests/unit/pinned-runtime-filters.test.ts tests/unit/pinned-filters.test.ts tests/unit/pinned-nested-filters.test.ts tests/unit/query-filters.test.ts tests/unit/query-filter-enablement.test.ts tests/unit/query-filter-session.test.ts tests/unit/runtime-fields.test.ts
npm test -- --maxWorkers=2 tests/unit/pinned-runtime-filters-ui.test.tsx tests/unit/pinned-filters-ui.test.tsx tests/unit/pinned-nested-filters-ui.test.tsx tests/unit/pinned-filters-service.test.ts tests/unit/pinned-filters-hook.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-pinned-runtime-filters.test.tsx tests/unit/pinned-filters-service.test.ts tests/unit/pinned-filters-hook.test.tsx
npm test -- --maxWorkers=2 tests/unit/app-pinned-runtime-filters.test.tsx tests/unit/app-pinned-nested-filters.test.tsx tests/unit/app-pinned-filters.test.tsx tests/unit/app-pinned-filter-lifecycle.test.tsx tests/unit/query-nested-filters.test.ts tests/unit/query-filter-groups.test.ts tests/unit/query-filters-ui.test.tsx tests/unit/query-nested-filters-ui.test.tsx
npm test -- --maxWorkers=2 tests/unit/pinned-runtime-filters.test.ts tests/unit/pinned-filters-hook.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib -- pinned_filters:: runtime_fields::tests --test-threads=2
cargo test --manifest-path src-tauri/Cargo.toml --lib -- storage::tests:: workspace_recovery::tests query::tests query_export::tests --test-threads=2
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run build
```

开发先以 v3 共享 fixture 的单个读取用例跑红，随后 29 项通过。
早期 typecheck 发现新测试误用 DataViewSelection 形状、readonly 标签赋值和不存在的 integer
参数类型；改用既有 selectDataView、不可变更新及 number 合同。另修正新测试把 fieldCaps
资源写成 fields 的笔误，并复验工作台；lint 的未使用解构变量也已修正。
没有提高超时、放松类型或删除安全断言，没有重跑未受影响全量/原型/clippy/安装包。

主代理独占实现、diff 复查与独立验证。只读 OMP 复核在 8 分钟后超时，
报告只有空白；relay watchdog 已终止进程并以 exit 1 退出，不算独立审查通过。
状态记录为系统临时目录 `delegate-relay/EScope-2026-10-10T05-46-34-119Z/result.json`，
session `01a12459-5997-7000-b553-fff35aab7676`，stderr 为空；不重试或用超时补长测试阈值。
没有真实 ES/模型、系统密钥库、浏览器/WebView、原生截图或用户数据库检查。

## 待验与接续

真实 ES 的 runtime 编译、昂贵查询设置、权限/FLS、缺失/多值/日期/IP/地理存在性、
脚本非确定性/成本、部分失败/取消及 PIT 仍需当次授权环境。
原生长脚本滚动、双语/字体/窄窗口/200%/高对比、Tab/Esc/屏幕阅读器、保存失败/重启/
v1/v2→v3 升级与旧版拒绝新库列入 [集中人工清单](manual-acceptance.md)，没有人工通过声明。

下一有界批次按第 10.2 节转到 **Q03 Monaco DSL 编辑器首批**：
先接正式查询 DSL 编辑器与现有无损文本、格式/诊断、撤销、标签独立和只读状态；
使用本地 worker/资源，不开放任意 REST，不因编辑/补全/恢复触发执行。
字段/参数补全依当前证据增量，真实 IME/焦点/缩放/原生 worker 验收单列。
nested runtime、深层条件、完整 Q02/Q03/F07 和 W01/W04 保持开放，不把有界自动化当父任务完成。
本批本地提交后创建一个 local 后继并更新既有监控，不推送、不提前睡眠。
