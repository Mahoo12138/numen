# 19. Runtime 日志

> 实现状态：2026-09-24。参考 [Koishi worker logger](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/koishi/src/worker/logger.ts) 的命名空间等级、时间格式与环境覆盖；通过当前 Cordis 4 的 Exporter API 独立实现。版本差异与源码依据见 [调研记录](19-logging-research.md)。

## 数据流与职责

`ctx.logger → @numenjs/logging → 脱敏记录 → 终端 / 有界历史 / JSONL → Console Query + 变更通知 → Workbench`

Runtime 在 Loader 之前安装 `ctx.logs`，Safe Mode 也可采集宿主和插件启动日志。采集器归宿主所有，记录来源 Fiber 与 Loader Entry 路径；卸载时释放 Exporter、计时器和订阅。关闭 Cordis 默认的原始参数缓存，终端、文件和 Console 使用同一份脱敏文本。

日志用于排查内部行为；Run Journal 继续承担耐久执行事实。文件写入失败不会改变 Scheduler 状态或令业务调用失败。日志等级与保留策略也不会改变 Journal。

## 配置

顶层配置（不是 `plugins.logger`）：

```yaml
logger:
  levels:
    base: 2
    scheduler: 3
    http:
      base: 1
      client: 2
  showTime: true
  showDiff: false
  console: true
  persist: true
  capacity: 2000
  maxFileBytes: 1048576
  maxFiles: 5
```

- `error=0 / warn=1 / info=2 / debug=3`，值表示接收的最高级别。`levels` 也可直接写数字；命名空间以 `:` 分段继承，支持 `http:client` 这样的显式覆盖及其后代。
- `NUMEN_LOG_LEVEL=0..3` 覆盖基础等级；`NUMEN_DEBUG=scheduler,http:client` 开启指定命名空间 debug。覆盖经过同一套校验，不修改原配置或其他 Runtime。
- `showTime` 可为布尔值或 Console exporter 日期模板，`showDiff` 控制终端相邻记录时间差。
- `capacity` 为 1–10000 条，默认 2000；单次 Query 为 1–200 条，默认 100。消息最多 4096 个 UTF-16 代码单元，参数、深度、字段与关联元数据均有限额。
- `maxFileBytes` 为 65536–16777216，默认 1 MiB；`maxFiles` 为 1–10，默认 5。`console: false` 或 `persist: false` 可分别关闭出口。

配置在启动时读取，修改后需重启 Runtime。

## 插件日志与上下文

```ts
import type { Context } from 'cordis'
import { withLogContext } from '@numenjs/logging'

export function example(ctx: Context) {
  const logger = ctx.logger('example')
  logger.info('Provider ready')
  return withLogContext({ traceId: 'operation-123' }, async () => {
    await Promise.resolve()
    logger.warn('Remote service unavailable')
  })
}
```

插件照常使用 `ctx.logger`；不要创建第二个终端 Exporter。公共 `withLogContext` 用 AsyncLocalStorage 隔离并发异步调用，可嵌套补充 `automationId / runId / executionId / attemptId / connectionId / triggerId / requestId / traceId`。Fiber 标识描述日志来源，不替代操作关联 ID。

当前自动接入边界：

| 边界 | 自动关联 / 记录 |
| --- | --- |
| Runtime | 启动、就绪、启动失败、停止 |
| Console Query / Action / Subscription | requestId / traceId；Action 仅记录 procedure ID |
| Scheduler Provider invocation | Automation / Run / Execution / Attempt；启动、完成、失败、超时；Run 状态在事务提交后记录 |
| Connection Adapter open / close | connectionId；打开成功或失败；该 Credential 快照在这两个调用范围内参与脱敏 |
| Trigger activate / emit / dispose | Automation / Trigger；激活、激活失败、接收事件和清理 |

单个 Connection 绑定的 Capability 调用还自动携带 connectionId；多个绑定不猜测具体连接。关联上下文会传播到该异步调用创建的任务，独立外部事件回调需要调用方显式建立范围。

## Workbench 与 Console

System 页面 `/system/overview`、全局底部 Logs、Automation 底部 Logs 共享日志视图；Automation 自动限定 automationId。Run 详情中的日志按钮跳转到带 runId 的 System 页面。

