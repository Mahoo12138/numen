# N3-01：安全的插件配置表单

本模块基于 `46c82e1`，实现 2026-09-30 计划中的 N3-01。插件列表收敛为名称、实际状态、简短原因和操作；来源、包信息、实例 ID、自身及继承启用状态、内部模块移入详情区域。Console 与 Workbench 保留独立实例和入口，内部模块仍只读。

## 编辑与保存语义

- 公开 Schema 的对象配置默认使用表单，复用共享标量、布尔、enum 与 JSON 控件，支持嵌套对象和数组。不能结构化表达的部分明确显示 JSON 回退；根 Schema 无法投影为对象时使用高级 JSON。
- 表单和高级 JSON 共同修改原有编辑会话的一份配置，并复用固定 fingerprint、Preview 和 Apply。默认值只提示是否存在，不传默认值内容，不自动物化；未显示的未知字段与未知数组成员属性完整保留。
- 合法聚焦字段先提交再切换模式或 Preview。非法字段与非法 JSON 留在原模式，刷新失败、实例切换、导航和关闭页面均沿用未提交保护。数组增删先提交聚焦字段，并等待父配置更新后再操作，防止覆盖刚提交的值。
- 服务端跨字段校验失败保留本地输入，显示固定错误并阻止 Apply。另一个客户端修改后仍使用打开时的 fingerprint；必须显式丢弃并加载最新值才能刷新编辑基线。Apply 响应丢失显示结果不确定，不自动重放写入。
- Host 对配置副本执行最终验证，避免 Schema 默认值或校验器修改原待写入对象。配置 CAS、管理通道保护、原有 YAML 写入限制继续由 Host 执行。

## 安全与显示边界

Schema DTO 只包含显示类型、字段名、标签、描述、有限数值约束、基本 enum 值、是否必填和是否有默认值。读取使用 own data descriptor，不调用校验器、lazy builder、getter 或序列化函数；默认值、Node 对象和函数不进入 DTO。静态且字段不重叠的对象交集可合并，其余复杂类型退回 JSON。

含秘密角色、敏感字段名或敏感实际文本的整项配置只读，DTO 不返回其配置或 Schema。缺失/无法安全检查 Schema、未加载插件和受保护管理入口同样只读。基线曾允许已加载但没有 Schema 的插件直接改 JSON，本模块按计划明确收紧该情况；旧编辑回归测试只在测试夹具中声明公开 Schema，没有给生产插件补虚假声明。

Schema 分类最大深度 12、扫描节点 1,024；投影最多 256 节点、每个对象 64 字段、文本 2,048 字符、整体 64 KiB UTF-8。无法完整分类时只读；已能分类但超过显示范围时明确 JSON 回退。表单最多显示 500 个 Schema 节点和每数组 50 项，完整配置继续保留在高级 JSON 中，不截断后提交。

不属于 JSON 数据的配置（例如 YAML 的非有限数）不能通过 JSON 无损往返，保持只读并拒绝写入。此边界用于保留原始配置，不把该类值误报为秘密。Schema 元数据投影与原值复制互相分离，旧脱敏逻辑不再重复访问原始 Schema。

## 验证

所有测试使用隔离的临时 Runtime、配置和数据目录。浏览器插件不可用，使用仓库 Playwright / Chromium 加载真实生产构建。

回归覆盖未知字段、未触碰的可选值和显式空值、默认值不写入、跨字段校验、校验器尝试修改输入、保存后重启、真实 CAS 冲突、访问器/函数不执行、秘密字段未设置时的整项只读，以及大数组和嵌套显示限制。

浏览器覆盖表单与 JSON 双向编辑的精确 Preview/Apply 请求及磁盘值、服务端失败后修复、聚焦字段与数组删除交错、非法输入保护、查询失败、插件禁用与重新启用、预览后并发变化和响应丢失。DISABLED 实例仍保留已加载的公开 Schema 时允许编辑；从未加载且无可检查 Schema 的实例只读。故障注入仅允许对应 URL 与文本的一次预期网络错误，其他 console error 和 pageerror 均使测试失败。

安全复核发现并修复两处实际边界：旧脱敏逻辑会重复访问 live Schema 的 getter/数组方法；YAML 非有限数经 JSON 序列化可能变成 `null`，破坏未知字段。新增真实 Host 回归分别证明不执行相关函数，以及 `.inf` 保持原始磁盘值并拒绝浏览器改写。

Vue 回归另外复现了渲染预算边界：将前面的 JSON 回退恢复为大型对象，可能挤掉后面尚未提交的字段。现在结构恢复先检查其他待提交字段，并保持稳定的字段元数据身份；回归验证两处缓冲均保留，修正非法数字后，再次提交结构恢复能成功保存完整内容。没有用重试或截断规避此问题。

初轮浏览器问题来自测试夹具：固定路由应为 `/plugins/installed`，控件按真实可访问名称定位，两个实例须使用独立对象避免 YAML 自动生成别名，DISABLED 与从未加载需按实际 Runtime 语义区分。修正夹具后相关 17 项通过；最终生产构建重新运行了全部 69 项。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm test` | 117 文件 / 712 项通过 | `/tmp/numen-n301-tests-final.log` |
| `pnpm typecheck` | 通过 | `/tmp/numen-n301-typecheck-final.log` |
| `pnpm build` | 通过 | `/tmp/numen-n301-build-final.log` |
| `pnpm build:examples` | 通过 | `/tmp/numen-n301-examples-final.log` |
| 相关 3 文件 Chromium 场景 | 17 项通过 | `/tmp/numen-n301-browser-targeted-v6.log` |
| 最终全量 Chromium Playwright | 69 项通过，2.2 分钟 | `/tmp/numen-n301-browser-final.log` |
| `git diff --check` | 通过 | 本轮实际执行 |

最终截图位于 `/tmp/numen-n301-browser-final/`：

- `plugin-config-form-keeps-o-971e8--without-inserting-defaults/plugin-schema-desktop.png`：1440×960 表单。
- 同目录 `plugin-schema-mobile-zh.png`：390×844 中文表单，切换语言后已编辑的字段仍保留。
- `plugin-config-form-shows-i-180cf-tion-or-executable-metadata/plugin-compact-list-desktop.png` 与 `plugin-compact-list-mobile.png`：紧凑实例列表、独立产品行及只读内部模块详情。

以上四张图已实际查看。字段、模式按钮和详情可读，移动端无横向溢出；内容较长时正常纵向滚动。

没有数据库迁移、依赖升级或新用户配置入口；有证据的影响分析留给 N3-02。本模块不增加秘密编辑，不验证其他浏览器、部署或发布。
