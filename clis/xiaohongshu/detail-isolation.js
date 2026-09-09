import { CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { command as noteCommand } from './note.js';
import { noteUrlInfo } from './search.js';

const DETAIL_OPERATION_TIMEOUT_SECONDS = 10;

export function fieldsFrom(rows) {
    if (!Array.isArray(rows))
        return {};
    return Object.fromEntries(rows
        .filter((row) => row && typeof row === 'object' &&
            typeof row.field === 'string' && typeof row.value === 'string')
        .map((row) => [row.field, row.value]));
}

export function sanitizedText(value, limit = Number.POSITIVE_INFINITY) {
    if (typeof value !== 'string')
        return '';
    const sanitized = value
        .replace(/\0/g, '')
        .replace(/https?:\/\/\S+/giu, '[链接已移除]')
        .replace(/\bxsec_token\b(?:\s*[=:]\s*[^\s&]+)?/giu, '[令牌已移除]')
        .replace(/\s+/gu, ' ')
        .trim();
    return [...sanitized].slice(0, limit).join('').trim();
}

export function boundedSanitizedText(value, limit) {
    const sanitized = sanitizedText(value);
    const codePoints = [...sanitized];
    return {
        text: codePoints.slice(0, limit).join('').trim(),
        truncated: codePoints.length > limit,
    };
}

export function canonicalNoteUrl(value) {
    const noteId = noteUrlInfo(value, 'www.xiaohongshu.com').key;
    return noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : '';
}

export function boundedBrowserPage(page, timeoutSeconds = DETAIL_OPERATION_TIMEOUT_SECONDS, commandName = 'Xiaohongshu note reader') {
    if (typeof page.getActivePage !== 'function' || typeof page.newTab !== 'function' ||
        typeof page.setActivePage !== 'function' || typeof page.closeTab !== 'function' ||
        typeof page.selectTab !== 'function' || typeof page.withCommandTimeout !== 'function') {
        throw new CommandExecutionError(
            `${commandName} requires Browser Bridge tab isolation for bounded detail reads.`,
        );
    }
    return page.withCommandTimeout(timeoutSeconds);
}

export function requireActivePage(page, commandName = 'Xiaohongshu note reader') {
    const activePage = page.getActivePage();
    if (!activePage) {
        throw new CommandExecutionError(
            `${commandName} cannot identify its anchor page for detail isolation.`,
        );
    }
    return activePage;
}

export async function ensureIsolatedAnchor(page, commandName = 'Xiaohongshu note reader') {
    const activePage = page.getActivePage?.();
    if (activePage)
        return { page: activePage, created: false };
    const tabControl = boundedBrowserPage(page, DETAIL_OPERATION_TIMEOUT_SECONDS, commandName);
    const anchorPage = await tabControl.newTab();
    if (!anchorPage)
        throw new CommandExecutionError(`${commandName} could not create an isolated anchor page.`);
    page.setActivePage(anchorPage);
    tabControl.setActivePage(anchorPage);
    await tabControl.selectTab(anchorPage);
    return { page: anchorPage, created: true };
}

export async function withDetailDeadline(readPromise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            readPromise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(
                    'xiaohongshu note detail',
                    Math.max(1, Math.ceil(timeoutMs / 1000)),
                    'The stalled note was skipped so the remaining notes could still be read.',
                )), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}

export async function readIsolatedDetail(page, anchorPage, signedUrl, commandName = 'Xiaohongshu note reader', internalOptions = {}) {
    const operationTimeoutSeconds = () => {
        if (!Number.isFinite(internalOptions.deadlineAt))
            return DETAIL_OPERATION_TIMEOUT_SECONDS;
        const remainingSeconds = (internalOptions.deadlineAt - Date.now()) / 1000;
        if (remainingSeconds <= 0)
            throw new TimeoutError('xiaohongshu note detail deadline', 50);
        return Math.min(DETAIL_OPERATION_TIMEOUT_SECONDS, remainingSeconds);
    };
    let tabControl = boundedBrowserPage(page, operationTimeoutSeconds(), commandName);
    const detailPage = await tabControl.newTab();
    if (!detailPage) {
        throw new CommandExecutionError(
            `${commandName} could not create an isolated detail page.`,
        );
    }
    try {
        tabControl = boundedBrowserPage(page, operationTimeoutSeconds(), commandName);
        await tabControl.selectTab(anchorPage);
        const detailHandle = boundedBrowserPage(tabControl, operationTimeoutSeconds(), commandName);
        detailHandle.setActivePage(detailPage);
        return await noteCommand.func(detailHandle, {
            'note-id': signedUrl,
        }, { includePageUrl: true, ...internalOptions });
    }
    finally {
        tabControl.setActivePage(anchorPage);
        await tabControl.selectTab(anchorPage);
        await tabControl.closeTab(detailPage);
    }
}

export function isBoundedTransportFailure(error) {
    let current = error;
    const seen = new Set();
    while (current && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
        seen.add(current);
        if (current.code === 'command_result_unknown' || current.code === 'cdp_timeout')
            return true;
        current = current.cause;
    }
    return false;
}
