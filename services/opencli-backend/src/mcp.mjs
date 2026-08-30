import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { hasScope } from './auth.mjs';
import { InputError, validateJobInput } from './job-input.mjs';
import { jobResult, publicJob } from './job-view.mjs';
import { ServiceError } from './service.mjs';
import { TERMINAL_STATUSES } from './store.mjs';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const paramValue = z.union([z.string(), z.number(), z.boolean()]);

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function toolError(code, message, retryable = false, details = {}) {
  return toolResult({ error: { code, message, retryable, ...details } }, true);
}

function buildServer({ config, catalog, service, principal }) {
  const server = new McpServer(
    { name: 'opencli-backend', version: '0.3.0' },
    { capabilities: { tools: { listChanged: false } } },
  );

  const actor = {
    agentId: principal?.id ?? 'anonymous',
    isAdmin: principal?.isAdmin ?? false,
    source: 'mcp',
  };

  if (hasScope(principal, 'commands:read')) server.registerTool('opencli_search_commands', {
    title: 'Search OpenCLI commands',
    description: 'Search the allowed OpenCLI command catalog by intent. Use this before describe or run when the site and command are not already known.',
    inputSchema: z.object({
      query: z.string().max(500).default(''),
      site: z.string().regex(NAME_PATTERN).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, site, limit }) => toolResult(catalog.list({
    query,
    site: site ?? null,
    limit,
    offset: 0,
  })));

  if (hasScope(principal, 'commands:read')) server.registerTool('opencli_describe_command', {
    title: 'Describe an OpenCLI command',
    description: 'Return parameters, output columns, browser/session behavior, strategy, domain, and example for one allowed command.',
    inputSchema: z.object({
      site: z.string().regex(NAME_PATTERN),
      command: z.string().regex(NAME_PATTERN),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ site, command }) => {
    const definition = catalog.describe(site, command);
    return definition
      ? toolResult({ command: definition })
      : toolError('command_not_found', `command ${site}.${command} is not available`);
  });

  if (hasScope(principal, 'jobs:submit')) server.registerTool('opencli_run', {
    title: 'Run an OpenCLI command',
    description: 'Submit an allowed command to the durable queue and wait for a bounded time. A timed-out wait returns a job ID; it does not cancel the job.',
    inputSchema: z.object({
      site: z.string().regex(NAME_PATTERN),
      command: z.string().regex(NAME_PATTERN),
      params: z.record(z.string(), paramValue).default({}),
      profile: z.string().min(1).max(64).optional(),
      timeoutSeconds: z.number().int().min(1).max(config.maxTimeoutSeconds).optional(),
      waitTimeoutSeconds: z.number().int().min(1).max(config.maxWaitSeconds).default(
        Math.min(60, config.maxWaitSeconds),
      ),
      idempotencyKey: z.string().regex(IDEMPOTENCY_PATTERN).optional(),
    }),
    annotations: {
      readOnlyHint: !catalog.hasWriteCommands,
      destructiveHint: catalog.hasWriteCommands,
      idempotentHint: !catalog.hasWriteCommands,
      openWorldHint: true,
    },
  }, async (input) => {
    let request;
    try {
      request = validateJobInput({
        site: input.site,
        command: input.command,
        params: input.params,
        profile: input.profile ?? null,
        timeoutSeconds: input.timeoutSeconds,
      }, config, catalog);
    } catch (error) {
      if (error instanceof InputError) {
        return toolError(error.code, error.message, error.retryable, {
          ...(error.field ? { field: error.field } : {}),
        });
      }
      throw error;
    }
    let submitted;
    try {
      submitted = service.submit(request, input.idempotencyKey ?? null, actor);
    } catch (error) {
      if (error instanceof ServiceError) {
        return toolError(error.code, error.message, error.retryable, {
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        });
      }
      throw error;
    }
    const job = await service.waitForTerminal(
      submitted.job.id,
      input.waitTimeoutSeconds * 1000,
    );
    if (job && TERMINAL_STATUSES.has(job.status)) {
      return toolResult({
        created: submitted.created,
        job: publicJob(job),
        result: jobResult(job),
      }, job.status !== 'succeeded');
    }
    return toolResult({
      created: submitted.created,
      job: publicJob(job ?? submitted.job),
      waitTimedOut: true,
    });
  });

  if (hasScope(principal, 'jobs:read')) server.registerTool('opencli_get_job', {
    title: 'Get an OpenCLI job',
    description: 'Get durable job status and include the result when the job is terminal.',
    inputSchema: z.object({ jobId: z.string().min(1).max(128) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    const job = service.get(jobId, actor);
    if (!job) return toolError('job_not_found', `job ${jobId} was not found`);
    return toolResult({
      job: publicJob(job),
      ...(TERMINAL_STATUSES.has(job.status) ? { result: jobResult(job) } : {}),
    });
  });

  if (hasScope(principal, 'jobs:cancel')) server.registerTool('opencli_cancel_job', {
    title: 'Cancel an OpenCLI job',
    description: 'Cancel a queued or active durable job. Cancellation is best-effort for an active browser operation.',
    inputSchema: z.object({ jobId: z.string().min(1).max(128) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    const job = service.cancel(jobId, actor);
    return job
      ? toolResult({ job: publicJob(job) })
      : toolError('job_not_found', `job ${jobId} was not found`);
  });

  return server;
}

export function createOpenCliMcpHandler(dependencies) {
  return createMcpHandler(
    ({ authInfo } = {}) => buildServer({
      ...dependencies,
      principal: authInfo?.principal ?? null,
    }),
    {
      responseMode: 'json',
      onerror: (error) => console.error('[mcp] request failed', error),
    },
  );
}
