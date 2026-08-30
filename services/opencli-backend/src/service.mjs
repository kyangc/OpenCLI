import { randomUUID } from 'node:crypto';
import { classifyExecution } from './executor.mjs';
import { TERMINAL_STATUSES } from './store.mjs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ServiceError extends Error {
  constructor(message, {
    code,
    httpStatus,
    retryable = false,
    retryAfterSeconds = null,
  }) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class JobService {
  constructor({
    store,
    executor,
    catalog = null,
    maxConcurrency = 1,
    maxQueuedJobs = 100,
    maxSubmissionsPerMinute = 60,
    watchdogGraceMs = 30_000,
    pollIntervalMs = 200,
  }) {
    this.store = store;
    this.executor = executor;
    this.catalog = catalog;
    this.maxConcurrency = maxConcurrency;
    this.maxQueuedJobs = maxQueuedJobs;
    this.maxSubmissionsPerMinute = maxSubmissionsPerMinute;
    this.watchdogGraceMs = watchdogGraceMs;
    this.pollIntervalMs = pollIntervalMs;
    this.running = false;
    this.loopPromise = null;
    this.active = new Map();
    this.activeTasks = new Set();
    this.submissionWindows = new Map();
    this.metrics = {
      queueFullRejections: 0,
      rateLimitRejections: 0,
      watchdogTerminations: 0,
    };
  }

  start() {
    if (this.running) return;
    this.store.recoverUnknownOutcomes();
    this.running = true;
    this.loopPromise = this.#runLoop();
  }

  get activeCount() {
    return this.active.size;
  }

  async stop({ cancelActive = false } = {}) {
    this.running = false;
    if (cancelActive) {
      for (const active of this.active.values()) active.cancel();
    }
    await this.loopPromise;
    await Promise.allSettled(this.activeTasks);
  }

  submit(request, idempotencyKey = null, actor = {}) {
    const agentId = actor.agentId ?? 'admin';
    const scopedIdempotencyKey = idempotencyKey && agentId !== 'admin'
      ? `${agentId}:${idempotencyKey}`
      : idempotencyKey;
    if (scopedIdempotencyKey) {
      const existing = this.store.findByIdempotencyKey(scopedIdempotencyKey);
      if (existing) {
        this.#auditSubmission(existing, request, actor, false);
        return { created: false, job: existing };
      }
    }
    if ((this.store.counts().queued ?? 0) >= this.maxQueuedJobs) {
      this.metrics.queueFullRejections += 1;
      throw new ServiceError('durable queue capacity has been reached', {
        code: 'queue_full',
        httpStatus: 503,
        retryable: true,
        retryAfterSeconds: 5,
      });
    }
    this.#checkSubmissionRate(agentId);
    const scheduling = this.catalog?.schedulingFor(request) ?? { resourceKey: null, exclusive: true };
    const result = this.store.enqueue({
      id: randomUUID(),
      idempotencyKey: scopedIdempotencyKey,
      request,
      scheduling,
      agentId,
      source: actor.source ?? 'internal',
      purpose: actor.purpose ?? 'command',
    });
    this.#auditSubmission(result.job, request, actor, result.created);
    return result;
  }

  #auditSubmission(job, request, actor, created) {
    this.store.appendAudit({
      agentId: actor.agentId ?? 'admin',
      source: actor.source ?? 'internal',
      action: 'job.submit',
      resourceType: 'job',
      resourceId: job.id,
      outcome: created ? 'created' : 'deduplicated',
      details: {
        site: request.site,
        command: request.command,
        purpose: actor.purpose ?? 'command',
      },
    });
  }

  #checkSubmissionRate(agentId, now = Date.now()) {
    const cutoff = now - 60_000;
    const recent = (this.submissionWindows.get(agentId) ?? [])
      .filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.maxSubmissionsPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
      this.submissionWindows.set(agentId, recent);
      this.metrics.rateLimitRejections += 1;
      throw new ServiceError('agent submission rate limit has been reached', {
        code: 'rate_limited',
        httpStatus: 429,
        retryable: true,
        retryAfterSeconds,
      });
    }
    recent.push(now);
    this.submissionWindows.set(agentId, recent);
  }

  get(id, actor = {}) {
    const job = this.store.get(id);
    const agentId = actor.agentId ?? 'admin';
    const isAdmin = actor.isAdmin ?? agentId === 'admin';
    return job && (isAdmin || job.agentId === agentId) ? job : null;
  }

  list(limit, actor = {}) {
    const agentId = actor.agentId ?? 'admin';
    const isAdmin = actor.isAdmin ?? agentId === 'admin';
    return this.store.list(limit, { agentId: isAdmin ? null : agentId });
  }

  cancel(id, actor = {}) {
    if (!this.get(id, actor)) return null;
    const job = this.store.requestCancel(id);
    if (job?.status === 'cancel_requested') this.active.get(id)?.cancel();
    const current = this.store.get(id);
    this.store.appendAudit({
      agentId: actor.agentId ?? 'admin',
      source: actor.source ?? 'internal',
      action: 'job.cancel',
      resourceType: 'job',
      resourceId: id,
      outcome: current?.status ?? 'not_found',
    });
    return current;
  }

  pause(actor = {}) {
    this.store.setPaused(true);
    this.store.appendAudit({
      agentId: actor.agentId ?? 'admin',
      source: actor.source ?? 'internal',
      action: 'queue.pause',
      resourceType: 'queue',
      outcome: 'paused',
    });
    return this.controlState();
  }

  resume(actor = {}) {
    this.store.setPaused(false);
    this.store.appendAudit({
      agentId: actor.agentId ?? 'admin',
      source: actor.source ?? 'internal',
      action: 'queue.resume',
      resourceType: 'queue',
      outcome: 'resumed',
    });
    return this.controlState();
  }

  controlState() {
    const activeJobIds = [...this.active.keys()];
    return {
      paused: this.store.isPaused(),
      activeJobId: activeJobIds[0] ?? null,
      activeJobIds,
      activeCount: activeJobIds.length,
      maxConcurrency: this.maxConcurrency,
      drained: activeJobIds.length === 0,
      counts: this.store.counts(),
    };
  }

  runtimeMetrics() {
    return {
      ...this.metrics,
      activeJobs: this.active.size,
      maxConcurrency: this.maxConcurrency,
      maxQueuedJobs: this.maxQueuedJobs,
    };
  }

  async waitForIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const counts = this.store.counts();
      if (this.active.size === 0 && !counts.queued && !counts.running && !counts.cancel_requested) return;
      await sleep(20);
    }
    throw new Error('timed out waiting for queue to become idle');
  }

  async waitForTerminal(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.store.get(id);
      if (!job || TERMINAL_STATUSES.has(job.status)) return job;
      await sleep(20);
    }
    return this.store.get(id);
  }

  async #runLoop() {
    while (this.running) {
      this.#enforceDeadlines();
      let launched = false;
      while (this.running) {
        const job = this.store.claimNext({ maxConcurrency: this.maxConcurrency });
        if (!job) break;
        launched = true;
        this.#launch(job);
      }
      await sleep(launched ? 0 : this.pollIntervalMs);
    }
  }

  #launch(job) {
    const task = this.#execute(job);
    this.activeTasks.add(task);
    void task.finally(() => this.activeTasks.delete(task));
  }

  async #execute(job) {
    const active = {
      cancel() {},
      timeout() {},
      deadlineAt: (job.startedAt ?? Date.now())
        + (job.request.timeoutSeconds * 1000)
        + this.watchdogGraceMs,
      watchdogTriggered: false,
    };
    this.active.set(job.id, active);
    try {
      const execution = await this.executor.execute(job, {
        onSpawn: ({ cancel, timeout = cancel }) => {
          active.cancel = cancel;
          active.timeout = timeout;
        },
      });
      const access = this.catalog?.get(job.request.site, job.request.command)?.access ?? null;
      this.store.finish(job.id, classifyExecution(execution, { access }));
    } catch (error) {
      try {
        this.store.finish(job.id, {
          status: 'failed',
          exitCode: null,
          errorCode: 'worker_internal_error',
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          outputTruncated: false,
          durationMs: null,
        });
      } catch (storeError) {
        console.error('[queue] could not persist worker failure', storeError);
      }
    } finally {
      this.active.delete(job.id);
    }
  }

  #enforceDeadlines(now = Date.now()) {
    for (const [jobId, active] of this.active) {
      if (active.watchdogTriggered || now <= active.deadlineAt) continue;
      active.watchdogTriggered = true;
      this.metrics.watchdogTerminations += 1;
      this.store.appendAudit({
        agentId: 'system',
        source: 'watchdog',
        action: 'job.timeout',
        resourceType: 'job',
        resourceId: jobId,
        outcome: 'termination_requested',
      });
      active.timeout();
    }
  }
}
