# Console / Workbench M0–M1 核查与验证

日期：2026-09-28。依据《Numen 控制台与编辑器开发计划》r2。
当前工作从 `98e5b70a2a1f3b55b98c68d608f1868a4801eb06` 开始，与计划基线一致；开始时工作区干净。
本轮不提交、不发布、不操作用户 `.numen` 数据。运行验收使用系统临时目录和测试数据。

## 本轮边界

M0 基线核查与 M1 两个产品入口、v2 配置树及显式迁移。v2 最多 16 层分组、
1000 个用户配置节点；普通插件自身的 `plugins` 字段不解释为分组。Console 和 Workbench 保持两个
独立包与用户配置入口。M2 嵌套编辑、M3 试运行/文档保护、M4 管理 UI/Entry 在线通知、
M5 综合产品验收仍未开始，不以基础测试通过替代产品验收。

## 已核对的安装环境

- Node.js `v22.14.0`，pnpm `10.6.3`。
- Cordis `4.0.0-rc.8`，`@cordisjs/plugin-loader` `1.0.0-rc.5`。
- Vitest `4.1.10`；其余安装版本以本仓库 `pnpm-lock.yaml` 为准。
- 未升级 Cordis；直接核查安装版 `Group`、`EntryGroup`、`EntryTree.update` 和 Fiber 类型/实现。

原生 Group 使用 `group: true` 与递归 `EntryOptions[]`；这样禁用时仍保留配置层，
由祖先状态约束成员，无需改写成员禁用标志。组不引入服务隔离。原生移动 API 保留
Entry ID，允许 Context 重建。Loader 的配置 ID 不能使用会与 `Object.prototype`
冲突的名字：实测这类名字会破坏上游 Group 的删除判断，配置层主动拒绝。

## 入口与字段迁移表

| v1 配置项 | v2 归属 | 字段处理 |
| --- | --- | --- |
| `console` | Console 内部 RPC 服务 | 旧配置必须为空 |
| `consoleEntries` | Console 内部 Entry registry | 旧配置必须为空 |
| `consoleAuth` | `console.auth` | `token`、`ownerId` 原值保留 |
| `consoleSession` | `console.session` | `path`、`secureCookie` 原值保留 |
| `consoleAssets` | `console.assets` | `mode`、`manifestPath`、`assetPath` 原值保留 |
| `consoleHttp` | `console.http` | `path` 原值保留 |
| `consoleWs` | `console.websocket` | `path`、`maxMessageBytes`、`maxBufferedBytes` 原值保留 |
| `workbench` | Workbench 内部 Runtime | `root`、`assetPath`、`entrySource` 保持在父入口 |
| `workbenchAutomationAuthoring`、`workbenchAutomationActivation`、`workbenchAutomationCatalog`、`workbenchAutomations` | Workbench 对应业务子插件 | 旧配置必须为空 |
| `workbenchConnections`、`workbenchCredentials`、`workbenchHome`、`workbenchLogs`、`workbenchInvalidation`、`workbenchRuns` | Workbench 对应业务子插件 | 旧配置必须为空 |

`provideManualRuns` 仍由现有 Runs Provider 装配，不新增重复子插件。Server、数据库、
Logging、Scheduler、Triggers、Connection/Credential/Resource Store 保持宿主独立分支。

迁移要求同一产品旧模块完整、启用意图一致且字段可无损映射。仅 Console、Workbench
整体禁用、两套整体禁用分别保留。部分装配、混合启停、自定义认证替代、未知字段或
有歧义的来源报告具体冲突；不自动增启产品或吞并第三方配置。v1 普通启动保留旧语义，
v2 禁止旧叶子装配与同类产品多实例。`console` 和 `workbench` 同时存在合法。

迁移命令默认输出脱敏 dry-run。应用需要 `--apply --fingerprint <审阅时的指纹>`；
写前再次核对，保留 YAML 注释和其他插件、创建受保护备份，再原子替换。
配置包写入和迁移共享协作锁；外部编辑器不参与锁协议，写前指纹核验不宣称能够提供
跨任意外部进程的原子 CAS。进程异常遗留锁时应先确认无活动写入再人工处理。
完整的运行时应用对账与通用管理 CAS 属于 M4，不在这里声称完成。

## 导出与分发边界

