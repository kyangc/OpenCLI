const JOB_STATUSES = [
  'queued',
  'running',
  'cancel_requested',
  'succeeded',
  'failed',
  'needs_login',
  'cancelled',
  'interrupted',
  'outcome_unknown',
];

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function renderMetrics({ service, store, catalog, bridge, sessionMonitor = null }) {
  const runtime = service.runtimeMetrics();
  const counts = store.counts();
  const lines = [
    '# HELP opencli_backend_bridge_ready Whether the Browser Bridge is connected.',
    '# TYPE opencli_backend_bridge_ready gauge',
    `opencli_backend_bridge_ready ${bridge.ready ? 1 : 0}`,
    '# HELP opencli_backend_active_jobs Currently executing jobs.',
    '# TYPE opencli_backend_active_jobs gauge',
    `opencli_backend_active_jobs ${runtime.activeJobs}`,
    '# HELP opencli_backend_max_concurrency Configured execution concurrency.',
    '# TYPE opencli_backend_max_concurrency gauge',
    `opencli_backend_max_concurrency ${runtime.maxConcurrency}`,
    '# HELP opencli_backend_max_queued_jobs Configured durable queue capacity.',
    '# TYPE opencli_backend_max_queued_jobs gauge',
    `opencli_backend_max_queued_jobs ${runtime.maxQueuedJobs}`,
    '# HELP opencli_backend_queue_paused Whether dispatch is paused.',
    '# TYPE opencli_backend_queue_paused gauge',
    `opencli_backend_queue_paused ${store.isPaused() ? 1 : 0}`,
    '# HELP opencli_backend_commands Allowed command catalog size.',
    '# TYPE opencli_backend_commands gauge',
    `opencli_backend_commands ${catalog?.size ?? 0}`,
    '# HELP opencli_backend_jobs Current durable jobs by status.',
    '# TYPE opencli_backend_jobs gauge',
    ...JOB_STATUSES.map((status) => `opencli_backend_jobs{status="${status}"} ${counts[status] ?? 0}`),
    '# HELP opencli_backend_queue_full_rejections_total Submissions rejected by queue capacity.',
    '# TYPE opencli_backend_queue_full_rejections_total counter',
    `opencli_backend_queue_full_rejections_total ${runtime.queueFullRejections}`,
    '# HELP opencli_backend_rate_limit_rejections_total Submissions rejected by per-agent rate limit.',
    '# TYPE opencli_backend_rate_limit_rejections_total counter',
    `opencli_backend_rate_limit_rejections_total ${runtime.rateLimitRejections}`,
    '# HELP opencli_backend_watchdog_terminations_total Executions terminated by the scheduler watchdog.',
    '# TYPE opencli_backend_watchdog_terminations_total counter',
    `opencli_backend_watchdog_terminations_total ${runtime.watchdogTerminations}`,
  ];
  if (sessionMonitor) {
    lines.push(
      '# HELP opencli_backend_session_state Current configured site session state.',
      '# TYPE opencli_backend_session_state gauge',
      ...sessionMonitor.status().map(({ site, state }) => (
        `opencli_backend_session_state{site="${escapeLabel(site)}",state="${escapeLabel(state)}"} 1`
      )),
    );
  }
  return `${lines.join('\n')}\n`;
}
