# 通用组件与 npm 发布

官方包统一使用 `@numenjs/*`。这次搭建开发和发布流程，不执行远程发布。

## 包边界

仓库继续使用 pnpm workspace + TypeScript project references；不增加第二套任务编排工具。

| 路径 | 职责 | 本次发布范围 |
| --- | --- | --- |
| `packages/components` | Vue 通用控件、Schema Literal 编辑器、主题、翻译注入、插件 Vite 适配器 | `@numenjs/components` |
| `packages/webui` | Browser Cordis Runtime、Page/Slot/Renderer 注册、Entry 生命周期 | `@numenjs/webui` |
| `packages/console` | 服务端 typed Console 与 Entry 协议 | `@numenjs/console` |
| `packages/core` | 插件使用的领域 Contract | `@numenjs/core` |
| `packages/i18n`、`packages/logging` | SDK 所依赖的共享服务 | 对应同名包 |
| `packages/workbench` | 页面、业务状态、领域交互、宿主布局 | private 应用包 |
| 其余 `packages/*` | 现有服务、内置集成、Runtime、CLI | 暂时保持 private |
| `examples/components-plugin` | 可独立构建、真实注册/卸载的示例插件 | private 示例 |

可发布包的运行依赖形成闭包，不依赖 private workspace 包。宿主的 Vue 和 Cordis 由
peerDependencies 约束，避免插件安装独立的运行时实例。当前 Cordis 为预发布版本，明确固定为已验证的 `4.0.0-rc.8`，升级时需重新验证宿主和插件。前端控件包本身不依赖
Console、Core、数据库或 Workbench；Schema 类型为 UI 层契约，领域验证仍在服务端。

已提取 SelectMenu、Button、StatePanel、FormSection，以及 string/number/boolean/enum/JSON/
duration/ISO date-time 编辑器。Workbench 的选择器、Schema Registry、状态页、Inspector
使用这些实现。Automation AST、Connection/Credential 服务等继续留在业务包，不作为通用控件暴露。

## 插件使用与共享运行时

示例见 [`examples/components-plugin`](../examples/components-plugin/README.md)，API 见
[`packages/components`](../packages/components/README.md)。

1. 服务端通过 `ctx.consoleEntries.addEntry(ctx, ...)` 注册产物。
2. 前端默认导出 Cordis 插件，用 `ctx.webuiExtensions.page(ctx, ...)` 或
   `ctx.schemaUI.defineRenderer(ctx, ...)` 注册组件。
3. 使用 `@numenjs/components/vite` 的 `numenPluginRuntime()` 编译 frontend Entry。
4. 产物从 `/workbench/vue.js`、`/workbench/cordis.js`、`/workbench/components.js` 加载宿主共享模块。
5. 组件继承宿主翻译与 CSS；Entry 卸载由现有 Fiber/Registry 清理。

宿主稳定 URL 是 facade；它们引用同一次构建的哈希 chunk。Core Entry、第三方 Entry
和 Vue 树使用同一个 Vue 模块，所以 inject、响应式和生命周期保持一致。浏览器重新
加载宿主后采用新的 facade；运行中的插件必须与宿主 API 版本兼容。

TypeScript 插件项目使用 `module: "ESNext"`、`moduleResolution: "Bundler"`。当前 Cordis 的声明包含无扩展名的内部路径，直接使用 NodeNext 解析其类型会失败；这不影响构建后的 Node ESM 运行。

当前 Entry 清单在浏览器启动及订阅重连时重新协调；服务端卸载不会主动推送新清单。开发时重新加载页面可获取新的插件列表。一次快照内的注册/卸载仍由 Cordis Effect 管理。

`numenPluginRuntime` 只面向生产 Entry 构建。示例使用单 JS bundle，避免 Entry 资产端点
相对路径变化导致 chunk/CSS 丢失。插件自有 CSS/资源应注册为已有 Console 资产机制支持的
资源；适配器仅处理组件库 CSS，不能自动托管任意插件资源。

目前复用目标为 **Numen 插件**，不声称兼容 Koishi 插件 API 或 VS Code Extension API。
参考的是 Koishi 的公共客户端组件/插槽边界，以及 VS Code 的公开扩展契约。

## 本地构建、验证和打包

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:examples
pnpm test
pnpm test:e2e
pnpm release:check
```

`release:pack` 调用每个 public 包的 `pnpm pack`（触发各自 prepack 构建），检查导出
目标、workspace 协议转换、private 依赖和 tarball 内容，并生成
`artifacts/npm/*.tgz` 与 SHA-256 清单 `manifest.json`。

`release:check` 在系统临时目录创建独立 npm 消费者，安装这些 tarball，验证类型声明、
ESM/SSR、Cordis 服务、插件构建入口、CSS 和 Vite 生产构建，然后清理临时目录。
此过程可能下载公共依赖，但不会发布包、访问 npm 凭据或修改 registry。

## 版本与发布

Changesets 管理六个 public 包的固定版本组；private 应用与示例不发布。当前源码版本
保持 0.1.0；提交的 changeset 将在维护者执行 version 后产生下一版本和 CHANGELOG。

```sh
pnpm changeset                 # 后续功能记录变更
pnpm version:packages          # 生成版本、CHANGELOG，并更新 lockfile
pnpm release:verify
pnpm release:check
# 维护者审阅并提交版本变更后，在具备 @numenjs scope 权限的环境中执行：
pnpm release:publish
```

`release:publish` 先运行完整验证，再调用 Changesets publish。首次正式发布前确认 npm
scope 的实际权限、包版本和项目许可证；仓库当前没有许可证，本文不替作者选择授权条款。
本次未执行 `version:packages` 或 `release:publish`。

GitHub Actions `npm-release.yml` 只有手动触发，默认 operation=pack；publish 需要显式
选择。配置 `npm-release` Environment 和其中的 `NPM_TOKEN`，可在仓库设置中加保护规则。
流程测试后上传 tarball；只有 publish 分支使用 token。不会因 push 或 merge 自动发布。
CI 检查整库测试、浏览器回归、以及真实外部 npm 消费。

## 参考

- [Koishi 客户端开发](https://koishi.chat/zh-CN/guide/console/client)：公共布局组件和插槽贡献。
- [VS Code Webview](https://code.visualstudio.com/api/extension-guides/webview)：自定义 UI 与宿主扩展接口的边界。
- [pnpm workspace](https://pnpm.io/workspaces)：打包时把 workspace 协议转换为发布版本。
- [Changesets 版本与发布](https://changesets.dev/guide/versioning-and-publishing)：版本记录、打包及显式发布。
