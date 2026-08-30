import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'needs_login',
  'cancelled',
  'interrupted',
  'outcome_unknown',
]);

function parseJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    request: JSON.parse(row.request_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    errorCode: row.error_code,
    stdout: row.stdout,
    stderr: row.stderr,
    outputTruncated: Boolean(row.output_truncated),
    durationMs: row.duration_ms,
    resourceKey: row.resource_key,
    exclusive: Boolean(row.exclusive),
    agentId: row.agent_id,
    source: row.source,
    purpose: row.purpose,
  };
}

function parseAuditEvent(row) {
  return {
    id: row.sequence,
    createdAt: row.created_at,
    agentId: row.agent_id,
    source: row.source,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    outcome: row.outcome,
    details: JSON.parse(row.details_json),
  };
}

export class JobStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS jobs (
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
        duration_ms INTEGER,
        resource_key TEXT,
        exclusive INTEGER NOT NULL DEFAULT 1,
        agent_id TEXT NOT NULL DEFAULT 'admin',
        source TEXT NOT NULL DEFAULT 'internal',
        purpose TEXT NOT NULL DEFAULT 'command'
      );

      CREATE INDEX IF NOT EXISTS jobs_status_created_idx
        ON jobs(status, sequence);

      CREATE TABLE IF NOT EXISTS control (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO control(key, value) VALUES ('paused', '0');

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        outcome TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS audit_events_created_idx
        ON audit_events(sequence DESC);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
    if (!columns.has('resource_key')) this.db.exec('ALTER TABLE jobs ADD COLUMN resource_key TEXT');
    if (!columns.has('exclusive')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 1');
    }
    if (!columns.has('agent_id')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'admin'");
    }
    if (!columns.has('source')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'internal'");
    }
    if (!columns.has('purpose')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'command'");
    }
  }

  close() {
    this.db.close();
  }

  recoverUnknownOutcomes(now = Date.now()) {
    return this.db.prepare(`
      UPDATE jobs
      SET status = 'outcome_unknown',
          finished_at = ?,
          error_code = 'service_restarted_during_execution'
      WHERE status IN ('running', 'cancel_requested')
    `).run(now).changes;
  }

  enqueue({
    id,
    idempotencyKey = null,
    request,
    scheduling = { resourceKey: null, exclusive: true },
    agentId = 'admin',
    source = 'internal',
    purpose = 'command',
    now = Date.now(),
  }) {
    if (idempotencyKey) {
      const existing = this.db
        .prepare('SELECT * FROM jobs WHERE idempotency_key = ?')
        .get(idempotencyKey);
      if (existing) return { created: false, job: parseJob(existing) };
    }

    this.db.prepare(`
      INSERT INTO jobs(
        id, idempotency_key, status, request_json, created_at, resource_key, exclusive,
        agent_id, source, purpose
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      idempotencyKey,
      JSON.stringify(request),
      now,
      scheduling.resourceKey,
      scheduling.exclusive ? 1 : 0,
      agentId,
      source,
      purpose,
    );
    return { created: true, job: this.get(id) };
  }

  get(id) {
    return parseJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  findByIdempotencyKey(idempotencyKey) {
    return parseJob(this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey));
  }

  list(limit = 50, { agentId = null } = {}) {
    const statement = agentId === null
      ? this.db.prepare('SELECT * FROM jobs ORDER BY sequence DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM jobs WHERE agent_id = ? ORDER BY sequence DESC LIMIT ?');
    return statement
      .all(...(agentId === null ? [limit] : [agentId, limit]))
      .map(parseJob);
  }

  latestSessionChecks() {
    return this.db.prepare(`
      SELECT jobs.*
      FROM jobs
      INNER JOIN (
        SELECT json_extract(request_json, '$.site') AS site, MAX(sequence) AS sequence
        FROM jobs
        WHERE purpose = 'session_check'
        GROUP BY json_extract(request_json, '$.site')
      ) latest ON latest.sequence = jobs.sequence
      ORDER BY jobs.sequence DESC
    `).all().map(parseJob);
  }

  claimNext({ maxConcurrency = 1, now = Date.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const paused = this.isPaused();
      if (paused) {
        this.db.exec('COMMIT');
        return null;
      }
      const running = this.db.prepare(`
        SELECT resource_key, exclusive
        FROM jobs
        WHERE status IN ('running', 'cancel_requested')
      `).all();
      if (running.length >= maxConcurrency || running.some((job) => Boolean(job.exclusive))) {
        this.db.exec('COMMIT');
        return null;
      }
      const occupiedResources = new Set(
        running.map((job) => job.resource_key).filter((resourceKey) => resourceKey !== null),
      );
      const queued = this.db.prepare(`
        SELECT id, resource_key, exclusive
        FROM jobs
        WHERE status = 'queued'
        ORDER BY sequence
      `).all();
      let row = null;
      for (const candidate of queued) {
        if (candidate.exclusive) {
          if (running.length === 0) row = candidate;
          break;
        }
        if (candidate.resource_key !== null && occupiedResources.has(candidate.resource_key)) continue;
        row = candidate;
        break;
      }
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db
        .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(now, row.id);
      this.db.exec('COMMIT');
      return this.get(row.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(id, result, now = Date.now()) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, finished_at = ?, exit_code = ?, error_code = ?,
          stdout = ?, stderr = ?, output_truncated = ?, duration_ms = ?
      WHERE id = ?
    `).run(
      result.status,
      now,
      result.exitCode,
      result.errorCode,
      result.stdout,
      result.stderr,
      result.outputTruncated ? 1 : 0,
      result.durationMs,
      id,
    );
    return this.get(id);
  }

  requestCancel(id, now = Date.now()) {
    const job = this.get(id);
    if (!job || TERMINAL_STATUSES.has(job.status)) return job;
    if (job.status === 'queued') {
      this.db
        .prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error_code = 'cancelled_before_start' WHERE id = ?")
        .run(now, id);
    } else if (job.status === 'running') {
      this.db.prepare("UPDATE jobs SET status = 'cancel_requested' WHERE id = ?").run(id);
    }
    return this.get(id);
  }

  isPaused() {
    return this.db.prepare("SELECT value FROM control WHERE key = 'paused'").get().value === '1';
  }

  setPaused(paused) {
    this.db
      .prepare("UPDATE control SET value = ? WHERE key = 'paused'")
      .run(paused ? '1' : '0');
  }

  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all();
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  appendAudit({
    agentId,
    source,
    action,
    resourceType,
    resourceId = null,
    outcome,
    details = {},
    now = Date.now(),
  }) {
    this.db.prepare(`
      INSERT INTO audit_events(
        created_at, agent_id, source, action, resource_type, resource_id, outcome, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now,
      agentId,
      source,
      action,
      resourceType,
      resourceId,
      outcome,
      JSON.stringify(details),
    );
  }

  listAudit(limit = 100) {
    return this.db
      .prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?')
      .all(limit)
      .map(parseAuditEvent);
  }
}

export { TERMINAL_STATUSES };
