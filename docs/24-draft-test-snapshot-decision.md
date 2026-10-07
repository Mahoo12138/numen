# ADR：Draft 固定快照试运行

状态：**三项语义已由用户明确批准，N1 已实现并通过本地综合验收**。2026-10-08。

源码审计基线：`8b7cb5641eae393fbd105cd2f01992abbf6ec020`。本文细化 [M3-05 草案](23-draft-test-snapshot-design.md) 和 [下一阶段计划](../Numen-下一阶段开发计划-2026-09-30.md) 的 N1；不改变两个产品组合入口、正式激活语义或既有执行引擎。

## 1. 已确认的三项数据语义

| 决策 | 已采用行为 | 可见影响 |
| --- | --- | --- |
| 测试来源 | 只接受服务端精确、已保存的 Draft version；前端先提交合法字段并等待保存完成 | 按钮明确“保存当前草稿并试运行”；保存冲突或无效字段阻止测试，不上传独立的本地 Source |
| 快照身份 | 复用 `automation_revisions`，用途为 `published` 或 `draft-test` | 测试快照没有发布编号、不进入发布列表、不可 Activate；Run 仍用固定 `revision_id` |
| 保留时间 | 测试快照与关联 Run 历史同寿命，无隐式 TTL | 第一版随现有 Automation 永久删除清理；归档继续保留历史，不新增普通 Run 删除或 Retention 产品 |

用户在本次开发对话中明确回复“采用这三项，继续 N1”。本轮按这些语义实施；验证只使用隔离临时数据库与资源目录，没有操作用户业务数据库。

## 2. 审计基线与新模型的差异

- 审计基线的 `coreMigrations` 最后一项为 **v14 / `automation-archives`**；N1 新增 v15，见第 4 节。`schema_migrations` 是版本真相，不能用 `PRAGMA user_version` 推断业务迁移版本。
- 基线的 `AutomationRevision.number` 和对应数据库列均必填，所有行隐含为 published。N1 保留 published 类型的必填编号，为 draft-test 增加独立联合分支。`UNIQUE(automation_id, number)` 继续约束发布编号；Run 和 Trigger Event 对 Revision 的外键保留。
- `automation_drafts.base_revision_id`、`automations.active_revision_id` 当前没有数据库外键。此次不顺便新增或改变这两个字段的生命周期。
- `publishDraft()` 编译后在事务内再次检查 Draft version，分配发布编号，更新 Draft `baseRevisionId` 并发出 `numen/automation-change`。Draft 测试不能复用这个写入入口。
- Scheduler 的 `startRevisionTest()` 已有固定 published 运行、完整请求去重和归档后重试恢复；新入口只扩展接受过程，运行、等待、取消、重启恢复继续使用现有 Run/Execution/Attempt。
- `manual_run_requests.request_id` 已有全局主键；`run_id` 唯一并在 Run 删除时级联删除。无需另建含义重叠的 Draft 去重表。

实施保留现有 `AutomationRevision` 的 published 返回契约，新增公共快照基类和区分用途的联合类型：

```ts
interface AutomationRevision extends AutomationSnapshotFields {
  purpose: 'published'
  number: number
  sourceDraftVersion?: number // 旧数据无法可靠回填时缺省
  baseRevisionId?: string
}
interface DraftTestAutomationSnapshot extends AutomationSnapshotFields {
  purpose: 'draft-test'
  sourceDraftVersion: number
  baseRevisionId?: string
  // 没有 number 字段；数据库对应 NULL
}
type AutomationExecutionSnapshot = AutomationRevision | DraftTestAutomationSnapshot
```

`AutomationSnapshotFields` 只包含现有 ID、Source、Presentation、IR、依赖、契约、hash 和创建时间等不可变字段。运行读取返回联合类型；发布列表、Activate 和 published 参数表单返回 published 类型。禁止把所有 `number` 改成可空后以 `!`、0 或假编号消除类型错误。

