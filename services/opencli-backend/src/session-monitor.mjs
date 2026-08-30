import { ServiceError } from './service.mjs';

function sessionState(job) {
  if (!job) return 'unknown';
  if (job.status === 'succeeded') return 'authenticated';
  if (job.status === 'needs_login') return 'needs_login';
  if (['queued', 'running', 'cancel_requested'].includes(job.status)) return 'checking';
  return 'error';
}

export class SessionMonitor {
  constructor({
    sites,
    catalog,
    store,
    service,
    defaultTimeoutSeconds,
    intervalMs,
  }) {
    this.sites = new Set(sites);
    this.catalog = catalog;
    this.store = store;
    this.service = service;
    this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.checking = false;
  }

  start() {
    if (this.timer || this.sites.size === 0) return;
    void this.checkNow().catch((error) => console.error('[sessions] initial check failed', error));
    this.timer = setInterval(() => {
      void this.checkNow().catch((error) => console.error('[sessions] periodic check failed', error));
    }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkNow(now = Date.now()) {
    if (this.checking || this.store.isPaused()) return [];
    this.checking = true;
    const jobs = [];
    try {
      const bucket = Math.floor(now / this.intervalMs);
      for (const site of this.sites) {
        if (!this.catalog.get(site, 'whoami')) continue;
        try {
          const result = this.service.submit({
            site,
            command: 'whoami',
            args: [],
            profile: null,
            timeoutSeconds: this.defaultTimeoutSeconds,
          }, `session:${site}:${bucket}`, {
            agentId: 'system',
            isAdmin: true,
            source: 'session-monitor',
            purpose: 'session_check',
          });
          jobs.push(result.job);
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
        }
      }
      return jobs;
    } finally {
      this.checking = false;
    }
  }

  status() {
    const latest = new Map(
      this.store.latestSessionChecks().map((job) => [job.request.site, job]),
    );
    return [...this.sites]
      .sort()
      .map((site) => {
        const job = latest.get(site) ?? null;
        return {
          site,
          state: sessionState(job),
          jobStatus: job?.status ?? null,
          errorCode: job?.errorCode ?? null,
          checkedAt: job?.finishedAt ?? job?.startedAt ?? job?.createdAt ?? null,
        };
      });
  }
}
