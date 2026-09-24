# 19. Koishi 日志源码调研与 Numen 适配建议

> 调研日期：2026-09-24。本文区分上游事实、当前项目事实与实现建议；建议不代表已经实现。

## 阅读基线

| 第一方来源 | 固定版本 / commit | 阅读范围 |
| --- | --- | --- |
| [Koishi worker](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/koishi/src/worker/logger.ts) | `5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde` | 用户指定的日志配置入口 |
| [Cordis Core](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/logger.ts) | `cordis@4.0.0-rc.8`，npm gitHead `f46ae95e039f156b966e1e0f7e8d1af91e73e9db` | Logger、Message、Exporter、缓存、过滤及生命周期 |
| [Cordis tracing](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/utils.ts) | 同上 | Service 调用代理与 caller / shadow |
| [Console exporter](https://github.com/cordiverse/cordis/blob/d6a0eae59f8b143e9185599eeaba30ad38aa7e57/packages/logger-console/src/shared.ts) | `@cordisjs/plugin-logger-console@1.0.0`，npm gitHead `d6a0eae59f8b143e9185599eeaba30ad38aa7e57` | levels、showTime、showDiff、格式化 |
| [Cordis Loader](https://github.com/cordiverse/cordis/blob/56b3d4f725681cf4556c1a8695a709cc3b6eed74/packages/loader/src/index.ts) | `@cordisjs/plugin-loader@1.0.0-rc.5`，npm gitHead `56b3d4f725681cf4556c1a8695a709cc3b6eed74` | Fiber.entry、locate、Entry 生命周期 |
| [Koishi WebUI logger](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/logger/src/index.ts) | `ec7b4849564347316d9000965606a452b584d8ec` | 记录接收、持久化、Console 投影 |

Koishi 与 WebUI 的 HEAD 通过 GitHub API 查询并固定；Cordis 版本取本项目 lockfile / 已安装包，gitHead 来自对应 npm 精确版本元数据。Cordis 行为同时核对本地发布产物 `lib/index.js` / `.d.ts`，不以仓库最新版本替代已安装版本。

## Koishi 配置思路与版本差异

用户指定的 worker 文件只负责启动配置：`levels` 接受数字或嵌套对象，递归补齐缺失的 `base`，默认 2；`showTime: true` 转为日期模板；`showDiff` 控制相邻日志时间差。`KOISHI_LOG_LEVEL` 覆盖基础级别，`KOISHI_DEBUG` 逐个开启逗号分隔命名空间的 debug。该文件使用全局 `Logger.levels` 与 `Logger.targets`，不是日志存储或前端查询实现。[源码](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/koishi/src/worker/logger.ts)

Numen 可学习配置语义，但不能直接复制调用：当前 Cordis 4 的公共入口是每个 Context 内置的 `ctx.logger` 与 `ctx.logger.exporter()`；没有相应的 `Logger.targets` 或 `record` / `logger` 事件。当前 Console exporter 的 `levels` 是扁平 `Record<string, number>`，不是 Koishi 的层级对象；`showTime` 是字符串，空字符串关闭。命名空间继承、布尔时间选项及环境变量优先级如需保留，应由 Numen 统一正规化。[Cordis Logger](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/logger.ts) [Console exporter](https://github.com/cordiverse/cordis/blob/d6a0eae59f8b143e9185599eeaba30ad38aa7e57/packages/logger-console/src/shared.ts)

建议明确等级范围 `0..3`，拒绝 `NaN`、浮点、非法对象与不受支持的键；层级覆盖按命名空间段匹配，避免 `http` 意外匹配 `httpx`。环境覆盖只使用 Numen 自己的变量名。配置变更不要修改其他 Context 的日志状态。

## 当前 Cordis 可直接复用的公共接口

```ts
type LoggerType = 'error' | 'warn' | 'info' | 'debug'
// ERROR = 0, WARN = 1, INFO = 2, DEBUG = 3
interface Message {
  sn: number
  ts: number
  name: string
  type: LoggerType
  level: number
  args: any[]
  fiber?: WeakRef<Fiber>
}
interface Exporter {
  levels?: Record<string, number>
  export(message: Message): void
}

const dispose = ctx.logger.exporter(exporter)
const logger = ctx.logger('namespace')
logger.info('message %s', value)
```

`exporter()` 使用当前 Context 的 Effect，卸载插件即移除接收器。每个接收器独立按 `levels[name] → levels.default → logger.level → INFO` 过滤。`sn` 在一次日志调用时递增，即使某个接收器过滤掉记录也会出现间隔；不能仅凭不连续的 `sn` 判断丢失。`Logger.format()` 可格式化普通参数、Error、占位符，但 `%o` 默认调用 `JSON.stringify`，遇到循环对象会抛错。[源码](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/logger.ts)

必须注意接收器故障边界：当前 `_method()` 直接同步调用 `exporter.export(message)`，没有 try/catch；Exporter 抛错会回到业务调用并阻止后续接收器。参数数组未深拷贝，各接收器看到相同对象。Numen 的接收器应保证永不向业务抛错，不应原地修改消息或参数；不要在自身异常分支再次调用同一 Logger 导致递归。

Core 默认安装 1000 条内存缓存，保留原始 `args` 和 Fiber 弱引用。安全日志中心不能直接把此缓存发送给浏览器。若承诺服务器日志统一脱敏，应在启动插件前关闭原始缓存（公开 `bufferSize` / `buffer`）并使用自己的有界安全记录；终端也应消费同一个安全投影，独立保留原始 Console exporter 会绕过脱敏。[同一源码](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/logger.ts)

## 自动关联来源与执行上下文

Logger 构造时把相关 Fiber 存入 `meta.fiber`。Loader 通过公开类型增强 `Fiber.entry?: Entry`，提供 `entry.id`、`entry.options.name` 与 `loader.locate(fiber)`。应在记录进入系统时立即将来源拍成少量字符串 / 数字；不要保存或序列化整个 Fiber、Context、Entry 配置或弱引用。[Logger](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/logger.ts) [Loader](https://github.com/cordiverse/cordis/blob/56b3d4f725681cf4556c1a8695a709cc3b6eed74/packages/loader/src/index.ts)

Service tracing 不等于请求链路追踪。本地用当前安装版本运行了最小实验：

| 调用 | 日志 name | message.fiber |
| --- | --- | --- |
| caller 插件直接 `ctx.logger.info()` | caller-plugin | caller 插件 |
| caller 调用 Service，Service 内 `this.ctx.logger.info()` | demo | Demo Service 所属插件 |
| caller 先 `intercept('logger', { name: 'request.namespace' })` 再调用 Service | request.namespace | 仍为 Demo Service |

这与源码中 `createShadow` / `symbols.caller` 的服务来源追踪一致。[tracing 实现](https://github.com/cordiverse/cordis/blob/f46ae95e039f156b966e1e0f7e8d1af91e73e9db/packages/core/src/utils.ts)

建议把关联拆成独立字段：`namespace` / `pluginId` 描述来源；`requestId` / `runId` / `executionId` / `attemptId` / `connectionId` 描述当前操作。Node 可以在 HTTP、WebSocket procedure、Scheduler Attempt、Connection 生命周期等真实边界使用 `AsyncLocalStorage.run()`，而不是把 requestId 拼进 namespace 或写入全局可变变量。后台任务应在自身执行时建立 scope，不能永久继承启动它的 HTTP 请求。Browser 可保留显式 Context 元数据，不能假设有 Node AsyncLocalStorage。

验证必须包含并发 A/B 请求、嵌套 Service、Promise/定时器回调、异常后恢复、无 scope 日志及两个独立 Runtime。只验证单一 await 链不足以证明隔离正确。

## Koishi WebUI 的日志分层

Koishi logger 插件注册旧 `Logger.Target.record`，将记录写入文件，并每 100 ms 批量 `console.patch('logs', buffer)`。`LogProvider` 的权限为 authority 4，Query 读取当前 writer 的数据。插件卸载关闭 writer 并移除 target，启动时接纳 loader.prolog。可以学习“独立记录器 + 可选 Console Provider + 页面”的边界，但当前源码没有通用游标续传契约。[服务端源码](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/logger/src/index.ts)

`FileWriter` 以一行 JSON 写入，串行 Promise 链批量 flush，读取时忽略无法解析的行。插件按 UTC 日期和大小切换文件，按 maxAge 清理历史；Query 只返回当前 writer 的记录，并不是所有历史文件检索。[文件实现](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/logger/src/file.ts) [轮转控制](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/logger/src/index.ts)

该 WebUI 插件声明 AGPL-3.0，且依赖 Koishi 4 的旧 Console / Logger 接口。Numen 应独立实现适配自身契约的小模块，不把这份实现当作 Cordis 4 的可直接安装组件。[包定义](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/logger/package.json)

## Numen 边界与建议

现有 Console 契约明确 `Query = truth`、`Subscription = synchronization acceleration`，重连应重新查询。Run Journal 是 append-only 领域事实，日志不得替代 Journal，也不能因日志保留策略变化影响 Run 恢复。[Console 设计](08-console-webui-schema.md) [Scheduler 实现](../packages/scheduler/src/service.ts)

建议建立单一收集入口，先正规化、关联、脱敏、截断，再向终端与有界内存投影分发。服务端日志可以由经过认证的 query 获取，再用合并的 invalidation 触发重新读取；初期无需把每行日志直接推过 WebSocket。这样记录量、慢客户端与重连都受既有边界控制。

日志查询若使用游标，必须包含 Runtime epoch 与单调序号；过滤日志导致序号跳跃属于正常行为。游标落后于保留窗口时明确返回截断 / 重置提示；进程重启后不能把旧序号当新 Runtime 的游标。Query 的过滤、分页与边界都在服务端执行，客户端只保存可见页。静默丢行或无限增长浏览器数组均不可接受。

持久化不是系统日志的必要前提。可以先明确提供本次 Runtime 的有界历史，生产环境通过 stdout 收集；如果需要本地历史文件，应单独定义字节预算、保留周期、串行写入、flush、磁盘满和部分写入恢复。不要仅为了模仿 Koishi 增加另一套数据库 Journal。

安全边界：默认不记录 Credential 值、Authorization、Cookie、连接配置、HTTP body、Capability inputs / outputs 或用户 Source；优先记录稳定 ID、状态、耗时、错误 code。对允许记录的结构做深度 / 数量 / 字符预算，处理循环对象、BigInt、Error cause、异常 getter、toJSON 和控制字符。仅靠 `password` 键名正则不能保证任意字符串中不存在秘密；对 URL query、user-info、Bearer 与 Cookie 等已知格式需覆盖，未知第三方插件主动打印的任意秘密仍须明确边界，不能承诺绝对脱敏。Workbench 用纯文本渲染，禁止把日志作为 HTML。

最低组合验收建议：并发上下文隔离；插件注册/卸载和双 Runtime；Exporter 失败不打断业务；循环参数与超大记录；已知敏感字段不进入终端/缓存/Console；窗口淘汰与 stale cursor；Query 后新记录到达和断线重连；进程重启 epoch；Scheduler retry/cancellation/Connection failure 日志关联仍指向正确实体。若开启文件输出，再补磁盘故障、部分行与停止 flush 场景。
