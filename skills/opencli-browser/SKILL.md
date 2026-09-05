---
name: opencli-browser
description: Drive a live Chrome session through OpenCLI for page inspection, extraction, or authorized UI interactions when a site adapter does not cover the task.
allowed-tools: Bash(opencli:*), Read, Edit, Write
---

# opencli-browser

The first reader of this CLI is an agent, not a human. Every subcommand returns a structured envelope that tells you exactly what matched, how confident the match is, and what to do if it didn't. Lean on those envelopes — do not guess.

This skill is for **driving a live browser** to accomplish an agent task. If you are building a reusable adapter under `~/.opencli/clis/<site>/` use `opencli-adapter-author` instead.

---

## Prerequisites

```bash
opencli doctor
```

Until `doctor` is green, nothing else will work. Typical failures: Chrome not running, extension not installed, debug port blocked by 1Password / other extensions. The doctor output tells you which.

---

## Session lifecycle

- `opencli browser *` commands require a `<session>` positional immediately after `browser`. Use the same session name for a multi-step flow; use a different name to isolate parallel browser work.
- Use a stable session name for any multi-command or human-paced browser workflow. Example: `opencli browser fb-yaya-warmup open https://example.com`, then reuse `opencli browser fb-yaya-warmup state`, `extract`, `click`, etc.
- Owned browser sessions keep a tab lease alive between calls. Release it with `opencli browser <session> close` or let the idle timeout expire.
- `opencli browser <session> bind` binds the Chrome tab you already have open to that session. Use this for logged-in pages, SSO flows, or pages you manually positioned before handing control to the agent.
- `--window foreground|background` (or `OPENCLI_WINDOW=foreground|background`) chooses whether OpenCLI creates/focuses a foreground browser window or uses a background browser window for owned sessions.

### Bind Tab

```bash
opencli browser gmail bind
opencli browser gmail state
opencli browser gmail click "Search"
opencli browser gmail network
opencli browser gmail unbind
```

Binding never owns the user window and never closes the user tab. It fails closed if the tab is closed or becomes non-debuggable. Re-run `opencli browser <session> bind` when you switch to a different real tab.

Navigation is allowed on bound sessions because the session now represents explicit agent ownership of that tab. Tab mutation (`tab new`, `tab select`, `tab close`) is still blocked for bound sessions. Use an owned session when you want OpenCLI to manage tab lifecycle.

Bound sessions have no OpenCLI idle-close timer; the binding lasts until `unbind`, tab close, window close, or daemon restart.

---

## Mental model

1. **Selector-first target contract.** Every interaction command (`click`, `type`, `select`, `get text/value/attributes`) takes one `<target>`, which is *either* a numeric ref from `state`/`find` *or* a CSS selector. Use `--nth <n>` to disambiguate multiple CSS matches.
2. **Every envelope reports `matches_n` and `match_level`.** `match_level` is `exact`, `stable`, or `reidentified` — the CLI already rescued moderate DOM drift for you, but the level tells you how confident to be.
3. **Compact output first, full payload on demand.** `state` is a budget-aware snapshot; `get html --as json` supports `--depth/--children-max/--text-max`; `network` returns shape previews and you re-fetch a single body with `--detail <key>`. If you emit a giant payload you are burning context you did not need to burn.
4. **Structured errors are machine-readable.** On failure the CLI emits `{error: {code, message, hint?, candidates?}}`. Branch on `code`, not on message strings.

---

## Critical rules

1. **Always inspect before you act.** Run `state` or `find` first. Never hard-code a ref or selector from memory across sessions — indices are per-snapshot.
2. **Prefer site adapters before raw browser driving.** If `opencli <site> <command>` already covers the task, use that adapter command first (`opencli facebook notifications`, `opencli reddit read`, `opencli chatgpt model <level>`, etc.). Use `opencli browser ...` only for gaps, debugging, or one-off UI flows the adapter does not expose.
3. **Prefer numeric ref over CSS once you have it.** Numeric refs survive mild DOM shifts because the CLI fingerprints each tagged element. A CSS selector written by hand will break the first time the site re-renders.
4. **Read `match_level` after every write.** `exact` = all good. `stable` = the element is the same but some soft attrs drifted — your action still applied. `reidentified` = the original ref was gone and the CLI found a unique replacement; double-check you hit the right element.
5. **Use the `compound` field for form controls.** Do not regex-guess a date format, do not `state` twice to get the full `<select>` options list. The compound envelope has the format string, full option list up to 50, `options_total` for overflow, and `accept`/`multiple` for `<input type=file>`.
6. **Verify writes that matter.** After `type <target> <text>`, run `get value <target>`. After `select`, run `get value`. Autocomplete widgets, React controlled inputs, and masked fields all silently eat characters. The CLI cannot detect this for you.
7. **`state` → action → `state` after a page change.** Navigations, form submits, and SPA route changes invalidate refs. Take a fresh snapshot. Do not reuse refs from before the transition.
8. **Chain with `&&` when reusing freshly parsed refs.** A chained sequence runs in one shell so the ref you just read from output can be passed directly to the next command. Separate shell invocations keep the named browser session, but any shell-local variables or copied refs from the previous command can go stale after page changes.
9. **`eval` is read-only.** Wrap the JS in an IIFE and return JSON. If you need to *change* the page, use the structured `click` / `type` / `select` / `keys` commands instead — they produce structured output and fingerprints, `eval` does not.
10. **Prefer `network` to screen-scraping.** If a page you care about fetches its data from a JSON API, the API is almost always more reliable than scraping the rendered DOM. Capture once, inspect the shape, then `--detail <key>` the body you need.

