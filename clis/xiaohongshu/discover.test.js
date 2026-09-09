import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command, __test__ } from './discover.js';
import { command as searchCommand } from './search.js';
import { resolveXhsNoteRefs } from './xhs-ref-store.js';

const SECRET = 'private-xsec-token';

function makePrivateStore() {
    const root = fs.realpathSync.native(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(root, 'opencli-xhs-discover-'));
    fs.chmodSync(dir, 0o700);
    return dir;
}

describe('xiaohongshu discover', () => {
    let storeDir;
    let previousStoreDir;

    beforeEach(() => {
        previousStoreDir = process.env.OPENCLI_XHS_REF_DIR;
        storeDir = makePrivateStore();
        process.env.OPENCLI_XHS_REF_DIR = storeDir;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (previousStoreDir === undefined)
            delete process.env.OPENCLI_XHS_REF_DIR;
        else
            process.env.OPENCLI_XHS_REF_DIR = previousStoreDir;
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('persists signed URLs and returns only the safe discovery whitelist', async () => {
        const noteId = '69c131c9000000002800be4c';
        const signedUrl = `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=${SECRET}&xsec_source=pc_search`;
        vi.spyOn(searchCommand, 'func').mockResolvedValue([{
            rank: 1,
            title: `安全标题 ${signedUrl}`,
            author: '作者',
            likes: '42',
            published_at: '2026-03-23',
            url: signedUrl,
            extra: SECRET,
        }]);

        const result = await command.func({}, { query: '里斯本', limit: 1 });

        expect(searchCommand.func).toHaveBeenCalledWith({}, {
            query: '里斯本',
            limit: 1,
        }, { applyDefaultFilters: false });
        expect(Object.keys(result[0])).toEqual([
            'rank', 'note_ref', 'title', 'author', 'canonical_url', 'published_at', 'likes',
        ]);
        expect(result[0]).toMatchObject({
            rank: 1,
            author: '作者',
            likes: '42',
            published_at: '',
            canonical_url: `https://www.xiaohongshu.com/explore/${noteId}`,
        });
        expect(JSON.stringify(result)).not.toContain('xsec_token');
        expect(JSON.stringify(result)).not.toContain(SECRET);
        const resolved = resolveXhsNoteRefs([result[0].note_ref]);
        expect(resolved[0]).toMatchObject({ status: 'active', signedUrl, canonicalUrl: result[0].canonical_url });
    });

    it('enforces a dedicated 1..20 limit without changing search', () => {
        expect(__test__.parseDiscoverLimit(undefined)).toBe(12);
        expect(__test__.parseDiscoverLimit(20)).toBe(20);
        for (const invalid of [0, 21, 1.5, 'oops'])
            expect(() => __test__.parseDiscoverLimit(invalid)).toThrow(/between 1 and 20/);
    });

    it('fails safely when the private store is not configured', async () => {
        delete process.env.OPENCLI_XHS_REF_DIR;
        const noteId = '69c131c9000000002800be4c';
        vi.spyOn(searchCommand, 'func').mockResolvedValue([{
            title: '标题', author: '作者', likes: '1',
            url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${SECRET}`,
        }]);

        const error = await command.func({}, { query: 'test', limit: 1 }).catch((caught) => caught);
        expect(error.code).toBe('CONFIG');
        expect(`${error.message} ${error.hint}`).not.toContain(SECRET);
        expect(`${error.message} ${error.hint}`).not.toContain('xsec_token');
    });

    it('replaces an upstream signed-URL error with a safe provider error', async () => {
        vi.spyOn(searchCommand, 'func').mockRejectedValue(
            new Error(`failed at https://www.xiaohongshu.com/explore/id?xsec_token=${SECRET}`),
        );
        const error = await command.func({}, { query: 'test', limit: 1 }).catch((caught) => caught);
        expect(error.code).toBe('COMMAND_EXEC');
        expect(error.message).not.toContain('xsec_token');
        expect(error.message).not.toContain(SECRET);
    });
});
