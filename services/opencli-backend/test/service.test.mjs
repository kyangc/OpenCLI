import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobStore } from '../src/store.mjs';
import { JobService } from '../src/service.mjs';
import { CommandCatalog } from '../src/command-catalog.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('condition was not reached');
}

class RecordingExecutor {
  active = 0;
  maximumActive = 0;
  events = [];

  async execute(job, { onSpawn }) {
    onSpawn({ cancel() {} });
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.events.push(`start:${job.id}`);
    await delay(40);
    this.events.push(`finish:${job.id}`);
    this.active -= 1;
    return {
      exitCode: 0,
      signal: null,
      stdout: '[]',
      stderr: '',
      outputTruncated: false,
      durationMs: 40,
      timedOut: false,
      cancelRequested: false,
      spawnError: null,
    };
  }
}

class ControlledExecutor {
  pending = new Map();

  execute(job, { onSpawn }) {
    return new Promise((resolve) => {
      this.pending.set(job.id, resolve);
      onSpawn({ cancel: () => this.finish(job.id, true) });
    });
  }

  finish(id, cancelRequested = false) {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve({
      exitCode: cancelRequested ? null : 0,
      signal: cancelRequested ? 'SIGTERM' : null,
      stdout: '[]',
      stderr: '',
      outputTruncated: false,
      durationMs: 1,
      timedOut: false,
      cancelRequested,
      spawnError: null,
    });
  }
}

class WatchdogExecutor {
  execute(_job, { onSpawn }) {
    return new Promise((resolve) => {
      onSpawn({
        cancel() {},
        timeout: () => resolve({
          exitCode: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
          outputTruncated: false,
          durationMs: 10,
          timedOut: true,
          cancelRequested: false,
          spawnError: null,
        }),
      });
    });
  }
}

