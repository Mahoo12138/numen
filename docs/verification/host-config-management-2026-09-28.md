# Host 配置管理验证记录（2026-09-28）

范围：开发计划 M4-02 的宿主配置管理后端。测试均使用隔离临时目录、本地 fixture 插件或隔离 Host；没有修改正在使用的用户配置，没有部署或发布。

## 权威来源与接口

`packages/config/src/management-types.ts` 定义 `HostConfigService.read / preview / apply` 和跨包 DTO。`packages/runtime/src/config-management.ts` 实现宿主 Cordis `hostConfig` 服务；该服务先于用户插件树挂载。Workbench 仅调用这个接口，不创建文件写入器或另一套期望状态。

配置文件是期望状态来源，Loader Entry 和 Cordis Fiber 是运行状态来源。`read()` 同时报告 `selfEnabled`、`effectiveEnabled`、实际 Fiber/Entry 状态及只读内部模块（ownerEntryId、临时 diagnosticId、依赖）。内部模块按最近的 Loader Entry 归属，用户配置的子组/成员仍是独立配置行。

接口提供显式 `setEnabled`，没有 toggle。支持创建分组、修改显示名/折叠状态、移动稳定 ID、删除空分组、编辑可管理插件配置。`createGroup.id` 是用户 ident，例如 `telegram`；生成键 `group:telegram`、稳定 ID `group-telegram`。禁止自身/后代移动、全树 ID 冲突、删除非空分组。

## 写入与恢复边界

- Host 内部队列串行化一次完整的“落盘 + 应用”；Config 包现有所有写入口共享合作式锁。
- 每个写请求绑定读取时的 SHA-256 指纹；锁内重新读取并校验，写入前再次比较内容、inode、device、权限和所有者。两个客户端基于相同版本修改时，一方成功，另一方收到 `CONFIG_CONFLICT`。
- YAML AST 保留未编辑字段、未知允许字段及注释；嵌套配置字段修改保留原注释。存在 YAML anchors/aliases 时明确阻止自动写入，不猜测引用迁移语义。
- 校验完整 v2 配置、操作边界及已加载插件的 Schema 后，使用独立随机临时文件进行原子替换。临时文件先以 0600 创建，再恢复原 uid/gid 和权限；恢复所有权失败会阻止替换。
- 文件替换成功后才应用实际 Loader 操作。失败会返回 `saved: true, runtimeApplied: false`，错误默认不包含配置值；期望状态保留，用户可以修正配置，Host 不无限重试。
- 响应丢失后先 `read()` 对账。重复的显式 setEnabled 保留相同状态，不反转启用意图。进程重启重新读取持久期望状态，并从新的 Fiber 状态报告实际结果。
- 外部编辑器不参加合作式锁。运行期间检测到外部文件指纹变化时，`read()` 返回 `restartRequired: true`、只读原因，同时保留真实运行状态；不把磁盘状态伪装成已应用状态，也不通过随后一个无关 UI 操作偷偷应用外部修改。
- 普通文件系统没有针对“比较内容后 rename”的通用跨编辑器原子 CAS。最终检查与 rename 间仍存在极窄外部竞争窗口；本实现不宣称外部副作用或所有编辑器的事务提交。
- v1 在管理接口只读，提示先显式迁移。符号链接不支持自动替换。

Docker 构建在安装依赖前复制 patches；镜像内自带默认配置归运行用户 node 所有，允许保留所有者的原子写回。用户绑定挂载的权限仍由其宿主文件决定。未在本轮声称 Docker 镜像已构建/部署验证。

## 同一管理通道保护与敏感数据

Console、Workbench、Server、提供当前管理服务的实际 Provider 所属 Entry，以及它们全部祖先分组，均由后端保护。禁用、移动、配置改写或移除这些受保护入口会被拒绝；把受保护入口间接移动到关闭的祖先之下也不能绕过。显示名和折叠等不改变执行状态的元数据允许修改。需要关闭当前管理通道时，应在宿主本地修改配置并重启。

配置快照/预览按敏感键、Schemastery `role('secret')`（含嵌套）和文本中已知凭据格式脱敏，包括认证 URL。含秘密的配置整项只读，避免用户把掩码误保存为真实值。Schema 错误、插件启动异常不原样回传敏感值。所有只读实例只返回空配置对象，不把未加载外部插件因 Schema 缺失而无法分类的字段送入浏览器。

影响预览列出当前可读取的 Connection、Capability/Trigger、Automation 候选 ID（每类最多 100）；这些不是完整依赖证明。始终明确 `impact.status: unknown`，不会把无法计算解释为“无影响”。可选领域服务通过 Cordis 的动态 `ctx.get()` 读取，只读取 ACTIVE Provider；这些服务消失不会使 Host 管理本身不可用。

Loader 提供真实加载状态，但没有通用包 manifest 版本 API。`installed` 对未加载且无法确定的外部包保持 null；`packageVersion` 保持 null，不按实例名猜测版本。内部 Fiber uid 仅供诊断，不能用作持久业务身份。

## 必要依赖补丁

安装版本为 Cordis `4.0.0-rc.8`、Loader `1.0.0-rc.5`。真实失败测试发现：

1. `Fiber.update()` 丢弃内部 waterfall 返回的 restart Promise。重新配置使插件初始化抛错时，Fiber 已进入 FAILED，但调用者无法观察 Promise，并出现 unhandled rejection。
2. Loader 的 `_patchContext`、isolate middleware 和 Group update 未贯通该返回值。
3. Loader `Entry.init()` 用 `fiber.await().finally(...)` 发布完成通知，却未处理该通知链自身的 rejection。首次启用失败产生额外 unhandled rejection。

仓库 `patches/` 通过 pnpm `patchedDependencies` 保存最小修补：返回/传播更新 Promise 并由 Entry.update 等待；为 init 完成通知链添加 catch。Fiber 自己的错误日志和 FAILED 状态保持，Host 仍明确返回运行时应用失败。没有用全局 rejection handler、无限 retry 或新生命周期实现掩盖故障。

这些补丁适用于本仓库依赖安装；不表示上游已经发布修复，也不表示独立 SDK 消费者自动获得本仓库的 patch 设置。

## 实际执行的验证

执行命令：

```sh
pnpm exec tsc -b packages/config packages/runtime --pretty false
pnpm exec vitest run packages/config/tests/management.test.ts packages/runtime/tests/config-management.test.ts packages/runtime/tests/cordis-groups.test.ts --reporter=dot
```

结果：TypeScript 构建通过；3 个测试文件、18 项通过，没有 unhandled rejection。

代表性场景：

- 两客户端相同指纹竞争、响应丢失后读取对账、重复 setEnabled 不翻转状态。
- 两层分组创建、跨组移动、祖先关闭/恢复、成员单独禁用意图、标签/折叠、空组删除、重启后状态。
- 管理产品/必要服务/祖先组的禁用、移动、setConfig 保护。
- 配置已落盘但插件 FAILED、无自动重试、用户修正后恢复；首次启用失败的 Loader rejection 回归。
- 嵌套秘密、Schema secret 字段、URL 凭据脱敏，内部 PENDING 模块归属。
- 完整隔离 Host 中读取真实领域服务的影响预览；关闭数据库后相关领域服务消失，Host 管理仍可读取和预览。
- YAML 注释/未知字段与文件 uid/gid/mode 保留；验证期间外部编辑不被覆盖；别名、符号链接和非法分组操作拒绝。
- 原生 Cordis Group 服务共享、跨组移动、持续启停与资源清理回归。

本文记录后端验证；浏览器交互与整仓验收由对应 M4 交付记录单独报告。
