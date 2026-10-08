# N4-02：长流程面板与容器上下文

本模块接续 N4-01，实现 2026-09-30 计划中的 N4-02。流程编辑继续使用现有 Source、Presentation、Draft 历史和 Inspector 输入缓冲；没有新增全局状态仓库。

## 上下文与折叠

- 画布增加容器路径、聚焦所选容器、返回父级、返回完整流程，以及当前范围的全部折叠／展开。路径包括 Block、If 的 Then／Else、ForEach 的 Body、Parallel／Race 分支；Trigger 与流程保持独立边界。
- 聚焦是组件内的临时视图，不保存 Source 或 Presentation，不改变当前节点和 Inspector。聚焦容器临时展开，返回外层后恢复其原有折叠状态；容器被远端删除或选择移到范围外时安全退出聚焦。
- 批量折叠仅修改既有 `Presentation.collapsedNodes`，一次操作只产生一个 Undo 项。聚焦时只影响范围内的后代容器，保留范围自身、外层及无关容器；叶子、Trigger、根 Block、失效 ID 和重复 ID 不产生额外操作。只读和冲突状态沿用本地浏览折叠，不保存文档。
- 聚焦范围内定位仅展开范围内的祖先，不顺带改写范围自身和外层的折叠状态。跨范围搜索或 Problems 定位返回完整流程；拒绝丢弃未提交输入时仍保留原选择、搜索和字段原文。
- Presentation Undo／Redo 只有在 Source 内容与选择均保持一致时才保留 Inspector 输入缓冲；真正修改 Source 或选择的历史操作继续要求原有输入保护。保存回执重建等值 Source 对象也不会误判为内容变化；处理合法字段的 blur 提交后再判断历史目标。

容器辅助函数只遍历已知结构槽，不读取未知扩展内容。节点中的数组／对象输入只显示数量摘要，不序列化复杂值；完整 JSON 仍在 Inspector 中编辑。桌面上下文条在画布内吸顶，手机取消吸顶以保留可用画布高度。长中文标题、Inspector JSON 输入与错误、Problems 的错误码／说明／来源均可换行。

## 浏览器验收

Browser plugin 不可用，使用仓库 Playwright / Chromium、生产构建和真实隔离 Runtime / SQLite。fixture 包含长中文 Automation 与 Capability 名称、Cron Trigger、嵌套 If → ForEach → Parallel、多层折叠、非法循环引用诊断和未完成的 Headers JSON。测试不向外部 HTTP 服务执行请求。

新增 7 个复合场景：

1. 1440×960、780×860、390×844 完整工作区下的中文标题、错误、嵌入 JSON 与无横向溢出。
2. 聚焦、父级路径及返回完整流程不保存文档，恢复原有折叠，保持 Source、版本和输入。
3. 范围内和完整流程批量折叠／展开的持久化、单步 Undo，以及 Source 不变。
4. 搜索和 Problems 定位范围外节点时退出聚焦并定位目标。
5. 独立客户端删除聚焦容器后退出聚焦，保留大纲搜索的查询和焦点，不额外保存。
6. 延迟本地保存并由另一客户端写入，真实 `409 CONFLICT` 后服务端赢家保持不变，后续折叠只留在本地。
7. 非法 JSON 经过聚焦、返回、折叠和 Presentation Undo 后原文仍在，不出现无意义的丢弃确认。

预期的 `409` 冲突和 `422` 发布诊断分别核对，其他浏览器错误不能被忽略。纯逻辑测试补充结构槽遍历、未知扩展不透明、非法范围不回落根、批量 no-op、历史上限、保存交错、选择和 Source 变化时的输入保护。

## 验证记录

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 当前共享工作区 `pnpm test` | 126 文件 / 876 项通过 | `/tmp/numen-n402-tests.log` |
| 当前工作区 `pnpm typecheck` | 通过 | `/tmp/numen-n402-typecheck.log` |
| 当前工作区生产／示例构建 | 通过 | `/tmp/numen-n402-build.log`、`/tmp/numen-n402-examples.log` |
| 新增 Chromium 验收 | 7 项通过 | `/tmp/numen-n402-browser-first.log` |
| 共享工作区全量 Chromium | 95 项通过，2 项失败 | `/tmp/numen-n402-browser-final.log` |
| 隔离候选生产／示例构建 | 通过 | `/tmp/numen-n402-isolated-build.log`、`/tmp/numen-n402-isolated-examples.log` |
| 隔离候选最终 `pnpm test` | 126 文件 / 871 项通过 | `/tmp/numen-n402-isolated-tests-confirm.log` |
| 隔离候选全量 Chromium | 93 项通过，2.9 分钟 | `/tmp/numen-n402-isolated-browser.log` |

共享工作区同时存在其他页面的未提交布局修改。两个全量失败分别是 `automation-publish.spec.ts` 的日志和面板缩放场景：并行修改设置 System 页 `chrome.hasPanel: false`，旧测试仍在 System 页查找底部日志 Tab 或要求底部面板高 300px。N4-02 没有修改该页面、Shell 或面板显示条件；这些并行修改不纳入本模块提交。

为验证提交边界，另在 `/tmp/numen-n402-verify-k50cppkb` 从已提交基线 `0e959e2` 导出独立源码快照，只叠加本模块 14 个实现／测试文件与一个 CSS hunk，重新离线安装锁定依赖、生产构建和示例构建，不共享原工作区的构建产物。该候选的全部 93 个 Chromium 场景通过，包括共享工作区失败的两个原测试。数量差异来自未包含并行布局的 4 个新浏览器场景和 5 个单测。

隔离快照初次单测早于首次构建完成，部分包入口尚不存在；构建完成后的首次全量单测又遇到既有 `config-management.test.ts` 的顺序断言失败：`applyFresh` 先异步 Preview，再进入 Apply 队列，测试却要求数组第一项必定成功。该失败不能据此认定为 CAS 失效。单独复跑该文件 17 项通过（`/tmp/numen-n402-runtime-cas-rerun.log`），随后完整 871 项通过。该测试的并发顺序假设是后续需要修正的已知不稳定点，本模块未修改其断言或 Runtime。

工作区全量截图位于 `/tmp/numen-n402-browser-final/` 对应场景目录：

- `context-desktop-canvas.png`、`context-desktop-inspector.png`：完整桌面工作区、上下文栏、长节点名称、可读的 JSON 编辑区与错误来源。
- `context-narrow-canvas.png`、`context-narrow-inspector.png`：780px 画布与 Inspector 抽屉。
- `context-mobile-canvas.png`、`context-mobile-inspector.png`：390px 工作区、可滚动的长画布和完整可见的 JSON 编辑器。
- `context-nested-container.png`：多级路径、ForEach Body、Parallel 分支边界及数量摘要。

上述各类截图均已实际查看，并据此修正 JSON 字段宽度、Problems 重叠和手机吸顶占用。验收数据和日志位于临时目录；没有迁移、依赖升级、部署或发布。N4-03 的 100／300 节点容量和性能基线尚未实施。
