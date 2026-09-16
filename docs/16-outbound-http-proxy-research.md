# Numen 出站 HTTP / Proxy Contract 调研

> 状态：Research Note
>
> 核对日期：2026-09-16
> 范围：Cordis / Koishi 第一方文档与源码；不构成已冻结的 Numen 产品 Contract

## 1. 结论摘要

Numen 不需要自行再造一套 HTTP transport。与当前 `cordis@4.0.0-rc.8` 直接匹配的官方实现是：

- `@cordisjs/plugin-http@1.5.2`：提供共享的 `ctx.http` Service、HTTP/HTTPS 代理、请求拦截与 WebSocket；
- `@cordisjs/plugin-http-socks@1.0.0`：可选地为同一 Service 注册 SOCKS/SOCKS4/SOCKS4A/SOCKS5/SOCKS5H dispatcher。

建议把 `ctx.http` 定为 **Numen host-owned outbound substrate**：Runtime 负责装载、默认 timeout 和全局代理；Integration 只声明 `http` 依赖并通过 `ctx.http.extend()` 创建带 `baseUrl`、headers 和局部覆盖的 client。Automation Capability 不直接接触 Undici dispatcher，也不各自实现代理。

Koishi 的架构模式值得参考，但其当前 `koishi@4.18.11` 仍依赖旧的 `@koishijs/plugin-http@^0.6.3` 和 `@koishijs/plugin-proxy-agent@^0.3.3`。Koishi 文档中的 `endpoint`、Axios/Quester 表述以及独立 `proxy-agent` 配置不能原样搬到当前 Cordis HTTP API；Numen 应以 `cordiverse/http` 当前源码为准。

## 2. 已核对版本与来源

