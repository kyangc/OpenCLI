#!/usr/bin/env node

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    baseUrl: null,
    expectedDaemonVersion: null,
    expectedExtensionVersion: null,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? 'argument'} requires a value`);
    if (flag === '--base-url') options.baseUrl = value;
    else if (flag === '--expected-daemon-version') options.expectedDaemonVersion = value;
    else if (flag === '--expected-extension-version') options.expectedExtensionVersion = value;
    else if (flag === '--timeout-seconds') {
      options.timeoutMs = parsePositiveNumber(value, flag) * 1_000;
    } else if (flag === '--poll-interval-ms') {
      options.pollIntervalMs = parsePositiveNumber(value, flag);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!options.baseUrl) throw new Error('--base-url is required');
  if (!options.expectedDaemonVersion) throw new Error('--expected-daemon-version is required');
  if (!options.expectedExtensionVersion) throw new Error('--expected-extension-version is required');
  options.baseUrl = new URL(options.baseUrl).toString().replace(/\/$/, '');
  return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getJson(url, remainingMs) {
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, 5_000))),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
  return { response, body };
}

async function pollUntil({ deadline, pollIntervalMs, probe }) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe(deadline - Date.now());
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  throw lastError ?? new Error('deployment smoke timed out');
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.timeoutMs;

  await pollUntil({
    deadline,
    pollIntervalMs: options.pollIntervalMs,
    probe: async (remainingMs) => {
      const { response, body } = await getJson(`${options.baseUrl}/health/live`, remainingMs);
      return response.ok && body?.status === 'alive';
    },
  });

  const readiness = await pollUntil({
    deadline,
    pollIntervalMs: options.pollIntervalMs,
    probe: async (remainingMs) => {
      const { response, body } = await getJson(`${options.baseUrl}/health/ready`, remainingMs);
      if (!response.ok || body?.status !== 'ready') return null;
      const bridge = body.bridge ?? {};
      const queue = body.queue ?? {};
      if (bridge.daemonVersion !== options.expectedDaemonVersion) {
        throw new Error(`unexpected daemon version: ${bridge.daemonVersion ?? 'missing'}`);
      }
      if (bridge.extensionVersion !== options.expectedExtensionVersion) {
        throw new Error(`unexpected extension version: ${bridge.extensionVersion ?? 'missing'}`);
      }
      if (!bridge.ready || !bridge.extensionConnected || bridge.profileCount < 1) return null;
      if (bridge.pendingCommands !== 0) return null;
      if (queue.paused || queue.activeCount !== 0 || !queue.drained) return null;
      if ((queue.counts?.queued ?? 0) !== 0) return null;
      return body;
    },
  });

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    daemonVersion: readiness.bridge.daemonVersion,
    extensionVersion: readiness.bridge.extensionVersion,
    profileCount: readiness.bridge.profileCount,
    pendingCommands: readiness.bridge.pendingCommands,
    activeCount: readiness.queue.activeCount,
    queuedCount: readiness.queue.counts?.queued ?? 0,
    drained: readiness.queue.drained,
  })}\n`);
}

run().catch((error) => {
  process.stderr.write(`deployment smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
