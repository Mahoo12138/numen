# N0–N4 整体验收与本地公共包消费检查

2026-10-10 对照 2026-09-30 接续计划的 15 个任务，核对实现、复杂场景测试和既有性能证据。N1 数据语义以 [已批准决策](../24-draft-test-snapshot-decision.md) 为准。本次补充一项配置 Apply 与页面生命周期交错的浏览器回归，没有修改产品代码、依赖或迁移。

## 候选与隔离范围

- 产品基线：`2e46e8facaef620008cb98d05d40e519d5b5725d`。从该提交导出全新源码，独立离线安装锁定依赖并构建，未复用主工作区的 `dist` 或运行实例。
- 最终候选只在该归档叠加本次 `e2e/plugin-config-form.spec.ts`；主工作区另外更新本文、文档索引、STATUS 和历史发布说明。用户原计划与其他任务的未跟踪截图不纳入提交。
- 归档目录：`/var/folders/h6/gsyfj6fj71x7q6y26yx2twm80000gn/T/numen-acceptance-20261010-o45558at`。
- 本地 Node `22.14.0`、pnpm `10.6.3`；锁定工作区使用 TypeScript `5.9.3`、Vue `3.5.41`、Vite `7.3.6`、Vitest `4.1.10`。Cordis `4.0.0-rc.8` 与 Loader `1.0.0-rc.5` 及既有 pnpm patches 保持不变。
- Browser plugin 不可用，使用仓库 Playwright／Chromium、单 worker、生产构建和真实临时 Runtime／SQLite／YAML。未安装额外浏览器依赖，未操作用户日常配置、数据库或密钥。
- production assets SHA256：`4594bf04cf27101dbb4b5b09276478bfc74e4aba171f27590ce24c7e465f63cc`，采用现有 benchmark 的排序路径与文件字节计算方式，与最后一次正式性能测量的产品一致。

最终确认主工作区的 402 个受跟踪产品／示例／脚本／补丁及相关配置文件与隔离副本逐字节一致；新增测试文件两处 SHA256 均为 `ad3062b9abf3eb03072b1c6d2cae5b4440c653309569c8374130636fd9723d18`。六个 tarball 的 SHA256 已逐一重算并匹配 manifest。

## 本次执行结果

