import test from 'node:test';
import assert from 'node:assert/strict';
import { jobResult } from '../src/job-view.mjs';

test('preserves the backend output contract across raw and enveloped CLI results', () => {
  for (const data of [[{ title: 'Example' }], [], null, { count: 1 }]) {
    for (const wire of [data, { ok: true, data }]) {
      const result = jobResult({ status: 'succeeded', stdout: JSON.stringify(wire) });
      assert.deepEqual(result.output, data);
    }
  }
});

test('retains failed envelopes, ordinary data objects, and non-JSON diagnostics', () => {
  for (const wire of [{ ok: false, error: { code: 'login_required' } }, { data: 'business value' }]) {
    assert.deepEqual(jobResult({ status: 'failed', stdout: JSON.stringify(wire) }).output, wire);
  }
  assert.equal(jobResult({ status: 'failed', stdout: 'diagnostic' }).output, 'diagnostic');
});
