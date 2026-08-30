# OpenCLI Backend 验收记录

日期：2026-08-06
追加验收：2026-08-07
环境：NAS `192.168.50.10`，Docker Compose 2.20.1，x86_64，无 AVX2

## 初始部署版本（2026-08-06）

- 部署目录：`/volume1/docker/opencli-backend`
- Chromium 镜像：`local/opencli-chromium:1.8.6-kyangc.3`
- Backend 镜像：`local/opencli-backend:1.8.6-kyangc.3`
- Backend service：`opencli-backend` `0.3.0`
- OpenCLI：`1.8.6-kyangc.3`
- Browser Bridge 扩展：`1.0.22.3`
- OpenCLI 源码提交：`ba4e7191abdc42bd865c96b31bd8021806d866df`

## Stable 升级实测（2026-08-29）

- Chromium 镜像：`local/opencli-chromium:1.8.7-kyangc.2`
- Backend 镜像：`local/opencli-backend:1.8.7-kyangc.2`
- OpenCLI stable 提交：`f8012cd9acfb7f69c996af40e23380fe41a78947`
- 运行时版本：CLI / daemon `1.8.7-kyangc.2`，Browser Bridge `1.0.23.1`
- OpenCLI stable CI 通过；backend 38 个 Node 测试通过；CLI 与扩展 production audit 均为 0 漏洞
- 外部 readiness 返回 200；X 与小红书 session check 均为 `authenticated`
- 携程 catalog 暴露 14 个 read 命令，包含 flight、hotel-search、train 和 attraction
- 终止 backend 主进程后，Docker restart count 从 0 增至 1，约 16 秒恢复 healthy 和 ready

## 自动验收结果

| 验收项 | 结果 | 证据摘要 |
| --- | --- | --- |
| GUI 访问控制 | 通过 | 无认证请求返回 401，使用文件型 secret 认证返回 200 |
| Bridge 自动连接 | 通过 | readiness 返回 200；daemon 与扩展版本匹配；识别到一个浏览器 profile |
| 真实浏览器任务 | 通过 | `bilibili hot --limit 1` 经 HTTP API 返回结构化数组结果 |
| 初始串行队列基线 | 通过 | 2026-08-06 验证连续两条任务严格串行；2026-08-07 已升级为下述资源感知调度 |
| 暂停与恢复 | 通过 | pause 后 readiness 为 503，resume 后恢复 200 |
| Bridge 故障检测 | 通过 | 终止扩展渲染进程后 readiness 为 503，扩展重连后恢复 200 |
| 重启恢复 | 通过 | 任务处于 `running` 时重启 backend，恢复状态为 `outcome_unknown`，未自动重放 |
| 登录态持久化 | 通过 | 小红书与 X 的只读 `whoami` 在容器重建前后均成功，匿名摘要完全一致 |
| Session Check API | 通过 | 小红书与 X 经便捷接口入队后均成功并确认已登录 |
| Chromium 退出自愈 | 通过 | 主进程退出后 watchdog 自动生成新 PID，Bridge 自动重连，readiness 恢复 200 |
| 动态命令目录 | 通过 | backend 从 1,331 条 manifest 中自动开放 978 条 read 命令；write 命令详情返回 404 |
| 资源感知并发 | 通过 | 小红书与 X 的 persistent read 时间窗口重叠；连续两条 X persistent read 严格串行 |
| Agent 有界等待 | 通过 | 终态可在一次调用中返回；等待超时返回 job id 且不会取消持久任务 |
| MCP v2 | 通过 | 官方 client 从 LAN 完成 modern 协商、bearer auth、search、describe、run 与 get |
| Agent scope 与隔离 | 通过 | 普通 Agent 可执行授权的 MCP/REST 操作；metrics、audit、control 返回 403；任务按 owner 隔离 |
| 容量与 watchdog | 通过 | 队列上限、按 Agent 限流、幂等优先和独立执行 watchdog 均有自动测试 |
| 审计与指标 | 通过 | SQLite 审计和 scoped Prometheus endpoint 已上线，输出不包含 bearer token |
| 主动登录探测 | 通过 | 周期性队列探测报告 X 与小红书均为 authenticated，不暴露账号输出 |
| v0.3 backend 重启演练 | 通过 | 健康恢复、暂停状态持久化，Chromium 容器未重建 |
| v0.3 Chromium 故障演练 | 通过 | 主进程变化、Bridge 重连，X 与小红书 `whoami` 均成功 |
| 本地回归测试 | 通过 | 35 个 Node 测试全部通过；npm audit 为 0 漏洞 |

