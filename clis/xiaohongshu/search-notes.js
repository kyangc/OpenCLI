import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { command as noteCommand } from './note.js';
import { command as searchCommand, noteUrlInfo } from './search.js';

const MAX_EXCERPT_CHARS = 560;
const SEARCH_OPERATION_TIMEOUT_SECONDS = 30;
const DETAIL_OPERATION_TIMEOUT_SECONDS = 10;
const DETAIL_READ_TIMEOUT_SECONDS = 15;

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
    return value
        .replace(/\0/g, '')
        .replace(/https?:\/\/\S+/giu, '[链接已移除]')
        .replace(/\bxsec_token\s*[=:]\s*[^\s&]+/giu, '[令牌已移除]')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, limit)
        .trim();
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

async function withDetailDeadline(readPromise) {
    let timer;
    try {
        return await Promise.race([
            readPromise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(
                    'xiaohongshu note detail',
                    DETAIL_READ_TIMEOUT_SECONDS,
                    'The stalled note was skipped so the remaining search results could still be read.',
                )), DETAIL_READ_TIMEOUT_SECONDS * 1000);
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
        return await withDetailDeadline(noteCommand.func(detailHandle, {
            'note-id': signedUrl,
        }));
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

export const command = cli({
    site: 'xiaohongshu',
    name: 'search-notes',
    access: 'read',
    description: '搜索小红书笔记并读取脱敏短摘录',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    siteSession: 'persistent',
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
        const searchHandle = boundedBrowserPage(page, SEARCH_OPERATION_TIMEOUT_SECONDS);
        let searchRows;
        try {
            searchRows = await searchCommand.func(searchHandle, {
                query: kwargs.query,
                limit: kwargs.limit,
            });
        }
        catch (error) {
            if (isBoundedTransportFailure(error)) {
                throw new TimeoutError(
                    'xiaohongshu search phase',
                    SEARCH_OPERATION_TIMEOUT_SECONDS,
                    'The search page did not respond within its local browser-operation budget.',
                );
            }
            throw error;
        }
        const searchPage = requireActivePage(searchHandle);
        const captures = [];
        for (const [index, row] of searchRows.entries()) {
            const canonicalUrl = canonicalNoteUrl(row.url);
            if (!canonicalUrl)
                continue;
            let fields = {};
            try {
                fields = fieldsFrom(await readIsolatedDetail(searchHandle, searchPage, row.url));
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
