import { describe, it, expect, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { AuthRequiredError, LoginWallError } from '@jackwener/opencli/errors';
import { extractAuthor, extractPost, extractDetailedMedia, extractArticle, extractPoll } from './tweet-data.js';
import { collectDetail, normalizeDetailId, fetchDetail } from './tweet-detail.js';
import { extractQuotedTweet } from './shared.js';
import './detail.js';

// Synthetic provider-shaped fixtures: these test mapping contracts, not live X acceptance.
const user = { rest_id: '99', core: { name: 'Alice', screen_name: 'alice' }, avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' }, is_blue_verified: true };
function tweet(id = '1', legacy = {}, extra = {}) {
    return { rest_id: id, core: { user_results: { result: user } }, legacy: { full_text: '你好 👨‍👩‍👧‍👦', ...legacy }, ...extra };
}

describe('X detail content mapping', () => {
    it('preserves current and legacy avatars without inventing original-size URLs', () => {
        expect(extractAuthor(user)).toEqual({ id: '99', name: 'Alice', handle: 'alice', avatar_url: user.avatar.image_url, verification: { verified: true, type: 'blue' } });
        expect(extractAuthor({ legacy: { screen_name: 'old', name: 'Old', profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/old.jpg' } })).toMatchObject({ handle: 'old', name: 'Old', avatar_url: 'https://pbs.twimg.com/profile_images/2/old.jpg' });
        expect(extractAuthor({ avatar: { image_url: 'https://evil.test/image.jpg' } }).avatar_url).toBeNull();
        expect(extractAuthor({ legacy: { profile_image_url_https: 'https://user:pass@pbs.twimg.com/a' } }).avatar_url).toBeNull();
        expect(extractAuthor({}).verification.verified).toBeNull();
    });
    it('preserves legacy verification when blue verification is false', () => {
        expect(extractAuthor({ is_blue_verified: false, legacy: { verified: true, verified_type: 'Business' } }).verification).toEqual({ verified: true, type: 'gold' });
    });
    it('rejects identity-only unavailable payloads instead of manufacturing empty content', () => {
        expect(extractPost({ rest_id: '1', core: { user_results: { result: user } } })).toBeNull();
    });
    it('does not reuse the outer author for a quoted author', () => {
        const quoted = tweet('2'); quoted.core.user_results.result = { legacy: { screen_name: 'bob', profile_image_url_https: 'https://pbs.twimg.com/profile_images/b.jpg' } };
        const result = extractQuotedTweet(tweet('1', { is_quote_status: true }, { quoted_status_result: { result: quoted } }));
        expect(result.author).toBe('bob');
        expect(result.avatar_url).toContain('/b.jpg');
    });
    it('pairs note text with note entities rather than legacy offsets', () => {
        const result = extractPost(tweet('1', { full_text: 'short', entities: { urls: [{ indices: [0, 5], expanded_url: 'https://old.test/' }] } }, {
            note_tweet: { note_tweet_results: { result: { text: 'full 🌟 https://t.co/x', entity_set: { urls: [{ indices: [8, 22], expanded_url: 'https://new.test/', display_url: 'new.test' }] } } } },
        }));
        expect(result.text_source).toBe('note'); expect(result.entities[0].url).toBe('https://new.test/');
        expect(result.metrics.likes).toBeNull();
        expect(extractPost(tweet('1', { favorite_count: 0 })).metrics.likes).toBe(0);
    });
    it('preserves photo/video/GIF order and never treats MP4 as a missing poster', () => {
        const media = extractDetailedMedia({ extended_entities: { media: [
            { id_str: '10', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', original_info: { width: 600, height: 900 }, ext_alt_text: '图' },
            { id_str: '11', type: 'video', video_info: { duration_millis: 2500, variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/a.mp4', bitrate: 100 }] } },
            { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/media/g.jpg' }, null,
        ] } });
        expect(media.map(m => m.type)).toEqual(['photo', 'video', 'animated_gif', 'unknown']);
        expect(media[0]).toMatchObject({ width: 600, height: 900, alt_text: '图' });
        expect(media[1]).toMatchObject({ poster_url: null, duration_ms: 2500 });
        expect(media[3].index).toBe(3);
    });
    it('retains missing poll counts as null, and supports real zero counts', () => {
        const poll = { card: { legacy: { name: 'poll2choice_text_only', binding_values: [
            { key: 'choice1_label', value: { string_value: 'yes' } }, { key: 'choice1_count', value: { string_value: '0' } },
            { key: 'choice2_label', value: { string_value: 'no' } },
        ] } } };
        expect(extractPoll(poll)).toMatchObject({ total_votes: null, complete: false, options: [{ label: 'yes', votes: 0 }, { label: 'no', votes: null }] });
    });
    it('retains article block order, styles, entity keys and unsupported blocks', () => {
        const article = extractArticle({ article: { article_results: { result: { title: '文章', content_state: {
            blocks: [{ key: 'a', type: 'header-one', text: '标题', inlineStyleRanges: [{ offset: 0, length: 2, style: 'BOLD' }] },
                { key: 'b', type: 'atomic', entityRanges: [{ key: 7, offset: 0, length: 1 }] }, { key: 'c', type: 'future-block', text: 'keep me' }],
            entityMap: [{ key: '7', value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: '50' }] } } }],
        }, media_entities: [{ media_id: '50', media_info: { original_img_url: 'https://pbs.twimg.com/media/a.jpg' } }] } } } });
        expect(article.blocks.map(b => b.key)).toEqual(['a', 'b', 'c']); expect(article.entities[0].media_ids).toEqual(['50']);
        expect(article.blocks[0].inline_styles[0].style).toBe('BOLD'); expect(article.completeness).toBe('partial');
    });
});

describe('bounded post graph', () => {
    it('resolves quote and reply together, reuses embedded quote and handles cycles', async () => {
        const quote = tweet('2', { in_reply_to_status_id_str: '1' });
        const fetch = vi.fn(async id => id === '1' ? tweet('1', { is_quote_status: true, quoted_status_id_str: '2', in_reply_to_status_id_str: '3' }, { quoted_status_result: { result: quote } }) : tweet('3'));
        const result = await collectDetail('1', fetch, { depth: 2 });
        expect(Object.keys(result.posts)).toEqual(['1', '2', '3']); expect(fetch).toHaveBeenCalledTimes(2);
        expect(result.posts['1'].relations.map(r => r.state)).toEqual(['resolved', 'resolved']);
        expect(result.posts['2'].relations[0].state).toBe('resolved');
    });
    it('rejects wrong roots and never falls back to a sibling', async () => {
        await expect(collectDetail('1', async () => tweet('2'))).rejects.toThrow(/ID did not match/);
        await expect(collectDetail('1', async () => ({ __typename: 'TweetUnavailable' }))).rejects.toThrow(/unavailable/);
    });
    it('keeps unavailable quote identity and does not refetch explicit tombstones', async () => {
        const fetch = vi.fn(async () => tweet('1', { is_quote_status: true, quoted_status_id_str: '2' }, { quoted_status_result: { result: { __typename: 'TweetTombstone' } } }));
        const result = await collectDetail('1', fetch);
        expect(fetch).toHaveBeenCalledTimes(1); expect(result.posts['1'].relations[0]).toEqual({ kind: 'quote', id: '2', state: 'unavailable' });
        expect(result.warnings).toContainEqual({ code: 'relation_unavailable', post_id: '1', field: 'quote' });
    });
    it('enforces context depth and node budget, without collecting unrelated comments', async () => {
        const fetch = vi.fn(async id => tweet(id, { in_reply_to_status_id_str: String(Number(id) + 1) }));
        const result = await collectDetail('1', fetch, { depth: 2, maxNodes: 2 });
        expect(fetch).toHaveBeenCalledTimes(2); expect(result.context.stop_reasons).toContain('node_limit');
        const single = await collectDetail('1', fetch, { depth: 0 }); expect(Object.keys(single.posts)).toEqual(['1']);
    });
    it('preserves a root when context fails but propagates login failure', async () => {
        const fetch = async id => { if (id === '1') return tweet('1', { in_reply_to_status_id_str: '2' }); throw new Error('network'); };
        const result = await collectDetail('1', fetch); expect(result.posts['1'].relations[0].state).toBe('unknown');
        await expect(collectDetail('1', async id => { if (id === '1') return tweet('1', { in_reply_to_status_id_str: '2' }); throw new AuthRequiredError('x.com'); })).rejects.toBeInstanceOf(AuthRequiredError);
    });
    it('propagates a context login wall instead of silently returning partial success', async () => {
        await expect(collectDetail('1', async id => {
            if (id === '1') return tweet('1', { in_reply_to_status_id_str: '2' });
            throw new LoginWallError('login', 403, 'https://x.com', '');
        })).rejects.toBeInstanceOf(LoginWallError);
    });
    it('rejects oversized output rather than silently clipping', async () => {
        await expect(collectDetail('1', async () => tweet('1', { full_text: 'x'.repeat(950000) }))).rejects.toThrow(/budget/);
    });
});

describe('detail command transport', () => {
    it('registers a discoverable read command and rejects invalid input before browser access', async () => {
        expect(getRegistry().get('twitter/detail').access).toBe('read');
        expect(normalizeDetailId('https://x.com/i/status/123/photo/1?s=20')).toBe('123');
        for (const input of ['https://evil.test/a/status/1', 'https://x.com@evil.test/a/status/1', '1;alert(1)', 'https://x.com:4430/a/status/1']) expect(() => normalizeDetailId(input)).toThrow();
        const page = { getCookies: vi.fn() };
        await expect(fetchDetail(page, '1', 3)).rejects.toThrow(/context-depth/); expect(page.getCookies).not.toHaveBeenCalled();
    });
    it('executes the browser fetch script with URL params and unwraps Bridge envelopes', async () => {
        const page = { getCookies: async () => [{ name: 'ct0', value: 'test-csrf' }], evaluate: vi.fn()
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async script => {
                const oldFetch = globalThis.fetch;
                globalThis.fetch = vi.fn(async url => {
                    expect(new URL(url, 'https://x.com').searchParams.get('variables')).toContain('"tweetId":"1"');
                    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ data: { tweetResult: { result: tweet() } } }) };
                });
                try { return { session: 'site:twitter', data: await eval(`(${script})`)() }; } finally { globalThis.fetch = oldFetch; }
            }) };
        const result = await fetchDetail(page, '1', 0); expect(result.posts['1'].author.avatar_url).toBe(user.avatar.image_url);
        expect(JSON.stringify(result)).not.toContain('test-csrf');
    });
    it('surfaces authentication failures', async () => {
        await expect(fetchDetail({ getCookies: async () => [] }, '1', 0)).rejects.toBeInstanceOf(AuthRequiredError);
        const page = { getCookies: async () => [{ name: 'ct0', value: 'x' }], evaluate: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ error: 401 }) };
        await expect(fetchDetail(page, '1', 0)).rejects.toBeInstanceOf(AuthRequiredError);
    });
});
