import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { BlobStore } from '../server/blob-store.js';
import { createNetlifyHandler } from '../server/netlify-handler.js';
import { createRequestId, REQUEST_MAX_AGE_MS, FUTURE_SKEW_MS } from '../src/request-id.js';

const ownerPassword = 'audit-test-password-only';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umami-audit-'));
  const app = await createApp({ dataDir, ownerPassword, ownerAccessRecord: null });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const customer = (firstName, email = `${firstName.toLowerCase()}@example.test`) => request('/api/customer', {
    method: 'POST', body: { firstName, lastName: 'Guest', email },
  });
  const owner = () => request('/api/owner/login', { method: 'POST', body: { password: ownerPassword } });
  const award = (cookie, code, requestId = createRequestId()) => request('/api/owner/stamps', {
    method: 'POST', cookie, body: { code, categories: ['maki'], directOrder: true, requestId },
  });
  return { request, customer, owner, award, store: app.store };
}

function requestIdAt(timestamp) {
  const id = createRequestId();
  const prefix = timestamp.toString(16).padStart(12, '0');
  return `${prefix.slice(0, 8)}-${prefix.slice(8)}${id.slice(13)}`;
}

test('owner customer search is protected, bounded and normalizes name and email searches', async t => {
  const app = await fixture(t);
  const customer = await app.customer('Ａｄａ', 'ada@example.test');
  const owner = await app.owner();
  assert.equal(owner.status, 200);
  const search = (query, cookie = owner.cookie) => app.request(`/api/owner/customers?q=${encodeURIComponent(query)}`, { cookie });
  assert.equal((await app.request('/api/owner/customers?q=ada')).status, 401);
  assert.equal((await search('ada', customer.cookie)).status, 401);
  for (const query of ['', 'a', '　　', 'x'.repeat(121)]) assert.equal((await search(query)).status, 400);
  for (const query of [' ADA ', 'ＡＤＡ', 'ADA@EXAMPLE.TEST']) {
    const result = await search(query);
    assert.equal(result.status, 200);
    assert.equal(result.value.customers.length, 1);
    assert.equal(result.value.customers[0].id, customer.value.customer.id);
    assert.deepEqual(Object.keys(result.value.customers[0]).sort(), ['code', 'email', 'id', 'name']);
  }
  assert.deepEqual((await search('no-such-customer')).value.customers, []);
  await app.store.transaction(state => {
    for (let index = 0; index < 25; index += 1) {
      const id = randomUUID();
      state.customers[id] = {
        ...structuredClone(customer.value.customer), id,
        firstName: 'Searchmatch', name: `Searchmatch ${index}`, email: `searchmatch-${index}@example.test`,
        code: String(index).padStart(32, '0'),
        orders: [{ id: 'private-visit', date: new Date().toISOString() }],
        corrections: [{ id: 'private-correction' }], recoveryHash: 'private-test-marker',
      };
    }
  });
  const bounded = await search('searchmatch');
  assert.equal(bounded.status, 200);
  assert.equal(bounded.value.customers.length, 20);
  for (const entry of bounded.value.customers) assert.deepEqual(Object.keys(entry).sort(), ['code', 'email', 'id', 'name']);
  assert.equal(JSON.stringify(bounded.value).includes('private-'), false);
});

test('thirty distinct parallel confirmations of one square produce one stamp and one direct visit', async t => {
  const app = await fixture(t);
  const customer = await app.customer('ConcurrentAudit');
  const owner = await app.owner();
  const results = await Promise.all(Array.from({ length: 30 }, () => app.award(owner.cookie, customer.value.customer.code)));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(results.reduce((sum, result) => sum + result.value.earned.length, 0), 1);
  const saved = (await app.request('/api/customer', { cookie: customer.cookie })).value.customer;
  assert.deepEqual(Object.keys(saved.stamps), ['maki']);
  assert.equal(saved.orders.length, 1);
  assert.equal(saved.directOrders, 1);
});

