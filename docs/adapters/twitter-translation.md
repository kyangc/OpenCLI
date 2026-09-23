# X detail translation

Current strategy: authenticated webpage API, with visible-UI fallback. The section below describes the original 2.2.0 DOM implementation; version changes follow at the end.

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

## 2.2.1：接口优先

默认先在已登录 X 页面内请求网页正在使用的 Grok translation 接口，成功则不导航到逐条推文。返回 method=api/dom 与 duration_ms；接口不可用时在预算内回退 DOM，401/登录失效上抛，429 明确 unavailable 且不回退。原始 text 保留。

可选 `--translate-relations all|quote|reply|none` 控制沿已解析关系图需要翻译的节点，repost 仍包含。未指定时兼容原行为。只有显示范围内的节点会添加 translation。Article 正文等限制不变，完整性仍为 unknown。

## 2.2.2：可选缓存

`twitter session-scope` 不导航，只返回登录凭据的不可重放 SHA-256 作用域标识，不返回 Cookie。凭据轮换或账号切换会改变标识。海报服务每次使用缓存前读取并核对 scope；这不替代 X 服务端的会话有效性校验，凭据存在但已被撤销时，缓存最多沿用其既有 TTL。

`twitter detail --cache true` 输出 session_scope，启用按 scope、推文ID、完整原文、源语言、目标语言和实现版本隔离的译文缓存。默认关闭，正常抓取行为不变。成功且非partial译文缓存7天，最多512条、每条300KB，位于 OPENCLI_CONFIG_DIR/cache/x-translations（默认 ~/.opencli/cache/x-translations）。`--refresh true` 跳过已有译文缓存并更新成功结果，失败和partial不缓存。cache_hit 标记命中，命中时 duration_ms=0（未发翻译请求，非文件读取计时）。
