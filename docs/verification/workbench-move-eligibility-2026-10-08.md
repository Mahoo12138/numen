# Workbench 拖拽资格计算优化

本模块接续文案缓存优化提交 `30e0dfcef7d23f7fab8111f7cb8a5c26e6d802b1`，只优化流程节点绘制时的移动资格计算。之前的 CPU 采样指出 `nodeHeader` 为了读取 `canMoveTo`，逐节点调用完整 `automationStepEditOptions`，连带执行复制安全校验、全 Source 遍历和节点子树克隆。

## 复现与实现

先用真实 `StructuredAutomationFlow` 和固定容量夹具构造渲染回归。旧实现在 100／300 节点初次绘制时分别触发 72／200 次 `structuredClone`，两项零克隆断言失败；只读场景通过。修改后相同三项全部通过，所有拖拽柄 ID 仍与未改动的 `automationStepEditOptions(...).canMoveTo` 逐项一致。日志为 `/tmp/numen-n405-render-red.log` 和 `/tmp/numen-n405-render-green.log`。

新增 `automationMovableNodeIds(source): ReadonlySet<string>`，一次遍历完整 Source，收集非空 Trigger ID 与 `Block.steps` 的直接成员 ID。组件内使用 Vue `computed` 保存该派生集合，节点标题只查集合；Source 替换或响应式结构变化后重算。没有跨文档全局缓存，也不以当前可见／聚焦子树替代完整 Source。

保留的边界：

- root、then／else、循环 body 和并发／竞速 branch 的必需槽位不能独立移动；槽位内普通步骤可以移动。
- 重复 ID 沿用原有“存在任一 Trigger／sequence member 即可”的展示语义；空 ID 保持不可移动。本轮不改变非法 Draft 的处理规则。
- 未知扩展、缺失字段和 opaque payload 不参与这个结构投影；复制安全性仍由原有逻辑判断。
- `canEdit`、拖拽开始时的当前 Source 检查、过期会话取消以及 drop 时的 `MOVE_TO` 目标／后代校验都保持不变。展开菜单、全局命令及复制操作仍使用完整校验。

9 项新结构测试覆盖所有槽位、重复／空 ID、不可复制的扩展移动、不完整 Wait／未知表达式、payload getter 零读取、Source 更新与旧集合隔离、过期节点／落点拒绝，以及 1000 次查询不再访问 Source。首轮相关结构编辑、结构命令、拖动会话共 58 项通过；补充的不完整 Draft 场景纳入最终全量单测。

新增生产浏览器用例让同一 ID 在必需槽位和普通 sequence 之间来回变换，检查手柄出现／消失，验证聚焦视图使用完整 Source，并实际拖入容器、保存和单次 Undo；移动端继续检查聚焦、资格和无横向溢出。首次编写时修正了槽位 Block 选择器与手机 Inspector 遮挡，截图另等待关闭动画完成；没有改变产品行为来迁就测试。

## 性能对照

前后均使用独立源码目录 `/tmp/numen-n403-verify-dqg1y1zq`，先从上述基线重新导出，再仅加入本轮两个产品文件。沿用 Apple M4、10 逻辑核、24 GiB、Darwin 25.6.0 arm64、Node 22.14.0、Chromium 153.0.8010.12、1440×960、单 worker、禁用 HTTP 缓存的 production 构建；没有 CPU／网络节流。

优化前重新测量 300／1000 节点，优化后执行完整五组；每组使用 20 个正式交互样本、独立预热、3 次冷导航、10 轮生命周期。每次字段提交后另等保存并核对 Source／不可变 Revision，600ms 自动保存 debounce 不计入字段本地提交时延。1000 节点仍是压力探针。

正式五组全部通过（4.9 分钟），沿用 nearest-rank 分位数。以下单位为 ms，前后比较仅使用本轮重新测量的 300／1000 节点：

| 节点 | 操作 | 优化前 P50 / P95 | 优化后 P50 / P95 | P95 变化 |
| --- | --- | --- | --- | --- |
| 300 | 选择 | 76.7 / 79.1 | 70.9 / 74.1 | 降低 6.3% |
| 300 | 字段本地提交 | 74.7 / 75.9 | 68.4 / 69.5 | 降低 8.4% |
| 300 | 隐藏节点定位 | 31.9 / 32.6 | 31.3 / 33.5 | 增加 2.8%（0.9ms） |
| 1000 | 选择 | 268.8 / 271.3 | 224.9 / 227.8 | 降低 16.0% |
| 1000 | 字段本地提交 | 270.4 / 274.1 | 225.7 / 228.7 | 降低 16.6% |
| 1000 | 隐藏节点定位 | 56.0 / 56.7 | 48.3 / 49.8 | 降低 12.2% |

