import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID, randomInt, randomBytes, scryptSync, createHash } from 'node:crypto';
import { createApp } from '../server.js';

const password = 'only-a-test-password';
const categories = ['maki', 'poke', 'gyoza', 'sushi-pizza', 'handroll', 'onigiri', 'udon', 'miso', 'nigiri', 'sandwich', 'salad', 'soba', 'senken', 'edamame', 'sashimi', 'platter'];
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'umami-api-'));
  let app;
  let base;
  async function open() {
    app = await createApp({ dataDir, ownerAccessRecord: null, ...options });
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
  async function customer(firstName, email = `${firstName.replace(/\W/g, '').toLowerCase()}@example.test`) { return request('/api/customer', { method: 'POST', body: { firstName, lastName: 'Guest', email } }); }
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
  assert.equal((await app.request(`/api/customer?code=${bob.value.customer.code}`, { cookie: alice.cookie })).value.customer.name, 'Alice Guest');
  assert.equal((await app.request(`/api/owner/customer?code=${bob.value.customer.code}`, { cookie: alice.cookie })).status, 401);
  assert.equal((await app.stamp(alice.cookie, bob.value.customer.code)).status, 401);
  const forged = await app.request('/api/customer', { method: 'PATCH', cookie: alice.cookie, body: { firstName: 'Alice again', lastName: 'Guest', email: 'alice@example.test', stamps: { maki: '2026-01-01' }, redeemed: true } });
  assert.equal(forged.value.customer.name, 'Alice again Guest');
  assert.deepEqual(forged.value.customer.stamps, {});
  assert.equal(forged.value.customer.redeemed, false);
  const repeat = await app.request('/api/customer', { method: 'POST', cookie: alice.cookie, body: { firstName: 'Alice', lastName: 'Guest', email: 'alice@example.test' } });
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
  const first = await app.stamp(owner.cookie, code, ['maki', 'poke', 'maki'], { requestId });
  assert.equal(first.status, 200);
  assert.deepEqual(first.value.earned, ['maki', 'poke']);
  assert.equal(first.value.customer.directOrders, 1);
  const retry = await app.stamp(owner.cookie, code, ['poke', 'maki'], { requestId });
  assert.equal(retry.value.repeated, true);
  assert.equal(retry.value.customer.directOrders, 1);
  assert.equal(retry.value.customer.orders.length, 1);
  assert.equal((await app.stamp(owner.cookie, code, ['gyoza'], { requestId })).status, 409);
  const repeatedCategory = await app.stamp(owner.cookie, code, ['poke'], { directOrder: false });
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
    app.stamp(owner.cookie, code, ['gyoza']),
  ]);
  assert.ok(results.every((result) => result.status === 200));
  const passport = (await app.request('/api/customer', { cookie: customer.cookie })).value.customer;
  assert.deepEqual(Object.keys(passport.stamps).sort(), ['gyoza', 'maki']);
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
  const redeemed = await redeem(owner.cookie);
  assert.equal(redeemed.value.customer.redeemed, true);
  assert.equal(redeemed.value.customer.redeemedDiscount, 25);
  assert.equal((await redeem(owner.cookie)).status, 409);
  await app.restart();
  const restored = await app.request('/api/customer', { cookie: customer.cookie });
  assert.equal(restored.value.customer.code, code);
  assert.equal(restored.value.customer.redeemed, true);
  assert.equal(Object.keys(restored.value.customer.stamps).length, 16);
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
  for (const chosen of [[], ['invalid'], ['__proto__'], ['free'], ['rice'], ['fish'], ['chef'], ['noodles'], ['ramen'], ['burrito']]) assert.equal((await app.stamp(owner.cookie, code, chosen)).status, 400);
  assert.equal((await app.stamp(owner.cookie, code, ['maki'], { requestId: 'invalid' })).status, 400);
  assert.equal((await app.request('/api/customer', { cookie: customer.cookie })).value.customer.name, 'Protected Guest');
  assert.deepEqual((await app.request('/api/customer', { cookie: customer.cookie })).value.customer.stamps, {});
});

