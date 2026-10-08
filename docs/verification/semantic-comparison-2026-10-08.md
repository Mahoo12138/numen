# N2-02 固定版本语义比较

接续 N2-01 提交 `16f14c0`。本模块实现比较；恢复到 Draft 属于后续 N2-03。

## 行为与归属

- Revisions 列表提供指定版本与已保存 Draft 的入口。独立比较页支持 Draft 与发布版本、两个发布版本；同一只读 API 也接受 N1 的测试快照。
- 比较必须指定 Automation、左右 Snapshot ID 或确切 Draft version。版本选择器只编辑临时选择；点击“比较”才替换结果。显式比较和刷新会更新固定身份 URL，参数仅含 ID 和 Draft version。
- 服务端以原始 Source 判断变化，再只返回固定类别、字段标签、操作与稳定节点 ID。值、默认值、表达式路径、模板文本、Connection ID、未知字段名、Schema 和数据指纹均不进入差异 DTO、工具提示或 URL。第一版对所有变化值保持隐藏，包括可能公开的值；页面显示“字段已变化”。
- 稳定节点 ID 区分新增、删除及移动。相同父节点/槽位内以公共节点的最长稳定子序列判断重排，插入/删除不会使剩余节点全部显示移动。移动容器只显示容器移动，其已有子节点身份保持不变；Then/Else 槽位变化单独识别。
- 参数及表达式、Connection 绑定、调用/Automation 执行策略、Trigger、Automation 输入声明和纯 Presentation 分组显示。对象键顺序不制造变化；Trigger 列表次序不制造订阅语义变化。兼容旧 `connection` 与等价的 `connections.default`，同时保留两者冲突的差异。
- 未知属性及 Extension Control 输入只做不解释内容的整体变化标记；不借用当前插件的契约推断历史语义。不编译或执行表达式，不调用当前 Registry，不修改 Draft、历史、激活、启用、订阅或 Run。
- 比较 Query 不订阅实时失效通知。另一个只读元数据 Query 跟踪当前 Draft version；后台保存只标记结果过期，保持左右旧内容。已经观察到的较新版本不会因后续元数据网络失败而遗忘。
- “刷新草稿比较”显式重新读取当前身份，再发起确切版本比较。两次读取之间再次保存仍以 409 拒绝，不自动重试或偷换版本。路由/对象切换、刷新取消和卸载均中止旧请求，旧结果不能覆盖新身份。已有编辑页输入与导航保护继续适用。

## 边界

没有新增迁移或配置入口，仍为 v15。默认 v2 Workbench 自动装配 Provider；v1 叶组合保持原装配语义，仅注册新 Query 定义而没有其 Provider。

- `numen:automation-comparison@1`：已认证、同一 Automation、禁止 Draft 对 Draft；HTTP POST、`Cache-Control: no-store`。
- Draft 读取使用单条 SQLite CASE 查询，在确切版本及 UTF-8 总量检查通过后才返回 JSON 列，避免两条检查/读取间的可变文档竞争；每个 Draft 的 Source + Presentation 上限 8 MiB。
- 历史读取沿用 N2-01 的 Automation 归属及全部快照 JSON 的 8 MiB 检查，然后解析不可变快照。
- 比较引擎每侧最多 250 个 Flow 节点、64 层 Flow / 表达式；一般 Source JSON 深度 256、Presentation 深度 64，每项最多 100,000 个 JSON 值，Source / Presentation 各自最多 8 MiB；输入声明及 Trigger 各最多 100 项，节点/Trigger ID 最长 160 字符。
- 最多 1,000 个变化，响应最多 128 KiB。超限返回 413，整个比较拒绝，避免截断后误报“没有变化”。不支持协议、损坏格式或重复节点 ID 返回固定 409；缺失或跨 Automation 返回 404；过期 Draft 返回独立 409。错误不回显解析异常中的原始片段。
- `numen:automation-comparison-state@1` 不解析 Source、Presentation、编译计划或契约 JSON，只读取当前 Draft version 及最近 100 个发布版本身份。更早版本仍可通过固定身份链接比较。测试快照不占发布选择器的编号或条目。

