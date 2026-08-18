# 02. Numen 插件生态：Registry、Marketplace、Installer

## 1. 四层职责

```text
Registry
“插件是什么、有哪些”
   ↓
Marketplace
“如何发现与选择”
   ↓
Installer
“如何改变本地 dependencies”
   ↓
Loader
“如何加载已经存在的包”
```

四者不要混合。

## 2. Registry

参考 `@koishijs/registry`：

- 扫描 npm Registry / 预构建索引
- 插件命名识别
- 获取 Package Metadata
- 兼容版本过滤
- deprecated 过滤
- Marketplace Search Object 生成

### 2.1 包命名

框架名称已经冻结为 **Numen**。社区插件通用命名建议：

```text
numen-plugin-foo
@scope/numen-plugin-foo
```

官方包在本文档中暂用逻辑占位：

```text
@numen/plugin-foo
```

其中 `@numen/*` **不表示 npm scope 已经冻结或已占用**；实际 organization/scope 需确认 registry 可用性后再定。

### 2.2 Host 兼容性

不能只检查 Cordis：

```text
Cordis Compatible
≠ Numen Contract Compatible
```

插件应声明自己的 Numen SDK / Host API peer dependency。

## 3. Numen Plugin Manifest

在 Koishi Manifest 的基础上增加 Numen Automation Domain 静态能力摘要。npm 包可通过 `package.json.numen` 暴露该静态 Manifest；它服务于 Registry / Marketplace 的发现与兼容性分析。

```ts
interface NumenPluginManifest {
  category?: string
  description?: string
  browser?: boolean

  services?: {
    required?: string[]
    optional?: string[]
    implements?: string[]
  }

  automation?: {
    capabilities?: CapabilityManifest[]
    triggers?: TriggerManifest[]
    controls?: ControlManifest[]
    connectionTypes?: ConnectionTypeManifest[]
    credentialTypes?: CredentialTypeManifest[]
  }
}
```

Marketplace 因此可以搜索“能力”而不只是包名。

## 4. Manifest 生成

避免作者手写两份 Contract：

```text
Plugin Source
├ defineCapability()
├ defineConnectionType()
├ defineTrigger()
└ console entry
      ↓
Build/Analyze
      ↓
generated manifest
      ↓
npm publish
```

静态生成内容仅用于发现/展示，不替代运行时 Contract Registry。

概念上的 `package.json`：

```json
{
  "name": "numen-plugin-example",
  "peerDependencies": {
    "<numen-sdk-package>": "^1.0.0"
  },
  "numen": {
    "category": "integration"
  }
}
```

其中 `<numen-sdk-package>` 的实际 npm 包名随官方 scope 一起冻结；这里不提前绑定 registry namespace。

## 5. Marketplace

Marketplace 负责：

- 搜索/分类/筛选
- 展示版本、作者、兼容性、deprecated、verified
- 展示插件提供的 Capability/Trigger/Connection Type
- 触发 install/update/remove 操作

用户路径：

```text
Discover
→ Install
→ Configure Plugin
→ Create Connection
→ Create Automation
```

## 6. Installer

参考 Koishi Installer，职责保持克制：

- 读取 `package.json dependencies`
- 获取 registry version metadata
- 修改 dependencies
- 调用 npm/yarn/pnpm 等实际包管理器
- 刷新本地依赖信息
- 必要时要求 Loader full reload

不自己实现：

- tarball downloader
- lockfile resolver
- node_modules installer

## 7. 安装后的关系

Package install 与 Plugin config 是两件事：

```text
Installed package
≠ configured plugin instance
```

安装完成可提供“添加到配置树”的引导，但 Installer 不直接承担 Loader config 语义。

## 8. 更新与卸载

- Package Remove：dependencies 删除
- Plugin Disable：Loader Config key 变为 disabled
- Plugin Config Delete：删除具体实例配置

三者 UI 必须区分。
