import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, TimeoutError } from '@jackwener/opencli/errors';
import {
    boundedSanitizedText,
    ensureIsolatedAnchor,
    fieldsFrom,
    readIsolatedDetail,
    sanitizedText,
} from './detail-isolation.js';
import { isXhsNoteRef, resolveXhsNoteRefs } from './xhs-ref-store.js';

const MAX_NOTE_CONTENT_CODE_POINTS = 4000;
const MAX_BATCH_CONTENT_CODE_POINTS = 12000;
const CAPTURE_BATCH_TIMEOUT_MS = 50_000;
// Isolated-tab cleanup may spend one 10s command budget selecting the anchor
// and another closing the detail tab; keep 5s headroom inside the batch budget.
const DETAIL_CLEANUP_RESERVE_MS = 25_000;
const MIN_DETAIL_START_BUDGET_MS = 10_000;

function parseNoteRefs(raw) {
    if (typeof raw !== 'string')
        throw new ArgumentError('note-refs must be a comma-separated list of 1 to 3 opaque refs.');
    const refs = raw.split(',').map((value) => value.trim());
    if (refs.length < 1 || refs.length > 3 || refs.some((ref) => !isXhsNoteRef(ref)))
        throw new ArgumentError('note-refs must contain 1 to 3 valid opaque refs.');
    if (new Set(refs).size !== refs.length)
        throw new ArgumentError('note-refs must not contain duplicates.');
    return refs;
}

function unavailableCapture(noteRef, captureStatus, canonicalUrl = '') {
    return {
        note_ref: noteRef,
        title: '',
        author: '',
        canonical_url: canonicalUrl,
        content: '',
        content_truncated: false,
        capture_status: captureStatus,
    };
}

function trustedNoteId(value) {
    if (typeof value !== 'string')
        return '';
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'www.xiaohongshu.com' ||
            parsed.username || parsed.password) {
            return '';
        }
        const match = parsed.pathname.match(
            /^\/(?:explore|note|search_result|discovery\/item)\/([0-9a-f]{24})\/?$|^\/user\/profile\/[^/?#]+\/([0-9a-f]{24})\/?$/i,
        );
        return match ? (match[1] || match[2]).toLowerCase() : '';
    }
    catch {
        return '';
    }
}

function matchesResolvedIdentity(pageUrl, canonicalUrl) {
    const actualId = trustedNoteId(pageUrl);
    return Boolean(actualId && actualId === trustedNoteId(canonicalUrl));
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'read-notes',
    access: 'read',
    description: '按短期不透明引用顺序读取最多三篇小红书笔记',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    siteSession: 'ephemeral',
    navigateBefore: false,
    args: [
        { name: 'note-refs', required: true, positional: true, help: 'Comma-separated opaque refs (1-3)' },
    ],
    columns: ['note_ref', 'title', 'author', 'canonical_url', 'content', 'content_truncated', 'capture_status'],
    func: async (page, kwargs) => {
        const deadlineAt = Date.now() + CAPTURE_BATCH_TIMEOUT_MS;
        const detailDeadlineAt = deadlineAt - DETAIL_CLEANUP_RESERVE_MS;
        const refs = parseNoteRefs(kwargs['note-refs']);
        const resolved = resolveXhsNoteRefs(refs);
        const anchorPage = resolved.some((entry) => entry.status === 'active')
            ? (await ensureIsolatedAnchor(page, 'Xiaohongshu read-notes')).page
            : null;
        let remainingBatchCodePoints = MAX_BATCH_CONTENT_CODE_POINTS;
        let completedCapture = false;
        let stopStatus = '';
        const results = [];

        for (const entry of resolved) {
            if (stopStatus) {
                results.push(unavailableCapture(entry.noteRef, stopStatus, entry.canonicalUrl || ''));
                continue;
            }
            if (entry.status !== 'active') {
                results.push(unavailableCapture(entry.noteRef, entry.status));
                continue;
            }
            const remainingMs = detailDeadlineAt - Date.now();
            if (remainingMs < MIN_DETAIL_START_BUDGET_MS) {
                stopStatus = 'timeout';
                results.push(unavailableCapture(entry.noteRef, 'timeout', entry.canonicalUrl));
                continue;
            }
            try {
                // The 50s batch deadline is soft: once a detail read starts, let
                // its bounded browser operations and tab cleanup settle fully.
                // This avoids a detached Promise.race loser in persistent or
                // keep-tab overrides. The next ref is gated by deadlineAt.
                const fields = fieldsFrom(await readIsolatedDetail(
                    page,
                    anchorPage,
                    entry.signedUrl,
                    'Xiaohongshu read-notes',
                    { deadlineAt: detailDeadlineAt },
                ));
                if (!matchesResolvedIdentity(fields.page_url, entry.canonicalUrl)) {
                    results.push(unavailableCapture(entry.noteRef, 'unavailable', entry.canonicalUrl));
                    continue;
                }
                const contentLimit = Math.min(MAX_NOTE_CONTENT_CODE_POINTS, remainingBatchCodePoints);
                const bounded = boundedSanitizedText(fields.content || '', contentLimit);
                remainingBatchCodePoints -= [...bounded.text].length;
                if (bounded.text)
                    completedCapture = true;
                results.push({
                    note_ref: entry.noteRef,
                    title: sanitizedText(fields.title || '', 180),
                    author: sanitizedText(fields.author || '', 120),
                    canonical_url: entry.canonicalUrl,
                    content: bounded.text,
                    content_truncated: bounded.truncated,
                    capture_status: bounded.text ? 'captured' : 'empty',
                });
            }
            catch (error) {
                if (error instanceof AuthRequiredError) {
                    if (!completedCapture)
                        throw error;
                    stopStatus = 'login_required';
                    results.push(unavailableCapture(entry.noteRef, stopStatus, entry.canonicalUrl));
                    continue;
                }
                if (error instanceof TimeoutError) {
                    // Do not start another detail read while this one may still be
                    // navigating. Returning lets the ephemeral BrowserOperation
                    // perform verified cancellation and block late commands.
                    stopStatus = 'timeout';
                    results.push(unavailableCapture(entry.noteRef, stopStatus, entry.canonicalUrl));
                    continue;
                }
                results.push(unavailableCapture(entry.noteRef, 'unavailable', entry.canonicalUrl));
            }
        }
        return results;
    },
});

export const __test__ = {
    parseNoteRefs,
    MAX_NOTE_CONTENT_CODE_POINTS,
    MAX_BATCH_CONTENT_CODE_POINTS,
    CAPTURE_BATCH_TIMEOUT_MS,
    matchesResolvedIdentity,
};
