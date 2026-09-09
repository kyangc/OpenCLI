import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigError } from '@jackwener/opencli/errors';

export const XHS_REF_TTL_MS = 30 * 60 * 1000;
export const XHS_REF_MAX_ENTRIES = 200;
export const XHS_REF_PATTERN = /^xhsr_[A-Za-z0-9_-]{43}$/;

const REF_FILE_PATTERN = /^(xhsr_[A-Za-z0-9_-]{43})\.json$/;
const PROVIDER_SCOPE = 'xiaohongshu:backend-provider:v1';

function unavailable(reason) {
    throw new ConfigError(
        `Xiaohongshu note refs are unavailable: ${reason}`,
        'Set OPENCLI_XHS_REF_DIR to an existing, private (0700), absolute directory owned by this process.',
    );
}

function isOwnedByProcess(stat) {
    return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function requireStoreDir() {
    const configured = process.env.OPENCLI_XHS_REF_DIR;
    if (!configured)
        unavailable('OPENCLI_XHS_REF_DIR is not configured.');
    if (!path.isAbsolute(configured))
        unavailable('OPENCLI_XHS_REF_DIR must be absolute.');

    const storeDir = path.resolve(configured);
    let stat;
    let real;
    try {
        stat = fs.lstatSync(storeDir);
        real = fs.realpathSync.native(storeDir);
    }
    catch {
        unavailable('the configured directory does not exist or cannot be inspected.');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== storeDir)
        unavailable('the configured path must be a real directory without symlink traversal.');
    if ((stat.mode & 0o777) !== 0o700 || !isOwnedByProcess(stat))
        unavailable('the configured directory must be owned by this process with mode 0700.');
    return storeDir;
}

function parseSignedNoteUrl(value) {
    try {
        const parsed = new URL(value);
        const match = parsed.pathname.match(/^\/(?:search_result|explore|note)\/([0-9a-f]{24})\/?$/i);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'www.xiaohongshu.com' ||
            parsed.username || parsed.password || parsed.hash || !match ||
            !parsed.searchParams.get('xsec_token')?.trim()) {
            return null;
        }
        return { noteId: match[1].toLowerCase(), url: parsed.toString() };
    }
    catch {
        return null;
    }
}

function parseCanonicalNoteUrl(value) {
    try {
        const parsed = new URL(value);
        const match = parsed.pathname.match(/^\/explore\/([0-9a-f]{24})\/?$/i);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'www.xiaohongshu.com' ||
            parsed.username || parsed.password || parsed.search || parsed.hash || !match) {
            return null;
        }
        return { noteId: match[1].toLowerCase(), url: `https://www.xiaohongshu.com/explore/${match[1].toLowerCase()}` };
    }
    catch {
        return null;
    }
}

function requireSafeRecordFile(stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !isOwnedByProcess(stat))
        unavailable('the ref store contains an unsafe entry.');
}

function readRecord(storeDir, fileName) {
    const filePath = path.join(storeDir, fileName);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
        requireSafeRecordFile(fs.fstatSync(fd));
        const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
        const signed = parseSignedNoteUrl(record?.signedUrl);
        const canonical = parseCanonicalNoteUrl(record?.canonicalUrl);
        if (record?.version !== 1 || record?.ref !== fileName.slice(0, -5) ||
            record?.providerScope !== PROVIDER_SCOPE || record?.profileBinding !== null || !signed || !canonical ||
            signed.noteId !== canonical.noteId || !Number.isSafeInteger(record?.createdAt) ||
            !Number.isSafeInteger(record?.expiresAt) || record.expiresAt - record.createdAt !== XHS_REF_TTL_MS) {
            unavailable('the ref store contains a malformed entry.');
        }
        return record;
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        if (error instanceof ConfigError)
            throw error;
        unavailable('a ref entry could not be read safely.');
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}

function readRecords(storeDir) {
    let names;
    try {
        names = fs.readdirSync(storeDir);
    }
    catch {
        unavailable('the configured directory cannot be read.');
    }
    const records = [];
    for (const name of names) {
        if (!REF_FILE_PATTERN.test(name))
            continue;
        const record = readRecord(storeDir, name);
        if (record)
            records.push({ record, fileName: name });
    }
    return records;
}

