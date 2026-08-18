# Numen Reference Repositories

> 状态：Architecture V1 Reference Map  
> 最近核对：2026-08-18  
> 用途：标注开发 Numen 时值得优先阅读、对照或持续跟踪的外部仓库，并说明其与 Numen 各模块的对应关系。

## 1. 使用原则

Numen 不以“复制 Koishi”或“复制某个 Shigma 项目”为目标。参考仓库的用途是复用已经被实践验证的设计经验，并在 Numen 的自动化领域约束下重新收敛。

建议始终遵循以下优先级：

```text
Cordis 官方 Runtime Primitive
        ↓
Cordiverse 基础设施
        ↓
Koishi 已验证的 Cordis 应用模式
        ↓
Shigma / Satori 等同生态 TypeScript 设计经验
        ↓
Numen Automation Domain Contract
```

具体规则：

1. **Cordis 能直接表达的机制，不在 Numen 中另造平行 Runtime。**
2. **Koishi 已验证的 Loader、HMR、Console、Marketplace、Config 等模式，优先适配而不是从零设计。**
3. **Satori、Minato/Database、Reggol 等主要作为“局部设计先例”，不自动成为 Numen 依赖。**
4. **仓库中的实现细节可能随版本变化。** 开发对应模块前，应重新查看当前主分支，而不是只依赖本文件的描述。
5. **不要把同名概念自动视为同一语义。** 特别是 `cordiverse/capability` 与 Numen Automation Capability 并非同一个抽象。
6. **区分原生仓库与个人 Fork。** `github.com/shigma` 下存在一些上游项目 Fork；本文件优先列出 Shigma 自己维护或 Cordiverse / Koishi / Satori 生态中的 canonical repository。

---

## 2. P0：Numen 的直接架构先例

这些仓库建议在对应模块开发前直接阅读源码。它们对 Numen 的架构影响最大。

### 2.1 `cordiverse/cordis`

Repository: <https://github.com/cordiverse/cordis>

定位：Cordis 官方仓库，当前描述为 **Meta-Framework of Spatiotemporal Composability**。

Numen 对应模块：

- Runtime Kernel
- Context
- Service / Dependency Injection
- Fiber / Scope
- Effect 生命周期
- Registry / Reflection
- Plugin lifecycle
- Isolation / interception
- HMR 的运行时边界

重点参考：

- `Context` 的层级与隔离语义。
- `Service` 如何绑定 Context 生命周期。
- Plugin/Fiber 的创建、更新与 dispose。
- Effect 如何把 timer、listener、provider registration 等副作用绑定到 Scope。
- Registry 如何表达 Runtime presence，而不是持久业务状态。

Numen 原则：

> Cordis 是 Numen 的运行时内核，不只是一个“插件加载器”。Numen 不应重新实现第二套 Plugin Runtime、Service Container 或 Effect 生命周期系统。

优先级：**最高 / Source of Truth**。

---

### 2.2 `koishijs/koishi`

Repository: <https://github.com/koishijs/koishi>

定位：规模化 Cordis 应用的最重要实践仓库。

Numen 对应模块：

- Application bootstrap
- Loader
- Config Tree → Fiber Tree
- HMR
- Plugin Config
- Service injection pattern
- Runtime diagnostics
- 应用级插件组织方式

重点路径：

```text
packages/loader/
plugins/hmr/
```

尤其参考：

- Loader 如何读取配置树、解析插件、创建 Fork。
- `$if`、`$filter`、group 等配置树语义。
- writable config 与 atomic config write。
- HMR 如何从文件 dependency graph 定位“受影响的 Plugin Runtime”。
- HMR 如何先尝试加载新代码，再 dispose 旧 Runtime，并在失败时 rollback。

Numen 不应照搬：

- Koishi 的聊天机器人业务模型。
- Koishi 特有的 Session / Bot / Command 语义。
- 仅适用于 Bot 生态的数据库表与权限定义。

优先级：**最高 / Proven Application Pattern**。

---

### 2.3 `koishijs/webui`

Repository: <https://github.com/koishijs/webui>

定位：Numen Console / WebUI / Marketplace 最重要的实现参考。

Numen 对应模块：

