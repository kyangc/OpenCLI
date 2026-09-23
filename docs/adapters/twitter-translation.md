# X detail translation

Strategy: UI_SELECTOR. Contract: visible-ui.

Evidence (2026-09-23): in the existing NAS X session, the target post's `显示翻译` button changes to `显示原文`; its own `tweetText` becomes `lang=zh`. NASA 2041557036274475228 and OpenAI Note 2097375276384567642 returned nonempty Chinese text. The Note quote remained English, so related posts must be visited independently. Authentication stays in the existing browser session. No account settings mutation or undocumented translation endpoint replay is required. The source detail API remains unchanged.

```sh
opencli twitter detail 2041557036274475228 --translate-to zh-CN --context-depth 1 -f json
```

`text` remains original. `lang` preserves the provider's original language when available. With `--translate-to zh-CN`, each fetched post additionally includes `translation`: provider, target_lang, source_lang, scope, status, text, completeness, untranslated_fields, fetched_at, and a reason when unavailable/not needed. No translation field is added when the flag is omitted.

Only `status=translated` has translation text. `completeness=unknown` means the visible webpage translation was read but X supplied no end-to-end completeness proof; visible Show more produces partial. Original rich-text/entity offsets do not apply to translated text. URL anchors are expanded during extraction; no translated formatting offsets are invented.

Scope is post_text, including Note text. Quotes/replies in the already-fetched graph are translated separately, root first. Article translation is explicitly unavailable in this implementation; poll options, link cards, image text and subtitles are not translated. Existing Chinese text is not sent for translation. Non-Chinese results are rejected, even if the webpage says translation is active.

Uses a page-local `lang=zh-cn` URL; does not update account language. The UI may ignore that preference: target-language validation prevents mislabeling another language as Chinese. Per-post wait is bounded to 15 seconds after navigation and the translation stage to a soft 60-second budget (in-flight browser commands can exceed it); skipped nodes report translation_budget_exhausted. Use a Backend job timeout of 180 seconds for translated context. Original detail fetching retains its own 90-second budget.

Unavailable translation preserves original data and adds per-post warnings. Consumers must inspect translation status instead of treating successful detail retrieval as guaranteed translation. Rate limiting, login expiry, absent UI controls, or DOM changes may make translations unavailable. No third-party fallback is silently used.

## Live acceptance

The production detail function was executed in an isolated adapter session on NAS before deployment. OpenAI Note + quote returned two separately identified Chinese translations (555/451 original characters, 211/150 translated characters), in 16.1 seconds. Original Chinese reply + parent returned not_needed for both. Article returned article_translation_not_supported with original article data intact. NASA photo post translation preserved its text URL and did not mix image alt text into the translation. These observations do not establish completeness for every X post shape.
