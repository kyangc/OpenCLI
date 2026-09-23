import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const TTL = 7 * 86400_000;
export function translationKey(scope, post) {
    return createHash('sha256').update(JSON.stringify(['x-api-v1', scope, post.id, post.text, post.lang, 'zh-CN'])).digest('hex');
}
export class TranslationCache {
    constructor(directory = path.join(process.env.OPENCLI_CONFIG_DIR || path.join(homedir(), '.opencli'), 'cache', 'x-translations')) { this.directory = directory; }
    async get(key, now = Date.now()) {
        try {
            const row = JSON.parse(await readFile(path.join(this.directory, key + '.json'), 'utf8'));
            const t = row.value;
            if (row.expires <= now || t?.status !== 'translated' || t.target_lang !== 'zh-CN' || typeof t.text !== 'string' || !t.text.trim()) return null;
            return t;
        } catch { return null; }
    }
    async set(key, value, now = Date.now()) {
        if (value.status !== 'translated' || value.completeness === 'partial') return;
        let temporary;
        try {
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            const entries = await readdir(this.directory);
            const files = (await Promise.all(entries.filter(f => f.endsWith('.json')).map(async f => {
                try { return { f, mtime: (await stat(path.join(this.directory, f))).mtimeMs }; } catch { return null; }
            }))).filter(Boolean).sort((a, b) => a.mtime - b.mtime);
            for (const entry of files.filter((f, i) => f.mtime < now - TTL || i < files.length - 511)) await unlink(path.join(this.directory, entry.f)).catch(() => {});
            temporary = path.join(this.directory, key + '.' + randomUUID() + '.tmp');
            const encoded = JSON.stringify({ expires: now + TTL, value });
            if (Buffer.byteLength(encoded) > 300000) return;
            await writeFile(temporary, encoded, { mode: 0o600 });
            await rename(temporary, path.join(this.directory, key + '.json'));
        } catch { if (temporary) await unlink(temporary).catch(() => {}); /* Cache errors must not fail a read. */ }
    }
}
