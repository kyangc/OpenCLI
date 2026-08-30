import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommandCatalog } from '../src/command-catalog.mjs';

test('loads read commands from OpenCLI while keeping writes denied by default', async () => {
  const run = async (binary, args) => {
    assert.equal(binary, 'opencli-test');
    assert.deepEqual(args, ['list', '-f', 'json']);
    return {
      stdout: JSON.stringify([
        { site: 'twitter', name: 'search', access: 'read', browser: true, args: [] },
        { site: 'twitter', name: 'post', access: 'write', browser: true, args: [] },
      ]),
    };
  };

  const catalog = await loadCommandCatalog('opencli-test', { run });

  assert.equal(catalog.describe('twitter', 'search').access, 'read');
  assert.equal(catalog.describe('twitter', 'post'), null);
});

test('normalizes the site prefix emitted for local plugin commands', async () => {
  const catalog = await loadCommandCatalog('opencli-test', {
    run: async () => ({
      stdout: JSON.stringify([
        {
          site: 'travel-web',
          name: 'travel-web/google-maps-route',
          access: 'read',
          browser: true,
          args: [],
        },
        {
          site: 'travel-web',
          name: 'another-site/not-allowed',
          access: 'read',
          browser: true,
          args: [],
        },
      ]),
    }),
  });

  assert.equal(catalog.describe('travel-web', 'google-maps-route').access, 'read');
  assert.equal(catalog.describe('travel-web', 'travel-web/google-maps-route'), null);
  assert.equal(catalog.describe('travel-web', 'not-allowed'), null);
});
