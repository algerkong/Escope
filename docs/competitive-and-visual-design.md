# EScope 竞品与视觉系统

日期：2026-09-30。状态：设计规范与样式原型，不代表已实现的桌面产品。

## 1. 竞品判断

市场并非没有 ES 查询工具。需要验证的是：面向我们的目标用户，现有工具有哪些高频摩擦。
本次读取以下官方站点与项目 README，未安装实测，也未核对所有版本、套餐和授权条件。

| 产品 | 已核实的公开能力 | 对 EScope 的启示 |
| --- | --- | --- |
| Elasticvue | Windows、macOS、Linux 桌面分发，浏览器扩展、Web、自托管，索引管理与文档检查 | 三平台桌面不是独有优势，必须实际对比数据浏览与日常流程 |
| Kibana | Discover、过滤、图表、Dev Tools、ES\|QL，官网列出自然语言生成和解释查询以及 AI 辅助分析 | 不能声称 AI 查询是空白市场；聚焦轻量本地工作台，而非复制整套分析平台 |
| Dejavu | Elasticsearch/OpenSearch Web UI，类型感知可视化过滤、多索引、文档浏览编辑、JSON/CSV 导入导出 | 无代码筛选已存在；复杂结构呈现与模式切换体验才值得进一步比较 |

来源：

