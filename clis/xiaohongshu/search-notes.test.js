import { describe, expect, it, vi } from 'vitest';
import { command } from './search-notes.js';

const NOTE_ID = '69c131c9000000002800be4c';
const SIGNED_URL = `https://www.xiaohongshu.com/search_result/${NOTE_ID}?xsec_token=private-token`;
const SECOND_NOTE_ID = '69c131ca000000002800be4d';
const SECOND_SIGNED_URL = `https://www.xiaohongshu.com/search_result/${SECOND_NOTE_ID}?xsec_token=second-private-token`;
const THIRD_NOTE_ID = '69c131cb000000002800be4e';
const THIRD_SIGNED_URL = `https://www.xiaohongshu.com/search_result/${THIRD_NOTE_ID}?xsec_token=third-private-token`;

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
    const page = {
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
    page.withCommandTimeout = vi.fn(() => page);
    return page;
}

function pageWithStalledMiddleNote() {
    let activePage = 'search-page';
    let nextPage = 1;
    const detailByPage = new Map();
    const page = {
        goto: vi.fn((url) => {
            if (url.includes('/search_result?'))
                return Promise.resolve();
            if (url.includes(SECOND_NOTE_ID))
                return new Promise(() => {});
            detailByPage.set(activePage, url.includes(THIRD_NOTE_ID) ? 'third' : 'first');
            return Promise.resolve();
        }),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn(async (script) => {
            const source = String(script);
            if (source.includes('findNoteCard'))
                return 'content';
            if (source.includes('const requestedFilters ='))
                return { status: 'ok' };
            if (source.includes('const targetCount =')) {
                return {
                    rows: [
                        { title: '第一篇', author: '作者一', likes: '12', url: SIGNED_URL, author_url: '' },
                        { title: '第二篇', author: '作者二', likes: '8', url: SECOND_SIGNED_URL, author_url: '' },
                        { title: '第三篇', author: '作者三', likes: '5', url: THIRD_SIGNED_URL, author_url: '' },
                    ],
                    diag: {
                        securityBlock: false,
                        stopReason: 'target',
                        scrollHeight: 2600,
                        clientHeight: 900,
                        cardCount: 3,
                        feedClientHeight: 1900,
                        distinctCardTops: 3,
                    },
                };
            }
            if (source.includes("document.querySelector('#noteContainer')")) {
                const detail = detailByPage.get(activePage);
                return {
                    pageUrl: detail === 'third' ? THIRD_SIGNED_URL : SIGNED_URL,
                    securityBlock: false,
                    loginWall: false,
                    notFound: false,
                    title: detail === 'third' ? '第三篇详情' : '第一篇详情',
                    desc: detail === 'third' ? '第三篇正文' : '第一篇正文',
                    author: detail === 'third' ? '作者三' : '作者一',
                    likes: '1',
                    collects: '1',
                    comments: '1',
                    tags: [],
                };
            }
            throw new Error(`Unexpected evaluate script: ${source.slice(0, 80)}`);
        }),
        getActivePage: vi.fn(() => activePage),
        newTab: vi.fn(async () => `detail-page-${nextPage++}`),
        setActivePage: vi.fn((target) => {
            activePage = target;
        }),
        selectTab: vi.fn(async (target) => {
            activePage = target;
        }),
        closeTab: vi.fn().mockResolvedValue(undefined),
        withCommandTimeout: vi.fn(() => page),
    };
    return page;
}

function pageWithRecoverableSearchTransportStall() {
    const page = pageWithOneNote();
    let searchAttempt = 0;
    page.withCommandTimeout = vi.fn((seconds) => {
        if (seconds <= 10)
            return page;
        searchAttempt += 1;
        return {
            ...page,
            withCommandTimeout: page.withCommandTimeout,
            goto: vi.fn((url) => {
                if (url.includes('/search_result?') && searchAttempt === 1) {
                    return new Promise((_, reject) => {
                        setTimeout(() => reject(Object.assign(
                            new Error('local browser command deadline expired'),
                            { code: 'command_result_unknown' },
                        )), seconds * 1000);
                    });
                }
                return page.goto(url);
            }),
        };
    });
    return page;
}