test('executes concurrently submitted jobs strictly one at a time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const executor = new RecordingExecutor();
  const service = new JobService({ store, executor, pollIntervalMs: 5 });
  const request = {
    site: 'hackernews', command: 'top', args: [], profile: null, timeoutSeconds: 30,
  };
  try {
    service.start();
    const first = service.submit(request).job;
    const second = service.submit(request).job;
    await service.waitForIdle();

    assert.equal(executor.maximumActive, 1);
    assert.deepEqual(executor.events, [
      `start:${first.id}`, `finish:${first.id}`, `start:${second.id}`, `finish:${second.id}`,
    ]);
    assert.equal(store.get(first.id).status, 'succeeded');
    assert.equal(store.get(second.id).status, 'succeeded');
  } finally {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('executes jobs for different persistent site sessions concurrently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-parallel-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const executor = new RecordingExecutor();
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
    store, executor, catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  try {
    service.start();
    service.submit({
      site: 'xiaohongshu', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
    });
    service.submit({
      site: 'twitter', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
    });
    await service.waitForIdle();

    assert.equal(executor.maximumActive, 2);
  } finally {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('serializes jobs that share a persistent site session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-same-tab-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const executor = new RecordingExecutor();
  const catalog = new CommandCatalog([{
    site: 'twitter', name: 'whoami', access: 'read', browser: true,
    siteSession: 'persistent', args: [],
  }]);
  const service = new JobService({
    store, executor, catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const request = {
    site: 'twitter', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
  };
  try {
    service.start();
    const first = service.submit(request).job;
    const second = service.submit(request).job;
    await service.waitForIdle();

    assert.equal(executor.maximumActive, 1);
    assert.deepEqual(executor.events, [
      `start:${first.id}`, `finish:${first.id}`, `start:${second.id}`, `finish:${second.id}`,
    ]);
  } finally {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('runs a free resource behind a blocked queue head', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-head-of-line-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  store.setPaused(true);
  const executor = new RecordingExecutor();
  const catalog = new CommandCatalog([
    {
      site: 'twitter', name: 'whoami', access: 'read', browser: true,
      siteSession: 'persistent', args: [],
    },
    {
      site: 'xiaohongshu', name: 'whoami', access: 'read', browser: true,
      siteSession: 'persistent', args: [],
    },
  ]);
  const service = new JobService({
    store, executor, catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const twitter = {
    site: 'twitter', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
  };
  const xiaohongshu = {
    site: 'xiaohongshu', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
  };
  try {
    service.start();
    const first = service.submit(twitter).job;
    service.submit(twitter);
    const third = service.submit(xiaohongshu).job;
    service.resume();
    await service.waitForIdle();

    assert.deepEqual(executor.events.slice(0, 2), [`start:${first.id}`, `start:${third.id}`]);
  } finally {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('cancels one active job without disturbing another', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-cancel-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const executor = new ControlledExecutor();
  const catalog = new CommandCatalog([
    {
      site: 'twitter', name: 'whoami', access: 'read', browser: true,
      siteSession: 'persistent', args: [],
    },
    {
      site: 'xiaohongshu', name: 'whoami', access: 'read', browser: true,
      siteSession: 'persistent', args: [],
    },
  ]);
  const service = new JobService({
    store, executor, catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  try {
    service.start();
    const first = service.submit({
      site: 'twitter', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
    }).job;
    const second = service.submit({
      site: 'xiaohongshu', command: 'whoami', args: [], profile: null, timeoutSeconds: 30,
    }).job;
    await waitUntil(() => service.activeCount === 2);

    service.cancel(first.id);
    await waitUntil(() => store.get(first.id).status === 'cancelled');
    assert.equal(store.get(second.id).status, 'running');
    assert.deepEqual(service.controlState().activeJobIds, [second.id]);

    executor.finish(second.id);
    await service.waitForIdle();
    assert.equal(store.get(second.id).status, 'succeeded');
  } finally {
    await service.stop({ cancelActive: true });
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('pause drains all active jobs before keeping new work queued', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-pause-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const executor = new ControlledExecutor();
  const catalog = new CommandCatalog([
    { site: 'twitter', name: 'whoami', access: 'read', browser: true, siteSession: 'persistent', args: [] },
    { site: 'xiaohongshu', name: 'whoami', access: 'read', browser: true, siteSession: 'persistent', args: [] },
    { site: 'bilibili', name: 'hot', access: 'read', browser: true, siteSession: null, args: [] },
  ]);
  const service = new JobService({
    store, executor, catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const request = (site, command) => ({
    site, command, args: [], profile: null, timeoutSeconds: 30,
  });
  try {
    service.start();
    const first = service.submit(request('twitter', 'whoami')).job;
    const second = service.submit(request('xiaohongshu', 'whoami')).job;
    await waitUntil(() => service.activeCount === 2);

    service.pause();
    const queued = service.submit(request('bilibili', 'hot')).job;
    assert.equal(service.controlState().drained, false);
    executor.finish(first.id);
    executor.finish(second.id);
    await waitUntil(() => service.controlState().drained);
    assert.equal(store.get(queued.id).status, 'queued');

    service.resume();
    await waitUntil(() => store.get(queued.id).status === 'running');
    executor.finish(queued.id);
    await service.waitForIdle();
  } finally {
    await service.stop({ cancelActive: true });
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('watchdog terminates an execution that exceeds its task budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-watchdog-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const service = new JobService({
    store,
    executor: new WatchdogExecutor(),
    pollIntervalMs: 5,
    watchdogGraceMs: 0,
  });
  try {
    service.start();
    const job = service.submit({
      site: 'hackernews', command: 'top', args: [], profile: null, timeoutSeconds: 0.01,
    }).job;
    await service.waitForIdle();

    assert.equal(store.get(job.id).status, 'outcome_unknown');
    assert.equal(store.get(job.id).errorCode, 'command_timeout');
    assert.equal(service.runtimeMetrics().watchdogTerminations, 1);
  } finally {
    await service.stop({ cancelActive: true });
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('uses catalog access to close a read-only timeout as failed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-service-read-timeout-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([{
    site: 'hackernews', name: 'top', access: 'read', browser: false, args: [],
  }]);
  const service = new JobService({
    store,
    executor: new WatchdogExecutor(),
    catalog,
    pollIntervalMs: 5,
    watchdogGraceMs: 0,
  });
  try {
    service.start();
    const job = service.submit({
      site: 'hackernews', command: 'top', args: [], profile: null, timeoutSeconds: 0.01,
    }).job;
    await service.waitForIdle();

    assert.equal(store.get(job.id).status, 'failed');
    assert.equal(store.get(job.id).errorCode, 'command_timeout');
  } finally {
    await service.stop({ cancelActive: true });
    store.close();
    rmSync(directory, { recursive: true });
  }
});
