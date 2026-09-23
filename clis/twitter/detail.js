import { cli, Strategy } from '@jackwener/opencli/registry';
import { fetchDetail } from './tweet-detail.js';
cli({
    site: 'twitter', name: 'detail', access: 'read', domain: 'x.com', browser: true,
    strategy: Strategy.COOKIE,
    description: 'Fetch one X post with author avatars, typed media, polls, article blocks and bounded quote/reply context (versioned JSON)',
    args: [
        { name: 'tweet-id', type: 'string', positional: true, required: true, help: 'Numeric tweet ID or HTTPS status URL' },
        { name: 'translate-to', type: 'string', required: false, help: 'Also read X webpage translation (zh-CN); keeps original text and returns per-post translation status' },
        { name: 'translate-relations', type: 'string', required: false, help: 'Translate related posts: all, quote, reply or none (reposts always included)' },
        { name: 'context-depth', type: 'int', default: 1, help: 'Related post depth: 0, 1 (default), or 2; at most 8 posts' },
    ],
    columns: ['schema_version', 'requested_id', 'root_id', 'fetched_at', 'posts', 'context', 'warnings'],
    func: (page, kwargs) => fetchDetail(page, kwargs['tweet-id'], kwargs['context-depth'] ?? 1, kwargs['translate-to'], kwargs['translate-relations']),
});
