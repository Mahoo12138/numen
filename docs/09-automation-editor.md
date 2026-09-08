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

Palette 由 Capability Registry + Control Registry 自动生成。Control 的注册和卸载通过 `numen/control-change` 使目录失效；核心 Control 目录也由插件注册。扩展条目携带版本化引用和经过投影的输入 Schema，复用 ValueExpr Field Shell、Schema Literal Renderer、自动保存和 Undo/Redo，不把编译函数发送到浏览器。

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
- 当前可查看节点身份，Source 和输入完整保留；恢复相同版本插件后继续编辑。移动/删除仍待 Canvas 结构编辑实现。
- Publish 因 compile dependency missing 被阻止，并定位原 Source 节点
- 已发布 Revision 的 Run Flow 使用契约快照标题和指令 Source Map 聚合执行状态，不依赖实时 Control Registry

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

Autosave 和 Publish 都以 Draft version 做乐观并发检查。收到 `DRAFT_VERSION_CONFLICT` 后，保留当前标签页的完整本地 Source、presentation 与历史，暂停编辑和自动保存，提供 `Compare and recover`：

- Compare 使用已有 Automation detail Query 读取服务器快照，单独保存以避免覆盖本地文档。按 JSON Pointer 比较 Source / presentation 的字段值，明确区分 Local / Server 与缺失字段；可刷新快照，不进行自动合并。
- 比较最多展示 100 项差异、访问 20,000 个不相等的值，单项显示最多 2,000 字符；深度超过 64 层时显示该子树的摘要。被截断时提示限制，另存仍保留完整文档。
- `Save local as copy` 把本地快照保存为用户命名的新 Automation。副本 Draft 从 v1 开始，保留 Source 和 presentation，不继承 Revision、baseRevisionId、enabled 或 activeRevisionId。
- 副本保存请求使用固定 requestId。响应丢失后重试发送完全相同的请求，服务端持久化去重，进程重启后也不会重复创建。相同 requestId 改变内容会被拒绝。成功后显式选择 `Open saved copy`；列表失效或排序变化不会自动切换当前 Automation。
- `Discard local and reload latest` 明确丢弃本标签页本地编辑和历史，再读取最新服务器 Draft；它可能比比较时的快照更新。

V1 不做 CRDT 自动合并或强制覆盖。未另存的本地文档仍只存在于当前页面内存，关闭或刷新浏览器不会持久保留它。异步请求随组件卸载取消，迟到结果不能切换当前 Automation 或覆盖新文档。

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
