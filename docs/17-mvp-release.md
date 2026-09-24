# 17. MVP 0.1.0 发布

## 1. 版本与冻结范围

当前应用版本为 **0.1.0**，版本来源是根 `package.json`。
这是容器应用版本；所有 workspace package 仍为 private，不发布到 npm，
也不意味着 `@numenjs/*` npm scope 或第三方 SDK 已冻结。

本次冻结当前已经实现的单用户、单进程 Node + SQLite 产品路径：

- 首次部署、Master Key 配置、bootstrap URL 登录与 Workbench。
- Automation 创建、Trigger/Capability/核心控制编辑、Draft 自动保存与冲突恢复。
- 显式 Publish、Activate、Enable；Revision 参数化手动 Run 与幂等提交。
- Cron → Echo 定时执行、Run Flow/Timeline/Context、取消、重试和重启恢复。
- Connection 与 Credential 管理、共享出站 HTTP、受限的 HTTP Request Capability。
- 冷备、容器重建恢复、前向升级和 loopback-only Compose 部署。

候选期仅接受以上范围内的缺陷修复及发布验证改进。新产品能力另开后续里程碑。
现有协议版本及 SQLite schema v13 保持不变。

**已知边界随候选版本交付：** 无多用户授权、分布式调度、任意脚本或插件沙箱；
Cron 不补发停机期间错过的触发；State Trigger、Try/Finally、Resource HTTP 下载、
Marketplace/Installer 与外部 vault 尚未完成。Plugins/System 页面不表示
已有完整的插件管理或恢复控制台。Echo 不验证真实 Credential-backed 外部 Integration。
完整约束见 [STATUS.md](../STATUS.md#known-boundaries)。

## 2. 发布门禁

每个待发布 commit 必须重新执行；历史验证不能替代该候选的验证。

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm release:verify
pnpm image:build
pnpm image:smoke
```

`release:verify` 执行 typecheck、单元/集成测试、生产构建、Playwright、配置验证和
CLI doctor。GitHub Actions 的 `Verify release candidate` 在 Node 22/24 上运行基础门禁，
在 Node 24 上运行浏览器验收，并在 Linux AMD64 上构建及验收容器。工作流不上传镜像。

`image:build` 默认构建 `numen:0.1.0`，也接受带相同版本后缀的完整仓库标签。
OCI labels 记录应用版本、Git commit 与可选 `NUMEN_SOURCE` 仓库 URL。
工作区有修改时 commit label 追加 `-dirty`；这类镜像仅用于本地候选验证，不能作为
正式发布来源。构建只针对当前 Docker 平台；不能把单平台镜像描述成多架构镜像。

`image:smoke` 创建随机命名的独立容器/数据卷与 loopback 随机端口，并使用临时生成的
Master Key。它验证非 root 启动、Docker health、HTTP health/readiness、生产 Workbench
资源、HttpOnly session、CLI config/doctor，以及通过真实 Console HTTP 接口执行：

```text
Create → Save → Publish → Activate → Enable → Manual Echo Run
  → Stop → Remove container → Recreate with same volume
  → Restore Draft/Revision/Run → Retry same requestId → Next Cron Echo Run
```

它还检查会话随进程重启失效、Run Journal 与 Echo 输出保留。等待下一次 Cron 最多
75 秒；无外部业务网络依赖。正常完成或检测到失败时清理自己的容器和数据卷；强制
终止进程后可能需要清理 `numen-smoke-*` 资源。脚本不会读取或修改用户现有数据卷，
也不会输出 bootstrap token、session cookie 或 Master Key。

## 3. 发布检查表

发布负责人对**最终干净 commit** 填写一次：

- [ ] 确认镜像仓库、可见性、发布平台与候选版本；版本 tag 不复用。
- [ ] `git status --short` 为空，记录 commit SHA。
- [ ] `pnpm install --frozen-lockfile` 与 `pnpm release:verify` 通过。
- [ ] GitHub Actions Node 22/24 与 Linux AMD64 容器门禁通过。
- [ ] 对每个承诺的平台运行 `image:smoke`；记录平台和 image ID。
- [ ] 按运维文档执行一次冷备→空卷恢复→手动 Run，记录结果。
- [ ] 从上一个已发布版本升级并验证 readiness/Run；首次发布记为不适用。
- [ ] 核对本页冻结范围、已知边界、迁移版本与发布说明。
- [ ] 将经验证的同一镜像上传到已确认仓库，记录 registry digest。
- [ ] 从 registry 拉取该 digest，再运行 `image:smoke`，确认部署路径。
- [ ] 发布 GitHub Release，附本地 `0.1.0` tag、digest、平台、验证结果及运维文档链接。

任何一项未通过都不得把候选标记为已发布。特别是本地 image ID 不等同于 registry
digest；构建成功不等同于上传成功。本流程不自动更新 `latest`、`0` 或 `0.1` 浮动标签。

## 4. 确认仓库后的发布步骤

以下是发布模板，`IMAGE_REPOSITORY` 必须替换为已经确认的仓库；目前没有约定默认
公共仓库。先完成检查表、提交最终修改，并用该干净 commit 重新构建及验收：

```bash
IMAGE_REPOSITORY=registry.example.com/your-project/numen
RELEASE_VERSION=$(node -p "require('./package.json').version")
pnpm image:build "$IMAGE_REPOSITORY:$RELEASE_VERSION"
pnpm image:smoke "$IMAGE_REPOSITORY:$RELEASE_VERSION"
# 使用仓库要求的认证方式登录后，由发布负责人执行：
docker push "$IMAGE_REPOSITORY:$RELEASE_VERSION"
docker image inspect "$IMAGE_REPOSITORY:$RELEASE_VERSION" --format '{{json .RepoDigests}}'
```

保存 push 返回的 digest，并使用 `repository@sha256:…` 拉取和再次验收。
不要在验收和 push 之间重建镜像；若需修改，重新跑门禁。

## 5. 使用已发布镜像部署

`compose.yml` 继续服务源码开发；`compose.release.yml` 是独立的镜像部署文件，
没有 build fallback。将 `NUMEN_IMAGE` 设置为已确认的版本标签，生产部署优先固定 digest：

```bash
cp .env.example .env
# 将下方占位值替换为实际发布的镜像
NUMEN_IMAGE=registry.example.com/your-project/numen:0.1.0
docker run --rm "$NUMEN_IMAGE" key generate
# 在 .env 中填写 NUMEN_IMAGE 和生成的 NUMEN_MASTER_KEY
# 现有部署必须保留原 Master Key。
docker compose --env-file .env -f compose.release.yml pull
docker compose --env-file .env -f compose.release.yml up -d --wait
```

启动后在本机读取日志中的 private Workbench URL。
不要把日志或 `.env` 添加到发布附件。

同一目录下两份 Compose 文件使用相同 service/volume 名称；切换前先做冷备，并保持
Compose project name 一致，避免误建空卷。不要同时运行两个实例访问同一个 SQLite 卷。
备份、恢复和前向升级见 [运维文档](13-engineering-operations.md)。

## 6. 发布记录

`0.1.0` 是本地 Git 版本基线，镜像上传与 GitHub Release 是独立步骤；外部 registry 上传和 GitHub Release 尚未执行。
最终发布记录应包含：版本、commit、registry digest、平台、schema 版本、各门禁结果、
备份恢复证据及已知边界。禁止用未提交的本地验证代替最终发布记录。

发布流程参考：[GitHub 容器发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、
[Docker GitHub Actions 文档](https://docs.docker.com/build/ci/github-actions/)。
