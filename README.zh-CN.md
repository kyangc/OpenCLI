# OpenCLI

> **把任意网站变成 CLI & 在你的登录态浏览器上跑 Browser Use。**
> 把网站、浏览器会话、Electron 应用和本地工具，统一变成适合人类与 AI Agent 使用的确定性接口。
> 或者在任意页面上跑 Browser Use —— 导航、填表单、点击、抓取、自动化。

[![English](https://img.shields.io/badge/docs-English-1D4ED8?style=flat-square)](./README.md)
[![Fork release](https://img.shields.io/github/v/release/kyangc/OpenCLI?filter=kyangc-v*&style=flat-square&label=fork)](https://github.com/kyangc/OpenCLI/releases)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.18.1-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)

> [!IMPORTANT]
> 这是 [jackwener/opencli](https://github.com/jackwener/opencli) 的
> **kyangc 生产 fork**。请从本仓库安装 fork release，不要把 npm 或上游
> Chrome Web Store 当作 fork 的发布源。当前版本线为 CLI `2.0.0`
>（`kyangc-v2.0.0`）和扩展 `2.0.0`（`kyangc-ext-v2.0.0`），对应的上游基线
> 分别是 `1.8.7` 和扩展 `1.0.23`。

OpenCLI 可以用同一套 CLI 做三类事情：

- **直接使用现成适配器**：B站、知乎、小红书、Twitter/X、Reddit、HackerNews 等 [100+ 站点](#内置命令) 开箱即用。
- **让 AI Agent 操作任意网站**：在你的 AI Agent（Claude Code、Cursor 等）中安装 `opencli-browser` skill，Agent 就能用你的已登录浏览器导航、点击、输入/填充、提取任意网页内容。
- **把新网站写成 CLI**：用 `opencli browser` 原语 + `opencli-adapter-author` skill，从站点侦察、API 发现、字段解码到 `opencli browser verify` 一条龙。

除了网站能力，OpenCLI 还是一个 **CLI 枢纽**：你可以把 `gh`、`docker`、`longbridge`、`tg`、`discord`、`wx`、`ntn`（Notion）等本地工具统一注册到 `opencli` 下，也可以通过桌面端适配器控制 Cursor、Trae CN、Codex、Antigravity、ChatGPT、Trae SOLO 等 Electron 应用。

## 这个 fork 做了什么

这个 fork 保留上游 OpenCLI 的命令能力，重点补强浏览器型 Provider 在本机或
远端长期运行的 headed Chrome 中的可靠性。

| 范围 | Fork 行为 |
|------|-----------|
| 浏览器操作生命周期 | 所有一次性浏览器型 adapter 都经过同一个、与 Provider 无关的 Browser Operation 边界，拥有唯一 operation ID、deadline/取消传播和 tab lease。 |
| 可核验清理 | 任务结束时阻止迟到命令、解除 debugger、关闭自己拥有的 tab、释放 lease，并返回 teardown receipt。receipt 不完整会明确报错，不再静默“尽力清理”。 |
| 全量 inventory | 同一个公共模块可返回所选 Chrome profile 中经过净化的 window、tab 和 lease 清单，让泄漏可观测，同时不暴露页面正文。 |
| 持久会话 | 明确声明为 persistent 的站点会话保留站点 tab 和登录连续性。清理只针对失败的一次性 operation，不误关其他持久会话或用户自己的 tab。 |
| Chrome 资源复用 | browser 命令与 adapter 使用分开的受管 tab group/window；空的自动化容器可以复用，避免无意义地不断新建 window。 |
| 小红书可靠性 | 小红书搜索是第一组生产压力测试：对 hydration/acquisition、笔记批次和总墙钟时间设上限，支持取消、一次有界重试、不可用/重复筛选项处理以及失败搜索 tab 回收；这些能力没有做成 Provider 特例。 |
| 长期在线 backend | 可选的远程控制面模块位于 `services/opencli-backend`。CLI、扩展和 backend 从同一个 `stable` checkout 构建，同时继续隔离进程、包、运行数据和容器。 |
| 发布安全 | CLI 与 MV3 扩展使用独立 fork 版本；release 提供带版本的构件与校验和，service worker 文件名带版本，发布 Gate 会把 CLI 与扩展一起测试。 |
| 真实浏览器 Gate | 面向 `stable` 的浏览器/扩展生命周期改动在 Linux 上运行合成 daemon + MV3 扩展 + 真实 headed Chrome 的 teardown 测试，并在 Linux、macOS、Windows 上运行 daemon transport 合约测试。 |

清理边界只拥有 OpenCLI 创建的 lease 和 tab。它**不会**杀掉 Chrome、删除
浏览器 profile，也不会关闭任意用户 tab。关闭 operation 自己的 tab 会停止该
页面活动；renderer 进程本身最终仍由 Chrome 回收。

### 可选的长期在线 backend

[`services/opencli-backend`](https://github.com/kyangc/OpenCLI/tree/stable/services/opencli-backend)
为内部 Agent 提供带
鉴权的 REST/MCP adapter、SQLite 持久队列、资源感知调度、审计和运维指标。
它只通过公开 CLI interface 使用 OpenCLI：`opencli list -f json`、结构化 argv、
JSON 输出和已记录的退出码；不会导入 CLI 或 daemon 的实现文件。

backend 要求 Node.js 24，仍是独立安装的包和独立部署的容器。迁入同仓后，Docker
直接从同一个 checkout 构建 CLI、unpacked 扩展和 backend，删除了原先跨仓的
commit pin。浏览器 profile、SQLite、OpenCLI state 和 secrets 仍在 Git 之外，
统一挂到显式配置的 `OPENCLI_RUNTIME_ROOT`。配置方式和安全约束见
[backend README](https://github.com/kyangc/OpenCLI/blob/stable/services/opencli-backend/README.md)。

## 快速开始

### 1. 安装 fork CLI

OpenCLI 要求 **Node.js >= 20.18.1**。从本 fork 的 [最新 GitHub
Release](https://github.com/kyangc/OpenCLI/releases/latest) 下载 CLI tarball
和 `SHA256SUMS`，校验后安装到 release 独立目录：

下面命令适用于 macOS/Linux。Windows 也应使用同一个 tarball 和显式的
release 独立 npm prefix，再把该 prefix 加入 `PATH`；不要按包名安装 registry
版本。

```bash
node --version
grep 'jackwener-opencli-2.0.0.tgz$' SHA256SUMS | sha256sum -c -
# macOS：把管道后的命令换成 `shasum -a 256 -c -`

OPENCLI_RELEASE=kyangc-v2.0.0
OPENCLI_PREFIX="$HOME/.local/share/opencli/releases/$OPENCLI_RELEASE/runtime"
npm install --prefix "$OPENCLI_PREFIX" --global ./jackwener-opencli-2.0.0.tgz
mkdir -p "$HOME/.local/bin"
ln -sfn "$OPENCLI_PREFIX/bin/opencli" "$HOME/.local/bin/opencli"
opencli --version
```

请确保 `~/.local/bin` 排在 npm 全局 bin 目录之前。这个 fork **不要**用
`npm install -g @jackwener/opencli` 安装：该包名只是为了兼容上游 adapter /
plugin import，npm registry 里的上游包可能覆盖 fork runtime。完整目录布局见
[fork 发布与回滚说明](./docs/kyangc-release.md)。

### 2. 安装 Browser Bridge 扩展

OpenCLI 通过轻量 Browser Bridge 扩展和本地微型 daemon 与 Chrome/Chromium 通信。daemon 会按需自动启动。

1. 从本 fork 的 [Releases 页面](https://github.com/kyangc/OpenCLI/releases)
   下载匹配的 `opencli-extension-v2.0.0.zip`。
2. 用同一 release 的 `SHA256SUMS` 校验后，解压到固定目录，例如
   `~/.local/share/opencli/browser-extension/current`。
3. 打开 `chrome://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**，
   选择这个固定目录。
4. 后续替换扩展文件后，需要在扩展页面点击**重新加载**；只更新磁盘文件不会
   更新 Chrome 已经加载的 MV3 worker。

上游 Chrome Web Store 构件不包含这个 fork 的完整发布生命周期。需要可核验
teardown 时，请使用版本匹配的 fork ZIP。

### 3. 验证环境

```bash
opencli doctor
```

### 4. 跑第一个命令

```bash
opencli list
opencli hackernews top --limit 5
opencli bilibili hot --limit 5
```

## 给人类用户

如果你只是想稳定地调用网站或桌面应用能力，主路径很简单：

- `opencli list` 查看当前所有命令
- `opencli <site> <command>` 调用内置或生成好的适配器
- `opencli external register mycli` 把本地 CLI 接入同一发现入口
- `opencli doctor` 处理浏览器连通性问题

## 扩展 OpenCLI

如果你想新增自己的命令，先看 [扩展 OpenCLI](./docs/zh/guide/extending-opencli.md)。README 只保留入口；目录结构、源码管理方式和安装命令放在文档里。

| 需求 | 推荐路径 |
|------|----------|
| 把个人网站命令放在自己的 Git repo | `opencli plugin create` + `opencli plugin install file://...` |
| 快速写一个本机私人 adapter | `opencli browser init <site>/<command>`，放在 `~/.opencli/clis/` |
| 本地修改官方 adapter | `opencli adapter eject <site>` + `opencli adapter reset <site>` |
| 发布或安装第三方命令 | `opencli plugin install github:user/repo` |
| 包装已有本机 binary | `opencli external register <name>` |

## 给 AI Agent

OpenCLI 的 browser 命令是给 AI Agent 用的——不是手动执行的。把 skill 安装到你的 AI Agent（Claude Code、Cursor 等）中，Agent 就能用你的已登录 Chrome 会话替你操作网站。

### 安装 skill（同时也用于更新）

```bash
npx skills add kyangc/OpenCLI
```

或只装需要的 skill：

```bash
npx skills add kyangc/OpenCLI --skill opencli-adapter-author
npx skills add kyangc/OpenCLI --skill opencli-autofix
npx skills add kyangc/OpenCLI --skill opencli-browser
npx skills add kyangc/OpenCLI --skill opencli-browser-sitemap
npx skills add kyangc/OpenCLI --skill opencli-sitemap-author
npx skills add kyangc/OpenCLI --skill opencli-usage
```

### 选择哪个 skill

| Skill | 适用场景 | 你对 AI Agent 说的话 |
|-------|---------|-------------------|
| **opencli-adapter-author** | 为新站点写可复用适配器，或给已有站点添加命令 | "帮我做一个抖音热门的适配器" / "帮我做一个抓取这个页面热帖的命令" |
| **opencli-autofix** | 内置命令失败时修复已有适配器 | "`opencli zhihu hot` 返回空了，修一下" |
| **opencli-browser** | 实时驱动 Chrome 页面——导航、填表单、点击、抓取 | "帮我看看小红书的通知" / "帮我填一下这个表单" / "用浏览器命令抓取这个页面" |
| **opencli-browser-sitemap** | 使用站点 sitemap 上下文来操作浏览器任务 | "用 sitemap 帮我少走弯路地操作这个网站" |
| **opencli-sitemap-author** | 创建或更新面向浏览器 Agent 的站点 sitemap | "把刚发现的稳定流程记录到这个站点的 sitemap" |
| **opencli-usage** | 所有命令和站点的快速参考 | "OpenCLI 有哪些 Twitter 相关的命令？" |

### 工作原理

安装 `opencli-browser` skill 后，你的 AI Agent 可以：

1. **导航**到任意 URL，使用你的已登录浏览器
2. **读取**页面内容——通过结构化 DOM 快照（不是截图）
3. **交互**——点击按钮、填写表单、选择选项、按键
4. **提取**页面数据或拦截网络 API 响应
5. **等待**元素、文本或页面跳转

Agent 在内部自动处理所有 `opencli browser` 命令——你只需用自然语言描述想做的事。

**Skill 参考文档：**
- [`skills/opencli-browser/SKILL.md`](./skills/opencli-browser/SKILL.md) — 实时驱动 Chrome（导航、填表单、点击、抓取）
- [`skills/opencli-browser-sitemap/SKILL.md`](./skills/opencli-browser-sitemap/SKILL.md) — 操作浏览器任务时消费 sitemap 上下文
- [`skills/opencli-sitemap-author/SKILL.md`](./skills/opencli-sitemap-author/SKILL.md) — 创建或更新站点 sitemap 知识
- [`skills/opencli-adapter-author/SKILL.md`](./skills/opencli-adapter-author/SKILL.md) — 给新站点写适配器，全流程
- [`skills/opencli-autofix/SKILL.md`](./skills/opencli-autofix/SKILL.md) — 修复已有适配器
- [`skills/opencli-usage/SKILL.md`](./skills/opencli-usage/SKILL.md) — 命令和站点参考

`browser` 可用命令包括：`open`、`state`、`click`、`type`、`fill`、`select`、`keys`、`wait`、`get`、`find`、`extract`、`frames`、`screenshot`、`scroll`、`back`、`eval`、`network`、`tab list`、`tab new`、`tab select`、`tab close`、`init`、`verify`、`close`。

`opencli browser` 命令必须紧跟一个 `<session>` 位置参数。`opencli browser work open <url>` 和 `opencli browser work tab new [url]` 都会返回 target ID。`opencli browser work tab list` 用来查看当前已存在 tab 的 target ID，再通过 `--tab <targetId>` 把命令明确路由到某个 tab。`tab new` 只会新建 tab，不会改变默认浏览器目标；只有显式执行 `tab select <targetId>`，才会把该 tab 设为同一 session 后续未指定 target 的默认目标。

## 为新站点写适配器

当你需要的网站还没覆盖时，用 `opencli-adapter-author` skill，全流程：

1. **侦察**站点，分类 pattern（SPA / SSR / JSONP / Token / Streaming）
2. **发现** endpoint——network 精读、initial state、bundle 搜索、token 溯源，或 interceptor 兜底
3. **定认证**——`PUBLIC` / `COOKIE` / `INTERCEPT` / `UI` / `LOCAL`
4. **字段解码** + 设计输出列
5. `opencli browser recon analyze <url>` → `opencli browser recon init <site>/<name>` → 写适配器 → `opencli browser recon verify <site>/<name>`
6. 站点知识沉到 `~/.opencli/sites/<site>/`，下次同站点直接吃缓存

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLI_PROFILE` | — | 多个 Chrome profile 同时连接时，要使用的 Browser Bridge profile alias/contextId |
| `OPENCLI_WINDOW` | 命令默认值 | 设为 `foreground` 或 `background` 来覆盖 Browser Bridge 窗口位置。浏览器型命令也支持 `--window <foreground\|background>` |
| `OPENCLI_SITE_SESSION` | adapter 默认值 | 设为 `ephemeral` 或 `persistent`，覆盖浏览器型 adapter 命令的 `siteSession` 元数据。`ephemeral` 会关闭 operation 自己的 tab 并释放 lease；`persistent` 会复用该站点的 tab/session。命令级 `--site-session` 优先。 |
| `OPENCLI_BROWSER_CONNECT_TIMEOUT` | `45` | 浏览器连接超时（秒） |
| `OPENCLI_BROWSER_COMMAND_TIMEOUT` | `60` | 单个浏览器命令超时（秒） |
| `OPENCLI_CDP_ENDPOINT` | — | Chrome DevTools Protocol 端点，用于远程浏览器或 Electron 应用 |
| `OPENCLI_CDP_TARGET` | — | 按 URL 子串过滤 CDP target（如 `detail.1688.com`） |
| `OPENCLI_VERBOSE` | `false` | 启用详细日志（`-v` 也可以） |
| `DEBUG_SNAPSHOT` | — | 设为 `1` 输出 DOM 快照调试信息 |

Browser Bridge daemon 与扩展的通信端口固定为 `localhost:19825`，不再支持通过 `OPENCLI_DAEMON_PORT` 配置自定义端口。

### 浏览器资源生命周期

| 工作类型 | 默认生命周期 | 结束时的行为 |
|----------|--------------|--------------|
| `opencli browser <session> ...` | 持久交互 lease | 保留选中的 tab，直到执行 `opencli browser <session> close` 或空闲回收。 |
| 浏览器型 adapter | 一次性后台 operation | 无论成功、失败、超时还是取消，都关闭自己拥有的 operation tab、释放 lease，并核验 teardown receipt。 |
| 声明 `siteSession: 'persistent'` 的 adapter | 持久站点 lease | 保留稳定站点 tab，延续登录态和工作流；需要一次性运行时可传 `--site-session ephemeral`。 |

扩展始终在它被加载的那个 Chrome profile 中工作。如果扩展加载在一台通过 VNC
观察的远端 headed Chrome 里，小红书、Twitter 和其他浏览器型 Provider 都使用
这同一个 VNC 可见的 Chrome/profile；不同任务由 lease 隔离 tab 和生命周期。
OpenCLI 不会为每个 Provider 偷偷启动一套 Chrome。

一次性任务结束后，受管自动化容器可以有意保留一个空白 marker tab/window，
供后续任务复用；这是有界基建，不是 Provider tab 泄漏。如果结果 tab、自动化
window 持续累计，或者出现 `incomplete` teardown receipt，就属于清理失败。

## 内置命令

运行 `opencli list` 查看完整注册表。

| 站点 | 命令 |
|------|------|
| **xiaohongshu** | `search` `ask` `note` `comments` `notifications` `feed` `user` `saved` `liked` `download` `publish` `follow` `unfollow` `creator-notes` `creator-note-detail` `creator-notes-summary` `creator-profile` `creator-stats` |
| **bilibili** | `hot` `search` `me` `favorite` `history` `feed` `subtitle` `summary` `video` `comments` `dynamic` `ranking` `following` `follow` `unfollow` `user-videos` `download` `creator-stats` |
| **zhihu** | `hot` `search` `question` `download` `follow` `like` `favorite` `comment` `answer` |
| **hackernews** | `top` `new` `best` `ask` `show` `jobs` `search` `user` |
| **hltv** | `search` `player-summary` `player-matches` `player-form` `player-map-pool` `player-vs-team` `player-teammate-impact` `player-duel` `match-map` `match-series` `team-matches` `team-map-pool` `event-matches` |
| **geogebra** | `eval` `add-point` `add-line` `add-circle` `add-polygon` `triangle` `hexagon` `list` `info` |
| **linkedin** | `connect` `inbox` `job-detail` `jobs-preferences` `post-analytics` `posts` `profile-experience` `profile-projects` `profile-read` `profile-analytics` `safe-send` `search` `people-search` `services-read` `sent-invitations` `thread-snapshot` `timeline` `salesnav-search` `salesnav-inbox` `salesnav-message` `salesnav-thread` |
| **reddit** | `hot` `frontpage` `popular` `search` `subreddit` `read` `user` `user-posts` `user-comments` `upvote` `save` `comment` `subscribe` `saved` `upvoted` |
| **twitter** | `trending` `search` `timeline` `tweets` `lists` `list-tweets` `list-create` `list-delete` `list-add` `list-add-batch` `list-remove` `list-remove-batch` `bookmarks` `profile` `thread` `following` `followers` `notifications` `post` `reply` `delete` `like` `likes` `article` `follow` `unfollow` `bookmark` `unbookmark` `download` `accept` `reply-dm` `block` `unblock` `hide-reply` |
| **claude** | `ask` `send` `new` `status` `read` `history` `detail` |
| **gemini** | `new` `ask` `image` `deep-research` `deep-research-result` |
| **notebooklm** | `status` `list` `open` `current` `get` `history` `summary` `note-list` `notes-get` `source-list` `source-get` `source-fulltext` `source-guide` |
| **amazon** | `bestsellers` `search` `product` `offer` `discussion` `movers-shakers` `new-releases` `rankings` |
| **upwork** | `search` `feed` `detail` |
| **slock** | `message-send` `message-read` `message-search` `channel-list` `channel-info` `channel-create` `channel-members` `channel-join` `task-list` `task-create` `task-claim` `task-status` `task-convert` `task-delete` `thread-list` `thread-follow` `attachment-upload` `attachment-download` `bookmark-add` `inbox` `dm-list` `server-list` `server-use` `whoami` |
| **huodongxing** | `events` |
| **midjourney** | `login` `whoami` `settings` `quota` `generate` `describe` `history` `status` `action` `download` |

精选清单 — **[→ 查看全部 100+ 站点和命令](./docs/adapters/index.md)**（小红书 / B站 / 知乎 / Twitter / Reddit / 抖音 / 微博 / 微信读书 / 小宇宙 / 1688 / 夸克 / Spotify / 牛客 / arxiv / Chess.com / Bilibili / 等）。

### 外部 CLI 枢纽

把现有命令行工具统一接入 `opencli <tool> ...`：

`gh` · `docker` · `vercel` · `wrangler` · `obsidian` · `longbridge` · `lark-cli` · `ntn(notion)` · `dws(DingTalk Workspace)` · `wecom-cli(企业微信)` · `tg(tg-cli)` · `discord(discord-cli)` · `wx(wx-cli)`

注册自定义本地 CLI：`opencli external register <name>`；查看所有：`opencli external list`。

**桌面应用适配器**（Electron，通过 CDP）：Cursor / Trae CN / Codex / Antigravity / ChatGPT App / ChatWise / Qoder / Discord / Doubao / Trae SOLO — 详见 [`docs/adapters/desktop/`](./docs/adapters/desktop/)。

## 下载支持

OpenCLI 支持从各平台下载图片、视频和文章。

### 支持的平台

| 平台 | 内容类型 | 说明 |
|------|----------|------|
| **小红书** | 图片、视频 | 下载笔记中的所有媒体文件 |
| **B站** | 视频 | 需要安装 `yt-dlp` |
| **Twitter/X** | 图片、视频 | 从用户媒体页或单条推文下载 |
| **Pixiv** | 图片 | 下载原始画质插画，支持多页作品 |
| **1688** | 图片、视频 | 下载商品页中可见的商品素材 |
| **小宇宙** | 音频、转录 | 使用本地凭证下载单集音频和转录 JSON / 文本 |
| **知乎** | 文章（Markdown） | 导出文章，可选下载图片到本地 |
| **微信公众号** | 文章（Markdown） | 导出微信公众号文章为 Markdown |
| **豆瓣** | 图片 | 下载电影条目的海报 / 剧照图片 |

### 前置依赖

下载流媒体平台的视频需要安装 `yt-dlp`：

```bash
# 安装 yt-dlp
pip install yt-dlp
# 或者
brew install yt-dlp
```

### 使用示例

```bash
# 下载小红书笔记中的图片/视频
opencli xiaohongshu download "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..." --output ./xhs
opencli xiaohongshu download "https://xhslink.com/..." --output ./xhs
opencli rednote download "https://www.rednote.com/search_result/<id>?xsec_token=..." --output ./rednote

# 下载B站视频（需要 yt-dlp）
opencli bilibili download BV1xxx --output ./bilibili
opencli bilibili download BV1xxx --quality 1080p  # 指定画质

# 下载 Twitter 用户的媒体
opencli twitter download elonmusk --limit 20 --output ./twitter

# 下载单条推文的媒体
opencli twitter download --tweet-url "https://x.com/user/status/123" --output ./twitter

# 下载豆瓣电影海报 / 剧照
opencli douban download 30382501 --output ./douban

# 下载 1688 商品页中的图片 / 视频素材
opencli 1688 download 841141931191 --output ./1688-downloads

# 下载小宇宙单集音频
opencli xiaoyuzhou download 69b3b675772ac2295bfc01d0 --output ./xiaoyuzhou

# 下载小宇宙单集转录
opencli xiaoyuzhou transcript 69dd0c98e2c8be31551f6a33 --output ./xiaoyuzhou-transcripts

# 导出知乎文章为 Markdown
opencli zhihu download "https://zhuanlan.zhihu.com/p/xxx" --output ./zhihu

# 导出并下载图片
opencli zhihu download "https://zhuanlan.zhihu.com/p/xxx" --download-images

# 导出微信公众号文章为 Markdown
opencli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
```

`opencli xiaoyuzhou download` 和 `transcript` 需要本地小宇宙凭证：`~/.opencli/xiaoyuzhou.json`。



## 输出格式

所有内置命令都支持 `--format` / `-f`，可选值为 `table`、`json`、`yaml`、`md`、`csv`。
`list` 命令也支持同样的格式参数，同时继续兼容 `--json`。

```bash
opencli list -f yaml            # 用 YAML 列出命令注册表
opencli bilibili hot -f table   # 默认：富文本表格
opencli bilibili hot -f json    # JSON（适合传给 jq 或者各类 AI Agent）
opencli bilibili hot -f yaml    # YAML（更适合人类直接阅读）
opencli bilibili hot -f md      # Markdown
opencli bilibili hot -f csv     # CSV
opencli bilibili hot -v         # 详细模式：展示管线执行步骤调试信息
```

## 退出码

opencli 遵循 Unix `sysexits.h`，CI / 脚本可按失败模式分支：`0` 成功、`66` 无数据、`69` Browser Bridge 未连接、`75` 超时、`77` 需要认证、`78` 配置错误、`130` Ctrl-C。完整参考：[docs/zh/guide/exit-codes.md](./docs/zh/guide/exit-codes.md)。

## 插件

通过社区贡献的插件扩展 OpenCLI。插件使用与内置命令相同的 JS 格式，启动时自动发现。

```bash
opencli plugin install github:user/opencli-plugin-my-tool  # 安装
opencli plugin list                                         # 查看已安装
opencli plugin update my-tool                               # 更新到最新
opencli plugin update --all                                 # 更新全部已安装插件
opencli plugin uninstall my-tool                            # 卸载
```

当 plugin 的版本被记录到 `~/.opencli/plugins.lock.json` 后，`opencli plugin list` 也会显示对应的短 commit hash。

| 插件 | 类型 | 描述 |
|------|------|------|
| [opencli-plugin-github-trending](https://github.com/ByteYue/opencli-plugin-github-trending) | JS | GitHub Trending 仓库 |
| [opencli-plugin-hot-digest](https://github.com/ByteYue/opencli-plugin-hot-digest) | JS | 多平台热榜聚合 |
| [opencli-plugin-juejin](https://github.com/Astro-Han/opencli-plugin-juejin) | JS | 稀土掘金热门文章 |
| [opencli-plugin-vk](https://github.com/flobo3/opencli-plugin-vk) | JS | VK (VKontakte) 动态、信息流和搜索 |
| [opencli-plugin-x-article-publisher](https://github.com/genoooool/opencli-plugin-x-article-publisher) | JS | 通过 OpenCLI 与 xPoster 将带本地图片的 Markdown 发布为 X 长文 |

详见 [插件指南](./docs/zh/guide/plugins.md) 了解如何创建自己的插件。

## 测试

Fork 发布 Gate 会核验 package metadata、TypeScript、unit/adapter/extension
测试、两端 build 和扩展 release 构件：

```bash
npm ci
npm ci --prefix extension
npm ci --ignore-scripts --prefix services/opencli-backend
TZ=Asia/Shanghai npm run verify:fork-release
npm run verify:backend
npm audit --omit=dev --audit-level=high
npm audit --omit=dev --audit-level=high --prefix extension
npm audit --omit=dev --audit-level=high --prefix services/opencli-backend
```

面向 `stable` 且触及浏览器/扩展生命周期路径的 PR 还必须通过真实 headed
Chrome Gate。Linux Gate 会启动隔离 daemon、构建后的 MV3 扩展、合成站点和
Xvfb 下的 headed Chrome，证明超时的一次性 operation 会停止页面活动并从全量
inventory 消失，同时保留无关的 persistent lease。完整测试矩阵见
[TESTING.md](./TESTING.md)。

路径限定的 Backend workflow 使用 Node.js 24 运行 backend 测试，从同一个
checkout 验证真实 catalog interface，证明 CLI tarball 不包含 backend module，
渲染 Compose，并构建最终 backend 与 Chromium 镜像。随后它会用隔离 profile、
禁用 session check 启动两个镜像，只读访问 `/health/live` 和 `/health/ready`：核对
daemon/扩展版本、已连接 profile、pending command 和持久队列空闲状态，不提交任何
Provider job。`kyangc-v*` release 必须通过同一契约和容器冒烟才允许发布。

## Fork 开发与发布

- `main` 只做 `upstream/main` 的 fast-forward 镜像，不是生产 runtime 来源。
- `stable` 是 fork 的生产事实源；候选 `codex/*` 分支和 PR 都以 `stable` 为目标。
- `services/opencli-backend` 只存在于 `stable`，继续保留自己的 package、Node.js
  24 runtime、测试、SQLite 权威和容器生命周期；`main` 仍是没有该模块的上游镜像。
- CLI tag 使用 `kyangc-v<version>`。CLI 与扩展各有独立 semver；上游基线只记录
  来源，不是 fork 版本权威。
- npm 包名和 import 仍保留 `@jackwener/opencli`，只用于兼容 adapter/plugin
  API。这个 fork 通过 GitHub release 构件分发，不覆盖上游 npm 包。
- 每个 `kyangc-v*` release 都包含 CLI tarball、匹配的 unpacked 扩展 ZIP 和
  `SHA256SUMS`。

完整的上游同步、promotion、手工重载扩展和回滚步骤见
[docs/kyangc-release.md](./docs/kyangc-release.md)。

## 常见问题排查

- **"Extension not connected" 报错**
  - 确保已加载并启用与 CLI release 匹配的 fork unpacked 扩展；替换磁盘文件后还要在 `chrome://extensions` 点击**重新加载**。
- **CLI / 扩展版本看起来对不上**
  - 执行 `opencli --version` 和 `opencli doctor`。后者会显示 daemon 和真正已连接的扩展版本；不能用磁盘上的文件版本推断 Chrome 当前加载的 MV3 版本。
- **结果 tab 或 window 反复累计**
  - 等命令进入结束态后检查 daemon/扩展日志。一个可复用的空白 automation marker 可以保留；无限增长的 Provider tab 或 incomplete teardown 不正常。
- **"attach failed: Cannot access a chrome-extension:// URL" 报错**
  - 其他 Chrome/Chromium 扩展（如 youmind、New Tab Override 或 AI 助手类扩展）可能产生冲突。请尝试**暂时禁用其他扩展**后重试。
- **返回空数据，或者报错 "Unauthorized"**
  - Chrome/Chromium 里的登录态可能已经过期。请打开当前页面，在新标签页重新手工登录或刷新该页面。
- **Node API 错误 / 缺少 `fetch` / 旧 Node 启动即崩**
  - OpenCLI 要求 **Node.js >= 20.18.1**。先执行 `node --version`，如果版本过低先升级，再重试命令。
- **Daemon 问题**
  - 检查 daemon 状态：`curl localhost:19825/status`
  - 查看扩展日志：`curl localhost:19825/logs`


## 上游项目

OpenCLI 由 [jackwener/opencli](https://github.com/jackwener/opencli) 创建。这个 fork
保留原项目署名，并通过上述 fork 发布流程定期把经过验证的上游快照合入
`stable`。

## License

[Apache-2.0](./LICENSE)
