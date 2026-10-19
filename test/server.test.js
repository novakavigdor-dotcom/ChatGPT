import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';

const password = 'only-a-test-password';
const categories = ['maki', 'rice', 'noodles', 'fish', 'platter', 'chef'];
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umami-api-'));
  let app;
  let base;
  async function open() {
    app = await createApp({ dataDir, ...options });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function close() {
    if (!app.server.listening) return;
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  }
  await open();
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    return { status: response.status, value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function customer(name) { return request('/api/customer', { method: 'POST', body: { name } }); }
  async function owner() { return request('/api/owner/setup', { method: 'POST', body: { password } }); }
  async function stamp(cookie, code, chosen = ['maki'], extra = {}) {
    return request('/api/owner/stamps', { method: 'POST', cookie, body: { code, categories: chosen, directOrder: true, requestId: randomUUID(), ...extra } });
  }
  return { request, customer, owner, stamp, dataDir, get store() { return app.store; }, restart: async () => { await close(); await open(); } };
}

test('customers have unique public QR identities and cannot access or award other passports', async (t) => {
  const app = await fixture(t);
  const alice = await app.customer('Alice');
  const bob = await app.customer('Bob');
  assert.equal(alice.status, 201);
  assert.match(alice.value.customer.code, /^[A-F0-9]{32}$/);
  assert.notEqual(alice.value.customer.code, bob.value.customer.code);
  assert.notEqual(alice.cookie, bob.cookie);
  assert.match(alice.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(alice.headers.get('cache-control'), 'no-store');
  assert.deepEqual(alice.value.customer.stamps, {});
  assert.equal((await app.request('/api/customer')).status, 401);
  assert.equal((await app.request(`/api/customer?code=${bob.value.customer.code}`, { cookie: alice.cookie })).value.customer.name, 'Alice');
  assert.equal((await app.request(`/api/owner/customer?code=${bob.value.customer.code}`, { cookie: alice.cookie })).status, 401);
  assert.equal((await app.stamp(alice.cookie, bob.value.customer.code)).status, 401);
  const forged = await app.request('/api/customer', { method: 'PATCH', cookie: alice.cookie, body: { name: 'Alice again', stamps: { maki: '2026-01-01' }, redeemed: true } });
  assert.equal(forged.value.customer.name, 'Alice again');
  assert.deepEqual(forged.value.customer.stamps, {});
  assert.equal(forged.value.customer.redeemed, false);
  const repeat = await app.request('/api/customer', { method: 'POST', cookie: alice.cookie, body: { name: 'Replace me' } });
  assert.equal(repeat.value.customer.id, alice.value.customer.id);
});

test('owner setup is one-time, login/logout are protected, passwords and sessions are not stored in plaintext', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/status')).value.ownerConfigured, false);
  assert.equal((await app.request('/api/owner/setup', { method: 'POST', body: { password: 'short' } })).status, 400);
  const owner = await app.owner();
  assert.equal(owner.status, 201);
  assert.equal((await app.owner()).status, 409);
  assert.equal((await app.request('/api/status')).value.ownerConfigured, true);
  assert.equal((await app.request('/api/owner/session', { cookie: owner.cookie })).status, 200);
  assert.equal((await app.request('/api/owner/login', { method: 'POST', body: { password: 'the-wrong-password' } })).status, 401);
  const login = await app.request('/api/owner/login', { method: 'POST', body: { password } });
  assert.equal(login.status, 200);
  const stored = await readFile(join(app.dataDir, 'store.json'), 'utf8');
  assert.equal(stored.includes(password), false);
  assert.equal(stored.includes(owner.cookie.split('=')[1]), false);
  const logout = await app.request('/api/owner/logout', { method: 'POST', cookie: login.cookie, body: {} });
  assert.equal(logout.value.authenticated, false);
  assert.equal((await app.request('/api/owner/session', { cookie: login.cookie })).status, 401);
});

test('owner multi-category stamping updates the customer and retries are idempotent', async (t) => {
  const app = await fixture(t);
  const customer = await app.customer('Nora');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  const formatted = `umami:${code.toLowerCase().match(/.{4}/g).join('-')}`;
  assert.equal((await app.request(`/api/owner/customer?code=${formatted}`, { cookie: owner.cookie })).value.customer.id, customer.value.customer.id);
  const requestId = randomUUID();
  const first = await app.stamp(owner.cookie, code, ['maki', 'rice', 'maki'], { requestId });
  assert.equal(first.status, 200);
  assert.deepEqual(first.value.earned, ['maki', 'rice']);
  assert.equal(first.value.customer.directOrders, 1);
  const retry = await app.stamp(owner.cookie, code, ['rice', 'maki'], { requestId });
  assert.equal(retry.value.repeated, true);
  assert.equal(retry.value.customer.directOrders, 1);
  assert.equal(retry.value.customer.orders.length, 1);
  assert.equal((await app.stamp(owner.cookie, code, ['fish'], { requestId })).status, 409);
  const repeatedCategory = await app.stamp(owner.cookie, code, ['rice'], { directOrder: false });
  assert.deepEqual(repeatedCategory.value.earned, []);
  assert.equal(repeatedCategory.value.customer.directOrders, 1);
  const refreshed = await app.request('/api/customer', { cookie: customer.cookie });
  assert.equal(Object.keys(refreshed.value.customer.stamps).length, 2);
  assert.equal(refreshed.value.customer.orders.length, 2);
});

test('concurrent confirmations do not lose categories or duplicate a retried visit', async (t) => {
  const app = await fixture(t);
  const customer = await app.customer('Concurrent');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  const requestId = randomUUID();
  const results = await Promise.all([
    app.stamp(owner.cookie, code, ['maki'], { requestId }),
    app.stamp(owner.cookie, code, ['maki'], { requestId }),
    app.stamp(owner.cookie, code, ['fish']),
  ]);
  assert.ok(results.every((result) => result.status === 200));
  const passport = (await app.request('/api/customer', { cookie: customer.cookie })).value.customer;
  assert.deepEqual(Object.keys(passport.stamps).sort(), ['fish', 'maki']);
  assert.equal(passport.orders.length, 2);
  assert.equal(passport.directOrders, 2);
});

test('only the owner redeems a complete reward once and the state survives restart', async (t) => {
  const app = await fixture(t);
  const customer = await app.customer('Returning guest');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  const redeem = (cookie) => app.request('/api/owner/redeem', { method: 'POST', cookie, body: { code } });
  assert.equal((await redeem(owner.cookie)).status, 409);
  await app.stamp(owner.cookie, code, categories);
  assert.equal((await redeem(customer.cookie)).status, 401);
  assert.equal((await redeem(owner.cookie)).value.customer.redeemed, true);
  assert.equal((await redeem(owner.cookie)).status, 409);
  await app.restart();
  const restored = await app.request('/api/customer', { cookie: customer.cookie });
  assert.equal(restored.value.customer.code, code);
  assert.equal(restored.value.customer.redeemed, true);
  assert.equal(Object.keys(restored.value.customer.stamps).length, 6);
  assert.equal((await app.request('/api/owner/session', { cookie: owner.cookie })).status, 200);
});

test('cross-site requests, malformed awards and oversized payloads cannot make changes', async (t) => {
  const app = await fixture(t);
  const customer = await app.customer('Protected');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  assert.equal((await app.request('/api/customer', { method: 'PATCH', cookie: customer.cookie, body: { name: 'Attacker' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await app.request('/api/customer', { method: 'PATCH', cookie: customer.cookie, body: { name: 'Attacker' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await app.request('/api/customer', { method: 'PATCH', cookie: customer.cookie, body: { name: 'Attacker' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.request('/api/customer', { method: 'PATCH', cookie: customer.cookie, body: { name: 'a'.repeat(18000) } })).status, 413);
  for (const chosen of [[], ['invalid'], ['__proto__']]) assert.equal((await app.stamp(owner.cookie, code, chosen)).status, 400);
  assert.equal((await app.stamp(owner.cookie, code, ['maki'], { requestId: 'invalid' })).status, 400);
  assert.equal((await app.request('/api/customer', { cookie: customer.cookie })).value.customer.name, 'Protected');
  assert.deepEqual((await app.request('/api/customer', { cookie: customer.cookie })).value.customer.stamps, {});
});

test('private server files stay private and both app versions are served', async (t) => {
  const app = await fixture(t);
  for (const path of ['/owner', '/customer', '/owner.css', '/src/app.js']) assert.equal((await app.request(path)).status, 200);
  for (const path of ['/server.js', '/server/store.js', '/package.json', '/.git/config', '/store.json']) assert.equal((await app.request(path)).status, 404);
});

test('an injected owner password prevents public first-run setup and authenticates normally', async (t) => {
  const app = await fixture(t, { ownerPassword: password });
  assert.equal((await app.request('/api/status')).value.ownerConfigured, true);
  assert.equal((await app.owner()).status, 409);
  assert.equal((await app.request('/api/owner/login', { method: 'POST', body: { password } })).status, 200);
});

test('owner authentication is rate limited and expired sessions cannot make changes', async (t) => {
  const app = await fixture(t, { ownerPassword: password });
  const owner = await app.request('/api/owner/login', { method: 'POST', body: { password } });
  const customer = await app.customer('Expiry');
  await app.store.transaction((state) => { for (const entry of Object.values(state.sessions)) entry.expires = Date.now() - 1; });
  assert.equal((await app.stamp(owner.cookie, customer.value.customer.code)).status, 401);
  assert.equal((await app.request('/api/customer', { cookie: customer.cookie })).status, 401);
  let last;
  for (let count = 0; count < 12; count++) last = await app.request('/api/owner/login', { method: 'POST', body: { password: 'wrong-test-password' } });
  assert.equal(last.status, 429);
});
