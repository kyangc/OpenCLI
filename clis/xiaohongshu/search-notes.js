import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { command as noteCommand } from './note.js';
import { command as searchCommand, noteUrlInfo } from './search.js';

const MAX_EXCERPT_CHARS = 560;
const SEARCH_OPERATION_TIMEOUT_SECONDS = 20;
const SEARCH_OPERATION_ATTEMPTS = 2;
const SEARCH_RECOVERY_TIMEOUT_SECONDS = 5;
const DETAIL_OPERATION_TIMEOUT_SECONDS = 10;
const DETAIL_READ_TIMEOUT_SECONDS = 15;
// Leave headroom below OpenCLI's 60s command ceiling for detached tab cleanup.
const CAPTURE_BATCH_TIMEOUT_SECONDS = 50;

function fieldsFrom(rows) {
    if (!Array.isArray(rows))
        return {};
    return Object.fromEntries(rows
        .filter((row) => row && typeof row === 'object' &&
            typeof row.field === 'string' && typeof row.value === 'string')
        .map((row) => [row.field, row.value]));
}

function sanitizedText(value, limit) {
    if (typeof value !== 'string')
        return '';
    const sanitized = value
        .replace(/\0/g, '')
        .replace(/https?:\/\/\S+/giu, '[链接已移除]')
        .replace(/\bxsec_token\s*[=:]\s*[^\s&]+/giu, '[令牌已移除]')
        .replace(/\s+/gu, ' ')
        .trim();
    return [...sanitized].slice(0, limit).join('').trim();
}

function canonicalNoteUrl(value) {
    const noteId = noteUrlInfo(value, 'www.xiaohongshu.com').key;
    return noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : '';
}

function boundedBrowserPage(page, timeoutSeconds) {
    if (typeof page.getActivePage !== 'function' || typeof page.newTab !== 'function' ||
        typeof page.setActivePage !== 'function' || typeof page.closeTab !== 'function' ||
        typeof page.selectTab !== 'function' || typeof page.withCommandTimeout !== 'function') {
        throw new CommandExecutionError(
            'Xiaohongshu search-notes requires Browser Bridge tab isolation for bounded detail reads.',
        );
    }
    return page.withCommandTimeout(timeoutSeconds);
}

function requireActivePage(page) {
    const searchPage = page.getActivePage();
    if (!searchPage) {
        throw new CommandExecutionError(
            'Xiaohongshu search-notes cannot identify its search-results page for detail isolation.',
        );
    }
    return searchPage;
}

async function withDetailDeadline(readPromise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            readPromise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(
                    'xiaohongshu note detail',
                    Math.max(1, Math.ceil(timeoutMs / 1000)),
                    'The stalled note was skipped so the remaining search results could still be read.',
                )), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}

async function readIsolatedDetail(page, searchPage, signedUrl) {
    const tabControl = boundedBrowserPage(page, DETAIL_OPERATION_TIMEOUT_SECONDS);
    const detailPage = await tabControl.newTab();
    if (!detailPage) {
        throw new CommandExecutionError(
            'Xiaohongshu search-notes could not create an isolated detail page.',
        );
    }
    try {
        // Keep the persistent session anchored to the search page. The local
        // Page handle can still target the isolated detail tab explicitly.
        await tabControl.selectTab(searchPage);
        const detailHandle = boundedBrowserPage(tabControl, DETAIL_OPERATION_TIMEOUT_SECONDS);
        detailHandle.setActivePage(detailPage);
        return await noteCommand.func(detailHandle, {
            'note-id': signedUrl,
        });
    }
    finally {
        // Restore authority before closing: closing the preferred tab would
        // release the whole persistent site session instead of one detail tab.
        tabControl.setActivePage(searchPage);
        await tabControl.selectTab(searchPage);
        await tabControl.closeTab(detailPage);
    }
}