function unlinkRecord(storeDir, fileName) {
    try {
        fs.unlinkSync(path.join(storeDir, fileName));
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            unavailable('an obsolete ref entry could not be removed.');
    }
}

function cleanupAndBound(storeDir, records, now, slotsNeeded = 0) {
    // Best-effort capacity bound across independent processes. Atomic per-ref
    // files prevent corruption, but concurrent writers may briefly exceed it.
    const active = [];
    for (const entry of records) {
        if (entry.record.expiresAt <= now)
            unlinkRecord(storeDir, entry.fileName);
        else
            active.push(entry);
    }
    active.sort((a, b) => a.record.createdAt - b.record.createdAt || a.fileName.localeCompare(b.fileName));
    const keep = Math.max(0, XHS_REF_MAX_ENTRIES - slotsNeeded);
    while (active.length > keep) {
        const oldest = active.shift();
        unlinkRecord(storeDir, oldest.fileName);
    }
    return active;
}

function writeRecord(storeDir, record) {
    const target = path.join(storeDir, `${record.ref}.json`);
    const temporary = path.join(storeDir, `.xhs-ref-${record.ref}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, target);
    }
    catch {
        if (fd !== undefined)
            fs.closeSync(fd);
        try {
            fs.unlinkSync(temporary);
        }
        catch {
            // Best-effort cleanup of a private temporary file.
        }
        unavailable('a ref entry could not be written atomically.');
    }
}

export function isXhsNoteRef(value) {
    return typeof value === 'string' && XHS_REF_PATTERN.test(value);
}

export function assertXhsRefStoreAvailable({ now = Date.now() } = {}) {
    const storeDir = requireStoreDir();
    cleanupAndBound(storeDir, readRecords(storeDir), now);
}

export function storeXhsNoteRefs(notes, { now = Date.now() } = {}) {
    if (!Array.isArray(notes) || notes.length < 1 || notes.length > 20)
        unavailable('a discovery batch must contain between 1 and 20 notes.');
    const normalized = notes.map((note) => {
        const signed = parseSignedNoteUrl(note?.signedUrl);
        const canonical = parseCanonicalNoteUrl(note?.canonicalUrl);
        if (!signed || !canonical || signed.noteId !== canonical.noteId)
            unavailable('discovery returned a note without a valid signed binding.');
        return { signedUrl: signed.url, canonicalUrl: canonical.url };
    });

    const storeDir = requireStoreDir();
    cleanupAndBound(storeDir, readRecords(storeDir), now, normalized.length);
    const stored = normalized.map((note) => {
        const ref = `xhsr_${crypto.randomBytes(32).toString('base64url')}`;
        const record = {
            version: 1,
            ref,
            signedUrl: note.signedUrl,
            canonicalUrl: note.canonicalUrl,
            // OpenCLI currently exposes one fixed backend browser provider scope.
            // This is deliberately not presented as per-user or multi-tenant binding.
            providerScope: PROVIDER_SCOPE,
            profileBinding: null,
            createdAt: now,
            expiresAt: now + XHS_REF_TTL_MS,
        };
        writeRecord(storeDir, record);
        return { noteRef: ref, canonicalUrl: record.canonicalUrl, expiresAt: record.expiresAt };
    });
    cleanupAndBound(storeDir, readRecords(storeDir), now);
    return stored;
}

export function resolveXhsNoteRefs(refs, { now = Date.now() } = {}) {
    if (!Array.isArray(refs) || refs.some((ref) => !isXhsNoteRef(ref)))
        unavailable('one or more refs have an invalid format.');
    const storeDir = requireStoreDir();
    const records = readRecords(storeDir);
    const byRef = new Map(records.map((entry) => [entry.record.ref, entry.record]));
    const resolved = refs.map((ref) => {
        const record = byRef.get(ref);
        if (!record)
            return { noteRef: ref, status: 'invalid' };
        if (record.expiresAt <= now)
            return { noteRef: ref, status: 'expired' };
        return {
            noteRef: ref,
            status: 'active',
            signedUrl: record.signedUrl,
            canonicalUrl: record.canonicalUrl,
        };
    });
    cleanupAndBound(storeDir, records, now);
    return resolved;
}
