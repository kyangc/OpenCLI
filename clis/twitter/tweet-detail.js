import { ArgumentError, AuthRequiredError, CommandExecutionError, LoginWallError } from '@jackwener/opencli/errors';
import { BROWSER_JSON_SNIFF_FN, throwIfLoginWall } from '@jackwener/opencli/utils';
import { resolveTwitterOperationMetadata, unwrapBrowserResult, extractCard } from './shared.js';
import { TWITTER_BEARER_TOKEN } from './utils.js';
import { appendTranslations, validateTranslationTarget, validateTranslationRelations } from './tweet-translation.js';
import { extractPost, unwrapTweet } from './tweet-data.js';

export function normalizeDetailId(value) {
    const raw = String(value ?? '').trim();
    if (/^\d{1,25}$/.test(raw)) return raw;
    try {
        const u = new URL(raw);
        const match = u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/);
        if (u.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.twitter.com'].includes(u.hostname) && !u.username && !u.password && !u.port && match) return match[1];
    } catch { /* reported below */ }
    throw new ArgumentError('twitter detail requires a numeric ID or HTTPS X/Twitter status URL');
}

export async function collectDetail(rootId, fetchTweet, { depth = 1, maxNodes = 8 } = {}) {
    if (!Number.isInteger(depth) || depth < 0 || depth > 2) throw new ArgumentError('context-depth must be 0, 1 or 2');
    const posts = Object.create(null), embedded = new Map(), attempted = new Set(), warnings = [], stopReasons = new Set();
    const queue = [{ id: rootId, level: 0 }];
    let resolvedDepth = 0;
    while (queue.length && attempted.size < maxNodes) {
        const task = queue.shift();
        if (attempted.has(task.id)) continue;
        attempted.add(task.id);
        let raw;
        try { raw = embedded.get(task.id) || await fetchTweet(task.id); }
        catch (error) {
            if (task.id === rootId || error instanceof AuthRequiredError || error instanceof LoginWallError) throw error;
            warnings.push({ code: 'context_fetch_failed', post_id: task.id });
            stopReasons.add('context_fetch_failed');
            continue;
        }
        const tw = unwrapTweet(raw);
        const post = extractPost(tw);
        if (!post || post.id !== task.id) {
            if (task.id === rootId) throw new CommandExecutionError('Requested tweet is unavailable or response ID did not match');
            const unavailable = /Tombstone|Unavailable/.test(tw?.__typename || '');
            warnings.push({ code: unavailable ? 'context_unavailable' : 'context_missing', post_id: task.id });
            stopReasons.add('context_incomplete');
            continue;
        }
        post.link_card = post.poll ? null : extractCard(tw);
        posts[post.id] = post;
        resolvedDepth = Math.max(resolvedDepth, task.level);
        for (const field of ['text', 'media', 'article']) {
            if (['partial', 'unknown'].includes(post.completeness[field])) warnings.push({ code: 'completeness_' + post.completeness[field], post_id: post.id, field });
        }
        if (post.poll && !post.poll.complete) warnings.push({ code: 'poll_partial', post_id: post.id, field: 'poll' });
        if (!post.author.avatar_url) warnings.push({ code: 'avatar_missing', post_id: post.id, field: 'author.avatar_url' });
        for (const relation of post.relations) {
            if (!relation.id || relation.state === 'unavailable') continue;
            const nested = relation.kind === 'quote' ? tw.quoted_status_result?.result ?? tw.legacy?.quoted_status_result?.result
                : relation.kind === 'repost' ? tw.retweeted_status_result?.result ?? tw.legacy?.retweeted_status_result?.result : null;
            if (unwrapTweet(nested)?.rest_id === relation.id) embedded.set(relation.id, nested);
            if (task.level < depth) queue.push({ id: relation.id, level: task.level + 1 });
            else if (!posts[relation.id]) stopReasons.add('depth_limit');
        }
    }
    if (queue.some(t => !attempted.has(t.id))) stopReasons.add('node_limit');
    for (const post of Object.values(posts)) for (const relation of post.relations) {
        if (posts[relation.id]) relation.state = 'resolved';
        else if (warnings.some(w => w.code === 'context_unavailable' && w.post_id === relation.id)) relation.state = 'unavailable';
        else if (attempted.has(relation.id)) relation.state = 'unknown';
        if (relation.state !== 'resolved') warnings.push({ code: 'relation_' + relation.state, post_id: post.id, field: relation.kind });
    }
    const result = { schema_version: 1, requested_id: rootId, root_id: rootId, fetched_at: new Date().toISOString(), posts,
        context: { requested_depth: depth, resolved_depth: resolvedDepth, stop_reasons: [...stopReasons] }, warnings };
    // Leave room for pretty-printing inside the Backend's default 1 MiB budget.
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 900_000) throw new CommandExecutionError('Tweet detail exceeds output budget; use --context-depth 0');
    return result;
}

