# 16. Outbound HTTP / Proxy Contract

> 本文冻结网络型 Integration 在 Numen Runtime 中使用的出站 HTTP seam，并记录内建 `http:request` Capability 的产品语义。
>
> Cordis / Koishi 版本核对与第一方源码证据见 [16-outbound-http-proxy-research.md](16-outbound-http-proxy-research.md)。

## 1. 决策

Numen 直接采用 Cordis 的 `ctx.http` 作为唯一的宿主级出站 HTTP interface，并由 `@numen/http` 安装和配置其默认 Adapter。Integration 不应各自创建 Axios、Undici Agent 或读取系统代理配置。

```text
Numen Runtime config
        ↓
@numen/http
        ↓
Cordis ctx.http
        ↓
Integration Adapter / Capability Provider
        ↓
HTTP(S) proxy or direct network
```

这样代理选择、默认超时、取消、错误分类和测试都集中在一个深 Module 内；Connection Runtime 仍负责服务身份与 API client，HTTP Module 不知道 Credential 或 Connection。

## 2. 冻结的插件作者 interface

网络型插件必须声明：

```ts
plugin.inject = ['http']
```

插件只依赖以下 `ctx.http` surface：

- `ctx.http(url, config)`：取得未解码的响应，用于需要自行处理非 2xx 状态的场景。
- `get/delete/head/post/put/patch`：校验状态并按 `responseType` 解码。
- `extend({ baseUrl, headers, timeout, proxyAgent })`：创建 Integration 或 Connection 专用 client。
- 请求级 `params/data/redirect/signal/responseType/validateStatus`。
- `ctx.http.isError(error)` 与 `TIMEOUT` / `STATUS_ERROR` 错误码。

Integration 不得依赖 HTTP Module 的 dispatcher、Agent 或 fetch hook 等实现细节。

典型 Connection Adapter：

```ts
const client = ctx.http.extend({
  baseUrl: endpoint,
  headers: { Authorization: `Bearer ${token}` },
})

return {
  value: {
    request(path, config) {
      return client(path, config)
    },
  },
}
```

Token 只存在于 Adapter 建立的闭包中。Capability Provider 仍只接收 READY Connection Runtime，并把 `invocation.signal` 传给每个请求。

## 3. Runtime 配置

默认配置：

```yaml
plugins:
  http:
    timeout: 30000
    # proxyAgent: http://127.0.0.1:7890
    # proxyAgentEnv: NUMEN_HTTP_PROXY
    # noProxy: localhost,127.0.0.1,::1,.home.arpa
    # noProxyEnv: NO_PROXY
```

优先级：

```text
显式 proxyAgent
    ↓ fallback
proxyAgentEnv 指向的环境变量
    ↓ fallback
direct
```

`proxyAgentEnv` 默认是 `NUMEN_HTTP_PROXY`；设置为空字符串可以关闭环境变量 fallback。环境变量只在 Runtime 启动时读取一次，变更后应重启 Runtime。代理 URL 可能包含秘密，生产部署优先使用环境变量，不应把带认证信息的 URL 写进日志、Run、Timeline 或诊断输出。

默认 Runtime 内置支持 `http://`、`https://`、`socks://`、`socks4://`、`socks4a://`、`socks5://` 和 `socks5h://`。HTTP(S) 由 Cordis HTTP Core 提供；SOCKS 由兼容 Cordis 4 的 `@cordisjs/plugin-http-socks` 在相同 `ctx.http.proxy()` seam 注册。旧的 `plugin-proxy-agent` 仍依赖 Cordis 3，因此不纳入 Runtime。

### 3.1 直连例外（NO_PROXY）

共享代理配置后，可用 `noProxy` 指定直连目标。未配置该字段时，读取 `noProxyEnv`
指定的环境变量（默认 `NO_PROXY`）；只有默认的 `NO_PROXY` 未定义时才继续读取
小写 `no_proxy`。显式 `noProxy: ''` 禁用全部直连例外，`noProxyEnv: ''` 仅关闭环境
fallback。环境值在 HTTP Service 启动时读取一次；修改后重启 Runtime。

规则以逗号或空白分隔：

