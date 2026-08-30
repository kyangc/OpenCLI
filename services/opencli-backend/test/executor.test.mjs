import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecution } from '../src/executor.mjs';

const base = {
  exitCode: 0,
  signal: null,
  stdout: '[]',
  stderr: '',
  outputTruncated: false,
  durationMs: 10,
  timedOut: false,
  cancelRequested: false,
  spawnError: null,
};

test('maps OpenCLI authentication failures to needs_login', () => {
  assert.equal(classifyExecution({ ...base, exitCode: 77 }).status, 'needs_login');
});

test('does not retry or call a timed-out operation failed', () => {
  const result = classifyExecution({ ...base, exitCode: 75, timedOut: true });
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.errorCode, 'command_timeout');
});

test('closes a read-only timeout as a stable failure', () => {
  const result = classifyExecution(
    { ...base, exitCode: 75, timedOut: true },
    { access: 'read' },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'command_timeout');
});

test('keeps write timeouts outcome unknown', () => {
  const result = classifyExecution(
    { ...base, exitCode: 75, timedOut: true },
    { access: 'write' },
  );
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.errorCode, 'command_timeout');
});

test('fails closed when managed JSON output is truncated', () => {
  const result = classifyExecution({
    ...base,
    stdout: '[{"rank":1',
    outputTruncated: true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'output_truncated');
});

test('fails closed when a successful command returns invalid JSON', () => {
  const result = classifyExecution({ ...base, stdout: '[{"rank":1' });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'invalid_json_output');
});
