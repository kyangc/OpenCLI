import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { command as searchCommand, noteUrlInfo } from './search.js';
import { canonicalNoteUrl, sanitizedText } from './detail-isolation.js';
import { assertXhsRefStoreAvailable, storeXhsNoteRefs } from './xhs-ref-store.js';

function parseDiscoverLimit(raw) {
    const limit = Number(raw ?? 12);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        throw new ArgumentError('--limit must be an integer between 1 and 20.');
    return limit;
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'discover',
    access: 'read',
    description: '搜索小红书笔记并返回短期不透明引用',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    siteSession: 'ephemeral',
    navigateBefore: false,
    args: [
        { name: 'query', required: true, positional: true, help: 'Search keyword' },
        { name: 'limit', type: 'int', default: 12, help: 'Number of notes (1-20)' },
    ],
    columns: ['rank', 'note_ref', 'title', 'author', 'canonical_url', 'published_at', 'likes'],
    func: async (page, kwargs) => {
        const limit = parseDiscoverLimit(kwargs.limit);
        // Fail before browsing if secret-bearing search results cannot be persisted safely.
        assertXhsRefStoreAvailable();
        let searchRows;
        try {
            searchRows = await searchCommand.func(page, {
                query: kwargs.query,
                limit,
            }, { applyDefaultFilters: false });
        }
        catch (error) {
            if (error instanceof AuthRequiredError)
                throw error;
            throw new CommandExecutionError('Xiaohongshu discover search failed.');
        }
        const eligible = [];
        for (const [index, row] of searchRows.entries()) {
            const canonicalUrl = canonicalNoteUrl(row.url);
            if (canonicalUrl && noteUrlInfo(row.url, 'www.xiaohongshu.com').signed)
                eligible.push([row, index + 1, canonicalUrl]);
        }
        if (eligible.length === 0)
            throw new EmptyResultError('xiaohongshu/discover', 'Search returned no notes with a usable signed detail binding.');

        // Persist every secret-bearing URL before constructing any provider output.
        const stored = storeXhsNoteRefs(eligible.map(([row, , canonicalUrl]) => ({
            signedUrl: row.url,
            canonicalUrl,
        })));
        return eligible.map(([row, rank], index) => ({
            rank,
            note_ref: stored[index].noteRef,
            title: sanitizedText(row.title || '', 180),
            author: sanitizedText(row.author || '', 120),
            canonical_url: stored[index].canonicalUrl,
            // Search currently derives dates from note IDs. That is not reliable metadata.
            published_at: '',
            likes: sanitizedText(row.likes || '', 40),
        }));
    },
});

export const __test__ = { parseDiscoverLimit };
