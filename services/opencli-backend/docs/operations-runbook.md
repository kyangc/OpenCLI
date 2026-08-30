# OpenCLI Backend 运维 Runbook

本文档面向 NAS 运维者。日常 Agent 不应获得管理员 token 或队列控制权限。

## 服务与数据位置

- OpenCLI `stable` checkout：`/volume1/docker/OpenCLI`
- Compose 文件：`/volume1/docker/OpenCLI/services/opencli-backend/compose.yaml`
- 持久数据根目录：`/volume1/docker/opencli-backend`
- Chromium GUI：`https://192.168.50.10:13001`
- REST / MCP：`http://192.168.50.10:18080`
- Browser profile：`browser-config/`
- OpenCLI state：`opencli-state/`
- SQLite job/audit store：`data/jobs.sqlite3`
- secrets：`secrets/`

不要把 GUI、API 或 OpenCLI daemon 端口直接暴露到公网。不要把 `secrets/`、`browser-config/`、`opencli-state/` 或 `data/` 提交到 Git。

## 常用检查

在 NAS 上执行：

```bash
opencli_repo_dir=/volume1/docker/OpenCLI
opencli_runtime_root=/volume1/docker/opencli-backend
opencli_backend_env="$opencli_repo_dir/services/opencli-backend/.env"
opencli_backend_compose_file="$opencli_repo_dir/services/opencli-backend/compose.yaml"
opencli_backend_compose() {
  /usr/local/bin/docker compose --env-file "$opencli_backend_env" \
    -f "$opencli_backend_compose_file" "$@"
}
cd "$opencli_repo_dir"
opencli_backend_compose ps
```

每次维护 shell 都先定义上述三个变量和 `opencli_backend_compose`。生产 `.env`
必须包含 `OPENCLI_RUNTIME_ROOT=/volume1/docker/opencli-backend`；源码 checkout
和运行数据目录是两个独立位置。

读取管理员 token 时只保存在临时 shell 变量中，不打印：

```bash
admin_token=$(cat "$opencli_runtime_root/secrets/api_token")
curl -fsS http://192.168.50.10:18080/health/live
curl -fsS http://192.168.50.10:18080/health/ready
curl -fsS http://192.168.50.10:18080/v1/control \
  -H "Authorization: Bearer $admin_token"
```

健康含义：

- `/health/live` 200：Node 进程可响应。
- `/health/ready` 200：Browser Bridge 已连接且队列未暂停。
- backend container `healthy`：只验证 liveness；仍需独立检查 readiness。

## 人工登录或浏览器接管

1. 暂停调度：

   ```bash
   curl -fsS -X POST http://192.168.50.10:18080/v1/control/pause \
     -H "Authorization: Bearer $admin_token"
   ```

2. 查询 `/v1/control`，等待 `drained=true`。
3. 打开 Chromium GUI，完成登录、验证码或人工操作。
4. 恢复调度：

   ```bash
   curl -fsS -X POST http://192.168.50.10:18080/v1/control/resume \
     -H "Authorization: Bearer $admin_token"
   ```

5. 使用新的 `Idempotency-Key` 调用 `/v1/sites/<site>/session-check`。旧 key 会命中旧 job，不能验证新的登录尝试。

## Backend 升级

1. pause 并等待 `drained=true`。
2. 更新 `stable` checkout，并确认运行数据仍指向既有目录：

   ```bash
   git status --short --branch
   git pull --ff-only origin stable
   grep '^OPENCLI_RUNTIME_ROOT=/volume1/docker/opencli-backend$' "$opencli_backend_env"
   opencli_backend_compose config --quiet
   ```

   Docker 只从当前 checkout 构建，不再存在可被 `.env` 覆盖的 OpenCLI 仓库或
   commit 参数。若 runtime root 检查失败，停止升级，不能让 Compose 创建空 profile。
3. 只构建 backend：

   ```bash
   opencli_backend_compose build backend
   ```

4. 启动 backend 时必须让 Compose 解析 `service:chromium` 依赖：

   ```bash
   opencli_backend_compose up -d --force-recreate backend
   ```

   不要使用 `--no-deps`；当前 NAS 的 Compose 2.20 会因 `network_mode: service:chromium` 无法解析目标网络服务。

5. 等待 backend healthy。session monitor 在队列暂停期间不会新建 Provider 巡检
   job；确认 Bridge 连接后 resume，再执行只读部署冒烟：

   ```bash
   admin_token=$(cat "$opencli_runtime_root/secrets/api_token")
   /usr/local/bin/docker exec opencli-backend opencli doctor
   curl -fsS -X POST http://192.168.50.10:18080/v1/control/resume \
     -H "Authorization: Bearer $admin_token"
   /usr/local/bin/docker exec opencli-backend \
     node /app/scripts/smoke-deployment.mjs \
       --base-url http://127.0.0.1:8080 \
       --expected-daemon-version 2.0.1 \
       --expected-extension-version 2.0.0 \
       --timeout-seconds 180
   ```

   smoke 只访问 `/health/live` 和 `/health/ready`，不提交 job 或调用 Provider；版本
   不一致、扩展未连接、没有 profile、存在 pending command，或队列仍有
   active/queued 工作都会失败并阻断发布。随后再验证 `/metrics`、`/v1/audit`。
