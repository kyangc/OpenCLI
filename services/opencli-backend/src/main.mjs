import { loadConfig } from './config.mjs';
import { JobStore } from './store.mjs';
import { OpenCliExecutor } from './executor.mjs';
import { JobService } from './service.mjs';
import { ensureDaemon, getBridgeHealth } from './bridge.mjs';
import { closeServer, createApiServer, listen } from './http-server.mjs';
import { loadCommandCatalog } from './command-catalog.mjs';
import { createOpenCliMcpHandler } from './mcp.mjs';
import { SessionMonitor } from './session-monitor.mjs';

const config = loadConfig();
const store = new JobStore(config.databasePath);
const executor = new OpenCliExecutor({
  binary: config.opencliBinary,
  maxOutputBytes: config.maxOutputBytes,
});

await ensureDaemon(config.opencliBinary);
const catalog = await loadCommandCatalog(config.opencliBinary, {
  autoAllowReads: config.autoAllowReads,
  explicitAllowedCommands: config.allowedCommands,
});
const service = new JobService({
  store,
  executor,
  catalog,
  maxConcurrency: config.maxConcurrency,
  maxQueuedJobs: config.maxQueuedJobs,
  maxSubmissionsPerMinute: config.maxSubmissionsPerMinute,
  watchdogGraceMs: config.watchdogGraceSeconds * 1000,
});
service.start();
const sessionMonitor = new SessionMonitor({
  sites: config.sessionCheckSites,
  catalog,
  store,
  service,
  defaultTimeoutSeconds: config.defaultTimeoutSeconds,
  intervalMs: config.sessionCheckIntervalSeconds * 1000,
});
sessionMonitor.start();
const mcpHandler = createOpenCliMcpHandler({ config, catalog, service, store });

const server = createApiServer({
  config,
  catalog,
  store,
  service,
  mcpHandler,
  sessionMonitor,
  bridgeHealth: getBridgeHealth,
});
const address = await listen(server, config);
console.log(`[opencli-backend] listening on ${address.address}:${address.port}`);
console.log(`[opencli-backend] ${catalog.size} commands available; max concurrency ${config.maxConcurrency}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[opencli-backend] received ${signal}; preserving any active job as outcome_unknown`);
  sessionMonitor.stop();
  await mcpHandler.close();
  await closeServer(server, { force: true });
  // Do not classify an in-flight browser action as cancelled. Container shutdown
  // terminates the process tree and startup recovery marks it outcome_unknown.
  if (service.activeCount === 0) {
    await service.stop();
    store.close();
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