- Browser-side Cordis Context
- Frontend Extension Loader
- Page / Slot lifecycle
- Console backend bridge
- WebSocket RPC/Data projection
- Plugin Config UI
- Registry / Marketplace / Installer
- Auth projection
- Logger / Status / Diagnostics

重点路径：

```text
packages/client/
packages/console/
packages/components/
packages/registry/
packages/market/

plugins/config/
plugins/market/
plugins/auth/
plugins/logger/
plugins/status/
```

特别重要的设计经验：

1. **Browser 本身运行 Cordis。** Frontend Plugin 不是手写的一套平行 Extension Runtime。
2. `page()` 与 `slot()` 是 UI extension 的基础 primitive。
3. Backend `Console Entry` 与 Browser Extension Scope 生命周期相连。
4. DataService + event RPC 可以作为 Numen typed Query/Action/Subscription 的实现基础。
5. Marketplace、Registry、Installer、Loader 的职责边界清晰：发现、解析、安装、运行互不混淆。
6. Plugin Config 使用 runtime Schema 驱动表单，与 Schemastery Validation 共享 Contract。

Numen 应增强的部分：

- typed/versioned Console Contract。
- Automation Editor reconnect，而不是简单 reload。
- Schema Renderer Registry。
- Automation-specific Extension Points。
- Stable contract IDs / namespace。

优先级：**最高 / WebUI Source Pattern**。

---

### 2.4 `cordiverse/database` — Minato lineage

Repository: <https://github.com/cordiverse/database>

历史说明：原 `shigma/minato` 当前在 GitHub 上解析到该仓库。本文统一称为 **Database / Minato lineage**。当前仓库描述为 **Type Driven Database Framework**。

Numen 对应模块：

- Durable model abstraction
- Type-driven database API
- Driver / backend abstraction
- Model extension
- Query / expression typing
- 数据库服务如何成为 Cordis ecosystem 中的可组合能力

重点参考：

- 如何用 TypeScript 类型系统描述 Model / Field / Query。
- Database Service 与插件模型的边界。
- Backend/Driver 替换能力。
- Model Extension 对插件生态的价值。

Numen 中的使用态度：

- 可以参考其数据库抽象与类型设计。
- 是否直接采用 Database/Minato 作为 Numen V1 持久化实现，应由实际 transaction、migration、SQLite 需求验证决定。
- Numen Scheduler 的 durability contract 不能为了适配 ORM 而弱化。

优先级：**高 / Durable Data Architecture**。

---

### 2.5 `shigma/schemastery`

Repository: <https://github.com/shigma/schemastery>

定位：当前描述为 **Type driven schema validator**。

Numen 对应模块：

- Capability input/output schema
- Connection config
- Credential type
- Trigger config
- State definition
- Console RPC schema
- Contract Snapshot
- Schema-driven UI

重点参考：

- Schema serialization / hydration。
- object / union / intersect / transform。
- description、default、required、role 等 metadata。
- 类型推断与运行时 validation 的统一。

Numen 原则：

> Schemastery 描述“数据与 Contract 是什么”；Schema UI Renderer 描述“它在界面中如何编辑或展示”。不要把 Vue component、callback 或 runtime object 塞进 Schema。

优先级：**最高 / Contract Schema Source**。

---

## 3. P1：高价值局部机制参考

这些仓库通常不需要成为 Numen 的直接依赖，但其设计方式值得在开发相关模块时重点阅读。

### 3.1 `cordiverse/server`

Repository: <https://github.com/cordiverse/server>

Numen 对应模块：

- HTTP Server
- Route lifecycle
- WebSocket upgrade
- middleware / intercept
- Resource API
- Webhook endpoint
- Console transport substrate

建议：优先把它作为 Numen HTTP/WS substrate，而不是在 Core 内自行维护另一套 Express/Fastify 生命周期。

---

### 3.2 `cordiverse/cli`

Repository: <https://github.com/cordiverse/cli>

Numen 对应模块：

- `numen` CLI
- daemon supervisor
- worker bootstrap
- restart / exit code protocol
- heartbeat
- Recovery / Safe Mode 启动入口

重点参考：

