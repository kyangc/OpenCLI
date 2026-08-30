# OpenCLI Backend Agent 接入指南

本文档面向调用 OpenCLI Backend 的内部 Agent。MCP 是推荐入口；REST 适合没有 MCP client、需要监控，或需要运维控制的调用方。

## 结论与适用边界

当前接口适合可信内部 Agent：工具面固定、命令可动态发现、参数与错误结构化、任务状态持久化，并支持幂等重试。Agent 不应获得管理员 token，也不应尝试绕过 command catalog、生成原始 shell 命令或直接操作浏览器。

默认部署只开放 OpenCLI catalog 中的 read 命令。write 命令只有在管理员显式 allowlist 后才可能出现；Agent 必须读取 command 的 `access`，不能假设 `opencli_run` 永远只读。

## 推荐 MCP 配置

不同 Agent host 的配置文件格式可能不同，核心信息只有 endpoint 和 bearer token：

```json
{
  "mcpServers": {
    "opencli": {
      "url": "http://192.168.50.10:18080/mcp",
      "headers": {
        "Authorization": "Bearer <AGENT_TOKEN>"
      }
    }
  }
}
```

不要把 token 写入仓库、prompt、日志或任务参数。推荐通过 Agent host 的 secret/environment 机制注入。

普通执行 Agent 的建议最小 scope：

```json
["commands:read", "jobs:submit", "jobs:read", "jobs:cancel", "sessions:read"]
```

## 固定工具与 scope

| MCP tool | 所需 scope | 用途 |
| --- | --- | --- |
| `opencli_search_commands` | `commands:read` | 用简短关键词或站点检索允许的命令 |
| `opencli_describe_command` | `commands:read` | 获取参数、类型、输出列、示例和 session 行为 |
| `opencli_run` | `jobs:submit` | 提交持久任务并有界等待 |
| `opencli_get_job` | `jobs:read` | 查询自己创建的任务及终态结果 |
| `opencli_cancel_job` | `jobs:cancel` | 取消自己创建的 queued/active 任务 |

MCP 的 `tools/list` 会根据 token scope 自动裁剪。缺少的工具通常意味着 token 权限不足，不应通过猜测名称强行调用。

## Agent 标准调用算法

### 1. 搜索命令

不确定 site/command 时，先调用 `opencli_search_commands`。搜索当前是关键词匹配，不是向量语义搜索；优先使用一到三个简短英文关键词，例如 `top stories`、`search posts`、`current account`。

如果结果为 0：

1. 去掉修饰词，保留核心名词或动词。
2. 已知站点时传 `site`；未知站点时不要猜 site。
3. 仍无结果时，使用空 query 分页浏览，而不是虚构 command 名称。

### 2. 描述命令

执行前调用 `opencli_describe_command`，读取：

- `access`：`read` 或 `write`。
- `args[]`：参数名、类型、是否必填、是否 positional、可选值。
- `columns`：常见输出字段；真实结果仍可能为空或随站点变化。
- `browser`、`siteSession`：是否占用浏览器，以及 persistent session 冲突语义。
- `example`、`strategy`、`domain`：辅助理解，不应复制示例中的敏感值。

只传 `args[]` 中存在的结构化 `params`。不要传 `--format`，不要把 cookie、password、token 或 secret 放进参数。

### 3. 生成幂等键

每个上游逻辑操作生成一个稳定的 `idempotencyKey`，建议格式：

```text
<agent-run-id>:<step-id>:<attempt>
```

同一个 key 永远返回第一次创建的 job，包括失败、`needs_login` 或 `outcome_unknown` 的 job。因此：

- 网络断开、不确定提交是否到达：使用原 key 重试。
- 只是等待超时：使用原 job ID 查询，不要重新提交。
- 人工重新登录后需要真正再执行一次：使用新的 attempt/key。
- 修正参数后再执行：使用新的 key。

### 4. 执行并处理结果

典型调用：

```json
{
  "site": "hackernews",
  "command": "top",
  "params": { "limit": 3 },
  "waitTimeoutSeconds": 60,
  "idempotencyKey": "run-01:fetch-top:1"
}
```

在 MCP 中优先读取 `structuredContent`；`content[0].text` 是兼容用的同内容 JSON 文本。

终态成功示例：

```json
{
  "created": true,
  "job": { "id": "...", "status": "succeeded" },
  "result": {
    "status": "succeeded",
    "errorCode": null,
    "output": [{ "title": "..." }],
    "outputTruncated": false
  }
}
```

有界等待超时示例：

```json
{
  "created": true,
  "job": { "id": "...", "status": "running" },
  "waitTimedOut": true
}
```

`waitTimedOut=true` 只表示本次等待结束；durable job 仍在运行。保存 `job.id`，随后调用 `opencli_get_job`。建议轮询间隔从 1 秒开始并逐步退避到 5–10 秒。

## Job 状态决策表

