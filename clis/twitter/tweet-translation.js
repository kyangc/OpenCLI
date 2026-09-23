import { ArgumentError, AuthRequiredError, LoginWallError } from '@jackwener/opencli/errors';
import { unwrapBrowserResult } from './shared.js';

export function validateTranslationTarget(target) {
    if (target !== undefined && target !== 'zh-CN') throw new ArgumentError('translate-to currently supports only zh-CN');
}

// Executed in the page; intentionally self-contained and read-only.
export function inspectTranslation(postId) {
    if (/^\/(?:i\/flow\/login|login)(?:\/|$)/.test(location.pathname)) return { state: 'login_required' };
    const current = location.pathname.match(/\/status\/(\d+)/)?.[1];
    if (current !== postId) return { state: 'wrong_page' };
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(a =>
        [...a.querySelectorAll('a[href]')].some(link => link.querySelector('time') && new URL(link.href, location.href).pathname === new URL(location.href).pathname));
    if (articles.length !== 1) return { state: 'missing_post' };
    const article = articles[0];
    // Quoted cards have their own role=link container. Never consume their text/buttons.
    const own = el => {
        for (let p = el.parentElement; p && p !== article; p = p.parentElement) {
            if (p.matches('[role="link"],article[data-testid="tweet"]')) return false;
        }
        return true;
    };
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')].filter(own);
    if (texts.length !== 1) return { state: 'missing_text' };
    const el = texts[0];
    const buttons = [...article.querySelectorAll('button[aria-label]')].filter(own);
    const original = buttons.find(b => /^(显示原文|顯示原文|Show original)$/i.test(b.getAttribute('aria-label')));
    const translate = buttons.find(b => /^(显示翻译|顯示翻譯|Show translation|Translate post|翻译帖子)$/i.test(b.getAttribute('aria-label')));
    const clone = el.cloneNode(true);
    // textContent avoids viewport-dependent URL wrapping. Expand visible URL links.
    for (const a of clone.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (/^https?:\/\//i.test(href || '') && !/^[@#]/.test(a.textContent || '')) a.textContent = href;
    }
    const selector = translate ? 'button[aria-label=' + JSON.stringify(translate.getAttribute('aria-label')) + ']' : null;
    return { state: original ? 'translated' : translate ? 'available' : 'unavailable',
        text: clone.textContent || '', lang: el.lang || null,
        truncated: [...article.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].some(own),
        selector, nth: translate ? [...document.querySelectorAll(selector)].indexOf(translate) : null };
}

export async function translatePost(page, post, { deadline, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    const base = { provider: 'x', target_lang: 'zh-CN', source_lang: post.lang || null, scope: 'post_text',
        text: null, completeness: 'not_available', untranslated_fields: ['article', 'poll', 'link_card', 'media_text'], fetched_at: null };
    const unavailable = reason => ({ ...base, status: 'unavailable', reason });
    if (post.article) return unavailable('article_translation_not_supported');
    if (!post.text.trim()) return { ...base, status: 'not_needed', reason: 'no_text' };
    if (/^zh(?:-|$)/i.test(post.lang || '')) return { ...base, status: 'not_needed', reason: 'already_chinese' };
    if (now() >= deadline) return unavailable('translation_budget_exhausted');
    try {
        await page.goto(`https://x.com/i/status/${post.id}?lang=zh-cn`, { waitUntil: 'none' });
        const end = Math.min(deadline, now() + 15_000);let clicked = false;let sourceLang = post.lang || null;let last;
        while (now() < end) {
            const state = unwrapBrowserResult(await page.evaluate(`(${inspectTranslation.toString()})(${JSON.stringify(post.id)})`));
            last = state;
            if (state?.state === 'login_required') throw new AuthRequiredError('x.com', 'X session requires login');
            if (!state || state.state === 'wrong_page' || state.state === 'missing_post' || state.state === 'missing_text') { await sleep(500);continue; }
            if (state.state === 'translated') {
                if (!/^zh(?:-|$)/i.test(state.lang || '')) return unavailable('target_language_mismatch');
                if (!state.text?.trim()) return unavailable('empty_translation');
                return { ...base, source_lang: sourceLang, status: 'translated', text: state.text,
                    completeness: state.truncated ? 'partial' : 'unknown', fetched_at: new Date(now()).toISOString() };
            }
            sourceLang ||= state.lang;
            if (/^zh(?:-|$)/i.test(sourceLang || '')) return { ...base, source_lang: sourceLang, status: 'not_needed', reason: 'already_chinese' };
            if (state.state === 'available' && !clicked) {
                // A fresh DOM observation supplies both selector and its unique position.
                await page.click(state.selector, { nth: state.nth });clicked = true;
            }
            await sleep(500);
        }
        return unavailable(clicked ? 'translation_timeout' : last?.state === 'unavailable' ? 'translation_not_offered' : 'post_not_rendered');
    } catch (error) {
        if (error instanceof AuthRequiredError || error instanceof LoginWallError) throw error;
        return unavailable('translation_read_failed');
    }
}

export async function appendTranslations(page, result, target, options = {}) {
    validateTranslationTarget(target);
    if (target === undefined) return result;
    const deadline = Date.now() + 60_000;
    const posts = Object.values(result.posts).sort((a,b) => (a.id === result.root_id ? -1 : b.id === result.root_id ? 1 : 0));
    for (const post of posts) {
        post.translation = await translatePost(page, post, { deadline, ...options });
        if (post.translation.status === 'unavailable' || post.translation.completeness === 'partial') result.warnings.push({ code: 'translation_' + (post.translation.reason || 'partial'), post_id: post.id, field: 'translation' });
    }
    return result;
}
