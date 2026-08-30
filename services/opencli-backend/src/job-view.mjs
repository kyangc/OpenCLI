export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    request: job.request,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    errorCode: job.errorCode,
    outputTruncated: job.outputTruncated,
    durationMs: job.durationMs,
  };
}

export function jobResult(job) {
  let output = job.stdout;
  try {
    output = JSON.parse(job.stdout);
  } catch {
    // Retain non-JSON OpenCLI output as text.
  }
  return {
    id: job.id,
    status: job.status,
    exitCode: job.exitCode,
    errorCode: job.errorCode,
    output,
    stderr: job.stderr,
    outputTruncated: job.outputTruncated,
    durationMs: job.durationMs,
  };
}