test('expired request IDs and unknown legacy IDs cannot award stamps, while known legacy receipts replay safely', async t => {
  const app = await fixture(t);
  const customer = await app.customer('ExpiryAudit');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  const currentId = createRequestId();
  assert.equal((await app.award(owner.cookie, code, currentId)).status, 200);
  const legacyId = randomUUID();
  await app.store.transaction(state => {
    state.requests[legacyId] = structuredClone(state.requests[currentId]);
  });
  const replay = await app.award(owner.cookie, code, legacyId);
  assert.equal(replay.status, 200);
  assert.equal(replay.value.repeated, true);
  assert.equal(replay.value.customer.orders.length, 1);
  assert.equal((await app.award(owner.cookie, code, randomUUID())).status, 409);
  assert.equal((await app.award(owner.cookie, code, requestIdAt(Date.now() + FUTURE_SKEW_MS + 60_000))).status, 400);
  const oldTime = Date.now() - REQUEST_MAX_AGE_MS - 60_000;
  const oldId = requestIdAt(oldTime);
  await app.store.transaction(state => {
    state.requests[oldId] = { ...structuredClone(state.requests[currentId]), date: new Date(oldTime).toISOString() };
    delete state.customers[customer.value.customer.id].stamps.maki;
  });
  // A later transaction performs routine receipt cleanup before the retry arrives.
  await app.store.transaction(() => {});
  assert.equal(await app.store.read(state => state.requests[oldId]), undefined);
  assert.equal((await app.award(owner.cookie, code, oldId)).status, 410);
  const after = (await app.request('/api/customer', { cookie: customer.cookie })).value.customer;
  assert.deepEqual(after.stamps, {});
  assert.equal(after.orders.length, 1);
  assert.equal(after.directOrders, 1);
});

test('customer failures are scoped by email and successful sign-ins reset their failure budget', async t => {
  const app = await fixture(t);
  await app.customer('AliceAudit');
  await app.customer('BobAudit');
  const login = (email, lastName = 'Guest') => app.request('/api/customer/login', { method: 'POST', body: { email, lastName } });
  for (let index = 0; index < 11; index += 1) assert.equal((await login('aliceaudit@example.test', 'Wrong')).status, 401);
  for (let index = 0; index < 15; index += 1) assert.equal((await login('bobaudit@example.test')).status, 200);
  assert.equal((await login('aliceaudit@example.test')).status, 200);
  for (let index = 0; index < 12; index += 1) assert.equal((await login('aliceaudit@example.test', 'Wrong')).status, 401);
  assert.equal((await login('aliceaudit@example.test', 'Wrong')).status, 429);
  assert.equal((await login('bobaudit@example.test')).status, 200);
});

test('successful owner sign-ins do not consume the failed-login budget', async t => {
  const app = await fixture(t);
  for (let index = 0; index < 15; index += 1) assert.equal((await app.owner()).status, 200);
  const wrong = () => app.request('/api/owner/login', { method: 'POST', body: { password: 'wrong-audit-password' } });
  for (let index = 0; index < 11; index += 1) assert.equal((await wrong()).status, 401);
  assert.equal((await app.owner()).status, 200);
  for (let index = 0; index < 12; index += 1) assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).status, 429);
});

test('normal Netlify customer polling reads the full Blobs state once and performs no write', async () => {
  let state = null, version = 0, reads = 0, writes = 0;
  const blobs = {
    async getWithMetadata() {
      reads += 1;
      return state ? { data: structuredClone(state), etag: `"${version}"` } : null;
    },
    async setJSON(key, next, condition) {
      if (condition.onlyIfNew ? state !== null : condition.onlyIfMatch !== `"${version}"`) return { modified: false };
      writes += 1;
      state = structuredClone(next);
      return { modified: true, etag: `"${++version}"` };
    },
  };
  const handler = createNetlifyHandler({
    storeFactory: () => new BlobStore({ blobs }),
    appFactory: options => createApp({ ...options, ownerPassword: '', ownerAccessRecord: null }),
  });
  const signup = await handler(new Request('https://audit.example/api/customer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Polling', lastName: 'Test', email: 'polling@example.test' }),
  }), { ip: '203.0.113.23' });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const id = (await signup.json()).customer.id;
  reads = 0;
  writes = 0;
  const response = await handler(new Request('https://audit.example/api/customer', { headers: { Cookie: cookie } }), { ip: '203.0.113.23' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).customer.id, id);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});
