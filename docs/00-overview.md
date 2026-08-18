# 00. Numen 总体架构

## 1. 框架定位

Numen 是一个 **Cordis-native、plugin-first 的个人自动化 Framework / Runtime**。它面向单个自然人的生活、学习与工作自动化，目标类似“面向人的 Home Assistant”，连接：

- 日历、邮件、笔记、即时通讯
- 游戏、动漫、阅读、购物清单
- 投资、储蓄等个人信息
- 天气、油价、设备等外部世界

Numen 的核心理念：**Cordis 万物皆插件**。不同领域通过插件接入，不把世界预先硬编码为固定模块。

Numen 与 Cordis 的关系：

```text
Numen
├ Automation / Scheduler / Capability / Connection
├ Console / Workbench / Marketplace / Diagnostics
└ Stable Domain Contracts
        ↓
      Cordis
Plugin / Service / Fiber / Effect / Context / Registry
        ↓
      Node.js
```

Cordis 是底层时空组合运行时；Numen 在其上定义个人自动化领域、耐久执行模型与默认 Workbench。

## 2. 总体分层

```text
Host / CLI / Supervisor
        │
        ▼
Loader ── Config Tree ── Package Resolution
        │
        ▼
Cordis Runtime
├── Services
├── Plugin/Fiber Tree
├── Effect Lifecycle
├── Registry
└── Events / Context Isolation
        │
        ├──────────────────────────────────────────┐
        ▼                                          ▼
Domain Runtime                                Console/WebUI
├ Automation                                  ├ Backend Console
├ Capability                                  ├ HTTP/WS RPC
├ Connection                                  ├ Frontend Entries
├ Credential                                  └ Browser Cordis Runtime
├ Resource
├ Scheduler
└ State / Trigger / Run
        │
        ▼
Durable Storage
```

## 3. 核心边界

### 3.1 Cordis 管“能力和运行时存在性”

Cordis 负责：

- Plugin 是否存在
- Service 是否可用
- Provider 是否注册
- Effect 是否需要清理
- Runtime Scope 是否存活
- HMR 时旧 Runtime 如何 Dispose

### 3.2 Durable Domain 管“用户意图与执行连续性”

持久化层负责：

- Automation / Draft / Revision
- Connection Config / Credential Metadata
- Run / Execution / Attempt
- State / Trigger Binding State / Wait Registration
- Resource Metadata / Owner

Runtime 可被销毁重建，但这些实体不随 Fiber 消失。

## 4. Narrow Waist

系统内部避免持久化 JS 对象引用，所有跨生命周期关系通过稳定 ID/Contract：

```text
AutomationSource
     ↓ compile
Core IR / Plan
     ↓ schedule
Execution
     ↓ resolve
Capability Contract + ConnectionRef
     ↓ runtime
Current Provider
```

同理：

```text
ResourceRef   ≠ file path
ConnectionRef ≠ token
CapabilityRef ≠ plugin JS object
Revision      ≠ current plugin runtime
```

## 5. 基础原则

### 5.1 Definition 与 Provider 分离

例如 Capability：

- Definition：稳定 Contract、Schema、语义
- Provider：当前 Cordis Runtime 中的实现

Definition 在而 Provider 不在：Contract 仍可展示，但运行时 NOT_READY。

### 5.2 Existence / Availability / Health / Readiness 分离

- **Existence**：配置/定义是否存在
- **Availability**：Provider/Store/Adapter 当前是否可调用
- **Health**：运行质量
- **Readiness**：当前业务对象是否具备继续运行的所有依赖

### 5.3 Desired State 与 Actual Runtime 分离

对于 Loader：

```text
Application Config Tree = Desired
Cordis Fiber Tree       = Actual
```

对于 Automation：

```text
Active Revision = Desired
Trigger Subscription Runtime = Actual
```

### 5.4 失败不应静默改变用户意图

- Activation 失败不自动切回旧 Revision
- Plugin Config 启动失败不偷偷恢复旧 Config
- Provider 缺失不删除 Connection/Automation
- 删除上游节点不自动清除所有 dangling ref

系统应保留事实并给出可诊断状态。