```text
CLI / Supervisor
      ↓
Worker
      ↓
new Cordis Context
      ↓
Loader
      ↓
Application Plugin Tree
```

Numen Host 应尽量保持 business-unaware。

---

### 3.3 `cordiverse/yakumo`

Repository: <https://github.com/cordiverse/yakumo>

当前描述：**Manage complex workspaces with ease.**

Numen 对应模块：

- Monorepo workspace
- package build task
- package graph
- SDK / Core / Plugin 多包工程
- publish workflow

尤其适合参考 Numen 将来形成：

```text
packages/core
packages/automation
packages/console
packages/client
packages/components
plugins/*
```

后的 workspace 管理方式。

---

### 3.4 `shigma/reggol`

Repository: <https://github.com/shigma/reggol>

当前描述：**Logger for professionals**。

Numen 对应模块：

- structured logger
- logger namespace
- log target
- formatting
- runtime metadata
- Console Logs

Numen 重点不是只复用输出格式，而是参考“Logger 作为基础设施”的边界，并结合 Cordis Scope / Loader Path / Run Context 自动附加：

```text
pluginPath
connectionId
runId
executionId
attemptId
traceId
```

注意：Logs 仍然不能替代 Run Journal、Audit 或 Diagnostics。

---

### 3.5 `satorijs/satori`

Repository: <https://github.com/satorijs/satori>

当前描述：**The Universal Messenger Protocol**。

Numen 对应模块：

- Adapter Protocol
- external platform normalization
- event model
- typed universal entity
- protocol / implementation separation
- 多 Adapter Provider 生态

Numen 最值得借鉴的是：

> 面对大量异构外部平台时，如何定义稳定的“通用协议层”，同时允许 Adapter 处理平台差异。

这与 Numen 的：

```text
Credential → Adapter → Connection → Capability
```

非常接近，但 Numen 的目标是通用个人自动化，不应把 Satori 的 Messenger entity 直接扩展成万能外部数据模型。

---

### 3.6 `satorijs/extensions`

Repository: <https://github.com/satorijs/extensions>

Numen 对应模块：

- Adapter 的真实生态样本
- 不同平台如何实现同一个上层 Protocol
- provider-specific configuration
- optional feature / compatibility handling

适合开发第一批 Numen Connection Adapter 时阅读，而不是用于 Core Contract 设计。

---

### 3.7 `shigma/ns-require`

Repository: <https://github.com/shigma/ns-require>

当前描述：**Require with Namespace**。

Numen 对应模块：

- Loader package resolution
- plugin naming convention
- namespace-aware module resolution

Koishi Loader 已实际使用类似机制处理 `koishi` / `plugin` / official namespace / baseDir 等解析规则，因此 Numen 设计自己的：

```text
numen-plugin-*
@scope/numen-plugin-*
```

时可参考，但优先保持 Node resolution 行为可预测。

---

### 3.8 `shigma/cosmokit`

Repository: <https://github.com/shigma/cosmokit>

当前描述：**A collection of common utilities**。

Numen 对应模块：

- lightweight TypeScript utility conventions
- Dict / Awaitable / common helpers
- ecosystem package granularity

用途主要是代码风格与基础工具层参考。不要因为“生态同源”就把所有 helper 都引入 Numen；只有确实降低重复代码时再依赖。

---

### 3.9 `shigma/typed-eval`

Repository: <https://github.com/shigma/typed-eval>

当前描述：**Type-based calculation does right with TypeScript**。

Numen 对应模块：

- ValueExpr
- expression type inference
- operator typing
- type-level expression experiments

它不是 Numen Expression Runtime 的直接实现模板，但在设计：

```text
Schema<T>
   ↓
ValueExpr<T>
   ↓
static compatibility
```

时值得阅读。

Numen 仍应坚持：表达式执行使用受限 AST，不执行 arbitrary JavaScript。

---

## 4. P2：选择性阅读与持续观察

### 4.1 `cordiverse/capability`

Repository: <https://github.com/cordiverse/capability>

状态：2026 年出现的较新 Cordiverse 仓库，建议持续观察。

当前 `packages/core` 中同样以 Cordis Service 暴露 `ctx.capability`，并提供：

```text
define
provide
inherit
depend
check
test
```