---

## Sitemaps

If `browser open` or `browser analyze` returns `sitemap.available: true`, switch to `opencli-browser-sitemap` before continuing a multi-step site flow. The sitemap is prior context for pages, actions, workflows, APIs, and pitfalls; it is not truth. If the browser state disagrees with the sitemap, trust the browser and mark the sitemap stale via `opencli-sitemap-author`.

---

## Detailed mechanics — read as needed

- For target matching, compound fields, command output, chaining, or recipes,
  read the relevant section of [browser mechanics](references/browser-mechanics.md).
- Use command help for current arguments; do not load the full reference for a
  simple known action.

## Pitfalls

- **Do not submit forms via `eval "document.forms[0].submit()"`** — modern sites intercept with JS handlers and silently drop the call. Either `click` the submit button via its ref, or (if you know the GET URL) just `open` it directly.
- **Do not reuse refs across a page transition.** `wait` for the new state, then re-`state`. Old refs will either 404 or (worse) `reidentify` onto a similarly-shaped element on the new page.
- **`match_level: reidentified` is a warning, not an error.** The action went through, but if you are chaining 5 more writes that all depend on that being the right element, verify with a `get text` or `get value` before continuing.
- **Budget-aware commands silently cap.** `get html --as json` with default budgets will return `truncated: {...}`. If your downstream logic needs the whole subtree, raise `--depth` / `--children-max` or tighten the selector.
- **`autocomplete: true` on a `type` response is not an error.** It means a suggestion popup is open and your value isn't committed yet. Typically `keys Enter` to accept the first suggestion, or `click` the one you want.
- **`network --filter` is AND-semantics on path segments.** `--filter "title,score"` keeps entries whose body shape contains *both* `title` and `score` as path segments, at any depth. It is not a regex.
- **Screenshots are for humans, not for agents.** Use `state` + `find` unless the page is genuinely visual (captcha, chart). Screenshots burn tokens and rarely add signal an agent can act on.

---

## Troubleshooting

| symptom | fix |
|---------|-----|
| `opencli doctor` red: "Browser not connected" | Start Chrome with `--remote-debugging-port=9222`, or install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk). |
| `attach failed: chrome-extension://...` | Disable 1Password / other CDP-hungry extensions temporarily. |
| `selector_not_found` right after `state` | Page mutated. `wait selector "..."` then retry. |
| `stale_ref` across every command | You are reusing refs from a prior page. Re-`state`. |
| `click` succeeds but nothing happens | The element is probably a decorative wrapper stealing clicks from the real target. `find --css "..."` with a narrower selector and retry on the inner element. |
| `type` appears to finish but value is wrong | Autocomplete, masked input, or React controlled re-render. Verify with `get value`. Add `keys Enter` or re-type. |
| Giant `get html` output | Pass `--selector` + `--as json --depth 3 --children-max 20 --text-max 200`. |
| Network cache seems stale | Bump `--ttl` down, or let it expire. The cache lives at `~/.opencli/cache/browser-network/`. |

---

## See also

- `opencli-adapter-author` — turning what you just figured out into a reusable `~/.opencli/clis/<site>/<command>.js`.
- `opencli-browser-sitemap` — consuming site sitemap context while driving a browser task.
- `opencli-sitemap-author` — creating or updating sitemap knowledge when you discover a durable path or stale entry.
- `opencli-autofix` — for authorized adapter repair, including trace evidence,
  read/write replay checks, and optional authorized issue reporting.
