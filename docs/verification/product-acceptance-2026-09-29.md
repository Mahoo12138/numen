# Console / Workbench 组合验收与提交边界（2026-09-29）

依据 2026-09-28 r2 开发计划第 14 节，对当前 M0–M4 实现重新验收。基线为 `98e5b70`，本轮接续此前尚未提交的开发内容；仍是非 release 阶段，不新增兼容层、不发布、不推送。此前各阶段记录是当时的历史结果，本文件记录本次实际复跑结果。

**首轮结论（归属补完前）：已实现范围的回归通过；M5 整体验收仍有一个功能缺口，不能标为全部通过。** 当时场景 E 的故障和恢复已验证，但业务对象尚不能精确定位到所属插件实例。该缺口已在同日后续实现，见文末“实例归属与导航补完”。M3-05 Draft 快照持久化仍待数据模型决策，不属于已交付能力。

## 场景与结果

| 计划场景 | 本次证据与结论 |
| --- | --- |
| A：独立 Console / Workbench | `runtime/tests/product-lifecycle.test.ts`、`e2e/entry-invalidation.spec.ts` 通过。Console-only、依赖等待、各十轮独立启停、后台运行与订阅、其他 Entry 存活，以及单独禁用 Workbench 的意图均覆盖。 |
| B：分组与稳定身份 | `runtime/tests/cordis-groups.test.ts`、`runtime/tests/config-management.test.ts` 和新增组合浏览器用例通过。三个本地配置实例中一个单独禁用；组关闭/恢复后仍禁用。Adapter 跨组移动与重启后，实例 ID、Connection ID/generation、Automation 和历史 Run 保留。 |
| C：完全通过 UI 搭建复杂流程 | `e2e/automation-structure.spec.ts` 通过。从空 Draft 创建 Cron → 本地 HTTP → If → Then/ForEach/Echo、Else/Echo；嵌套复制、定点插入、分支增删、跨容器移动、撤销/重做、刷新、作用域诊断定位及实际执行均覆盖。 |
| D：调试隔离 | `e2e/automation-revision-test.spec.ts`、`e2e/run-data.spec.ts` 及 Scheduler Revision 测试通过。新 Revision 发布但不激活，固定版本试运行、响应丢失后恢复、保留原 Active Revision 和 Cron 订阅、分类输出与 Source 定位均覆盖。 |
| E：异常排查与恢复 | **部分通过**。Home → 异常 Connection → 插件列表可达，Run Timeline 能显示 Provider 不可用。组停用后 Connection 不可用、Execution BLOCKED，恢复后原 Run 完成。当前“Check plugin availability”进入通用列表，尚无可靠的 Adapter/Capability → Loader Entry 归属索引，也没有 Run → 对应实例直达路径；因此精确定位未验收通过。 |
| F：组合异常 | 新增 `e2e/product-acceptance.spec.ts` 通过。将保存中导航、两个独立 Console 客户端版本冲突、未应用 JSON、WebSocket 断开/重连、插件 Entry 撤回/重新加载、配置已落盘但响应丢失、分组恢复及 Host 重启放在同一条实际浏览器流程中验证。 |

所有业务夹具使用临时配置、临时 SQLite 和本地插件，无需真实 Telegram 账号，也不读取用户日常业务数据库。新增测试中另一个浏览器页面执行管理操作，其认证请求作为独立客户端赢得 Draft 版本竞争；原编辑页收到 409 后保留未提交 URL 与无效 JSON，不覆盖服务端版本。

## 组合场景的关键断言

- 配置操作响应丢失后仅读取对账，写请求恰好一次；成员自身启用意图与继承状态分别验证。
- 关闭依赖组后旧 Trigger signal 被 abort，旧回调 emit 返回 `stale`；Connection 运行资源关闭，业务配置仍启用。
- 恢复组后活动订阅恰好一份；同一个阻塞 Run 恢复完成，Revision 不变。另一个明确禁用的成员从未启动。
- 断线重连与 Entry 变化期间，编辑器保存仍在途；取消导航保留当前字段。独立客户端先保存后，迟到请求形成真实版本冲突，无效 JSON 不丢失。
- Adapter 移组后重启 Host；稳定实例 ID、Connection generation、Draft 服务端版本及历史 Run 一致。重启后的重复事件返回 `duplicate` 和同一个 Run ID。
- 退出 Host 时活动订阅归零，Connection 打开/关闭次数相等。未把清理成功等同于业务数据删除。
- 浏览器异常均作为失败处理；仅允许精确匹配且各一次的预期 409 和主动模拟响应丢失网络错误。

