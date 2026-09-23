import { cli, Strategy } from '@jackwener/opencli/registry';
import { sessionScope } from './tweet-session.js';
cli({
    site: 'twitter', name: 'session-scope', access: 'read', browser: true, domain: 'x.com',
    strategy: Strategy.COOKIE, navigateBefore: false,
    description: 'Read an opaque cache scope for the current X login without navigating or exposing cookies',
    columns: ['scope'],
    func: async page => ({ scope: sessionScope(await page.getCookies({ url: 'https://x.com' })) }),
});
