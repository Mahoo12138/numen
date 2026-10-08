# N3-03：预览过期校验与管理通道保护

本模块基于 `475740f`，实现 2026-09-30 计划中的 N3-03。配置文件指纹只表示磁盘配置没有变化，不能证明 Provider、Connection、活动 Revision 或 Run 仍与 Preview 时相同。现在 Apply 必须携带 Host 签发的预览凭据；相关观察变化时拒绝写入，保留本地输入并要求重新预览。

## 凭据与观察范围

- Host 使用每个进程独立的随机密钥，对配置 fingerprint、完整操作和相关观察生成 HMAC。浏览器只收到不透明凭据；无法将一次预览改成另一个目标、配置内容或移动目的组。Host 重启后旧凭据失效。
- 被阻止的 Preview 不签发凭据。Host 直接调用缺少凭据报 `PREVIEW_REQUIRED`；Console 的输入 Schema 会更早拒绝缺失或不合法的凭据。凭据与当前操作或观察不匹配报 `PREVIEW_STALE`。
- 观察沿用 N3-02 有界证据链，纳入目标实例的实际状态、Fiber/Runtime 身份、相关 Definition/Provider 所有权代次，以及相关 Connection、固定版本和执行观察。移动操作还检查目的组及其祖先状态。
- 注册代次独立于毫秒时间戳，因此同一毫秒内卸载、替换并重新提供相同注册，也不能继续使用旧凭据。
- 计算时间和无关对象的扫描计数不参与校验。证据完整时，无关 Provider、Connection 或 Run 变化不使旧预览失效；标签、折叠和空组元数据操作不查询业务证据。
- 有界来源截断、不完整或不可用时，不能证明额外数据库变化与目标无关，使用进程内写入计数及 SQLite 外部连接提交版本保守失效。证据读取失败不能复用一个空结果来证明观察未变。
- 凭据按观察是否变化失效，不采用固定分钟数倒计时。签名所需的内部数据不加入影响 DTO，也不建立无界的服务器预览缓存。

内部校验额外读取相关 Connection 的 generation、配置及 Credential ID、版本激活代次、Execution/Attempt 身份。Connection 配置在 SQL 侧按单项 256 KiB、累计 4 MiB 限制读取，超过上限则保守使用变更计数。该数据只进入 Host 内部签名材料，不返回配置内容或可独立比对的内容摘要；公开影响图继续遵守 N3-02 的范围和上限。

## Apply 与落盘边界

Preview 和 Apply 在进入异步读取或队列前固定输入副本。Apply 保留原串行队列、配置 CAS、Schema 校验和管理保护，首先检查当前操作可执行且凭据有效，再准备临时文件。

临时文件写入和权限处理完成后，再检查磁盘身份、配置 fingerprint、管理保护和相关运行观察。运行校验前后均执行一次磁盘 CAS，防止插件 Schema 校验回调同步改写文件后被随后覆盖。最后的同步校验与原子 rename 位于同一个事件循环轮次，避免临时文件 I/O 期间发生的 Provider 或业务变化绕过检查。无实际文件修改的操作也必须通过凭据校验。拒绝时删除临时文件并保留原配置。

这保证当前 Host 进程的落盘前检查；不宣称 SQLite 与文件系统之间存在跨进程分布式事务。未知的动态插件行为仍在 N3-02 明示的覆盖范围之外。

## 管理保护与界面

复核修复了一处真实归属缺陷：Cordis 对 `ctx.get()` 返回的服务应用上下文代理，`provider.ctx` 可能是调用者 Context，不能作为提供者归属证据。保护逻辑现在读取 Cordis 记录的真实实现 Fiber，并保护其所属 Entry 和全部祖先组。Console、Workbench、Server 的固定入口保护继续保留；组操作、移动和配置修改不能绕过保护。

Apply 收到明确的 Host 拒绝时显示“配置未保存”；运行观察过期时保留旧证据并标记过期、禁用再次 Apply，提供“重新预览并核对”。重新预览只读取新证据，用户再次点击 Apply 后才写入。重新预览请求失败仍保留原操作和本地输入，允许显式重试。

配置 CAS 冲突继续使用原来的基线比较与显式重载流程。网络中断或未知服务异常不能证明未保存，仍显示结果不确定并读取当前状态，绝不自动重放写入。Console 的非预期失败使用既有安全 `Unavailable` 错误，不把内部异常暴露给浏览器，也不误标 `saved: false`。

已经提交文件后，通知订阅者或状态读取异常不能再作为保存前拒绝返回。回归用真实 `host-config-change` 订阅者抛出 `HostConfigError`，验证文件已保存，同时错误按结果不确定处理；正常的 Runtime 应用失败仍沿用原有 `saved: true` 返回。

## 验证

测试使用隔离临时 Runtime、配置和数据库。Browser plugin 不可用，沿用仓库 Playwright / Chromium 对真实生产构建验收。

回归覆盖凭据缺失、伪造、操作篡改、Host 重启、同毫秒 Provider 替换、配对 Definition/Provider、相关与无关业务变化、Run/Execution/Attempt 状态、活动版本、数据库外部连接写入、不完整证据降级、未就绪数据库 getter、请求入队后被修改、提交前管理服务接管、临时文件 I/O 交错和同步校验器改写文件。

新增 5 个复合浏览器场景核对真实 Preview/Apply 请求、原配置指纹保持不变时的观察变化拒绝、保留原 JSON 和过期证据、重新预览网络失败后恢复、更新证据后再次显式 Apply，以及直接 Console 请求无法绕过凭据与管理祖先保护。既有两客户端 CAS、敏感配置和响应丢失回归继续保留。故障注入只允许对应请求的一次预期错误。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm test` | 121 文件 / 782 项通过 | `/tmp/numen-n303-tests-final.log` |
| `pnpm typecheck` | 通过 | `/tmp/numen-n303-typecheck-final.log` |
| `pnpm build` | 通过 | `/tmp/numen-n303-build-final.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n303-examples-final.log` |
| 相关 Chromium 场景 | 28 项通过 | `/tmp/numen-n303-browser-targeted.log` |
| 最终全量 Chromium Playwright | 79 项通过，2.3 分钟 | `/tmp/numen-n303-browser-final.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

最终截图位于 `/tmp/numen-n303-browser-final/plugin-preview-expiry-reta-f8277--an-explicit-updated-review/`：

- `preview-expired-desktop.png`：1440×960，过期说明、原配置和旧证据。
- `preview-expired-mobile.png`：390×844，相同过期状态和保留的内容。
- `preview-expired-mobile-actions.png`：移动端禁用 Apply 与可用的重新预览、取消入口。

以上三张图均已实际查看。文字、对象 ID 和按钮正常换行，无横向溢出；长证据正常纵向滚动。所有浏览器场景核对真实页面、接口结果及配置文件，没有用重试放宽断言。

本模块不增加迁移、依赖、用户配置或自动重试策略；其他浏览器、部署与发布未在本轮验证。
