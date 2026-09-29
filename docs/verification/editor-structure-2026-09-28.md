# M2 结构编辑验收（2026-09-28）

结论：M2-01～05 已通过本报告列出的验收。

范围：`Numen-控制台与编辑器开发计划.md` 的 M2-01～05。当前为非 release 开发阶段，内部命令直接更新，不增加旧 INSERT 调用的兼容适配。本轮不提交、推送、发布包或操作日常运行数据。

## 实现边界

- Source 仍是唯一业务真相；显式目标支持前/后、空 Block、嵌套容器和非 Block 根流程。失效目标原子失败，不回落到根流程。
- Then/Else/Body/Branch 可直接编辑；非空分支删除先确认；Parallel/Race 至少保留两个分支；必需 Block 只能清空内容。
- Copy 捕获不可变快照，粘贴分配完整新 ID 映射，只重写 ValueExpr 内部引用；字面量与外部引用保持原值。Cut 只在成功粘贴时移动当前节点，失败不删除原节点。
- 移动保留 ID，拒绝后代目标和失效锚点。跨 scope 的不合法引用保持原义，Publish 编译诊断并定位，不自动重绑定。
- 完整 Source / Presentation / 选择状态以单次操作进入 Undo/Redo。折叠状态随 Draft 保存，删除时清理、复制时映射；迟到保存响应不能覆盖新编辑。
- 容器边界、折叠、流程大纲及节点/字段定位沿用现有 Workbench 布局，移除没有实现的缩放/布局按钮。英文、中文提供同一组操作。

## 验收环境

- 仓库：`/Users/mahoo/Projects/numen`，基线 HEAD `98e5b70a2a1f3b55b98c68d608f1868a4801eb06`；结果针对当前未提交工作区，包含上一阶段的 M0/M1 改动。
- macOS；Node `v22.14.0`，pnpm `10.6.3`，Playwright `1.63.0`。
- 新增结构编辑 E2E 启动隔离临时目录、临时 SQLite、localhost HTTP fixture 和端口为 0 的独立 Runtime。其中所有 Draft/Revision/Run 写操作通过浏览器 UI；直接服务读取仅用于断言。
- 截图只使用测试 Automation，不包含 bootstrap URL、Cookie 或 Credential。

## 验证记录

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | `artifacts/verification/m2-typecheck.log` |
| `pnpm test` | 81 文件 / 424 项通过 | `artifacts/verification/m2-tests.log` |
| `pnpm build` | 通过，包含最新 UI 与生产资产 | `artifacts/verification/m2-build.log` |
| 新增结构编辑 E2E | 2 / 2 通过，44.1 秒 | `e2e/automation-structure.spec.ts` |
| `pnpm build:examples` | 通过 | `artifacts/verification/m2-build-examples.log` |
| `pnpm exec playwright test` | 全套 9 / 9 通过，54.6 秒 | `artifacts/verification/m2-e2e-all.log` |
| 视觉复核 | 1440×960 桌面及 390×844 英/中文移动端已检查；无页面/Canvas 横向溢出 | 下方三张截图 |
| Impeccable 单次静态扫描 | 3 项历史样式提示；无新增 UI 文件命中 | `artifacts/verification/m2-ui-detection.json` |

静态扫描退出码 2 对应已有全局 Inter 字体、Activity 与 Automation 选中态标记的 3 项风格提示，不是编译失败。本轮保持既有视觉体系，未为这些提示重做全站样式。

覆盖重点：目标失效、必需插槽、最小分支数、后代移动、旧根删除后的悬空引用、重复/含点 ID、旧格式引用、普通字面量、前向/自引用、内部/外部引用映射、未知扩展无损移动、复制后原节点删除、剪切失效、Automation 切换、撤销/重做与并发保存、冲突状态下选择不得恢复编辑。

浏览器路径：Cron → HTTP → If → ForEach → Echo 从空草稿搭建；副本内部引用映射；非空 Else 和 Parallel/Race 分支删除及恢复；跨 scope 剪切粘贴后 Publish 拒绝与 Problems 字段定位；延迟保存响应期间继续修改；刷新恢复 Source/折叠状态；大纲定位隐藏子节点；归档后的本地展开和大纲导航保持整个 Draft 不变；390×844 的真实插入和中英文菜单；发布、激活与手动 Run 调用本地 HTTP fixture，校验 Echo 输出。手动 Run 后 Automation 仍保持 Disabled，不改变正式 Trigger 启用意图。

## 截图

- [桌面：嵌套结构与大纲](../../artifacts/verification/m2-structure-desktop.png)
- [移动端：Else 与容器插入入口](../../artifacts/verification/m2-structure-mobile.png)
- [移动端中文：循环体内完整操作](../../artifacts/verification/m2-structure-mobile-zh.png)

截图等待 Inspector 抽屉退出视口后采集；最终复核结构层级、操作可达性、文案和周边布局。自动化同时检查页面与 Canvas 的水平溢出，实际执行插入、撤销、菜单关闭和语言切换。

## 已发现并修复的问题

- 嵌套表达式诊断（如 `input.message.parts.0`）原先只选中节点，不聚焦字段。字段焦点匹配现在包含子路径，并避免相似字段名误匹配；Problems 的显式字段请求优先于 Canvas 卡片聚焦，字段在渲染完成后可重复接收焦点，不依赖原生 autofocus。已先复现失败再修复。
- 无可用目录时的 Add step，以及预览中没有 handler 的 Undo/Redo 入口原先可能看似可用，现在明确禁用。
- 只读时折叠/展开与大纲定位使用本地视图状态，归档或冲突 Draft 不因导航而保存或解除锁定。
- 任意嵌套 Block 的重复标题已合并；移动目标显示结构路径，菜单成功操作后恢复到选中节点的焦点。

## 保留的边界

- 不包含拖拽；当前菜单和目标入口完成结构编辑。
- 命令层缺少扩展内部引用语义契约，因此所有扩展 Control（及包含扩展的子树）暂不支持复制；查看、诊断、移动、删除及原样保存支持。含点 ID 和无法识别的引用同样明确禁用复制。
- 剪贴板为当前 Automation 的页面内状态，刷新或切换 Automation 不保留；不是系统剪贴板或跨 Automation 复制。
- 跨 scope 引用诊断在 Publish 的权威校验时显示，Draft 仍允许保存暂时不合法的编辑状态。
- M3 的试运行与离开保护、M4 插件管理和配置 CAS、M5 综合产品验收尚未完成。本轮结果不代表这些后续阶段或 npm 独立分发已经验收。
