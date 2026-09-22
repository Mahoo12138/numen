# 18. Koishi i18n 源码调研与 Numen 适配方案

> 调研日期：2026-09-22。本文记录第一方证据与实现建议；建议部分不代表已经实现的 API。
> 目标：在 Numen 的 Node / Browser Cordis Runtime 中建立可卸载的国际化能力，并覆盖 Workbench 的英文、简体中文界面。

## 1. 结论

直接依赖 `@koishijs/i18n-utils@1.0.1` 复用语言树和回退算法，另建轻量 `@numen/i18n` Cordis Service 管理词条、文本渲染和生命周期。该上游包仅提供 `LocaleTree.from()` 与 `fallback()`，不包含消息存储、插值、Vue 集成或卸载。源码仅依赖 `cosmokit`，没有 Node 专属 API；包同时提供 CommonJS、ESM 与类型入口，适合 Node / Browser 共用。[包定义](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/i18n-utils/package.json) [完整工具源码](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/i18n-utils/src/index.ts)

Koishi Core 与 WebUI 不是同一个渲染器：Core 采用 Satori 消息元素，WebUI 采用 Vue I18n。Numen 应学习其服务分层与外置词条方式，再适配本项目的纯文本 UI、Cordis 4 与 Entry 原子切换；无需将整个 Koishi Core 或 Client 引入依赖。[Core](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/i18n.ts) [WebUI](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/packages/client/client/plugins/i18n.ts)

## 2. 阅读基线

