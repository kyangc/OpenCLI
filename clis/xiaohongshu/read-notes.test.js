import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command, __test__ } from './read-notes.js';
import { storeXhsNoteRefs } from './xhs-ref-store.js';

function note(index) {
    const noteId = (BigInt('0x69c131c9000000002800bf00') + BigInt(index)).toString(16).padStart(24, '0');
    return {
        signedUrl: `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=private-${index}`,
        canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    };
}

function makePrivateStore() {
    const root = fs.realpathSync.native(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(root, 'opencli-xhs-read-'));
    fs.chmodSync(dir, 0o700);
    return dir;
}

function pageFor(notesByUrl, { initialActivePage = 'anchor-page' } = {}) {
    let activePage = initialActivePage;
    let currentUrl = '';
    let nextTab = 0;
    return {
        getActivePage: vi.fn(() => activePage),
        newTab: vi.fn(async () => `detail-page-${++nextTab}`),
        setActivePage: vi.fn((pageId) => { activePage = pageId; }),
        selectTab: vi.fn(async (pageId) => { activePage = pageId; }),
        closeTab: vi.fn(async () => {}),
        withCommandTimeout() { return this; },
        goto: vi.fn(async (url) => {
            currentUrl = url;
            if (notesByUrl[url] instanceof Error)
                throw notesByUrl[url];
        }),
        wait: vi.fn(async () => {}),
        evaluate: vi.fn(async () => notesByUrl[currentUrl]),
    };
}

function notePayload(url, overrides = {}) {
    return {
        pageUrl: url,
        securityBlock: false,
        loginWall: false,
        notFound: false,
        title: '标题',
        desc: '正文',
        author: '作者',
        likes: '1',
        collects: '2',
        comments: '3',
        tags: [],
        ...overrides,
    };
}