test('private server files stay private and both app versions are served', async (t) => {
  const app = await fixture(t);
  for (const path of ['/owner', '/customer', '/owner.css', '/src/app.js']) assert.equal((await app.request(path)).status, 200);
  for (const path of ['/server.js', '/server/store.js', '/server/owner-access.js', '/package.json', '/.git/config', '/store.json']) assert.equal((await app.request(path)).status, 404);
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

test('signup requires a complete profile and normalizes a unique email without anonymous accounts', async (t) => {
  const app = await fixture(t);
  for (const body of [{}, { name: 'Anonymous' }, { firstName: 'Ada', lastName: 'Lovelace' }, { firstName: '', lastName: 'Lovelace', email: 'ada@example.test' }, { firstName: 'Ada', lastName: 'Lovelace', email: 'not-an-email' }]) {
    assert.equal((await app.request('/api/customer', { method: 'POST', body })).status, 400);
  }
  assert.equal(await app.store.read((state) => Object.keys(state.customers).length), 0);
  const signup = await app.request('/api/customer', { method: 'POST', body: { firstName: '  Ada ', lastName: ' Lovelace ', email: ' ADA@EXAMPLE.TEST ' } });
  assert.equal(signup.status, 201);
  assert.equal(signup.value.customer.name, 'Ada Lovelace');
  assert.equal(signup.value.customer.email, 'ada@example.test');
  assert.equal(signup.value.customer.needsProfile, false);
  assert.equal(signup.value.customer.version, 3);
  assert.match(signup.value.recoveryCode, /^UMP-(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
  const duplicate = await app.customer('Other', 'ADA@example.test');
  assert.equal(duplicate.status, 409);
  const second = await app.customer('Other', 'other@example.test');
  const rename = await app.request('/api/customer', { method: 'PATCH', cookie: second.cookie, body: { firstName: 'Other', lastName: 'Person', email: 'ada@example.test' } });
  assert.equal(rename.status, 409);
  assert.equal((await app.request('/api/customer', { cookie: second.cookie })).value.customer.email, 'other@example.test');
});

test('private recovery code restores the same account on another browser but the public QR never signs in', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Recovery');
  const { customer, recoveryCode } = signup.value;
  const firstGet = await app.request('/api/customer', { cookie: signup.cookie });
  assert.equal(firstGet.value.recoveryCode, undefined);
  assert.equal(firstGet.value.customer.recoveryHash, undefined);
  const owner = await app.owner();
  const lookup = await app.request(`/api/owner/customer?code=${customer.code}`, { cookie: owner.cookie });
  assert.equal(lookup.value.recoveryCode, undefined);
  assert.equal(lookup.value.customer.recoveryHash, undefined);
  const publicLogin = await app.request('/api/customer/login', { method: 'POST', body: { email: customer.email, recoveryCode: customer.code } });
  const unknownLogin = await app.request('/api/customer/login', { method: 'POST', body: { email: 'unknown@example.test', recoveryCode } });
  assert.equal(publicLogin.status, 401);
  assert.deepEqual(publicLogin.value, unknownLogin.value);
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: customer.email.toUpperCase(), recoveryCode: recoveryCode.toLowerCase() } });
  assert.equal(login.status, 200);
  assert.equal(login.value.customer.id, customer.id);
  assert.equal(login.value.recoveryCode, undefined);
  assert.equal((await app.request('/api/customer', { cookie: login.cookie })).value.customer.code, customer.code);
  const stored = await readFile(join(app.dataDir, 'store.json'), 'utf8');
  assert.equal(stored.includes(recoveryCode), false);
  assert.equal(stored.includes(recoveryCode.replace(/^UMP-/, '').replace(/-/g, '')), false);
  const logout = await app.request('/api/customer/logout', { method: 'POST', cookie: login.cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.equal((await app.request('/api/customer', { cookie: login.cookie })).status, 401);
  assert.equal((await app.request('/api/customer', { cookie: signup.cookie })).status, 200);
});

test('bingo line redeems 10% once; a later blackout cannot add a second 25% reward', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Bingo');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  assert.equal(signup.value.customer.bingo.count, 0);
  assert.equal(signup.value.customer.bingo.discount, 0);
  const row = await app.stamp(owner.cookie, code, ['maki', 'poke', 'gyoza', 'sushi-pizza']);
  assert.equal(row.value.customer.bingo.hasBingo, true);
  assert.equal(row.value.customer.bingo.count, 4);
  assert.equal(row.value.customer.bingo.discount, 10);
  const redeem = await app.request('/api/owner/redeem', { method: 'POST', cookie: owner.cookie, body: { code, discount: 25 } });
  assert.equal(redeem.value.customer.redeemedDiscount, 10);
  const blackout = await app.stamp(owner.cookie, code, categories);
  assert.equal(blackout.value.customer.bingo.blackout, true);
  assert.equal(blackout.value.customer.redeemedDiscount, 10);
  assert.equal((await app.request('/api/owner/redeem', { method: 'POST', cookie: owner.cookie, body: { code } })).status, 409);
});

test('legacy anonymous passports retain history and need a complete profile before new account use', async (t) => {
  const app = await fixture(t);
  const old = await app.customer('Legacy');
  const date = '2026-10-19T12:00:00.000Z';
  await app.store.transaction((state) => {
    const customer = state.customers[old.value.customer.id];
    customer.version = 1;
    customer.stamps = { maki: date, rice: date, noodles: date, fish: date, platter: date, chef: date };
    for (const key of ['firstName', 'lastName', 'email', 'recoveryHash']) delete customer[key];
  });
  await app.restart();
  const migrated = await app.request('/api/customer', { cookie: old.cookie });
  assert.equal(migrated.value.customer.needsProfile, true);
  assert.deepEqual(Object.keys(migrated.value.customer.stamps).sort(), ['maki', 'platter']);
  assert.equal(migrated.value.customer.id, old.value.customer.id);
  assert.equal(await app.store.read((state) => Object.keys(state.customers[old.value.customer.id].legacyStamps).length), 6);
  const upgraded = await app.request('/api/customer', { method: 'PATCH', cookie: old.cookie, body: { firstName: 'Legacy', lastName: 'Guest', email: 'legacy@example.test' } });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.value.customer.needsProfile, false);
  assert.ok(upgraded.value.recoveryCode);
  assert.equal(upgraded.value.customer.id, old.value.customer.id);
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: 'legacy@example.test', recoveryCode: upgraded.value.recoveryCode } });
  assert.equal(login.value.customer.id, old.value.customer.id);
});