export async function fetchDetail(page, input, depth, translateTo, translateRelations) {
    validateTranslationTarget(translateTo);
    validateTranslationRelations(translateRelations);
    const rootId = normalizeDetailId(input);
    if (!Number.isInteger(depth) || depth < 0 || depth > 2) throw new ArgumentError('context-depth must be 0, 1 or 2');
    const cookies = await page.getCookies({ url: 'https://x.com' });
    const csrf = cookies.find(c => c.name === 'ct0')?.value;
    if (!csrf) throw new AuthRequiredError('x.com', 'X login required');
    const op = await resolveTwitterOperationMetadata(page, 'TweetResultByRestId', {
        queryId: '7xflPyRiUxGVbJd4uWmbfg', features: {
            longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
            articles_preview_enabled: true, responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
        }, fieldToggles: { withArticleRichContentState: true, withArticlePlainText: true },
    });
    const deadline = Date.now() + 90_000;
    const detail = await collectDetail(rootId, async tweetId => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new CommandExecutionError('Tweet detail request budget exhausted');
        const url = '/i/api/graphql/' + op.queryId + '/TweetResultByRestId?' + new URLSearchParams({
            variables: JSON.stringify({ tweetId, withCommunity: false, includePromotedContent: false, withVoice: false }),
            features: JSON.stringify(op.features), fieldToggles: JSON.stringify({ ...op.fieldToggles, withArticleRichContentState: true, withArticlePlainText: true }),
        });
        const result = unwrapBrowserResult(await page.evaluate(`async () => {
            ${BROWSER_JSON_SNIFF_FN}
            return await fetchJsonOrLoginWall(${JSON.stringify(url)}, { credentials: 'include',
                signal: AbortSignal.timeout(${Math.min(remaining, 15000)}), headers: {
                    Authorization: ${JSON.stringify('Bearer ' + decodeURIComponent(TWITTER_BEARER_TOKEN))},
                    'X-Csrf-Token': ${JSON.stringify(csrf)}, 'X-Twitter-Auth-Type': 'OAuth2Session', 'X-Twitter-Active-User': 'yes'
                } });
        }`));
        const data = throwIfLoginWall(result, { url });
        if (data?.error === 401 || data?.error === 403 || data?.errors?.some(e => [32, 89, 215].includes(e.code))) throw new AuthRequiredError('x.com', 'X session requires login');
        if (data?.error || (data?.errors?.length && !data?.data?.tweetResult?.result)) throw new CommandExecutionError('X detail request failed');
        return data?.data?.tweetResult?.result;
    }, { depth });
    await appendTranslations(page, detail, translateTo, { relations: translateRelations });
    if (Buffer.byteLength(JSON.stringify(detail, null, 2)) > 900_000) throw new CommandExecutionError('Translated detail exceeds output budget; use --context-depth 0');
    return detail;
}
