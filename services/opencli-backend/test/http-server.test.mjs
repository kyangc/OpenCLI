import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobStore } from '../src/store.mjs';
import { JobService } from '../src/service.mjs';
import { closeServer, createApiServer, listen } from '../src/http-server.mjs';
import { CommandCatalog } from '../src/command-catalog.mjs';

class ImmediateExecutor {
  async execute(_job, { onSpawn }) {
    onSpawn({ cancel() {} });
    return {
      exitCode: 0,
      signal: null,
      stdout: '[{"title":"example"}]',
      stderr: '',
      outputTruncated: false,
      durationMs: 1,
      timedOut: false,
      cancelRequested: false,
      spawnError: null,
    };
  }
}

class CancellableExecutor {
  async execute(_job, { onSpawn }) {
    return new Promise((resolve) => {
      onSpawn({
        cancel: () => resolve({
          exitCode: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
          outputTruncated: false,
          durationMs: 1,
          timedOut: false,
          cancelRequested: true,
          spawnError: null,
        }),
      });
    });
  }
}

test('protects job APIs and preserves idempotency through HTTP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', access: 'read', browser: false, siteSession: null,
    args: [{ name: 'limit', type: 'int', required: false, positional: false, choices: [] }],
  }]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(['hackernews.top']),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config,
    catalog,
    store,
    service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ site: 'hackernews', command: 'top', args: ['--limit', '1'] });
  try {
    const unauthorized = await fetch(`${base}/v1/jobs`, { method: 'POST', body });
    assert.equal(unauthorized.status, 401);

    const headers = {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'http-test-1',
    };
    const first = await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body });
    const firstPayload = await first.json();
    assert.equal(first.status, 202);

    const duplicate = await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body });
    const duplicatePayload = await duplicate.json();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicatePayload.job.id, firstPayload.job.id);

    await service.waitForIdle();
    const result = await fetch(`${base}/v1/jobs/${firstPayload.job.id}/result`, { headers });
    const resultPayload = await result.json();
    assert.equal(resultPayload.status, 'succeeded');
    assert.deepEqual(resultPayload.output, [{ title: 'example' }]);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('queues allowlisted site session checks through the job service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-session-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([
    { site: 'xiaohongshu', name: 'whoami', access: 'read', browser: true, siteSession: 'persistent', args: [] },
    { site: 'twitter', name: 'whoami', access: 'read', browser: true, siteSession: 'persistent', args: [] },
  ]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(['xiaohongshu.whoami', 'twitter.whoami']),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config,
    catalog,
    store,
    service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    'Idempotency-Key': 'session-check-test-1',
  };
  try {
    const unauthorized = await fetch(`${base}/v1/sites/xiaohongshu/session-check`, {
      method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    const first = await fetch(`${base}/v1/sites/xiaohongshu/session-check`, {
      method: 'POST',
      headers,
    });
    const firstPayload = await first.json();
    assert.equal(first.status, 202);
    assert.deepEqual(firstPayload.job.request, {
      site: 'xiaohongshu',
      command: 'whoami',
      args: [],
      profile: null,
      timeoutSeconds: 30,
    });

    const duplicate = await fetch(`${base}/v1/sites/xiaohongshu/session-check`, {
      method: 'POST',
      headers,
    });
    const duplicatePayload = await duplicate.json();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicatePayload.job.id, firstPayload.job.id);

    const disallowed = await fetch(`${base}/v1/sites/rednote/session-check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    assert.equal(disallowed.status, 400);
    assert.match((await disallowed.json()).message, /not allowed/);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('discovers and submits read commands from the OpenCLI catalog', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-catalog-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'twitter',
    name: 'search',
    description: 'Search posts',
    access: 'read',
    browser: true,
    siteSession: null,
    args: [
      { name: 'query', type: 'str', required: true, positional: true, choices: [] },
      { name: 'limit', type: 'int', required: false, positional: false, choices: [] },
    ],
  }], { autoAllowReads: true });
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config,
    catalog,
    store,
    service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
  };
  try {
    const discovery = await fetch(`${base}/v1/commands?site=twitter`, { headers });
    const discoveryPayload = await discovery.json();
    assert.equal(discovery.status, 200);
    assert.equal(discoveryPayload.total, 1);
    assert.equal(discoveryPayload.commands[0].command, 'search');

    const submitted = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        site: 'twitter',
        command: 'search',
        params: { query: 'opencli', limit: 3 },
      }),
    });
    const submittedPayload = await submitted.json();
    assert.equal(submitted.status, 202);
    assert.deepEqual(submittedPayload.job.request.args, ['opencli', '--limit', '3']);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('searches the command catalog by agent intent and returns execution metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-search-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([
    {
      site: 'twitter', name: 'search', description: 'Search public posts by keyword',
      access: 'read', strategy: 'cookie', browser: true, siteSession: null,
      domain: 'x.com', example: 'opencli twitter search opencli', columns: ['id', 'text'],
      args: [{ name: 'query', type: 'str', required: true, positional: true, choices: [] }],
    },
    {
      site: 'twitter', name: 'whoami', description: 'Show current account',
      access: 'read', strategy: 'cookie', browser: true, siteSession: 'persistent',
      args: [],
    },
    {
      site: 'hackernews', name: 'top', description: 'List top stories',
      access: 'read', strategy: 'public', browser: false, siteSession: null,
      args: [],
    },
  ]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${config.apiToken}` };
  try {
    const response = await fetch(`${base}/v1/commands?q=search%20posts`, { headers });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.total, 1);
    assert.equal(payload.commands[0].command, 'search');
    assert.deepEqual(payload.commands[0].columns, ['id', 'text']);
    assert.equal(payload.commands[0].strategy, 'cookie');
    assert.equal(payload.commands[0].domain, 'x.com');
    assert.equal(payload.commands[0].sessionCheckAvailable, true);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('waits for a submitted job when an agent requests synchronous completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-wait-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', description: 'List top stories',
    access: 'read', strategy: 'public', browser: false, siteSession: null,
    args: [], columns: ['title'],
  }]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    maxWaitSeconds: 30,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/v1/jobs?wait=true&waitTimeoutSeconds=5`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site: 'hackernews', command: 'top', params: {} }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.job.status, 'succeeded');
    assert.deepEqual(payload.result.output, [{ title: 'example' }]);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('returns machine-actionable validation errors for agent self-correction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-errors-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'twitter', name: 'search', description: 'Search public posts',
    access: 'read', strategy: 'cookie', browser: true, siteSession: null,
    args: [{ name: 'query', type: 'str', required: true, positional: true, choices: [] }],
  }]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    maxWaitSeconds: 30,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site: 'twitter', command: 'search', params: {} }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      error: 'invalid_request',
      code: 'missing_parameter',
      field: 'query',
      message: 'missing required parameter: query',
      retryable: false,
    });
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('keeps a durable job running when an agent wait times out', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-wait-timeout-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', description: 'List top stories',
    access: 'read', strategy: 'public', browser: false, siteSession: null, args: [],
  }]);
  const service = new JobService({
    store, executor: new CancellableExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    maxWaitSeconds: 30,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
  };
  try {
    const response = await fetch(`${base}/v1/jobs?wait=true&waitTimeoutSeconds=1`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ site: 'hackernews', command: 'top', params: {} }),
    });
    const payload = await response.json();

    assert.equal(response.status, 202);
    assert.equal(payload.waitTimedOut, true);
    assert.equal(store.get(payload.job.id).status, 'running');

    await fetch(`${base}/v1/jobs/${payload.job.id}/cancel`, { method: 'POST', headers });
    await service.waitForIdle();
    assert.equal(store.get(payload.job.id).status, 'cancelled');
  } finally {
    await closeServer(server);
    await service.stop({ cancelActive: true });
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('enforces agent scopes and isolates jobs by owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-agent-auth-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', description: 'List top stories',
    access: 'read', strategy: 'public', browser: false, siteSession: null,
    args: [], columns: ['title'],
  }]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const config = {
    apiToken: 'admin-token-with-at-least-24-characters',
    agentCredentials: [
      {
        id: 'research-agent',
        token: 'research-token-with-at-least-24-characters',
        scopes: new Set(['commands:read', 'jobs:submit', 'jobs:read']),
      },
      {
        id: 'observer-agent',
        token: 'observer-token-with-at-least-24-characters',
        scopes: new Set(['commands:read', 'jobs:read']),
      },
    ],
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const auth = (token) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  try {
    const submitted = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: auth(config.agentCredentials[0].token),
      body: JSON.stringify({ site: 'hackernews', command: 'top', params: {} }),
    });
    const payload = await submitted.json();
    assert.equal(submitted.status, 202);

    const forbiddenSubmit = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: auth(config.agentCredentials[1].token),
      body: JSON.stringify({ site: 'hackernews', command: 'top', params: {} }),
    });
    assert.equal(forbiddenSubmit.status, 403);
    assert.deepEqual(await forbiddenSubmit.json(), {
      error: 'forbidden',
      requiredScope: 'jobs:submit',
    });

    const hidden = await fetch(`${base}/v1/jobs/${payload.job.id}`, {
      headers: auth(config.agentCredentials[1].token),
    });
    assert.equal(hidden.status, 404);

    const owned = await fetch(`${base}/v1/jobs/${payload.job.id}`, {
      headers: auth(config.agentCredentials[0].token),
    });
    assert.equal(owned.status, 200);

    const admin = await fetch(`${base}/v1/jobs/${payload.job.id}`, {
      headers: auth(config.apiToken),
    });
    assert.equal(admin.status, 200);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('persists agent mutation audit events without storing bearer tokens', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-audit-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', access: 'read', browser: false, siteSession: null,
    args: [],
  }]);
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const agentToken = 'audited-agent-token-with-at-least-24-characters';
  const config = {
    apiToken: 'admin-token-with-at-least-24-characters',
    agentCredentials: [{
      id: 'audited-agent', token: agentToken,
      scopes: new Set(['jobs:submit']),
    }],
    allowedCommands: new Set(),
    deniedArguments: new Set(),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });
  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const submitted = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site: 'hackernews', command: 'top', params: {} }),
    });
    assert.equal(submitted.status, 202);

    const audit = await fetch(`${base}/v1/audit`, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    const payload = await audit.json();
    assert.equal(audit.status, 200);
    assert.equal(payload.events[0].agentId, 'audited-agent');
    assert.equal(payload.events[0].action, 'job.submit');
    assert.equal(payload.events[0].outcome, 'created');
    assert.equal(JSON.stringify(payload).includes(agentToken), false);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('rejects new work with a retryable error when the durable queue is full', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-capacity-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  store.setPaused(true);
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', access: 'read', browser: false, siteSession: null,
    args: [],
  }]);
  const service = new JobService({
    store,
    executor: new ImmediateExecutor(),
    catalog,
    maxQueuedJobs: 1,
    pollIntervalMs: 5,
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
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });
  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const endpoint = `http://127.0.0.1:${address.port}/v1/jobs`;
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ site: 'hackernews', command: 'top', params: {} });
  try {
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 202);
    const rejected = await fetch(endpoint, { method: 'POST', headers, body });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('retry-after'), '5');
    assert.deepEqual(await rejected.json(), {
      error: 'queue_full',
      message: 'durable queue capacity has been reached',
      retryable: true,
      retryAfterSeconds: 5,
    });
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('rate limits new submissions per agent without blocking idempotent retries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-rate-limit-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', access: 'read', browser: false, siteSession: null,
    args: [],
  }]);
  const service = new JobService({
    store,
    executor: new ImmediateExecutor(),
    catalog,
    maxSubmissionsPerMinute: 1,
    pollIntervalMs: 5,
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
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });
  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const endpoint = `http://127.0.0.1:${address.port}/v1/jobs`;
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'same-request',
  };
  const body = JSON.stringify({ site: 'hackernews', command: 'top', params: {} });
  try {
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 202);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);

    const limited = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'new-request' },
      body,
    });
    const payload = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(payload.error, 'rate_limited');
    assert.equal(payload.retryable, true);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('exposes scoped Prometheus metrics for queue and bridge health', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-metrics-http-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', access: 'read', browser: false, siteSession: null,
    args: [],
  }]);
  const service = new JobService({ store, executor: new ImmediateExecutor(), catalog });
  const metricsToken = 'metrics-agent-token-with-at-least-24-characters';
  const config = {
    apiToken: 'admin-token-with-at-least-24-characters',
    agentCredentials: [{
      id: 'metrics-agent', token: metricsToken, scopes: new Set(['metrics:read']),
    }],
    allowedCommands: new Set(),
    deniedArguments: new Set(),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
  };
  const server = createApiServer({
    config, catalog, store, service,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });
  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`, {
      headers: { Authorization: `Bearer ${metricsToken}` },
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.match(body, /opencli_backend_bridge_ready 1/);
    assert.match(body, /opencli_backend_active_jobs 0/);
    assert.match(body, /opencli_backend_commands 1/);
    assert.match(body, /opencli_backend_watchdog_terminations_total 0/);
  } finally {
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});
