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

### 当前 Canvas 结构编辑

结构编辑通过纯 Source commands 完成，复用完整文档 Undo/Redo 与乐观 autosave。当前开发版本直接采用显式目标接口，不保留省略目标的旧插入调用。

```ts
type AutomationInsertTarget =
  | { kind: 'block'; blockId: string; beforeNodeId?: string }
  | { kind: 'triggers'; beforeTriggerId?: string }
  | { kind: 'root'; beforeNodeId?: string }
```

- Block 目标支持指定步骤前插入和追加；步骤后的入口转换为下一个兄弟节点前或 Block 尾部。Quick Picker 打开时捕获目标，执行时重新校验，失效时保持草稿不变并报告错误，不回落根流程。非 Block 根流程使用显式 root 目标扩展为 Block，已有节点 ID 保持不变。
- If 的 then/else、ForEach body、Parallel/Race branch 都有容器内插入入口和空状态。If 可添加/移除 else；Parallel/Race 至少保留两个分支。必需的结构插槽只能清空内容，不能作为普通步骤删除或移动。删除非空分支和清空容器先说明影响，再以一次操作执行。
- Trigger 保持顶层 OR 语义，支持插入、排序、复制和删除，不可移入普通 flow。
- 同容器排序、跨 Block 移动和剪切粘贴保持整个子树的 ID、表达式、Connection bindings 与执行策略。移动到自身后代、失效位置或错误类型的容器均被拒绝。剪切只记录待移动节点，成功粘贴后才修改 Source；节点删除或重新加载时清除待剪切状态。
- 复制捕获 Source 与 Presentation 快照。粘贴为整棵子树分配新 ID，仅改写已识别 ValueExpr 中指向副本内部的引用；普通字面量与外部引用保持原值。含点 ID、重复 ID、不可解析引用或扩展载荷无法证明安全时禁用复制并说明限制。复制副本不依赖原节点继续存在。
- ID 分配同时避开现存节点和仍被引用的节点 ID，防止悬空引用静默绑定到新节点。删除非 Block 根流程使用新 ID 的空 Block，旧根引用仍保持失效。
- 跨作用域移动不重新绑定表达式；Publish 运行权威编译校验，Problems 定位到原 Source 节点和字段。
- 每次变更使用同一份 Source、Presentation 和选择状态历史；Undo/Redo 恢复整棵子树和折叠状态，保存中的继续编辑不会被迟到响应覆盖。冲突恢复、重新加载和 Publish 期间禁用结构编辑。

Canvas 显示分支和循环体的归属，支持折叠/展开。Outline 与 Problems 选择展开祖先容器，并滚动定位对应节点。可编辑时折叠状态保存在 Draft Presentation 中，刷新后恢复；复制容器映射其折叠状态，删除时清理被移除节点的折叠记录。归档或冲突等只读状态下，折叠/展开和大纲定位只改变当前视图，不保存 Presentation，也不解除编辑限制。

拖拽尚未实现；目前通过菜单、明确目标和容器内入口操作。工具栏只保留已经接通的操作。

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

字段展示默认值、必填、说明、Provider/Connection 可用性以及编译诊断。Literal 的字符串、数字、Duration、日期和 JSON，以及 Reference/Template 的临时文本保留在字段组件中；格式、范围或步进错误不会写回 Source。修正后的值通过现有 Source command 提交。切换字段模式、节点、页签或执行会替换输入的命令前，若仍有未提交内容，需要明确选择保留或丢弃；丢弃会恢复当前 Draft 值，不只清除提示。

Execution Policy 仅编辑 Runtime 支持的 `timeoutMs`、`retry.maxAttempts` 与 `retry.backoffMs`，解释默认超时、总尝试次数和退避。Capability 未声明 `retrySafe` 时不提供新增重试配置；已有不安全重试可移除。Compiler 和 Runtime 仍负责最终校验，编辑器不提供“失败后继续”等未实现语义。

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

