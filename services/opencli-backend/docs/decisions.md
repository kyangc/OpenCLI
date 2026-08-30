# OpenCLI Backend 阶段性选型记录

状态：内部 Agent 服务持续演进；动态 catalog、资源感知并发、MCP v2、生产硬化 v0.3 与同仓迁移已实现
日期：2026-08-30

## 目标

在 NAS Docker 中运行一个足够鲁棒、稳定、面向内部 Agent 的 OpenCLI backend。它长期保留浏览器登录态，支持 Web GUI 人工接管，并通过受控的 REST/MCP 接口和持久任务队列执行 OpenCLI 命令。

## 已确定的选型

### 容器拓扑

- 使用两个 Compose 服务：`chromium` 和 `backend`。
- `backend` 使用 `network_mode: service:chromium`，与 Chromium 共享网络命名空间。
- 原因：当前 OpenCLI daemon 与 Browser Bridge 固定通过 `127.0.0.1:19825` 通信；普通 Docker bridge 网络无法让两个容器共享 localhost。
- OpenCLI daemon 端口不映射到宿主机。
- GUI 与 API 只绑定 NAS 的 LAN 地址，不创建未经身份保护的公网入口。

### Chromium

- 基础镜像：`lscr.io/linuxserver/chromium:3d7cd855-ls48`。
- NAS 是 x86_64，但 CPU 不支持 AVX2，因此明确使用 X11 fallback。
- `/config` 持久化浏览器 profile、扩展、Cookie 与站点登录态。
- `shm_size` 设为 1 GiB。
- 使用当前定制 OpenCLI 仓库构建并自动加载 Browser Bridge 扩展，而不是依赖首次启动后手工安装。
- GUI 使用 LinuxServer 自带 HTTPS 界面和文件型密码 secret。
- Chromium 禁用后台驻留，并由 LinuxServer `RESTART_APP` watchdog 拉起意外退出的浏览器，避免关闭最后窗口后只剩黑色桌面。

### 仓库布局与 OpenCLI 来源

- backend 作为独立深模块位于 `stable` 的 `services/opencli-backend`；`main` 继续只做上游 fast-forward 镜像。
- Docker 只从当前 checkout 构建 CLI、unpacked 扩展和 backend，不再接受第二个仓库 URL 或 commit selector。
- backend 保持独立 `package.json`、lockfile 和 Node.js 24 runtime，暂不加入 root npm workspace，避免依赖、audit 和发布面相互污染。
- backend 只通过 `opencli list -f json`、结构化 argv、JSON 输出和公开退出码组成的进程 seam 使用 OpenCLI，不导入 CLI/daemon 实现。
- Node.js 24 backend CI 对该 seam、backend 测试、Compose 和容器构建做同一次验证；CLI release 包的文件白名单继续排除 backend。
- `OPENCLI_RUNTIME_ROOT` 是 browser profile、SQLite、OpenCLI state 和 secrets 的唯一持久目录权威；源码 checkout 的移动不能隐式改变运行数据位置。

### Backend

- Node.js 24，ESM，尽量只使用标准库。
- HTTP：`node:http`。
- MCP：官方 `@modelcontextprotocol/server` v2，Streamable HTTP `/mcp`，REST 与 MCP 不复制业务逻辑。
- 持久队列：`node:sqlite`，单 SQLite 文件。
- 命令执行：`child_process.spawn()` argv 数组，`shell: false`。
- backend 启动时读取 OpenCLI 的结构化 command catalog，默认自动开放 `access=read` 的 site adapter 命令；write 仍需显式 allowlist，不开放 `browser eval`、`external` 或任意 shell。
- 动态命令使用结构化 `params` 并按 manifest 校验；原始 `args` 仅为显式 allowlist 中的兼容命令保留。
- 调度器默认全局并发 2。non-browser、ephemeral tab 和不同站点 persistent tab 可以并发；同一 `profile + persistent site session` 串行；write 或未知元数据按独占任务处理。