以上是只读、有界的版本差异，不提供原始文档导出、值级 diff、多方合并或恢复操作。

## 验证

使用临时 Runtime、配置、SQLite 和 Resource 目录；没有使用用户业务数据库。Browser 插件不可用，按已采用的前端验证流程使用仓库 Playwright 和 Chromium，页面加载真实生产构建。

新增 29 项比较引擎测试覆盖嵌套容器移动与增删交错、最小兄弟/分支重排、Then/Else 槽位、稳定 ID 类型变化、全部分类、未知嵌套字段、Extension 输入、私密 canary、对象/Trigger 顺序、旧绑定兼容及冲突、`__proto__` 数据、损坏/重复/不支持格式、深度、UTF-8 字节、数量及完整拒绝边界。

新增 7 项真实 Provider / 数据库 / HTTP 测试覆盖固定 published / draft-test 身份、双向 Draft 比较、归档及插件卸载、无写入与无 Registry 调用、认证/abort、外来损坏 JSON 在解析前拒绝、过期 Draft 在解析前拒绝、UTF-8 大文档、无 JSON 解码的元数据、100 个版本选择器边界、无秘密错误、HTTP POST/no-store。

新增 9 项浏览器场景覆盖真实多类别变化、容器只移动一次、保留已接受 Run、两个历史版本及编译器卸载、后台保存不替换结果、显式刷新与固定 URL、过期 bookmark 409、跨对象及缺失 404、同一挂载页旧真实响应延迟、导航保护、临时选择不查询，以及状态请求 503 后保留过期提示并重新读取当前版本。控制台只允许对应故障场景中一次确切的 HTTP 404/409/503 消息，不忽略其他错误。

初次浏览器配置遗漏 Cron 插件，以及导航 fixture 初始折叠状态，已修正；这些是测试准备错误，不作为产品回归证据。503 场景在已修复构建上单独通过，没有宣称保留修复前失败。

最终全量轮执行 52 项：49 通过，3 项失败只因 fixture 生成的查询参数顺序与 Router 的按键排序不同，路径与完整版本身份相同。按 Router 既有规则排序 fixture URL，保留完整 URL 的严格断言，生产代码未改变；重新执行全部 9 项比较场景，9 项全部通过。原有 43 项浏览器场景在全量轮中均通过。没有把这两次执行描述成一次完整 52 项通过。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm test` | 112 文件 / 603 项通过 | `/tmp/numen-n2-comparison-unit-final.log` |
| `pnpm typecheck` | 通过 | `/tmp/numen-n2-comparison-typecheck-final.log` |
| `pnpm build` | 通过 | `/tmp/numen-n2-comparison-build-final.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n2-comparison-examples-final.log` |
| 原有 Chromium Playwright 场景 | 43 项通过；同轮比较场景 6 项通过 / 3 项 URL 排序预期失败 | `/tmp/numen-n2-comparison-browser-full-url-order.log` |
| 全部新比较浏览器场景 | URL fixture 修正后 9 项全部通过 | `/tmp/numen-n2-comparison-browser-final.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

最终桌面 1440×960 和中文移动端 390×844 截图位于 `/tmp/numen-n2-comparison-browser-final/automation-comparison-comp-16af2-nd-keeps-every-value-opaque/`，已人工查看。页面身份、左右版本、变化分类和移动标识可见，390px 无横向溢出。严格控制台检查未发现非预期错误。`comparison-request-order.json` 记录同页身份切换时旧真实请求已中止、旧响应未收到，不声称旧响应已收到后再被忽略。

未验证其他浏览器、远程 CI、部署或发布；没有对 N4 的规模/性能容量作承诺。
