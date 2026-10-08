# Workbench 文案解析性能优化

本模块接续 N4-03 的实测基线。对 300／1000 节点选择和字段提交做 CPU 采样后，将优化收敛在 Workbench 的重复文案解析；没有更换画布或框架。

## 诊断与对照范围

本轮开始时另一个任务的页面布局修改已经暂存，随后提交为 `a7a4f93dd0e2a4eb59173821ddb3da5a8148d945`。对照测量以该提交重新导出的独立源码为基线，而不是直接拿此前 `2f44812` 的数值计算改善率。源码目录为 `/tmp/numen-n403-verify-dqg1y1zq`，依赖和构建产物独立于主工作区。前后差异限定为本模块产品文件。

环境沿用 Apple M4、10 逻辑核、24 GiB、Darwin 25.6.0 arm64、Node v22.14.0、Chromium 153.0.8010.12、1440×960、单 worker。正式测量继续使用 N4-03 的固定夹具、20 次样本、3 次首次导航、10 轮生命周期、禁用 HTTP 缓存和 nearest-rank 分位数。1000 节点仍是压力探针。

先在 production 构建上使用隐藏 source map 和 CDP CPU profiler，采样间隔 1000µs，每类交互 10 次，并记录浏览器布局／样式累计耗时。该诊断运行包含自动保存等待和检查，不混入正式性能样本。初次采样器遗漏 assets 子目录 source map 后已经修正，以下引用完整符号化的一轮 `/tmp/numen-n404-profile-symbolized/`。

| 诊断场景 | 主线程任务累计（ms） | 布局 + 样式累计（ms） | Workbench 翻译入口累计包含子调用（ms） |
| --- | --- | --- | --- |
| 300 节点选择 × 10 | 1,108.8 | 6.0 | 851.8 |
| 300 节点字段 × 10 | 5,560.7 | 10.6 | 4,431.9 |
| 1000 节点选择 × 10 | 3,624.6 | 10.7 | 2,662.0 |
| 1000 节点字段 × 10 | 18,826.8 | 12.3 | 13,857.7 |

符号化栈落在 `provideWorkbenchI18n().t` → BrowserLocale／I18n 的词条解析、locale fallback，以及 Cordis Context 的属性查找和方法代理。包含子调用的时间不能在父子函数之间相加，也不能等同于一个字段提交的延迟。该证据优先支持减少重复翻译解析，而非先做 DOM 虚拟化。

另外观察到逐节点绘制拖拽手柄会调用完整 `automationStepEditOptions`，其中复制安全校验遍历 Source。这是独立的次级热点；本模块保留其现有校验语义，不把多个优化混在同一对照中。

## 实现边界

缓存限定在每个 Workbench Vue 树的 i18n provider 内，最多 256 个无参数文案，达到上限后淘汰最早加入的条目。参数调用继续委托真实 locale service，不缓存用户输入、参数对象或参数化结果。词条／语言 revision 改变、服务替换和生命周期清理使缓存失效；未被当前订阅观察的 service identity 旁路缓存。

订阅使用同步 effect，先订阅再读取版本；命中缓存前再检查 `getSnapshot()`。这一步不能只依赖“订阅回调清缓存”：较早注册的 listener 可能在 provider 收到通知前同步读取，此时 service 版本已经改变，旧缓存必须立即失效。命中检查不会在 render 中写入 Vue 响应式版本。生产 Shell 传入稳定 service prop，测试也保留真实 Cordis proxy 身份，避免反复读取 `ctx.webuiLocale` 生成新 proxy 造成缓存始终旁路的假验证。

保留参数解析路径是必要的语义约束。例如 `left = "{"`、`right = "name}"`、`outer = "{@left}{@right}"`，现有服务输出字面 `{name}`；先展开引用再调用一次 `interpolate` 会错误地替换成用户参数。因此没有采用“缓存所有展开模板，再统一插值”的方案。

## 实测与验证

正式对照未启用 CPU profiler，单位 ms。选择／字段的 P95 下降约 21%–24%；这是本机这一组受控前后结果，不是跨机器保证或统计置信区间。

