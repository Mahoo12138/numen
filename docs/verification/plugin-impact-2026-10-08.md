# N3-02：有证据的有界插件影响分析

本模块基于 `1f60417`，实现 2026-09-30 计划中的 N3-02。插件变更 Preview 从全局对象列表改为有证据的影响链：被操作的 Entry/Group → 当前实际拥有的 Capability / Adapter / Type 注册 → 显式使用对应 Adapter/Type 的 Connection → 活动 Revision 和非终态 Run。

## 证据与行为边界

- 沿用 Runtime 实际注册的所有权观察，不按实例名、包名或注册命名空间猜测归属。Definition 与 Provider 独立展示，分别解释声明与当前实现的作用。Group 纳入当前子树，移动后继续使用稳定 Entry ID。
- `previous` 所有者单独作为历史线索展示，不进入当前影响链。从未加载、未观察、被淘汰、重启后缺少记录或配置已变化时，缺失证据继续标未知。
- Connection 只读显式 Adapter/Type 引用；Revision 读取固定依赖 Manifest，Run 关联其实际固定快照，包括非活动发布版本和 Draft-test 快照。执行中的显式调用还可由固定编译指令证明，不因另一部分 Manifest 损坏而丢失已有证据。
- Draft 引用、动态扩展引用和任意插件行为明确列为覆盖范围之外。没有已知影响只表示已检查范围内没有已知关系，不承诺插件没有副作用。
- Run 区分尚未调用、BLOCKED、等待、运行中、外部动作执行记录、取消中和结果未知。数据库中的 RUNNING 是持久化观察，不保证当前外部动作状态。已有失败或中断 Attempt、正在等待重试的调用不标为尚未调用；历史 `OUTCOME_UNKNOWN` 即使不是最新 Attempt 也保留。
- Execution 区分相关调用与同一个 Run 的上下文。并行无关调用的运行状态、前置控制节点等待和结果未知记录不冒充相关调用本身。证据不完整时不推断安全重试或恢复保证。
- 预览和查看证据不调用 Provider、不修改业务数据、不重跑结果未知的副作用。查看 Connection、固定快照或 Run 使用已有导航，并保留未应用 Preview 的离开确认。
- 标签、折叠和空组增删属于元数据操作，不查询业务数据库。原有配置 fingerprint CAS、敏感配置只读及管理通道保护继续有效。

DTO 包含对象 ID、关系边、证据来源、观察与计算时间、每个来源的覆盖状态、截断标记及具体未知原因。浏览器仅展示服务端证据，不建立另一套依赖推断。

## 查询与显示上限

持久化证据在一个 SQLite 延迟只读事务中收集。只投影引用及状态，不返回 Source、Input、Output、Connection 配置、秘密或内部错误；固定快照 JSON 在数据库侧先检查字节数再读取解析。

| 范围 | 上限 |
| --- | --- |
| 进程内所有权观察 | 4,096 条；淘汰后保留不完整标记 |
| 单次相关注册 / 历史线索 | 各 256 条 |
| 图节点 / 边 | 512 / 1,024 |
| Connection / 活动 Revision / 非终态 Run | 各 128 条 |
| 每个 Run 的 Execution / 总 Execution | 64 / 1,024 |
| 每个 Execution 的近期 Attempt | 64 条；更早记录未覆盖时标截断 |
| 单快照 JSON / 累计快照 JSON | 256 KiB / 4 MiB |
| 单快照依赖 / 编译指令 | 256 / 1,024 |
| 单个调用的命名 Connection 绑定 | 32 |

缺失服务、数据库不可用、未知协议、损坏引用或状态、缺失固定指令及超出上限分别记录原因；事务失败不返回部分成功的结果冒充一致快照。命名 Connection 映射遵守持久化协议的优先级，显式空映射也覆盖旧的单 Connection 字段。

## 验证

测试使用隔离临时 Runtime、配置、SQLite 和 Resource 目录。浏览器插件不可用，使用仓库 Playwright / Chromium 加载真实生产构建。

单元与集成回归覆盖独立 Definition/Provider、真实 Host Preview、历史及淘汰观察、元数据操作不读数据库、服务缺失、固定版本和 Run 关联、重启、损坏数据、范围截断、累计字节上限、协议兼容、读操作不写入、私密数据不进入 DTO，以及复杂 Run/Attempt 状态组合。

新增 5 个复合浏览器场景使用名称互不相关的真实外部插件，覆盖完整证据链、无关对象和 Draft 排除、Run 状态区分、分组关闭/恢复不重跑未知结果、移动后稳定 ID、从未加载和重启后缺记录、敏感配置只读、130 个 Connection 的截断，以及查看对象时取消/确认离开 Preview。浏览器错误没有统一豁免。

首次全量浏览器回归有 4 项新场景失败。启动日志确认夹具缺少真实依赖声明：Loader 并发启动同级实例，Adapter/Provider 有时先于其 Type/Definition 加载，分别报 `connection type not found` 和 `connection adapter not found`。测试夹具改为通过独立 Cordis 服务声明就绪依赖，并加入预期实例 ACTIVE、Provider 已注册的前置断言；没有修改产品注册语义、添加重试或放宽影响分析断言。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm test` | 119 文件 / 753 项通过 | `/tmp/numen-n302-tests-final.log` |
| `pnpm typecheck` | 通过 | `/tmp/numen-n302-typecheck-final.log` |
| `pnpm build` | 通过 | `/tmp/numen-n302-build-final.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n302-examples-final.log` |
| 配置表单 → 配置编辑 → 影响分析 Chromium 回归 | 20 项通过 | `/tmp/numen-n302-browser-fixture-fixed.log` |
| 最终全量 Chromium Playwright | 74 项通过，2.3 分钟 | `/tmp/numen-n302-browser-final-v2.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

最终截图位于 `/tmp/numen-n302-browser-final-v2/`：

- `plugin-impact-proves-separ-bc37c-ated-and-Draft-only-objects/plugin-impact-desktop.png`：1440×960，展示注册、Connection、固定版本、Run 和展开的证据链。
- `plugin-impact-distinguishe-13d69-ithout-invoking-or-retrying/plugin-impact-mobile-zh.png`：390×844 中文界面，展示多种 Run 状态和查看入口。

以上两张最终截图已实际查看。对象 ID 可换行，证据及状态解释可读，无横向溢出；较长内容正常纵向滚动。浏览器验收同时保留真实 Host DTO 附件用于核对证据。

本模块没有数据库迁移、依赖升级或新增用户配置。N3-03 将把 Preview 与相关运行观察关联，并在 Apply 前校验观察变化；本模块沿用现有配置 CAS，尚未实现该运行态过期门禁。其他浏览器、部署与发布不属于本轮验证。
