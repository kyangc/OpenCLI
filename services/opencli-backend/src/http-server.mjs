import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAuthenticator, hasScope } from './auth.mjs';
import { InputError, validateJobInput } from './job-input.mjs';
import { jobResult, publicJob } from './job-view.mjs';
import { ServiceError } from './service.mjs';
import { TERMINAL_STATUSES } from './store.mjs';
import { renderMetrics } from './metrics.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(payload);
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new InputError('request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('request body must be valid JSON');
  }
}

function idempotencyKey(request) {
  const value = request.headers['idempotency-key'] ?? null;
  if (value !== null && (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value))) {
    throw new InputError('Idempotency-Key contains unsupported characters');
  }
  return value;
}

function submitJob(request, response, service, validated, actor) {
  const result = service.submit(validated, idempotencyKey(request), actor);
  sendJson(response, result.created ? 202 : 200, {
    created: result.created,
    job: publicJob(result.job),
  });
}

function requestedWaitMs(url, config) {
  const wait = url.searchParams.get('wait');
  if (wait === null || wait === 'false') return null;
  if (wait !== 'true') throw new InputError('wait must be true or false');
  const maxWaitSeconds = config.maxWaitSeconds ?? 120;
  const rawSeconds = Number(url.searchParams.get('waitTimeoutSeconds') ?? maxWaitSeconds);
  if (!Number.isInteger(rawSeconds) || rawSeconds <= 0 || rawSeconds > maxWaitSeconds) {
    throw new InputError(`waitTimeoutSeconds must be an integer between 1 and ${maxWaitSeconds}`);
  }
  return rawSeconds * 1000;
}

function pagination(url) {
  const rawLimit = Number(url.searchParams.get('limit') ?? 100);
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  return {
    limit: Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 500 ? rawLimit : 100,
    offset: Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
  };
}

function webRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }
  return new Request(new URL(request.url ?? '/mcp', 'http://localhost'), init);
}

async function sendWebResponse(response, webResponse) {
  const headers = Object.fromEntries(webResponse.headers.entries());
  response.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    response.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(webResponse.body), response);
  } catch (error) {
    if (!response.destroyed) throw error;
  }
}

