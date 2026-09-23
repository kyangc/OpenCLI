import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandCatalog } from '../src/command-catalog.mjs';
import { JobStore } from '../src/store.mjs';
import { JobService } from '../src/service.mjs';
import { createApiServer, listen, closeServer } from '../src/http-server.mjs';
import { buildOpenCliArgv } from '../src/job-input.mjs';
import { classifyExecution } from '../src/executor.mjs';

test('discovers built twitter detail and preserves structured content across durable HTTP jobs', async () => {
    const commands = JSON.parse(readFileSync(new URL('../../../cli-manifest.json', import.meta.url), 'utf8'));
    const descriptor = commands.find(c => c.site === 'twitter' && c.name === 'detail');
    assert.ok(descriptor, 'build the current CLI manifest before running Backend tests');
    const catalog = new CommandCatalog([descriptor]);
    const directory = mkdtempSync(join(tmpdir(), 'opencli-detail-'));
    const store = new JobStore(join(directory, 'jobs.sqlite3'));
    const output = { schema_version: 1, root_id: '123', posts: { '123': { author: { avatar_url: 'https://pbs.twimg.com/a.jpg' }, media: [{ type: 'video', poster_url: null }], relations: [{ kind: 'reply', id: '9', state: 'unavailable' }] } }, warnings: [{ code: 'relation_unavailable' }] };
    let runs = 0;
    const executor = { async execute(job, { onSpawn }) {
        runs++;
        assert.deepEqual(buildOpenCliArgv(job.request), ['twitter', 'detail', '123', '--context-depth', '1', '--format', 'json']);
        onSpawn({ cancel() {} });
        return { exitCode: 0, stdout: JSON.stringify(output), stderr: '', outputTruncated: false, durationMs: 1 };
    } };
    const service = new JobService({ store, executor, catalog, pollIntervalMs: 5 });
    const config = { apiToken: 'test-token-at-least-24-characters', allowedCommands: new Set(), deniedArguments: new Set(), allowedOrigins: new Set(), defaultTimeoutSeconds: 30, maxTimeoutSeconds: 120 };
    const server = createApiServer({ config, catalog, store, service, bridgeHealth: async () => ({ ready: true }) });
    service.start();
    const address = await listen(server, { host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'detail-1' };
    try {
        const command = await (await fetch(`${base}/v1/commands/twitter/detail`, { headers })).json();
        assert.ok(JSON.stringify(command).includes('context-depth'));
        const body = JSON.stringify({ site: 'twitter', command: 'detail', params: { 'tweet-id': '123', 'context-depth': 1 } });
        const first = await (await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body })).json();
        await service.waitForIdle();
        const duplicate = await (await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body })).json();
        assert.equal(first.job.id, duplicate.job.id); assert.equal(runs, 1);
        const result = await (await fetch(`${base}/v1/jobs/${first.job.id}/result`, { headers })).json();
        assert.equal(result.status, 'succeeded'); assert.deepEqual(result.output, output);
    } finally {
        await closeServer(server); await service.stop(); store.close(); rmSync(directory, { recursive: true });
    }
});

test('a truncated detail is never a successful result, even if its remaining JSON parses', () => {
    assert.equal(classifyExecution({ exitCode: 0, stdout: '{}', stderr: '', outputTruncated: true }, { access: 'read' }).errorCode, 'output_truncated');
});