6. 检查运行态没有漂移：restart policy 应为 `unless-stopped`，network mode 应为
   `container:<chromium-container-id>`。

   ```bash
   /usr/local/bin/docker inspect opencli-backend \
     --format 'restart={{.HostConfig.RestartPolicy.Name}} network={{.HostConfig.NetworkMode}}'
   ```

7. 确认 Chromium container 的 `StartedAt` 未变化。
8. 确认 `activeCount=0`、queued count 为零且 `drained=true`。

启动迁移会为旧 SQLite schema 增加必要字段。启动前处于 `running` 或 `cancel_requested` 的 job 会转为 `outcome_unknown`，不会自动重放。

## 本地插件更新

本地插件源放在持久化的 `opencli-state/plugin-sources/<source-sha>/`，目录名必须来自实际 Git
对象，不手工扩写短 SHA。更新时：

1. pause 并等待 `drained=true`；
2. 将只含 tracked files 的插件 archive 解到新的 `<source-sha>` 目录，不覆盖旧源；
3. `opencli plugin uninstall <name>` 后，以新目录的绝对 `file://` URL 重新安装；
4. 重启 Backend 进程以重载启动时 catalog，不重启 Chromium；
5. 通过受限 Agent token 验证命令详情仍为 `access=read`，再执行一个只读探针；
6. resume，并保留旧源到回滚窗口结束。不要在队列运行中修改已安装插件所指向的源目录。

## Agent token 管理

Agent 凭据位于 `secrets/agent_tokens.json`。修改后重启 backend 生效。

- 每个 Agent 使用唯一、至少 24 字符的 token。
- Agent ID 保持稳定：job owner 使用 ID 持久化；同 ID 换 token 后仍能访问历史 job。
- 不向普通 Agent 授予 `*`；配置解析也会拒绝该 scope。
- 日常执行建议只授予 `commands:read`、`jobs:submit`、`jobs:read`、`jobs:cancel`、`sessions:read`。
- `control:write`、`metrics:read`、`audit:read` 仅授予独立运维调用方。

轮换管理员 token：替换 `secrets/api_token` 后重启 backend。轮换 Agent token：修改 JSON 中对应 token，保持 `id` 不变，然后重启 backend。

## 告警与指标

Prometheus endpoint：`GET /metrics`，需要 `metrics:read`。示例规则在 [`../ops/prometheus-alerts.yml`](../ops/prometheus-alerts.yml)。

优先告警：

- `opencli_backend_bridge_ready == 0`
- queued job 超过容量的 80%
- 任一 session 为 `needs_login`
- watchdog termination 增加
- 持续发生 rate limit

指标 endpoint 会主动检查 Bridge，scrape timeout 应大于 2 秒。

## 故障处理

### GUI 关闭最后一个 tab 后黑屏

Chromium 使用 `--disable-background-mode`，LinuxServer watchdog 使用 `RESTART_APP=true`。主进程退出后通常会自动拉起；先等待约 15–30 秒并刷新 GUI。

检查 Chromium 是否重新生成主进程：

```bash
/usr/local/bin/docker top opencli-chromium -eo pid,ppid,comm,args
```

若仍未恢复，先 pause/drain，再按顺序重启 Chromium 和 backend，随后验证 Bridge 和 session：

```bash
opencli_backend_compose restart chromium
opencli_backend_compose restart backend
```

浏览器 profile 挂载在 `/config`，容器或主进程重启不应清除登录态；仍必须使用 session check 验证。

### readiness 503 / Bridge 断开

1. 检查 `/health/ready` 中 `bridge` 字段。
2. 检查 Chromium 主进程和扩展进程是否存在。
3. 先重启 backend，让 OpenCLI daemon 重新初始化。
4. 仍未恢复时 pause/drain 并重启 Chromium，再重启 backend。
5. 恢复后运行 X、小红书 session check。

### NAS 重启后 GUI 正常但 API 被重置

如果 Chromium GUI 可访问、`18080` TCP 也开放，但 HTTP 请求被 reset，先检查 backend 是否停在
`Exited`，以及运行态 restart policy / network mode 是否偏离 Compose：

```bash
/usr/local/bin/docker inspect opencli-backend \
  --format 'status={{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}} network={{.HostConfig.NetworkMode}}'
```

暂停并排空队列后，按当前 Compose 强制重建 backend。不要使用 `--no-deps`：

```bash
opencli_backend_compose up -d --force-recreate backend
```

完成后重新验证 restart policy、network mode、`/health/ready` 和两个 session check。

### `needs_login`

停止该站点的自动业务重试，按“人工登录或浏览器接管”流程处理。验证码、二次验证和站点风控只能人工完成。

### `queue_full` 或队列长期不下降

1. 查看 `/v1/control` 的 counts 和 active job IDs。
2. 查看 `/metrics` 的 Bridge、active、queued 与 watchdog 指标。
3. 查询 active job；确认可取消后调用 cancel。
4. 不要通过提高容量掩盖 Bridge 断开或卡死任务。

### `outcome_unknown`

该状态表示服务无法确认网页操作是否已经生效。write 操作禁止自动重放；read 操作可在确认 Bridge 和 session 后使用新幂等键重试。保留原 job ID用于审计。

## 故障演练范围

已经自动或实机验证：backend 重启恢复、执行中状态恢复、Chromium 主进程自愈、Bridge 重连、登录态持久化。

整台 NAS 重启会影响其他服务，必须在维护窗口单独执行，不属于日常 backend 发布步骤。
