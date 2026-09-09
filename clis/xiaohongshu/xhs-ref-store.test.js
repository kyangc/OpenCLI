import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    XHS_REF_MAX_ENTRIES,
    XHS_REF_PATTERN,
    XHS_REF_TTL_MS,
    resolveXhsNoteRefs,
    storeXhsNoteRefs,
} from './xhs-ref-store.js';

function note(index = 1) {
    const noteId = (BigInt('0x69c131c9000000002800be00') + BigInt(index)).toString(16).padStart(24, '0');
    return {
        signedUrl: `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=secret-${index}`,
        canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    };
}

function makePrivateStore() {
    const root = fs.realpathSync.native(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(root, 'opencli-xhs-store-'));
    fs.chmodSync(dir, 0o700);
    return dir;
}

describe('xiaohongshu opaque ref store', () => {
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

    it('persists a high-entropy ref that another process can resolve', () => {
        const moduleUrl = new URL('./xhs-ref-store.js', import.meta.url).href;
        const script = `
          import { storeXhsNoteRefs } from ${JSON.stringify(moduleUrl)};
          const stored = storeXhsNoteRefs([${JSON.stringify(note(7))}], { now: 1000 });
          process.stdout.write(stored[0].noteRef);
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
            encoding: 'utf8',
            env: { ...process.env, OPENCLI_XHS_REF_DIR: storeDir },
        });
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout).toMatch(XHS_REF_PATTERN);
        expect(resolveXhsNoteRefs([child.stdout], { now: 1001 })[0]).toMatchObject({
            status: 'active',
            signedUrl: note(7).signedUrl,
            canonicalUrl: note(7).canonicalUrl,
        });
        const fileMode = fs.statSync(path.join(storeDir, `${child.stdout}.json`)).mode & 0o777;
        expect(fileMode).toBe(0o600);
    });

    it('distinguishes expired from invalid and cleans expired refs on access', () => {
        const [stored] = storeXhsNoteRefs([note(2)], { now: 5000 });
        expect(resolveXhsNoteRefs([stored.noteRef], { now: 5000 + XHS_REF_TTL_MS })[0].status).toBe('expired');
        expect(resolveXhsNoteRefs([stored.noteRef], { now: 5000 + XHS_REF_TTL_MS + 1 })[0].status).toBe('invalid');
    });

    it('keeps at most 200 live entries across sequential writes', () => {
        for (let batch = 0; batch < 11; batch += 1) {
            storeXhsNoteRefs(Array.from({ length: 20 }, (_, index) => note(batch * 20 + index + 1)), {
                now: 10_000 + batch,
            });
        }
        expect(fs.readdirSync(storeDir).filter((name) => XHS_REF_PATTERN.test(name.replace(/\.json$/, ''))))
            .toHaveLength(XHS_REF_MAX_ENTRIES);
    });

    it('rejects an unsafe directory without leaking secret input', () => {
        fs.chmodSync(storeDir, 0o755);
        const error = (() => {
            try {
                storeXhsNoteRefs([note(3)]);
            }
            catch (caught) {
                return caught;
            }
        })();
        expect(error.code).toBe('CONFIG');
        expect(`${error.message} ${error.hint}`).not.toContain('secret-3');
        expect(`${error.message} ${error.hint}`).not.toContain('xsec_token');
    });

    it('rejects a symlinked store directory', () => {
        const symlinkPath = `${storeDir}-link`;
        fs.symlinkSync(storeDir, symlinkPath);
        process.env.OPENCLI_XHS_REF_DIR = symlinkPath;
        try {
            expect(() => storeXhsNoteRefs([note(4)])).toThrow(/without symlink traversal/);
        }
        finally {
            fs.unlinkSync(symlinkPath);
        }
    });
});
