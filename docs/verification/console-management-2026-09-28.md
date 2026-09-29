# M4 控制台管理与命令验收（2026-09-28）

本轮继续 Console / Workbench 开发计划的 M4。沿用当前开发版 API，未增加旧协议适配层；未提交、发布、部署或修改用户实际运行配置。M3-05 的 Draft 快照数据模型仍待确认，没有通过本轮工作隐式采用该方案。

## 实现范围

- **M4-01 命令入口**：Shell 内共享命令注册表，命令 ID、可见条件、禁用原因、快捷键和执行路径统一。Command Center、工具栏和键盘复用现有 Source 命令及文档保护。覆盖创建、页面导航、撤销/重做、复制/剪切/粘贴、移动、发布、查看运行、打开 Revision 试运行表单、面板开关。处理输入框、IME、重复按键、弹层、焦点恢复和作用域释放；仅打开试运行参数表，不绕过已有提交检查。
- **M4-02 宿主写入**：宿主提供唯一配置管理服务，文件指纹 CAS、串行落盘与应用、保注释 YAML AST 和原子替换。显式 setEnabled，报告“已保存”和“运行时已应用”的不同结果，保护当前 Console / Workbench / Server 及其祖先与实际管理服务 Provider。实现和边界详见 [宿主配置验证](host-config-management-2026-09-28.md)。
- **M4-03 插件管理**：替换占位页，显示用户配置实例/分组、稳定 ID、来源、安装信息、自身启用、父级影响、实际 Loader 状态和内部模块只读诊断。支持分组创建/改名/折叠/移动/空组删除及可管理配置编辑；先预览受影响实例及未知影响提示，再提交冻结的明确操作。冲突保留表单；响应丢失只重新读取，不重放 toggle。
- **M4-04 Entry 在线更新**：Console 自有通用订阅，manifest 使用 epoch、revision 与 Entry incarnation；每个 Entry 的资源版本稳定。保留未变化 Fiber 与 locale stage，明确撤回立即生效。迟到 manifest/import、断线重连、注册表重启以及其他 Entry 加载失败不能复活已撤销 Entry。无关 Entry 上下线不重挂 Workbench 或丢掉其未提交输入。
- **M4-05 真实状态与关联导航**：Home 近期 Automation / Run 可直接打开；Runs 提供状态筛选并将 Automation、cursor 和分页历史保留在 URL，详情、日志、刷新和返回共享上下文。Connections 显示当前 Draft/Active Revision 的结构引用、插件排查和关联日志入口；同时响应连接与自动化失效通知并允许重试。System 展示有观测时间的存储、调度、触发订阅、连接和日志状态，缺失服务明确不可用。默认底部面板仅保留 Logs，移除假的 Problems 计数、Preview 和无保存对象页面的 Saved 状态。

## 验证重点

实际修复并回归了三个联调问题：

1. Command provider 依赖每次 render 新建的 navigation，形成父子响应式更新循环。Shell 现在仅在真实导航变化时重建 navigation，生产浏览器真实编辑恢复。
2. 无 props 声明的 functional ToolbarButton 导致 Vue 合并新旧 onClick；改为显式 setup props 后，真实挂载点击只调用命令一次，fallback 不触发。
3. Connection usage 最初只监听 Automation，连接新建后会保留旧查询。现在监听两类失效事件；回归覆盖失败后重试、无关事件不刷新、迟到响应和卸载清理。

代表性复杂验证包括：两客户端 CAS 冲突与表单保留、服务器已落盘但浏览器响应丢失、分组关闭/恢复保留成员意图、稳定 ID 跨组移动与重启、首次启用及重新配置失败恢复、管理通道保护、内部模块归属、敏感配置脱敏、服务卸载后健康状态清除、嵌套 Source 引用识别、Entry 撤销与并发加载竞争、未提交 JSON 在无关 Entry 变化后保留、快捷键/工具栏/命令面板单次操作、IME/重复按键/弹层与焦点边界。

## 本轮结果

实际执行并通过：

| 检查 | 结果 |
| --- | --- |
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | 锁文件与补丁安装路径一致，无需修改锁文件 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 98 个文件，490 项通过 |
| `pnpm build` | TypeScript 与生产前端资产构建通过 |
| `pnpm build:examples` | 独立插件构建通过 |
| `pnpm exec playwright test --output=/tmp/numen-m4-browser-final` | 23 项通过，涵盖已有 M2/M3 与新增 M4 路径 |
| `git diff --check` | 通过 |

最后的只读配置收口和按钮文案修正后，另复跑管理页面 2 项用例，全部通过（`/tmp/numen-m4-management-last.log`）。桌面 1440×960、窄桌面 900×800、移动端 390×844、中英文均有真实浏览器覆盖；图片已人工查看，包含活动栏、工具栏、主内容与底部面板布局，不只截取孤立组件。

所有浏览器使用临时 Host 与临时配置。构建和测试日志、截图位于 `/tmp/numen-m4-*`，主要文件为 `/tmp/numen-m4-unit-final.log`、`/tmp/numen-m4-build-final.log`、`/tmp/numen-m4-browser-final.log`；浏览器截图按用例存放于 `/tmp/numen-m4-browser-final/`。常见 `NO_COLOR/FORCE_COLOR` 运行器提示不是应用错误；预期的冲突 409 与主动模拟丢失响应在测试中明确识别，其余页面异常/控制台错误会使相应用例失败。

## 明确边界

- 插件影响列表仅提供最多 100 个各类候选对象，始终标为 unknown；尚没有完整的插件→业务对象依赖图，不把无法推断解释为无影响。
- Loader 没有通用包版本接口，版本未知时明确显示未知；未加载外部包的安装状态也不猜测。通用配置编辑仅面向可管理实例；敏感或受保护配置通过宿主本地维护。
- System 展示主动读取的快照和观测时间；日志有自己的实时订阅。没有将快照健康状态伪装为持续采样的监控。
- Connection 引用范围限当前 Draft 和 Active Revision，不包括历史 Runs 和其他已发布版本；扩展控制节点的动态引用明确不完整。
- 文件系统对不参加锁的外部编辑器没有通用原子比较交换；检测到外部漂移后要求先重启对账。具体边界见后端记录。
- pnpm 依赖补丁与 Dockerfile 路径/所有者修正已入源码，本轮没有构建/启动 Docker 镜像，也没有远程 CI、发布或 registry 消费验收。
- 后续为 M5 的跨模块组合验收。M3-05 Draft 快照试运行继续等待持久化方案确认，不属于本轮已完成内容。
