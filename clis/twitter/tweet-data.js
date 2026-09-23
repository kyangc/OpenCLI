// Provider-neutral projections of X response fields. Never export viewer/auth data.
const str = (v) => typeof v === 'string' && v.length ? v : null;
const id = (v) => typeof v === 'string' && /^\d+$/.test(v) ? v : null;
const count = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const array = (v) => Array.isArray(v) ? v : [];
export function publicUrl(value, image = false) {
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        if (image && u.hostname !== 'pbs.twimg.com') return null;
        return u.href;
    } catch { return null; }
}
export function unwrapTweet(value) { return value?.tweet || value; }
export function extractAuthor(user) {
    const legacy = user?.legacy || {};
    const handle = str(user?.core?.screen_name) || str(legacy.screen_name);
    const avatar = publicUrl(user?.avatar?.image_url, true) || publicUrl(legacy.profile_image_url_https, true);
    const flags = [user?.is_blue_verified, user?.verification?.verified, legacy.verified].filter(v => typeof v === 'boolean');
    let verified = flags.length ? flags.some(Boolean) : null;
    const badge = str(user?.verification?.verified_type) || str(user?.verified_type) || legacy.verified_type;
    const verificationType = badge === 'Business' ? 'gold' : badge === 'Government' ? 'gray' : user?.is_blue_verified === true ? 'blue' : 'unknown';
    if (verificationType === 'gold' || verificationType === 'gray') verified = true;
    const label = user?.affiliates_highlighted_label?.label;
    const badgeUrl = publicUrl(label?.badge?.url, true);
    const affiliation = badgeUrl ? { image_url: badgeUrl, description: str(label?.description), url: publicUrl(label?.url?.url) } : null;
    return {
        id: id(user?.rest_id), handle: handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null,
        name: str(user?.core?.name) || str(legacy.name), avatar_url: avatar,
        verification: { verified, type: verificationType },
        ...(affiliation ? { affiliation } : {}),
    };
}
export function authorFields(user) {
    const a = extractAuthor(user);
    return { author_info: a, avatar_url: a.avatar_url };
}
export function extractDetailedMedia(legacy) {
    const raw = legacy?.extended_entities?.media ?? legacy?.entities?.media;
    return array(raw).map((m, index) => ({
        index, id: id(m?.id_str), type: ['photo', 'video', 'animated_gif'].includes(m?.type) ? m.type : 'unknown',
        image_url: m?.type === 'photo' ? publicUrl(m?.media_url_https, true) : null,
        poster_url: publicUrl(m?.media_url_https, true),
        width: count(m?.original_info?.width), height: count(m?.original_info?.height),
        duration_ms: count(m?.video_info?.duration_millis), alt_text: str(m?.ext_alt_text),
        variants: array(m?.video_info?.variants).flatMap((v) => {
            const url = publicUrl(v?.url);
            return url ? [{ url, content_type: str(v.content_type), bitrate: count(v.bitrate) }] : [];
        }),
    }));
}
export function extractPoll(tweet) {
    const card = tweet?.card?.legacy;
    if (!/^poll\d+/.test(card?.name || '')) return null;
    const fields = Object.fromEntries(array(card.binding_values).map(b => [b?.key, b?.value?.string_value]));
    const options = Object.keys(fields).filter(k => /^choice\d+_label$/.test(k))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        .map(k => ({ label: str(fields[k]), votes: count(fields[k.replace('_label', '_count')]) }));
    const ends = str(fields.end_datetime_utc);
    return { options, total_votes: options.length && options.every(o => o.votes !== null) ? options.reduce((n, o) => n + o.votes, 0) : null,
        ends_at: ends && Number.isFinite(Date.parse(ends)) ? new Date(ends).toISOString() : null,
        duration_minutes: count(fields.duration_minutes),
        complete: options.length >= 2 && options.every(o => o.label !== null && o.votes !== null) };
}
function ranges(items) {
    return array(items).map(r => ({ offset: count(r?.offset), length: count(r?.length),
        ...(r?.key != null ? { key: String(r.key) } : {}), ...(typeof r?.style === 'string' ? { style: r.style } : {}) }));
}
export function extractArticle(tweet) {
    const source = tweet?.article?.article_results?.result;
    if (!source) return null;
    const state = source.content_state;
    const rawEntities = state?.entityMap;
    const entries = Array.isArray(rawEntities) ? rawEntities.map(e => [String(e?.key), e?.value]) : Object.entries(rawEntities || {}).map(([k, e]) => [k, e?.value || e]);
    const media = Object.values(source.media_entities || {}).map(m => ({
        id: str(m?.media_id), image_url: publicUrl(m?.media_info?.original_img_url, true),
        width: count(m?.media_info?.original_img_width), height: count(m?.media_info?.original_img_height),
    }));
    const entities = entries.map(([key, e]) => ({ key, type: str(e?.type),
        url: publicUrl(e?.data?.url), caption: str(e?.data?.caption),
        media_ids: array(e?.data?.mediaItems).map(m => str(m?.mediaId)).filter(Boolean),
    }));
    const known = new Set(['unstyled', 'header-one', 'header-two', 'header-three', 'blockquote', 'unordered-list-item', 'ordered-list-item', 'code-block', 'atomic']);
    const blocks = array(state?.blocks).map((b, index) => ({ index, key: str(b?.key), type: str(b?.type) || 'unknown',
        text: typeof b?.text === 'string' ? b.text : '', depth: count(b?.depth),
        inline_styles: ranges(b?.inlineStyleRanges), entity_ranges: ranges(b?.entityRanges),
    }));
    const unsupported = blocks.some(b => !known.has(b.type) || (b.type === 'atomic' && (!b.entity_ranges.length || b.entity_ranges.some(r => {
        const e = entities.find(e => e.key === r.key);
        return !e || e.type !== 'MEDIA' || !e.media_ids.length || e.media_ids.some(key => !media.some(m => m.id === key && m.image_url));
    }))));
    return { id: str(source.rest_id), title: str(source.title), preview_text: str(source.preview_text),
        blocks, entities, media, completeness: !Array.isArray(state?.blocks) ? 'unknown' : unsupported ? 'partial' : 'unknown' };
}
function textEntities(source) {
    return ['urls', 'user_mentions', 'hashtags', 'symbols'].flatMap(kind => array(source?.[kind]).map(e => ({
        kind, indices: array(e?.indices).length === 2 ? e.indices.map(count) : null,
        url: publicUrl(e?.expanded_url) || publicUrl(e?.url), display_url: str(e?.display_url),
        text: str(e?.text) || str(e?.screen_name), id: id(e?.id_str),
    })));
}
export function extractPost(value) {
    const tw = unwrapTweet(value);
    if (!id(tw?.rest_id) || /Tombstone|Unavailable/.test(tw?.__typename || '')) return null;
    const l = tw.legacy || {};
    const note = tw.note_tweet?.note_tweet_results?.result;
    const hasNote = typeof note?.text === 'string';
    const author = extractAuthor(tw.core?.user_results?.result);
    const media = extractDetailedMedia(l);
    const article = extractArticle(tw);
    if (typeof l.full_text !== 'string' && !hasNote && !media.length && !article) return null;
    const relations = [];
    const add = (kind, target, nested) => {
        const targetId = id(target) || id(unwrapTweet(nested)?.rest_id);
        if (targetId || nested || (kind === 'quote' && l.is_quote_status === true)) {
            relations.push({ kind, id: targetId, state: /Tombstone|Unavailable/.test(unwrapTweet(nested)?.__typename || '') ? 'unavailable' : 'not_fetched' });
        }
    };
    add('quote', l.quoted_status_id_str, tw.quoted_status_result?.result ?? l.quoted_status_result?.result);
    add('reply', l.in_reply_to_status_id_str);
    add('repost', l.retweeted_status_id_str, tw.retweeted_status_result?.result ?? l.retweeted_status_result?.result);
    return { id: tw.rest_id, url: `https://x.com/${author.handle || 'i'}/status/${tw.rest_id}`, author,
        text: hasNote ? note.text : typeof l.full_text === 'string' ? l.full_text : '',
        text_source: hasNote ? 'note' : 'legacy', lang: str(l.lang),
        // Preserve provider indices; callers must validate offsets before using them.
        entity_index_unit: 'provider', entities: textEntities(hasNote ? note.entity_set : l.entities),
        richtext: array(note?.richtext?.richtext_tags).map(r => ({ from_index: count(r?.from_index), to_index: count(r?.to_index), types: array(r?.richtext_types).filter(t => typeof t === 'string') })),
        inline_media: array(note?.media?.inline_media ?? note?.inline_media).map(m => ({ media_id: id(m?.media_id), index: count(m?.index) })),
        media, poll: extractPoll(tw), article,
        created_at: str(l.created_at), metrics: { likes: count(l.favorite_count), retweets: count(l.retweet_count), replies: count(l.reply_count), bookmarks: count(l.bookmark_count), views: count(tw.views?.count) },
        relations, completeness: { text: l.truncated === true && !hasNote ? 'partial' : 'unknown', media: media.some(m => m.type === 'unknown' || !m.poster_url) ? 'partial' : 'unknown', article: article?.completeness || (tw.article ? 'unknown' : 'not_applicable') } };
}
