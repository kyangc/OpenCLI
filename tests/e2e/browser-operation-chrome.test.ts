/**
 * Browser operation lifecycle E2E — real daemon + real MV3 extension + headed Chrome.
 *
 * The synthetic page never finishes Runtime.evaluate and emits a local heartbeat
 * while the command is still driving it. The observable contract is that an
 * ephemeral operation reaches one physical terminal state: its target disappears
 * from inventory and the page stops running, while an unrelated persistent lease
 * remains available.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const DAEMON_ENTRY = path.join(ROOT, 'dist', 'src', 'daemon.js');
const PORT = 19825;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { 'X-OpenCLI': '1', 'Content-Type': 'application/json' };

type WireResult = {
  id?: string;
  ok: boolean;
  data?: unknown;
  page?: string;
  error?: string;
  errorCode?: string;
  teardown?: TeardownReceipt;
};

type TeardownReceipt = {
  operationId: string;
  contextId: string;
  surface: 'browser' | 'adapter';
  reason: string;
  status: 'verified' | 'incomplete';
  startedAt: number;
  completedAt: number;
  lateCommandsBlocked: boolean;
  leaseReleased: boolean;
  targetPages: string[];
  survivingPages: string[];
};

type BrowserInventory = {
  capturedAt: number;
  contextId: string;
  windows: Array<{ id: number; role: 'interactive' | 'automation' | 'user' }>;
  tabs: Array<{
    page?: string;
    windowId: number;
    active: boolean;
    url?: string;
    lease?: { operationId: string; page?: string };
  }>;
  leases: Array<{ operationId: string; page?: string; lifecycle: string }>;
};

type DaemonStatus = {
  profiles?: Array<{ contextId?: string }>;
};

type TestSite = {
  operationUrl: string;
  persistentUrl: string;
  tickUrl: string;
  tickCount: () => number;
  close: () => Promise<void>;
};

let nextCommandId = 0;

function commandId(label: string): string {
  return `browser-operation-e2e-${process.pid}-${label}-${++nextCommandId}`;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

async function getStatus(): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`${BASE}/status`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    return await res.json() as DaemonStatus;
  } catch {
    return null;
  }
}

async function postCommand(
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<{ status: number; result: WireResult }> {
  const res = await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, result: await res.json() as WireResult };
}

function findChromeExecutable(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((entry): entry is string => !!entry);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const binary of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const resolved = spawnSync('which', [binary], { encoding: 'utf8' });
    const found = resolved.stdout.trim();
    if (resolved.status === 0 && found) return found;
  }
  return null;
}

function launchChrome(chromePath: string, userDataDir: string): ChildProcess {
  return spawn(chromePath, [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--no-sandbox',
    '--window-size=1280,720',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function startTestSite(): Promise<TestSite> {
  let ticks = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/tick') {
      ticks++;
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${url.pathname.slice(1)}</title><main>${url.pathname}</main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Synthetic site did not bind a port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    operationUrl: `${origin}/operation`,
    persistentUrl: `${origin}/persistent`,
    tickUrl: `${origin}/tick`,
    tickCount: () => ticks,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    },
  };
}

describe('browser operation lifecycle (real headed Chrome)', () => {
  let daemon: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let site: TestSite | null = null;
  let contextId = '';
  let userDataDir = '';
  let daemonStderr = '';
  let chromeStderr = '';

  beforeAll(async () => {
    if (await getStatus()) {
      throw new Error(`Port ${PORT} is already in use; stop the local OpenCLI daemon before this isolated E2E gate`);
    }

    daemon = spawn(process.execPath, [DAEMON_ENTRY], { stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr?.on('data', (chunk) => {
      daemonStderr += chunk.toString();
      if (daemonStderr.length > 20_000) daemonStderr = daemonStderr.slice(-20_000);
    });
    await waitFor(async () => (await getStatus()) !== null, 10_000, 'Real daemon did not start');
    // A developer's already-open Browser Bridge reconnects on a bounded 5s
    // backoff. Let those profiles settle before launching the temporary Chrome,
    // otherwise an existing profile can be mistaken for this test's fresh one.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const baselineProfiles = new Set(
      ((await getStatus())?.profiles ?? [])
        .map((profile) => profile.contextId)
        .filter((id): id is string => typeof id === 'string'),
    );

    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('Chrome executable not found');
    site = await startTestSite();
    let lastConnectError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      contextId = '';
      chromeStderr = '';
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-browser-operation-'));
      chrome = launchChrome(chromePath, userDataDir);
      chrome.stderr?.on('data', (chunk) => {
        chromeStderr += chunk.toString();
        if (chromeStderr.length > 20_000) chromeStderr = chromeStderr.slice(-20_000);
      });

      try {
        await waitFor(async () => {
          const profiles = (await getStatus())?.profiles ?? [];
          const fresh = profiles.find((profile) =>
            typeof profile.contextId === 'string' && !baselineProfiles.has(profile.contextId));
          if (!fresh?.contextId) return false;
          contextId = fresh.contextId;
          return true;
        }, 30_000, () => `Temporary MV3 profile did not connect (attempt ${attempt}/2)\nDaemon stderr:\n${daemonStderr}\nChrome stderr:\n${chromeStderr}`);
        lastConnectError = undefined;
        break;
      } catch (err) {
        lastConnectError = err;
        await stopProcess(chrome);
        chrome = null;
        fs.rmSync(userDataDir, { recursive: true, force: true });
        userDataDir = '';
      }
    }
    if (lastConnectError) throw lastConnectError;
  }, 100_000);

  afterAll(async () => {
    await stopProcess(chrome);
    await site?.close();
    try {
      await fetch(`${BASE}/shutdown`, {
        method: 'POST',
        headers: HEADERS,
        signal: AbortSignal.timeout(2_000),
      });
    } catch { /* daemon may already be gone */ }
    await stopProcess(daemon);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  }, 20_000);

  it('tears down a timed-out ephemeral operation without touching a persistent lease', async () => {
    expect(site).toBeTruthy();
    expect(contextId).not.toBe('');
    const operationSession = `operation-${process.pid}`;
    const persistentSession = `persistent-${process.pid}`;
    const common = { contextId, surface: 'adapter' as const, windowMode: 'background' as const };

    try {
      const persistent = await postCommand({
        id: commandId('persistent-navigate'),
        action: 'navigate',
        session: persistentSession,
        siteSession: 'persistent',
        url: site!.persistentUrl,
        ...common,
      });
      expect(persistent.status).toBe(200);
      expect(persistent.result.ok, persistent.result.error).toBe(true);

      const operation = await postCommand({
        id: commandId('operation-navigate'),
        action: 'navigate',
        session: operationSession,
        siteSession: 'ephemeral',
        url: site!.operationUrl,
        ...common,
      });
      expect(operation.status).toBe(200);
      expect(operation.result.ok, operation.result.error).toBe(true);
      expect(operation.result.page).toBeTruthy();

      const deadlineAt = Date.now() + 11_500;
      const timedOut = await postCommand({
        id: commandId('operation-exec'),
        action: 'exec',
        session: operationSession,
        siteSession: 'ephemeral',
        page: operation.result.page,
        code: `setInterval(() => fetch(${JSON.stringify(site!.tickUrl)}, { method: 'POST' }).catch(() => {}), 50); new Promise(() => {})`,
        timeout: 11.5,
        deadlineAt,
        ...common,
      });
      expect(timedOut.status).toBe(200);
      expect(timedOut.result).toEqual(expect.objectContaining({
        ok: false,
        errorCode: 'cdp_timeout',
      }));
      await waitFor(() => site!.tickCount() >= 3, 1_000, 'Synthetic operation never began driving the page');
      const ticksAtTerminal = site!.tickCount();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const inventoryResult = await postCommand({
        id: commandId('full-inventory'),
        action: 'inventory',
        contextId,
      });
      const diagnosticSessionTabs = await postCommand({
        id: commandId('diagnostic-session-tabs'),
        action: 'tabs',
        op: 'list',
        session: operationSession,
        siteSession: 'ephemeral',
        ...common,
      });
      const ticksAfterTeardown = site!.tickCount();
      const redEvidence = JSON.stringify({
        teardown: timedOut.result.teardown,
        fullInventory: inventoryResult.result,
        diagnosticSessionTabs: diagnosticSessionTabs.result,
        ticksAtTerminal,
        ticksAfterTeardown,
      });

      expect(timedOut.result.teardown, redEvidence).toEqual(expect.objectContaining({
        operationId: operationSession,
        contextId,
        surface: 'adapter',
        status: 'verified',
        lateCommandsBlocked: true,
        leaseReleased: true,
        targetPages: [operation.result.page],
        survivingPages: [],
      }));
      expect(inventoryResult.result.ok, redEvidence).toBe(true);
      const inventory = inventoryResult.result.data as BrowserInventory;

      expect(inventory.leases.some((lease) => lease.operationId === operationSession), JSON.stringify({
        inventory,
        ticksAtTerminal,
        ticksAfterTeardown,
      })).toBe(false);
      expect(inventory.tabs.some((tab) => tab.page === operation.result.page)).toBe(false);
      expect(ticksAfterTeardown).toBe(ticksAtTerminal);
      expect(inventory.leases).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operationId: persistentSession,
          lifecycle: 'persistent',
          page: persistent.result.page,
        }),
      ]));
      expect(inventory.tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          page: persistent.result.page,
          url: site!.persistentUrl,
          lease: expect.objectContaining({ operationId: persistentSession }),
        }),
      ]));
      expect(inventory.windows).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'automation' }),
      ]));
    } finally {
      await postCommand({
        id: commandId('operation-cleanup'),
        action: 'operation-cancel',
        session: operationSession,
        siteSession: 'ephemeral',
        ...common,
      }).catch(() => undefined);
      await postCommand({
        id: commandId('persistent-cleanup'),
        action: 'close-window',
        session: persistentSession,
        siteSession: 'persistent',
        ...common,
      }).catch(() => undefined);
    }
  }, 35_000);
});