UI 支持等级、命名空间、消息和 Run ID 筛选，暂停 / 跟随、最新页和更早页，中英双语及毫秒时间。日志始终按纯文本渲染。

- 经过现有 Console 身份认证的 `numen:logs@1` Query 返回 `LogSnapshot`。除 UI 筛选项外，还接受所有关联 ID 的精确筛选。命名空间匹配自身和以 `:` 分隔的后代。
- `numen:logs-changed@1` 只发送 `{ changed: true }`，约 200 ms 合并通知；慢订阅最多保留一次待发送失效通知。订阅建立时发送一次，作为重连后的重新查询屏障。
- 客户端刷新会替换有界快照，在切换筛选或卸载时取消旧请求，并忽略旧筛选条件下晚到的响应，不追加重复记录。连续通知期间允许正在进行的慢查询完成，再合并刷新，避免查询饿死。
- 更早页使用 `{ stream, sequence }` 游标；新记录插入不改变已取得游标的位置。进程重启后 `reset: true` 并返回新 Runtime 的最新匹配页；游标已落出窗口则 `expired: true`，用户可返回最新页。
- Snapshot 显示保留 / 淘汰数量、无法处理的记录数量和文件出口状态。历史 Query 只检索当前内存窗口，不扫描所有归档文件。

## 文件与故障边界

文件固定在 `<dataDir>/logs/runtime.jsonl`，轮转为 `runtime.1.jsonl` 等。新目录权限 0700、新文件权限 0600。同步逐行追加，写入前按字节上限轮转；内存容量独立于文件总量。

重启按旧到新顺序恢复有效记录，重新执行字段投影和脱敏，保留原记录 ID、生成新 stream。坏行跳过并计数，末尾残缺行补换行以隔离后续写入；过大的异常文件不读入内存。写入失败将 persistence 标为 failed，本次进程继续保留内存日志，修复目录或磁盘后重启以恢复文件出口。

每个 dataDir 只允许一个 Runtime 写入。当前没有多进程文件锁、跨节点聚合、压缩归档或全量磁盘检索；同步追加没有每条 fsync，不保证断电耐久性。日志文件应纳入与 dataDir 一致的本地访问控制和备份保留策略。

## 脱敏边界

系统自身只记录状态与稳定 ID，不自动记录 Source、HTTP body、输入输出或 Credential 内容。对已知敏感字段、Authorization / Cookie / Bearer、常见 URL 密钥和用户信息、私钥块，以及配置中的已知秘密值进行脱敏；Connection open / close 的解密快照仅在调用范围内补充秘密值匹配。格式化完成后再次脱敏，避免 `token=%s` 绕过字段匹配。

序列化限制循环、深度、字段和长度，不调用业务对象的 getter、toJSON 或自定义 inspect；V8 原生 Error.stack 的延迟 getter 单独受保护，递归日志和异常参数会被隔离并计数。终端故障不影响文件和内存出口。

这些措施不能识别任意第三方字符串中的未知秘密，插件仍不得主动打印敏感内容。独立第三方 Exporter、直接 `console.log`、CLI 命令输出和浏览器 console 不经过此采集器。CLI 显式生成的私有登录链接不会进入日志历史。

## 验证

`pnpm release:verify` 覆盖类型检查、完整 Node 测试、生产浏览器、配置校验与 doctor。日志专项包含：命名空间继承和环境覆盖、并发 / 嵌套上下文、双 Runtime、插件来源、格式化脱敏、循环 / getter / Proxy、出口异常与重入、日志洪峰、分页窗口淘汰、文件轮转与残行恢复、Scheduler 并发失败重试、Connection 异步打开失败和关闭、慢订阅、查询竞态与卸载。

生产浏览器验证认证、纯文本渲染、编辑中筛选值保留、暂停 / 跟随、真实 WebSocket 重连、一次查询网络失败恢复、洪峰分页和中英移动端布局。`pnpm image:smoke <image>` 另外验证真实容器执行的 Run / Attempt 日志写盘、容器重建后保留记录及旧游标重置。