| 项目 | 当前第一方证据 | 与 Numen 的关系 |
|---|---|---|
| Cordis HTTP | [`@cordisjs/plugin-http` package.json：1.5.2，peer `cordis ^4.0.0-rc.8`](https://github.com/cordiverse/http/blob/main/packages/core/package.json#L1-L56) | 与仓库当前 Cordis 版本直接匹配 |
| Cordis SOCKS | [`@cordisjs/plugin-http-socks` package.json：1.0.0](https://github.com/cordiverse/http/blob/main/packages/socks/package.json#L1-L53) | 可选扩展，不是 Core 必需依赖 |
| Cordis Service | [`Service` 注册和 config resolution](https://github.com/cordiverse/cordis/blob/main/packages/core/src/service.ts#L3-L61) | `ctx.http` 的生命周期和 scoped config 基础 |
| Cordis Injection | [`Plugin.inject`、`ctx.inject()` 与 Fiber 创建](https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts#L10-L21) | Integration 的依赖声明机制 |
| Koishi Runtime | [`koishi@4.18.11` 仍依赖旧 HTTP / proxy-agent 包](https://github.com/koishijs/koishi/blob/master/packages/koishi/package.json#L60-L77) | 仅作为成熟使用模式参考 |
| Koishi 使用示例 | [Bot 实现中用 `ctx.http.extend()` 构造平台 API client](https://koishi.chat/en-US/guide/adapter/bot#使用-http-服务) | 验证“共享 Service → scoped client → typed API wrapper”模式 |

## 3. 当前 Cordis HTTP Service

### 3.1 Service interface

HTTP 插件通过 TypeScript declaration merging 增加 `Context.http: Http`，并为 `http/fetch`、`http/websocket` 声明 waterfall event。`Http` 继承 Cordis `Service`，构造时以 `http` 为服务名注册，因此 consumer 应依赖服务名而不是导入某个具体 provider。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L7-L19) [源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L150-L208)

公开调用形态分两组：

```ts
// 底层调用：返回 Fetch Response
const response = await ctx.http(url, requestConfig)

// 便利方法：解码后直接返回 body
const data = await ctx.http.get(url, requestConfig)
const data = await ctx.http.delete(url, requestConfig)
const data = await ctx.http.post(url, body, requestConfig)
const data = await ctx.http.put(url, body, requestConfig)
const data = await ctx.http.patch(url, body, requestConfig)
const headers = await ctx.http.head(url, requestConfig)
```

当前源码的底层 callable 实际返回原生 Fetch `Response`；便利方法才调用内部 decoder。仓库 README 仍展示旧的 `{ status, data }` response 形态，因此这里应以实现与类型源码为准。[接口与实现](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L93-L158) [便利方法实现](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L160-L188) [底层返回实现](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L319-L388)

`ctx.http.extend(config)` 返回一个继承原 Service 的 scoped client，并通过 `Http.mergeConfig()` 合并默认配置；headers 会逐项合并，而不是要求 Integration 在每次请求中重写。这个模式正适合 Connection Runtime 创建平台 client。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L260-L291)

### 3.2 请求类型

当前 `Http.RequestConfig` 包含：

```ts
interface RequestConfig {
  baseUrl?: string
  headers?: Record<string, unknown>
  timeout?: number
  proxyAgent?: string
  method?: string
  params?: Record<string, unknown>
  data?: unknown
  keepAlive?: boolean
  redirect?: RequestRedirect
  signal?: AbortSignal
  responseType?: 'json' | 'text' | 'stream' | 'blob'
    | 'formdata' | 'arraybuffer' | 'headers'
    | ((raw: Response) => unknown)
  validateStatus?: (status: number) => boolean
}
```

定义见 [Cordis HTTP 类型源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L83-L145)。几个重要行为：

- URL 使用 `new URL(url, baseUrl)` 解析；`params` 追加到 query，`null` / `undefined` 被跳过。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L292-L307)
- string、URLSearchParams、ArrayBuffer/View、Blob、FormData、ReadableStream 原样传递；其他 object JSON 序列化，并在调用者未设置时补 `content-type: application/json`。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L71-L82) [源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L345-L365)
- 未指定 `responseType` 时，便利方法按 response `content-type` 解码：JSON、text，否则 ArrayBuffer；也可注册自定义 decoder。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L268-L272) [源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L309-L317)

### 3.3 响应与 HTTP status

底层调用保留完整 Fetch `Response`，包括 `url`、`status`、`statusText`、`headers` 和可消费 body。对于需要输出 `{ status, headers, body }` 的通用 HTTP Capability，应从底层调用读取响应，不应使用会丢失 status/headers 的便利方法。

便利方法默认将 `< 400` 视为成功；`>= 400` 抛出 code 为 `STATUS_ERROR` 的 `Http.Error`，并把原始 Response 附在 error 上。底层 callable 本身不执行 `_decode()`，因此也不应用 `validateStatus`。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L160-L188) [源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L389-L412)

这意味着 Numen 的通用 Capability 必须明确冻结一个产品语义：

1. 所有收到的 HTTP response 都作为成功输出，调用者检查 status；或
2. 默认把非成功 status 转成结构化 Capability error，并提供显式 opt-out。

不应让“用了底层调用还是 `.get()`”偶然决定 Automation 的成功/失败。

## 4. 默认配置、headers 与 redirect

官方 Service 的构造默认配置是 `{}`，没有默认 timeout、headers、proxy 或 redirect。静态 Schemastery 配置只暴露 timeout、keepAlive、proxyAgent；实例级 schema还增加 baseUrl。[源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L190-L207)

因此：

- 未配置 timeout 时请求可以无限等待；Numen Runtime 应提供自己的有限默认值；
- redirect 直接传给 Fetch/Undici，允许 `follow | error | manual`；未设置时沿用 Fetch 默认行为；
- 当前 API 没有暴露 max redirects、cookie jar、PAC、NO_PROXY 或 retry policy；
- headers 接受 Fetch `Headers` 可接受的键值，并由 scoped client 继承；认证 header 应只在 Connection Runtime 内构造，不能进入 Automation Source、Revision 或 journal。

对应传递实现见 [RequestInit 构造](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L345-L354)。

## 5. Proxy 支持

### 5.1 HTTP / HTTPS proxy

