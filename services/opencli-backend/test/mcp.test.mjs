import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CommandCatalog } from '../src/command-catalog.mjs';
import { JobStore } from '../src/store.mjs';
import { JobService } from '../src/service.mjs';
import { closeServer, createApiServer, listen } from '../src/http-server.mjs';
import { createOpenCliMcpHandler } from '../src/mcp.mjs';

class ImmediateExecutor {
  async execute(_job, { onSpawn }) {
    onSpawn({ cancel() {} });
    return {
      exitCode: 0,
      signal: null,
      stdout: '[{"title":"example"}]',
      stderr: '',
      outputTruncated: false,
      durationMs: 1,
      timedOut: false,
      cancelRequested: false,
      spawnError: null,
    };
  }
}

test('exposes a small searchable MCP tool surface instead of one tool per command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-mcp-'));
  const store = new JobStore(join(directory, 'jobs.sqlite3'));
  const catalog = new CommandCatalog([
    {
      site: 'hackernews', name: 'top', description: 'List top stories',
      access: 'read', strategy: 'public', browser: false, siteSession: null,
      args: [], columns: ['title'],
    },
    {
      site: 'twitter', name: 'search', description: 'Search public posts',
      access: 'read', strategy: 'cookie', browser: true, siteSession: null,
      args: [{ name: 'query', type: 'str', required: true, positional: true, choices: [] }],
    },
  ]);
  const config = {
    apiToken: 'test-token-with-at-least-24-characters',
    agentCredentials: [{
      id: 'catalog-agent',
      token: 'catalog-token-with-at-least-24-characters',
      scopes: new Set(['commands:read']),
    }],
    allowedCommands: new Set(),
    deniedArguments: new Set(['include-sensitive']),
    allowedOrigins: new Set(),
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    maxWaitSeconds: 30,
  };
  const service = new JobService({
    store, executor: new ImmediateExecutor(), catalog, maxConcurrency: 2, pollIntervalMs: 5,
  });
  const mcpHandler = createOpenCliMcpHandler({ config, catalog, service, store });
  const server = createApiServer({
    config, catalog, store, service, mcpHandler,
    bridgeHealth: async () => ({ ready: true, extensionConnected: true }),
  });

  service.start();
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { authProvider: { token: async () => config.apiToken } },
  );
  const client = new Client(
    { name: 'opencli-backend-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const catalogTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { authProvider: { token: async () => config.agentCredentials[0].token } },
  );
  const catalogClient = new Client(
    { name: 'opencli-catalog-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'opencli_cancel_job',
      'opencli_describe_command',
      'opencli_get_job',
      'opencli_run',
      'opencli_search_commands',
    ]);
    const runTool = tools.tools.find((tool) => tool.name === 'opencli_run');
    assert.equal(runTool.annotations.readOnlyHint, true);
    assert.equal(runTool.annotations.destructiveHint, false);

    const result = await client.callTool({
      name: 'opencli_search_commands',
      arguments: { query: 'top stories', limit: 5 },
    });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.total, 1);
    assert.equal(result.structuredContent.commands[0].command, 'top');

    const run = await client.callTool({
      name: 'opencli_run',
      arguments: {
        site: 'hackernews',
        command: 'top',
        params: {},
        waitTimeoutSeconds: 5,
        idempotencyKey: 'mcp-run-test-1',
      },
    });
    assert.equal(run.isError, false);
    assert.equal(run.structuredContent.job.status, 'succeeded');
    assert.deepEqual(run.structuredContent.result.output, [{ title: 'example' }]);

    const fetched = await client.callTool({
      name: 'opencli_get_job',
      arguments: { jobId: run.structuredContent.job.id },
    });
    assert.equal(fetched.structuredContent.job.status, 'succeeded');

    await catalogClient.connect(catalogTransport);
    const scopedTools = await catalogClient.listTools();
    assert.deepEqual(scopedTools.tools.map((tool) => tool.name).sort(), [
      'opencli_describe_command',
      'opencli_search_commands',
    ]);
  } finally {
    await catalogClient.close();
    await client.close();
    await mcpHandler.close();
    await closeServer(server);
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true });
  }
});
