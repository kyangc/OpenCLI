# OpenCLI Backend

面向内部 Agent 的长期在线 OpenCLI 执行后端：Chromium 保留登录态并提供 Web GUI，backend 通过共享 localhost 连接 Browser Bridge，SQLite 队列按 tab/session 冲突感知并发执行。REST 与 MCP 共用同一份 command catalog、策略、持久队列和结果语义。

本模块由原 `kyangc/opencli-backend` 仓库的 `dd82543` 迁入；此后 `stable` 中的
`services/opencli-backend` 是源码权威。它保留独立 package、Node.js 24 runtime、
SQLite 权威和容器生命周期，只通过公开 CLI interface 使用同一 checkout 的
OpenCLI，不导入 CLI/daemon 实现。

Agent 接入与恢复语义见 [docs/agent-integration.md](docs/agent-integration.md)，NAS 日常运维见 [docs/operations-runbook.md](docs/operations-runbook.md)。阶段性选型与范围见 [docs/decisions.md](docs/decisions.md)，架构图见 [docs/opencli-backend-architecture.html](docs/opencli-backend-architecture.html)，NAS 实测结果见 [docs/poc-verification.md](docs/poc-verification.md)。

## 本地测试

在仓库根目录执行：

```bash
npm ci --ignore-scripts --prefix services/opencli-backend
npm run verify:backend
```

## Docker Compose

```bash
cd services/opencli-backend
cp .env.example .env
./scripts/generate-secrets.sh
docker compose --env-file .env build
docker compose --env-file .env up -d
```

GUI 密码、管理员 API token 和 Agent token 位于未入库的 `secrets/` 目录。不要把它们写入 Compose、Git 或日志。由于 backend 与 Chromium 共享网络命名空间，API 的宿主机端口映射定义在 `chromium` 服务上；OpenCLI daemon 的 `19825` 不映射。

## 发布与部署冒烟

Backend workflow 和 `kyangc-v*` 发布 Gate 会从同一个 checkout 构建两个最终
镜像，在隔离的临时 profile 中启动 Compose，然后运行：

```bash
sh services/opencli-backend/scripts/smoke-compose.sh 2.0.3 2.0.0
```

该编排显式设置 `OPENCLI_SESSION_CHECK_SITES=disabled`，只读访问
`/health/live` 和 `/health/ready`；它不会提交 job，也不会调用真实 Provider。
smoke 会核对 daemon 与扩展版本、Bridge、至少一个已连接 profile、pending command
为零，以及 durable queue 没有 active/queued 工作。失败会阻断 workflow，并输出
容器日志后清理临时容器、profile 和 secrets。为防误伤，若机器上已经存在
`opencli-backend` 或 `opencli-chromium` 容器，隔离 Compose smoke 会直接拒绝运行。

生产更新后在已运行的 backend 容器内调用同一个只读检查：

```bash
docker exec opencli-backend node /app/scripts/smoke-deployment.mjs \
  --base-url http://127.0.0.1:8080 \
  --expected-daemon-version 2.0.3 \
  --expected-extension-version 2.0.0 \
  --timeout-seconds 180
```

GitHub 当前没有能访问 LAN NAS 的 runner、Environment 或部署 secrets，因此上述
workflow 是镜像/发布 Gate，不声称已经自动部署生产。NAS 的升级、resume 和部署后
smoke 仍按运维 runbook 执行；以后接入受控 runner 时直接复用同一命令。

Docker 构建上下文是仓库根目录，CLI、扩展和 backend 必须来自同一个 checkout；
不再支持 `OPENCLI_REPOSITORY` 或 `OPENCLI_COMMIT` 覆盖。Compose 要求显式设置
`OPENCLI_RUNTIME_ROOT`：本地示例使用当前目录，NAS 必须指向既有的持久目录，
避免迁仓后静默创建空 profile、空队列或新 secrets。

当前服务部署在 NAS 的 `/volume1/docker/opencli-backend`：

- Chromium GUI：`https://192.168.50.10:13001`，用户为 `opencli`，密码在 NAS 的 `secrets/gui_password`。
- Agent API / MCP：`http://192.168.50.10:18080`。管理员 token 在 NAS 的 `secrets/api_token`，普通 Agent 凭据在 `secrets/agent_tokens.json`。
- 两个入口都只绑定 NAS 的 LAN 地址；GUI 使用自签名 HTTPS 证书。

不要把这两个端口直接映射到公网。远程使用应在后续增加 Tailscale、VPN 或带身份认证的反向代理。

## MCP（Agent 推荐入口）

Streamable HTTP endpoint 为 `/mcp`，使用与 REST 相同的 bearer token。服务基于官方 MCP TypeScript SDK v2，同时兼容 2025-era stateless client 与 2026-07-28 协议协商。MCP 工具列表根据 token scope 动态裁剪，Agent 不会看到无权调用的工具。

```json
{
  "url": "http://127.0.0.1:8080/mcp",
  "headers": {
    "Authorization": "Bearer <AGENT_TOKEN>"
  }
}
```

只暴露固定的通用工具，不为 978 个 read 命令各生成一个 tool：

- `opencli_search_commands`：按意图、站点和关键词检索命令。
- `opencli_describe_command`：读取参数、输出列、示例、strategy 和 session 行为。
- `opencli_run`：提交持久 job 并有界等待；等待超时不会取消 job。
- `opencli_get_job`：获取长期任务的状态或结果。
- `opencli_cancel_job`：取消 queued 或 active job。

Agent 应先 search/describe，再使用结构化 `params` 调用 run。对可能被客户端或网络重试的任务应传稳定的 `idempotencyKey`。

