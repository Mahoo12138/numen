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

### 2.1 Docker 冷备

当前 MVP 使用 SQLite，因此备份以停止写入后的整个数据目录为一致性边界：

```bash
mkdir -p backups
docker compose stop numen
docker compose cp numen:/var/lib/numen ./backups/numen-data
docker compose start numen
```

备份完成后必须确认服务恢复健康：

```bash
curl --fail http://127.0.0.1:5140/api/ready
```

`.env` 中的 `NUMEN_MASTER_KEY` 必须通过独立的 secret backup 保存，不能和普通
support bundle 一起分发。只恢复数据库而没有恢复原 Master Key，会使已有 Credential
无法解密。

恢复必须在 Numen 停止时进行，并以空的新数据卷或已明确归档的旧数据卷为目标；不要
把两个时间点的 `numen.db` 与 `resources/` 混合。恢复后先执行 readiness 和一次手动
Run，再重新开放自动 Trigger。

## 3. Numen Core Upgrade / Rollback

Package Installer 管插件；App Core 升级是另一条路径。

升级前建议保存：

- current Numen version
- package manifest / lockfile
- config snapshot
- DB backup checkpoint

程序文件 rollback 与 DB migration rollback 是不同问题；如果 DB 已进行不可逆 migration，不能假装降二进制即可回退。

Docker 部署的最小升级流程：

1. 记录当前 Git revision / image digest，并完成冷备。
2. 拉取目标 revision，执行 `docker compose build --pull`。
3. 执行 `docker compose up -d`，等待 `/api/ready` 返回 200。
4. 检查最近一次定时 Run；失败时保留数据卷和日志，不自动回滚数据库。

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

### 10.1 Compose first-run

仓库根目录的 `Dockerfile` 使用 Node 24 LTS 构建 Runtime 与 Workbench，`compose.yml`
运行单个 Numen 进程。容器内固定路径为：

```text
/etc/numen/numen.config.yml   # image-owned deployment config
/var/lib/numen/numen.db       # named volume
/var/lib/numen/resources/     # named volume
```

首次部署：

```bash
docker build -t numen:local .
cp .env.example .env
docker run --rm numen:local key generate
# 将输出写入 .env 的 NUMEN_MASTER_KEY
docker compose up --build -d
docker compose logs numen
```

启动日志中的 Workbench URL 含有 fragment-only bootstrap token，应按 secret 处理，
不要粘贴到工单或共享日志。Compose 默认只绑定 `127.0.0.1`；远程访问应通过具备 TLS
与访问控制的反向代理或 SSH tunnel，不应直接把 5140 暴露到公网。

首启后可以用以下命令验证：

```bash
curl --fail http://127.0.0.1:5140/api/health
curl --fail http://127.0.0.1:5140/api/ready
docker compose exec numen node packages/cli/dist/bin.js doctor \
  --config /etc/numen/numen.config.yml
```

`NUMEN_HTTP_PROXY` 是所有 Integration 出站请求的统一代理入口；支持 HTTP(S) URL，
安装了 `httpSocks` 时也支持 SOCKS URL。容器访问宿主机代理时可以使用
`host.docker.internal`；Compose 已把该名称映射到宿主机 gateway。

需要直连 NAS 或 Home Assistant 时，在 `.env` 中设置
`NO_PROXY=localhost,127.0.0.1,::1,host.docker.internal,.home.arpa`，按实际主机增删。
开发与发布 Compose 都将此值传入容器；未定义大写变量时兼容 `no_proxy`。
地址规则见 [出站 HTTP Contract](16-outbound-http-proxy.md#31-直连例外no_proxy)。
环境值在启动时固定，修改 `.env` 后执行 `docker compose up -d` 重建容器配置。

### 10.2 生产约束

- 同一个 SQLite 数据卷只运行一个 Numen 实例。
- Master Key 必须是 Base64 编码的 32 字节随机值，生成后保持稳定。
- `/api/health` 用于进程存活；`/api/ready` 用于接流量与升级验证。
- 修改容器内配置应构建新 image，或显式挂载一份受版本控制的完整配置；不要在运行中编辑 image 文件。

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
