# 融合标题栏与查询编辑辅助验收

日期：2026-09-30。范围：F02.2、Q01.2。实现与自动化通过；原生平台/布局待用户集中手测。

## F02.2

- `App.tsx` 的既有 header 改由 `WindowTitleBar` 封装；品牌、工作区、连接选择与三个操作入口保留，
  不增加第二条标题栏。浏览器模式没有假窗口按钮、不调用桌面窗口 API。
- Windows/Linux 主配置 `decorations:false`；窗口按钮调用真实 minimize/toggleMaximize/close，
  不用 destroy 跳过 close 事件。Windows 热区宽 46px、移除头部上下外垫以触及窗口右上边缘；
  Linux/未知平台是紧凑右侧 CSD 控件，不承诺匹配所有发行版的按钮位置。
- macOS 平台覆盖文件 `tauri.macos.conf.json` 使用 `decorations:true`、
  `titleBarStyle:Overlay`、`hiddenTitle:true`；保留真正交通灯，左侧预留安全区，不绘制模拟按钮。
  平台配置替换 windows 数组，故明确重复全部窗口尺寸/label/minima。
- 使用锁定 Tauri 2.12 的 `data-tauri-drag-region="deep"` 注入行为；按钮/下拉等交互元素阻断拖拽，
  空白双击走系统窗口 API，不叠加第二套 JS 双击处理。测试不冒充实际系统拖拽。
- 初始状态与 resize/focus/blur 共用订阅通道；generation 拒绝旧的最大化/全屏状态，
  卸载清理注册与在途读取。同步句柄错误被包装为 Promise 拒绝，窗口操作失败显示本地化提示。
- 最小授权仅 main 本地窗口：minimize、toggle-maximize、close、is-maximized、is-fullscreen、
  start-dragging、internal-toggle-maximize、event listen/unlisten；没有全量 default/通配权限。
- 去除新单测对未跟踪 `src-tauri/gen/schemas/acl-manifests.json` 的依赖，
  权限名称合法性由 Tauri 编译验证；单测校验精确授权集合和没有远程来源授权。

## Q01.2

- `query-dsl.ts` 使用精确固定的 `jsonc-parser 3.3.1` 做严格 JSON 结构校验。
  相同值、不同值、嵌套和 Unicode 转义等价的重复键均拒绝；数组中不同对象同名属性允许。
- 格式化仅应用源码空白 edits，不重序列化数字或字段；长整数、小数、指数、转义、键序、
  `__proto__` 字段均保留。首版 lossless-json 的同值重复合并/字段丢失不被接受，最终依赖已移除。
  解析器临时数值节点不用于执行、复制或输出；原始 DSL 文本始终是数据来源。
- `createValidatedSnapshot` 返回冻结执行快照，保留逐字 rawDsl，带 JSON 合同版本 2；
  非法日期等返回稳定错误码。旧 createSnapshot 合同不变，不表示查询网络或 AST 编辑已实现。
- 主代理把能力接入 `QueryWorkspace`：校验、格式化、撤销格式化的图标按钮，
  中英文错误及行列、aria-invalid/诊断关联。编辑后旧诊断隐藏，撤销不能作用到另一个标签；
  设置往返保留既有查询状态。格式化不执行网络请求，查询执行按钮仍明确禁用。
- 状态栏可换行，避免新增校验状态挤压窄窗口；实际布局/缩放仍待用户验收。

## 本轮独立检查

| 检查 | 实际结果 |
| --- | --- |
| 新窗口、DSL 与编辑器定向测试 | 5 文件 67 项通过（补最后窗口句柄用例之前） |
| `npm run check` | lint/typecheck/正式与原型构建通过，正式 141 项、原型 16 项通过 |
| 句柄同步异常防护后 `npm test` / `npm run lint` | 最终正式 142 项通过；lint 通过 |
| 去除生成文件依赖后 `npm test -- tests/unit/window-config.test.ts` | 6 项通过；未再改运行时代码 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 含本批凭证编排：56 通过、2 忽略 |
| Rust fmt / `clippy --all-targets --locked -- -D warnings` | 通过 |
| `npm run build:desktop` | typecheck、前端和 Windows release 构建通过；未启动 exe |
| `git diff --check` | 通过 |

产物 `src-tauri/target/release/escope.exe`，未签名内部构建，不是安装包。
既有 `127.0.0.1:1420` Vite 已监听，未重复启动、未打开浏览器/桌面/ES。
旧截图不作为本轮证据。未运行 macOS/Linux 编译/原生窗口、Windows Snap/边缘缩放、
macOS 交通灯垂直对齐/全屏菜单、Linux Wayland/X11、200% 缩放和键盘人工验收。
待验流程见 [人工清单](manual-acceptance.md)。

## OMP 追溯

本机归档根为 `C:/Users/Administrator/AppData/Local/Temp/delegate-relay/`。
窗口会话 `01a0f153-79b7-7000-bf35-46cc98f75ff8`：
`EScope-2026-09-30T07-59-32-602Z`、`EScope-2026-09-30T08-12-47-837Z`。
查询会话 `01a0f153-7b0f-7000-8da2-1c1c86228a66`：
`EScope-2026-09-30T07-59-32-963Z`、`EScope-2026-09-30T08-07-50-834Z`。
均已正常退出，最后 result 为 completed/exit 0；主代理另做编辑器接线、句柄错误和干净检出测试修正。
未提交、推送或部署。
