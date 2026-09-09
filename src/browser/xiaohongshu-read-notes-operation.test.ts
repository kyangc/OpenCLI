import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Adapter JavaScript modules intentionally do not ship declarations.
import { command as readNotesCommand } from '../../clis/xiaohongshu/read-notes.js';
// @ts-expect-error Adapter JavaScript modules intentionally do not ship declarations.
import { storeXhsNoteRefs } from '../../clis/xiaohongshu/xhs-ref-store.js';
import { BrowserOperation, type BrowserTeardownReceipt } from './operation.js';

describe('xiaohongshu read-notes BrowserOperation wiring', () => {
  let storeDir: string;
  let previousStoreDir: string | undefined;

  beforeEach(() => {
    previousStoreDir = process.env.OPENCLI_XHS_REF_DIR;
    storeDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'opencli-xhs-operation-'));
    fs.chmodSync(storeDir, 0o700);
    process.env.OPENCLI_XHS_REF_DIR = storeDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousStoreDir === undefined) delete process.env.OPENCLI_XHS_REF_DIR;
    else process.env.OPENCLI_XHS_REF_DIR = previousStoreDir;
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('does not teardown or return until the in-flight detail settles', async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2030, 0, 2, 3, 4, 5);
    vi.setSystemTime(startedAt);
    const notes = [1, 2, 3].map((index) => {
      const noteId = `69c131c9000000002800c00${index}`;
      return {
        signedUrl: `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=private-${index}`,
        canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      };
    });
    const stored = storeXhsNoteRefs(notes);
    let currentUrl = '';
    let gotoCount = 0;
    const page = {
      getActivePage: vi.fn(() => 'anchor-page'),
      newTab: vi.fn(async () => 'detail-page'),
      setActivePage: vi.fn(),
      selectTab: vi.fn(async () => {}),
      closeTab: vi.fn(async () => {}),
      withCommandTimeout() { return this; },
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
        gotoCount += 1;
        if (gotoCount === 2) await new Promise((resolve) => setTimeout(resolve, 13_000));
      }),
      wait: vi.fn(async ({ time }: { time: number }) => {
        await new Promise((resolve) => setTimeout(resolve, time * 1000));
      }),
      evaluate: vi.fn(async () => {
        const isSecond = currentUrl === notes[1].signedUrl;
        return {
          pageUrl: currentUrl,
          securityBlock: isSecond,
          loginWall: false,
          notFound: false,
          title: 'slow note',
          desc: 'settled body',
          author: 'author',
          likes: '1',
          collects: '0',
          comments: '0',
          tags: [],
        };
      }),
    };
    const receipt: BrowserTeardownReceipt = {
      operationId: 'operation-read-notes',
      contextId: 'profile-1',
      surface: 'adapter',
      reason: 'explicit cancellation',
      status: 'verified',
      startedAt: 1,
      completedAt: 2,
      lateCommandsBlocked: true,
      leaseReleased: true,
      targetPages: ['anchor-page', 'detail-page'],
      survivingPages: [],
    };
    const send = vi.fn(async () => {
      return receipt;
    });
    const operation = new BrowserOperation({
      operationId: 'operation-read-notes',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const running = operation.execute(() => readNotesCommand.func!(page as never, {
      'note-refs': stored.map((entry: { noteRef: string }) => entry.noteRef).join(','),
    }));

    // The first detail settles at T+5s. The second then spends 13s in
    // navigation and 5s settling, reaching T+23s. Its 18s risk-control
    // cooldown cannot fit before the private T+25s detail deadline.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).not.toHaveBeenCalled();
    expect(page.newTab).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(startedAt + 5_000);

    await vi.advanceTimersByTimeAsync(17_999);
    expect(send).not.toHaveBeenCalled();
    expect(Date.now()).toBe(startedAt + 22_999);

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await running;
    expect(Date.now()).toBe(startedAt + 23_000);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(outcome.result).toEqual([
      expect.objectContaining({ capture_status: 'captured', content: 'settled body' }),
      expect.objectContaining({ capture_status: 'timeout' }),
      expect.objectContaining({ capture_status: 'timeout' }),
    ]);
    expect(outcome.teardown).toEqual(receipt);
    expect(send).toHaveBeenCalledTimes(1);
    expect(page.wait).toHaveBeenCalledTimes(2);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.newTab).toHaveBeenCalledTimes(2);
    randomSpy.mockRestore();
  });
});