300／1000 节点首次路由就绪中位数为 234.2→222.9ms、498.0→457.0ms。每项仅 3 次冷导航，不当作标准 TTI 或稳定尾部估计。300 节点定位未体现改善，保留其实际结果；本轮没有挑选最快一轮，也没有改变预算。

| 优化后场景 | 首次就绪中位数 | 选择 P95 | 字段 P95 | 定位 P95 | Apply P95 | 十轮后 GC 堆增量 KiB |
| --- | --- | --- | --- | --- | --- | --- |
| Automation 100 | 149.0 | 33.4 | 29.8 | 32.9 | — | +380.1 |
| Automation 300 | 222.9 | 74.1 | 69.5 | 33.5 | — | +333.3 |
| Automation 1000（压力） | 457.0 | 227.8 | 228.7 | 49.8 | — | +393.6 |
| Plugins 100 | 110.2 | 实例 32.7 / 分组 32.4 | 27.2 | 109.2（整页） | 66.6 | +362.3 |
| Plugins 300 | 134.7 | 实例 33.1 / 分组 33.0 | 26.7 | 140.0（整页） | 164.4 | +349.2 |

五组满足 N4-03 冻结的本机回归预算。每组 11 个 Home 样本的 DOM、监听器、浏览器／宿主订阅及连接计数逐轮一致，pending／closing 为 0；仍保留上述堆增量，不能声称无泄漏。1000 节点交互 P95 仍约 229ms，不转为官方容量保证。插件和 100 节点本轮只测最终候选，不据此报告前后改善率。

[前后对照](workbench-move-eligibility-comparison-2026-10-08.json) 保留优化前原始样本、夹具哈希和百分比；[优化后完整数据](workbench-move-eligibility-after-2026-10-08.json) 由现有严格汇总器生成，保留长任务、真实保存／Apply 和生命周期记录。所有数字均来自本轮运行。

## 验证与候选身份

| 检查 | 结果 | 本机日志 |
| --- | --- | --- |
| `pnpm build` | 通过 | `/tmp/numen-n405-after-build.log` |
| `pnpm typecheck` 与 benchmark 独立类型检查 | 通过 | `/tmp/numen-n405-typecheck.log`、`/tmp/numen-n405-harness-typecheck.log` |
| `pnpm test` | 131 文件 / 923 项通过 | `/tmp/numen-n405-tests.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n405-examples.log` |
| 新增 Source 切换／聚焦／移动／Undo 浏览器用例 | 通过 | `/tmp/numen-n405-drag-scoped.log` |
| 完整性能基准与严格汇总 | 5 组通过 | `/tmp/numen-n405-after.log` |
| 完整 Playwright 回归（包含最终截图等待） | 103 项通过 | `/tmp/numen-n405-regression.log` |

完整浏览器回归中，新用例与既有冲突、过期拖拽、后代落点保护、未提交输入、快照和插件配置等组合场景全部通过。已实际查看 1440×960 桌面与 390×844 手机截图；手机最终图已等待 Inspector 离开视口，聚焦后的必需容器无拖拽柄、内部子节点资格仍保留，交互无横向溢出。页面标题／路由、非空画布、无框架错误遮罩和页面错误日志也由真实浏览器用例核对。

优化前 production assets SHA256 为 `8fcfc9fa4e35070a6a612d90122a75733c782f5a5436c58b6906bd32d7095a92`，与已验证的 `30e0dfc` 产品一致。原始 before 报告保留调用时提供的短 SHA `30e0dfc`，对照文件另记录完整基线提交；不改写原始测量元数据。优化后 assets SHA256 为 `4594bf04cf27101dbb4b5b09276478bfc74e4aba171f27590ce24c7e465f63cc`。两个产品文件的 SHA256 同时保存在对照 JSON。

归档运行的 `sourceHead` 表示基线提交，`sourceWasDirty: false` 不表示未叠加本轮改动；候选由明确的两个产品文件及实际构建资产哈希识别。

最终再次核对普通 production assets 哈希与正式测量完全一致，主工作区两个产品文件和三个测试文件与隔离验证副本逐字节一致。提交不包含原计划或其他任务的未跟踪截图目录。

Browser plugin not available；使用仓库已有 Playwright／Chromium 和临时 Runtime／SQLite，不新增浏览器依赖。受测路径为 Automation 编辑器 → 同 ID 结构变化／聚焦／拖拽 → 正确手柄、真实保存与 Undo。现有容量用例同时验证滚动、IME、键盘焦点、无效输入保留、折叠定位和持久化。

原始日志、报告与截图位于 `/tmp/numen-n405-*`，临时路径不构成永久存档。无依赖升级、数据库迁移、部署或对外发布。