快照 `baseRevisionId` 是创建时 Draft 的来源观察，不更新当前 Draft 的 `baseRevisionId`；不建立第二套 authoritative Source。旧 Revision 的 `sourceDraftVersion/baseRevisionId` 留空：当前 Draft version 和当前 base 不能证明某个历史 Revision 的创建来源。

## 3. 精确查询与调用影响清单

以下记录基线的生产 `getRevision/listRevisions/automation_revisions` 用途及 N1 实施后的边界；已重新搜索调用点。`getRevision/listRevisions` 保留既有名字并过滤 published，未另增 `getPublishedRevision/listPublishedRevisions` 别名。Console Entry 的同名 `getRevision()` 是前端注册代次，与此模型无关。

| 文件 / 入口 | 基线用途 | N1 查询边界 |
| --- | --- | --- |
| `automation/src/service.ts` · `RevisionRow/mapRevision` | 所有记录映射到必填 number 类型 | 按 purpose 映射联合类型；非法数据库组合拒绝，不默认当 published |
| 同文件 · `listSummaries()` | COUNT/MAX 所有 Revision | LEFT JOIN 的 **ON 条件**增加 `purpose='published'`，保留从未发布且只有测试的 Automation；runCount/activeRunCount 继续包含测试 Run |
| 同文件 · `publishDraft()` 序号查询 | MAX(number)+1 | 显式筛选 published；INSERT 明确 purpose；保持发布后的 base 更新 |
| 同文件 · `publishDraft()` 返回查询 | `getRevision(revisionId)` | `getRevision` 过滤 published，number 仍必填 |
| 同文件 · `getRevision()` | 稳定 ID 查任何行 | 保留为 published 兼容入口；新增 `getExecutionSnapshot` 查两种用途 |
| 同文件 · `listRevisions()` | number DESC 列表 | 保留 published 兼容入口；不把测试插入这个列表 |
| 同文件 · `getExecutionSnapshotIdentity()`（N1 新增） | 历史列表用途/版本标签 | 只读 ID、purpose、number、source_draft_version，不为列表解析 Source/IR 等大 JSON |
| 同文件 · `activateRevision()` | 只验证 Revision 的 Automation 归属 | 归属和 purpose 都校验；不存在/测试快照拒绝且不改变 activationGeneration |
| 同文件 · `removeArchived()` | 拒绝活跃 Run，释放 execution owners 后删除历史 | 扩展释放 run/snapshot owners；先删 Run 再删 Automation/Revision；去重记录仍由 Run 级联删除 |
| `scheduler/src/service.ts` · `startRequestedRun()` | manual / revision-test 接受 | 仍限 published；新增 draft-test 接受入口不要绕过 purpose 校验 |
| 同文件 · `acceptTrigger()` | 根据正式 binding 接受 | `getRevision`；测试快照不生成 binding/trigger_events |
| 同文件 · `admitOneRun()` | 根据 queued Run 读取 IR | `getExecutionSnapshot` |
| 同文件 · `getRevisionForExecution()` | 执行、分支、循环、等待统一读取 IR | `getExecutionSnapshot`；返回类型和所有间接调用接受联合类型 |
| 同文件 · `recoverInterruptedWork()` | 固定契约决定 retrySafe / OUTCOME_UNKNOWN | `getExecutionSnapshot`；不能读取当前插件重新编译 |
| `triggers/src/service.ts` · `automationHealth()` | 正式订阅状态 | `getRevision` |
| 同文件 · `collectDesiredSubscriptions()` | 正式订阅装配 | `getRevision`；测试不发 automation-change、不影响订阅集合 |
| `workbench/src/automations-provider.ts` · detail query | 发布列表与 count 投影 | `listRevisions`；DTO `number` 保持必填 |
| `workbench/src/automation-authoring-provider.ts` · `projectRevision()` | Publish 返回摘要 | 继续只接 published 类型 |
| `workbench/src/manual-run-provider.ts` · form query | manual / published-test 选项 | `listRevisions`；不让最新测试成为默认发布选项 |
| `workbench/src/connection-usage-provider.ts` | 当前 active Source 的 Connection 使用 | `getRevision`；Draft 已有独立观察，测试历史不冒充当前 active |
| `workbench/src/runs-provider.ts` · detail query | 固定 Source/IR/SourceMap | `getExecutionSnapshot`；Execution 节点过滤基于该快照 |
| `workbench/src/execution-data-provider.ts` | 使用固定输入/输出分类契约 | `getExecutionSnapshot`；继续认证、大小限制、脱敏 |
| `workbench/src/plugin-ownership-provider.ts` | Run 指令的实际注册归属 | `getExecutionSnapshot`；保持 Run/Execution 归属校验 |
| `workbench/src/run-detail-projection.ts` | number 文案、SourceMap、Flow | 接受联合类型；显示“Draft 测试 · Draft vN”，published 才填 revisionNumber |
| `workbench/src/contracts.ts` / `runs-provider.ts` 的 output schema | Run detail 目前只有 optional revisionNumber | 加安全的用途/sourceDraftVersion 元数据，保留 revisionId；不要以 number 缺失猜测用途 |
| `workbench/src/RunDetailPage.tsx` | Revision 标题与导航 | 按显式用途显示测试来源；Source 导航绑定 snapshotId，不能打开当前 Draft 代替历史 |
| `workbench/src/AutomationEditor.tsx` | 发布列表、最新项和 Activate | 继续只显示 published；草稿测试使用独立动作和参数会话 |
| `database/src/migrations.ts` · revisions / runs / trigger_events | 存储、父表与外键 | 旧行回填 published；保留现有 ID/外键/发布编号/所有 JSON/hash/时间 |

