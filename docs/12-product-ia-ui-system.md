# 12. Numen Core Product IA 与 UI Design System

## 1. Numen Workbench 定位

本文档描述 **Numen 默认 Workbench / WebUI** 的 Core Product IA。Numen Framework 本身保持插件化；Workbench 负责把核心插件组织成一套稳定、克制的最终用户产品界面。

## 2. 一级信息架构

最终一级导航：

```text
Home
Automations
Runs
Connections
Plugins
System
```

一级对象保持用户领域语义，不暴露内部协议实体。

## 3. Core Product Objects

用户真正需要理解：

```text
Automation  我要系统做什么
Run         它这一次做得怎么样
Connection  系统连接了什么
Plugin      系统拥有什么能力
System      系统自身是否正常
```

Revision、State、Credential 是二级上下文对象。

Resource、Contract、Fiber、Attempt 等默认只在 Diagnostics/Developer Mode 出现。

## 4. 路由建议

```text
/
├ /automations
│ └ /automations/:id/{editor,runs,revisions,state,settings}
├ /runs
│ └ /runs/:id/{flow,timeline,context}
├ /connections
│ ├ /connections/:id
│ └ /connections/credentials
├ /plugins/{installed,marketplace,:pluginId}
└ /system/{overview,diagnostics,logs,settings,developer}
```

导航引用稳定 Route ID，不硬编码 raw URL。

## 5. Workbench 思想

吸收 VS Code 经验，但不复制 IDE。

```text
Top Bar / Command Center
Activity Rail
Primary Sidebar
Main Workbench
Inspector
Bottom Panel
Context Status Bar
```

映射：

```text
Activity Rail     → 全局领域切换
Primary Sidebar   → 当前 Activity 的上下文导航
Main Workbench    → 当前主要任务
Inspector         → 当前 selection 配置/详情
Bottom Panel      → Problems/Timeline/Context/Logs
Status Bar        → 当前上下文状态
```

## 6. 插件空间边界

插件扩展“内容”，Shell 管理“空间”。

业务插件只需要理解：

```text
Page
View
Inspector
Panel
Command
Schema Renderer
```

禁止普通插件：

- 操作 root DOM
- 任意绝对定位 Workbench overlay
- 改 Activity Rail CSS
- 决定 Inspector width

## 7. Activity Rail

Core：

```text
Home / Automations / Runs / Connections / Plugins / System
```

第三方默认不能随意增加一级 Activity。

## 8. Primary Sidebar

随 Activity 变化。

Automation 可含：

```text
AUTOMATIONS
OUTLINE
VARIABLES(optional)
```

Capability Palette 默认使用 Quick Picker，避免永久占据大面积 Sidebar。

## 9. Inspector

selection-driven，而不是 route-driven。

Automation 中选择不同对象：Trigger/Capability/Control → 自动切换 Inspector。

Core Inspector Shell 管：

- Title / type / status
- connection
- schema form
- execution policy
- diagnostics
- extension slots

## 10. Bottom Panel

Automation：Problems / Preview / Logs
Run：Timeline / Context / Logs
Connection：Events / Logs
Plugin：Runtime / Logs

默认不因新 warning 自动展开；使用 badge 提示。

## 11. Command Center

统一搜索：

- Command
- Automation
- Run
- Connection
- Plugin
- Capability
- Marketplace result

所有 UI action 尽量落到 Command：

```text
Toolbar / Menu / Shortcut / Palette
        ↓
      Command
        ↓
Console Action / Domain Command
```

## 12. Detail Shell

统一：

```text
Breadcrumb
Entity Header + status
Context Tabs
Main Content
Optional Inspector / Panel
```

例如 Automation：

```text
Editor | Runs | Revisions | State | Settings
```

Connection：

```text
Overview | Capabilities | Settings
```

Plugin：

```text
Overview | Configuration | Runtime
```

## 13. Visual Language

- 高信息密度、专业、克制
- 不做 Card Everywhere
- Pane / Section / List / Tree / Inspector Group 为主
- 颜色主要表达 status / selection / brand
- Node Shell 统一中性，不一个 Provider 一大片颜色

状态必须使用：Icon + Text + Color，不只靠颜色。

## 14. Density

建议：

```text
Base spacing: 4px
Controls: 28 / 32 / 36px
List row: 32–36px
Top bar: 44px
Activity rail: ~52px
Status bar: 24px
Primary sidebar default: ~260px
Inspector default: ~360px
```

## 15. Layout Profile

内置：

```text
Browse
Build
Inspect
Focus
```

Automation Focus Mode 最大化 Canvas，隐藏非必要 Parts。

## 16. Responsive

Desktop 是完整编辑主平台。

- >=1280：完整 Workbench
- 900–1279：Inspector 可 drawer
- Tablet：压缩 Sidebar/Activity
- Mobile：查看、手动 Run、启停、简单编辑；复杂 Flow Editing 不强求完整能力

## 17. Layout State 分离

```text
Automation node layout
→ Draft Presentation

Sidebar width / panel height / selected panel
→ User Workbench State
```

两者不能混。
