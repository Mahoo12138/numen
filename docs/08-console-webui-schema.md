# 08. Numen Console、WebUI Extension、RPC 与 Schema UI

## 1. Browser 也是 Cordis Runtime

参考 Koishi WebUI：

```text
Browser
└ Cordis Context
  ├ Router Service
  ├ Loader Service
  ├ Theme / Settings
  ├ Console Client
  └ Frontend Extension Fibers
```

Frontend Entry 加载到独立 Scope，dispose/HMR 自动回收 Page/Slot/Renderer/listener/timer。

## 2. Backend Entry

插件后端注册：

```ts
ctx.console.addEntry({
  id: '@example/foo:webui',
  dev: './client/index.ts',
  prod: './dist/client.js',
})
```

注册是 Cordis Effect。

## 3. Frontend Extension Primitive

底层尽量沿用：

```text
page()
slot()
effect()
plugin()
service()
```

高层：Renderer / Inspector / Toolbar / Widget / Command 只是 sugar。

## 4. Extension Point

Typed namespaced slot，例如：

```text
automation.editor.inspector.after
automation.run.inspector.tabs
connection.detail.tabs
resource.preview
```

需要：

- stable ID
- version
- ordering: before/after/order/stable-id
- collision detection

## 5. Console Data Protocol

在 Koishi DataService/Event RPC 上正式化为三类：

```text
Query        read current truth
Action       mutation
Subscription observe change
```

Procedure ID：

```text
<namespace>:<procedure>@version
```

Input/Output/Event 都使用 Schemastery。

## 6. Query / Subscription 关系

```text
Query = truth
Subscription = synchronization acceleration
```

Reconnect：

```text
fetch current truth
→ reconcile entry snapshot
→ invalidate visible query cache
→ restore subscriptions
```

不要依靠 event replay 重建普通当前状态。

Durable Journal 类 stream 可以单独使用 cursor。

## 7. Request Context

服务端构造：

```text
requestId
principal
session
signal
logger
```

Principal 不允许客户端自报。

## 8. HMR Generation

Frontend Entry HMR：

```text
load new generation into staging scope
→ validate registrations
→ atomic registry swap
→ dispose old scope
```

失败保留旧前端 Extension。

## 9. Schemastery UI

Schemastery 是统一 Data Contract。

Schema UI 支持三种投影：

```text
Edit
View
Compact
```

基础类型 Renderer：

```text
string number boolean enum array object union intersect ...
```

领域语义通过 namespaced role。Numen 内建 Role 使用逻辑命名空间 `numen/*`：

```text
numen/resource
numen/connection
numen/credential
numen/expression
@github/repository
@home-assistant/entity
```

## 10. Renderer Registry

前端 Cordis Service：

```ts
ctx.schemaUI.defineRenderer({
  role,
  editor,
  viewer,
  compact,
})
```

Renderer 是 Effect，插件卸载自动消失。

Role 缺失时优先 fallback 到基础类型。

## 11. Dynamic Option

动态数据不塞入 Schema：

```text
Schema = value contract
Renderer = interaction
Console Query = runtime choices
```

例如 GitHub repository picker 通过 Console Query 获取当前 Connection 的仓库列表。

## 12. Secret

区分：

```text
password role = 仅 UI masked 普通配置
secret role   = write-only Credential semantics
```

Secret edit 使用：keep / replace / clear，不回传旧值。

## 13. Automation ValueExpr Adapter

Capability input 的 Schema 描述目标类型 `T`，Automation Editor 实际编辑 `ValueExpr<T>`。

第三方 Renderer 只负责 Literal Mode；Expression/Template 由统一 Field Shell 处理，避免每个插件理解 AST。