以及 capability dependency / inheritance graph。

**重要：它与 Numen Automation Capability 语义不同。**

该仓库当前更接近：

```text
Principal / Session
        ↓
Capability / Permission Graph
        ↓
check / test
```

而 Numen Capability 是：

```text
Automation Contract
        ↓
Trigger / Query / Action
        ↓
Provider Invocation
```

因此建议用于参考：

- Numen Access / Permission。
- capability graph / dependency expression。
- Effect-based define/provide registration。

不要直接用于替换：

- `Numen Capability Protocol`。
- Automation action/query/trigger contract。

---

### 4.2 `cordiverse/http`

Repository: <https://github.com/cordiverse/http>

参考方向：HTTP client/service、网络能力在 Cordis 中的 Service 化方式。适合 Connection Adapter、Webhook、OAuth、外部 API 插件开发时查看。

---

### 4.3 `cordiverse/unyaml`

Repository: <https://github.com/cordiverse/unyaml>

参考方向：YAML 与配置处理。Numen Loader Config、Import/Export、可写配置格式设计时可选择性查看。

---

### 4.4 `koishijs/common`

Repository: <https://github.com/koishijs/common>

参考方向：成熟 Koishi 插件如何组织 Config、Service、命令、依赖、数据库与插件生命周期。

适合写 Numen 官方示例插件时参考“插件作者体验”，但不要继承 Bot-specific API。

---

### 4.5 `satorijs/webui`

Repository: <https://github.com/satorijs/webui>

参考方向：协议生态自身的 WebUI 与相关工具。优先级低于 `koishijs/webui`，主要用于观察同生态如何复用 WebUI infrastructure。

---

## 5. UI / Workbench 外部参考

### 5.1 `microsoft/vscode`

Repository: <https://github.com/microsoft/vscode>

Numen 对应模块：

- Workbench layout
- Activity Bar
- Primary / Secondary Sidebar
- Panel
- Command / Menu / Keybinding model
- Problems
- Status visibility
- Extension contribution boundaries

Numen 要借的是 **Workbench Architecture**，不是 IDE 外观。

映射：

```text
VS Code                   Numen
────────────────────────────────────────────
Activity Bar       →      Global Activity Rail
Primary Sidebar    →      Context Navigation
Editor Area        →      Automation Workbench
Secondary Sidebar  →      Inspector
Panel              →      Problems / Timeline / Logs
Status Bar         →      Context Status
Command Palette    →      Domain Command Center
```

Numen 不应复制：

- File Explorer 中心模型。
- 多文件 Editor Tab 作为核心交互。
- Terminal-centric workflow。
- 任意 Extension 控制整个 UI Layout。

---

## 6. 按 Numen 模块查参考仓库

| Numen 模块 | 第一参考 | 第二参考 | 备注 |
|---|---|---|---|
| Runtime / Plugin Lifecycle | `cordiverse/cordis` | `koishijs/koishi` | Cordis 为 Source of Truth |
| Loader | `koishijs/koishi` | `shigma/ns-require` | Config Tree → Fiber Tree |
| HMR | `koishijs/koishi` | `cordiverse/cordis` | Plugin Runtime 是 reload boundary |
| CLI / Supervisor | `cordiverse/cli` | `koishijs/koishi` | Host 保持业务无感 |
| HTTP / WS | `cordiverse/server` | `cordiverse/http` | Console、Resource、Webhook |
| Database | `cordiverse/database` | `koishijs/koishi` | Minato lineage |
| Schema / Validation | `shigma/schemastery` | `koishijs/webui` | Schema 同时服务 Contract 与 UI |
| Console / WebUI Runtime | `koishijs/webui` | `satorijs/webui` | Browser Cordis Context |
| Schema-driven UI | `koishijs/webui` | `shigma/schemastery` | Numen 增加 Renderer Registry |
| Marketplace / Registry | `koishijs/webui` | `shigma/ns-require` | Installer 不等于 Loader |
| Logging | `shigma/reggol` | `koishijs/webui/plugins/logger` | 与 Journal/Audit 分离 |
| Adapter / Connection | `satorijs/satori` | `satorijs/extensions` | 学协议归一化，不搬 Messenger Domain |
| Permission / Capability Graph | `cordiverse/capability` | `koishijs/webui/plugins/auth` | 注意与 Automation Capability 同名冲突 |
| Expression Type Design | `shigma/typed-eval` | `shigma/schemastery` | 仅参考类型思想 |
| Monorepo / Build | `cordiverse/yakumo` | `koishijs/webui` | 多包 Build / Publish |
| Workbench UI | `microsoft/vscode` | `koishijs/webui` | Automation-oriented，而非 IDE clone |

