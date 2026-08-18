# 01. Numen Runtime、Loader、HMR、Server、CLI

## 1. Loader 定位

Loader 采用 Koishi 的模型：**Host Bootstrap + Configuration Bridge**，不是数据库驱动的 PluginInstance Reconciler。

```text
Process / CLI
    │
    ▼
Loader
├ Environment
├ Application Config
├ Plugin Resolution
├ Plugin Config Tree
├ Context Creation
├ Load / Reload / Unload
├ Config Writeback
└ Full Process Reload
    │
    ▼
Cordis Runtime
```

### 1.1 配置树

推荐 YAML 为主，可选 JSON。

```yaml
plugins:
  server:
    port: 5140
  automation:
  telegram:abc123:
    ...
  ~github:def456:
    ...
```

约定：

- `plugin-name:ident` 支持同一插件多实例
- `~` 前缀表示 durable disabled
- `$` 前缀保留 meta
- `$if` 可控制条件加载
- `$filter` 可映射到 Cordis Context filter

### 1.2 配置写回

- JSON/YAML 可写
- 写入使用临时文件 + rename
- Runtime Schema normalize/simplify 后再落盘
- executable JS config 可支持但视为只读，不作为 WebUI 可管理的标准路径

## 2. Host Bootstrap

Host 本身尽量薄：

```text
Supervisor
   ↓
Worker
   ↓
new Context()
   ↓
Loader
   ↓
Application Config Tree
```

不要在 `main.ts` 手工初始化所有业务服务。

## 3. HMR

参考 Koishi HMR：HMR 的真正边界是 **Plugin Runtime**，文件只是用于定位受影响 Plugin Entry。

```text
Filesystem Change
      ↓
Module Dependency Analysis
      ↓
Affected Plugin Entries
      ↓
Backup module cache
      ↓
Load new module
   ├ fail → rollback cache
   └ success
      ↓
Dispose old Plugin Runtime
      ↓
Recreate existing Forks with original config
   ├ fail → rollback old runtime
   └ success → commit
```

### 3.1 HMR 不理解 Automation Domain

HMR 不应认识：

- Run
- Execution
- Capability business semantics
- Connection config
- Trigger Binding

它只处理 Module / Plugin / Fork / Loader / Registry。

Automation Domain 响应 Runtime Availability 变化：

```text
Plugin disappears
→ provider unregister
→ current unsafe invocation interrupted
→ affected Execution BLOCKED / INTERRUPTED
→ Dependency Resolver marks not ready

Plugin returns
→ providers register
→ Connections rebuild
→ Triggers rebuild
→ blocked work becomes runnable when safe
```

## 4. Server

优先采用 `@cordisjs/server` 风格：Server 是 Cordis Service，Route/WS Route 是 Effect。

```text
Plugin Fiber alive
→ route exists

Plugin Fiber disposed
→ route automatically removed
```

Console RPC、Resource HTTP、Webhook 等都应建立在 Server Service 上，而不是各自再造 HTTP Runtime。

## 5. CLI / Supervisor

参考 Cordis CLI：

- CLI 可前台启动
- 可由 supervisor/daemon fork worker
- Supervisor 负责 heartbeat、自动重启、退出码解释
- `fullReload` 使用明确退出码触发进程重启

推荐命令能力：

```text
numen start
numen start --safe
numen doctor
numen config validate
numen plugin list
numen plugin disable <key>
numen plugin enable <key>
numen restart
```

## 6. 启动顺序

业务 Runtime 推荐：

```text
Loader/Cordis ready
→ Database / Stores
→ Registries / Definitions
→ Providers
→ Credential Store
→ Connections
→ Dependency Resolver
→ Scheduler Recovery
→ Readiness
→ Trigger subscriptions last
```

Trigger 最后启动，避免系统恢复过程中提前接受新外部事件。
