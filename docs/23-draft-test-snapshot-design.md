# Draft 固定快照试运行设计建议

状态：原 M3-05 设计建议，2026-09-28。下文“当前”描述该设计时的审计基线。

2026-10-08：用户已批准精确已保存 Draft、用途区分快照和 Run 同寿命三项语义。N1 模型与接受流程已实施并通过本地综合验收，记录和实际查询/迁移边界见
[已批准的决策记录](24-draft-test-snapshot-decision.md)。

## 已核实的现状

- `automation_revisions` 已持久保存 Source、Presentation、Core IR、依赖清单、契约快照和内容指纹。当前 `number` 必填且在 Automation 内唯一。
- `runs.revision_id` 对 `automation_revisions.id` 有外键；Scheduler 按 Run 的 Revision 读取固定 Core IR，不依赖当前 Draft。
- `publishDraft()` 会分配发布序号并更新 `automation_drafts.base_revision_id`，所以不能直接调用它实现“未发布 Draft 试运行”。
- 当前没有独立的 Revision TTL/回收流程。Automation 归档保留历史；永久删除先拒绝活跃 Run，再删除 Run 与 Automation/Revision。
- ResourceService 有耐久 `resource_owners` 和临时 lease，只有无 owner/lease 的资源会进入 GC；Scheduler 目前为执行输出登记 `execution` owner，不能假设 Draft 字面量和试运行输入中的 ResourceRef 已有足够寿命。

## 推荐的持久结构

复用现有 Revision 快照表和 Scheduler，引入显式用途 `published | draft-test`，不新增执行引擎：

| 字段/约束 | 发布版本 | Draft 测试快照 |
| --- | --- | --- |
| purpose | published | draft-test |
| number | 正整数发布序号 | NULL，不占用发布编号 |
| source_draft_version | 可保留创建时版本 | 必填，精确记录服务端 Draft 版本 |
| base_revision_id | 可选来源 | 保存测试时 Draft 的 baseRevisionId |
| Source / Presentation / IR / contracts / content_hash | 已有不可变快照 | 同一字段结构，同样不可变 |

服务接口区分 `getPublishedRevision/listPublishedRevisions` 和面向运行的 `getExecutionSnapshot`。Activate 只接受 published。发布列表、latest published、revisionCount 和下一个发布编号必须过滤 purpose；Run 历史根据 purpose 显示“Draft 测试快照 · Draft vN”，不能伪装成发布版本。数据库增加检查约束，将 purpose 与 number/source_draft_version 的关系固定下来。

这里复用存储和 IR，不把测试快照视为已发布版本。创建测试快照不得修改 Draft、baseRevisionId、Active Revision、enabled、activationGeneration 或 Trigger 订阅。

## 接受与去重事务

1. 前端先处理字段未提交文本。格式错误阻止试运行；合法字段提交并等待现有 Draft 保存状态机完成。用户随后继续编辑不改变本次已捕获版本。
2. 提交 `{ automationId, expectedDraftVersion, input, trigger, requestId }`。不向 Scheduler 传前端 Source，不调用 Publish，不隐式重新执行 Trigger。
3. 服务端先按 requestId 与完整请求内容指纹找已接受结果。相同请求返回原 snapshotId/runId，即使 Draft 已变化或 Automation 随后归档；同 ID 不同内容拒绝。
4. 读取指定版本的当前服务端 Draft，编译并验证输入。不存在、归档、版本冲突、编译失败、输入无效均在接受前失败。
5. 单事务再次校验 Draft 版本/归档状态；写入不可变 draft-test 快照、资源 owners、正常 Run、RunAccepted 来源和去重记录。事务整体成功后才通知 Scheduler。失败不遗留快照、Run 或 owners。
6. `RunAccepted` 记录 source=`draft-test`、snapshotId、sourceDraftVersion、requestId、contentHash。运行输入和触发数据仍在 Run 专用数据字段中，不能写进诊断日志。

同 requestId 的响应不确定恢复复用 M3-03 的参数冻结机制。恢复前不得修改原请求的版本/input/trigger；取消浏览器请求不等于取消服务端已接受 Run。

## 寿命与历史查看

建议第一版将测试快照保留到关联 Run 历史被明确删除，不设置隐式 TTL。可由历史页只读查看其 Source、Presentation、契约和计划，并关联创建时 Draft 版本；不能通过当前 Draft 回放旧运行。当前仓库已有的 Automation 归档/永久删除流程可以作为第一版回收入口，但必须扩展到快照 owners 和去重记录。

创建快照时，遍历受支持的 NumenValue/ValueExpr 字面量、编译计划资源列表以及已接受 Run input/trigger 中的 ResourceRef，验证可读并在同一事务登记 `snapshot` / `run` owner。不能只为快照创建一个短 lease，否则长时间排队、等待、重启和历史查看会失去资源。资源没有 owner 的情况必须先修正再接受，不能悄悄保留一个很快失效的 Ref。

Run 删除后才能释放相应 run owner；最后一个引用 Run 被删除后才能删除测试快照并释放 snapshot owner。发布版本或其他 Run 共享的资源仍由各自 owners 保留。配置、Connection 和 Credential 只保存 ID/契约引用；不把凭据材料复制进快照，也不承诺外部 Connection 状态或真实服务永远与测试时相同。

## 需要产品/实现决策确认的边界

推荐采用“与 Run 历史同寿命、不自动到期”的第一版保留策略。如果产品需要默认清理测试历史，必须先确定保留期限、活跃/等待 Run 豁免规则、删除确认和历史只读失效表现，再实现回收。不能把 TTL 当成任意默认值。

推荐只测试已保存的精确 Draft 版本。若需要测试“本地尚未保存但合法的 Source”，则必须明确是否接受独立服务器快照上传、如何记录与服务端 Draft 的差异；这一扩展不应伪装成当前 Draft 版本。

## 实施前必须通过的验证设计

- inactive/disabled Automation 的 Draft 测试可以运行，发布列表/编号、Draft baseRevisionId、激活代次和 Trigger 订阅均不变。
- 同时提交两个相同 requestId、响应丢失后重启重试、归档后恢复原请求，仅存在一个快照和一个 Run；不同内容复用 ID 拒绝。
- 编译失败、非法 input/trigger、Snapshot/Run/owner 写入中途失败：完整回滚。
- 编译前后其他客户端保存 Draft、用户在保存中继续编辑：版本冲突可解释，不使用错误版本，不覆盖新 Draft。
- 插件编译器卸载后仍可读取和执行已有 Core IR；运行时依赖不可用照现有机制阻塞/失败，不重新编译成不同语义。
- 等待和并发分支跨进程重启仍引用同一个快照；SourceMap、Execution/Attempt 定位到测试时节点。
- 资源在队列/长等待/重启后不会因 GC 消失；共享 owner 不误删；拒绝已 GONE 的资源；历史删除准确释放 owners。
- 归档保留历史；存在活跃 Run 的永久删除被拒绝；合法永久删除连同快照、去重记录与专属 owners 一起清理。
- 历史与日志不泄露 Credential、敏感 input/trigger；没有 localStorage 快照备份。