| 第一方来源 | 固定版本 / commit | 阅读范围 |
| --- | --- | --- |
| [koishijs/koishi](https://github.com/koishijs/koishi/tree/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde) | `5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde` | `packages/i18n-utils` 的源码、测试、package.json；`packages/core/src/i18n.ts` |
| [koishijs/webui](https://github.com/koishijs/webui/tree/ec7b4849564347316d9000965606a452b584d8ec) | `ec7b4849564347316d9000965606a452b584d8ec` | Client i18n / setting / context 与 package.json |
| [koishijs/docs](https://github.com/koishijs/docs/tree/1762722143c3cb277cc2359cfbcf43945f29920e) | `1762722143c3cb277cc2359cfbcf43945f29920e` | 中文 API、国际化基本用法与本地化文件文档 |
| [用户指定 API 页面](https://koishi.chat/zh-CN/api/service/i18n.html) | 2026-09-22 读取 | `define` 与 `find` 公共接口 |
| [npm 包元数据](https://registry.npmjs.org/@koishijs%2fi18n-utils/1.0.1) | `@koishijs/i18n-utils@1.0.1` | 发布版本、入口、依赖与 MIT 许可 |

同时下载了 npm `1.0.1` tarball，其 `src/index.ts` 与固定 commit 的文件逐字一致（`diff` 无差异）。npm 发布包声明 `cosmokit ^1.5.2`，当前仓库同版本 package.json 声明 `^1.8.1`；安装行为以发布包和 lockfile 为准。

上述源码通过 Git 浅克隆读取，API 页面通过 HTTP 读取。`master` / `main` 会继续变化，因此实现依据应保留以上固定链接。Koishi Client 当前声明 `cordis ^3.18.1` 与 `vue-i18n ^9.10.2`，不能把它的 `ctx.collect()` 等旧运行时调用机械移植为 Numen 当前 Cordis API。[Client 包定义](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/packages/client/package.json)

## 3. 可以直接复用的语言回退

上游公开接口如下；类型签名以源码为准：

```ts
export type LocaleTree = { [key: string]: LocaleTree }
export namespace LocaleTree {
  export function from(locales: string[]): LocaleTree
}
export function fallback(tree: LocaleTree, locales: string[]): string[]
```

`LocaleTree.from()` 将语言按 `-` 分段构造树，节点键保留完整前缀，兄弟节点顺序来自配置列表。`fallback()` 对去重的目标语言调整遍历优先级，输出目标子树及剩余语言，并包含空字符串根节点。每次调用生成临时遍历结构，不直接改写输入语言树。[算法源码](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/i18n-utils/src/index.ts)

对于 `LocaleTree.from(['zh-CN', 'zh-TW', 'en-US', 'en-GB'])`，上游测试明确规定：

| 首选语言 | 回退结果 |
| --- | --- |
| `['zh-TW']` | `['zh-TW', 'zh', 'zh-CN', '', 'en', 'en-US', 'en-GB']` |
| `['en']` | `['en', 'en-US', 'en-GB', '', 'zh', 'zh-CN', 'zh-TW']` |
| `[]` 或 `['de-DE']` | `['', 'zh', 'zh-CN', 'zh-TW', 'en', 'en-US', 'en-GB']` |
| `['en', 'zh-TW']` | `['en', 'en-US', 'en-GB', 'zh-TW', 'zh', 'zh-CN', '']` |

这比简单“地区语言 → 基础语言 → 默认语言”更宽：会尝试同语言的其他地区和剩余配置语言；未出现在树中的未知完整标签不会自行成为返回候选。[上游测试](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/i18n-utils/tests/index.spec.ts)

**文档与代码有一处顺序差异。** 官方指南的单个 `zh-TW` 示例将空语言放在末尾，当前源码测试将其放在 `zh-CN` 与 `en` 之间。本项目以固定版本源码与测试为准，不按文档示例重写算法。[指南源码](https://github.com/koishijs/docs/blob/1762722143c3cb277cc2359cfbcf43945f29920e/zh-CN/guide/i18n/index.md)

Numen 适配建议：

- 使用显式、稳定的可用语言配置构造树，不能让插件异步加载顺序决定默认 fallback。
- 在服务入口用 `Intl.getCanonicalLocales()` 规范化有效标签，避免大小写差异被上游当成不同语言。上游工具自身不验证输入；其普通对象树不应直接接收任意配置字符串，如 `__proto__`。
- 首次启动可按“已保存选择 → `navigator.languages` → 项目默认语言”选择；以后显式选择优先。保存值不可用时回退，读取存储异常不阻止启动。
- 当前只支持 `zh-CN` / `en-US` 时，不把 `zh-TW`、`zh-Hant`、`zh-HK` 静默宣称为简体中文翻译；可以回退显示简体，但选择器显示实际可用语言。
- 空语言只作为内部未指定语言候选，界面语言选项不展示空值。没有找到词条时返回首个 key，便于发现缺漏；空字符串词条本身是合法翻译，不按 truthiness 判为缺失。

## 4. 词条与渲染

Koishi `define(locale, dict)` 支持独立 locale 文件，也有 `define(locale, key, value)` 重载。Core 将嵌套对象展平成点路径，跳过 `_` 开头的字段；`render()` 以 path 为外层、locale 为内层查找，每个 locale 先查 `$locale` 用户覆盖，再查普通词条，未命中返回首个 path。[Core 源码](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/i18n.ts)

Numen 建议保持 path 优先顺序：`['errors.SPECIFIC', 'errors.GENERIC']` 应先遍历具体错误的所有语言，再找通用错误。这样保留具体含义，不因当前语言缺词便过早退为通用消息。[官方路径回退说明](https://github.com/koishijs/docs/blob/1762722143c3cb277cc2359cfbcf43945f29920e/zh-CN/guide/i18n/index.md)

词条按模块分组，放在 `locales/en-US.ts`、`locales/zh-CN.ts` 或 JSON 中即可；YAML 是 Koishi 推荐格式而非必要运行时 Contract，Numen 不必为此新增构建 loader。键名例如：

```text
numen.workbench.navigation.automations
numen.workbench.automation.save
numen.workbench.automation.draftConflict
numen.workbench.connection.status.connected
numen.workbench.errors.DRAFT_COPY_REQUEST_CONFLICT
```

插件使用自己的稳定命名空间，避免跨插件意外覆盖。Schema title / description 的翻译与 value contract 分离，页面标题存 key 并在 render 时翻译，不能在 Entry 注册时先渲染成某一种语言的字符串。[Koishi 本地化文件与配置说明](https://github.com/koishijs/docs/blob/1762722143c3cb277cc2359cfbcf43945f29920e/zh-CN/guide/i18n/translation.md) [Numen Schema 分层](08-console-webui-schema.md)

Koishi Core 用 `h.parse()`，其模板支持 `{0}`、`{name}`、嵌套属性、表达式和消息元素，输出不是普通字符串数组之外的简单文本模型。[Core 渲染](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/i18n.ts) [官方模板能力](https://github.com/koishijs/docs/blob/1762722143c3cb277cc2359cfbcf43945f29920e/zh-CN/guide/i18n/index.md)

Numen 首阶段建议只实现纯文本 `{name}` / `{0}` 插值，参数取 own property，约定缺失参数保持占位符或显式报错，测试固定该行为；不引入 `eval`、HTML、Satori 消息元素或控制流。若支持嵌套属性，应逐段验证 own property，拒绝原型链字段。日期、数字交给 `Intl.DateTimeFormat` / `Intl.NumberFormat` 并随当前 locale 变化；富文本由 Vue 组件组合，而不是 `innerHTML`。

## 5. Effect 覆盖与卸载

Koishi 当前 `define()` 注册后，清理函数只是删除本次定义的 path，没有检查后来是否被覆盖，也不恢复更早的值。这对 Numen “加载新 generation → 切换 → 卸载旧 generation” 的顺序不够：旧实例清理可能删掉新实例词条。[Core define 实现](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/i18n.ts)

Numen 应使用每次注册唯一 token 的层叠词条：最后有效定义覆盖前值；dispose 只移除自己的 token；顶层被移除时恢复仍有效的下层定义。注册与清理绑定调用方 `owner.effect()`，与当前 `ConsoleService.define(owner, ...)`、`SchemaUIRegistry.defineRenderer(owner, ...)` 一致。Map 或无原型对象存储可避免普通对象继承字段干扰。[本项目 Console 注册](../packages/console/src/service.ts) [本项目 Schema Renderer 注册](../packages/webui/src/schema-ui.ts)

纯 i18n 服务不依赖 DOM 或 Vue。可暴露 revision / subscribe 适配前端，注册、卸载、语言变化时通知；服务销毁清理订阅。`ctx.i18n.define(owner, locale, dict)` 可明确表示 caller 生命周期；若提供 Koishi 风格 `ctx.i18n.define(locale, dict)` sugar，需先证明 Cordis 服务代理能正确绑定调用方 scope。

## 6. Browser Entry staging 必须包含词条

本项目已要求 Entry 在独立 staging scope 中注册，全部验证后原子切换，失败保持旧 generation。现有 loader 对 `webuiExtensions` 注入 stage，Schema UI 也通过 `owner.get('webuiExtensions')` 进入相同 stage。[架构要求](08-console-webui-schema.md) [Loader](../packages/webui/src/loader.ts) [Stage / Registry](../packages/webui/src/extensions.ts)

词条如果直接写入全局 `ctx.i18n`，即使 page 注册仍在 stage，新翻译也会提前影响旧页面。建议将 locale registrations 纳入同一 FrontendExtensionStage / snapshot，或者给 staging Context 注入隔离的 i18n registration target。顺序必须为：

```text
加载全部 Entry → 验证 page / renderer / locale registrations
→ 同步替换所有 registry 可见状态 → 统一通知订阅者
→ dispose 旧 Fiber
```

切换前任何 Entry 失败，释放暂存词条且不发可见变化；成功后旧词条清理不能影响新快照。切换通知发出前，所有 registry 应已指向新状态，避免同步订阅者读到新页面配旧词条。插件自己的词条卸载也必须生效，不能只依赖浅复制的快照而留下僵尸值。

## 7. Vue 集成

Koishi WebUI 的 `I18nService` 创建 `createI18n({ legacy: false, fallbackLocale: 'zh-CN' })`，通过 Cordis Effect 持有 `watchEffect`，将持久化设置的 locale 同步到 Vue I18n 的 global locale；Context 初始化时把实例装到 Vue app。[i18n Service](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/packages/client/client/plugins/i18n.ts) [Settings](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/packages/client/client/plugins/setting.ts) [Context](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/packages/client/client/context.ts)

官方控制台文档展示组件 `useI18n({ messages })` 与 `setLocaleMessage()` HMR，并注明当时该能力是实验性、不能由其他插件扩展。因此 Numen 的跨 Entry staging / 可覆盖注册是针对自身 Contract 的增强，不应描述为 Koishi 已实现的能力。[官方控制台本地化](https://github.com/koishijs/docs/blob/1762722143c3cb277cc2359cfbcf43945f29920e/zh-CN/guide/i18n/translation.md)

Numen 可以为共享文本服务增加 Vue provider / `useI18n()` hook：hook 订阅 revision，组件 render 中 `t()` 读取响应式 revision，locale 变化、补充词条、覆盖卸载都触发更新；`onScopeDispose()` 清理订阅。避免 `setup()` 一次性翻译后写入普通数组或字符串，导致切语言不更新。DOM `lang`、导航 aria-label、按钮 title、空状态、验证反馈、日期数字都要一起跟随选择。页面局部表单值和用户草稿不应因 locale 切换重建。

## 8. 后端业务错误的本地化边界

Numen 当前预期业务失败通过 `ConsoleProcedureError(status, code, message, details)` 表达，code 是受校验的稳定大写标识，message 要求非空。[错误 Contract](../packages/console/src/service.ts)

建议保留 status / code / details 与领域状态、数据库事件原样；前端按 `code` 查词条并插入经允许的 details 字段，未知 code 回退到服务端 caller-safe message。持久化 Journal、日志、调试错误、插件 ID、Schema path、变量引用、用户名称不因语言切换被改写。

共享后端 i18n 服务用于真正面向用户的文本输出，locale 由调用上下文显式传入；不要让某个 Console 用户的浏览器偏好改写服务器全局 locale。无需为了界面翻译扩展认证或 RPC 协议。Schema 验证与领域判断继续产生结构化结果，UI 负责显示语言；异常详情不得为了插值直接全部展开到提示中。

## 9. 验收重点

1. 与上游测试一致的语言树回退；标签规范化、未知标签、空词条、缺失 key、参数为 0 / false、缺参行为。
2. 两插件覆盖同一路径；任意卸载顺序；旧 generation dispose 后新翻译仍然有效；顶层清理恢复下层。
3. staging 期间旧词条保持；后续 Entry 失败整体回滚；成功切换后页面与词条同步；移除 Entry 清理词条。
4. Workbench 不刷新即可切换 zh-CN / en-US，核心页面、aria / title、业务反馈、日期数字同步变化，草稿输入保持。
5. 重新加载保存语言；无可用 localStorage / navigator 时仍可启动；后端业务 code / 数据 Contract 不随语言变化。
6. 主路径全量词条 parity 检查，避免英文键已存在但中文遗漏；未知第三方错误仍有 caller-safe fallback。
