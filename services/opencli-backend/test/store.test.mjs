import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../src/store.mjs';

function tempDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-store-'));
  return { directory, path: join(directory, 'jobs.sqlite3') };
}

const request = {
  site: 'hackernews', command: 'top', args: [], profile: null, timeoutSeconds: 30,
};

test('deduplicates submissions by idempotency key', () => {
  const temp = tempDatabase();
  const store = new JobStore(temp.path);
  try {
    const first = store.enqueue({ id: 'one', idempotencyKey: 'same-key', request });
    const second = store.enqueue({ id: 'two', idempotencyKey: 'same-key', request });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, 'one');
  } finally {
    store.close();
    rmSync(temp.directory, { recursive: true });
  }
});

test('marks an in-flight job outcome_unknown after restart recovery', () => {
  const temp = tempDatabase();
  let store = new JobStore(temp.path);
  store.enqueue({ id: 'running-job', request });
  assert.equal(store.claimNext().status, 'running');
  store.close();

  store = new JobStore(temp.path);
  try {
    assert.equal(store.recoverUnknownOutcomes(), 1);
    const recovered = store.get('running-job');
    assert.equal(recovered.status, 'outcome_unknown');
    assert.equal(recovered.errorCode, 'service_restarted_during_execution');
  } finally {
    store.close();
    rmSync(temp.directory, { recursive: true });
  }
});

test('cancels a queued job without executing it', () => {
  const temp = tempDatabase();
  const store = new JobStore(temp.path);
  try {
    store.enqueue({ id: 'queued-job', request });
    const cancelled = store.requestCancel('queued-job');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(store.claimNext(), null);
  } finally {
    store.close();
    rmSync(temp.directory, { recursive: true });
  }
});

test('migrates legacy jobs conservatively for resource-aware scheduling', () => {
  const temp = tempDatabase();
  const legacy = new DatabaseSync(temp.path);
  legacy.exec(`
    CREATE TABLE jobs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      exit_code INTEGER,
      error_code TEXT,
      stdout TEXT,
      stderr TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    );
    INSERT INTO jobs(id, status, request_json, created_at)
    VALUES ('legacy-job', 'queued', '{}', 1);
  `);
  legacy.close();

  const store = new JobStore(temp.path);
  try {
    const migrated = store.get('legacy-job');
    assert.equal(migrated.exclusive, true);
    assert.equal(migrated.resourceKey, null);
  } finally {
    store.close();
    rmSync(temp.directory, { recursive: true });
  }
});