describe('xiaohongshu search-notes', () => {
    it('publishes a narrow read-only ephemeral-session interface', () => {
        expect(command).toMatchObject({
            site: 'xiaohongshu',
            name: 'search-notes',
            access: 'read',
            siteSession: 'ephemeral',
        });
        expect(command.args.map((argument) => argument.name)).toEqual([
            'query',
            'limit',
        ]);
    });

    it('does not require the optional search-filter panel when no filters are exposed', async () => {
        const page = pageWithOneNote();
        const evaluate = page.evaluate.getMockImplementation();
        page.evaluate.mockImplementation(async (script) => {
            if (String(script).includes('const requestedFilters =')) {
                return { status: 'layout', detail: 'option_not_found' };
            }
            return evaluate(script);
        });

        const result = await command.func(page, {
            query: '里斯本 雨天安排',
            limit: 1,
        });

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('里斯本雨天慢游');
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

    it('continues after one detail read stalls until its local deadline', async () => {
        vi.useFakeTimers();
        try {
            const page = pageWithStalledMiddleNote();
            const settled = vi.fn();
            void command.func(page, {
                query: '里斯本 雨天安排',
                limit: 3,
            }).then(
                (value) => settled({ status: 'fulfilled', value }),
                (reason) => settled({ status: 'rejected', reason }),
            );

            await vi.advanceTimersByTimeAsync(15_000);

            expect(settled).toHaveBeenCalledOnce();
            expect(settled.mock.calls[0][0]).toEqual({
                status: 'fulfilled',
                value: [
                    expect.objectContaining({ rank: 1, capture_status: 'captured', excerpt: '第一篇正文' }),
                    expect.objectContaining({ rank: 2, capture_status: 'unavailable', excerpt: '' }),
                    expect.objectContaining({ rank: 3, capture_status: 'captured', excerpt: '第三篇正文' }),
                ],
            });
            expect(page.withCommandTimeout).toHaveBeenCalledWith(10);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('continues when one isolated detail cleanup stalls', async () => {
        vi.useFakeTimers();
        try {
            const page = pageWithStalledMiddleNote();
            page.goto.mockResolvedValue(undefined);
            page.closeTab.mockImplementation((target) => target === 'detail-page-2'
                ? new Promise(() => {})
                : Promise.resolve());
            const settled = vi.fn();
            void command.func(page, {
                query: '里斯本 雨天安排',
                limit: 3,
            }).then(
                (value) => settled({ status: 'fulfilled', value }),
                (reason) => settled({ status: 'rejected', reason }),
            );

            await vi.advanceTimersByTimeAsync(15_000);

            expect(settled).toHaveBeenCalledOnce();
            expect(settled.mock.calls[0][0]).toEqual({
                status: 'fulfilled',
                value: [
                    expect.objectContaining({ rank: 1, capture_status: 'captured' }),
                    expect.objectContaining({ rank: 2, capture_status: 'unavailable' }),
                    expect.objectContaining({ rank: 3, capture_status: 'captured' }),
                ],
            });
            expect(page.newTab).toHaveBeenCalledTimes(3);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('returns partial captures before the whole command timeout when the batch budget is exhausted', async () => {
        vi.useFakeTimers();
        try {
            const page = pageWithStalledMiddleNote();
            page.goto.mockImplementation((url) => url.includes('/search_result?')
                ? new Promise((resolve) => setTimeout(resolve, 20_000))
                : new Promise(() => {}));
            const settled = vi.fn();
            void command.func(page, {
                query: '里斯本 雨天安排',
                limit: 3,
            }).then(
                (value) => settled({ status: 'fulfilled', value }),
                (reason) => settled({ status: 'rejected', reason }),
            );

            await vi.advanceTimersByTimeAsync(50_000);

            expect(settled).toHaveBeenCalledOnce();
            expect(settled.mock.calls[0][0]).toEqual({
                status: 'fulfilled',
                value: [
                    expect.objectContaining({ rank: 1, capture_status: 'unavailable' }),
                    expect.objectContaining({ rank: 2, capture_status: 'unavailable' }),
                    expect.objectContaining({ rank: 3, capture_status: 'unavailable' }),
                ],
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('recovers one stalled search transport while time remains for note capture', async () => {
        vi.useFakeTimers();
        try {
            const page = pageWithRecoverableSearchTransportStall();
            const settled = vi.fn();
            void command.func(page, {
                query: '里斯本 雨天安排',
                limit: 1,
            }).then(
                (value) => settled({ status: 'fulfilled', value }),
                (reason) => settled({ status: 'rejected', reason }),
            );

            await vi.advanceTimersByTimeAsync(20_000);

            expect(settled).toHaveBeenCalledOnce();
            expect(settled.mock.calls[0][0]).toEqual({
                status: 'fulfilled',
                value: [expect.objectContaining({
                    rank: 1,
                    capture_status: 'captured',
                })],
            });
            expect(page.closeTab).toHaveBeenNthCalledWith(1, 'page-1');
            expect(page.closeTab.mock.invocationCallOrder[0])
                .toBeLessThan(page.goto.mock.invocationCallOrder[0]);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not retry an unknown search outcome when the failed page cannot be cancelled', async () => {
        const page = pageWithOneNote();
        page.getActivePage.mockReturnValue(undefined);
        page.goto.mockRejectedValue(Object.assign(
            new Error('local browser command deadline expired'),
            { code: 'command_result_unknown' },
        ));

        await expect(command.func(page, {
            query: '里斯本 雨天安排',
            limit: 3,
        })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            cause: { code: 'command_result_unknown' },
        });

        expect(page.withCommandTimeout).toHaveBeenCalledTimes(1);
        expect(page.closeTab).not.toHaveBeenCalled();
    });

    it('fails the batch with a typed timeout when the search phase transport expires', async () => {
        const page = pageWithOneNote();
        page.goto.mockRejectedValue(Object.assign(
            new Error('local browser command deadline expired'),
            { code: 'command_result_unknown' },
        ));

        await expect(command.func(page, {
            query: '里斯本 雨天安排',
            limit: 3,
        })).rejects.toMatchObject({
            code: 'TIMEOUT',
            message: 'xiaohongshu search phase timed out after 40s',
        });
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