## 实际执行

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 98 个文件、490 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | TypeScript 与生产前端构建通过 |
| `pnpm build:examples` | 独立组件插件构建通过 |
| `pnpm exec playwright test --output=/tmp/numen-m5-browser` | 24 项通过，约 1.5 分钟 |
| 组合用例追加 Entry 撤回和重复事件状态断言后定向复跑 | 1 项通过，最终截图来自 `/tmp/numen-m5-combined-final` |
| `pnpm numen config validate` / `pnpm numen doctor` | 通过 |
| `pnpm numen config validate --config deploy/numen.config.yml` | 通过 |
| `pnpm release:check` | 6 个 public 包本地打包、临时 npm 安装、类型、ESM/SSR、构建适配器与共享 Cordis 服务检查通过；该命令不发布 |
| `git diff --check` | 通过；每个模块提交前另检查实际暂存范围和空白错误 |

基础日志为本机 `/tmp/numen-m5-{unit,typecheck,build,examples,config,doctor,deploy-config,package-check}.log`，浏览器日志为 `/tmp/numen-m5-browser.log` 和 `/tmp/numen-m5-combined-final.log`。临时日志和 tarball 不纳入提交。当前没有 Browser 插件，浏览器验收使用仓库 Playwright 与 Chromium。

截图已查看：桌面显示 Run 的真实阻塞原因、编辑器本地/服务端版本冲突与周边布局；390×844 下 JSON 输入、错误提示、底部状态和导航可见，无页面水平溢出。完整回归还覆盖 900px 窄桌面、中英文与已有弹层交互。

- [Run 阻塞原因](../../artifacts/verification/m5-blocked-run-desktop.png)
- [桌面：组合故障后的 Draft 冲突](../../artifacts/verification/m5-protected-conflict-desktop.png)
- [移动端：未应用 JSON 仍保留](../../artifacts/verification/m5-protected-conflict-mobile.png)

## 后续边界与模块提交

本轮按以下模块提交已验证的实现及其测试：依赖补丁和 workspace 声明、Config/CLI、Console/WebUI/i18n、Schema 组件、Scheduler/Triggers/HTTP 诊断、Workbench 编辑与管理、Runtime/默认配置/容器接线、端到端验收与文档。历史 M0–M4 截图和 JSON 检查记录随文档保留，属于当时证据，不冒充本轮重新生成。

首轮留下的工作是场景 E 的实例归属诊断与导航，以及另行决策后的 M3-05 Draft 快照。影响预览仍明确 unknown；缺失的归属信息不能根据包名或 Capability ID 猜测。Workbench 仍是 private workspace 包，本地 public 包消费验证不代表 Workbench 可独立从 registry 安装。Dockerfile 与 smoke 脚本已静态检查和配置校验，但本轮没有构建/启动容器，也没有远程 CI 或发布验收。

## 实例归属与导航补完（2026-09-29）

基线 `686fdf7`。用户要求参考 Koishi 的类似操作后实现，范围限于场景 E 的归属诊断与导航。

### Koishi 依据与适配

本轮实际读取 `koishijs/webui` 的 `main` 源码，以下链接指向分支，并非固定提交：