| 检查 | 结果 | 本机日志（前缀 `/tmp/numen-acceptance-20261010-`） |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --offline` | 通过 | `install.log` |
| `pnpm typecheck` | 通过 | `typecheck.log` |
| `pnpm build` | 通过 | `build.log` |
| `pnpm build:examples` | 通过 | `examples.log` |
| `pnpm test`，构建完成后执行 | 131 文件 / 923 项通过 | `tests.log` |
| 基线全部 Playwright | 103 项通过，3.1 分钟 | `browser.log` |
| 新增 Apply 离开／返回场景 | 1 项通过，2.3 秒 | `apply-navigation.log` |
| 包含新用例的最终全部 Playwright | 104 项通过，3.1 分钟 | `browser-final.log` |
| `pnpm release:check` | 六个 public 包打包及独立消费通过 | `packages.log` |
| `pnpm numen config validate --config <fixture>` | 通过 | `cli-config-validate.log` |
| `pnpm numen doctor --config <fixture>` | 通过 | `cli-doctor.log` |
| `pnpm numen doctor --safe --config <fixture>` | 通过 | `cli-doctor---safe.log` |

CLI 使用独立的临时 v2 配置，包含内建入口和分组，并指定任务专用的空密钥环境变量；验证的是配置和诊断路径，不等于真实凭据或部署健康检查。没有执行使用默认配置的 `release:verify` 包装脚本。当前结果来自本次命令执行，不是转抄旧文档测试数量。

已打开检查最终运行生成的 1440×960 中文桌面画布、780×860 窄屏 Inspector 和 390×844 手机 Inspector 截图：长标题和错误说明可读，未完成 JSON 保留在完整编辑器中，窄屏使用可关闭的侧边抽屉。对应自动化另外断言无横向溢出、有效路由／标题和非预期浏览器错误为空。图片位于最终输出目录的 `automation-context-keeps-a-fc968-iagnostics-and-pending-JSON/`，不是对 1000 节点场景的新截图或新测量。

## 计划逐项核对

以下链接均为仓库内实现或测试证据；本次全量回归涵盖这些普通单测／浏览器用例，性能基准单独注明来源。

| ID | 已实现的行为与关键复杂场景 | 主要证据 |
| --- | --- | --- |
| N0-01 | 编辑内容与 fingerprint 同时冻结；两个客户端分别在 Preview 前／后发生写入，后台失效通知不更新旧表单凭据；核对真实请求、保留输入与最终 YAML | [配置编辑 E2E](../../e2e/plugin-editing.spec.ts)、[Host CAS](../../packages/runtime/tests/config-management.test.ts) |
| N0-02 | 无效 JSON、隐藏字段、实例／分组／操作切换、返回／刷新／离开保护；查询失败可恢复；丢失已提交响应只读对账，本次新增离开后返回与新会话隔离 | [配置编辑 E2E](../../e2e/plugin-editing.spec.ts)、[表单与生命周期 E2E](../../e2e/plugin-config-form.spec.ts) |
| N1-01 | published／draft-test 用途区分，测试快照不占发布编号；v14 全值、索引、外键、编号间隙和 v12 升级；DDL／CHECK／marker 失败完整回滚，旧 SQLite 明确拒绝 | [决策与查询清单](../24-draft-test-snapshot-decision.md)、[迁移测试](../../packages/database/tests/draft-test-migration.test.ts)、[v14 fixture](../../packages/database/tests/draft-test-v14-fixture.test.ts) |
| N1-02 | 同请求先恢复原结果；同事务接受快照、owners、Run、Journal 和请求；双连接并发、内容冲突、版本／归档／资源竞态、部分写入失败回滚、共享资源清理 | [耐久接受测试](../../packages/scheduler/tests/draft-test-run.test.ts)、[资源服务测试](../../packages/resources/tests/service.test.ts) |
| N1-03 | 合法焦点字段提交并等待保存后固定 Draft version；未发布／未启用草稿可测试；非法输入、编译失败无残留；丢响应后关闭、归档、重开仍恢复同一请求；历史读取固定 Source | [Draft 测试 E2E](../../e2e/automation-draft-test.spec.ts)、[安全 DTO 测试](../../packages/workbench/tests/draft-test-provider.test.ts) |
| N1-04 | 正式 Cron 与测试 Wait／parallel 并行，继续编辑、编译器卸载、GC 和 Runtime 重建后仍按原 IR 完成；独立进程 SIGKILL 后恢复同一 snapshot／Run／owners，正式订阅不变 | [真实 Runtime 组合测试](../../packages/scheduler/tests/draft-test-runtime.test.ts)、[进程中断恢复](../../packages/scheduler/tests/draft-test-process.test.ts) |
| N2-01 | 按稳定 ID 只读查看 published／draft-test，不编译或写 Draft；归档／卸载后可读，认证和归属先于解析；损坏／过大数据、未知协议安全处理；旧请求取消 | [快照 Provider 测试](../../packages/workbench/tests/automation-snapshot-provider.test.ts)、[快照 E2E](../../e2e/automation-snapshots.spec.ts) |
| N2-02 | 稳定节点 ID 区分移动／增删，独立分类参数、binding、策略、Trigger、inputs、Presentation；子树移动不整树误报；版本固定、跨客户端 stale、元数据失败保留 stale、超限拒绝 | [语义比较测试](../../packages/workbench/tests/automation-comparison.test.ts)、[比较 E2E](../../e2e/automation-comparison.spec.ts) |
| N2-03 | 先处理输入与保存，再只读 prepare，确认后一次完整替换；精确版本 CAS，已保存恢复可 Undo／Redo；真实大请求、prepare 竞态、旧请求取消、保存丢响应不自动重放；正式 Run／Cron 不变 | [恢复 Provider 测试](../../packages/workbench/tests/automation-restoration-provider.test.ts)、[恢复 E2E](../../e2e/automation-restoration.spec.ts) |
| N3-01 | Schema／高级 JSON 共用配置真相，保留未知字段，不注入显示默认值；跨字段验证、秘密和不支持 Schema 保护、失败／CAS／丢响应恢复，实例列表与内部详情分开 | [表单测试](../../packages/workbench/tests/plugin-config-form.test.tsx)、[安全表单 E2E](../../e2e/plugin-config-form.spec.ts)、[阶段记录](plugin-config-form-2026-10-08.md) |
| N3-02 | 以真实 Context 归属和观察链解释影响；独立 Definition／Provider、卸载／恢复／移动后稳定 ID；历史／未知不假装无影响，损坏快照与行数／字节／图限额明确处理 | [影响证据测试](../../packages/runtime/tests/config-impact-evidence.test.ts)、[影响 E2E](../../e2e/plugin-impact.spec.ts)、[阶段记录](plugin-impact-2026-10-08.md) |
| N3-03 | Preview 绑定相关观察与管理通道，Apply 队列内重校验并做写前 CAS；提供者替换／重启／直接请求／分组祖先不能绕过保护，丢响应与无关活动不会误重放 | [预览保护测试](../../packages/runtime/tests/config-preview-guard.test.ts)、[过期与管理 E2E](../../e2e/plugin-preview-expiry.spec.ts) |
| N4-01 | 拖拽沿用 Source 命令和一次 Undo，覆盖祖先／后代、空槽、自动滚动、失效目标／冲突取消；搜索展开隐藏祖先且保留输入／焦点；全 Source 移动资格随结构切换更新 | [拖拽搜索 E2E](../../e2e/automation-drag-search.spec.ts)、[搜索测试](../../packages/workbench/tests/automation-node-search.test.ts)、[资格优化记录](workbench-move-eligibility-2026-10-08.md) |
| N4-02 | 聚焦、父级路径和批量折叠沿用 Source／Presentation 归属；并发删除退出聚焦、保存冲突、本地折叠与 Presentation Undo 保留非法输入；中文桌面／窄屏／手机完整工作区 | [上下文测试](../../packages/workbench/tests/automation-flow-context.test.ts)、[上下文 E2E](../../e2e/automation-context.spec.ts)、[页面布局 E2E](../../e2e/workbench-page-layout.spec.ts) |
| N4-03 | 100／300／1000 节点与 100／300 插件固定夹具、样本契约、生命周期指标和冻结预算已建立；本次重新跑跨模块回归，沿用同产品构建的 10-08 性能数据 | [benchmark 契约](../../benchmarks/workbench/README.md)、[容量基线](workbench-capacity-2026-10-08.md)、[最新性能测量](workbench-move-eligibility-2026-10-08.md) |

## 本次新增回归

此前已有“Apply 响应丢失后原页对账”与“有未提交输入时离开”的测试，但缺少两个生命周期的交错。新增用例先通过 `route.fetch()` 让真实 Host 完成写入，扣留成功响应；核对磁盘已变，再依次执行取消离开、确认离开、组件卸载、返回读取和开始新编辑，最后释放旧响应。

断言同时覆盖：原请求实际 `net::ERR_ABORTED`、返回的 fingerprint 与已提交结果一致、总计一次 Preview／一次 Apply、无自动重放、新输入不被旧响应清空、磁盘中目标实例的完整业务配置及另一实例配置保持正确。取消网络请求不被解释为服务端撤销。定向运行及最终全量回归均通过，独立静态复核未发现伪通过或循环等待；本次没有发现需要产品修复的缺陷。

## 公共包消费边界

`release:check` 调用现有 [pack](../../scripts/pack-packages.mjs) 与 [consumer](../../scripts/verify-packages.mjs) 脚本。六包均为 `0.1.0`：`@numenjs/components`、`console`、`core`、`i18n`、`logging`、`webui`。打包检查导出目标、残留 workspace 协议、private 依赖与源码／测试文件；随后按 SHA256 检查 tarball，并在工作区以外新建 npm consumer 安装六包。

消费者实际完成严格 TypeScript 编译（Bundler 解析、`skipLibCheck`）、Node ESM／Vue SSR 组件渲染、Core 值契约、Console／WebUI Cordis Registry 启停，以及 Vite 应用和 CSS 构建。插件构建还检查 Vue／Cordis／components 使用宿主模块 URL，产物小于 2000 字符。各包的所有公共 API 和所有 peer 版本组合不在这项 smoke check 的覆盖范围。

独立 npm consumer 不继承工作区 lockfile 或 pnpm patches；本次 consumer 根据现有版本范围解析到 Vite `7.3.7`，工作区仍为锁定的 `7.3.6`。这些打包／消费结果不能外推为任意第三方 Cordis／Loader 生命周期兼容性。Workbench、Runtime、CLI 仍为 private；未确认 npm scope 权限，未运行 publish。

[六包 manifest](n0-n4-public-packages-2026-10-10.json) 保留名称、版本、文件名和本次 tarball SHA256；二进制包留在上述隔离目录 `artifacts/npm/`，不纳入源码提交。消费者临时目录由现有脚本在验证后清理。

## 性能、容量与未覆盖项

本次没有重新执行正式性能基准。产品 assets 与 [10-08 最新五组数据](workbench-move-eligibility-after-2026-10-08.json) 完全一致，因此保留其证据身份和日期：300 节点选择／字段本地提交 P95 为 74.1／69.5ms；1000 节点为 227.8／228.7ms。字段指标不含 600ms 自动保存等待；路由就绪不是标准 TTI，十轮后仍有保留堆增量，不能宣称无泄漏。

- N2 查看是 **最多 250 Flow 节点／64 层的有标记投影**；比较与恢复超出结构上限会整体拒绝，另有存储／响应字节限制。N4 的 300／1000 节点编辑器数据不扩展 N2 上限，1000 节点仍只作为压力探针。
- Draft 测试保留已支持位置的静态 ResourceRef；动态拼接字符串或 Provider 内部隐含资源不在保证内，多 Host 对共享目录并发 GC 仍不支持。历史无自动 TTL／普通 Run 删除；明确永久删除 Automation 仍检查活跃 Run。Undo 栈仅属于当前编辑会话。
- 当前最新迁移为 v15，要求 SQLite ≥3.53；破坏性 down migration 未提供，真实升级回退依赖迁移前完整备份。本次迁移用测试数据库验证，没有升级用户业务库或执行真实冷备恢复。
- 插件安全表单不开放秘密编辑；渲染限制为 500 节点／数组 50 项，高级 JSON 保留未知字段。有界影响观察不能证明任意插件动态行为，Draft 引用不在当前影响扫描内；历史／未知观察不代表无影响。分组关闭／恢复不会撤销已产生的副作用。
- Preview 过期基于相关观察变化，没有时间 TTL。Host 写前保护不构成跨进程 SQLite／文件系统分布式事务保证。同进程插件仍为受信任代码。
- 本次未验证 Node 24、其他浏览器、远程 CI、容器、真实外部 Integration、npm／镜像仓库或部署。已有历史结果不转作当前发布结果。

## 记录定位

N0–N4 的实现与本地综合验收在上述范围内完成。下一阶段产品需求或实际发布候选需要单独确定范围；不从此报告推导发布完成。早期 [MVP 发布页](../17-mvp-release.md) 已标注其历史 private 包和 schema v13 背景。

10-08 各阶段报告内的“下一步／尚未实施”仅描述当时状态，由 STATUS 的后续章节和本文更新当前进度；不改写当时失败、缺失原始 N0 red artifact 或环境限制的记录。原始日志和截图位于 `/tmp/numen-acceptance-20261010-*`，临时目录不是永久档案。
