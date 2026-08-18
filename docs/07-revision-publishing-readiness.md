# 07. Numen Draft、Revision、Publish、Activation、Readiness

> 本文描述 Numen 中“可编辑意图”到“不可变可执行 Revision”的发布与激活边界。

## 1. Automation Shell

```ts
interface Automation {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
}
```

Automation 是稳定 identity。

## 2. Draft

V1 一个 mutable Draft：

```ts
interface AutomationDraft {
  automationId: string
  baseRevisionId?: string
  source: AutomationSource
  version: number
}
```

- optimistic version/etag
- 可保存 invalid/incomplete/unresolved 状态
- Save ≠ Publish

## 3. Revision

Revision immutable：

```ts
interface AutomationRevision {
  id: string
  automationId: string
  number: number
  protocolVersion: number
  source: AutomationSource
  irVersion: number
  compiledPlan: CorePlan
  dependencyManifest: DependencyManifest
  contractSnapshot: ContractSnapshot
  contentHash: string
}
```

执行历史 Revision 直接读取存储的 `compiledPlan`，不重新编译 Source。

## 4. Contract Snapshot

保存：

- serialized Schemastery schemas
- capability refs
- connection requirements
- semantics
- hashes
- minimal presentation metadata

用于历史查看/调试，不替代 Runtime Provider。

## 5. Publish Pipeline

```text
Source structural validation
→ resolve compile-time control/expr extensions
→ resolve runtime contracts
→ schema/static type checks
→ connection compatibility checks
→ lower to Core IR
→ IR verify
→ dependency manifest
→ contract snapshot
→ content hash
→ persist immutable Revision
```

Publish 要求 Contract 可解析，但不要求外部系统此刻在线。

因此：

```text
Compile Valid
≠ Runtime Ready
```

## 6. Activate

`publishDraft()` 与 `activateRevision()` 分开。

Activate transaction：

```text
activeRevisionId = revision
activationGeneration++
audit
```

外部 Trigger subscription 不在这个 DB TX 中同步完成。

## 7. Activation Reconciler

Cordis Service：

```text
Desired:
automation.enabled + activeRevisionId

Actual:
trigger subscriptions / dependency runtime
```

状态：

```text
DISABLED
ACTIVATING
READY
NOT_READY
ERROR
```

失败不秘密 rollback desired revision。

## 8. Dependency Manifest

Revision 记录：

- Capability Contract
- Connection requirements
- Trigger providers
- State provider
- Resource-related contracts
- compile-time extension dependencies

Dependency Resolver 维护 reverse index，响应 Cordis Registry / Connection 状态事件，并周期 consistency sweep。

## 9. 当前 Run Readiness

Existing Run 不要求整个 Revision 全部 Ready。

它只检查：

```text
当前可运行 Execution 所需依赖
```

这样未走到的 branch provider 暂时缺失不必阻止当前执行。

## 10. Layout / Presentation

节点坐标等 presentation metadata 可与 Revision 一起 snapshot，但不参与 executable content hash。

区分：

```text
Semantic Dirty
Presentation Dirty
```

仅拖动节点不应制造新的业务 Revision。
