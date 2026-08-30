import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';

test('defaults to dynamic read discovery with two concurrent jobs', () => {
  const config = loadConfig({
    OPENCLI_API_TOKEN: 'test-token-with-at-least-24-characters',
  });

  assert.equal(config.autoAllowReads, true);
  assert.equal(config.maxConcurrency, 2);
  assert.equal(config.maxWaitSeconds, 120);
  assert.equal(config.maxQueuedJobs, 100);
  assert.equal(config.maxSubmissionsPerMinute, 60);
  assert.equal(config.watchdogGraceSeconds, 30);
  assert.equal(config.sessionCheckIntervalSeconds, 900);
  assert.deepEqual([...config.sessionCheckSites], []);
  assert.equal(config.allowedCommands.size, 0);
  assert.deepEqual([...config.deniedArguments], [
    'include-sensitive', 'token', 'password', 'secret', 'cookie',
  ]);
});

test('loads scoped agent credentials from a secret JSON file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencli-agent-config-'));
  const path = join(directory, 'agents.json');
  writeFileSync(path, JSON.stringify({
    agents: [{
      id: 'research-agent',
      token: 'research-token-with-at-least-24-characters',
      scopes: ['commands:read', 'jobs:submit', 'jobs:read'],
    }],
  }));
  try {
    const config = loadConfig({
      OPENCLI_API_TOKEN: 'test-token-with-at-least-24-characters',
      OPENCLI_AGENT_TOKENS_FILE: path,
    });

    assert.equal(config.agentCredentials.length, 1);
    assert.equal(config.agentCredentials[0].id, 'research-agent');
    assert.deepEqual([...config.agentCredentials[0].scopes], [
      'commands:read', 'jobs:submit', 'jobs:read',
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
