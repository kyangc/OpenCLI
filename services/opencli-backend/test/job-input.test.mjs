import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCliArgv, InputError, validateJobInput } from '../src/job-input.mjs';
import { CommandCatalog } from '../src/command-catalog.mjs';

const config = {
  allowedCommands: new Set(['hackernews.top']),
  defaultTimeoutSeconds: 120,
  maxTimeoutSeconds: 300,
};

test('validates an allowed command and forces structured argv', () => {
  const request = validateJobInput({
    site: 'hackernews',
    command: 'top',
    args: ['--limit', '3'],
    profile: 'work',
  }, config);

  assert.deepEqual(buildOpenCliArgv(request), [
    '--profile', 'work', 'hackernews', 'top', '--limit', '3', '--format', 'json',
  ]);
});

test('rejects commands outside the allowlist', () => {
  assert.throws(
    () => validateJobInput({ site: 'browser', command: 'eval' }, config),
    (error) => error instanceof InputError && error.message.includes('not allowed'),
  );
});

test('rejects caller-controlled output formats', () => {
  assert.throws(
    () => validateJobInput({
      site: 'hackernews', command: 'top', args: ['--format', 'table'],
    }, config),
    InputError,
  );
});

test('requires structured params for dynamically discovered commands', () => {
  const catalog = new CommandCatalog([{
    site: 'twitter', name: 'search', access: 'read', browser: true, siteSession: null,
    args: [{ name: 'query', type: 'str', required: true, positional: true, choices: [] }],
  }]);
  assert.throws(
    () => validateJobInput({
      site: 'twitter', command: 'search', args: ['opencli'],
    }, {
      ...config,
      allowedCommands: new Set(),
      deniedArguments: new Set(['include-sensitive']),
    }, catalog),
    (error) => error instanceof InputError && error.message.includes('structured params'),
  );
});

test('rejects sensitive parameters even on read commands', () => {
  const catalog = new CommandCatalog([{
    site: '12306', name: 'me', access: 'read', browser: true, siteSession: null,
    args: [{
      name: 'include-sensitive', type: 'boolean', required: false, positional: false, choices: [],
    }],
  }]);
  assert.throws(
    () => validateJobInput({
      site: '12306', command: 'me', params: { 'include-sensitive': true },
    }, {
      ...config,
      allowedCommands: new Set(),
      deniedArguments: new Set(['include-sensitive']),
    }, catalog),
    (error) => error instanceof InputError && error.message.includes('not allowed'),
  );
});
