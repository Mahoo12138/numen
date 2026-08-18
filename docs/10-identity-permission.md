# 10. Numen Identity、Authentication、Authorization

> 本文定义 Numen 的身份与授权边界；V1 实现保持单用户，但协议不绑定单用户模型。

## 1. 概念拆分

```text
Authentication
“你是谁”
    ↓
Principal
“这次调用代表谁”
    ↓
Authorization
“能不能做这件事”
    ↓
Domain Service
```

UI visibility 只是 projection，不是安全边界。

## 2. Subject / Session / Principal / Actor

### Subject

持久身份：

```ts
interface SubjectRef {
  type: string
  id: string
}
```

可能：

```text
user:miles
automation:auto_123
system:scheduler
api-token:xxx
```

### Session

一次临时认证会话。

### Principal

当前请求的有效调用者，由 server/auth provider 构建。

### ActorRef

写入 Audit/Journal 的耐久身份引用。

## 3. Automation Actor

后台 Run 不继承浏览器 Session。

例如手动启动：

```text
triggerActor   = user:miles
executionActor = automation:auto_123
```

Cron：

```text
triggerActor   = system:scheduler
executionActor = automation:auto_123
```

## 4. Core 不内置 RBAC

Core 只认识：

```text
Principal
Action
AccessTarget
Decision
```

不硬编码：Admin/Editor/Viewer/Workspace Role。

## 5. Permission Action

ID namespaced。Numen 内建 Action 使用逻辑命名空间 `numen/*`：

```text
numen/automation:publish
numen/run:cancel
numen/connection:manage
numen/credential:replace
numen/market:install
numen/system:manage
```

Definition 注册可作为 Cordis Effect。

## 6. Access Service

```text
check
require
checkMany
```

V1：SingleUserAccessProvider，authenticated owner allow all。

未来可替换 Workspace/RBAC Provider。

## 7. Console

Console Client 挂 `principal`。

Action 可声明 authorization target resolver，Console 层做 early rejection。

但最终 Domain mutation 仍需在 Domain Security Boundary 做授权，避免 CLI/REST/Plugin 绕过 Console。

## 8. Query / List

List Query 不应先 `SELECT *` 再前端过滤。

Domain Service 根据 Access Context 做 visibility filter。

## 9. Subscription

建立 subscription 时授权；authorization generation 改变后需要 revalidate，不能永远保持旧权限。

## 10. Credential

不存在普通 Console `credential:read-secret`。

授权可以管理 credential metadata / replace / delete，但 Secret Material 仍只通过 CredentialService → ConnectionRuntime declared adapter path 使用。

## 11. Resource

`resource_owner` 是生命周期所有权，不是访问权限。

Resource HTTP：

```text
ResourceRef
→ Principal
→ Authorization
→ stream
```

## 12. Audit

Audit 保存 ActorRef，不只保存 User ID。

CreatedBy 是历史事实，不自动等于永久权限 Owner。
