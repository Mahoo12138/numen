# 14. Numen V1 边界与 Open Questions

## 1. 已确认 V1 方向

### Runtime

- TypeScript / Node.js
- Cordis-native plugin runtime
- Koishi-style Loader config tree
- Koishi-style HMR
- Cordis server/CLI patterns

### Persistence

- SQLite single scheduler
- DB durable truth
- local/default ResourceStore
- encrypted Credential payload

### Automation

- Source → Core IR → Scheduler
- immutable Revision
- Draft autosave + explicit Publish
- structured flow + graph escape hatch
- trigger/query/action Capability
- state / wait / retry / cancellation

### WebUI

- Browser Cordis Runtime
- Vue-based Koishi-style WebUI infrastructure is preferred
- Schema-driven UI
- Automation-oriented Workbench
- Desktop-first full editor

### Product

一级：

```text
Home / Automations / Runs / Connections / Plugins / System
```

## 2. V1 明确不做

- 多节点分布式 Scheduler
- CRDT / realtime multi-user Automation editing
- Enterprise RBAC
- Workspace / Team full model
- Plugin process sandbox / hard isolation
- Arbitrary scripting/eval
- Secret reveal
- Full Metrics/Prometheus platform
- Full mobile Canvas editing
- Complex quota/accounting
- Automatic semantic rollback of user config/revision

## 3. 已留接口但后置

- Workspace / Team Authorization Provider
- API Token / OIDC / WebAuthn
- Vault / 1Password / KMS CredentialStore
- Remote ResourceStore / migration
- NativeBackend / RemoteBackend
- Marketplace trust/signature/verified program
- Plugin sandbox / permissions
- Distributed scheduler
- collaborative editor

## 4. 仍需后续正式决定的问题

这些问题不会阻止开始核心开发，但应在相应模块实现前定稿。

### 4.1 npm organization / scope 与仓库命名

框架名称 **Numen 已冻结**。仍需确认的是实际 npm organization/scope 是否可用，以及官方仓库命名。

本文档暂用逻辑占位：

```text
@numen/core
@numen/plugin-xxx
```

社区插件通用命名建议已经明确：

```text
numen-plugin-xxx
@scope/numen-plugin-xxx
```

`@numen/*` 目前仅表示 Numen 官方逻辑包名，不代表 npm scope 已最终占用。

### 4.2 Config 具体格式

当前倾向 YAML-first，需要最终定：

- 主文件名
- JSON 是否正式支持
- executable JS config 是否保留只读兼容
- env interpolation 语法

### 4.3 Database library / migration framework

需要根据 Cordis 生态和 SQLite 选型决定具体实现。

### 4.4 Frontend component foundation

架构倾向 Vue + Koishi-style client runtime，但还需选定：

- Element Plus 是否继续沿用
- 是否建立更轻的自有组件层
- Canvas renderer library / 自研程度

### 4.5 Core UI visual tokens

需通过实际视觉稿确定：

- font family
- accent color
- surface hierarchy
- dark/light theme tokens
- icons

### 4.6 Automation import/export format

需要明确：

- public schema version
- unresolved Connection binding representation
- presentation metadata 是否默认包含

### 4.7 Credential Master Key bootstrap

需要确定本地默认体验：

- 首次生成到独立 key file？
- env-only？
- OS keychain provider？

### 4.8 Plugin trust model

V1 允许 trusted arbitrary Node plugins，但 Marketplace UI 是否明确标记：

- official / verified / community
- insecure/native/network/file access expectations

### 4.9 Numen Core Update Strategy

插件更新已有 Installer 参考；Core App 自更新是否由 CLI/容器/外部 supervisor 负责仍需定。

## 5. 推荐开发顺序

```text
1. Host + Loader + Config + SQLite
2. Console/Server minimal runtime
3. Contract registries (Capability/Connection/etc.)
4. Credential + Resource
5. Revision/Compiler/Core IR
6. Scheduler + Run Journal + Recovery
7. Trigger + Wait + State
8. Connection runtime/adapters
9. WebUI Client/Console RPC/Schema UI
10. Automation Editor
11. Marketplace/Installer
12. Diagnostics/Recovery UX
13. Product polish / mobile degradation
```

## 6. 架构冻结建议

当前已经足够进入实现。后续新需求默认遵循：

1. 先判断是否已有 Cordis/Koishi/Cordiverse 参考实现。
2. 先判断它是 Runtime Infrastructure 还是 Automation Domain。
3. Runtime Infrastructure 优先复用现有生态模式。
4. Domain 新概念才定义新的稳定 Contract/Protocol。
5. 不因为 UI 方便破坏持久化和安全边界。