### Agent API 与任务语义

- Job Service 与 SQLite 是权威状态；REST 和 MCP 都是同一 Service 的门面。
- 命令目录支持关键词检索；MCP 保持固定的 search、describe、run、get、cancel 五个通用工具。
- 创建任务可立即返回 `202 + job id`，也可有界等待终态；等待超时或连接断开都不取消持久任务。
- 支持 idempotency key、暂停、恢复和取消请求。
- 管理员 token 向后兼容；普通 Agent 使用独立 bearer token 和最小 scope，并且只能访问自己的 job。
- 每个 Agent 的幂等键独立命名，跨 Agent 不会误命中同一个任务。
- `GET /v1/commands` 与命令详情接口暴露经过策略过滤的动态 catalog，不为每个 OpenCLI 命令单独定义 endpoint。
- OpenCLI 本地插件在结构化 catalog 中可能把命令名表示为 `<site>/<command>`；Backend 只剥离与
  `site` 完全相等的单层前缀，再应用既有名称、读写和 allowlist 校验。其他含 `/` 的名称继续拒绝，
  不把插件命名兼容扩展成任意路径执行能力。
- `POST /v1/sites/:site/session-check` 是 `whoami` 的便捷入口，但仍提交到同一个 Job Service 和资源感知队列。
- OpenCLI timeout/TEMPFAIL 只有在启动时 catalog 明确标记为 `access=read` 时才收敛为稳定 `failed`；write、catalog 缺失或命令未知时继续记为 `outcome_unknown`。
- 服务重启时仍处于 `running` 或 `cancel_requested` 的任务转为 `outcome_unknown`，不会自动重放。
- 登录失效由 OpenCLI 退出码映射为 `needs_login`，等待人工 GUI 登录后显式重试。
- 配置的登录站点会周期性把 `whoami` 放入普通队列，主动报告 `authenticated`、`needs_login`、`checking` 或 `error`，不持久化额外账号信息。
- 手动接管浏览器前必须暂停并排空队列。

### 数据与安全边界

- `browser-config/`、`opencli-state/`、`data/` 分开持久化。
- GUI 密码和 API bearer token 放在未入库的 Compose secret 文件中。
- API 拒绝未配置的浏览器 Origin；无 CORS。
- 任务 stdout/stderr 有大小上限，避免无限占用 NAS 空间。
- durable queue 有硬容量上限；每个 Agent 的新任务提交有滑动窗口限流，幂等重试优先命中。
- 调度层 watchdog 独立于 worker timeout，在 worker 超时路径失灵时请求终止并留下审计。
- SQLite 持久化任务归属和变更审计；Prometheus endpoint 暴露队列、Bridge、容量拒绝和 watchdog 指标。
- 默认拒绝敏感参数名，避免 token、password、cookie 或显式敏感数据进入持久化 job 请求。
- 不挂载 Docker socket、NAS 根目录或其他服务数据。

## 当前验收标准

1. Chromium GUI 可从 LAN 通过 HTTPS 访问。
2. 定制 Browser Bridge 自动加载，并能连接 sidecar 中的 OpenCLI daemon。
3. 浏览器登录态在容器重建后仍保留。
4. 不同 tab/session 的任务可重叠执行，同一 persistent tab 的任务严格串行。
5. Bridge 断开时 readiness 失败，恢复后 readiness 自动恢复。
6. 执行中的任务遇到 backend 重启后进入 `outcome_unknown`，不会自动重复执行。
7. Agent 可通过固定 MCP 工具检索、描述、执行和追踪动态命令。
8. Agent 等待超时不会丢失或取消已经提交的持久 job。

## 当前非目标

- 多浏览器、多账号或多 worker 横向扩容。
- 公网域名、OAuth、Cloudflare Access 或 Tailscale 自动配置。
- 自动处理验证码、二次验证或站点风控。
- 对网页写操作承诺端到端 exactly-once。
