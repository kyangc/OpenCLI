import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { command as searchCommand } from './search.js';
import {
    boundedBrowserPage,
    canonicalNoteUrl,
    fieldsFrom,
    isBoundedTransportFailure,
    readIsolatedDetail,
    requireActivePage as requireIsolatedActivePage,
    sanitizedText,
    withDetailDeadline,
} from './detail-isolation.js';

const MAX_EXCERPT_CHARS = 560;
const SEARCH_OPERATION_TIMEOUT_SECONDS = 20;
const SEARCH_OPERATION_ATTEMPTS = 2;
const SEARCH_RECOVERY_TIMEOUT_SECONDS = 5;
const DETAIL_READ_TIMEOUT_SECONDS = 15;
// Leave headroom below OpenCLI's 60s command ceiling for detached tab cleanup.
const CAPTURE_BATCH_TIMEOUT_SECONDS = 50;

function requireActivePage(page) {
    return requireIsolatedActivePage(page, 'Xiaohongshu search-notes');
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
