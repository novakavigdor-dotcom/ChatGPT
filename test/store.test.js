import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, emptyStore, pruneExpiredState } from '../server/store.js';
import { REQUEST_MAX_AGE_MS } from '../src/request-id.js';

function oldState(now = Date.now()) {
  const state = emptyStore();
  state.sessions = { expired: { expires: now - 1 }, invalid: {}, live: { expires: now + 60000 } };
  state.authAttempts = { old: { since: now - 15 * 60 * 1000 }, invalid: {}, live: { since: now } };
  state.requests = {
    old: { operation: 'award', date: new Date(now - REQUEST_MAX_AGE_MS - 60000).toISOString() },
    recent: { operation: 'remove', date: new Date(now).toISOString() },
    unknownAge: { fingerprint: 'legacy receipt without a reliable date' },
  };
  state.customers.one = { corrections: [{ date: new Date(now - REQUEST_MAX_AGE_MS - 60000).toISOString(), categories: ['maki'] }] };
  return state;
}

test('receipt cleanup keeps the retry boundary and audit history intact', () => {
  const now = Date.now();
  const state = oldState(now);
  state.requests.boundary = { date: new Date(now - REQUEST_MAX_AGE_MS).toISOString() };
  const audit = structuredClone(state.customers.one.corrections);
  pruneExpiredState(state, now);
  assert.deepEqual(Object.keys(state.sessions), ['live']);
  assert.deepEqual(Object.keys(state.authAttempts), ['live']);
  assert.deepEqual(Object.keys(state.requests).sort(), ['boundary', 'recent', 'unknownAge']);
  assert.deepEqual(state.customers.one.corrections, audit);
});

test('a future-skewed UUID cannot outlive the receipt that prevents its replay', () => {
  const now = Date.now();
  const timestamp = (now - REQUEST_MAX_AGE_MS + 60000).toString(16).padStart(12, '0');
  const id = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000000`;
  const state = emptyStore();
  state.requests[id] = { date: new Date(now - REQUEST_MAX_AGE_MS - 60000).toISOString() };
  pruneExpiredState(state, now);
  assert.ok(state.requests[id], 'keep the receipt while the request ID is still acceptable');
  pruneExpiredState(state, now + 120000);
  assert.equal(state.requests[id], undefined);
});

test('an ordinary local transaction removes expired state and persists cleanup atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'umami-store-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.transaction((state) => Object.assign(state, oldState()));
  await assert.rejects(store.transaction((state) => {
    assert.equal(state.requests.old, undefined);
    assert.equal(state.sessions.expired, undefined);
    throw new Error('save failed');
  }), /save failed/);
  assert.ok(JSON.parse(await readFile(store.path, 'utf8')).requests.old, 'a failed callback must not commit cleanup');
  await store.transaction((state) => { state.customers.one.name = 'Saved customer'; });
  const stored = JSON.parse(await readFile(store.path, 'utf8'));
  assert.deepEqual(Object.keys(stored.sessions), ['live']);
  assert.deepEqual(Object.keys(stored.authAttempts), ['live']);
  assert.deepEqual(Object.keys(stored.requests).sort(), ['recent', 'unknownAge']);
  assert.equal(stored.customers.one.name, 'Saved customer');
  assert.equal(stored.customers.one.corrections.length, 1);
});