describe('xiaohongshu read-notes', () => {
    let storeDir;
    let previousStoreDir;

    beforeEach(() => {
        previousStoreDir = process.env.OPENCLI_XHS_REF_DIR;
        storeDir = makePrivateStore();
        process.env.OPENCLI_XHS_REF_DIR = storeDir;
    });

    afterEach(() => {
        if (previousStoreDir === undefined)
            delete process.env.OPENCLI_XHS_REF_DIR;
        else
            process.env.OPENCLI_XHS_REF_DIR = previousStoreDir;
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('reads selected non-leading discovery refs in the requested order', async () => {
        const notes = Array.from({ length: 5 }, (_, index) => note(index + 1));
        const stored = storeXhsNoteRefs(notes);
        const selected = [stored[4], stored[2]];
        const page = pageFor(Object.fromEntries(notes.map((item, index) => [
            item.signedUrl,
            notePayload(item.signedUrl, { title: `标题${index + 1}`, desc: `正文${index + 1}` }),
        ])));

        const result = await command.func(page, {
            'note-refs': selected.map((entry) => entry.noteRef).join(','),
        });

        expect(result.map((row) => row.note_ref)).toEqual(selected.map((entry) => entry.noteRef));
        expect(result.map((row) => row.title)).toEqual(['标题5', '标题3']);
        expect(result.map((row) => row.canonical_url)).toEqual(selected.map((entry) => entry.canonicalUrl));
        expect(JSON.stringify(result)).not.toContain('xsec_token');
        expect(JSON.stringify(result)).not.toContain('private-');
    });

    it('creates a safe anchor when an independent job has no active page', async () => {
        const item = note(6);
        const [stored] = storeXhsNoteRefs([item]);
        const noteId = item.canonicalUrl.split('/').pop();
        const page = pageFor({
            [item.signedUrl]: notePayload(item.signedUrl, {
                pageUrl: `https://www.xiaohongshu.com/user/profile/author/${noteId}?xsec_source=pc_user`,
            }),
        }, { initialActivePage: null });

        const result = await command.func(page, { 'note-refs': stored.noteRef });

        expect(result[0].capture_status).toBe('captured');
        expect(page.newTab).toHaveBeenCalledTimes(2);
        expect(page.selectTab).toHaveBeenCalledWith('detail-page-1');
        expect(command.siteSession).toBe('ephemeral');
    });

    it('rejects a detail page whose actual note identity does not match the ref', async () => {
        const items = [note(21), note(22)];
        const [stored] = storeXhsNoteRefs([items[0]]);
        const page = pageFor({
            [items[0].signedUrl]: notePayload(items[1].signedUrl, {
                pageUrl: items[1].signedUrl,
                title: 'wrong title',
                desc: 'wrong body',
            }),
        });

        const result = await command.func(page, { 'note-refs': stored.noteRef });

        expect(result[0]).toMatchObject({ capture_status: 'unavailable', content: '', title: '' });
        expect(JSON.stringify(result)).not.toContain('wrong body');
    });

    it('marks a successfully read note with empty body as empty', async () => {
        const item = note(23);
        const [stored] = storeXhsNoteRefs([item]);
        const page = pageFor({
            [item.signedUrl]: notePayload(item.signedUrl, { desc: '' }),
        });

        const result = await command.func(page, { 'note-refs': stored.noteRef });

        expect(result[0]).toMatchObject({ capture_status: 'empty', content: '', content_truncated: false });
    });

    it('preserves other notes when one detail read fails and never emits the signed URL error', async () => {
        const notes = [note(1), note(2), note(3)];
        const stored = storeXhsNoteRefs(notes);
        const page = pageFor({
            [notes[0].signedUrl]: notePayload(notes[0].signedUrl, { desc: '第一篇' }),
            [notes[1].signedUrl]: new Error(`failed at ${notes[1].signedUrl}`),
            [notes[2].signedUrl]: notePayload(notes[2].signedUrl, { desc: '第三篇' }),
        });

        const result = await command.func(page, {
            'note-refs': stored.map((entry) => entry.noteRef).join(','),
        });

        expect(result.map((row) => row.capture_status)).toEqual(['captured', 'unavailable', 'captured']);
        expect(result.map((row) => row.content)).toEqual(['第一篇', '', '第三篇']);
        expect(JSON.stringify(result)).not.toContain('xsec_token');
        expect(JSON.stringify(result)).not.toContain('private-2');
    });

    it('preserves completed reads when a later note requires login', async () => {
        const notes = [note(31), note(32), note(33)];
        const stored = storeXhsNoteRefs(notes);
        const page = pageFor({
            [notes[0].signedUrl]: notePayload(notes[0].signedUrl, { desc: '第一篇' }),
            [notes[1].signedUrl]: notePayload(notes[1].signedUrl, { loginWall: true }),
            [notes[2].signedUrl]: notePayload(notes[2].signedUrl, { desc: '不应读取' }),
        });

        const result = await command.func(page, {
            'note-refs': stored.map((entry) => entry.noteRef).join(','),
        });

        expect(result.map((row) => row.capture_status)).toEqual(['captured', 'login_required', 'login_required']);
        expect(result[0].content).toBe('第一篇');
        expect(page.goto).toHaveBeenCalledTimes(2);
    });

    it('keeps first-note AuthRequired as a typed command failure', async () => {
        const item = note(34);
        const [stored] = storeXhsNoteRefs([item]);
        const page = pageFor({
            [item.signedUrl]: notePayload(item.signedUrl, { loginWall: true }),
        });

        await expect(command.func(page, { 'note-refs': stored.noteRef })).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
        });
    });

    it('does not count an empty first note as a completed capture before AuthRequired', async () => {
        const notes = [note(35), note(36)];
        const stored = storeXhsNoteRefs(notes);
        const page = pageFor({
            [notes[0].signedUrl]: notePayload(notes[0].signedUrl, { desc: '' }),
            [notes[1].signedUrl]: notePayload(notes[1].signedUrl, { loginWall: true }),
        });

        await expect(command.func(page, {
            'note-refs': stored.map((entry) => entry.noteRef).join(','),
        })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });

    it('waits for an in-flight detail to settle, then soft-times out remaining refs', async () => {
        vi.useFakeTimers();
        try {
            const startedAt = Date.UTC(2030, 0, 2, 3, 4, 5);
            vi.setSystemTime(startedAt);
            const notes = [note(41), note(42), note(43)];
            const stored = storeXhsNoteRefs(notes);
            const page = pageFor({
                [notes[0].signedUrl]: notePayload(notes[0].signedUrl, { desc: '慢速但完整' }),
                [notes[1].signedUrl]: notePayload(notes[1].signedUrl, { securityBlock: true }),
            });
            const originalGoto = page.goto.getMockImplementation();
            let gotoCount = 0;
            page.goto.mockImplementation(async (url) => {
                gotoCount += 1;
                if (gotoCount === 2)
                    await new Promise((resolve) => setTimeout(resolve, 13_000));
                return originalGoto(url);
            });
            page.wait.mockImplementation(async ({ time }) => {
                await new Promise((resolve) => setTimeout(resolve, time * 1000));
            });
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
            const settled = vi.fn();
            const running = command.func(page, {
                'note-refs': stored.map((entry) => entry.noteRef).join(','),
            }).then((value) => {
                settled(value);
                return value;
            });

            await vi.advanceTimersByTimeAsync(5_000);
            expect(settled).not.toHaveBeenCalled();
            expect(page.newTab).toHaveBeenCalledTimes(2);
            expect(Date.now()).toBe(startedAt + 5_000);

            await vi.advanceTimersByTimeAsync(18_000);
            const result = await running;
            expect(Date.now()).toBe(startedAt + 23_000);
            expect(result.map((row) => row.capture_status)).toEqual(['captured', 'timeout', 'timeout']);
            expect(result[0].content).toBe('慢速但完整');
            expect(page.newTab).toHaveBeenCalledTimes(2);
            expect(page.goto).toHaveBeenCalledTimes(2);
            randomSpy.mockRestore();
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('reports invalid and expired refs safely without requiring a browser tab', async () => {
        const [stored] = storeXhsNoteRefs([note(8)], { now: 1000 });
        const expired = await command.func({}, { 'note-refs': stored.noteRef });
        expect(expired[0].capture_status).toBe('expired');

        const invalidRef = 'xhsr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const invalid = await command.func({}, { 'note-refs': invalidRef });
        expect(invalid[0].capture_status).toBe('invalid');
        expect(JSON.stringify([...expired, ...invalid])).not.toContain('xsec_token');
    });

    it('enforces 4000 code points per note and 12000 for the batch', async () => {
        const notes = [note(11), note(12), note(13)];
        const stored = storeXhsNoteRefs(notes);
        const page = pageFor(Object.fromEntries(notes.map((item) => [
            item.signedUrl,
            notePayload(item.signedUrl, { desc: '😀'.repeat(4001) }),
        ])));

        const result = await command.func(page, {
            'note-refs': stored.map((entry) => entry.noteRef).join(','),
        });

        expect(result.every((row) => [...row.content].length === __test__.MAX_NOTE_CONTENT_CODE_POINTS)).toBe(true);
        expect(result.reduce((total, row) => total + [...row.content].length, 0)).toBe(__test__.MAX_BATCH_CONTENT_CODE_POINTS);
        expect(result.every((row) => row.content_truncated)).toBe(true);
    });

    it('strictly validates 1..3 unique high-entropy refs without echoing input', () => {
        const secretInput = 'https://www.xiaohongshu.com/explore/id?xsec_token=do-not-echo';
        for (const raw of ['', secretInput, Array(4).fill('xhsr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').join(',')]) {
            const error = (() => {
                try {
                    __test__.parseNoteRefs(raw);
                }
                catch (caught) {
                    return caught;
                }
            })();
            expect(error.code).toBe('ARGUMENT');
            expect(error.message).not.toContain('xsec_token');
            expect(error.message).not.toContain('do-not-echo');
        }
        const duplicate = 'xhsr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        expect(() => __test__.parseNoteRefs(`${duplicate},${duplicate}`)).toThrow(/duplicates/);
    });
});