## v0.3 生产硬化实测

2026-08-07 在保持原 Chromium 容器和浏览器 profile 的情况下完成升级：

1. 新建 `internal-agent` 最小权限 token；其 command catalog、MCP search/run/get 可用，`/metrics`、`/v1/audit`、`/v1/control` 均返回 403。
2. 管理员 token 可读取 audit 与 Prometheus metrics；队列容量指标为 100，并包含 Bridge、session、限流和 watchdog 状态。
3. 官方 MCP v2 client 使用普通 Agent token 完成自动协议协商、五工具发现、Hacker News 搜索、执行与结果读取。
4. 主动 session monitor 经同一资源感知队列检查 X 与小红书，两个站点均报告 `authenticated`。
5. 单独重启 backend 后健康恢复，SQLite 中的暂停状态保持，Chromium `StartedAt` 未变化。
6. 队列暂停并排空后终止 Chromium 主进程；镜像 watchdog 启动新进程，Bridge 自动恢复，两个站点的登录态检查均成功。
7. 未执行整台 NAS 重启，避免影响本项目范围外服务；该项应在维护窗口单独安排。

## MCP Agent 链路实测

2026-08-07 使用官方 MCP TypeScript v2 client 从 backend 容器外连接 `/mcp`：

1. 无 bearer token 请求返回 401。
2. client 通过 `versionNegotiation: auto` 协商为 `modern` protocol era。
3. `tools/list` 只返回 search、describe、run、get、cancel 五个固定工具。
4. 搜索 `top stories` 精确找到 `hackernews.top`，describe 返回七个输出字段。
5. `opencli_run` 以结构化参数请求两条结果，job 成功；随后 `opencli_get_job` 返回相同成功终态。
6. 验收结束后 backend healthy，队列 `paused=false`、`activeCount=0`、`drained=true`，近期无 API/MCP/queue 错误日志。

## 动态目录与并发调度实测

2026-08-07 在保留真实登录态的 NAS 上完成 API 级验收：

1. `/v1/commands?site=twitter` 返回 20 条允许的 read 命令，`twitter/whoami` 描述包含 `siteSession=persistent`。
2. write 命令 `xiaohongshu/login` 不在外部 catalog 中，详情接口返回 404。
3. 同时提交小红书与 X 的 `whoami`，两个 job 均成功且执行时间窗口重叠。
4. 同时提交两条 X `whoami`，第二条只在第一条完成后启动。
5. 验收结束时 `activeCount=0`、`maxConcurrency=2`、`drained=true`，队列保持运行状态。

## 登录态持久化实测

用户通过 GUI 完成小红书与 X 登录后，验收过程如下：

1. 暂停队列并确认排空。
2. 分别调用两个站点的只读 `whoami`，只保留不可逆摘要作为基线。
3. 重建 Chromium 与 backend，等待 Browser Bridge 自动恢复。
4. 再次调用相同命令；两边均返回 `logged_in=true`，摘要与重建前一致。
5. 恢复队列并确认 readiness 返回 200。

人工操作前应暂停队列并等待排空，避免自动任务和人工点击争用同一个浏览器实例。

## 当前边界

- 当前自动开放 OpenCLI catalog 中的 read site adapter；write、管理命令和敏感参数默认禁止。
- API 与 GUI 只绑定局域网，不提供公网暴露方案。
- 当前服务面向内部 Agent；多浏览器和多账号尚未纳入。
