# 13. Numen 工程落地与运维约定

> 本文补齐此前架构讨论较少涉及、但进入实现阶段必须明确的工程问题。它们不改变前面的协议边界。

## 1. 数据库与迁移

### 1.1 原则

- DB 是 Durable Domain Truth
- Schema Migration 必须可版本化、可检测、可中止
- 不允许插件在启动过程中任意破坏 Core schema

建议：

```text
Core migrations
Plugin-owned migrations
```

插件 migration 绑定 package/plugin schema version，但执行由统一 MigrationService 排序与记录。

### 1.2 升级失败

Numen Core 升级后 migration 失败：

- 停止进入正常 Runtime
- 进入 Recovery / CLI doctor
- 不继续启动 Trigger/Scheduler
- 不自动执行 destructive rollback migration

## 2. Backup / Restore

至少定义“可恢复系统”的一致性边界：

```text
DB
Config
Master-key reference / external secret-store metadata
Resource Store (if local)
package.json + lockfile
```

Credential Master Key 不应被普通 support bundle 包含；正式 Backup 流程需明确单独保护。

V1 可以优先提供：

```text
numen backup
numen restore
```

或文档化冷备方案。

## 3. Numen Core Upgrade / Rollback

Package Installer 管插件；App Core 升级是另一条路径。

升级前建议保存：

- current Numen version
- package manifest / lockfile
- config snapshot
- DB backup checkpoint

程序文件 rollback 与 DB migration rollback 是不同问题；如果 DB 已进行不可逆 migration，不能假装降二进制即可回退。

## 4. 插件 SDK

建议形成稳定的逻辑包边界（本文档以 `@numen/*` 作为占位，实际 npm scope 尚未冻结）：

```text
@numen/core
@numen/plugin-sdk
@numen/client
@numen/components
@numen/testing
```

第三方插件避免 import 深层内部路径。

只从 public export surface 使用：

- Capability definitions
- Connection/Adapter APIs
- Console extension SDK
- Schema UI
- Testing harness

## 5. Plugin Build

Build Tool 负责：

- backend TS build
- frontend Vite library build
- external shared runtime deps
- manifest extraction/generation
- source maps
- contract static checks

Browser shared deps（Vue/Cordis/Router/Client SDK）由 Host 提供，插件不要重复 bundle。

## 6. Testing Strategy

### 6.1 Contract Tests

每个 Capability/Adapter/Control：

- schema serialization
- definition/provider registration
- duplicate conflict
- HMR dispose/re-register

### 6.2 Scheduler Deterministic Tests

重点测试：

- crash between TX1 and external result
- safe/unsafe retry
- timer recovery
- wait resume race
- cancellation recovery
- parallel/race/foreach
- generation fencing

建议大量使用 deterministic fake clock + fake provider。

### 6.3 Integration Tests

建立真实 Cordis Context + SQLite temp DB：

```text
load plugin
publish automation
activate
emit trigger
execute
restart process/runtime
recover
assert durable truth
```

### 6.4 WebUI Tests

重点：

- Frontend Entry lifecycle
- schema renderer fallback
- reconnect preserving editor document
- draft conflict
- extension HMR rollback
- permission projection != server authorization

## 7. Package / Config Compatibility

需要记录几个独立版本：

```text
Numen Version
Cordis Version
Plugin SDK Version
Automation Protocol Version
IR Version
Console API Version
Schema/Contract Version
```

不要用单个 package semver 代替所有兼容性判断。

## 8. Data Retention

V1 先配置基础 retention：

- logs
- completed run history
- resource GC grace
- support bundle temp files

Run Journal 与 Audit 的 retention 以后可独立配置。

## 9. Import / Export

建议把 Automation portability 定成稳定能力，但 V1 可先只实现：

```text
Export Automation Source + presentation
Import as Draft
```

不默认导出：

- Credential secret
- concrete Connection binding secret material
- Resource bytes

ConnectionRef import 时允许变成 unresolved binding，由用户重新选择。

## 10. Deployment

首选单进程 Node + SQLite 的 V1：

```text
numen-data/
├ config.yml
├ numen.db
├ resources/
├ logs/
└ backups/
```

Master Key 推荐来自：

- environment
- external secret file with restrictive permissions
- future Vault provider

Docker 只是一种 Host 包装，不改变应用内部 Runtime 模型。

## 11. Filesystem Safety

任何持久文件写入：

- temp + fsync/rename where appropriate
- 明确权限
- 不把 secret 写日志
- Support Bundle 路径与 Resource Store 隔离

## 12. Performance Baseline

V1 不提前为多节点分布式 Scheduler 设计复杂协议。

先测：

- scheduler throughput
- idle memory
- number of active connections
- trigger subscriptions
- run journal volume
- frontend large-flow rendering

只有基准显示单 Node runtime 是瓶颈时，再考虑 NativeBackend/RemoteBackend 或进程隔离。
