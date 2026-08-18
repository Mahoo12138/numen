# 04. Numen Capability、Connection、Credential、Resource

> 本文描述 Numen 将外部能力、连接、凭据与耐久资源纳入统一插件运行时的核心 Contract。

## 1. Capability

Capability 是 Automation 可发现、可类型检查、可持久引用的稳定 Contract。

```text
kind = trigger | query | action
```

ID：

```text
<namespace>:<capability-name>
```

版本单独管理：

```ts
{ id, version }
```

Package Version 与 Contract Version 分离。

### 1.1 Definition / Provider

```text
Capability Definition
→ ID / Version / Schema / Semantics

Capability Provider
→ Current Runtime Implementation
```

同 Context 下 V1 默认一个 active provider。

### 1.2 Semantics

Capability Contract 描述：

- side effect / pure-like query
- idempotency
- retry safety
- timeout semantics
- connection slots
- structured errors

## 2. Connection Model

```text
Credential
   ↓
Adapter
   ↓
Connection
   ↓
Capability
   ↓
Automation
```

- Credential：秘密身份材料
- Adapter：如何连接
- Connection：具体持久连接实例
- Capability：连接提供的能力

### 2.1 Connection 持久与运行时分离

Durable：

```text
Connection Config
ConnectionRef
Desired enabled/disabled
```

Ephemeral：

```text
ConnectionRuntime
socket/session/timer/heartbeat
```

每个 Runtime 绑定 Cordis child Fiber/Effect lifecycle。

### 2.2 Connection State

建议：

```text
STOPPED
STARTING
READY
RECONNECTING
ERROR
STOPPING
```

并区分：desired / availability / health / readiness。

Config/Credential 变化使用 stop-and-recreate + generation fencing。

## 3. Credential

Credential 分：

- Durable Metadata
- Encrypted Secret Material

整个 credential payload 加密，不仅是 Schema 标记为 secret 的字段。

DB 至少记录：

```text
ciphertext
nonce
keyId
secretVersion
```

Master Key 不存同一个数据库。

### 3.1 Secret 边界

Secret 永远不进入：

- Automation Source
- Revision / IR
- Run Context
- Run Journal
- Resource Metadata
- Console read API

普通 UI 只显示：

```text
configured / not configured
updatedAt
secretVersion
```

不提供 Reveal。

### 3.2 Runtime Snapshot

Connection open 时读取固定 Secret Snapshot：

```text
secretVersion = N
```

Credential rotation：

```text
N → N+1
→ dependent connections recreate
```

旧 Runtime 不静默切换。

## 4. Resource

Resource 表示持久逻辑数据，不是文件路径。

```json
{ "$resource": "res_xxx" }
```

### 4.1 Resource Service / Store

```text
ResourceService
→ logical ID / metadata / owner / lease / GC

ResourceStore
→ physical bytes only
```

Metadata：

```text
id
name
mediaType
size
digest
createdAt
```

### 4.2 State

```text
STAGED
COMMITTED
DELETING
GONE
```

Capability 输出大对象时：

```text
stream create
→ STAGED
→ return ResourceRef
→ scheduler validates output
→ owner commit atomically
```

异常 staging 依靠 lease expiry + GC 清理。

### 4.3 Owner vs Lease

Owner 决定生命周期：

```text
revision owns resource
draft owns resource
run output owns resource
state owns resource
```

Lease 只保护 runtime 使用期间不被删。

`ResourceRef` 不是 bearer token。HTTP 下载仍需 Principal + Authorization。
