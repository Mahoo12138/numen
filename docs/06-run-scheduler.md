# 06. Numen Run、Execution、Attempt 与 Scheduler

> 本文描述 Numen 的耐久执行模型；数据库是 Run/Execution/Attempt 的事实来源。

## 1. 持久实体

```text
Run
Execution
Attempt
Scope / Variable
RunEvent
```

不要用单个 `currentNode` 表示执行位置。

## 2. Run

Run 是一次逻辑执行。

状态可包括：

```text
QUEUED
RUNNING
WAITING/BLOCKED derived by children
COMPLETED
FAILED
CANCELLING
CANCELLED
```

## 3. Execution

Execution 对应计划中的一个稳定执行单元。

建议状态：

```text
RUNNABLE
RUNNING
WAITING
BLOCKED
COMPLETED
FAILED
CANCELLING
CANCELLED
TIMED_OUT
```

## 4. Attempt

Retry 不创建新 Execution，而创建新的 Attempt。

Attempt 状态：

```text
SUCCEEDED
FAILED
TIMED_OUT
ABORTED
INTERRUPTED
OUTCOME_UNKNOWN
```

## 5. 调用事务边界

外部 Capability 调用前：

```text
TX1
RUNNABLE → RUNNING
freeze resolved_input
create Attempt
append journal
commit
```

调用 Provider。

成功后：

```text
TX2
validate output
complete attempt/execution
commit Resource Owners
create successors
append journal
update run status
commit
```

然后才发非耐久 Cordis runtime event。

## 6. Crash Recovery

进程崩溃后发现 Attempt 仍 RUNNING：

- 明确安全重试 → INTERRUPTED + new attempt
- 外部结果不确定且非幂等 → `OUTCOME_UNKNOWN`，Execution BLOCKED

不猜测外部调用是否成功。

## 7. Timers

耐久 timer 保存绝对 `wake_at`。

启动时查询 due waits，而不是依赖历史 `setTimeout()`。

## 8. Scheduler

数据库是 sole durable truth。

内存：

- ready index
- reverse dependency index
- short-lived queue

都只是 acceleration。

采用：

- event-driven dispatcher
- periodic consistency sweep

## 9. Concurrency / Admission

Automation Policy：

```text
groupBy
maxActive
overflow = queue | drop | replace
```

`groupBy` 只读取 trigger/input，Run 接收时冻结。

QUEUED = 已接受但未获取 permit。

WAITING/BLOCKED 的 admitted Run 默认继续占 permit，避免绕过 maxActive。

## 10. Structured Concurrency

Scope Tree 管理：

- parent/child execution
- Parallel
- Race
- ForEach
- Try/Finally

默认：

- Parallel all: fail-fast
- Race: first-success / configured winner
- ForEach: fail-fast + window concurrency

## 11. Cancellation

取消先耐久记录 intent：

```text
RUNNING → CANCELLING
```

再传播：

- abort active invocation
- remove waits
- cancel children
- run finalizers

进程重启后能继续取消流程。

Abort reason 包括：

```text
USER
PARENT
RACE
TIMEOUT
PROVIDER_DISPOSED
CONNECTION_DISPOSED
RECONFIGURED
SHUTDOWN
CREDENTIAL_ROTATED
```

## 12. Run Context

持久可重建 bindings：

```text
run.*
trigger.*
input.*
steps.*
vars.*
loop.*
error.*
```

Secrets 不进入 Context。

## 13. Journal

RunEvent append-only，严格 sequence。

它描述语义执行事实，不替代 Logs。

```text
ExecutionStarted
AttemptFailed
ExecutionBlocked
RunCompleted
...
```

Retry = same Run/new Attempt；Run Again = new Run。
