# 09. Numen Automation Editor Architecture

> 本文描述 Numen Workbench 中面向 Structured Automation Source 的核心编辑体验。

## 1. 核心原则

> Draft Source 是唯一业务真相；Canvas、Inspector、Variable、Problems 都是 Source 的投影。

不要维护 `nodes[]/edges[]` 与 Source 两套 authoritative state。

## 2. Editor Document

```text
Automation Draft
  ↓
Editor Document
├ Source Tree
├ Presentation Metadata
├ Selection / Focus
├ Undo/Redo
└ Diagnostics
```

## 3. Structured Flow

视觉上仍可像 node flow，但持久语义是 Structured Source。

```text
Trigger
  ↓
Get Weather
  ↓
If
├ true → Notify
└ false → Ignore
```

内部是 Block/If tree。

## 4. Control Flow vs Data Flow

- Control Flow：Canvas 结构/连线
- Data Flow：默认用 Field Ref / Magic Variable，不画满数据线

可提供“Show Data Dependencies”辅助视图。

## 5. Trigger UI

Trigger 位于顶层 `When` 区域；多个 Trigger 语义为 OR。

Trigger Inspector：

- config schema
- connection binding
- filter
- debounce/throttle

## 6. Palette

Palette 由 Capability Registry + Control Registry 自动生成。

默认使用 Quick Picker，不永久占用 300px 节点库。

搜索直接搜索“能力”：

```text
send message
→ Telegram / Discord / Email capabilities
```

## 7. Node UI

Canvas Node 默认自动生成：

- provider icon/name
- capability name
- connection summary
- validation/runtime status

复杂配置放 Inspector，不塞进 Node。

## 8. Inspector

Core Shell：

```text
Connection
Input (Schema UI)
Execution Policy
Diagnostics
Extension Slots
```

Connection binding 与 input value 分离。

## 9. Magic Variables

Variable Picker 来源：

```text
trigger
input
steps
vars
loop
error
```

Ref 存稳定 ID，UI 显示 friendly name。

Picker 做静态类型过滤与转换建议。

## 10. Value Mode

统一 Field Shell：

```text
Literal
Template / Reference
Expression
```

String 可把 Template 做成 inline magic-variable experience。

Expression Editor parse/print 到结构化 AST，不执行任意 JS。

## 11. Control Container

If / ForEach / Parallel / Try 更适合作为 Container Node。

支持：

- collapse
- expand
- enter block / focus scope
- breadcrumb

Variable Picker 根据当前 lexical scope 变化。

## 12. Unknown Extension

Control/Renderer Plugin 缺失：

- Source 原样保留
- 显示 Unknown Control
- 允许查看/移动/删除
- Publish 因 compile dependency missing 被阻止

## 13. Presentation Metadata

节点：

```text
x/y
collapsed
width
```

与 Source semantics 分离。

Workbench sidebar width 等更不属于 Automation Draft。

## 14. Autosave / Publish

```text
local edit
→ debounce autosave Draft
→ saved

Publish
→ authoritative server validation
→ new Revision
→ optional Activate
```

UI 必须区分 Saved 与 Published。

## 15. Draft Conflict

optimistic version；多 Tab 修改发生冲突时：

- Reload
- Compare
- Save as copy / explicit overwrite

V1 不做 CRDT 自动合并。

## 16. Reconnect

WebSocket 断线时保留：

- local document
- undo stack
- selection
- viewport

恢复后检查 server draft version，再继续 autosave 或进入 conflict flow。

## 17. Problems

Server Diagnostic 带 `sourceRef(nodeId, fieldPath)`。

同一 Issue 投影到：

- Node badge
- Inspector field
- Problems Panel

点击可定位节点与字段。

## 18. Run Inspector 复用 Canvas

Run View 打开 pinned immutable Revision，Canvas 只读并 overlay：

```text
COMPLETED
RUNNING
WAITING
BLOCKED
FAILED
```

Panel 提供 Timeline / Context / Logs。