| `status` | 是否终态 | Agent 动作 |
| --- | --- | --- |
| `queued` | 否 | 等待并退避轮询 |
| `running` | 否 | 等待；不要重复提交 |
| `cancel_requested` | 否 | 等待终态；取消是 best effort |
| `succeeded` | 是 | 消费 `result.output`；`errorCode=empty_result` 仍是成功 |
| `failed` | 是 | 按 `errorCode` 处理，必要时用新 key 创建新 attempt |
| `needs_login` | 是 | 停止自动重试，通知人工登录；恢复后用新 key 重试 |
| `cancelled` | 是 | 结束当前 attempt |
| `interrupted` | 是 | 不自动重放；根据命令读写性质人工或策略决策 |
| `outcome_unknown` | 是 | 可能已经产生效果；write 禁止自动重试，read 可在确认后用新 key 重试 |

MCP 对非成功终态返回 `isError=true`，但详细 job/result 仍位于 `structuredContent`。不要只记录通用的 tool error 文本而丢掉 `status` 和 `errorCode`。

## 错误恢复

### 提交前错误

| 错误 | `retryable` | 处理方式 |
| --- | --- | --- |
| `invalid_body` / `invalid_parameter` | false | 修正输入 |
| `missing_parameter` / `unknown_parameter` | false | 重新 describe，然后修正 `params` |
| `command_not_allowed` | false | 重新 search；不要猜命令 |
| `parameter_not_allowed` / `raw_args_not_allowed` | false | 删除敏感、format 或原始 args |
| `queue_full` | true | 按 `retryAfterSeconds` 退避，保留同一个幂等键 |
| `rate_limited` | true | 按 `retryAfterSeconds` 退避，保留同一个幂等键 |
| HTTP 401 `unauthorized` | 否 | token 缺失、错误或已轮换；交给运维 |
| HTTP 403 `forbidden` | 否 | 缺少 `requiredScope`；交给运维调整 scope |

### 执行错误

| `errorCode` | 建议动作 |
| --- | --- |
| `empty_result` | 正常成功；返回空结果，不要重试 |
| `authentication_required` | 人工登录；恢复后新建 attempt |
| `browser_bridge_unavailable` | 等待 readiness 恢复，再用新 key 重试 read 操作 |
| `command_timeout` | catalog 明确为 read 时终态是 `failed`，可在上层 retry budget 内新建 attempt；write 或元数据未知时终态仍是 `outcome_unknown`，不得自动重试 |
| `service_restarted_during_execution` | 结果不确定；同上 |
| `opencli_configuration_error` | 不重试，交给运维 |
| `spawn_error` / `worker_internal_error` | 不高频重试，交给运维并附 job ID |
| `opencli_exit_<n>` | 保留 job ID、stderr 与 errorCode，交给运维或站点适配器维护者 |

## 并发认知

- non-browser、ephemeral tab 和不同 persistent site session 可以并发。
- 同一 `profile + persistent site` 严格串行。
- write 或调度元数据未知的命令独占执行。
- Agent 可以并发提交任务，不需要自己维护全局锁；仍应避免无意义的同站点请求风暴。

## 人工接管与登录失效

普通 Agent 可通过 REST `GET /v1/sessions`（需要 `sessions:read`）读取配置站点的 `authenticated`、`needs_login`、`checking`、`error` 状态。该接口不返回账号信息。

当任务返回 `needs_login` 时，Agent 应输出清晰的人类动作：站点名、job ID、需要打开 Chromium GUI 登录。不要自动处理验证码、二次验证或风控页面，也不要持续重试。

## 建议放入 Agent system prompt 的规则

```text
使用 OpenCLI 时：未知命令先 search，再 describe；只传 describe 返回的结构化 params。
每次逻辑操作都带稳定 idempotencyKey。waitTimedOut 后查询原 job，不重复提交。
needs_login 必须停止自动重试并请求人工登录；outcome_unknown 不得自动重放 write 操作。
不要把 token、cookie、password、secret 或账号数据放入参数、日志和回复。
```

## AI 友好性检查结果

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 小型稳定工具面 | 通过 | 固定 5 个 MCP tools，不为大量动态命令展开 tool |
| 动态发现 | 通过 | search + describe 返回参数和执行元数据 |
| 自纠错输入 | 通过 | 结构化参数、稳定错误 code、field、retryable |
| 长任务处理 | 通过 | 有界等待、durable job、get/cancel |
| 网络重试安全 | 通过 | Agent 级幂等键 |
| 权限最小化 | 通过 | scope 裁剪工具；job owner 隔离 |
| 人工接管 | 通过 | `needs_login` 和 session 状态显式建模 |
| 语义搜索 | 有限 | 当前是关键词搜索；Agent 应使用短关键词并在 0 结果时放宽查询 |
| write exactly-once | 不承诺 | 只保证提交幂等；网页动作结果可能为 `outcome_unknown` |