`baseRevisionId` 的编辑、复制、N2 恢复及运行历史页的 `revisionId` 均须做语义回归，但不需要为接口命名整洁改动无关代码。

## 4. 已实施的 v15 存储约束与迁移路径

新增 `purpose`、`source_draft_version`、`base_revision_id`，`number` 允许 NULL。约束必须同时保证：

1. published 的 number 为正整数；draft-test 的 number 为 NULL，source_draft_version 为正整数。
2. published 的 source_draft_version 可空；若有值也为正整数。unknown purpose 拒绝。
3. 保留 `(automation_id, number)` UNIQUE。多个 NULL 不占发布编号；不加 content_hash UNIQUE，不跨请求合并内容相同的测试。
4. `runs.revision_id` 与 `trigger_events.revision_id` 的外键继续指向同一表。base 来源不增加级联删除。

当前 `pnpm-lock.yaml` 解析为 `better-sqlite3@13.0.3`；本次仅在隔离内存连接读取到 **SQLite 3.53.4**。SQLite 3.53.0 起支持 `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`，因此不能沿用“必须重建表”的旧假设。[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html#altertabcol)

已采用现有锁定运行时的原位路径：在迁移事务中移除 number 的 NOT NULL，添加来源列，最后添加带整行用途关系 CHECK 的 purpose 列并将旧行默认为 published。CHECK 要显式使用 `typeof(number)='integer'` / `typeof(source_draft_version)='integer'` 和 NULL 分支，避免 SQLite 的 NULL 表达式被当成通过；该 CHECK 覆盖后续 Source version/number 更新，而非只约束 INSERT。此 DDL 已在隔离的空库、完整 v14 fixture 和 v12 升级链执行并验证。INTEGER affinity 允许数字字符串转换后存为整数；CHECK 保证存储类型为 integer，不能把它描述成拒绝所有数字字符串 SQL 输入。服务层另外校验正的安全整数。

v15 迁移显式拒绝 SQLite < 3.53；不升级依赖，也不提供未经验证的表重建 fallback。DDL 和 marker 在既有 immediate 事务内执行。故障注入验证第一/中间 DDL、CHECK 添加和 marker 写入失败均完整回滚，保持 FK 开启，原 v14 行及索引不变，重跑可用。

`runMigrations()` 现在拒绝高于当前代码支持范围的 schema；DatabaseService 迁移失败关闭连接并保持未 ready。该检查保护包含它的新构建，不能追溯让已部署的旧二进制具备检查。

## 5. 原子接受与去重

接受请求为 `{ automationId, expectedDraftVersion, input, trigger, requestId }`，服务端固定 mode=`draft-test`。前端冻结整个请求，包括原始 input/trigger，响应不确定时恢复同一内容；新一次用户测试才生成新 requestId。

请求 hash 与快照内容 hash **分开**：前者对 `mode + automationId + expectedDraftVersion + input + trigger` 规范化计算，用于 requestId 冲突；后者沿用发布的语义快照算法。当前发布 hash 不含 Presentation，测试也不突然把它当含全部展示信息的指纹；Draft version 已固定完整保存内容。

推荐接受顺序：

1. 检查 requestId/NumenValue/请求边界后，先读 `manual_run_requests`。已接受且 hash 相同，从 Run `revision_id` 恢复原 snapshotId/runId；不同 hash 返回冲突。此步骤先于当前 Draft、归档、编译器可用性检查。
2. 新请求读 Automation/Draft，校验未归档且 version 精确相等。复用 `compileAutomation()`；用该 Source 的 `resolveAutomationInputs()` 计算默认值和验证契约，验证显式 trigger 是 NumenValue，不激活 Trigger。
3. 收集/预检受支持资源引用。预检不得启动插件动作；异步文件检查放在事务外，必要短 lease 只覆盖准备期。
4. 同一 **immediate transaction** 再检查 requestId，处理并发请求已被接受的情况；再次校验 Draft version/归档状态与资源可接受状态。
5. 写不可变 draft-test 快照、snapshot/run owners、QUEUED Run、`manual_run_requests`、`RunAccepted`。失败全回滚；不把先写入快照或 owners 的独立提交当作“准备”。
6. commit 后才 kick Scheduler。进程在 commit 后/kick 前崩溃时，重启从 QUEUED Run 恢复，不依赖内存保存任务身份。

接受成功返回 `{ runId, snapshotId, sourceDraftVersion }`，使 UI 明确测试对象。`RunAccepted` 只写 `source='draft-test'`、snapshotId/revisionId、sourceDraftVersion、requestId、contentHash 等安全身份；input/trigger 放 Run 专用列，Source/秘密不写诊断日志。

事务回调必须同步：当前 better-sqlite3 transaction 不能以 async callback 覆盖 await 后的写入。资源 owners 使用已支持外层事务的 `commitOwner()`；新的快照插入入口不调用 Publish、Draft save、Enable/Activate 或自动订阅通知。

同 ID 在归档/插件卸载/草稿变更/重启后仍返回原接受结果。永久删除历史会级联移除请求记录，历史消失后不承诺继续恢复旧结果；当前接受对象也已删除，不允许静默重建该 Automation。

## 6. 资源所有权和必须先验证的 GC 竞态

当前仅 Scheduler 执行输出登记 `execution` owner。`CorePlan.resources` 虽然已有类型，当前 compiler 的返回对象**并未填充它**，不能只遍历这个可选数组。

收集器显式覆盖：

- Source：input 声明 default、Trigger config、支持的 ValueExpr literal（递归 array/object/call 参数）、各个控制的表达式字段和 policy.groupBy。extension 输入同样遍历。
- Core IR：`resources` 以及 invoke input、eval expression、branch condition、suspend config、iterate items、complete output、fail error 的 ValueExpr literal；覆盖 extension 降级产生而不在原 Source 中的常量。
- Presentation：其已声明为 NumenValue 的值，保留实际 ResourceRef 所需的历史可读性。
- Run：**已解析默认值后的 input** 与接受的 trigger。默认值不能因用户没有显式传参而遗漏。

只把 `isResourceRef()` 认可的单字段 `{ $resource: string }` 识别为引用；不用字符串前缀猜测，不在任意未知 Schema/运行对象中盲目扫描。资源数量、输入体积/深度必须有明确拒绝上限；不能截断收集后接受并宣称所有引用都保留。实际上限为深度 64、值节点 100,000、资源 1,000、请求/已解析 input+trigger 1 MiB、快照 8 MiB；超限明确拒绝。由插件在运行期动态生成的 Ref 继续遵循输出 owner 机制；任意 Provider 内部隐含资源、任意 Schema 执行函数或从字符串合成 Ref 不属于静态保留保证，应给出明确约束。

Source/IR/Presentation refs 归 `{ type:'snapshot', id:snapshotId }`；resolved input/trigger refs 归 `{ type:'run', id:runId }`。重复 Ref 按资源 ID 去重，每类 owner 都耐久保存。STAGED/COMMITTED 的 Ref 在物理文件可用、状态仍可接受时用 `commitOwner()` 登记；DELETING/GONE/缺失对象拒绝。提交时 recheck 防止预检后状态变化。短 lease 不能代替这两个 owner。

**基线发现，现已失败复现并修复：** `ResourceService.collectGarbage()` 先读取所有候选，再逐项执行只检查 state 的 `UPDATE ... SET state='DELETING'`。候选循环中 `await store.delete()` 给其他请求写入 owner 的机会；后续候选已经取得新 owner，旧 candidate 仍可能被 claim。现已把 owner、有效 lease、到期条件复核放入原子 GC claim；被 owner 接受与被 GC claim 只有一个胜者。

实际回归覆盖：至少两个候选资源，暂停第一个对象的 `store.delete()`，此时给第二个候选登记 owner/接受运行，再放开 GC；第二个资源应保持可读且不进入 GONE。另覆盖两个 SQLite 连接竞争、expired lease、GC 已 claim 后接受失败，以及 shared digest 对象删除竞态。另验证上传物理写入完成到 metadata 发布之间的删除窗口，以及上传失败清理不能误删另一连接新接受的共享 digest。metadata 发布与同步物理复核/失败清理在 immediate 事务内；同一 ResourceService 的重叠 GC 串行执行。

保证范围沿用单 Host、单 ResourceService。两个 SQLite 连接用于并发接受/owner 竞争验证，不代表多个 Host 可同时对同一资源目录 GC；本轮没有加入分布式删除锁。

Credential 只保留 ID/契约，Connection 仍使用现有配置和 generation；快照没有复制 Credential 材料或 Connection Runtime，不承诺外部世界在测试时冻结。

## 7. 清理边界

第一版没有普通 Run 删除：归档保留历史，`removeArchived()` 是唯一纳入本轮的永久清理入口。它已经在事务内拒绝 `QUEUED/RUNNING/CANCELLING`；WAITING/BLOCKED Execution 所属 Run 仍为 RUNNING，同样受到保护。

扩展清理时，先在同一事务中确定要删的 snapshot/run/execution owner 集合，再移除这些 owner，最后仅对已无任何 owner 的 COMMITTED 资源设置 `gc_after`。保留其他 Automation、published snapshot、其他 Run 和 generic owner；有效 lease 由 GC 最终判断，数据库删除不直接 unlink 文件。已有 `execution_iterations` 和自引用 Execution 清理顺序保留。

Run 删除使 requests/events/attempts 等按现有 FK 清理；之后再删所属 Automation/Revision 和 snapshot owners。`resource_owners.owner_id` 没有业务对象外键，不能期待删 Revision 自动释放 owner。未来若加入普通 Run 删除，删除最后一个关联 Run 后才能删 draft-test snapshot；published 保留依既有发布历史语义，不随一个测试 Run 删除。

本轮只新增 draft-test snapshot 和新接受 Run 的 owners；不要借此次迁移重新编译旧 Revision、猜测已有 owner 来源或改变旧 hash。若后续要求旧 published 快照的字面量资源也被长期保留，应以独立、可核验的历史资源审计确定范围，而非隐式重写旧数据。

## 8. 已准备的隔离旧库 fixture

新增 [v14 fixture builder](../packages/database/tests/fixtures/draft-test-v14.ts) 与 [基线自检](../packages/database/tests/draft-test-v14-fixture.test.ts)。它使用当前真实 v1–v14 migrations 创建 schema，数据全部为合成内容，仅在内存或 `mkdtemp` 目录创建数据库，不读用户业务库、配置或 Credential。

fixture 含两个 Automation（一个已归档）、发布编号 1/3 的空档、Draft v7/base r3、等待的 Run/嵌套 Execution/Iteration、完成 Run/Attempt、Trigger Event、Journal、旧 requestId 去重、共享 owner/输出 owner/lease；按全部表的主键顺序捕获原始行供未来迁移逐行对比。IR/契约/hash 是预存合成值，不要求当前插件可用，不重新编译；资源仅为元数据，未创建真实资源文件。

2026-10-07 本次实际运行：

```bash
pnpm exec vitest run packages/database/tests/draft-test-v14-fixture.test.ts packages/database/tests/database.test.ts
```

结果：**2 个测试文件、5 项测试通过**。新测试校验 v14 schema、FK/integrity、历史图/发布编号/共享 owner、重复现有迁移不改数据、WAL 连接 online backup 和数据库重新打开后全表原始行不变。

这是 **fixture 与当前 v14 的基线验证**，不是目标迁移验证，也不是资源 GC、真实 IR 执行、前端 Draft 测试或等待跨重启验收。

目标迁移与接受测试已追加，保留这些基线自检。综合验收范围：

| 目标场景 | 必须核对 |
| --- | --- |
| 空库 / v14 populated / v12 升级链 | marker 顺序、旧行 published、旧字段逐字不变、索引/外键/FK 检查、下一发布编号为 4 |
| DDL/复制/约束/marker 故障注入 | 全部回滚，NN/旧表恢复，FK 开启，重跑可用；不只检查“抛错” |
| 用途约束 | draft-test NULL number 可多条、published NULL/0/非整数存储编号拒绝、draft-test 缺版本/有编号拒绝、未知用途拒绝 |
| 查询隔离 | 从未发布但已测试仍 revisionCount=0；published list/latest/Activate/manual/正式 Trigger 不取测试 |
| 内容与请求身份 | 相同 requestId 并发/重启/归档恢复一个 Run 和快照；不同 body 冲突；新 requestId 相同 Source 独立快照 |
| 原子接受 | 编译/版本/owner/Event/request 写入故障不遗留行，资源状态也回滚 |
| 真正运行与资源 | 正式 Cron 与测试 Wait 并行、继续编辑、关闭/重启、编译器卸载、GC 竞争、永久删除/共享 owner |

## 9. 备份与回退

未来实际迁移前，应有经授权的停机或一致性备份流程；本文不执行业务备份。WAL 数据库不能只复制正在使用的主 `.db` 文件。可在停机并确认所有连接关闭后复制完整持久目录，或用 SQLite backup API 获得一致数据库副本；资源对象目录与 Credential 加密所需外部密钥要与同一恢复点配套保存，密钥不写测试 fixture/日志。[SQLite Backup API](https://www.sqlite.org/backup.html)

本文隔离测试只证明 synthetic WAL DB online backup 的行级恢复，未证明资源目录和外部密钥的备份恢复。

回退优先使用**迁移前完整备份和对应旧代码**，在隔离目录复核健康再替换正式目录；先停止新旧服务，保留失败后的库作为诊断副本。已经接受测试快照的库不能直接由旧代码运行：旧 code 的无条件 Revision 查询和 number 类型没有用途语义，审计基线的旧 runner 没有“看到未知新 schema 就拒绝启动”的保护。新 runner 已增加该检查，但旧二进制仍不具备；不能仅退回 Git commit 假装数据库也回退。

本轮不提供会删除新 Run 的 down migration、不删除 migration marker 来欺骗旧程序、不自动清理测试快照以适配旧 schema。迁移后产生的数据在恢复旧备份时不在旧恢复点中；需要保留时先导出/隔离保存并明确恢复方案。

## 10. 实施与验收记录

已完成用途区分类型/查询、v15 原位迁移、快照/Run 耐久 owners、GC 竞争修复、原子接受与去重、草稿参数会话和固定历史读取。界面复用既有 Console Query/Action、Draft 保存状态机与 Scheduler，不增加执行引擎或本地 Source 上传。

2026-10-08：`pnpm typecheck`、`pnpm build`、`pnpm build:examples` 已通过；真实 `startRuntime()` 综合测试通过。它覆盖正式每分钟 Cron 与 Draft Wait/parallel 同时运行，接受后继续编辑、关闭 Console、卸载编译器、资源 GC、停止并重建完整 Runtime，同 requestId 恢复原 Run，以及按原 IR 完成等待和下一次正式 Cron。

完整单元/集成回归已通过 **109 个文件、560 项测试**，包含两个真实 Runtime 测试：除上述 Cron 综合场景外，独立 Node 子进程 A 在接受且进入 WAITING 后被 SIGKILL，子进程 B 从同一临时数据库与资源目录恢复，当前 Draft 修改成 v2 后仍以原 requestId 恢复 v1 快照，按真实计时完成 Wait/parallel，资源在 GC 前后仍可读，且只有一个快照、Run 和去重记录。

审查中发现并采用失败复现 → 最小修复 → 复测的三个 UI/数据问题：

- 合法尚未失焦的参数没有触发 beforeunload；同 Draft 版本重新加载时无效 JSON 文本没有重置。现由字段 dirty/invalid 状态保护，并在成功加载后重建参数控件；查询/保存失败保留原表单与参数。失败证据为 `/tmp/numen-n1-parameter-red.log` 和对应截图/trace 目录。
- INPUT_SCHEMA_INVALID/TRIGGER_SCHEMA_INVALID 的原 Schema exception 会回显合成敏感 literal/config。N1 DTO 现在保留 code/severity/SourceRef，使用固定的校验解释；负例先失败再通过。失败日志为 `/tmp/numen-n1-provider-diagnostic-red.log`。
- 丢失接受响应后关闭参数，再归档，旧冻结请求缺少重开入口。已有会话现在仍可查看和恢复，归档后新的试运行与重新加载禁止。失败日志为 `/tmp/numen-n1-archived-session-red-specific.log`，截图/trace 目录同名去掉 `.log`。

全量浏览器回归还定位了新增 header 动作带来的发布点击回归：mousedown 导致字段 blur、Draft 状态文字变长并让徽章换行，按钮在 mouseup 前下移，点击未到达按钮。隔离 Runtime 连续 8/8 次失败，事件/矩形记录保存在 `/tmp/numen-inspector-diagnose.json`。Publish/草稿测试按钮延后焦点提交到自身 click 处理，取消指针手势不执行动作；原“一次点击发布”测试增加拖离取消验证，相关两个浏览器文件 **8 项通过**。首轮全量失败证据保留在 `/tmp/numen-n1-browser-initial{,.log}`。

最终完整 Chromium 浏览器回归 **37 项全部通过**，包含 6 项新增 Draft 测试场景及既有发布、参数保护、运行历史和 N0 配置编辑回归。已查看最终 1440×960 桌面和 390×844 中文移动端截图，固定 Draft 版本、当前版本变化提示、运行入口和参数动作均可见，未出现横向溢出。

保留证据：`/tmp/numen-n1-{typecheck-final,build-final,unit-final,browser-final}.log`、`/tmp/numen-n1-examples.log` 和 `/tmp/numen-n1-browser-final`（截图）；针对性指针回归为 `/tmp/numen-n1-pointer-verified.log`。这些是本地未提交变更的隔离验证；没有执行用户业务数据库迁移、远程 CI、其他浏览器引擎或部署验证。
