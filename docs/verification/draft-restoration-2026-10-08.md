# N2-03 固定版本恢复到草稿

接续 N2-02 提交 `79e090c`。本模块将同一 Automation 的 published Revision 或 draft-test 快照恢复为草稿的一次完整编辑。

## 行为

- Revisions 列表、固定快照页和比较结果中的固定身份提供恢复入口。比较选择器的临时选择不改变恢复来源；入口 URL 仅含 Automation / Snapshot ID。
- 先提交当前有效字段并等待草稿保存完成。未提交的非法字段、保存失败、冲突、发布中和归档状态阻止准备。已准备期间编辑操作锁定，取消即释放。
- 独立的已认证 `numen:automation-restore-content@1` Query 校验 `expectedDraftVersion` 后返回精确 Source / Presentation。只有显式恢复意图调用这个作者接口；普通查看和比较仍使用其脱敏投影。恢复面板只显示固定身份，不显示原始值，也不将原始内容写入 URL 或浏览器存储。
- 准备不写入；用户确认后，既有草稿文档模型执行一次完整替换，并通过原有 save-draft Action 和 CAS 自动保存。没有第二套写入通道、额外迁移、恢复事务表或配置入口。
- Source / Presentation 包括未知字段均完整复制。当前 Draft 的 `baseRevisionId` 沿用原语义；当前 Draft version / updatedAt 由保存流程推进。撤销或重做已保存的恢复会再产生新版本，Undo 历史保留在当前编辑会话中。
- 历史快照、发布列表、activeRevisionId、enabled、Trigger 订阅和已接受 Run 均不因恢复变化。不调用当前插件编译器，不跨 Automation 克隆。
- 已准备期间发现更高 Draft version，只标记过期，必须显式重新准备。确认后若另一个客户端先写入，最终 CAS 拒绝并进入既有冲突恢复。已接受保存丢失响应时保留本地内容并显示保存错误，不自动重放写入。
- 取消、切换 Automation、路由变化和卸载中止旧请求。旧响应不能应用到新对象；恢复书签仅准备，刷新页面不会自动确认写入。

## 数据边界

Provider 在一个 SQLite 延迟读事务内读取 Automation 归属/归档状态、轻量 Draft 身份及固定内容。Snapshot 读取在 SQL 层限制 Source + Presentation 为 8 MiB，并在解析前拒绝不支持的协议；不读取编译 IR 或冻结契约，所以无关编译数据的损坏不妨碍合法内容恢复。

检查编辑器所需的核心结构，不用当前 Registry 重新解释历史内容。保留未知扩展属性及扩展输入中的未知表达式类型；已知核心表达式检查必要结构。JSON 值总数每项最多 100,000，Source 深度 256、Presentation 深度 64，Flow 250 节点 / 64 层，核心表达式深度 64，Trigger 和输入声明各 100 项，节点 ID 最长 160 字符。超限整体拒绝，不截断后恢复。返回 DTO 允许身份元数据额外 8 KiB。

外来或缺失快照返回固定 404，过期 Draft / 归档 / 损坏内容返回固定 409，超限返回 413；解析错误不回显原始片段。HTTP POST 经过既有认证/Origin 保护，响应 `Cache-Control: no-store`。默认 v2 Workbench 装配 Provider；v1 叶组合仍仅注册定义。数据库迁移仍为 v15。

## 验证记录

全部测试使用隔离临时 Runtime、配置、SQLite 和 Resource 目录，没有访问用户业务数据库。Browser 插件不可用，沿用仓库 Playwright / Chromium，加载真实生产构建。

新增 14 项草稿模型测试覆盖完整 Source / Presentation 替换、同内容恢复、选择和剪贴板、历史上限、保存后 Undo / Redo、并发版本及失败状态拒绝。新增 22 项恢复会话测试覆盖字段提交与保存顺序、请求取消/晚到/替换、Automation/client 切换、同版本刷新与更高版本过期、显式重新准备、卸载、发布/归档阻断和错误不回显。

