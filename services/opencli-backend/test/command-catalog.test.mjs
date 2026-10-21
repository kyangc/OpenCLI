import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommandCatalog } from '../src/command-catalog.mjs';

test('loads read commands from OpenCLI while keeping writes denied by default', async () => {
  const run = async (binary, args) => {
    assert.equal(binary, 'opencli-test');
    assert.deepEqual(args, ['list', '--full', '-f', 'json']);
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

test('loads the complete enveloped catalog with scheduling and argument metadata', async () => {
  const commands = Array.from({ length: 130 }, (_, index) => ({
    site: `site-${index}`, name: 'search', access: 'read', browser: true,
    siteSession: 'persistent', args: [{ name: 'query', positional: true, required: true }],
  }));
  const catalog = await loadCommandCatalog('opencli-test', {
    run: async () => ({ stdout: JSON.stringify({ ok: true, data: commands }) }),
  });
  assert.equal(catalog.size, 130);
  assert.equal(catalog.describe('site-129', 'search').args[0].name, 'query');
  assert.equal(catalog.schedulingFor({ site: 'site-129', command: 'search' }).resourceKey,
    'profile:default:site:site-129');
});

test('rejects a failed or paginated summary in place of the full catalog', async () => {
  for (const value of [
    { ok: false, error: { code: 'unavailable' } },
    { ok: true, data: { commands: [], total: 130, nextOffset: 25 } },
  ]) {
    await assert.rejects(loadCommandCatalog('opencli-test', {
      run: async () => ({ stdout: JSON.stringify(value) }),
    }), /catalog must be an array/);
  }
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