Core 在构造时为代理 URL scheme `http` 和 `https` 注册 Undici `ProxyAgent` factory。请求带 `proxyAgent` 时，会解析代理 URL、按 scheme 选择 factory，并把生成的 dispatcher 放入 Undici RequestInit。普通 HTTP 请求与 WebSocket 都走同一选择机制。[注册](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L203-L219) [HTTP 使用](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L366-L374) [WebSocket 使用](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L415-L430)

`proxyAgent` 是 URL 字符串，因此可以携带 URL userinfo，但这也意味着它可能包含秘密。Numen 不应把含用户名/密码的代理 URL放进可读配置投影、Run Context 或日志；认证信息应进入 Credential，Connection Runtime 只在内存中拼装最终 URL 或 dispatcher。

Core 把 `undici` 声明为 optional peer，并在 Node runtime 中动态加载；使用普通 Node 启动时，host 应显式安装一个兼容版本，而不是依赖传递依赖。[package.json](https://github.com/cordiverse/http/blob/main/packages/core/package.json#L39-L56) [加载逻辑](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L163-L176)

### 5.2 SOCKS proxy

SOCKS 不需要 Numen 自行实现。官方扩展 `@cordisjs/plugin-http-socks` 声明 `inject = ['http']`，然后通过 `ctx.http.proxy()` 注册：

```text
socks, socks5h  → SOCKS5，代理端解析域名
socks5          → SOCKS5，本地先解析域名
socks4a         → SOCKS4a，代理端解析域名
socks4          → SOCKS4，本地先解析域名
```

默认端口为 1080，username/password 从代理 URL 解码。实现见 [SOCKS 插件源码](https://github.com/cordiverse/http/blob/main/packages/socks/src/index.ts#L8-L42)。

Core README 仍声称需要旧的 `@cordisjs/plugin-proxy-agent`；当前仓库已经不存在该 package，实际 SOCKS 扩展名是 `@cordisjs/plugin-http-socks`。这是明确的文档漂移，应以 package/source 为准。[旧 README 段落](https://github.com/cordiverse/http/blob/main/packages/core/readme.md#configproxyagent) [当前 SOCKS package](https://github.com/cordiverse/http/blob/main/packages/socks/package.json#L1-L53)

## 6. Timeout、取消与生命周期

每次请求创建内部 AbortController：

- 外部 `signal` 已取消时，立即抛出它的 reason；
- 后续外部 abort 会转发给内部 controller；
- `timeout` 到期时以 `Http.Error('request timeout', 'TIMEOUT')` abort；
- 请求完成后清除 timeout timer。

实现见 [取消与 timeout 源码](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L319-L344)。

fetch 失败时，已有的 `Http.Error` 原样抛出；其他错误包装为 `Http.Error('fetch ... failed')` 并通过 `cause` 保留底层错误。官方 code union 只有 `TIMEOUT | STATUS_ERROR`，普通 DNS/TLS/连接/外部取消没有稳定细分 code。[错误类型](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L60-L69) [错误包装](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L372-L380)

对 Numen 有两个直接要求：

1. Capability Provider 必须把 `CapabilityInvocation.signal` 传给每次 HTTP 请求，否则 Run cancel/timeout 不能停止底层 I/O。
2. 在 provider boundary 把 Cordis/Undici error 归一成 Numen 的稳定结构化错误，例如 `TIMEOUT`、`HTTP_STATUS`、`CANCELLED`、`NETWORK`、`INVALID_REQUEST`；不要把 Undici 的易变错误类写入持久 Contract。

需要注意：当前 HTTP Service 的 lifecycle effect 负责清 timer，但源码没有在 Context dispose 时显式 abort 正在进行的 fetch。Numen 的 Run cancellation 必须依靠 invocation signal，不能假设卸载插件一定取消在途请求。[effect 实现](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L336-L344)

## 7. Cordis Service injection pattern

当前 Cordis 推荐模式如下：

```ts
import type {} from '@cordisjs/plugin-http'
import type { Context } from 'cordis'

export const inject = ['http']

export function apply(ctx: Context) {
  const client = ctx.http.extend({
    baseUrl: 'https://api.example.com',
    headers: { authorization: 'Bearer ...' },
  })
}
```

其语义不是启动时的一次性检查。Fiber 会等待所有 required service 可用；provider 变化时 consumer unload，provider 恢复后重新加载。注入项上的非空 config 会进入 Context intercept chain，Service 在请求时通过 `resolveConfig()` 合并 base、intercept 与 request config。[Fiber 构造与 intercept](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts#L114-L166) [Fiber readiness/reload](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts#L348-L430) [Service config resolution](https://github.com/cordiverse/cordis/blob/main/packages/core/src/service.ts#L46-L61)

Koishi 的成熟实践也使用 `ctx.http.extend()` 为每个平台创建 client，再把 client 交给 typed internal API wrapper，而不是让每个方法直接处理 proxy/headers。[Koishi 官方示例](https://koishi.chat/en-US/guide/adapter/bot#使用-http-服务)

对 Numen 的具体映射应是：

```text
Runtime-owned ctx.http
        ↓ inject ['http']
Integration Adapter / Capability Provider
        ↓ ctx.http.extend({ baseUrl, headers, timeout, proxyAgent })
ConnectionRuntime.value (typed platform client)
        ↓ invocation.connections.<slot>
Capability invoke({ input, connections, signal })
```

平台 Integration 不应绕过 Connection ABI 回查 CredentialService，也不应自行读取全局代理环境变量。

## 8. 建议冻结的 Numen 边界

### 8.1 Runtime substrate

建议先冻结以下 host contract：

- Runtime 默认加载唯一 `ctx.http` provider；
- Numen host 显式依赖 `undici`；
- 默认 timeout 由 Numen 设置，例如 30 秒，因为 Cordis 默认无限；
- 显式 Runtime 配置的 proxy 优先于环境 fallback；
- 环境变量只在 Runtime 启动时读取，避免运行中静默改变网络路径；
- SOCKS 作为可选 transport extension，可在确有需求时加载官方插件；无需改变 Integration ABI。

### 8.2 Integration contract

- 网络 Integration 必须声明 required `http` service；
- Adapter open 时使用 `ctx.http.extend()` 创建 scoped client；
- base URL、公共 headers、timeout、proxy override 固化在 scoped client；
- token/password 只从 Credential snapshot 进入内存 headers/proxy URL；
- 每个请求传入 invocation signal；
- Integration 对外返回领域对象，不泄漏 Fetch Response、Undici Dispatcher 或 Cordis Http.Error。

### 8.3 Generic HTTP Capability

MVP 的用户输入可以只暴露：

```text
method, url, headers, query, body(text|json), timeout, redirect
```

输出只暴露 JSON 可持久化数据：

```text
status, statusText, headers, body(text|json)
```

并建议：

- 只允许目标 scheme `http:` / `https:`。Cordis substrate 还支持 `file:` 与 `data:`，但通用 Automation Capability 不应由此获得读取本机文件的隐式能力。[file/data handler](https://github.com/cordiverse/http/blob/main/packages/core/src/index.ts#L220-L253)
- 不把 `proxyAgent` 放进 Automation step input。否则含认证的代理 URL 会进入 Revision 和 Run history；代理应是 Runtime 默认或一个可绑定的 typed Connection。
- headers 输出转换为普通 `Record<string, string>`；不能把原生 Headers 对象写入 Run output。
- 第一版不加入 multipart、stream、cookie jar、download Resource、PAC、retry 或 browser automation。
- retry 不属于 HTTP transport 默认行为。是否安全重试应由 Capability semantics、HTTP method、idempotency key 与 Scheduler policy共同决定。

## 9. 仍需显式决定的开放项

在实现通用 HTTP Capability 前，还需要冻结三项产品语义：

1. `4xx/5xx` 是成功 output 还是 Capability failure；
2. 全局代理之外，是否在 MVP 提供可绑定的 Proxy Connection（尤其是代理认证）；
3. 是否允许访问 loopback/private network。个人自动化常需 Home Assistant / NAS，因此不宜照搬云端 SSRF 全禁策略；但至少必须拒绝 `file:` / `data:` 并在未来多用户部署模型中重新评估。

这些决定不会改变 `ctx.http` substrate，可在其上独立演进。