- [Elasticvue 官方网站](https://elasticvue.com/)
- [Kibana 官方网站](https://www.elastic.co/kibana)
- [Dejavu 官方仓库](https://github.com/appbaseio/dejavu)

不沿用 Dejavu README 中关于其他产品的历史对比表来描述当前市场。
未从介绍页看到某项能力，不能据此判断产品完全不支持它。
“EScope 更好用”目前是待验证假设，不是调研结论。

### 建议定位

本地优先的 ES 查询客户端：默认无代码，必要时进入 DSL，AI 候选可审核，结构化结果清楚可读。

以相同任务实测三个竞品：连接生产只读账号、筛选订单、展开 nested 数据、修改 DSL、解释聚合、保存查询。
记录完成时间、语义误解、重复操作、权限要求和结果丢失；不只按功能数量评分。
优先访谈 5–8 位开发、测试和技术支持用户，验证后再决定商业化和功能优先级。

## 2. 视觉方向

以用户指定的 Codex、ChatGPT 客户端作为气质参考，而不是像素复制或品牌复刻。
本方案没有从这两个应用提取精确字体、色值或尺寸；以下参数均为 EScope 的原创建议。

关键词：中性、平静、清晰、紧凑、有呼吸感。

借鉴：

- 低对比资源侧栏、清晰主内容区、少量分割线。
- 单一主操作，次要命令图标化，工具栏保持安静。
- 聊天内容以排版组织，不把每段输出包在气泡或卡片里。
- 将复杂能力放入渐进展开的面板，而不是首次打开全部铺满。

不照搬：

- 不把主结果区改成居中的窄聊天流。
- 不做巨大欢迎语或空旷首页。
- 不让 AI 面板成为强制入口；默认可关闭。
- 不使用大面积彩色背景、渐变、玻璃质感或无意义装饰。

主布局依然是资源导航、查询、结果；主题与语言设置集中在“外观与语言”，而非占据业务工具栏。
样式预览也将这些设置移入独立设置视图，主界面只保留快捷入口。
设置分组与快捷操作的后续规范见 [设置与快捷操作](settings-and-shortcuts.md)。

## 3. 主题模型

三个独立维度：

| 维度 | 值 | 存储 |
| --- | --- | --- |
| 外观 | system / light / dark | 持久保存用户选择，不仅保存解析后的值 |
| 强调色 | graphite / jade / blue / violet | 稳定 ID，与显示语言无关 |
| 语言 | system / zh-CN / en-US | 产品使用独立语言状态，预览只提供中英显式切换 |

默认跟随系统外观，石墨强调色。用户可切换玉绿、清蓝、柔紫。
强调色只影响主要命令、焦点、选择标记和少量图表强调，不把整套灰阶染色。
状态色单独定义：成功、警告、错误不跟随主题色，且始终搭配文字或图标。
图表多系列使用稳定的分类调色板，不全部使用强调色深浅变体。

跟随系统时监听系统变化；选择固定日间或夜间后不再响应系统色彩切换。
启动时在界面绘制前恢复偏好，避免浅色闪屏；配置损坏或系统信息不可用时有明确默认值。
表格、弹窗、tooltip、Monaco、ECharts、滚动条和原生控件必须同步主题，不能只切换页面背景。

## 4. 基础 Token

| 角色 | 日间 | 夜间 |
| --- | --- | --- |
| app | #FFFFFF | #191A1C |
| sidebar | #F6F6F7 | #151618 |
| subtle | #F4F5F6 | #222427 |
| elevated | #FFFFFF | #282A2E |
| text | #24262A | #ECEDEF |
| muted | #646870 | #ADB1BA |
| border | #E5E6E9 | #34373D |

界面字体建议 IBM Plex Sans 配合系统中文字体，离线发布内置许可允许的字体资源；
样式预览只使用系统字体，避免远程字体影响加载。
代码使用 JetBrains Mono 或系统等宽字体；数字采用等宽数字，不给整张表套等宽字体。

字体：正文 14px、工具条与元信息 12–13px、页面局部标题 16–20px。字距为 0。
间距使用 4、8、12、16、24、32px；控件圆角 6px，弹窗 8px，避免过多胶囊按钮。
边框比阴影优先；阴影仅用于浮层，不让页面分区“浮起来”。
图标 16px，点击目标至少 32px；键盘焦点清晰可见。

## 5. Tailwind 方案

应用推荐 React + TypeScript + Tailwind CSS 4 + Radix primitives + Lucide。
基础组件可借用 shadcn/ui 的组合方式，但统一改为本项目 token 和交互规范，不直接拼默认模板。
高密度数据表使用 TanStack Table/Virtual，DSL 使用 Monaco，图表使用 ECharts。

采用 CSS-first 的语义 token：

```css
@import "tailwindcss";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme inline {
  --color-app: var(--app);
  --color-sidebar: var(--sidebar);
  --color-ink: var(--text);
  --color-muted: var(--muted);
  --color-line: var(--border);
  --color-accent: var(--accent);
  --color-on-accent: var(--on-accent);
}
```

组件使用 `bg-app text-ink border-line`、`bg-accent text-on-accent` 等语义类。
不在每个组件中硬编码 `bg-white dark:bg-zinc-900`，也不散落各自的强调色。
主题以根节点 `data-theme` 与 `data-accent` 切换，CSS 负责实际值。
提供方、连接环境与查询状态不得借用主题色字段存储，避免业务语义随外观改变。

正式应用通过本地构建生成 CSS，不使用 Tailwind 浏览器 CDN。
附带的独立 HTML 使用本地构建的 Tailwind CSS 与 Lucide，不再依赖运行时 CDN。
首次准备运行 `npm install` 和 `npm run build`，之后直接打开 HTML。
锁定桌面支持的 WebView 基线并验证 Tailwind 4 的 CSS 能力，尤其是 Linux WebKitGTK；
不因为 Chrome 预览通过，就假设所有系统 WebView 一致。

## 6. 中英文国际化

正式应用使用 i18next + react-i18next，按 common、connections、query、results、ai、settings 分命名空间。
UI 文案、空状态、错误提示、导出弹窗、tooltip、快捷键说明、ARIA 标签都进入词条。

| 中文 | English |
| --- | --- |
| 连接 | Connections |
| 索引 | Indices |
| 可视化 | Visual |
| 执行查询 | Run query |
| 文档 | Documents |
| 查询已修改 | Query modified |
| 结果来自上次执行 | Results from the previous run |
| 跟随系统 | System |

规则：

- 不拼接翻译片段，用带参数的完整句子；英文数量使用复数规则。
- 错误由稳定代码映射成本地化说明，原始 ES 错误单独保留，不丢诊断信息。
- 字段名、索引名、DSL 关键字与原始文档不翻译，不随界面语言变化。
- 日期、数字使用 Intl；显示语言与查询时区分离，切换语言不能改变时间过滤。
- 机器输入与 DSL 中的数值仍使用规定格式，不把显示中的千分位或小数逗号写回请求。
- 用户语言、AI 回答语言可以单独配置；英文界面仍可使用中文提问。
- 根节点同步 lang；英文和中文各自调整合理换行，日志、ID、URL 可横向滚动或按需展开。
- 为英文留扩展空间，按钮用最小宽度和 padding，不按中文字符数固定宽度。
- 切换语言无需重启，也不重建查询标签、不丢编辑内容、不重新执行请求。

## 7. 样式原型范围

`theme-preview.html` 展示工作台、文档表格、JSON、只读 DSL 和 AI 示例；
新增集群概览、节点、分片、索引、本地模型目录与连接草稿，实际能力见项目 README。
可操作外观、四种强调色、中文/英文、表格/JSON、可视化/DSL 和 AI 面板显隐。
所有订单均为内置演示数据，AI 内容为静态示例，不连接 ES、不调用模型。
它验证布局与外观，不替代完整查询功能原型。

## 8. 验收

覆盖两种解析后外观 × 四种强调色 × 两种语言，共 16 个基础组合，另外验证跟随系统事件。
每个组合检查正文与控件对比度、hover、focus、disabled、选中和危险状态。
正文目标对比度至少 4.5:1；交互图形与焦点等按对应 WCAG 条款验证，不能只肉眼判断。
执行英文扩展和伪本地化测试，验证最小窗口、125%–200% 缩放、长字段、IME 和键盘导航。
预览验收与实际三平台发布验收分开记录。
