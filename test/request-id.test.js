import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequestId, requestTime, REQUEST_MAX_AGE_MS, FUTURE_SKEW_MS } from '../src/request-id.js';

test('new request IDs preserve their creation time and have distinct secure random identities', () => {
  const before = Date.now();
  const ids = Array.from({ length: 1000 }, () => createRequestId());
  const after = Date.now();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(requestTime(id) >= before && requestTime(id) <= after);
    assert.equal(requestTime(id.toUpperCase()), requestTime(id));
  }
  assert.equal(REQUEST_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(FUTURE_SKEW_MS, 5 * 60 * 1000);
});

test('request timestamps reject legacy UUIDs and malformed versions or variants', () => {
  for (const id of [undefined, null, {}, '', randomUUID(), '00000000-0000-7000-0000-000000000000', '00000000-0000-6000-8000-000000000000', '00000000-0000-7000-8000-000000000000\n']) {
    assert.equal(requestTime(id), null);
  }
  assert.equal(requestTime('019a0000-0001-7000-8000-000000000000'), Number.parseInt('019a00000001', 16));
});
