import { AuthRequiredError } from '@jackwener/opencli/errors';
import { TWITTER_BEARER_TOKEN } from './utils.js';
import { unwrapBrowserResult } from './shared.js';

// Reuse the authenticated page, never export session cookies to another client.
export async function requestTranslation(page, post, deadline = Date.now() + 15_000) {
    const remaining = Math.min(15_000, deadline - Date.now());
    if (remaining <= 0) return { reason: 'translation_budget_exhausted', fallback: false };
    const cookies = await page.getCookies({ url: 'https://x.com' });
    const csrf = cookies.find(c => c.name === 'ct0')?.value;
    if (!csrf) throw new AuthRequiredError('x.com', 'X login required');
    const headers = { authorization: `Bearer ${TWITTER_BEARER_TOKEN}`, 'x-csrf-token': csrf,
        'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'zh-cn', 'content-type': 'application/json' };
    const result = unwrapBrowserResult(await page.evaluate(`(async () => {
        const response = await fetch('https://api.x.com/2/grok/translation.json', {
            method: 'POST', credentials: 'include', headers: ${JSON.stringify(headers)},
            body: JSON.stringify({ content_type: 'POST', id: ${JSON.stringify(post.id)}, dst_lang: 'zh' }),
            signal: AbortSignal.timeout(${remaining})
        });
        const body = await response.text();
        return { status: response.status, body: body.length <= 300000 ? body : null };
    })()`));
    if (result?.status === 401) throw new AuthRequiredError('x.com', 'X session requires login');
    if (result?.status === 429) return { reason: 'translation_rate_limited', fallback: false };
    if (result?.status !== 200) return { reason: 'translation_api_unavailable', fallback: true };
    let data;
    try { data = JSON.parse(result.body); } catch { return { reason: 'translation_api_invalid', fallback: true }; }
    if (data.errors?.some(e => [32, 89, 215].includes(e.code))) throw new AuthRequiredError('x.com', 'X session requires login');
    const text = data.result?.text;
    if (data.result?.content_type !== 'POST' || typeof text !== 'string' || !text.trim() || !/[\u3400-\u9fff]/u.test(text)
        || text.trim() === post.text.trim()) return { reason: 'translation_api_invalid', fallback: true };
    return { text, entities: data.result.entities ?? {}, method: 'api' };
}
