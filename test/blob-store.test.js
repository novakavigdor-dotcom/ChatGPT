import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobStore, verifiedBlobsFetch } from '../server/blob-store.js';
import { emptyStore } from '../server/store.js';
import { REQUEST_MAX_AGE_MS } from '../src/request-id.js';

// Same conditional-write contract as @netlify/blobs; shared by independent clients.
class MemoryBlobs {
  constructor(state = null) { this.state = structuredClone(state); this.version = state ? 1 : 0; this.writes = []; }
  async getWithMetadata(key, options) {
    assert.equal(options.consistency, 'strong');
    assert.equal(options.type, 'json');
    return this.state ? { data: structuredClone(this.state), etag: `"${this.version}"`, metadata: {} } : null;
  }
  async setJSON(key, state, options) {
    this.writes.push(options);
    const matches = options.onlyIfNew ? !this.state : options.onlyIfMatch === `"${this.version}"`;
    if (!matches) return { modified: false };
    this.state = structuredClone(state);
    this.version += 1;
    return { modified: true, etag: `"${this.version}"` };
  }
}
const client = (blobs, options = {}) => new BlobStore({ blobs, retryDelay: async () => {}, ...options });

test('Blobs state persists between clients and reads do not mutate the stored record', async () => {
  const blobs = new MemoryBlobs();
  const first = client(blobs);
  assert.deepEqual(await first.read((state) => state), emptyStore());
  assert.equal(blobs.writes.length, 0);
  await first.transaction((state) => { state.customers.one = { id: 'one' }; });
  assert.deepEqual(blobs.writes[0], { onlyIfNew: true });
  const second = client(blobs);
  const record = await second.read((state) => state);
  record.customers.one.id = 'modified outside transaction';
  assert.equal(await first.read((state) => state.customers.one.id), 'one');
  await second.transaction((state) => { state.customers.two = { id: 'two' }; });
  assert.deepEqual(blobs.writes[1], { onlyIfMatch: '"1"' });
  assert.equal(await first.read((state) => Object.keys(state.customers).length), 2);
});

test('concurrent serverless clients do not lose independent updates', async () => {
  const blobs = new MemoryBlobs();
  await Promise.all(Array.from({ length: 20 }, (_, index) => client(blobs, { maxAttempts: 32 })
    .transaction((state) => { state.customers[index] = { id: String(index) }; })));
  assert.equal(Object.keys(blobs.state.customers).length, 20);
  assert.ok(blobs.writes.length > 20, 'the test must exercise actual compare-and-swap conflicts');
});

test('conflicted transactions rerun against committed state and return the final callback result', async () => {
  const blobs = new MemoryBlobs(emptyStore());
  const originalSet = blobs.setJSON.bind(blobs);
  let firstWrite = true;
  blobs.setJSON = async (...args) => {
    if (firstWrite) {
      firstWrite = false;
      blobs.state.customers.external = { id: 'external' };
      blobs.version += 1;
      return { modified: false };
    }
    return originalSet(...args);
  };
  let callbacks = 0;
  const returned = await client(blobs).transaction((state) => {
    callbacks += 1;
    state.customers.local = { id: 'local' };
    return callbacks;
  });
  assert.equal(returned, 2);
  assert.deepEqual(Object.keys(blobs.state.customers).sort(), ['external', 'local']);
});

test('failed callbacks and failed conditional writes are never acknowledged as commits', async () => {
  const blobs = new MemoryBlobs(emptyStore());
  const before = structuredClone(blobs.state);
  await assert.rejects(client(blobs).transaction((state) => {
    state.owner = { shouldNotBeSaved: true };
    throw new Error('validation failed');
  }), /validation failed/);
  assert.deepEqual(blobs.state, before);
  assert.equal(blobs.writes.length, 0);
  blobs.setJSON = async () => ({ modified: true, etag: '' });
  await assert.rejects(client(blobs).transaction(() => 42), { status: 503 });
});

test('CAS exhaustion and provider failures fail closed without silently overwriting data', async () => {
  const blobs = new MemoryBlobs(emptyStore());
  let writes = 0;
  blobs.setJSON = async () => { writes += 1; return { modified: false }; };
  await assert.rejects(client(blobs, { maxAttempts: 3 }).transaction(() => {}), { status: 503 });
  assert.equal(writes, 3);
  const providerError = new Error('provider failed');
  blobs.getWithMetadata = async () => { throw providerError; };
  await assert.rejects(client(blobs).read(() => {}), (error) => error === providerError);
});

test('upstream HTTP errors with an ETag cannot masquerade as successful conditional writes', async () => {
  const failedFetch = verifiedBlobsFetch(async () => new Response('storage failure', { status: 500, headers: { ETag: 'error-document-etag' } }));
  await assert.rejects(failedFetch('https://storage.example/record', { method: 'put' }), { status: 503 });
  const conflict = new Response(null, { status: 412 });
  const conflictFetch = verifiedBlobsFetch(async () => conflict);
  assert.equal(await conflictFetch('https://storage.example/record', { method: 'PUT' }), conflict);
  const success = new Response(null, { status: 200, headers: { ETag: 'new-version' } });
  assert.equal(await verifiedBlobsFetch(async () => success)('https://storage.example/record', { method: 'PUT' }), success);
});

test('CAS retries prune expired state from the latest snapshot and preserve concurrent session renewals', async () => {
  const now = Date.now();
  const state = emptyStore();
  state.sessions.expired = { expires: now - 1 };
  state.authAttempts.old = { since: now - 16 * 60 * 1000 };
  state.requests.old = { date: new Date(now - REQUEST_MAX_AGE_MS - 60000).toISOString() };
  state.requests.recent = { date: new Date(now).toISOString() };
  const blobs = new MemoryBlobs(state);
  const originalSet = blobs.setJSON.bind(blobs);
  let first = true;
  blobs.setJSON = async (...args) => {
    if (first) {
      first = false;
      blobs.state.sessions.expired.expires = now + 60000;
      blobs.version += 1;
      return { modified: false };
    }
    return originalSet(...args);
  };
  let calls = 0;
  await client(blobs).transaction((next) => {
    calls += 1;
    assert.equal(next.requests.old, undefined);
    assert.equal(next.authAttempts.old, undefined);
    assert.equal(Boolean(next.sessions.expired), calls > 1);
    next.customers.saved = { id: 'saved' };
  });
  assert.equal(calls, 2);
  assert.equal(blobs.state.sessions.expired.expires, now + 60000);
  assert.equal(blobs.state.requests.old, undefined);
  assert.ok(blobs.state.requests.recent);
  assert.ok(blobs.state.customers.saved);
});