export function createApiServer({
  config,
  catalog = null,
  store,
  service,
  mcpHandler = null,
  sessionMonitor = null,
  bridgeHealth,
}) {
  const authenticate = createAuthenticator(config);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.has(origin)) {
        sendJson(response, 403, { error: 'origin_not_allowed' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health/live') {
        sendJson(response, 200, { status: 'alive' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health/ready') {
        const bridge = await bridgeHealth();
        const control = service.controlState();
        const ready = bridge.ready && !control.paused;
        sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          bridge,
          queue: control,
        });
        return;
      }

      const principal = authenticate(request.headers.authorization);
      if (!principal) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const actor = { agentId: principal.id, isAdmin: principal.isAdmin, source: 'rest' };
      const requireScope = (scope) => {
        if (hasScope(principal, scope)) return true;
        sendJson(response, 403, { error: 'forbidden', requiredScope: scope });
        return false;
      };

      if (request.method === 'GET' && url.pathname === '/metrics') {
        if (!requireScope('metrics:read')) return;
        const bridge = await bridgeHealth();
        sendText(response, 200, renderMetrics({
          service, store, catalog, bridge, sessionMonitor,
        }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/sessions' && sessionMonitor) {
        if (!requireScope('sessions:read')) return;
        sendJson(response, 200, { sessions: sessionMonitor.status() });
        return;
      }

      if (url.pathname === '/mcp' && mcpHandler) {
        const mcpResponse = await mcpHandler.fetch(webRequest(request), {
          authInfo: { principal },
        });
        await sendWebResponse(response, mcpResponse);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/jobs') {
        if (!requireScope('jobs:submit')) return;
        const body = await readJson(request);
        const validated = validateJobInput(body, config, catalog);
        const waitMs = requestedWaitMs(url, config);
        if (waitMs === null) {
          submitJob(request, response, service, validated, actor);
          return;
        }
        const result = service.submit(validated, idempotencyKey(request), actor);
        const job = await service.waitForTerminal(result.job.id, waitMs);
        if (job && TERMINAL_STATUSES.has(job.status)) {
          sendJson(response, 200, {
            created: result.created,
            job: publicJob(job),
            result: jobResult(job),
          });
        } else {
          sendJson(response, 202, {
            created: result.created,
            job: publicJob(job ?? result.job),
            waitTimedOut: true,
          });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/commands' && catalog) {
        if (!requireScope('commands:read')) return;
        const site = url.searchParams.get('site');
        const query = url.searchParams.get('q') ?? '';
        sendJson(response, 200, catalog.list({ site, query, ...pagination(url) }));
        return;
      }

      const commandMatch = url.pathname.match(
        /^\/v1\/commands\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})$/,
      );
      if (request.method === 'GET' && commandMatch && catalog) {
        if (!requireScope('commands:read')) return;
        const command = catalog.describe(commandMatch[1], commandMatch[2]);
        sendJson(response, command ? 200 : 404, command ?? { error: 'command_not_found' });
        return;
      }

      const sessionCheckMatch = url.pathname.match(
        /^\/v1\/sites\/([a-z0-9][a-z0-9-]{0,63})\/session-check$/,
      );
      if (request.method === 'POST' && sessionCheckMatch) {
        if (!requireScope('jobs:submit')) return;
        const validated = validateJobInput({
          site: sessionCheckMatch[1],
          command: 'whoami',
        }, config, catalog);
        submitJob(request, response, service, validated, { ...actor, purpose: 'session_check' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/jobs') {
        if (!requireScope('jobs:read')) return;
        const rawLimit = Number(url.searchParams.get('limit') ?? 50);
        const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100 ? rawLimit : 50;
        sendJson(response, 200, { jobs: service.list(limit, actor).map(publicJob) });
        return;
      }

      const resultMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/result$/i);
      if (request.method === 'GET' && resultMatch) {
        if (!requireScope('jobs:read')) return;
        const job = service.get(resultMatch[1], actor);
        if (!job) {
          sendJson(response, 404, { error: 'job_not_found' });
        } else if (!TERMINAL_STATUSES.has(job.status)) {
          sendJson(response, 409, { error: 'job_not_finished', status: job.status });
        } else {
          sendJson(response, 200, jobResult(job));
        }
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === 'POST' && cancelMatch) {
        if (!requireScope('jobs:cancel')) return;
        const job = service.cancel(cancelMatch[1], actor);
        sendJson(response, job ? 202 : 404, job ? { job: publicJob(job) } : { error: 'job_not_found' });
        return;
      }

      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && jobMatch) {
        if (!requireScope('jobs:read')) return;
        const job = service.get(jobMatch[1], actor);
        sendJson(response, job ? 200 : 404, job ? { job: publicJob(job) } : { error: 'job_not_found' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/control') {
        if (!requireScope('control:write')) return;
        sendJson(response, 200, service.controlState());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/control/pause') {
        if (!requireScope('control:write')) return;
        sendJson(response, 200, service.pause(actor));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/control/resume') {
        if (!requireScope('control:write')) return;
        sendJson(response, 200, service.resume(actor));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/audit') {
        if (!requireScope('audit:read')) return;
        const rawLimit = Number(url.searchParams.get('limit') ?? 100);
        const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 500 ? rawLimit : 100;
        sendJson(response, 200, { events: store.listAudit(limit) });
        return;
      }

      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof InputError) {
        sendJson(response, 400, {
          error: 'invalid_request',
          code: error.code,
          ...(error.field ? { field: error.field } : {}),
          message: error.message,
          retryable: error.retryable,
        });
      } else if (error instanceof ServiceError) {
        sendJson(response, error.httpStatus, {
          error: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        }, error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {});
      } else {
        console.error('[api] request failed', error);
        if (response.headersSent || response.destroyed) response.destroy();
        else sendJson(response, 500, { error: 'internal_error' });
      }
    }
  });
}

export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

export function closeServer(server, { force = false } = {}) {
  return new Promise((resolve) => {
    server.close(resolve);
    if (force) server.closeAllConnections();
  });
}
