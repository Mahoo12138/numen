# N2 版本工作区：固定快照查看验收

范围：N2-01。接续 N1 提交 `0e08ee3`；N0 配置编辑已独立提交为 `2342472`。用户要求每完成一个模块就提交，本模块经验证后单独提交。

## 已实现行为

- 发布列表提供“查看快照”，Run 详情提供其接受时快照的入口。稳定路由为 `/automations/:automationId/snapshots/:snapshotId`；URL 仅包含对象身份，Run 返回上下文仅包含 Run ID。
- 新的 `numen:automation-snapshot@1` Console Query 校验认证与 Automation 归属；允许读取归档 Automation 的历史。查看使用固定 Source、Presentation 和契约，不调用当前插件注册表或编译器，不保存 Draft，不改变发布、激活、启用、订阅或 Run。
- Flow 与已有运行查看共用只读树；历史名称来自快照。节点详情可定位并聚焦固定 Source 的对应节点。固定版本有自己的标题、身份、内容指纹、Source/IR 格式及创建时间。
- 测试快照明确显示 Draft 来源与版本，不提供 Activate。未知 Source 协议仅显示身份和不支持提示，不解释未来格式。
- Source 的 literal/object/array 只在服务端按固定 Schema 的已有检查规则逐叶投影。只有明确 public 且类型匹配的值可显示；敏感及未分类字段隐藏，未知字段名不发送。动态表达式只显示类别，不显示 ref path、模板文字、调用参数，也不执行表达式。
- Automation 输入声明显示名字、类型、必填及是否存在默认值；标题、描述和默认值不传输。Connection 仅显示绑定数，不传输运行身份或凭据。Presentation 只展示与实际 Source 节点相符的 `collapsedNodes`；其他字段隐藏。
- 参数路由变化会清除上一查询内容并中止旧请求；显式重试保持同一快照 ID。节点选择随身份变化清空，延迟定位不会抢新快照的焦点。导航沿用 Draft 的未提交字段/保存/冲突保护。

## 数据与兼容边界

没有新增迁移，仍为 N1 的 v15。只读领域入口先用 SQLite `length(CAST(... AS BLOB))` 检查归属与全部历史 JSON 的 UTF-8 字节数，然后才解析：总上限 8 MiB。跨 Automation 或已删除对象在解析前拒绝。

Flow 与 Source 最大 250 节点、64 层；literal 投影沿用单项检查边界，并有 32 KiB 的全局值预算；触发器最多 30 个，输入声明最多 100 项。最终响应超过 128 KiB 明确返回 413，截断时显示提示；不会改变原存储内容。解析失败仅返回固定说明，不回显异常内的数据片段。HTTP 查询为认证 POST，响应 `Cache-Control: no-store`。

这些展示是有界安全投影，不是原始 Source、完整 Schema 或 Presentation 的导出；未分类值不能因当前插件的新声明而变得可见。同进程插件仍属于受信任代码，这一 UI 不构成针对恶意插件的隔离沙箱。

默认 v2 Workbench 组合自动装配新查询 Provider。旧 v1 叶组合继续原来的装配语义，不新增一个用户配置入口；只有 Query 定义可用，新 Provider 在未装配时明确 unavailable。

## 验证记录

在隔离临时 Runtime、SQLite、配置与资源目录验证；没有读取或迁移用户业务数据库。

新增 7 项真实数据库/Provider 测试覆盖：

1. published / draft-test 固定身份；继续编辑、归档及 Definition/Control 卸载后查看，不产生写入或 automation-change。
2. 认证、abort、缺失对象与跨 Automation；外来损坏 JSON 在归属检查前不会解析。
3. 未知协议及不兼容 Source/契约的明确降级。
4. UTF-8 多字节大对象在 parse 前超过 8 MiB；损坏 JSON 的固定错误与无秘密回显。
5. 80 层 / 400 节点、公共大字面量、未知字段名、模板、默认值、Presentation 合成 canary 和缺失契约。
6. 真实 Console HTTP 的认证、POST-only、no-store 和错误投影。

浏览器目标测试先在 N1 的生产构建验证缺失版本查看入口，失败日志与证据保留在 `/tmp/numen-n2-snapshot-entry-red{,.log}`。更早的 `/tmp/numen-n2-snapshot-red` 是 fixture 未完成启动认证的错误，不作为实现失败证据。

浏览器覆盖已保存身份、当前 Draft 改变、插件卸载、无历史或 Draft 写入、公共 HTML 作为文本、敏感 canary 未进入 HTTP body、Run 入口与归档后的测试快照、刷新、中文 390px 无横向溢出、未知协议、跨 Automation、无效字段导航取消，以及不同快照的读取失败/同 ID 重试。同页参数变化与旧真实响应延迟返回补充独立场景。

最终执行结果（2026-10-08）：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | `/tmp/numen-n2-01-typecheck-final.log` |
| `pnpm build` | 通过 | `/tmp/numen-n2-01-build-final.log` |
| `pnpm test` | 110 个文件 / 567 项全部通过 | `/tmp/numen-n2-01-unit-final.log` |
| 完整 Chromium Playwright | 43 项全部通过，含 6 项 N2-01 场景 | `/tmp/numen-n2-01-browser-final.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

Browser plugin 在本会话不可用，因此使用仓库 Playwright/Chromium、正式生产构建和 `127.0.0.1` 临时 Runtime。最终 1440×960 桌面、390×844 中文移动端及 Source 定位截图已实际查看：页面身份正确、有完整内容、没有框架报错层，public HTML 为文本，节点详情聚焦正确，无横向溢出；浏览器用例严格检查无未解释的 console/pageerror。

最终截图、响应顺序 JSON 保留在 `/tmp/numen-n2-01-browser-final`。响应顺序证据明确为 `mountedPagePreserved=true`、`obsoleteRequestAborted=true`、`obsoleteResponseReceived=false`：同一 Page 的旧请求被取消，延迟真实后端响应不能覆盖 B；不能描述为已收到旧响应再丢弃。公开 DTO 对象与私密 canary 均为合成测试数据。

这是本地隔离验证。没有执行远程 CI、其他浏览器引擎、发布或部署验收，没有操作用户业务数据库。

## 后续模块

N2-02 的语义比较及 N2-03 的一次可撤销恢复到 Draft 尚未实施。比较将绑定明确的 Draft version 与快照 ID；恢复继续使用现有文档命令、Draft CAS 和 Undo，不改变 `baseRevisionId` 的发布来源语义。
