# 03. Numen Automation Source、Control、Core IR、Expression

> 本文描述 Numen 面向人的 Automation Source Language、稳定 Core IR 与纯表达式模型。

## 1. Automation Source

人类可编辑语义层，保存用户意图，不直接执行。

```ts
interface AutomationSource {
  triggers: TriggerSource[]
  flow: ControlSource
  policy?: AutomationPolicy
}
```

## 2. Control Source

首批 Control：

- Capability Step
- Block / Sequence
- If / Switch
- ForEach / Loop
- Parallel / Race
- Wait
- Try / Catch / Finally
- Call
- Return / Stop / Fail
- Eval / Assign
- Graph Escape Hatch
- Extension Control

### 2.1 Block

Block 是：

- lexical scope
- output boundary
- structured composition container

规则：

- child 可读 parent
- sibling 默认隔离
- 输出通过显式 Block output 暴露

## 3. Extension Control

插件可通过 Cordis Effect 注册 Control Definition / Compiler：

```text
defineControl()
```

Compiler 必须：

- deterministic
- pure
- no network
- no credentials
- no business side effects

Publish 时将高层 Control 降低为 Core IR。

历史 Revision 执行不需要原 Control Plugin 继续存在。

## 4. Core IR

Core IR 是稳定、窄、JSON 可序列化的执行语言。

建议指令：

```text
Invoke
Eval
Branch
Fork
Join
Iterate
Suspend
Call
Complete
Fail
```

约束：

- 不持有 Plugin JS object
- 不包含任意函数
- instruction ID 稳定
- 保留 source mapping

## 5. Structured Source vs Graph

默认 Source 是结构化程序，不是任意 DAG。

Raw Graph 作为显式高级 Control：

- 默认 DAG
- cycle 只允许通过明确 Loop/Graph 规则
- 不让整个系统退化成不可解释 edge graph

## 6. ValueExpr

所有表达式使用统一结构：

```text
Literal
Ref
Array
Object
Template
Call
```

运行时值限制为 JSON-ish + ResourceRef：

- string / number / boolean / null
- array / object
- ResourceRef
- 不允许 Date/Buffer/Map/Set/class/function/stream

## 7. Reference

稳定 Ref 不依赖显示名：

```text
run.*
trigger.*
input.*
steps.<stableStepId>.*
vars.*
loop.*
error.*
```

Rename 仅影响 UI label，不影响 Ref。

## 8. Expression 安全边界

不允许：

- `eval`
- arbitrary JS function
- require/process/global
- network
- state mutation
- credential access

表达式只读当前 Run Context。

## 9. 类型系统

Schemastery 用于：

- Capability input/output schema
- Ref 类型推断
- Branch 条件检查
- Template/Expression 目标类型检查

禁止大量隐式 coercion；转换使用显式函数。

## 10. 非确定性

时间、随机数、外部查询等非确定操作必须通过显式 Instruction/Capability materialize，避免恢复时重新计算出不同结果。
