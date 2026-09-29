# M3 配置与调试验收（2026-09-28）

范围：控制台与编辑器计划 M3-01～04。当前处于非 release 开发阶段，内部接口直接更新，没有增加新旧请求兼容分支。本记录不代表 M3-05、M4/M5 或发布验收已经完成。

## 实现

- **Inspector**：统一字段默认值、必填、可用性、变量来源与诊断；非法 JSON、数字、日期、Reference/Template 文本保留在组件中。只提交合法值；明确丢弃后从 Source 重置，取消则保持内容。Execution Policy 仅配置现有 timeout/retry，重试受 retrySafe 限制。
- **文档状态**：区分未提交输入、Draft 保存阶段、已发布版本、活动版本、enabled 意图及实际 Trigger 订阅状态。保护节点、页签、Automation、应用路由、前进/后退和页面关闭；没有浏览器 Draft 副本。
- **发布版本试运行**：选择固定 Revision 与输入契约，显式提供 Trigger 数据，提示真实副作用；不改变激活、启用或订阅。响应不确定时冻结完整请求并复用 requestId；Run 历史保留来源、版本和请求 ID。
- **执行数据**：按需、鉴权、no-store，按发布契约的显式标量字段分类投影。未知字段与敏感内容保持隐藏，数据库读取和最终响应均有界；纯文本展示，关闭/换 Run 后清除并忽略迟到响应。Execution 与有效 Source 节点双向定位，Attempt 明示当前 Execution 数据。

## 代表性失败路径

1. 非法 JSON/数字失焦、取消节点/页签切换、取消浏览器刷新/后退，Source 与输入均保持；确认丢弃后恢复原值并清除 pending 状态。
2. 保存已在服务端接受但响应延迟时取消离开；保存网络失败后取消切换保留本地内容，确认切换后读取耐久版本。
3. 第二个真实 HTTP 客户端抢先保存产生 409 冲突；比较期间保留无效输入，明确丢弃后清除缓冲、恢复服务器字段和版本，刷新不复活丢弃内容。
4. 聚焦字段合法编辑后单击 Publish；聚焦运行参数合法编辑后单击 Start Run。后者验证实际请求和 Execution 输出使用新参数，同时覆盖响应丢失后的去重恢复。
5. r1 激活并有真实 Cron 订阅时试运行未激活的 r2；运行契约、输入和 Trigger 正确，r1 激活状态、启用意图和订阅均保持。
6. 私密 HTTP URL/Header/Body 不进入查看响应、URL 或存储；显式公开的 HTML 样式文本不能执行。错属 Run/Execution/Attempt、损坏耐久 JSON、超大值、旧响应和关闭面板均有针对性验证。
7. 可选 Trigger 服务从缺失到晚加载再卸载：健康状态出现/消失，Draft 与 CRUD Provider 始终可用。

验收期间修复了启动入口在 beforeunload 提前销毁页面、提交状态导致 Publish 移位漏点、合法输入误禁用 Start Run、归档前聚焦字段漏提交、默认值复选框取消后失真等组合问题。

## 环境与证据

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 生产资产构建通过 |
| `pnpm build:examples` | 独立插件产物构建通过 |
| `pnpm test` | 90 文件 / 458 测试通过 |
| `pnpm exec playwright test --output=/tmp/numen-m3-final-browser --workers=1` | 全部 17 用例通过（约 1.2 分钟） |
| 手机状态样式调整后，单独重跑语言切换与 Revision 试运行 | 2/2 通过（8.8 秒），发布/活动版本在 390px 均可见 |
| `git diff --check` | 通过 |

完整命令日志保留在 `/tmp/numen-m3-{build,typecheck,unit,examples,final-e2e}.log`，浏览器截图在 `/tmp/numen-m3-final-browser/`。桌面和窄屏截图已实际查看；数据面板、主操作、纯文本与敏感占位没有横向溢出。手机端保留 Draft/Published/Active/Enabled 全部状态，避免继承旧样式隐藏版本关系。

最新手机验收日志为 `/tmp/numen-m3-mobile-final.log`，截图在 `/tmp/numen-m3-mobile-final/`。

macOS，本地 Node 22.14.0、pnpm 10.6.3、Playwright 1.63.0 Chromium；使用生产 Workbench 资产、独立临时 SQLite 数据库和本地随机端口。Browser 技能不可用，沿用仓库 Playwright 工作流。桌面 1440×960、窄屏 390×844，覆盖英文和简体中文。

新增浏览器流程检查真实页面内容、标题/路由、交互结果及 pageerror/console.error。仅精确允许测试刻意注入的单条网络失败或真实 Draft 冲突 HTTP 错误；不泛化忽略应用错误。

静态 UI 检测仅保留既有 Inter 字体和两处选中侧边标记共 3 个告警，与 M2 基线一致；本轮保持现有设计体系。

## 未完成范围

- **M3-05 未实现**：[Draft 固定快照设计](../23-draft-test-snapshot-design.md)已给出存储、事务、资源所有权、保留寿命和测试设计，等待确认“只测试已保存 Draft、快照与 Run 历史同寿命”的数据决策。没有改动快照表或回收策略。
- 不声称 WebKit/Firefox、真实第三方外部副作用、容器重启、发布产物或 M4/M5 管理流程已在本轮验收。
- 第三方缓存文本的 Renderer 必须上报字段状态；Host 无法推断插件私有缓冲。Attempt 目前没有独立历史 I/O 快照；数据查看仍遵循 Execution 当前耐久值边界。
- 全局页面既有底部占位状态和插件管理入口属于后续阶段。