| 节点 | 操作 | 优化前 P50 / P95 | 优化后 P50 / P95 | P95 降幅 |
| --- | --- | --- | --- | --- |
| 300 | 选择 | 99.3 / 102.8 | 76.0 / 78.9 | 23.2% |
| 300 | 字段提交 | 97.2 / 100.0 | 74.9 / 76.3 | 23.7% |
| 300 | 隐藏节点定位 | 33.8 / 35.0 | 31.6 / 32.4 | 7.4% |
| 1000 | 选择 | 341.1 / 352.4 | 271.1 / 279.8 | 20.6% |
| 1000 | 字段提交 | 339.0 / 348.9 | 272.4 / 275.8 | 21.0% |
| 1000 | 隐藏节点定位 | 79.9 / 82.6 | 57.2 / 58.4 | 29.3% |

300／1000 节点首次路由就绪中位数分别为 337.8→232.0ms、612.1→512.7ms；每项仅 3 个新 context，仍不作为标准 TTI 或稳定尾部估计。字段提交只计到本地 DIRTY／pending-cleared 渲染，随后另行等待保存并验证 Source；不包含 600ms 自动保存 debounce。

优化后完整五组基准均通过：

| 场景 | 选择 P95 | 字段 P95 | 定位 P95 | Apply P95 | 十轮后 GC 堆增量（KiB） |
| --- | --- | --- | --- | --- | --- |
| Automation 100 | 32.5 | 32.2 | 32.1 | — | +380.0 |
| Automation 300 | 78.9 | 76.3 | 32.4 | — | +324.2 |
| Automation 1000（压力） | 279.8 | 275.8 | 58.4 | — | +389.8 |
| Plugins 100 | 实例 32.5 / 分组 32.3 | 23.7 | 127.7（整页） | 81.8 | +357.5 |
| Plugins 300 | 实例 32.8 / 分组 32.0 | 25.5 | 155.4（整页） | 166.1 | +354.8 |

插件和 100 节点数据用于最终候选回归验证；受控前后比较限定在本轮重新测量的 300／1000 节点。N4-03 已冻结的本机预算全部满足，没有重算或放宽预算。

五组生命周期在相同 Home 状态的每轮 DOM、监听器、浏览器／宿主订阅与连接计数均未增长，pending／closing 为 0；堆仍有上述小幅保留，不能表述为无泄漏。Automation 选择阶段 0 保存、字段阶段 21 保存、折叠＋定位阶段 42 保存；插件每组 21 Preview / 21 Apply 与实际 YAML 变化均核对通过。它们都包含各阶段 1 次预热。

长任务仍存在，尤其 1000 节点的选择和字段提交仍有约 280ms 的尾部耗时；本模块不把压力探针转为官方容量承诺。完整长任务、DOM、堆和订阅样本保留在数值记录中。

新增 12 个真实 Cordis／Vue 回归场景覆盖重复渲染词条、语言／字典更新、同版本号的服务替换、先订阅后快照、较早 listener 读取、非响应式 service 替换旁路、Entry stage 激活／失效／撤销、引用与循环、空字符串缓存命中、空对象／数组参数直通、256 条目边界，以及共享 service 的多棵树独立缓存和逐棵卸载。旧实现先实际失败 4 项，记录在 `/tmp/numen-n403-i18n-cache-red.log`；修复后的首次相关测试为 4 文件 / 19 项通过，随后补充 3 项生命周期边界纳入最终全量验证。

修复后使用同一 CPU 诊断脚本复测，300 节点两阶段主线程任务累计从 1,108.8 / 5,560.7ms 降到 908.4 / 4,472.6ms；1000 节点从 3,624.6 / 18,826.8ms 降到 2,904.1 / 15,000.6ms。参数化文案的解析仍占较大比例。该结果支持当前小范围改动；没有因此绕过参数语义或扩大缓存范围。

## 复现

正式性能命令沿用 `pnpm bench:workbench`，随后运行 `node benchmarks/workbench/summarize.mjs OUTPUT_DIR`。本轮优化前用默认 20 / 3 / 10 配置限定 `automation --grep '300 node|1000 node'`；优化后执行全部五组。Profiler 只用于定位，不启用在正式计时运行中；本次临时诊断脚本 `/tmp/numen-n404-profile.spec.ts`、配置及脱敏 CPU profiles 保留在本机 `/tmp`，并未纳入正式 benchmark 的测试匹配。