变量候选保留来源节点 ID 和类型；尚不可用或不兼容的候选显示原因并禁用选择，避免静默消失。来源和选择都基于当前 Draft 的结构作用域，不使用运行时数据猜测引用。

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
- 当前可查看节点身份，Source 和输入完整保留；恢复相同版本插件后继续编辑。作为序列成员的 Unknown Control 支持排序、跨容器移动和整节点删除，不依赖插件定义。复制所有扩展 Control 暂不可用，因为客户端命令层没有可证明其内部引用语义的契约。
- Publish 因 compile dependency missing 被阻止，并定位原 Source 节点
- 已发布 Revision 的 Run Flow 使用契约快照标题和指令 Source Map 聚合执行状态，不依赖实时 Control Registry

## 13. Presentation Metadata

当前结构视图使用 `presentation.collapsedNodes: string[]` 保存折叠节点 ID。编辑器仅转换它拥有的 Presentation 字段，其余字段原样保留；不维护第二套节点或连线模型。

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

### 按需查看执行数据

Execution/Attempt 行可显式打开 `numen:execution-data@1`。查询按 Run、Execution 和可选 Attempt 校验归属，只返回该 Execution 当前耐久输入输出；Attempt 链接不声称拥有独立的历史 I/O 快照。有效 Source 节点可与 Execution 列表双向定位，Runtime 内部指令不展示无效定位入口。

可显示数据来自该 Run 固定 Revision 的契约快照，字段须显式标记 `schema.extra('extra', { numen: { execution: 'public' } })`。仅允许匹配 Schema 的标量叶子；容器不会继承公开权限。secret/password/resource 角色、敏感标记、Credential/Authorization/Cookie 等已知敏感字段优先隐藏；未知字段、无分类契约、自由字典和 ResourceRef 不展开。HTTP 内置契约只开放 method、timeoutMs、ok、status、bodyType，URL、Headers 和 Body 保持隐藏。插件作者应仅将确定可公开查看的字段标记为 public。

每侧耐久 JSON 在 SQL 读取阶段限 64 KiB；投影限制深度 6、节点 128、数组 20 项、字符串 1024 字符、文本累计 8 KiB、每侧序列化 10 KiB、整个响应 24 KiB。接口要求认证并使用 `Cache-Control: no-store`；文本只在当前面板内按纯文本渲染，关闭或切换 Run 后丢弃并忽略迟到响应。数据不进入 URL、localStorage、全局日志或 HTML 注入路径；解析异常返回固定错误，不透传耐久数据片段。

### 文档状态与离开保护

顶部独立展示 Draft 版本及保存状态、最新发布版本、活动版本和 enabled 意图；Trigger 实际订阅健康另行显示，并校验激活代次，不能把 enabled 等同于已就绪。Trigger 服务缺失或卸载不阻塞 Draft 的查询和编辑。

字段尚未提交时，状态栏明确显示本地输入状态，不将其称为已保存。合法聚焦输入在发布、归档前先提交并等待 Draft 保存；非法输入阻止发布/归档。切换 Automation、应用路由、浏览器前进/后退或关闭页面时，未提交字段和 DIRTY/SAVING/ERROR/CONFLICT 文档均受到保护。取消导航保留原文档和浏览器历史位置；确认丢弃后重新进入读取耐久 Draft。页签或节点切换只处理受影响的本地字段，已进入 Source 的编辑继续使用现有自动保存与撤销历史。浏览器不维护第二份 Draft 存储。

## Automation 输入和手动运行

Settings 的 Automation inputs 表单编辑 Draft 的输入名称、类型、标签、说明、必填和默认值。修改通过 `SET_AUTOMATION_INPUTS` 命令进入完整文档历史，复用 Undo/Redo、自动保存和冲突保护。删除最后一个声明保留空契约；Allow undeclared inputs 明确移除契约。输入声明问题可从 Problems 跳到 Settings。Magic Variables 根据本地 Draft 的声明提供 `input.*` 选项及类型转换，不依赖运行状态。

Runs 页的“运行已发布版本”表单支持 `manual`（当前活动版本）与 `revision-test`（指定已发布版本）。`numen:manual-run-form@1` Query 接收 `{ automationId, mode, revisionId? }`，返回对应版本的输入契约及可选发布版本列表；未声明输入契约时使用 JSON 对象表单。试运行可以选择尚未激活的版本，且不改变 Draft、Active Revision、enabled、激活代次或 Trigger 订阅。