| 包/路径 | 兼容策略 |
| --- | --- |
| `@numenjs/console` | 新增 default `consolePlugin`；所有旧命名类型/服务/实现导出保留；增加 `legacyConsoleBuiltins` 供 v1 Host 使用 |
| `@numenjs/workbench/plugin` | 新增服务端 default `workbenchPlugin` 与 `legacyWorkbenchBuiltins` |
| Workbench 根路径、`/runtime`、`/server`、`/contracts`、`/i18n` | 保留现有导出与默认行为；浏览器根路径不引入服务端组合模块 |
| Browser WebUI/组件 facade | 继续共享 Vue、Cordis、组件运行时；不移动到 Console |

普通 import 不注册服务。Host 只选择版本对应的产品/兼容映射，不逐项枚举两包内部模块。
保持 `Workbench → Console` 与 `Workbench → WebUI → Console`，未引入 Console 反向依赖。
Workbench 的生产 HTML、CSS、JS、哈希 chunk 和 facade 仍归自身 `dist/app`。

Workbench 保持 private，运行时继续依赖 `@numenjs/automation`、`@numenjs/connections`、
`@numenjs/credentials`、`@numenjs/scheduler` 等 private 领域包。领域错误类与 `instanceof`
语义没有复制/替换。本地 workspace 构建和 tarball 内容检查不代表从 registry 独立安装成功。

本地 Workbench tarball 检查：12 个应用资产、31 条资源引用、12 个导出文件齐全，解包后
使用本地 workspace 依赖闭包导入 `/plugin` 和 `/runtime` 不创建 Server。归档仍含源码和
JSX，保持 private。本轮还定位到既有独立消费限制：干净 `tsc` 以 `jsx:preserve` 输出
`pages.jsx` / `WorkbenchShell.jsx`，而浏览器根 `index.js` 引用对应 `.js`；旧 dist 文件会
掩盖问题。生产 Vite 应用和新增服务端 `/plugin` 构建正常。未借组合化扩大发布重构。
证据：[归档检查](../../artifacts/verification/workbench-pack-audit.json)、
[干净输出检查](../../artifacts/verification/workbench-clean-output-audit.json)。

## 实际验证

| 检查 | 本轮结果 |
| --- | --- |
| 修改前 `pnpm typecheck` | 通过 |
| 修改前 `pnpm test` | 74 文件 / 366 测试通过 |
| 原生 Cordis Group 隔离测试 | 4 测试通过：两层分组意图、组/成员移动、服务共享、依赖恢复及释放基线 |
| 产品包测试 | 39 文件 / 136 测试通过；含新入口 3 项配置/生命周期测试 |
| Runtime v1/v2 双路径 | 两种配置均通过原有真实 HTTP 业务流程验收 |
| Runtime 独立启停与真实分组 | 5 测试通过；Workbench 10 次、Console 10 次，路由/Provider/Entry/Fiber/Effect 对比基线；后台 Run 完成且 Cron 订阅保留；嵌套 fixture 经 Host 验证安全模式与跨组移动 |
| `pnpm install --frozen-lockfile` | 通过，未升级依赖 |
| `pnpm build` | 通过，Workbench 生产资源仍归自身包 |
| `pnpm test:e2e` | 7 测试通过（含构建、示例构建）；发布焦点输入、语言切换、断线日志恢复、区域拖动与恢复、独立 UI 插件共享运行时 |
| 最终 `pnpm typecheck` / `pnpm test` | 通过；80 文件 / 395 测试 |
| `pnpm numen config validate` / `pnpm numen doctor` | 通过；默认 v2 配置无依赖诊断；部署配置单独 validate 通过 |
| `pnpm release:check` | 通过；6 个 public 包本地归档与独立临时 npm 消费者验证；无发布 |
| Workbench 本地归档 | 12 个应用资产、31 条资源引用、12 个导出文件；服务端导入不创建 Server |
| `git diff --check` | 通过 |

当时的本地运行日志存于 `artifacts/verification/{install,build,e2e,pack,final-regression}.log`，
未纳入版本控制。当前复跑结果见 [2026-09-29 组合验收](product-acceptance-2026-09-29.md)。

独立启停测试同时验证：仅启用 Console 不创建 Workbench；缺少 Console 时保留 Workbench
启用意图；明确禁用 Workbench 后，重启 Console 不会复活它；其他插件 Entry 与认证
在 Workbench 禁用期间保留。组测试使用本地 fixture，不安装 Telegram 包。

## 未执行与后续

- 不运行用户日常配置迁移，不读取/修改业务数据库，不执行 Docker 或远程发布。
- 未验收浏览器运行中主动卸载通知、迟到 Entry import 的新组合场景；M4 未实现主动通知。
- 未新增嵌套编辑与复制操作；下一阶段为 M2 Source 定点插入、容器分支及引用安全。
- 本轮不将静态 CLI 配置检查等同于实时插件健康投影或 M4 插件管理界面。
