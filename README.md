# OpenCLI

> **Convert any website into a CLI & run Browser Use on your logged-in Chrome.**
> Turn websites, browser sessions, Electron apps, and local tools into deterministic interfaces for humans and AI agents.
> Or run Browser Use against any page — navigate, fill forms, click, extract, automate.

[![中文文档](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-0F766E?style=flat-square)](./README.zh-CN.md)
[![Fork release](https://img.shields.io/github/v/release/kyangc/OpenCLI?filter=kyangc-v*&style=flat-square&label=fork)](https://github.com/kyangc/OpenCLI/releases)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.18.1-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)

> [!IMPORTANT]
> This repository is the **kyangc production fork** of
> [jackwener/opencli](https://github.com/jackwener/opencli). Install fork
> releases from this repository rather than npm or the upstream Chrome Web
> Store. The current lines are CLI `2.0.0` (`kyangc-v2.0.0`) and extension
> `2.0.0` (`kyangc-ext-v2.0.0`), based on upstream `1.8.7` / extension
> `1.0.23`.

OpenCLI gives you one surface for three different kinds of automation:

- **Use built-in adapters** for sites like Bilibili, Zhihu, Xiaohongshu, Reddit, HackerNews, Twitter/X, and [many more](#built-in-commands).
- **Let AI Agents operate any website** — install the `opencli-browser` skill in your AI agent (Claude Code, Cursor, etc.), and it can navigate, click, type/fill, extract, and inspect any page through your logged-in browser via `opencli browser` primitives.
- **Write new adapters** end-to-end with `opencli browser` + the `opencli-adapter-author` skill, which guides from first recon through field decoding, code, and `opencli browser verify`.

It also works as a **CLI hub** for local tools such as `gh`, `docker`, `longbridge`, `tg`, `discord`, `wx`, `ntn` (Notion), and other binaries you register yourself, plus **desktop app adapters** for Electron apps like Cursor, Trae CN, Codex, Antigravity, ChatGPT, and Trae SOLO.

## What this fork changes

This fork keeps the upstream OpenCLI command surface, but hardens the parts
needed to run browser-backed Providers against a long-lived local or remote
headed Chrome.

| Area | Fork behavior |
|------|---------------|
| Browser operation lifecycle | Every ephemeral browser-backed adapter runs through one Provider-neutral operation boundary with a unique operation ID, deadline/cancellation propagation, and a tab lease. |
| Verified cleanup | A terminal operation blocks late commands, detaches the debugger, closes its owned tab, releases its lease, and returns a teardown receipt. An incomplete receipt is an error rather than silent “best effort.” |
| Full inventory | The same module can report sanitized windows, tabs, and leases for the selected Chrome profile, making leaks observable without exposing page content. |
| Persistent sessions | Explicitly persistent site sessions keep their site tab and login continuity. Cleanup targets the failed ephemeral operation, not unrelated persistent or user-owned tabs. |
| Chrome resource reuse | Browser commands and adapters use separate owned tab groups/windows. Empty automation container windows may be reused instead of creating an endless series of windows. |
| Xiaohongshu reliability | Xiaohongshu search was the first production pressure test: bounded hydration/acquisition, cancellable note batches, one bounded stalled-read retry, unavailable/duplicate filter handling, and failed-search tab reclamation. These do not replace the common lifecycle with a Provider special case. |
| Release safety | CLI and MV3 extension have independent fork versions, versioned release assets and checksums, a versioned service-worker filename, and a release gate that tests CLI + extension together. |
| Real-browser gate | Browser/extension lifecycle changes targeting `stable` run synthetic daemon + MV3 extension + real headed Chrome teardown coverage on Linux, plus daemon transport contracts across Linux, macOS, and Windows. |

The operation cleanup owns OpenCLI-created leases and tabs. It does **not**
kill Chrome, delete a browser profile, or close arbitrary user tabs. Closing an
owned tab stops its page activity; Chrome remains responsible for reclaiming
the renderer process itself.

## Quick Start

### 1. Install the fork CLI

OpenCLI requires **Node.js >= 20.18.1**. Download the CLI tarball and
`SHA256SUMS` from this fork's [latest GitHub
release](https://github.com/kyangc/OpenCLI/releases/latest), verify the
artifact, and install it into a release-specific prefix:

The commands below target macOS/Linux. On Windows, install the same tarball
with an explicit release-specific npm prefix and add that prefix to `PATH`;
do not install the registry package by name.

```bash
node --version
grep 'jackwener-opencli-2.0.0.tgz$' SHA256SUMS | sha256sum -c -
# macOS: use `shasum -a 256 -c -` after the pipe instead

OPENCLI_RELEASE=kyangc-v2.0.0
OPENCLI_PREFIX="$HOME/.local/share/opencli/releases/$OPENCLI_RELEASE/runtime"
npm install --prefix "$OPENCLI_PREFIX" --global ./jackwener-opencli-2.0.0.tgz
mkdir -p "$HOME/.local/bin"
ln -sfn "$OPENCLI_PREFIX/bin/opencli" "$HOME/.local/bin/opencli"
opencli --version
```

Keep `~/.local/bin` before npm's global bin directory in `PATH`. Do **not** use
`npm install -g @jackwener/opencli` for this fork: that package name remains an
upstream/plugin compatibility surface and the npm registry can overwrite the
fork runtime. See the [fork release and rollback guide](./docs/kyangc-release.md)
for the full layout.

### 2. Install the Browser Bridge Extension

OpenCLI connects to Chrome/Chromium through a lightweight Browser Bridge extension plus a small local daemon. The daemon auto-starts when needed.

1. Download the matching `opencli-extension-v2.0.0.zip` from this fork's
   [Releases page](https://github.com/kyangc/OpenCLI/releases).
2. Verify it against the release's `SHA256SUMS` and extract it to a fixed path,
   such as `~/.local/share/opencli/browser-extension/current`.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select that fixed directory.
4. When replacing extension files later, click **Reload** on the extension.
   Updating files on disk does not update Chrome's already-loaded MV3 worker.

The upstream Chrome Web Store build does not include this fork's complete
release lifecycle. Use the matching fork ZIP when verified teardown behavior
is required.

### 3. Verify the setup

```bash
opencli doctor
```

### 4. Optional: name your Chrome profile

Each Chrome profile runs its own OpenCLI extension instance. If you use multiple Chrome profiles, list the connected profiles and assign local aliases:

```bash
opencli profile list
opencli profile rename <contextId> work
opencli profile use work
opencli --profile work browser main state
```

With only one connected profile, OpenCLI uses it automatically. With multiple connected profiles and no default, OpenCLI asks you to choose instead of guessing.

### 5. Run your first commands

```bash
opencli list
opencli hackernews top --limit 5
opencli bilibili hot --limit 5
```

## For Humans

Use OpenCLI directly when you want a reliable command instead of a live browser session:

- `opencli list` shows every registered command.
- `opencli <site> <command>` runs a built-in or generated adapter.
- `opencli external register mycli` exposes a local CLI through the same discovery surface.
- `opencli doctor` helps diagnose browser connectivity.

## Extending OpenCLI

If you want to add your own commands, start with the [Extending OpenCLI guide](./docs/guide/extending-opencli.md). README keeps this short; the guide covers the directory layout, source-control model, and install commands.

| Need | Recommended path |
|------|------------------|
| Keep personal website commands in your own Git repo | `opencli plugin create` + `opencli plugin install file://...` |
| Quickly draft a private local adapter | `opencli browser init <site>/<command>` in `~/.opencli/clis/` |
| Modify an official adapter locally | `opencli adapter eject <site>` + `opencli adapter reset <site>` |
| Publish or install third-party commands | `opencli plugin install github:user/repo` |
| Wrap an existing local binary | `opencli external register <name>` |

## For AI Agents

OpenCLI's browser commands are designed to be used by AI Agents — not run manually. Install skills into your AI agent (Claude Code, Cursor, etc.), and the agent operates websites on your behalf using your logged-in Chrome session.

### Install skills (also refreshes existing installs)

```bash
npx skills add kyangc/OpenCLI
```

Or install only what you need:

```bash
npx skills add kyangc/OpenCLI --skill opencli-adapter-author
npx skills add kyangc/OpenCLI --skill opencli-autofix
npx skills add kyangc/OpenCLI --skill opencli-browser
npx skills add kyangc/OpenCLI --skill opencli-browser-sitemap
npx skills add kyangc/OpenCLI --skill opencli-sitemap-author
npx skills add kyangc/OpenCLI --skill opencli-usage
```

### Which skill to use

| Skill | When to use | Example prompt to your AI agent |
|-------|------------|-------------------------------|
| **opencli-adapter-author** | Write a reusable adapter for a new site or add a command to an existing site | "Write an adapter for douyin trending" / "Make a command that grabs the top posts from this page" |
| **opencli-autofix** | Repair a broken adapter when a built-in command fails | "`opencli zhihu hot` is returning empty — fix it" |
| **opencli-browser** | Drive a real Chrome page ad-hoc — navigate, fill forms, click, extract | "Help me check my Xiaohongshu notifications" / "Help me fill out this form" / "Use browser commands to scrape this page" |
| **opencli-browser-sitemap** | Consume site sitemap context while driving a browser task | "Use the sitemap to navigate this website without blind clicking" |
| **opencli-sitemap-author** | Create or update site sitemap knowledge for browser agents | "Record the stable workflow you just discovered for this site" |
| **opencli-usage** | Quick reference for all OpenCLI commands and sites | "What commands does OpenCLI have for Twitter?" |

### How it works

Once `opencli-browser` is installed, your AI agent can:

1. **Navigate** to any URL using your logged-in browser
2. **Read** page content via structured DOM snapshots (not screenshots)
3. **Interact** — click buttons, fill forms, select options, press keys
4. **Extract** data from the page or intercept network API responses
5. **Wait** for elements, text, or page transitions

The agent handles all the `opencli browser` commands internally — you just describe what you want done in natural language.

**Skill references:**
- [`skills/opencli-browser/SKILL.md`](./skills/opencli-browser/SKILL.md) — drive Chrome ad-hoc (navigate, fill forms, click, extract)
- [`skills/opencli-browser-sitemap/SKILL.md`](./skills/opencli-browser-sitemap/SKILL.md) — use sitemap context while driving a browser task
- [`skills/opencli-sitemap-author/SKILL.md`](./skills/opencli-sitemap-author/SKILL.md) — create or update site sitemap knowledge
- [`skills/opencli-adapter-author/SKILL.md`](./skills/opencli-adapter-author/SKILL.md) — write a new adapter end-to-end
- [`skills/opencli-autofix/SKILL.md`](./skills/opencli-autofix/SKILL.md) — repair broken adapters
- [`skills/opencli-usage/SKILL.md`](./skills/opencli-usage/SKILL.md) — command and site reference

Available browser commands include `open`, `state`, `click`, `type`, `fill`, `select`, `keys`, `wait`, `get`, `find`, `extract`, `frames`, `screenshot`, `scroll`, `back`, `eval`, `network`, `tab list`, `tab new`, `tab select`, `tab close`, `init`, `verify`, and `close`.

`opencli browser` commands require a `<session>` positional immediately after `browser`. `opencli browser work open <url>` and `opencli browser work tab new [url]` both return a target ID. Use `opencli browser work tab list` to inspect target IDs, then pass `--tab <targetId>` to route a command to a specific tab. `tab new` creates a new tab without changing the default browser target; only `tab select <targetId>` promotes that tab to the default target for later untargeted commands in the same session.

## Writing a new adapter

When the site you need is not yet covered, use the `opencli-adapter-author` skill end-to-end:

1. **Recon** the site and pick a pattern (SPA / SSR / JSONP / Token / Streaming).
2. **Discover** the right endpoint — network inspection, initial state, bundle search, token trace, or interceptor fallback.
3. **Pick auth** — `PUBLIC` / `COOKIE` / `INTERCEPT` / `UI` / `LOCAL`.
4. **Decode** response fields and design output columns.
5. `opencli browser recon analyze <url>` → `opencli browser recon init <site>/<name>` → write adapter → `opencli browser recon verify <site>/<name>`.
6. Site knowledge persists to `~/.opencli/sites/<site>/` so the next adapter for the same site starts from context.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLI_PROFILE` | — | Browser Bridge profile alias/contextId to use when multiple Chrome profiles are connected |
| `OPENCLI_WINDOW` | command default | Set to `foreground` or `background` to override Browser Bridge window placement. Browser-backed commands also accept `--window <foreground\|background>`. |
| `OPENCLI_SITE_SESSION` | adapter default | Set to `ephemeral` or `persistent` to override `siteSession` metadata for browser-backed adapter commands. `ephemeral` closes the operation-owned tab and releases its lease; `persistent` reuses the site's tab/session. Per-command `--site-session` takes precedence. |
| `OPENCLI_BROWSER_CONNECT_TIMEOUT` | `45` | Seconds to wait for browser connection |
| `OPENCLI_BROWSER_COMMAND_TIMEOUT` | `60` | Seconds to wait for a single browser command |
| `OPENCLI_CDP_ENDPOINT` | — | Chrome DevTools Protocol endpoint for remote browser or Electron apps |
| `OPENCLI_CDP_TARGET` | — | Filter CDP targets by URL substring (e.g. `detail.1688.com`) |
| `OPENCLI_VERBOSE` | `false` | Enable verbose logging (`-v` flag also works) |
| `DEBUG_SNAPSHOT` | — | Set to `1` for DOM snapshot debug output |

Browser Bridge daemon/extension transport uses fixed `localhost:19825` and no
longer supports a custom `OPENCLI_DAEMON_PORT`.

### Browser resource lifecycle

| Work type | Default lifecycle | Terminal behavior |
|-----------|-------------------|-------------------|
| `opencli browser <session> ...` | Persistent interactive lease | Keeps its selected tab until `opencli browser <session> close` or idle cleanup. |
| Browser-backed adapter | Ephemeral background operation | Closes its owned operation tab, releases the lease, and verifies a teardown receipt on success, error, timeout, or cancellation. |
| Adapter declaring `siteSession: 'persistent'` | Persistent site lease | Keeps a stable site tab for login/workflow continuity; use `--site-session ephemeral` when a one-shot run is desired. |

The extension always operates inside the Chrome profile in which it is loaded.
If that is a remote headed Chrome observed through VNC, Xiaohongshu, Twitter,
and other browser-backed Providers all use that same VNC-visible Chrome/profile;
leases separate their tabs and lifecycles. OpenCLI does not start one hidden
Chrome process per Provider.

The reusable automation container can intentionally remain as one blank marker
tab/window after ephemeral work. That is bounded infrastructure, not a leaked
Provider tab. A growing series of result tabs, duplicate automation windows, or
an `incomplete` teardown receipt is a cleanup failure and should be reported.

## Built-in Commands

| Site | Commands |
|------|----------|
| **xiaohongshu** | `search` `ask` `note` `comments` `feed` `user` `download` `publish` `follow` `unfollow` `notifications` `creator-notes` `creator-notes-summary` `creator-note-detail` `creator-profile` `creator-stats` |
| **bilibili** | `hot` `search` `history` `feed` `ranking` `download` `comments` `dynamic` `favorite` `following` `follow` `unfollow` `me` `subtitle` `summary` `video` `user-videos` `creator-stats` |
| **zhihu** | `hot` `search` `question` `download` `follow` `like` `favorite` `comment` `answer` |
| **hackernews** | `top` `new` `best` `ask` `show` `jobs` `search` `user` |
| **hltv** | `search` `player-summary` `player-matches` `player-form` `player-map-pool` `player-vs-team` `player-teammate-impact` `player-duel` `match-map` `match-series` `team-matches` `team-map-pool` `event-matches` |
| **geogebra** | `eval` `add-point` `add-line` `add-circle` `add-polygon` `triangle` `hexagon` `list` `info` |
| **linkedin** | `connect` `inbox` `job-detail` `jobs-preferences` `post-analytics` `posts` `profile-experience` `profile-projects` `profile-read` `profile-analytics` `safe-send` `search` `services-read` `sent-invitations` `thread-snapshot` `timeline` `salesnav-search` `salesnav-inbox` `salesnav-message` `salesnav-thread` |
| **reddit** | `hot` `frontpage` `popular` `search` `subreddit` `read` `user` `user-posts` `user-comments` `upvote` `upvoted` `save` `saved` `comment` `subscribe` |
| **twitter** | `trending` `search` `timeline` `tweets` `lists` `list-tweets` `list-create` `list-delete` `list-add` `list-add-batch` `list-remove` `list-remove-batch` `bookmarks` `post` `download` `profile` `article` `like` `likes` `notifications` `reply` `reply-dm` `thread` `follow` `unfollow` `followers` `following` `block` `unblock` `bookmark` `unbookmark` `delete` `hide-reply` `accept` |
| **claude** | `ask` `send` `new` `status` `read` `history` `detail` |
| **gemini** | `new` `ask` `image` `deep-research` `deep-research-result` |
| **notebooklm** | `status` `list` `open` `current` `get` `history` `summary` `note-list` `notes-get` `source-list` `source-get` `source-fulltext` `source-guide` |
| **amazon** | `bestsellers` `search` `product` `offer` `discussion` `movers-shakers` `new-releases` `rankings` |
| **upwork** | `search` `feed` `detail` |
| **slock** | `message-send` `message-read` `message-search` `channel-list` `channel-info` `channel-create` `channel-members` `channel-join` `task-list` `task-create` `task-claim` `task-status` `task-convert` `task-delete` `thread-list` `thread-follow` `attachment-upload` `attachment-download` `bookmark-add` `inbox` `dm-list` `server-list` `server-use` `whoami` |
| **huodongxing** | `events` |
| **midjourney** | `login` `whoami` `settings` `quota` `generate` `describe` `history` `status` `action` `download` |

Curated highlights — **[→ see all 100+ supported sites & commands](./docs/adapters/index.md)** (douyin / weibo / spotify / 1688 / quark / nowcoder / google-scholar / hupu / xianyu / weread / weread-official / xiaoyuzhou / Chess.com / and more).

## CLI Hub

Unified passthrough for your existing command-line tools. Run `opencli <tool> ...` for any of:

`gh` · `docker` · `vercel` · `wrangler` · `obsidian` · `longbridge` · `lark-cli` · `ntn(notion)` · `dws(DingTalk Workspace)` · `wecom-cli(企业微信)` · `tg(tg-cli)` · `discord(discord-cli)` · `wx(wx-cli)`

Register your own with `opencli external register <name>`; list everything with `opencli external list`.

**Desktop app adapters** (Electron, via CDP): Cursor / Trae CN / Codex / Antigravity / ChatGPT App / ChatWise / Qoder / Discord / Doubao / Trae SOLO — see [`docs/adapters/desktop/`](./docs/adapters/desktop/).

## Download Support

OpenCLI supports downloading images, videos, and articles from supported platforms.

| Platform | Content Types | Notes |
|----------|---------------|-------|
| **xiaohongshu** | Images, Videos | Downloads all media from a note |
| **rednote** | Images, Videos | Downloads all media from a signed rednote note URL |
| **bilibili** | Videos | Requires `yt-dlp` installed |
| **twitter** | Images, Videos | From user media tab or single tweet |
| **douban** | Images | Poster / still image lists |
| **pixiv** | Images | Original-quality illustrations, multi-page |
| **1688** | Images, Videos | Downloads page-visible product media from item pages |
| **xiaoyuzhou** | Audio, Transcript | Downloads episode audio and transcript JSON/text with local credentials |
| **zhihu** | Column articles, answers (Markdown) | Exports with optional image download |
| **weixin** | Articles (Markdown) | WeChat Official Account articles |

For video downloads, install `yt-dlp` first: `brew install yt-dlp`

```bash
opencli xiaohongshu download "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..." --output ./xhs
opencli xiaohongshu download "https://xhslink.com/..." --output ./xhs
opencli rednote download "https://www.rednote.com/search_result/<id>?xsec_token=..." --output ./rednote
opencli bilibili download BV1xxx --output ./bilibili
opencli twitter download elonmusk --limit 20 --output ./twitter
opencli 1688 download 841141931191 --output ./1688-downloads
opencli xiaoyuzhou download 69b3b675772ac2295bfc01d0 --output ./xiaoyuzhou
opencli xiaoyuzhou transcript 69dd0c98e2c8be31551f6a33 --output ./xiaoyuzhou-transcripts
```

`opencli xiaoyuzhou download` and `transcript` require local Xiaoyuzhou credentials in `~/.opencli/xiaoyuzhou.json`.

## Output Formats

All built-in commands support `--format` / `-f` with `table` (default), `json`, `yaml`, `md`, and `csv`.

```bash
opencli bilibili hot -f json    # Pipe to jq or LLMs
opencli bilibili hot -f csv     # Spreadsheet-friendly
opencli bilibili hot -v         # Verbose: show pipeline debug steps
```

## Exit Codes

opencli follows Unix `sysexits.h` so CI / scripts can branch on failure mode: `0` success, `66` empty result, `69` Browser Bridge down, `75` timeout, `77` auth required, `78` config error, `130` Ctrl-C. Full reference: [docs/guide/exit-codes.md](./docs/guide/exit-codes.md).

## Plugins

Extend OpenCLI with community-contributed adapters:

```bash
opencli plugin install github:user/opencli-plugin-my-tool
opencli plugin list
opencli plugin update --all
opencli plugin uninstall my-tool
```

| Plugin | Type | Description |
|--------|------|-------------|
| [opencli-plugin-github-trending](https://github.com/ByteYue/opencli-plugin-github-trending) | JS | GitHub Trending repositories |
| [opencli-plugin-hot-digest](https://github.com/ByteYue/opencli-plugin-hot-digest) | JS | Multi-platform trending aggregator |
| [opencli-plugin-juejin](https://github.com/Astro-Han/opencli-plugin-juejin) | JS | 稀土掘金 (Juejin) hot articles |
| [opencli-plugin-vk](https://github.com/flobo3/opencli-plugin-vk) | JS | VK (VKontakte) wall, feed, and search |
| [opencli-plugin-x-article-publisher](https://github.com/genoooool/opencli-plugin-x-article-publisher) | JS | Publish Markdown with local images as X long-form Articles via OpenCLI and xPoster |

See [Plugins Guide](./docs/guide/plugins.md) for creating your own plugin.

## Testing

The fork release gate verifies package metadata, TypeScript, unit/adapter/
extension tests, both builds, and the extension release artifact:

```bash
npm ci
npm ci --prefix extension
TZ=Asia/Shanghai npm run verify:fork-release
npm audit --omit=dev --audit-level=high
npm audit --omit=dev --audit-level=high --prefix extension
```

PRs targeting `stable` that touch the browser/extension lifecycle paths also
run the real headed-Chrome lifecycle gate. On Linux it launches an isolated
daemon, the built MV3 extension, a synthetic site, and headed Chrome under
Xvfb, then proves that a timed-out ephemeral operation stops page activity and
disappears from full inventory while a persistent lease survives. See
**[TESTING.md](./TESTING.md)** for the complete test matrix.

## Fork development and releases

- `main` is a fast-forward mirror of `upstream/main`; it is not a production
  runtime source.
- `stable` is the fork's production source of truth. Candidate `codex/*`
  branches and PRs target `stable`.
- CLI tags use `kyangc-v<version>`. The CLI and extension have independent
  semver lines; their upstream bases are provenance, not version authorities.
- The npm package/import name remains `@jackwener/opencli` only to preserve the
  adapter/plugin API. This fork is distributed as GitHub release artifacts and
  does not publish over the upstream npm package.
- A `kyangc-v*` release contains the CLI tarball, matching unpacked extension
  ZIP, and `SHA256SUMS`.

The complete upstream-sync, promotion, manual extension reload, and rollback
procedure is in [docs/kyangc-release.md](./docs/kyangc-release.md).

## Troubleshooting

- **"Extension not connected"** — Ensure the unpacked extension from this fork's matching release is loaded and **enabled** in `chrome://extensions`; after replacing files, click **Reload**.
- **CLI/extension version confusion** — Run `opencli --version` and `opencli doctor`. The latter reports the daemon and connected extension versions. Do not infer the loaded MV3 version from files on disk.
- **Repeated result tabs or windows** — Let the command reach its terminal state, then inspect daemon/extension logs. One reusable blank automation marker may remain; unbounded Provider tabs or an incomplete teardown are not expected.
- **"attach failed: Cannot access a chrome-extension:// URL"** — Another extension may be interfering. Try disabling other extensions temporarily.
- **Empty data or 'Unauthorized' error** — Your Chrome/Chromium login session may have expired. Navigate to the target site and log in again.
- **Node API errors / missing `fetch` / startup crash on old Node** — OpenCLI requires **Node.js >= 20.18.1**. Run `node --version`, upgrade Node if needed, then retry.
- **Daemon issues** — Check status: `curl localhost:19825/status` · View logs: `curl localhost:19825/logs`

## Upstream

OpenCLI was created by [jackwener/opencli](https://github.com/jackwener/opencli).
This fork preserves attribution and periodically merges a verified upstream
snapshot into `stable` through the fork release process above.

## License

[Apache-2.0](./LICENSE)