test('customer login limits persist across app restarts and duplicate concurrent emails cannot create two accounts', async (t) => {
  const app = await fixture(t);
  const results = await Promise.all([app.customer('First', 'same@example.test'), app.customer('Second', 'same@example.test')]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  for (let count = 0; count < 12; count++) {
    assert.equal((await app.request('/api/customer/login', { method: 'POST', body: { email: 'none@example.test', recoveryCode: 'invalid' } })).status, 401);
  }
  await app.restart();
  assert.equal((await app.request('/api/customer/login', { method: 'POST', body: { email: 'none@example.test', recoveryCode: 'invalid' } })).status, 429);
});

test('hosted mode disables public owner setup and emits secure session cookies', async (t) => {
  const app = await fixture(t, { allowOwnerSetup: false, secureCookies: true });
  const status = await app.request('/api/status');
  assert.equal(status.value.ownerSetupAllowed, false);
  assert.equal(status.value.ownerConfigured, false);
  assert.equal((await app.owner()).status, 403);
  const signup = await app.customer('Secure');
  assert.match(signup.headers.get('set-cookie'), /; Secure/);
});

test('failed durable writes do not issue a session cookie or mutate the current state', async (t) => {
  const app = await fixture(t);
  const persist = app.store.persist;
  app.store.persist = async () => { throw new Error('Simulated unavailable private storage'); };
  const signup = await app.customer('Failed');
  assert.equal(signup.status, 500);
  assert.equal(signup.cookie, undefined);
  assert.equal(await app.store.read((state) => Object.keys(state.customers).length), 0);
  app.store.persist = persist;
  assert.equal((await app.customer('Retry')).status, 201);
});

function testAccessRecord() {
  const code = String(randomInt(100000, 1000000));
  const salt = randomBytes(16).toString('hex');
  return { code, record: { salt, hash: scryptSync(code, salt, 64).toString('hex') } };
}

test('a private access record configures owner login without a public setup wizard', async (t) => {
  const access = testAccessRecord();
  const app = await fixture(t, { ownerAccessRecord: access.record });
  const status = await app.request('/api/status');
  assert.deepEqual(status.value, { ownerConfigured: true, ownerSetupAllowed: false });
  assert.equal(JSON.stringify(status.value).includes(access.record.hash), false);
  assert.equal((await app.owner()).status, 403);
  const invalid = await app.request('/api/owner/login', { method: 'POST', body: { code: 'not-numeric' } });
  assert.equal(invalid.status, 401);
  const owner = await app.request('/api/owner/login', { method: 'POST', body: { code: access.code } });
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await app.request('/api/owner/session', { cookie: owner.cookie })).status, 200);
  assert.equal(await app.store.read((state) => state.owner), null);
  assert.equal((await app.request('/server/owner-access.js')).status, 404);
});