## REST API

发现可用的只读命令：

```bash
curl 'http://127.0.0.1:8080/v1/commands?q=top%20stories&site=hackernews' \
  -H "Authorization: Bearer $OPENCLI_AGENT_TOKEN"
```

提交动态发现的只读命令：

```bash
curl -X POST 'http://127.0.0.1:8080/v1/jobs?wait=true&waitTimeoutSeconds=60' \
  -H "Authorization: Bearer $OPENCLI_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-1' \
  -d '{"site":"hackernews","command":"top","params":{"limit":3}}'
```

`wait=true` 在限定时间内直接返回终态结果；等待超时返回 HTTP 202 和 `job.id`，job 继续在队列中运行，可通过状态和结果接口查询。客户端断连同样不会取消持久 job。

检查已登录站点的会话：

```bash
curl -X POST http://127.0.0.1:8080/v1/sites/xiaohongshu/session-check \
  -H "Authorization: Bearer $OPENCLI_AGENT_TOKEN" \
  -H 'Idempotency-Key: xiaohongshu-session-example'
```

session check 同样返回普通 job，并经过同一个资源感知队列；使用现有 job 状态与结果接口轮询。只要 OpenCLI catalog 中存在允许的 `<site>.whoami` 即可调用。

接口：

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `POST /mcp`
- `GET /v1/commands?q=<query>&site=<site>&limit=100&offset=0`
- `GET /v1/commands/:site/:command`
- `POST /v1/jobs?wait=true&waitTimeoutSeconds=60`
- `POST /v1/sites/:site/session-check`
- `GET /v1/sessions`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/result`
- `POST /v1/jobs/:id/cancel`
- `GET /v1/control`
- `POST /v1/control/pause`
- `POST /v1/control/resume`
- `GET /v1/audit?limit=100`

除健康检查外，所有接口都需要 bearer token。backend 启动时通过 `opencli list -f json` 加载命令 catalog：默认自动开放其中的 `access=read` 命令，write 命令仍需在 `OPENCLI_ALLOWED_COMMANDS` 中显式配置。动态命令必须使用结构化 `params`；`args` 只为 `OPENCLI_ALLOWED_COMMANDS` 中的兼容命令保留。服务始终使用 argv 执行并强制 JSON 输出。

输入错误同时返回稳定的 `code`、`field`、`retryable` 和人类可读 `message`，便于 Agent 自行修正。命令执行错误使用 job `status` 和 `errorCode`；`needs_login` 需要人工通过 GUI 恢复会话，不应自动高频重试。
由于服务强制 `--format json`，退出码为零但输出被截断或不是合法 JSON 时也会 fail closed，分别返回
`output_truncated` 或 `invalid_json_output`，不能把不可消费的 Provider 输出记为成功。

## Agent 身份与权限

`secrets/agent_tokens.json` 使用以下格式；修改后重启 backend 生效：

```json
{
  "agents": [
    {
      "id": "internal-agent",
      "token": "<at-least-24-characters>",
      "scopes": ["commands:read", "jobs:submit", "jobs:read", "jobs:cancel", "sessions:read"]
    }
  ]
}
```

可用 scope 为 `commands:read`、`jobs:submit`、`jobs:read`、`jobs:cancel`、`sessions:read`、`control:write`、`metrics:read`、`audit:read`。普通 Agent 只能查看和取消自己创建的 job；原 `OPENCLI_API_TOKEN` 始终作为管理员凭据保留。任务提交、幂等命中、取消、队列暂停/恢复和 watchdog 终止会写入 SQLite 审计表，`GET /v1/audit` 仅对 `audit:read` 开放，审计中不保存 token。

## 容量保护与可观测性

- `OPENCLI_MAX_QUEUED_JOBS` 限制 durable queue 深度，默认 100；满载返回可重试的 HTTP 503 `queue_full`。
- `OPENCLI_MAX_SUBMISSIONS_PER_MINUTE` 对每个 Agent 限制新任务提交，默认 60；幂等重试不计入限流。
- `OPENCLI_WATCHDOG_GRACE_SECONDS` 为执行器 timeout 增加调度层兜底终止窗口，默认 30 秒。
- `GET /metrics` 输出 Prometheus 文本指标，需要 `metrics:read`；示例告警规则见 [`ops/prometheus-alerts.yml`](ops/prometheus-alerts.yml)。
- `OPENCLI_SESSION_CHECK_SITES` 中的站点会按 `OPENCLI_SESSION_CHECK_INTERVAL_SECONDS` 周期执行 `whoami`；`GET /v1/sessions` 只返回登录状态，不返回账号或命令输出。

默认拒绝名为 `include-sensitive`、`token`、`password`、`secret` 或 `cookie` 的参数，避免敏感值进入持久化 job 记录；可通过 `OPENCLI_DENIED_ARGUMENTS` 调整。调度器默认最多执行两个 job：non-browser、ephemeral tab 和不同站点的 persistent tab 可并发，同一 `profile + persistent site` 严格串行。未知调度元数据和显式允许的 write 命令按独占任务处理。

人工登录或接管浏览器前，先调用 `POST /v1/control/pause` 并确认 `GET /v1/control` 中 `drained=true`；完成操作后再调用 `POST /v1/control/resume`。

Chromium 使用 `--disable-background-mode`，LinuxServer watchdog 使用 `RESTART_APP=true`。最后一个窗口被关闭后，浏览器进程应退出并由 watchdog 自动重新拉起，避免只剩黑色远程桌面。
