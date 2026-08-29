import { describe, expect, it, vi } from 'vitest';
import { command } from './search-notes.js';

const NOTE_ID = '69c131c9000000002800be4c';
const SIGNED_URL = `https://www.xiaohongshu.com/search_result/${NOTE_ID}?xsec_token=private-token`;
const SECOND_NOTE_ID = '69c131ca000000002800be4d';
const SECOND_SIGNED_URL = `https://www.xiaohongshu.com/search_result/${SECOND_NOTE_ID}?xsec_token=second-private-token`;

function pageWithOneNote(detail = {
    pageUrl: SIGNED_URL,
    securityBlock: false,
    loginWall: false,
    notFound: false,
    title: '里斯本雨天慢游',
    desc: '午后阵雨时先逛室内展馆，再沿有遮蔽的街区慢慢步行。',
    author: '旅行者',
    likes: '12',
    collects: '4',
    comments: '2',
    tags: [],
}) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn(async (script) => {
            const source = String(script);
            if (source.includes('findNoteCard'))
                return 'content';
            if (source.includes('const requestedFilters ='))
                return { status: 'ok' };
            if (source.includes('const targetCount =')) {
                return {
                    rows: [{
                        title: '里斯本雨天慢游',
                        author: '旅行者',
                        likes: '12',
                        url: SIGNED_URL,
                        author_url: '',
                    }],
                    diag: {
                        securityBlock: false,
                        stopReason: 'target',
                        scrollHeight: 1800,
                        clientHeight: 900,
                        cardCount: 1,
                        feedClientHeight: 1200,
                        distinctCardTops: 1,
                    },
                };
            }
            if (source.includes("document.querySelector('#noteContainer')")) {
                return detail;
            }
            throw new Error(`Unexpected evaluate script: ${source.slice(0, 80)}`);
        }),
        getActivePage: vi.fn(() => 'page-1'),
        newTab: vi.fn().mockResolvedValue('page-2'),
        setActivePage: vi.fn(),
        selectTab: vi.fn().mockResolvedValue(undefined),
        closeTab: vi.fn().mockResolvedValue(undefined),
    };
}

describe('xiaohongshu search-notes', () => {
    it('publishes a narrow read-only persistent-session interface', () => {
        expect(command).toMatchObject({
            site: 'xiaohongshu',
            name: 'search-notes',
            access: 'read',
            siteSession: 'persistent',
        });
        expect(command.args.map((argument) => argument.name)).toEqual([
            'query',
            'limit',
        ]);
    });

    it('uses signed URLs only inside the command and emits a sanitized capture', async () => {
        const page = pageWithOneNote();

        const result = await command.func(page, {
            query: '里斯本 雨天安排',
            limit: 1,
        });

        expect(page.goto.mock.calls[1][0]).toBe(SIGNED_URL);
        expect(result).toEqual([{
            rank: 1,
            title: '里斯本雨天慢游',
            author: '旅行者',
            published_at: '2026-03-23',
            canonical_url: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
            excerpt: '午后阵雨时先逛室内展馆，再沿有遮蔽的街区慢慢步行。',
            capture_status: 'captured',
        }]);
        expect(JSON.stringify(result)).not.toContain('xsec_token');
        expect(JSON.stringify(result)).not.toContain('private-token');
    });

    it('sanitizes every persisted text field and caps the excerpt', async () => {
        const signedText = (
            `https://www.xiaohongshu.com/explore/${NOTE_ID}` +
            '?xsec_token=content-private-token'
        );
        const page = pageWithOneNote({
            pageUrl: SIGNED_URL,
            securityBlock: false,
            loginWall: false,
            notFound: false,
            title: `雨天路线 ${signedText}`,
            desc: (`先逛室内展馆 ${signedText} 再散步。`).repeat(80),
            author: 'xsec_token=author-private-token',
            likes: '12',
            collects: '4',
            comments: '2',
            tags: [],
        });

        const result = await command.func(page, {
            query: '里斯本 雨天安排',
            limit: 1,
        });

        const persisted = JSON.stringify(result);
        expect(persisted).not.toContain('xsec_token');
        expect(persisted).not.toContain('private-token');
        expect(result[0].excerpt.length).toBeLessThanOrEqual(560);
    });

    it('keeps usable notes when one detail is unavailable', async () => {
        const page = pageWithOneNote();
        let detailReads = 0;
        page.evaluate.mockImplementation(async (script) => {
            const source = String(script);
            if (source.includes('findNoteCard'))
                return 'content';
            if (source.includes('const requestedFilters ='))
                return { status: 'ok' };
            if (source.includes('const targetCount =')) {
                return {
                    rows: [
                        {
                            title: '里斯本雨天慢游', author: '旅行者', likes: '12',
                            url: SIGNED_URL, author_url: '',
                        },
                        {
                            title: '电车沿线散步', author: '另一位旅行者', likes: '3',
                            url: SECOND_SIGNED_URL, author_url: '',
                        },
                    ],
                    diag: {
                        securityBlock: false,
                        stopReason: 'target',
                        scrollHeight: 2200,
                        clientHeight: 900,
                        cardCount: 2,
                        feedClientHeight: 1600,
                        distinctCardTops: 2,
                    },
                };
            }
            if (source.includes("document.querySelector('#noteContainer')")) {
                detailReads += 1;
                return detailReads === 1
                    ? {
                        pageUrl: SIGNED_URL,
                        securityBlock: false,
                        loginWall: false,
                        notFound: false,
                        title: '里斯本雨天慢游',
                        desc: '午后阵雨时先逛室内展馆，再沿有遮蔽的街区慢慢步行。',
                        author: '旅行者',
                        likes: '12',
                        collects: '4',
                        comments: '2',
                        tags: [],
                    }
                    : {
                        pageUrl: SECOND_SIGNED_URL,
                        securityBlock: false,
                        loginWall: false,
                        notFound: true,
                    };
            }
            throw new Error(`Unexpected evaluate script: ${source.slice(0, 80)}`);
        });

        const result = await command.func(page, {
            query: '里斯本 雨天安排',
            limit: 2,
        });

        expect(result.map((row) => row.capture_status)).toEqual([
            'captured',
            'unavailable',
        ]);
        expect(result[1]).toMatchObject({
            canonical_url: `https://www.xiaohongshu.com/explore/${SECOND_NOTE_ID}`,
            excerpt: '',
        });
        expect(JSON.stringify(result)).not.toContain('xsec_token');
        expect(JSON.stringify(result)).not.toContain('second-private-token');
    });

    it('propagates login loss without exposing the signed URL', async () => {
        const page = pageWithOneNote({
            pageUrl: SIGNED_URL,
            securityBlock: false,
            loginWall: true,
            notFound: false,
        });

        try {
            await command.func(page, {
                query: '里斯本 雨天安排',
                limit: 1,
            });
            throw new Error('expected login loss to fail the command');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
            expect(String(error)).not.toContain('xsec_token');
            expect(String(error)).not.toContain('private-token');
        }
    });
});