新增 19 项真实 Provider / 数据库 / HTTP 测试覆盖 published / draft-test、未知字段精确保留、编译器卸载、恢复→保存→Undo→保存→Redo、正式运行与激活保持不变、只读准备、认证/归档/跨对象/损坏数据/深度/字节限制以及大于 1 MiB 的真实 HTTP 准备→保存链路。测试发现扩展中损坏的已知核心表达式会进入编辑器，已增加结构检查并验证回归；返回 DTO 的嵌套 Automation identity 不匹配也会被前端拒绝。

浏览器测试在原构建复现了聚焦合法字段→点击 Revisions 后仍停留 Editor 的回归：失焦提交引发保存状态和布局变化，鼠标释放时标签已移动，点击丢失。Tabs 沿用 Publish 的 mousedown 保护，在 click 的既有输入 guard 中提交字段；没有跳过输入校验或放松保存门槛。原失败证据为 `/tmp/numen-n203-focused-diagnosis.log` 与对应 trace。另通过实际截图发现移动 Inspector 遮挡恢复预览，准备成功开始后会关闭 Inspector；非法字段仍先由输入保护处理。

初轮测试夹具的中文 Language 定位、Console Draft DTO 与领域 Draft 的 automationId 差异已修正；这些不属于产品缺陷。最终结果使用修复后的生产构建重新执行。

首轮全量浏览器回归在 Home→Automations 触发真实页面错误：`useConsoleQuery` 原先先删除旧 `data` 再切换 `status`，新增的同步身份监听观察到了 READY 但无 data 的中间状态。该轮已停止；诊断保留于 `/tmp/numen-n203-browser-full-query-transition.log`。修复将新状态所需数据先准备完整，再切换 status，最后清理无关属性，并补同步读取的单元回归，避免依赖 Vue 批处理掩盖非法状态。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm test` | 114 文件 / 659 项通过 | `/tmp/numen-n203-vitest-final.log` |
| `pnpm typecheck` | 通过 | `/tmp/numen-n203-typecheck-final.log` |
| `pnpm build` | 通过 | `/tmp/numen-n203-build-final.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n203-examples.log` |
| 新增恢复 Chromium 场景 | 9 项通过 | `/tmp/numen-n203-browser-targeted.log` |
| 最终全量 Chromium Playwright | 61 项全部通过，2.1 分钟 | `/tmp/numen-n203-browser-final.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

新增 9 项浏览器场景检查固定发布和测试快照、比较结果的固定身份入口、精确 Source / Presentation / 未知字段、保存后 Undo / Redo / 刷新、baseRevisionId、仍在等待的正式 Run 和 Cron 订阅不变、编译器卸载、非法聚焦字段取消、合法字段保存完成前不读取恢复内容、两个客户端在准备前及确认后的竞争、已接受保存丢失响应后无自动重放、取消晚到响应、归档及跨 Automation 拒绝。控制台只允许每个故障场景中一次匹配 URL 和文本的预期网络错误；没有笼统忽略 4xx 或 pageerror。

最终全量轮的桌面 1440×960 和中文移动端 390×844 截图位于 `/tmp/numen-n203-browser-final/automation-restoration-res-ca8d7-ron-subscription-stay-fixed/` 的 `restoration-preview-desktop.png` 与 `restoration-preview-mobile-zh.png`，已实际查看：来源版本、目标草稿和确认/取消可见，390px 无横向溢出、无 Inspector 遮挡。`restoration-request-order.json` 记录旧真实请求已中止、响应未收到、没有写入；不声称该浏览器场景收到旧响应后才忽略。晚到 Promise 成功/失败由会话单元测试另行验证。

最终全量轮包含原有 52 项与新增 9 项，61 项全部通过，包含此前失败的 Home→Automations 查询状态路径。未验证其他浏览器、远程 CI、部署或发布；本模块没有 N4 规模容量承诺。
