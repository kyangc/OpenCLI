import { spawn } from 'node:child_process';
import { buildOpenCliArgv } from './job-input.mjs';

function boundedCollector(limit) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, limit - bytes);
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(remaining, buffer.length);
      if (buffer.length > remaining) truncated = true;
    },
    value() {
      return Buffer.concat(chunks).toString('utf8');
    },
    get truncated() {
      return truncated;
    },
  };
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export class OpenCliExecutor {
  constructor({ binary = 'opencli', maxOutputBytes = 1_048_576, killGraceMs = 2_000 } = {}) {
    this.binary = binary;
    this.maxOutputBytes = maxOutputBytes;
    this.killGraceMs = killGraceMs;
  }

  execute(job, { onSpawn = () => {} } = {}) {
    const startedAt = Date.now();
    const stdout = boundedCollector(this.maxOutputBytes);
    const stderr = boundedCollector(this.maxOutputBytes);
    const argv = buildOpenCliArgv(job.request);

    return new Promise((resolve) => {
      const child = spawn(this.binary, argv, {
        detached: process.platform !== 'win32',
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timedOut = false;
      let cancelRequested = false;
      let spawnError = null;
      let settled = false;
      let forceKillTimer = null;

      const terminate = (reason) => {
        if (reason === 'cancel') cancelRequested = true;
        if (reason === 'timeout') timedOut = true;
        terminateProcessGroup(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), this.killGraceMs);
        forceKillTimer.unref();
      };

      onSpawn({
        pid: child.pid,
        cancel: () => terminate('cancel'),
        timeout: () => terminate('timeout'),
      });
      const timeoutTimer = setTimeout(() => terminate('timeout'), job.request.timeoutSeconds * 1000);
      timeoutTimer.unref();

      child.stdout.on('data', (chunk) => stdout.append(chunk));
      child.stderr.on('data', (chunk) => stderr.append(chunk));
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({
          exitCode,
          signal,
          stdout: stdout.value(),
          stderr: stderr.value(),
          outputTruncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - startedAt,
          timedOut,
          cancelRequested,
          spawnError: spawnError?.message ?? null,
        });
      });
    });
  }
}

export function classifyExecution(result, { access = null } = {}) {
  const base = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
  };

  if (result.spawnError) {
    return { ...base, status: 'failed', errorCode: 'spawn_error' };
  }
  if (result.cancelRequested) {
    return { ...base, status: 'cancelled', errorCode: 'cancelled_during_execution' };
  }
  if (result.timedOut || result.exitCode === 75) {
    return {
      ...base,
      status: access === 'read' ? 'failed' : 'outcome_unknown',
      errorCode: 'command_timeout',
    };
  }
  if (result.signal) {
    return { ...base, status: 'outcome_unknown', errorCode: `terminated_by_${result.signal}` };
  }
  if (result.outputTruncated) {
    return { ...base, status: 'failed', errorCode: 'output_truncated' };
  }
  if (result.exitCode === 0) {
    try {
      JSON.parse(result.stdout);
    } catch {
      return { ...base, status: 'failed', errorCode: 'invalid_json_output' };
    }
    return { ...base, status: 'succeeded', errorCode: null };
  }
  if (result.exitCode === 66) return { ...base, status: 'succeeded', errorCode: 'empty_result' };
  if (result.exitCode === 69) return { ...base, status: 'failed', errorCode: 'browser_bridge_unavailable' };
  if (result.exitCode === 77) return { ...base, status: 'needs_login', errorCode: 'authentication_required' };
  if (result.exitCode === 78) return { ...base, status: 'failed', errorCode: 'opencli_configuration_error' };
  return { ...base, status: 'failed', errorCode: `opencli_exit_${result.exitCode ?? 'unknown'}` };
}
