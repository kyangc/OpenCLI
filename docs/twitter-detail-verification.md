# Twitter detail local verification — 2026-09-23

Branch: `codex/twitter-detail`, based on `0a281389`.
Release candidate: CLI 2.1.0, compatible extension 2.0.0, Backend 0.3.0.
No X account mutations; all live checks use read commands.

Implemented:

- Read-only `twitter.detail` with version 1 JSON, exact root matching, author
  avatars, typed media, poll fields, Note entities, Article blocks and bounded
  quote/reply/repost relationships.
- Additive `author_info` / `avatar_url` on existing Twitter reading commands
  and quoted posts; additive structured Article output with Markdown preserved.
- Backend discovery, structured parameters, nested JSON, durable idempotency and
  truncation tests. No Backend production route or parser change required.
- Generated manifest and CLI help expose the new command.

Checks:

| Check | Result |
|---|---|
| `npm run build` | Pass; generated manifest contains twitter/detail |
| `npm run typecheck` | Pass |
| `npm run check:silent-column-drop` | Pass; zero new violations |
| Twitter adapter suite | Covered by full release suite |
| `npm test` with isolated `OPENCLI_CONFIG_DIR` | 640 files, 7470 passed, 1 skipped |
| Final detail/article targeted tests | 27 passed, including 4 additional cases |
| Backend suite | 49 passed |
| Backend monorepo integration | 5 passed |
| `git diff --check` and new module syntax checks | Pass |

The first unrestricted full-suite run failed six existing browser tab/profile
assertions because the user's saved profile supplied an unexpected
`preferredContextId`. Running with a temporary empty `OPENCLI_CONFIG_DIR`
resolved all six failures without changing production profile configuration or
unrelated CLI code.

The local `opencli list -f json` and `twitter detail --help` were inspected;
these checks did not execute live X requests. Mapping/transport tests use
synthetic provider-shaped inputs and a mocked network. New/legacy avatar shapes,
poll and Article mapping are implemented but need representative live response
acceptance; provider entity indices and content completeness remain explicitly
unverified/unknown where evidence is absent.

## Release checks

- Reinstalled root, extension and Backend dependencies with `npm ci`.
- `verify:fork-release` passed, including extension build/package.
- `verify:backend` passed: 49 Backend tests and 5 monorepo contracts.
- Production dependency audits passed in all three packages after updating
  js-yaml 4.3.1 to 4.3.2 (GHSA-2883-xcg3-v3hh).
- Existing Ctrip flight discovery had an unbaselined silent clamp on stable.
  Reused its existing strict integer parser; all 227 Ctrip tests passed and
  typed-error lint now has zero new findings.
- NAS Backend was down due to a stale Chromium network namespace. Recreating
  only Backend restored readiness with daemon 2.0.4 / extension 2.0.0.
- Existing `twitter.thread` job `7ae1f17a-2d86-48e3-bc0e-693cdc121935`
  succeeded through the ordinary agent API for post `20`, confirming the
  queue, persisted login and browser execution chain before promotion.

Candidate/live detail acceptance and final deployment evidence will be recorded
alongside the stable promotion. These automated checks do not establish poster
rendering or iPhone Shortcut acceptance.
