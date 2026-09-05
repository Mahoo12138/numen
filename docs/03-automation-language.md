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

`ControlRegistry` 由 Runtime 的 `controls` 插件提供。`coreControls` 插件通过同一 Registry 注册 Wait、If、Parallel、Race、ForEach 的目录定义；这些核心语法的编译实现仍属于 Core IR 编译器。

扩展插件声明 `inject = ['controls']`，并通过 Cordis Effect 注册版本化定义：

```ts
ctx.controls.defineControl(ctx, {
  kind: 'extension',
  id: 'example:pause',
  version: 1,
  title: 'Pause',
  description: 'A durable pause.',
  input: z.object({ milliseconds: z.number().min(0).required() }),
  lower: ({ nodeId, input }) => ({
    type: 'wait',
    id: nodeId,
    durationMs: input.milliseconds!,
  }),
})
```

Source 保存版本化引用和表达式，不保存编译函数：

```json
{
  "type": "extension",
  "id": "pause",
  "control": { "id": "example:pause", "version": 1 },
  "input": { "milliseconds": { "type": "literal", "value": 1000 } }
}
```

Publish 验证输入契约后，将冻结的表达式副本传给同步 `lower`。函数返回已有核心 Control 树，再由核心编译器生成 IR。返回树必须为 JSON 数据，根 ID 必须等于 `nodeId`，子 ID 必须以 `${nodeId}.` 开头；禁止嵌套扩展，最多 256 个 Control、20,000 个 JSON 值、64 层数据深度。非法返回或异常产生指向原 Source 节点的 `CONTROL_LOWER_FAILED`，不会暴露插件异常内容。核心编译诊断同样映射回原节点。

Compiler 的插件契约要求确定性、纯计算、不访问网络或 Credential、不产生业务副作用。接口不提供 Context 或运行时服务；当前插件仍是可信进程内代码，这不是 JavaScript sandbox，也不会自动证明纯度。

Revision 的 Dependency Manifest 和 Contract Snapshot 保存使用过的 Control 版本及输入契约，Core Plan 的 `sourceMap` 将生成指令关联到原 Source 节点。历史 Revision 直接执行持久化 Core IR，不需要原 Control Plugin 继续存在；其依赖的 Capability Provider 和 Connection 仍需满足运行条件。卸载编译插件会使新的 Publish 返回 `CONTROL_UNAVAILABLE`，Draft 保持原样。

当前扩展 Source 是带表达式输入的叶节点，`lower` 可以生成结构化核心控制树。用户编排的命名 body/branch 插槽、扩展输出契约和对应 Magic Variable 输出目录尚未实现。

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