`numen:manual-run-start@1` Action 接收 `{ automationId, mode, revisionId, input, trigger, requestId }`。Trigger 数据显式填写为 JSON 值，不会重新调用触发器。Scheduler 根据该 Revision 的输入契约校验与填充默认值；manual 模式额外核对该版本仍为活动版本。接受时在同一事务中写入正常耐久 Run、带来源/Revision/requestId 的 RunAccepted Journal 和请求内容指纹。相同 requestId 与完整 payload 的重试（包括进程重启、激活变化和随后归档）返回原 runId；不同内容复用 ID 返回 `409 MANUAL_RUN_REQUEST_CONFLICT`。外部 Automation 的 Revision 和无效输入在接受前拒绝，不创建 Run。

表单明确提示可能产生真实外部副作用。响应不确定时冻结原 mode/Revision/input/trigger/requestId，禁止切换版本、重新加载或更改参数，仅允许用同一请求安全恢复。View Run 打开耐久运行详情；Timeline 保留测试来源、版本和原请求 ID。表单卸载仅取消浏览器等待，不取消服务端已接受的 Run。当前 Draft 快照试运行尚未实现，持久性与回收方案见 [Draft 固定快照试运行设计建议](23-draft-test-snapshot-design.md)。

JSON 编辑器保留未提交文本并上报本地格式状态；无效 JSON 会阻止手动运行提交。参数值回调不透传成原生 DOM `change` 监听器，避免把 Event 对象当成参数。

## Automation 运行历史

Automation 的 Runs 页展示该 Automation 所有 Revision 的运行记录；未归档 Automation 还提供可展开的手动运行表单。可按 Queued、Running、Completed、Failed、Cancelling、Cancelled 筛选，点击记录打开已有 Run 详情。状态统计始终表示当前 Automation 的全部记录，不随状态筛选缩小；记录包含其冻结的 Revision ID。归档 Automation 只读，保留历史查询但不提供新 Run 表单。

`numen:runs-index@1` 增加可选的 `automationId`、`status` 参数，省略时保持全局列表行为。不存在的 Automation 返回 404。Scheduler 在 SQL 中筛选并按 `(created_at DESC, id DESC)` 取最多 20 条页面记录（底层接口最多 50 条），再汇总该页 Execution/Attempt 数量。相同时间戳使用 ID 排序，避免不稳定翻页；游标绑定 Automation 和状态，跨筛选条件使用会返回 `RUN_CURSOR_SCOPE_MISMATCH`。

Previous/Next 保存当前筛选下的游标路径。切换状态或 Automation 会从第一页开始，Latest runs 回到当前状态的第一页并刷新。Run invalidation 更新当前页及统计，手动接受 Run 后也会刷新；页面不把新记录插入正在浏览的旧页。列表是实时视图而非数据库快照：状态变化可能使记录进入或离开筛选结果，用户可回到第一页查看最新状态。列表卸载时查询和订阅随 Vue scope 清理。

手机端编号列截断展示，状态保留在首屏，其余列可横向滚动查看。加载、查询失败、无运行记录和筛选为空分别展示明确状态。

## Automation 生命周期

- 归档会写入 `archived_at` 并递增激活代数。触发订阅立即卸载，旧代数的迟到事件会被 Scheduler 拒绝；已接受的 Run 继续执行，Automation 的启用意图、Draft、Revision 和 Run 历史都会保留。
- 默认 Automation 列表隐藏归档记录，归档筛选器可查看记录、恢复或永久移除。恢复会清除归档时间并再次递增激活代数；如果恢复时仍处于启用状态且有激活 Revision，触发订阅会按当前状态重新建立。
- 归档后不显示手动运行表单，也会拒绝新的手动 Run；先前已接受的请求仍可按相同 requestId 安全重试。
- 永久移除只接受已归档 Automation。只要关联 Run 仍处于排队、运行或取消处理中，就必须先等待完成或取消；通过后在一个数据库事务内清除 Automation、Draft、Revision 和全部 Run 历史。
- Run 删除同时释放其 Execution 的资源所有权。共享资源、仍被其他对象拥有的资源及有效租约不会被清除；没有其他所有者的资源进入现有延迟垃圾回收流程。