function isBoundedTransportFailure(error) {
    let current = error;
    const seen = new Set();
    while (current && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
        seen.add(current);
        if (current.code === 'command_result_unknown' || current.code === 'cdp_timeout')
            return true;
        current = current.cause;
    }
    return false;
}

async function discardFailedSearchPage(searchHandle) {
    const failedPage = searchHandle.getActivePage();
    if (!failedPage)
        return false;
    const cleanupHandle = boundedBrowserPage(searchHandle, SEARCH_RECOVERY_TIMEOUT_SECONDS);
    cleanupHandle.setActivePage(failedPage);
    await cleanupHandle.closeTab(failedPage);
    return true;
}

async function acquireSearchRows(page, kwargs) {
    let lastTransportFailure;
    for (let attempt = 0; attempt < SEARCH_OPERATION_ATTEMPTS; attempt += 1) {
        const searchHandle = boundedBrowserPage(page, SEARCH_OPERATION_TIMEOUT_SECONDS);
        try {
            const searchRows = await searchCommand.func(searchHandle, {
                query: kwargs.query,
                limit: kwargs.limit,
            }, { applyDefaultFilters: false });
            return {
                searchHandle,
                searchPage: requireActivePage(searchHandle),
                searchRows,
            };
        }
        catch (error) {
            if (!isBoundedTransportFailure(error))
                throw error;
            lastTransportFailure = error;
            if (attempt + 1 < SEARCH_OPERATION_ATTEMPTS &&
                !await discardFailedSearchPage(searchHandle)) {
                throw error;
            }
        }
    }
    const timeout = new TimeoutError(
        'xiaohongshu search phase',
        SEARCH_OPERATION_TIMEOUT_SECONDS * SEARCH_OPERATION_ATTEMPTS,
        'The search page did not respond after one bounded transport retry.',
    );
    timeout.cause = lastTransportFailure;
    throw timeout;
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'search-notes',
    access: 'read',
    description: '搜索小红书笔记并读取脱敏短摘录',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    siteSession: 'ephemeral',
    navigateBefore: false,
    args: [
        { name: 'query', required: true, positional: true, help: 'Search keyword' },
        { name: 'limit', type: 'int', default: 5, help: 'Number of notes' },
    ],
    columns: [
        'rank',
        'title',
        'author',
        'published_at',
        'canonical_url',
        'excerpt',
        'capture_status',
    ],
    func: async (page, kwargs) => {
        const captureDeadlineAt = Date.now() + CAPTURE_BATCH_TIMEOUT_SECONDS * 1000;
        const { searchHandle, searchPage, searchRows } = await acquireSearchRows(page, kwargs);
        const captures = [];
        for (const [index, row] of searchRows.entries()) {
            const canonicalUrl = canonicalNoteUrl(row.url);
            if (!canonicalUrl)
                continue;
            let fields = {};
            try {
                const remainingMs = captureDeadlineAt - Date.now();
                if (remainingMs > 0) {
                    fields = fieldsFrom(await withDetailDeadline(
                        readIsolatedDetail(searchHandle, searchPage, row.url),
                        Math.min(DETAIL_READ_TIMEOUT_SECONDS * 1000, remainingMs),
                    ));
                }
            }
            catch (error) {
                if (error instanceof AuthRequiredError)
                    throw error;
                if (!(error instanceof CliError) && !isBoundedTransportFailure(error)) {
                    throw new CommandExecutionError(
                        'Xiaohongshu search-notes detail read failed.',
                    );
                }
            }
            const excerpt = sanitizedText(fields.content, MAX_EXCERPT_CHARS);
            captures.push({
                rank: index + 1,
                title: sanitizedText(fields.title || row.title || '', 180),
                author: sanitizedText(fields.author || row.author || '', 120),
                published_at: row.published_at || '',
                canonical_url: canonicalUrl,
                excerpt,
                capture_status: excerpt ? 'captured' : 'unavailable',
            });
        }
        return captures;
    },
});
