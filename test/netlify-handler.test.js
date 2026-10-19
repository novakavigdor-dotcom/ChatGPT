import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, randomInt, scryptSync } from 'node:crypto';
import { createApp } from '../server.js';
import { BlobStore } from '../server/blob-store.js';
import { createNetlifyHandler } from '../server/netlify-handler.js';

function fixture({ password = '', alwaysConflict = false, ownerAccessRecord = null } = {}) {
  let state = null, etag = 0;
  const blobs = {
    async getWithMetadata() { return state ? { data: structuredClone(state), etag: `"${etag}"` } : null; },
    async setJSON(key, next, condition) {
      if (alwaysConflict || (condition.onlyIfNew ? state !== null : condition.onlyIfMatch !== `"${etag}"`)) return { modified: false };
      state = structuredClone(next);
      return { modified: true, etag: `"${++etag}"` };
    },
  };
  const handler = createNetlifyHandler({
    storeFactory: () => new BlobStore({ blobs, maxAttempts: 8, retryDelay: async () => {} }),
    appFactory: (options) => createApp({ ...options, ownerPassword: password, ownerAccessRecord }),
  });
  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await handler(new Request(`https://passport.example${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), { ip: '203.0.113.7' });
    return { status: response.status, value: await response.json(), headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { request };
}

test('Netlify bridge handles API rewrites and never permits public first-owner setup', async () => {
  const api = fixture();
  const status = await api.request('/.netlify/functions/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.value, { ownerConfigured: false, ownerSetupAllowed: false });
  assert.equal((await api.request('/api/health')).value.ready, true);
  const setup = await api.request('/api/owner/setup', { method: 'POST', body: { password: 'test-password-only' } });
  assert.equal(setup.status, 403);
  assert.equal((await api.request('/server.js')).status, 404);
});

test('Netlify requests share durable customer and owner state through the HTTP adapter', async () => {
  const password = 'test-owner-password-only';
  const api = fixture({ password });
  const signup = await api.request('/api/customer', { method: 'POST', body: { firstName: 'Test', lastName: 'Customer', email: 'netlify@example.test' } });
  assert.equal(signup.status, 201);
  assert.ok(signup.value.recoveryCode);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly.*Secure/);
  const customer = signup.value.customer;
  const owner = await api.request('/api/owner/login', { method: 'POST', body: { password } });
  assert.equal(owner.status, 200);
  const lookup = await api.request(`/api/owner/customer?code=${encodeURIComponent(`UMAMI:${customer.code}`)}`, { cookie: owner.cookie });
  assert.equal(lookup.value.customer.id, customer.id);
  const visit = { code: customer.code, categories: ['maki', 'ramen'], directOrder: true, requestId: randomUUID() };
  const stamp = await api.request('/.netlify/functions/api/owner/stamps', { method: 'POST', cookie: owner.cookie, body: visit });
  assert.equal(stamp.status, 200);
  assert.deepEqual(stamp.value.earned, ['maki', 'ramen']);
  const refreshed = await api.request('/api/customer', { cookie: signup.cookie });
  assert.deepEqual(Object.keys(refreshed.value.customer.stamps).sort(), ['maki', 'ramen']);
  assert.equal(refreshed.headers.get('cache-control'), 'no-store');
  const blocked = await api.request('/api/owner/stamps', { method: 'POST', cookie: owner.cookie, body: { ...visit, requestId: randomUUID() }, headers: { Origin: 'https://other.example' } });
  assert.equal(blocked.status, 403);
});

test('oversized function bodies are rejected before storage is initialized', async () => {
  let initialized = false;
  const handler = createNetlifyHandler({ storeFactory: () => { initialized = true; throw new Error('must not be called'); } });
  const response = await handler(new Request('https://passport.example/api/customer', { method: 'POST', body: 'x'.repeat(17000) }));
  assert.equal(response.status, 413);
  assert.equal(initialized, false);
});

test('a failed Blobs commit cannot issue a customer session cookie', async () => {
  const api = fixture({ alwaysConflict: true });
  const signup = await api.request('/api/customer', { method: 'POST', body: { firstName: 'Unsaved', lastName: 'Customer', email: 'unsaved@example.test' } });
  assert.equal(signup.status, 503);
  assert.equal(signup.headers.has('set-cookie'), false);
  assert.equal((await api.request('/api/customer')).status, 401);
});

test('Netlify owner access code works without an environment password and opens protected owner APIs', async () => {
  const code = String(randomInt(100000, 1000000));
  const salt = randomBytes(16).toString('hex');
  const ownerAccessRecord = { salt, hash: scryptSync(code, salt, 64).toString('hex') };
  const api = fixture({ ownerAccessRecord });
  const status = await api.request('/api/status');
  assert.deepEqual(status.value, { ownerConfigured: true, ownerSetupAllowed: false });
  const owner = await api.request('/api/owner/login', { method: 'POST', body: { code } });
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('set-cookie'), /HttpOnly.*Secure/);
  assert.equal((await api.request('/api/owner/session', { cookie: owner.cookie })).value.authenticated, true);
  const signup = await api.request('/api/customer', { method: 'POST', body: { firstName: 'Private', lastName: 'Test', email: 'private-access@example.test' } });
  const lookup = await api.request(`/api/owner/customer?code=${signup.value.customer.code}`, { cookie: owner.cookie });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.value.customer.id, signup.value.customer.id);
  assert.equal(JSON.stringify(lookup.value).includes(ownerAccessRecord.hash), false);
});
