import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { command as noteCommand } from './note.js';
import { command as searchCommand, noteUrlInfo } from './search.js';

const MAX_EXCERPT_CHARS = 560;

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
        const searchRows = await searchCommand.func(page, {
            query: kwargs.query,
            limit: kwargs.limit,
        });
        const captures = [];
        for (const [index, row] of searchRows.entries()) {
            const canonicalUrl = canonicalNoteUrl(row.url);
            if (!canonicalUrl)
                continue;
            let fields = {};
            try {
                fields = fieldsFrom(await noteCommand.func(page, {
                    'note-id': row.url,
                }));
            }
            catch (error) {
                if (error instanceof AuthRequiredError)
                    throw error;
                if (!(error instanceof CliError)) {
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
