# X post details for rendering and archiving

`twitter detail` is a read-only, versioned JSON interface for one specific post
and bounded quote, reply and repost context. It uses the existing authenticated
X browser session, without returning cookies or viewer-specific response data.

```sh
opencli twitter detail 'https://x.com/alice/status/123' -f json
opencli twitter detail 123 --context-depth 0 -f json
```

Use a numeric **string** ID or an HTTPS `x.com` / `twitter.com` status URL.
Article URLs are not status IDs: use the containing post URL for `detail`, or
use the existing `twitter article` command to resolve an Article URL.

## Output

The result is an object, not a timeline array:

- `schema_version: 1`, `requested_id`, `root_id`, `fetched_at`.
- `posts`: ID-keyed posts with `author`, `text`, `text_source`, `entities`,
  `richtext`, `inline_media`, `media`, `poll`, `link_card`, `article`,
  `created_at`, `metrics`, `relations` and `completeness`.
- `context`: requested/resolved depth and stop reasons.
- `warnings`: missing assets, incomplete/unknown content and unresolved relations.

Author fields include `id`, `handle`, `name`, `avatar_url` and verification.
The mapper accepts legacy profile image URLs and the current-shaped
`avatar.image_url` container. The source HTTPS `pbs.twimg.com` URL is preserved;
no high-resolution/original URL is invented. A missing avatar is `null`.
List commands (`tweets`, `thread`, `timeline`, `search`, `list-tweets`,
`bookmarks`, `bookmark-folder`, `likes`), `profile`, and available quoted posts
also gain `author_info` and `avatar_url`, without changing existing fields.
`article` adds the same identity fields and structured `article` blocks when
those fields are available in its response; its existing Markdown stays intact.

Media preserve ordering and explicitly distinguish `photo`, `video`,
`animated_gif`, and `unknown`. Image/preview URLs are separate from playable
variants. Missing poster URLs are `null`, never an MP4 fallback. Width/height
are pixels, duration is milliseconds, and video bitrate is the provider value.
Unknown counts stay `null` rather than becoming zero.

Note text uses its own entity set. `entity_index_unit: "provider"` explicitly
means offsets have not been converted or live-verified for all X response
variants; consumers must validate ranges before using them, especially around
emoji. Display/expanded URLs and source text are separate. Article blocks keep
source order, inline styles, entity keys and media links; unsupported atomic
blocks remain present instead of disappearing.

## Bounds and failure semantics

Context depth defaults to 1 (root + immediate relationships), accepts 0–2 and
visits at most 8 posts. Embedded quotes are reused. The root must match exactly;
a missing/deleted/wrong root is an error, not an empty successful poster.
No arbitrary conversation replies are appended and this is **not** a complete
thread crawler. Network requests have a 15-second maximum each and a 90-second
fetch budget after metadata discovery. Pretty-printed results above 900 KB fail
explicitly to stay within Backend's default output allowance.

Relations may be `resolved`, `unavailable`, `not_fetched`, or `unknown`.
Context failures preserve the root with warnings, except authentication/login
wall errors, which stop the command so Backend can report `needs_login`.
An explicit tombstone is not retried. Depth/node limits are reported.

`completeness` is conservative: fetching `full_text` alone does not prove the
provider returned everything. Unknown content stays `unknown`; truncation or
unsupported article blocks become `partial`. This applies independently to
text, media and article content. Do not interpret CLI success as proof that an
entire Article or thread was fetched.

## Backend

No new Backend routes are required. After deploying a matching CLI build and
refreshing Backend's startup catalog, describe `twitter/detail` first, then:

```json
{
  "site": "twitter",
  "command": "detail",
  "params": {"tweet-id": "123", "context-depth": 1}
}
```

Submit this to `POST /v1/jobs` using an Agent token and stable idempotency key.
Poll the same job after a wait timeout. Consume `result.output` only after
success and validate its root ID/schema/warnings. Keep Backend tokens out of
shared shortcuts; the poster service should own this connection.

## Verification boundary

Automated tests use synthetic provider-shaped responses. They verify field
mapping, graph limits, browser fetch scripts, backwards-compatible output and
Backend JSON/idempotency semantics, not live X availability. See
[verification evidence](../twitter-detail-verification.md) for the current NAS
acceptance results and remaining content-shape coverage. Poster rendering and
iPhone Shortcut acceptance belong to the consuming service.