test('private access-code login also works with an existing password owner and remains rate limited', async (t) => {
  const access = testAccessRecord();
  const app = await fixture(t, { ownerPassword: password, ownerAccessRecord: access.record });
  const viaCode = await app.request('/api/owner/login', { method: 'POST', body: { code: access.code } });
  const viaPassword = await app.request('/api/owner/login', { method: 'POST', body: { password } });
  assert.equal(viaCode.status, 200);
  assert.equal(viaPassword.status, 200);
  const otherCode = String((Number(access.code) + 1) % 1000000).padStart(6, '0');
  for (let count = 0; count < 10; count++) assert.equal((await app.request('/api/owner/login', { method: 'POST', body: { code: otherCode } })).status, 401);
  assert.equal((await app.request('/api/owner/login', { method: 'POST', body: { code: access.code } })).status, 429);
});

test('an obsolete invalid password setting cannot disable a configured private access code', async (t) => {
  const access = testAccessRecord();
  const app = await fixture(t, { ownerPassword: 'old', ownerAccessRecord: access.record });
  assert.equal((await app.request('/api/status')).value.ownerConfigured, true);
  const owner = await app.request('/api/owner/login', { method: 'POST', body: { code: access.code } });
  assert.equal(owner.status, 200);
});

test('owner corrections remove multiple confirmed squares and immediately update bingo eligibility without deleting visits', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Correction');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const stamped = await app.stamp(owner.cookie, code, categories.slice(0, 4));
  assert.equal(stamped.value.customer.bingo.discount, 10);
  const expectedStamps = { maki: stamped.value.customer.stamps.maki, poke: stamped.value.customer.stamps.poke };
  const body = { code, categories: ['poke', 'maki'], requestId: randomUUID(), expectedStamps };
  assert.equal((await app.request('/api/owner/stamps/remove', { method: 'POST', body })).status, 401);
  assert.equal((await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: signup.cookie, body })).status, 401);
  const corrected = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body });
  assert.equal(corrected.status, 200);
  assert.deepEqual(corrected.value.removed, ['maki', 'poke']);
  assert.equal(corrected.value.customer.bingo.discount, 0);
  assert.equal(corrected.value.customer.bingo.count, 2);
  assert.deepEqual(corrected.value.customer.orders, stamped.value.customer.orders);
  assert.equal(corrected.value.customer.directOrders, stamped.value.customer.directOrders);
  assert.deepEqual(corrected.value.customer.corrections[0].previousStamps, expectedStamps);
  assert.equal(corrected.value.customer.corrections[0].actor, 'owner');
  const polled = await app.request('/api/customer', { cookie: signup.cookie });
  assert.deepEqual(polled.value.customer.stamps, corrected.value.customer.stamps);
  await app.restart();
  const persisted = await app.request('/api/customer', { cookie: signup.cookie });
  assert.deepEqual(persisted.value.customer.corrections, corrected.value.customer.corrections);
});

test('correction retries cannot remove later legitimate re-stamps and award retries cannot restore a corrected stamp', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Retry');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const awardId = randomUUID();
  const stamped = await app.stamp(owner.cookie, code, ['maki'], { requestId: awardId });
  const body = { code, categories: ['maki'], requestId: randomUUID(), expectedStamps: { maki: stamped.value.customer.stamps.maki } };
  const removed = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body });
  assert.deepEqual(removed.value.removed, ['maki']);
  const awardRetry = await app.stamp(owner.cookie, code, ['maki'], { requestId: awardId });
  assert.equal(awardRetry.value.repeated, true);
  assert.equal(awardRetry.value.customer.stamps.maki, undefined);
  assert.equal(awardRetry.value.customer.orders.length, 1);
  const newAward = await app.stamp(owner.cookie, code, ['maki']);
  assert.notEqual(newAward.value.customer.stamps.maki, body.expectedStamps.maki);
  const correctionRetry = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body });
  assert.equal(correctionRetry.value.repeated, true);
  assert.equal(correctionRetry.value.customer.stamps.maki, newAward.value.customer.stamps.maki);
  assert.equal(correctionRetry.value.customer.corrections.length, 1);
  assert.equal((await app.stamp(owner.cookie, code, ['maki'], { requestId: body.requestId })).status, 409);
});

