# N4-01：拖拽移动与节点搜索定位

本模块基于 `5beb25f`，实现 2026-09-30 计划中的 N4-01。沿用已有 Source 命令、Draft 文档历史与 Presentation，不增加第二套流程状态。

## 拖拽与文档边界

- 桌面节点提供拖动手柄。前置、后置和移入 Block 三种落点分别生成明确的 `AutomationInsertTarget`，最终只提交一个现有 `MOVE_TO`。触发器只能在触发器序列内排序，根节点和固定分支／循环体不能作为可移动节点。
- 纯落点解析复用既有结构命令校验。祖先移入后代、跨触发器／流程、失效节点或锚点均被拒绝；同位置放下不产生命令、保存或 Undo 项。悬停只校验，不修改文档。
- 拖动会话固定起拖的 Source 对象以及悬停节点、位置和已解析目标。Source 被替换、文档变为不可编辑、Escape、拖拽结束、窗口失焦或组件卸载都会取消会话。离开落点清除悬停意图，离开窗口也暂停边缘滚动。即使只是保存回执或同内容后台刷新替换 Source，也保守取消当前拖动。
- Drop 必须与已接受的悬停位置一致，再检查当前 Source 与结构。Workspace 在处理未提交字段后再次核对起拖 Source，防止字段提交使拖拽意图失效。目标消失时不重新选择容器，也不回落到根。
- 空 Block、固定接收槽和折叠的独立 Block 均可接收移动。祖先展开、选中节点和 Source 改变由现有文档 reducer 一次处理；一次 Undo 恢复原结构、选择和折叠状态。延迟保存回执不能覆盖已撤销的内容。
- 画布边缘持续拖动会纵向自动滚动；取消和卸载清理动画帧及监听器。已有菜单、剪切粘贴和键盘移动保留。窄屏及粗指针隐藏拖动手柄，继续使用原有移动入口。

真实 Chromium 测试发现：起拖时插入占据布局空间的落点，会把下方的来源节点推出视口，触发浏览器立即 `dragend`。最终落点覆盖显示于节点头部、插入区和折叠 Block 中部，不改变起拖时的几何位置。相同原生鼠标操作修复后通过；没有延长测试超时规避故障。

## 安全搜索与定位

流程大纲增加搜索框，按显示名、稳定 Source ID 和显式 `capability.id@version` 匹配，支持大小写、Unicode NFC 和跨字段多词匹配。搜索不读取摘要、输入、连接配置、表达式或未知扩展数据；不存在、重复歧义的 Source 身份不会成为结果。

显式定位展开祖先、滚动并选中节点；只读／冲突状态使用既有本地展开规则。搜索导航沿用 Inspector 未提交输入保护：拒绝丢弃时保留原文、原选择及打开的大纲，明确接受后才定位。后台刷新即使删除当前节点并选择回退节点，也不打断大纲搜索的焦点。IME 组合中的 Enter、方向键和 Escape 不触发定位或关闭。

## 验证

Browser plugin 不可用，使用仓库 Playwright / Chromium、生产构建及真实的隔离临时 Runtime 和 SQLite。复杂初始树由测试 fixture 建立，正在验收的拖拽、撤销、搜索和确认均通过浏览器交互；后台删除和并发写入由独立 Runtime 调用制造。

新增 7 个复合浏览器场景，覆盖 before／after／inside 持久化与单次 Undo、嵌套子树 ID 保留、祖先／后代拒绝、Escape 无写入、长画布自动滚动、拖动中远端删除目标、保存中真实 CAS 冲突、敏感值搜索负例、隐藏节点展开、后台更新及删除后的焦点保留、非法 JSON 拒绝／接受导航。预期的冲突响应单独核对，其余浏览器错误不忽略。

纯逻辑与会话测试额外覆盖触发器隔离、固定结构槽、空容器、未知扩展内容、重复投递、外部拖入、no-op、失效末尾锚点、组件卸载和监听清理；文档组合测试验证移动后 Undo 与延迟保存交错。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm test` | 124 文件 / 825 项通过 | `/tmp/numen-n401-tests-final.log` |
| `pnpm typecheck` | 通过 | `/tmp/numen-n401-typecheck.log` |
| `pnpm build` | 通过 | `/tmp/numen-n401-build.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n401-examples.log` |
| 既有结构、命令、文档保护 Chromium 回归 | 8 项通过 | `/tmp/numen-n401-existing-browser.log` |
| 新增 Chromium 验收 | 7 项通过 | `/tmp/numen-n401-browser-second.log` |
| 最终全量 Chromium | 86 项通过，2.7 分钟 | `/tmp/numen-n401-browser-final.log` |
| 增补 390px 搜索／定位边界 | 同一生产构建单例通过 | `/tmp/numen-n401-browser-mobile-final.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

最终全量截图位于 `/tmp/numen-n401-browser-final/` 对应场景目录：

- `nested-drag-desktop.png`：移动子树后的结构、选中节点和单次 Undo 入口。
- `rejected-descendant-drop.png`：正在拖动的非法后代落点与拒绝说明。
- `auto-scroll-drop.png`：长画布自动滚动后放下的末端节点。
- `search-located-desktop.png`：1440×960，展开多个祖先后的节点、滚动与 Inspector。
- `search-narrow.png`：780×860，搜索框、Capability 与稳定 ID 结果及完整窄屏工作区。

补充手机截图位于 `/tmp/numen-n401-browser-mobile-final/automation-drag-search-sea-a9b6f--not-steal-focus-on-refresh/search-mobile.png`，390×844 下确认手柄隐藏、搜索和定位正常、页面及画布无横向溢出。桌面拖拽、非法落点、自动滚动以及桌面／窄屏／手机搜索截图均已实际查看。手机断言在全量完成后加入同一搜索场景并单独重跑，产品代码和生产构建未改变。

本模块没有迁移、依赖升级、部署或发布。移动端完整拖拽、多选、跨 Automation 剪贴板、自动连线以及 N4-03 的容量／性能承诺不在本轮范围。工作区同时出现的运行页、系统页布局修改保留在其原位置，不纳入本模块提交；浏览器验收使用当前工作区的生产构建。
