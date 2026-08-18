# 11. Numen Recovery、Diagnostics、Developer Tools

> 本文定义 Numen 在插件化 Runtime 发生故障时的恢复、解释与开发者观测能力。

## 1. 三层职责

```text
Recovery
系统坏了怎么救

Diagnostics
现在为什么不正常

Developer Tools
Runtime 实际长什么样
```

三者共享事实，但不混成一套功能。

## 2. Diagnostics 不是第二份状态

Diagnostic Provider 只读取：

- Cordis Registry/Fiber
- Loader Runtime
- ConnectionService
- AutomationService
- Scheduler
- ResourceService

并生成结构化 projection。

## 3. DiagnosticIssue

```ts
interface DiagnosticIssue {
  source: DiagnosticSourceRef
  severity: 'info' | 'warning' | 'error' | 'critical'
  code: string
  message: string
  details?: ConsoleValue
  observedAt: string
  related?: DiagnosticSourceRef[]
}
```

复用各 Domain 原本 Issue Code，不发明第二套错误枚举。

## 4. Explain Why

Dependency Resolver 提供解释树：

```text
Automation NOT_READY
└ Step Send Message
  └ Capability telegram:send
    └ Connection Personal Bot
      └ Adapter telegram
        └ Plugin disabled
```

同一个 Explain API 被 Automation、Run、Connection、Diagnostics 共用。

## 5. Diagnostics 首页

优先 Domain Health：

```text
Database
Scheduler
Credential Store
Resource Stores
Plugins
Connections
Automations
Runs
```

CPU/RAM/Uptime 是次级系统指标。

## 6. Logs

结构化日志自动关联：

```text
plugin path
connectionId
runId
executionId
attemptId
traceId
```

通过 Runtime/Invocation Context 自动注入，不要求插件作者每次手写。

### 6.1 Logs ≠ Journal ≠ Audit

| 系统 | 回答的问题 |
|---|---|
| Diagnostics | 现在有什么问题、为什么 |
| Logs | 内部代码发生了什么 |
| Audit | 谁改变了系统定义 |
| Run Journal | 某次 Automation 语义执行发生了什么 |

## 7. Developer Tools

建议页面：

```text
Runtime
Contracts
Connections
Scheduler
Triggers & Waits
Resources
Console
HMR
```

### 7.1 Cordis Runtime Inspector

展示：

- Loader path
- Runtime UID
- Scope status
- Fork children
- required/optional inject
- provided services/contracts

只使用 Cordis 公共 Reflection/Registry API。

### 7.2 Contract Registry Inspector

查看：

- Capability definition/provider
- Trigger/Control
- Connection Type/Adapter
- Credential Type
- Resource Store
- Schema Renderer
- Console Procedure/Entry

要明确显示 `Definition PRESENT / Provider MISSING`。

### 7.3 Scheduler Inspector

分别显示 durable truth 与 in-memory acceleration；两者不一致本身产生诊断。

## 8. Recovery Plane

Recovery 不能完全依赖正常 Application Plugin Tree。

最低层：CLI。

推荐层级：

```text
Normal Console
→ Recovery Console
→ CLI
→ manual filesystem/config
```

## 9. Safe Mode

`--safe` / env flag。

Safe Mode：

- 不修改用户 Config
- 通过 runtime overlay 只启动最小恢复栈
- 默认停掉第三方 integrations
- 默认不启动 Automation triggers/dispatch

最小栈：

```text
Loader
Logger
Server
Minimal Console
Config Manager
Auth
Diagnostics
optional Installer
```

## 10. Support Bundle

默认包含：

- app/node/os versions
- plugin versions
- sanitized config structure
- current diagnostics
- recent sanitized logs
- runtime summaries

默认排除：

- Secret / ciphertext
- Resource bytes
- Run input/output
- personal message/http bodies

导出前提供内容 Preview。

## 11. Developer Mode

只解锁高级观察 UI，不解锁：

- Secret reveal
- arbitrary SQL
- arbitrary Service invocation
- remote Node REPL
