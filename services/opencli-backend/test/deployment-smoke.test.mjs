import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const smokeScript = fileURLToPath(new URL('../scripts/smoke-deployment.mjs', import.meta.url));

test('deployment smoke waits for a ready idle bridge using read-only health probes', async () => {
  const requests = [];
  let readinessChecks = 0;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health/live') {
      response.end(JSON.stringify({ status: 'alive' }));
      return;
    }

    readinessChecks += 1;
    const ready = readinessChecks > 1;
    response.statusCode = ready ? 200 : 503;
    response.end(JSON.stringify({
      status: ready ? 'ready' : 'not_ready',
      bridge: {
        ready,
        daemon: ready ? 'running' : 'starting',
        daemonVersion: '2.0.1',
        extensionConnected: ready,
        extensionVersion: '2.0.0',
        profileCount: ready ? 1 : 0,
        pendingCommands: 0,
      },
      queue: {
        paused: false,
        activeCount: 0,
        drained: true,
      },
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      smokeScript,
      '--base-url', `http://127.0.0.1:${address.port}`,
      '--expected-daemon-version', '2.0.1',
      '--expected-extension-version', '2.0.0',
      '--timeout-seconds', '2',
      '--poll-interval-ms', '10',
    ]);

    assert.deepEqual(JSON.parse(stdout), {
      status: 'passed',
      daemonVersion: '2.0.1',
      extensionVersion: '2.0.0',
      profileCount: 1,
      pendingCommands: 0,
      activeCount: 0,
      queuedCount: 0,
      drained: true,
    });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      'GET /health/live',
      'GET /health/ready',
      'GET /health/ready',
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('deployment smoke fails while any queued work could start after release', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health/live') {
      response.end(JSON.stringify({ status: 'alive' }));
      return;
    }
    response.end(JSON.stringify({
      status: 'ready',
      bridge: {
        ready: true,
        daemonVersion: '2.0.0',
        extensionConnected: true,
        extensionVersion: '2.0.0',
        profileCount: 1,
        pendingCommands: 0,
      },
      queue: {
        paused: false,
        activeCount: 0,
        drained: true,
        counts: { queued: 1 },
      },
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        smokeScript,
        '--base-url', `http://127.0.0.1:${address.port}`,
        '--expected-daemon-version', '2.0.0',
        '--expected-extension-version', '2.0.0',
        '--timeout-seconds', '0.05',
        '--poll-interval-ms', '10',
      ]),
      /deployment smoke failed/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
