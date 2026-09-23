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

## NAS candidate acceptance

Candidate image `local/opencli-backend:2.1.0.1` was built from the candidate
checkout and tested with the existing persistent state. The queue was paused
and drained before replacement, then resumed. Deployment smoke passed with
CLI/daemon 2.1.0, extension 2.0.0, one connected profile, zero pending browser
commands and zero active/queued jobs. The ordinary agent catalog exposes the
read-only `twitter.detail` command and structured parameters.

All jobs below used the Backend HTTP API and completed without truncation:

| Shape | Post | Job | Observed result |
|---|---|---|---|
| Plain + share URL | 20 | 30bf985d-c5b9-480a-93be-6455cce2cd61 | Exact root, author/avatar, text, metrics |
| Reply depth 2 | 2096847737153012204 | ad91132e-33eb-40f2-a891-60a1dc498a05 | Three posts with distinct authors/avatars; depth boundary explicit |
| Four photos | 2041557036274475228 | 90157139-ea99-4443-a26a-7b8b35aaca9a | Ordered images, dimensions and alt text |
| Video | 2041690396586090592 | 34f52178-f0df-4595-9403-2a7a110b80a8 | Preview JPEG, variants, 720x405, 99699 ms |
| Poll | 1593767953706921985 | d04de292-1a9e-43bb-8472-c748bc7a8f99 | Two options, 15085458 total votes, end time |
| Note + quote | 2097375276384567642 | c35b09cc-2808-4710-a505-a815e260badb | 555-character Note plus resolved 451-character quoted Note |
| Article | 2102341632452411524 | 5c6dc080-d5c8-4796-a2df-4451c8d3fbd3 | 58 blocks, 4 media, 13 entities; unsupported content marked partial |

NAS downloads of the photo/video authors' avatars and first previews returned
HTTP 206 with image/jpeg and JPEG magic bytes (bounded 64 KiB reads). Existing
`twitter.search` also returned additive avatars and independent quoted-author
metadata. An unavailable sample (1594005989316083712) correctly failed rather
than returning an empty success.

GIF, mixed-media and repost mapping are covered by synthetic tests, not live
acceptance. Article completeness remains partial/unknown, and provider text
indices have not been certified across every Unicode shape. These results do
not establish poster rendering or iPhone Shortcut acceptance.

The promotion PR targets `stable`; `main` is not changed. CI includes the
Backend container/Compose smoke and a manually dispatched headed-browser gate,
which also runs isolated fixed-port transport tests on all three operating
systems without disconnecting the user's local browser extension.