| 规则 | 匹配范围 |
|---|---|
| `example.com` / `.example.com` | 本域及其子域，不匹配 `notexample.com` 或 `example.com.evil.test` |
| `*.example.com` | 仅子域 |
| `localhost:8123` | 该主机的指定端口；省略端口则匹配所有端口 |
| `127.0.0.1` / `::1` / `[::1]:8123` | IP 字面量；IPv6 带端口必须加方括号 |
| `*` | 所有目标直连 |

匹配忽略域名大小写与末尾的点，支持国际化域名；HTTP/WS 默认端口是 80，HTTPS/WSS
是 443。仅根据 URL 主机匹配，不查询 DNS，也不隐式绕过私有网络。CIDR、URL、路径、
PAC 和其他 glob 规则不受支持；无效规则使 HTTP Service 配置失败，错误不回显规则内容。
域名与独立 `*` 的语义参考 [curl NO_PROXY 文档](https://curl.se/libcurl/c/CURLOPT_NOPROXY.html)，
上表是 Numen 的具体支持范围。

直连规则是宿主级策略，也适用于 `extend()` 或请求级选择的代理。未匹配的目标继续
使用已解析的代理；未配置代理时保持直连。HTTP 自动重定向对每一跳重新选择路径，
WebSocket 握手复用相同路由。实现保留 Cordis 的代理 factory 扩展，支持 HTTP(S) 与
SOCKS；复用的代理连接与直连连接随所属 Effect 卸载而关闭。Integration 无需改变代码。

## 4. 行为约束

- Runtime 默认超时是 30 秒；Integration 只有在上游协议明确需要时才覆盖。
- Scheduler 的 Capability 超时与 HTTP 超时是两层限制；Provider 必须传递 `invocation.signal`，最先发生的取消获胜。
- `get/post/...` 默认把 HTTP 4xx/5xx 转为 `STATUS_ERROR`；需要读取错误 body 时使用可调用的 `ctx.http()` 或自定义 `validateStatus`。
- Connection Adapter 可用 `extend()` 固定 endpoint、认证 header 和服务级 timeout，但不应缓存 Credential 明文到 durable state。
- Provider 返回前必须把 Headers、ArrayBuffer、Stream 等宿主对象投影为 Capability Schema 允许的有界值或 ResourceRef。
- 禁止记录 Authorization、Cookie、Proxy-Authorization、请求 body、URL userinfo，以及含敏感 query 的完整 URL。

## 5. Built-in HTTP Request Capability

`@numen/integration-http` 在相同 seam 上提供 `http:request@1`。它是保守的 `action`：method 是运行时输入，Contract 不能把所有请求都声明成无副作用或可安全重试。

输入：

```text
method = GET | HEAD | POST | PUT | PATCH | DELETE
url
headers?: Record<string, string>
query?: Record<string, string>
body?: { type: text, value: string }
      | { type: json, value: NumenValue }
timeoutMs?: 1..300000
```

输出：

```text
ok
status
statusText
headers
bodyType = text | json
body
```

冻结行为：

- HTTP 4xx/5xx 是正常输出，`ok = false`；Automation 可按 status 分支。
- 网络失败、超时、非法 URL、非 HTTP(S) scheme、URL userinfo、请求/响应超限、二进制 media type、无效 UTF-8 或无效 JSON 会使 Execution 失败。
- 请求和响应 body 默认各限 1 MiB，Runtime 配置上限为 16 MiB；超限响应会取消 stream，不返回截断内容。
- JSON body 必须是 NumenValue；response headers 会转换为普通对象。
- `Authorization`、`Proxy-Authorization`、`Proxy-Authenticate`、`Set-Cookie` 等响应 header 在持久化前脱敏。
- 私有网络和 loopback 可访问，以支持 Home Assistant、NAS 等个人自动化场景；多用户部署需重新评估 SSRF policy。
- 代理不属于 Step input，只能来自 Runtime HTTP 配置。

## 6. 当前边界

- 已提供宿主级 `NO_PROXY` 路由；CIDR、DNS 解析后的地址匹配和 PAC 尚不支持。
- 尚未提供 mTLS、客户端证书、统一重试或断路器。
- HTTP Module 不自动重试。是否安全重试由 Capability 语义、Scheduler policy 和上游协议共同决定。
- `http:request` 只允许 `http:` / `https:` 目标；Cordis 的 `file:` / `data:` handler 不属于 Automation 权限面。
- 第一版不支持 multipart、streaming output、cookie jar、下载 Resource、PAC、retry 或 browser automation。
