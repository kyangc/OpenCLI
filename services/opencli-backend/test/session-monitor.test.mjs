import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandCatalog } from '../src/command-catalog.mjs';
import { JobStore } from '../src/store.mjs';
import { JobService } from '../src/service.mjs';
import { SessionMonitor } from '../src/session-monitor.mjs';
import { closeServer, createApiServer, listen } from '../src/http-server.mjs';

class SessionExecutor {
  async execute(job, { onSpawn }) {
    onSpawn({ cancel() {} });
    return {
      exitCode: job.request.site === 'twitter' ? 77 : 0,
      signal: null,
      stdout: job.request.site === 'twitter' ? '' : '{"loggedIn":true}',
      stderr: '',
      outputTruncated: false,
      durationMs: 1,
      timedOut: false,
      cancelRequested: false,
      spawnError: null,
    };
  }
}

test('probes configured site sessions through the queue and reports login state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-sessions-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([
    {
      site: 'xiaohongshu', name: 'whoami', access: 'read', browser: true,
      siteSession: 'persistent', args: [],
    },
    {
      site: 'twitter', name: 'whoami', access: 'read', browser: true,
      siteSession: 'persistent', args: [],
    },
  ]);
  const service = new JobService({
    store, executor: new SessionExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const monitor = new SessionMonitor({
    sites: new Set(['xiaohongshu', 'twitter']),
    catalog,
    store,
    service,
    defaultTimeoutSeconds: 30,
    intervalMs: 15 * 60 * 1000,
  });
  const config = {
    apiToken: 'admin-token-with-at-least-24-characters',
    allowedCommands: new Set(),
    deniedArguments: new Set(),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config, catalog, store, service, sessionMonitor: monitor,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  try {
    await monitor.checkNow();
    await service.waitForIdle();

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/sessions`, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.sessions.map(({ site, state }) => ({ site, state })), [
      { site: 'twitter', state: 'needs_login' },
      { site: 'xiaohongshu', state: 'authenticated' },
    ]);
    assert.equal(JSON.stringify(payload).includes('loggedIn'), false);

    const readiness = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(JSON.stringify(await readiness.json()).includes('twitter'), false);

    const metrics = await fetch(`http://127.0.0.1:${address.port}/metrics`, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    const metricsBody = await metrics.text();
    assert.match(metricsBody, /opencli_backend_session_state\{site="twitter",state="needs_login"\} 1/);
    assert.match(metricsBody, /opencli_backend_session_state\{site="xiaohongshu",state="authenticated"\} 1/);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});
