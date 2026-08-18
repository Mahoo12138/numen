# Numen Architecture Documentation

> 状态：Architecture V1 Draft
>
> 框架名称：**Numen**
>
> 命名语义：**意志 / 力量；让意图在背后自动发生。** Numen 是建立在 Cordis 之上的 plugin-first personal automation framework / runtime。
>
> 本文档集整理当前已确认的 Numen 架构决策。目标不是描述某个单体 “Automation Engine”，而是定义一个 **Cordis-native、万物皆插件、面向个人自动化的可组合框架与默认 Workbench Runtime**。


## 命名约定

- **Numen**：框架与 Runtime 的正式名称。
- **Numen Workbench**：本文档对默认 WebUI / 产品壳的工作称呼；未来如果产品层采用独立品牌，不影响 Numen Framework Contract。
- **`numen/*`**：内建 Contract / Permission / Schema Role 的逻辑命名空间，不等同于 npm scope。
- **`@numen/*`**：本文档中的逻辑 npm 包名占位。实际 npm organization/scope 仍需确认可用性后冻结。
- 社区插件通用命名建议：`numen-plugin-*` / `@scope/numen-plugin-*`。
- CLI 可执行文件统一使用：`numen`。

## 设计总纲

1. **Cordis 是运行时内核，不只是插件加载库。** Plugin、Service、Fiber、Effect、Context isolation、Registry、HMR 都是系统的一等运行时机制。
2. **持久化业务真相与瞬时 Runtime 分离。** Automation、Revision、Run、Connection Config 等持久化；Fiber、Subscription、Socket、Runtime Provider 等可重建。
3. **稳定 Contract + Provider 分离。** Capability、Connection Type、Adapter、Trigger、Control、Console Procedure、Renderer 等都区分“定义”与“当前提供者”。
4. **数据库是 Automation Runtime 的耐久真相。** 内存只做索引、缓存、dispatcher 加速，不承担任务存在性。
5. **插件失效不删除用户意图。** Plugin/Provider/HMR 暂时消失时，配置、Revision、Run、Connection 等保留并进入 NOT_READY/BLOCKED 等可解释状态。
6. **WebUI 本身也是 Cordis Runtime。** 参考 Koishi WebUI：浏览器中运行 Cordis Context，Frontend Entry 加载为独立 Scope，Page/Slot/Renderer/Command 都绑定生命周期。
7. **Schema 驱动默认 UI。** Schemastery 是统一的数据契约描述；自定义 Renderer 只是增强，不应成为执行依赖。
8. **UI 面向用户领域对象，而不是内部协议对象。** 一级产品对象：Automation、Run、Connection、Plugin、System。

## 文档索引

| 文档 | 内容 |
|---|---|
| [00-overview.md](00-overview.md) | 总体架构、边界、设计原则 |
| [01-runtime-loader-hmr.md](01-runtime-loader-hmr.md) | Cordis Runtime、Loader、HMR、Server、CLI |
| [02-plugin-ecosystem.md](02-plugin-ecosystem.md) | Registry、Marketplace、Installer、插件清单与发布 |
| [03-automation-language.md](03-automation-language.md) | Automation Source、Control、Core IR、Expression |
| [04-capability-connection-resource.md](04-capability-connection-resource.md) | Capability、Connection、Adapter、Credential、Resource |
| [05-trigger-state-wait.md](05-trigger-state-wait.md) | Trigger、State、Wait/Signal、事件接收 |
| [06-run-scheduler.md](06-run-scheduler.md) | Run、Execution、Attempt、Scheduler、并发、取消、恢复 |
| [07-revision-publishing-readiness.md](07-revision-publishing-readiness.md) | Draft、Revision、Publish、Activation、Dependency/Readiness |
| [08-console-webui-schema.md](08-console-webui-schema.md) | Console Extension、RPC、WebUI Runtime、Schema UI |
| [09-automation-editor.md](09-automation-editor.md) | Automation Editor、Canvas、Inspector、Variable、Problems |
| [10-identity-permission.md](10-identity-permission.md) | Auth、Principal、Actor、Authorization、审计边界 |
| [11-recovery-diagnostics.md](11-recovery-diagnostics.md) | Safe Mode、Recovery、Diagnostics、Developer Tools |
| [12-product-ia-ui-system.md](12-product-ia-ui-system.md) | Core IA、Workbench、VS Code 经验、UI Design System |
| [13-engineering-operations.md](13-engineering-operations.md) | 数据迁移、备份、升级、测试、部署、SDK 工程约定 |
| [14-v1-scope-open-questions.md](14-v1-scope-open-questions.md) | V1 边界、明确不做、后续开放问题 |
| [15-reference-repositories.md](15-reference-repositories.md) | 开发参考仓库、源码阅读路线、Cordis/Koishi/Shigma/Satori/VS Code 对照图 |

## 推荐阅读顺序

若准备直接开始编码：

`00 → 15 → 01 → 03 → 04 → 06 → 07 → 08 → 09 → 13 → 14`

若准备做前端：

`00 → 15 → 08 → 09 → 12`

若准备写第三方插件：

`15 → 01 → 02 → 04 → 08 → 13`
