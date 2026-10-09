# F01/R03 开发依赖安全修复

日期：2026-10-10。从干净 `d2436f6` 接手，沿用 `main`。
环境：Windows x64、Node 24.9.0、npm 11.6.0。
状态：有界依赖修复、安装、自动化与两类构建通过；不代表 R03 发布安全或跨平台验收完成。
前批发现见 [时间范围 QA](query-time-range-qa.md)，执行进度见
[计划](development-plan.md) 第 10.16 节。

## 范围与依据

修复前重新执行 `npm audit --json`：5 项 high；`npm audit --omit=dev --json`：0。
其中三个 high 是同一条传递依赖链的影响，不是五个独立漏洞。

| 漏洞 | 本次注册表审计证据 | 处理 |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | braces <=3.0.3 深层模式栈耗尽；最新 braces 仍为 3.0.3，micromatch 4.0.8 仍依赖它 | watcher 2.5.6 已改用 picomatch，移除 micromatch/braces 链 |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | source-map-js >=1.0.0 <1.2.2 的 indexed section offset 放大 | 在原有依赖范围内锁定 1.2.2 |

依据来自本次 npm 审计、`npm view` 版本/依赖和实际包间 `npm diff`，不是仅凭
`fixAvailable` 推定可用。GitHub advisory API 的两次读取因 TLS 握手/主机名校验失败，
未取得页面正文；没有关闭证书验证、修改网络配置或使用该失败请求作为验证证据。

当前 `@tailwindcss/cli` 最新仍为 4.3.3，精确依赖 watcher 2.5.1。
`package.json` 仅增加 `@tailwindcss/cli > @parcel/watcher@2.5.1` 到 **2.5.6** 的限定 override；
不覆盖其他调用方或其他 watcher 版本。选用同一 2.5 分支，未升级到 2.6.0。
上游 CLI 不再依赖 2.5.1 后，本覆盖不再匹配；后续升级时复核并移除无效覆盖，
重新审计及验证构建，不长期保留一个未经复核的全局覆盖。

锁文件的实际变化：

- watcher 和其 13 个可选原生包同步至 2.5.6，原有平台条目保留。
- `source-map-js` 1.2.1 → 1.2.2，仍为开发依赖，供 PostCSS 与 Tailwind Node 使用。
- watcher 改用已经被 Vite/Vitest 使用的 picomatch 4.0.7，并复用已有 detect-libc 2.1.2；
  移除旧根版本及重复嵌套项。Linux libc 探测随上游改为 `familySync()`，未在 Linux 实测。
- 删除 micromatch、braces、fill-range、to-regex-range、is-number 的不再需要条目。
- 所有生产依赖、React/Vite/Tailwind/Vitest/TypeScript、Temporal/JSBI 版本不变。
  安装树从 549 项降至 540 项；生产依赖计数仍为 155。
- npm 自动补写的六个无关 WASM bundled 元数据条目已排除，原包版本/完整性未修改；
  精简后的锁文件通过 `npm ci`，未再次产生锁文件改动。

没有修改正式业务代码、原型 HTML/CSS/JS、构建脚本、Rust、IPC、SQLite schema 或文档格式。
原型与正式入口仍独立，生成的 `docs/assets` 和 `dist` 继续被忽略，不纳入提交。

## 自动化

新增 `tests/unit/build-dependencies.test.ts`，共 27 项：

- 锁文件不含 micromatch/braces，watcher 配套原生包版本一致，两个依赖仍只属于开发链。
- 使用本机原生 watcher 的 snapshot API 验证普通文件、子目录、隐藏文件、
  `**/*.{tmp,log}` 和目录忽略规则；仅临时文件，清理前校验绝对路径，无常驻监听。
- 从 PostCSS 和 Tailwind Node 各自解析实际使用的 source-map-js，
  检查普通映射/跨行序列化、indexed 偏移读取和源码正文保留。
- 拒绝超大/非法/非整数/字符串偏移及嵌套累计越界。测试在构造阶段断言拒绝，
  不实际生成超大映射或进行耗尽攻击。

| 检查 | 本批实际结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 成功，安装 540 项；未使用忽略脚本选项，Windows 预编译原生依赖可加载 |
| `npm audit --json` | 0 漏洞，含开发依赖；不等于发现所有供应链风险 |
| `npm audit --omit=dev --json` | 0 漏洞 |
| `npm ls ... --all` | watcher 2.5.6 overridden、source-map-js 1.2.2，picomatch/detect-libc 去重正常，无 invalid |
| 正式定向测试 | **4 文件 59 项通过**：build-dependencies、packaging-config、controls-polish、app；两个 worker |
| ESLint | 新增测试文件通过 |
| `npm run build` | typecheck 与正式 Vite 构建通过；JS **1,272.16 kB**，既有 500 kB 警告未提高阈值 |
| `npm run build:prototype` | Tailwind 4.3.3 与本地图标构建通过 |
| `npm run test:prototype` | **16 项通过**，JSDOM/状态检查，不是浏览器像素验收 |
| 文档与 diff | 9 份 Markdown、146 个本地链接、44 张表格、12 文件 UTF-8/LF 和 `git diff --check` 通过；26 条锁文件变化均在预定开发依赖范围 |

实际定向命令：

```sh
npm test -- --maxWorkers=2 tests/unit/build-dependencies.test.ts tests/unit/packaging-config.test.ts tests/unit/controls-polish.test.tsx tests/unit/app.test.tsx
npx --no-install eslint tests/unit/build-dependencies.test.ts
```

过程记录：

- 首次按直接 CLI 的具体版本限定 override，npm 报 `EOVERRIDE`，未更新锁文件。
  改为在 CLI 下限定 watcher 2.5.1 后安装通过；原有直接依赖范围不变。
- 首轮定向 4 文件 57 项中 55 通过、2 失败。新增正常映射测试将 indexed consumer 直接传入
  `SourceMapGenerator.fromSourceMap`，触发其既有 `sourceRoot` 为 undefined 的错误。
  新旧包 diff 确认相关读取逻辑未变；本批不修补第三方库或宣称支持任意 indexed 转换。
  改为分别验证 flat map 序列化与 indexed map 读取，新增两例后最终 59 项通过。
- `npm ci` 仍报告已有 eslint 9.39.5、whatwg-encoding 3.1.1 弃用提示；
  它们不是本次审计的两个漏洞，不在此批无差别升级。

## 边界与下一步

未运行 Rust/全量前端/严格 clippy/安装包，因无相应代码变化；未运行浏览器、WebView、
真实 ES/模型或用户数据库操作。没有 OMP、worktree、额外服务或配置变更。
本机 snapshot 自动化不代表跨平台 native watcher、持续 watch/热更新、原生 UI、
真实服务、安装签名、性能与可访问性已验收，见 [集中人工清单](manual-acceptance.md)。
任意 indexed map 的 generator 转换仍有上述上游限制，不将审计 0 写为完整安全证明。

F01/R03 的本开发依赖子项自动化通过，父任务和六方向范围保持开放。
下一功能批为 Q02 类型感知单元格包含/排除与筛选草稿；先核对字段证据与实际执行快照，
显式预览/应用、不自动执行、不覆盖手写条件，复杂布尔/nested/启停/固定/服务器排序随后增量。
本批交接后仅本地提交、不推送；命令退出后创建一个 local 后继并更新已有接续监控。
