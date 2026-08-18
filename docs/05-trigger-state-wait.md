# 05. Numen Trigger、State、Wait / Signal

> 本文描述 Numen 的外部触发、跨 Run 状态以及耐久暂停/恢复模型。

## 1. Trigger

完整链路：

```text
Trigger Capability
→ Trigger Binding in Revision
→ Runtime Subscription Effect
→ Emission
→ Durable Acceptance
→ Run
```

Trigger Definition 描述：

- config schema
- output schema
- connection requirements
- mode: event | state
- activate(ctx, binding, emit)

## 2. Active Revision Ownership

只有 Active Revision 拥有新的 Trigger Subscription。

旧 Revision：

- 已开始 Run 可以继续
- 不再接受新 Trigger

Subscription 标记：

```text
revisionId
activationGeneration
```

`emit()` durable accept 时再次验证 generation，拒绝 stale callback。

## 3. Emission

建议字段：

```text
data
occurredAt
eventId
subject
checkpoint
```

Pipeline：

```text
validate
→ dedupe
→ filter
→ debounce/throttle
→ state transition(optional)
→ concurrency/admission
→ create Run
```

`await emit()` 语义：事件已被数据库耐久接收，而不是仅入内存队列。

## 4. State Trigger

Provider 负责提供 observation，State Trigger Service 检测 transition。

首次启动默认建立 baseline，不产生“startup enter”事件，除非显式配置。

## 5. Automation State

State 是跨 Run 的持久内存，与 `vars.*` 严格分开。

定义：

```text
stateId
schema
contractVersion
default
```

操作：

```text
Read
Set
Delete
Increment
CAS
```

原子性由 StateService/DB 保证。

State 中 ResourceRef 自动形成 Resource Owner。

## 6. Wait / Suspend

`Suspend` 是 Core IR 中的耐久暂停。

Durable：

```text
Wait Registration
```

Ephemeral：

```text
Runtime subscription Effect
```

V1 Resume Source：

- timer
- signal
- event
- child run

## 7. Signal

Signal 是一对一 addressed resume：

- validate payload schema
- dedupe
- atomic resolve one-shot wait
- optional deadline

## 8. Event Wait

可复用 Trigger Infrastructure：

Provider 不在：

```text
WAITING → BLOCKED (WAIT_SOURCE_UNAVAILABLE)
```

Provider 恢复后重建 runtime subscription。

## 9. Approval

Approval 不需要特殊 Scheduler 原语：

```text
Invoke create approval
→ Suspend
→ Branch on result
```

UI 可以提供高层 Approval Control，再编译到上述 IR。

## 10. Race

Race 可由：

```text
Fork waits
→ Join first
→ cancel losers
```

组合。