- [Status Profile](https://github.com/koishijs/webui/blob/main/plugins/status/src/profile.ts) 对 Bot 的实际 `bot.ctx.scope` 调用 `loader.paths()`，将所属路径交给前端。
- [Bot 状态导航](https://github.com/koishijs/webui/blob/main/plugins/status/client/bots/index.vue) 使用该路径跳转到插件配置。
- [Config ServiceProvider](https://github.com/koishijs/webui/blob/main/plugins/config/src/shared/services.ts) 从真实服务实例的 Context 获取所属 Scope，并监听服务变化更新。

采用其“实际注册上下文 → Loader 身份 → 实例导航”的做法，使用 Numen 当前 Cordis 的 Fiber/Entry；没有引入旧 Scope API 兼容层，也不按包名或 Capability ID 推测归属。

### 实现与边界

- Core/Connections 在 Definition 与 Provider 注册及释放时发送真实所有者 Context 和独立生命周期 token。Host 在加载用户实例之前开始观察，沿内部子插件的 Fiber 父链找到最近的 Loader Entry。
- 索引只保存稳定 ID、插件来源、token、观察时间与存活状态，不持有已卸载的 Context/Fiber。最多保留 4096 条观察；淘汰、从未加载或 Host 重启后未重新注册的项目显示 unknown。历史归属只作为排查线索，不承诺插件恢复后必然提供相同注册项。
- Definition 和 Provider 可属于不同实例；Definition 提前卸载也撤销 Provider 注册证据。旧生命周期的迟到释放不能覆盖新注册，重复释放不重复发事件。
- 每次诊断结合当前配置重算父组路径和实际状态；实例删除、换来源、配置外部漂移时不提供错误目标。该索引不是完整依赖影响图，也不是持久化审计历史。
- Connection 展示 Adapter Definition/Provider 和 Type Definition；Run 使用自身不可变 Revision 的 invoke 指令解析 Capability 与绑定 Connection，不读取当前 Draft。校验 Execution 所属 Run，删除的 Connection 明确提示；一次最多 64 项依赖，输出不含配置、凭据、输入或输出值。
- 两处界面按需加载，已展开面板通过事件自动更新。可直达精确实例或禁用父组；定位会临时显示折叠路径、滚动并聚焦目标，不改写 `$collapsed`。刷新保留定位，返回保留 Connection 选择或 Run 的原视图与列表筛选。目标不存在时明确提示；返回地址仅接受已知内部对象路由。

### 补充验收

新增运行时用例验证独立定义/实现、内部子插件、分组禁用与恢复、跨组移动、定义先卸载、迟到释放、未托管注册、外部配置漂移、实例删除/换源，以及重启后的 unknown。Core Trigger 与 Connection Adapter 另覆盖定义先释放、重复清理与新旧 Provider 交错。

组合浏览器用例实际经过：Home → 异常 Connection → Adapter 实例 → 刷新 → 返回；Run Timeline → Capability 实例 → 返回并保留 RUNNING 筛选 → 禁用父组 → 恢复，原阻塞 Run 完成。随后在面板展开时从 Host 停用/恢复 Adapter，断言自动从 current 变 previous 再恢复；缺失实例深链无替代选中。原有保存冲突、未应用 JSON、订阅清理、稳定身份移动和 Host 重启断言继续保留。

另外先复现了后台更新重新抢焦点的问题：深链定位后将焦点移到命令中心，再由 Host 重命名另一组，旧实现会错误聚焦回目标实例。改为分别观察目标 ID 与是否加载完成之后，该回归通过，正常后台刷新保留当前焦点。返回路径解析也覆盖了反斜杠造成的非法 URL，解析失败时不提供返回按钮，不会令整个页面渲染失败。

浏览器为本机 Playwright/Chromium，临时 `127.0.0.1` 端口、隔离 SQLite 与本地 fixture；Browser 插件不可用。查看了 1440×960 英文定位/诊断画面和 390×844 中文归属面板，主要按钮可见，无水平溢出。没有真实外部账号、其他浏览器或远程环境验收。

| 本轮命令 | 实际结果 |
| --- | --- |
| `pnpm test` | 101 个文件、498 项通过 |
| `pnpm typecheck` / `pnpm build` / `pnpm build:examples` | 通过；最后的焦点与返回路径修复后单元测试、类型与生产构建再次通过 |
| `pnpm exec playwright test --output=/tmp/numen-ownership-browser-complete` | 24 项通过，约 1.6 分钟 |
| `pnpm exec playwright test e2e/product-acceptance.spec.ts e2e/management.spec.ts --output=/tmp/numen-ownership-browser-final-accepted` | 最后焦点与返回路径修复后的 3 项相关回归通过 |
| `pnpm release:check` | 6 个 public 包本地打包、安装、类型、ESM/SSR、构建适配器与共享 Cordis 检查通过；没有发布 |
| `git diff --check` / `git diff --cached --check` | 通过，按模块检查实际暂存范围 |

日志保留在 `/tmp/numen-ownership-{unit-final,typecheck-final,build-final,examples-final,package-check,browser-complete,browser-final-accepted}.log`；焦点问题的失败证据保留在 `/tmp/numen-ownership-focus-regression.log`。最后截图位于 `/tmp/numen-ownership-browser-final-accepted/product-acceptance-recover-a6c93--conflict-and-pending-input/` 的 `located-instance-desktop.png`、`blocked-run-desktop.png` 和 `ownership-mobile-zh.png`，不写入产品资产。

场景 E 的实例导航缺口已补齐；M3-05 数据模型决策、完整依赖影响图和发布工作不包含在本次交付中。