- [前后对照数据](workbench-render-performance-comparison-2026-10-08.json)：优化前原始时延样本、夹具哈希、对照百分比、CPU 诊断汇总、候选产品文件 SHA256。
- [优化后完整数值基线](workbench-render-performance-after-2026-10-08.json)：由现有严格汇总器生成，保留五组原始时延、长任务、持久化和生命周期数据。
- 优化前 production assets SHA256：`6fa28e5df71993f5f2341d8787997da433531d995eda9ab1564e7b7161abad4a`。
- 优化后 production assets SHA256：`8fcfc9fa4e35070a6a612d90122a75733c782f5a5436c58b6906bd32d7095a92`。

归档运行的 `sourceHead` 记录导出基线 `a7a4f93`，优化后的额外产品改动是 `packages/workbench/src/i18n.ts`，其 SHA256 为 `32dd8421d0d630b80a81acbe6830b95413a0f7f59952a5bf0daecd87e872fe26`。归档没有 Git 元数据，不能用 `sourceWasDirty: false` 证明候选无改动；这里通过显式基线、文件对照和实际资产哈希识别候选。

## 完整回归

所有运行来自上述独立源码目录。最终普通 production 构建的 assets SHA256 再次核对与正式测量候选一致；主工作区的产品文件、新增单测和两个调整后的 E2E 文件与隔离目录逐字节一致。

| 检查 | 结果 | 本机日志 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | `/tmp/numen-n404-typecheck.log` |
| benchmark 独立 TypeScript 检查 | 通过 | `/tmp/numen-n404-harness-typecheck.log` |
| `pnpm build`、最终普通 production app 重建 | 通过 | `/tmp/numen-n404-after-build.log`、`/tmp/numen-n404-final-build.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n404-examples.log` |
| `pnpm test` | 129 文件 / 911 项通过 | `/tmp/numen-n404-tests.log` |
| 修正路径后的三项针对性浏览器回归 | 3 项通过 | `/tmp/numen-n404-regression-scoped.log` |
| 刷新后 splitter 持久化回归，连续三次 | 3 项通过 | `/tmp/numen-n404-regression-resize.log` |
| 最终完整 Playwright 回归 | 102 项通过（3.0 分钟） | `/tmp/numen-n404-regression-complete.log` |
| 正式优化后性能基准 | 5 组通过 | `/tmp/numen-n404-after.log` |

首次全量浏览器回归为 99 通过 / 3 失败。两个日志用例仍假设 System 默认打开日志，命令用例仍假设 Home 有底部日志面板；它们与 `a7a4f93` 已提交的页面布局不符。在隔离目录恢复原始 `a7a4f93` 文案实现、重建并只跑这三项后，三项均以同样原因失败，日志为 `/tmp/numen-n404-base-regression.log`。

因此更新两个 E2E 文件的真实进入路径：显式选择 System 的 Runtime logs 标签；Home 断言无页面专属面板，在 Automation 检查日志／问题面板；280 条日志绑定专用 Automation，在移动端关闭默认检查器后选择该对象检查底部日志。仍保留认证、脱敏、丢失请求与 WebSocket 恢复、历史分页、暂停／恢复、100 条上限、语言切换、命令焦点和导航保护断言；没有放宽原有业务目标。

调整页面路径后的全量回归为 101 通过 / 1 失败：既有 splitter 用例在 `page.reload()` 后立即读取尚未挂载的 Inspector，`boundingBox()` 返回 null 而使断言抛错，日志为 `/tmp/numen-n404-regression-final.log`。补上 Inspector 可见性等待，仍严格断言刷新后宽度为 500px；未改动产品 resize 行为。该用例连续三次通过，最终完整回归 102 项全部通过。

已实际查看本次 production 候选的 `i18n-desktop.png`（1440×960）和 `i18n-mobile.png`（390×844），中英文切换后的界面及用户原始标题／内容正常；另查看针对性回归生成的 `logs-panel-mobile.png`，确认 Automation 面板在移动视口内。浏览器交互和 DOM 断言负责核对日志内容与数量，截图仅用于布局检查。

临时日志／profiles／截图保存在本机 `/tmp/numen-n404-*`，不是永久存档。没有依赖升级、迁移、部署或对外发布。