---

## 7. 推荐源码阅读路线

### 7.1 开始实现 Numen Runtime

```text
cordiverse/cordis
    ↓
koishijs/koishi packages/loader
    ↓
koishijs/koishi plugins/hmr
    ↓
cordiverse/cli
    ↓
cordiverse/server
```

目标：先建立正确的 Host → Loader → Cordis Fiber Tree，不先写 Automation Engine。

### 7.2 开始实现持久化与 Scheduler

```text
cordiverse/database
    ↓
Numen 06-run-scheduler.md
    ↓
Numen 07-revision-publishing-readiness.md
```

目标：借鉴 type-driven storage，但以 Numen durable scheduler contract 为最高约束。

### 7.3 开始实现 Console / WebUI

```text
koishijs/webui packages/client
    ↓
packages/console
    ↓
plugins/config
    ↓
packages/components
    ↓
Numen 08-console-webui-schema.md
```

目标：Browser Cordis Runtime + Entry + Page/Slot + typed Console Contract。

### 7.4 开始实现 Marketplace

```text
koishijs/webui packages/registry
    ↓
packages/market
    ↓
plugins/market/src/node/installer
    ↓
Numen 02-plugin-ecosystem.md
```

目标：Registry / Market / Installer / Loader 四层保持解耦。

### 7.5 开始实现 Adapter / Connection

```text
satorijs/satori
    ↓
satorijs/extensions
    ↓
Numen 04-capability-connection-resource.md
```

目标：学习 Universal Protocol 与 Adapter 分离，但保持 Numen Connection / Credential / Capability 三者的独立边界。

### 7.6 开始实现 Automation Editor

```text
koishijs/webui
    ↓
microsoft/vscode Workbench
    ↓
shigma/schemastery
    ↓
Numen 09-automation-editor.md
    ↓
Numen 12-product-ia-ui-system.md
```

目标：不是做任意 DAG Editor，而是做 Structured Automation Source 的视觉 Workbench。

---

## 8. 参考时的“禁止推导”

为了避免 AI Coding 或后续实现者过度类比，以下推导默认禁止：

```text
Koishi 有 Bot
⇒ Numen Core 应该有统一 Device/Account 父类        ×

Satori 有 Universal Message
⇒ Numen 应该建立 Universal External Entity Model   ×

Minato/Database 有 ORM abstraction
⇒ Scheduler transaction 可以交给 ORM 自由决定      ×

Cordiverse 有 capability
⇒ Numen Automation Capability 应改成它的模型        ×

Koishi Console 断线 reload
⇒ Automation Editor 断线也直接 reload               ×

VS Code 可以任意移动 Workbench Part
⇒ Numen 插件也应该任意修改布局                       ×
```

正确原则是：

> **参考机制，不继承不相关领域语义；参考已经验证的边界，不放弃 Numen 已经定义的 Automation Contract。**

---

## 9. 后续维护规则

该文件不是静态“致谢列表”，而应作为开发导航持续维护。

建议每次发生以下情况时更新：

- Cordis 出现重要 Runtime API 变化。
- Koishi Loader/HMR/WebUI 重构。
- Cordiverse 新增与 Numen Protocol 高度重叠的基础设施。
- Numen 决定直接依赖某个参考仓库。
- 某参考仓库停止维护、归档或迁移。
- 开发过程中发现新的高价值 TypeScript 架构项目。

对每个新参考仓库至少记录：

```text
Repository
Canonical owner
Reference priority
Relevant Numen modules
What to learn
What not to copy
Last verified date
```

这样该文档最终可以成为 Numen 开发时的 **Architecture Source Map**，而不只是一个链接收藏夹。
