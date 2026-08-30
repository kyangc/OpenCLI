import { execFile } from 'node:child_process';

export function ensureDaemon(binary = 'opencli') {
  return new Promise((resolve) => {
    execFile(binary, ['daemon', 'restart'], { timeout: 15_000 }, (error) => {
      resolve({ ok: !error, error: error?.message ?? null });
    });
  });
}

export async function getBridgeHealth({ timeoutMs = 1_500 } = {}) {
  try {
    const response = await fetch('http://127.0.0.1:19825/status', {
      headers: { 'X-OpenCLI': '1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ready: false, daemon: 'unhealthy', extensionConnected: false };
    const status = await response.json();
    return {
      ready: Boolean(status.extensionConnected),
      daemon: 'running',
      daemonVersion: status.daemonVersion ?? null,
      extensionConnected: Boolean(status.extensionConnected),
      extensionVersion: status.extensionVersion ?? null,
      profileCount: Array.isArray(status.profiles) ? status.profiles.length : 0,
      pendingCommands: Number(status.pending ?? 0),
    };
  } catch {
    return { ready: false, daemon: 'stopped', extensionConnected: false };
  }
}