test('stale correction dates fail atomically, absent squares are harmless and correction payloads are validated', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Stale');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const stamped = await app.stamp(owner.cookie, code, ['maki', 'poke']);
  const oldDate = stamped.value.customer.stamps.maki;
  const remove = (body) => app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body });
  const valid = { code, categories: ['maki'], requestId: randomUUID(), expectedStamps: { maki: oldDate } };
  assert.equal((await remove(valid)).status, 200);
  const absent = await remove({ ...valid, requestId: randomUUID() });
  assert.deepEqual(absent.value.removed, []);
  assert.equal(absent.value.customer.corrections.length, 1);
  await app.stamp(owner.cookie, code, ['maki']);
  const stale = await remove({ code, categories: ['maki', 'poke'], requestId: randomUUID(), expectedStamps: { maki: oldDate, poke: stamped.value.customer.stamps.poke } });
  assert.equal(stale.status, 409);
  const unchanged = (await app.request('/api/customer', { cookie: signup.cookie })).value.customer;
  assert.ok(unchanged.stamps.maki);
  assert.ok(unchanged.stamps.poke);
  assert.equal(unchanged.corrections.length, 1);
  for (const invalid of [
    { ...valid, categories: [] },
    { ...valid, categories: ['free'] },
    { ...valid, categories: ['ramen'] },
    { ...valid, expectedStamps: {} },
    { ...valid, expectedStamps: { maki: 'invalid' } },
    { ...valid, requestId: 'not-a-uuid' },
  ]) assert.equal((await remove(invalid)).status, 400);
  assert.equal((await remove({ ...valid, expectedStamps: { maki: new Date(0).toISOString() } })).status, 409);
});

test('corrections never reverse a redeemed reward or allow a second redemption', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Redeemed');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const full = await app.stamp(owner.cookie, code, categories);
  assert.equal(full.value.customer.bingo.total, 16);
  await app.request('/api/owner/redeem', { method: 'POST', cookie: owner.cookie, body: { code } });
  const corrected = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body: { code, categories, requestId: randomUUID(), expectedStamps: full.value.customer.stamps } });
  assert.deepEqual(corrected.value.customer.stamps, {});
  assert.equal(corrected.value.customer.bingo.discount, 0);
  assert.equal(corrected.value.customer.redeemed, true);
  assert.equal(corrected.value.customer.redeemedDiscount, 25);
  assert.equal((await app.request('/api/owner/redeem', { method: 'POST', cookie: owner.cookie, body: { code } })).status, 409);
});

test('version two accounts migrate exact food stamps to the new card while preserving legacy history and login', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Migrating');
  const oldDate = '2026-10-19T12:00:00.000Z';
  const oldCategories = ['maki', 'poke', 'noodles', 'ramen', 'platter', 'onigiri', 'gyoza', 'burrito'];
  const oldOrders = [{ id: randomUUID(), date: oldDate, total: 0, categories: oldCategories, directOrder: true }];
  await app.store.transaction((state) => {
    const customer = state.customers[signup.value.customer.id];
    customer.version = 2;
    customer.stamps = Object.fromEntries(oldCategories.map((category) => [category, oldDate]));
    customer.legacyStamps = { fish: oldDate };
    customer.orders = oldOrders;
    customer.redeemed = true;
    customer.redeemedDiscount = 10;
  });
  await app.restart();
  const migrated = (await app.request('/api/customer', { cookie: signup.cookie })).value.customer;
  assert.equal(migrated.version, 3);
  assert.equal(migrated.code, signup.value.customer.code);
  assert.equal(migrated.email, signup.value.customer.email);
  assert.deepEqual(Object.keys(migrated.stamps).sort(), ['gyoza', 'maki', 'onigiri', 'platter', 'poke']);
  assert.deepEqual(migrated.orders, oldOrders);
  assert.equal(migrated.redeemed, true);
  assert.equal(migrated.redeemedDiscount, 10);
  const legacy = await app.store.read((state) => state.customers[signup.value.customer.id].legacyStamps);
  for (const category of ['noodles', 'ramen', 'burrito', 'fish']) assert.equal(legacy[category], oldDate);
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: migrated.email, recoveryCode: signup.value.recoveryCode } });
  assert.equal(login.value.customer.id, migrated.id);
});

test('receipts from the old award format still protect repeat confirmations after deployment', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('OldReceipt');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const requestId = randomUUID();
  await app.stamp(owner.cookie, code, ['maki'], { requestId });
  await app.store.transaction((state) => {
    delete state.requests[requestId].operation;
    state.requests[requestId].fingerprint = createHash('sha256').update(JSON.stringify({ code, categories: ['maki'], directOrder: true })).digest('hex');
  });
  const repeat = await app.stamp(owner.cookie, code, ['maki'], { requestId });
  assert.equal(repeat.value.repeated, true);
  assert.equal(repeat.value.customer.orders.length, 1);
});
