import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID, randomInt, randomBytes, scryptSync, createHash } from 'node:crypto';
import { createApp } from '../server.js';
import { createRequestId, REQUEST_MAX_AGE_MS } from '../src/request-id.js';

const password = 'only-a-test-password';
const categories = ['maki', 'poke', 'gyoza', 'sushi-pizza', 'handroll', 'onigiri', 'udon', 'miso', 'nigiri', 'sandwich', 'salad', 'soba', 'senken', 'edamame', 'sashimi', 'platter'];
const lineIds = ['line-row-1', 'line-row-2', 'line-row-3', 'line-row-4', 'line-column-1', 'line-column-2', 'line-column-3', 'line-column-4', 'line-diagonal-main', 'line-diagonal-anti'];
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
    return request('/api/owner/stamps', { method: 'POST', cookie, body: { code, categories: chosen, directOrder: true, requestId: createRequestId(), ...extra } });
  }
  async function redeem(cookie, code, rewardId = 'line-row-1', extra = {}) {
    return request('/api/owner/redeem', { method: 'POST', cookie, body: { code, rewardId, requestId: createRequestId(), ...extra } });
  }
  return { request, customer, owner, stamp, redeem, dataDir, get store() { return app.store; }, restart: async () => { await close(); await open(); } };
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
  const forged = await app.request('/api/customer', { method: 'PATCH', cookie: alice.cookie, body: { firstName: 'Alice again', lastName: 'Guest', email: 'alice@example.test', stamps: { maki: '2026-01-01' }, redeemed: true, redemptions: [{ id: createRequestId(), rewardId: 'blackout', discount: 25, date: new Date().toISOString(), actor: 'owner' }] } });
  assert.equal(forged.value.customer.name, 'Alice again Guest');
  assert.deepEqual(forged.value.customer.stamps, {});
  assert.equal(forged.value.customer.redeemed, false);
  assert.deepEqual(forged.value.customer.redemptions, []);
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
  const requestId = createRequestId();
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
  assert.equal(refreshed.value.customer.orders.length, 1);
});

test('concurrent confirmations do not lose categories or duplicate a retried visit', async (t) => {
  const app = await fixture(t);
  const customer = await app.customer('Concurrent');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  const requestId = createRequestId();
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

test('only the owner redeems all ten distinct lines and blackout once and their histories survive restart', async (t) => {
  const app = await fixture(t);
  const customer = await app.customer('Returning guest');
  const owner = await app.owner();
  const code = customer.value.customer.code;
  assert.equal((await app.redeem(owner.cookie, code, 'blackout')).status, 409);
  await app.stamp(owner.cookie, code, categories);
  assert.equal((await app.redeem(customer.cookie, code, 'blackout')).status, 401);
  const redeemed = await app.redeem(owner.cookie, code, 'blackout');
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.value.redemption.discount, 25);
  assert.equal(redeemed.value.customer.redeemed, true);
  assert.equal(redeemed.value.customer.redeemedDiscount, 25);
  assert.deepEqual(redeemed.value.customer.rewards.availableRewards.map(reward=>reward.id), lineIds);
  assert.equal((await app.redeem(owner.cookie, code, 'blackout')).status, 409);
  for (const [index, rewardId] of lineIds.entries()) {
    const line = await app.redeem(owner.cookie, code, rewardId);
    assert.equal(line.status, 200);
    assert.equal(line.value.redemption.discount, 10);
    assert.equal(line.value.customer.redemptions.length, index + 2);
    assert.equal((await app.redeem(owner.cookie, code, rewardId)).status, 409);
  }
  await app.restart();
  const restored = await app.request('/api/customer', { cookie: customer.cookie });
  assert.equal(restored.value.customer.code, code);
  assert.equal(restored.value.customer.redeemed, true);
  assert.deepEqual(restored.value.customer.redemptions.map(entry=>entry.discount), [25,...lineIds.map(()=>10)]);
  assert.equal(new Set(restored.value.customer.redemptions.map(entry=>entry.rewardId)).size, 11);
  assert.deepEqual(restored.value.customer.rewards.availableRewards, []);
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
  for (let count = 0; count < 13; count++) last = await app.request('/api/owner/login', { method: 'POST', body: { password: 'wrong-test-password' } });
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
  assert.equal(signup.value.recoveryCode, undefined);
  assert.equal(await app.store.read((state) => state.customers[signup.value.customer.id].recoveryHash), undefined);
  const duplicate = await app.customer('Other', 'ADA@example.test');
  assert.equal(duplicate.status, 409);
  const second = await app.customer('Other', 'other@example.test');
  const rename = await app.request('/api/customer', { method: 'PATCH', cookie: second.cookie, body: { firstName: 'Other', lastName: 'Person', email: 'ada@example.test' } });
  assert.equal(rename.status, 409);
  assert.equal((await app.request('/api/customer', { cookie: second.cookie })).value.customer.email, 'other@example.test');
});

test('last name and email open the same account on another browser while QR codes alone never sign in', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Returning');
  const { customer } = signup.value;
  const firstGet = await app.request('/api/customer', { cookie: signup.cookie });
  assert.equal(firstGet.value.recoveryCode, undefined);
  assert.equal(firstGet.value.customer.recoveryHash, undefined);
  const owner = await app.owner();
  const lookup = await app.request(`/api/owner/customer?code=${customer.code}`, { cookie: owner.cookie });
  assert.equal(lookup.value.recoveryCode, undefined);
  assert.equal(lookup.value.customer.recoveryHash, undefined);
  const publicLogin = await app.request('/api/customer/login', { method: 'POST', body: { email: customer.email, lastName: customer.code } });
  const unknownLogin = await app.request('/api/customer/login', { method: 'POST', body: { email: 'unknown@example.test', lastName: 'Guest' } });
  assert.equal(publicLogin.status, 401);
  assert.deepEqual(publicLogin.value, unknownLogin.value);
  for (const lastName of [undefined, null, 42, [], {}, '', 'Wrong']) {
    const malformed = await app.request('/api/customer/login', { method: 'POST', body: { email: customer.email, lastName } });
    assert.equal(malformed.status, 401);
    assert.deepEqual(malformed.value, unknownLogin.value);
  }
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: ` ${customer.email.toUpperCase()} `, lastName: ' gUeSt ' } });
  assert.equal(login.status, 200);
  assert.equal(login.value.customer.id, customer.id);
  assert.equal(login.value.recoveryCode, undefined);
  assert.equal((await app.request('/api/customer', { cookie: login.cookie })).value.customer.code, customer.code);
  const logout = await app.request('/api/customer/logout', { method: 'POST', cookie: login.cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.equal((await app.request('/api/customer', { cookie: login.cookie })).status, 401);
  assert.equal((await app.request('/api/customer', { cookie: signup.cookie })).status, 200);
});

test('a ten percent line reward and a later twenty-five percent full-card reward are independent', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Bingo');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  assert.equal(signup.value.customer.bingo.count, 0);
  assert.equal(signup.value.customer.bingo.discount, 0);
  const row = await app.stamp(owner.cookie, code, ['maki', 'poke', 'gyoza', 'sushi-pizza']);
  assert.equal(row.value.customer.bingo.hasBingo, true);
  const redeem = await app.redeem(owner.cookie, code, 'line-row-1', { discount: 25 });
  assert.equal(redeem.status, 200);
  assert.equal(redeem.value.redemption.discount, 10);
  assert.equal(redeem.value.customer.redemptions[0].rewardId, 'line-row-1');
  assert.equal((await app.redeem(owner.cookie, code, 'line-row-1')).status, 409);
  const blackout = await app.stamp(owner.cookie, code, categories);
  assert.equal(blackout.value.customer.bingo.blackout, true);
  assert.deepEqual(blackout.value.customer.rewards.availableRewards.map(reward=>reward.id), [...lineIds.slice(1), 'blackout']);
  const fullReward = await app.redeem(owner.cookie, code, 'blackout', { discount: 100 });
  assert.equal(fullReward.status, 200);
  assert.equal(fullReward.value.redemption.discount, 25);
  assert.deepEqual(fullReward.value.customer.redemptions.map(entry=>entry.discount), [10,25]);
  assert.equal((await app.redeem(owner.cookie, code, 'blackout')).status, 409);
});

test('one newly stamped square can complete a row, column and diagonal as three separate rewards', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('ThreeLines');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const preparatory = ['poke','gyoza','sushi-pizza','handroll','nigiri','senken','onigiri','salad','platter'];
  const before = await app.stamp(owner.cookie, code, preparatory);
  assert.deepEqual(before.value.customer.rewards.availableRewards, []);
  const after = await app.stamp(owner.cookie, code, ['maki']);
  assert.deepEqual(after.value.customer.rewards.availableRewards.map(reward=>reward.id), ['line-row-1','line-column-1','line-diagonal-main']);
  const claims = await Promise.all(after.value.customer.rewards.availableRewards.map(reward=>app.redeem(owner.cookie,code,reward.id)));
  assert.ok(claims.every(result=>result.status===200));
  const customer = (await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
  assert.equal(customer.redemptions.length,3);
  assert.deepEqual(customer.rewards.availableRewards,[]);
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
  assert.equal(upgraded.value.recoveryCode, undefined);
  assert.equal(upgraded.value.customer.id, old.value.customer.id);
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: 'legacy@example.test', lastName: 'Guest' } });
  assert.equal(login.value.customer.id, old.value.customer.id);
});

test('customer login limits persist across app restarts and duplicate concurrent emails cannot create two accounts', async (t) => {
  const app = await fixture(t);
  const results = await Promise.all([app.customer('First', 'same@example.test'), app.customer('Second', 'same@example.test')]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  for (let count = 0; count < 12; count++) {
    assert.equal((await app.request('/api/customer/login', { method: 'POST', body: { email: 'none@example.test', lastName: 'Unknown' } })).status, 401);
  }
  await app.restart();
  assert.equal((await app.request('/api/customer/login', { method: 'POST', body: { email: 'none@example.test', lastName: 'Unknown' } })).status, 429);
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
  for (let count = 0; count < 12; count++) assert.equal((await app.request('/api/owner/login', { method: 'POST', body: { code: otherCode } })).status, 401);
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
  const body = { code, categories: ['poke', 'maki'], requestId: createRequestId(), expectedStamps };
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
  const awardId = createRequestId();
  const stamped = await app.stamp(owner.cookie, code, ['maki'], { requestId: awardId });
  const body = { code, categories: ['maki'], requestId: createRequestId(), expectedStamps: { maki: stamped.value.customer.stamps.maki } };
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
  const valid = { code, categories: ['maki'], requestId: createRequestId(), expectedStamps: { maki: oldDate } };
  assert.equal((await remove(valid)).status, 200);
  const absent = await remove({ ...valid, requestId: createRequestId() });
  assert.deepEqual(absent.value.removed, []);
  assert.equal(absent.value.customer.corrections.length, 1);
  await app.stamp(owner.cookie, code, ['maki']);
  const stale = await remove({ code, categories: ['maki', 'poke'], requestId: createRequestId(), expectedStamps: { maki: oldDate, poke: stamped.value.customer.stamps.poke } });
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

test('corrections change eligibility but never reopen any of the ten redeemed lines or blackout after re-stamping', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Redeemed');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const full = await app.stamp(owner.cookie, code, categories);
  assert.equal(full.value.customer.bingo.total, 16);
  assert.equal((await app.redeem(owner.cookie, code, 'blackout')).status, 200);
  for (const rewardId of lineIds) assert.equal((await app.redeem(owner.cookie, code, rewardId)).status, 200);
  const corrected = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body: { code, categories, requestId: createRequestId(), expectedStamps: full.value.customer.stamps } });
  assert.deepEqual(corrected.value.customer.stamps, {});
  assert.equal(corrected.value.customer.bingo.discount, 0);
  assert.equal(corrected.value.customer.redemptions.length, 11);
  assert.deepEqual(corrected.value.customer.rewards.availableRewards, []);
  const restamped = await app.stamp(owner.cookie, code, categories);
  assert.deepEqual(restamped.value.customer.rewards.availableRewards, []);
  assert.equal((await app.redeem(owner.cookie, code, 'blackout')).status, 409);
  for (const rewardId of lineIds) assert.equal((await app.redeem(owner.cookie, code, rewardId)).status, 409);
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
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: migrated.email, lastName: migrated.lastName } });
  assert.equal(login.value.customer.id, migrated.id);
});

test('receipts from the old award format still protect repeat confirmations after deployment', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('OldReceipt');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const requestId = createRequestId();
  await app.stamp(owner.cookie, code, ['maki'], { requestId });
  await app.store.transaction((state) => {
    delete state.requests[requestId].operation;
    state.requests[requestId].fingerprint = createHash('sha256').update(JSON.stringify({ code, categories: ['maki'], directOrder: true })).digest('hex');
  });
  const repeat = await app.stamp(owner.cookie, code, ['maki'], { requestId });
  assert.equal(repeat.value.repeated, true);
  assert.equal(repeat.value.customer.orders.length, 1);
});

test('existing accounts keep legacy recovery hashes privately but sign in only with last name and email', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Existing');
  const oldCode = randomBytes(16).toString('hex');
  const recoveryHash = createHash('sha256').update(oldCode).digest('hex');
  const date = new Date().toISOString();
  await app.store.transaction((state) => {
    const customer = state.customers[signup.value.customer.id];
    customer.recoveryHash = recoveryHash;
    customer.lastName = 'Ｇｕｅｓｔ';
    customer.name = 'Existing Ｇｕｅｓｔ';
    customer.stamps = { maki: date };
    customer.redeemed = true;
    delete customer.redeemedDiscount;
  });
  await app.restart();
  const legacy = await app.request('/api/customer', { cookie: signup.cookie });
  assert.equal(legacy.value.customer.needsProfile, false);
  assert.equal(legacy.value.customer.redeemedDiscount, null);
  const rejected = await app.request('/api/customer/login', { method: 'POST', body: { email: signup.value.customer.email, recoveryCode: oldCode } });
  assert.equal(rejected.status, 401);
  const login = await app.request('/api/customer/login', { method: 'POST', body: { email: ` ${signup.value.customer.email.toUpperCase()} `, lastName: ' gUeSt ' } });
  assert.equal(login.status, 200);
  assert.equal(login.value.customer.id, signup.value.customer.id);
  assert.equal(login.value.customer.code, signup.value.customer.code);
  assert.deepEqual(login.value.customer.stamps, { maki: date });
  assert.equal(login.value.customer.recoveryHash, undefined);
  assert.equal(login.value.recoveryCode, undefined);
  assert.equal(await app.store.read((state) => state.customers[signup.value.customer.id].recoveryHash), recoveryHash);
});

test('failed registrations are bounded for one email without blocking another customer at the same address', async (t) => {
  const app = await fixture(t);
  const body = { firstName: '', lastName: 'Guest', email: 'mistyped@example.test' };
  for (let index = 0; index < 12; index++) assert.equal((await app.request('/api/customer', { method: 'POST', body })).status, 400);
  assert.equal((await app.request('/api/customer', { method: 'POST', body })).status, 429);
  assert.equal((await app.customer('Different', 'different@example.test')).status, 201);
});

test('request UUID casing cannot bypass award and correction receipts', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('Casing');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  const requestId = createRequestId();
  const stamped = await app.stamp(owner.cookie, code, ['maki'], { requestId: requestId.toUpperCase() });
  const retry = await app.stamp(owner.cookie, code, ['maki'], { requestId });
  assert.equal(retry.value.repeated, true);
  assert.equal(retry.value.customer.orders.length, 1);
  const correctionId = createRequestId();
  const correction = { code, categories: ['maki'], requestId: correctionId.toUpperCase(), expectedStamps: { maki: stamped.value.customer.stamps.maki } };
  const removed = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body: correction });
  assert.equal(removed.value.customer.corrections[0].id, correctionId);
  const removedRetry = await app.request('/api/owner/stamps/remove', { method: 'POST', cookie: owner.cookie, body: { ...correction, requestId: correctionId } });
  assert.equal(removedRetry.value.repeated, true);
  assert.equal(removedRetry.value.customer.corrections.length, 1);
});

test('redemption retries preserve the selected reward and cannot silently consume the next discount', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('RetryRewards');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  await app.stamp(owner.cookie, code, categories);
  const requestId = createRequestId();
  const first = await app.redeem(owner.cookie, code, 'line-row-1', { requestId });
  assert.equal(first.status, 200);
  const retry = await app.redeem(owner.cookie, code, 'line-row-1', { requestId: requestId.toUpperCase() });
  assert.equal(retry.status, 200);
  assert.equal(retry.value.repeated, true);
  assert.deepEqual(retry.value.redemption, first.value.redemption);
  assert.equal(retry.value.customer.redemptions.length, 1);
  assert.deepEqual(retry.value.customer.rewards.availableRewards.map(reward=>reward.id), [...lineIds.slice(1), 'blackout']);
  assert.equal((await app.redeem(owner.cookie, code, 'line-row-2', { requestId })).status, 409);
  assert.equal((await app.redeem(owner.cookie, code, 'blackout', { requestId })).status, 409);
  const full = await app.redeem(owner.cookie, code, 'blackout');
  assert.equal(full.status, 200);
  const laterRetry = await app.redeem(owner.cookie, code, 'line-row-1', { requestId });
  assert.equal(laterRetry.value.repeated, true);
  assert.deepEqual(laterRetry.value.redemption, first.value.redemption);
  assert.equal(laterRetry.value.customer.redemptions.length, 2);
  await app.store.transaction(state=>{delete state.requests[requestId];});
  const ledgerRetry = await app.redeem(owner.cookie, code, 'line-row-1', { requestId });
  assert.equal(ledgerRetry.status, 200);
  assert.equal(ledgerRetry.value.repeated, true);
  assert.deepEqual(ledgerRetry.value.redemption, first.value.redemption);
  assert.equal((await app.redeem(owner.cookie, code, 'line-row-2', { requestId })).status, 409);
  const other = await app.customer('OtherRewardCard');
  await app.stamp(owner.cookie, other.value.customer.code, categories);
  assert.equal((await app.redeem(owner.cookie, other.value.customer.code, 'line-row-1', { requestId })).status, 409);
  assert.equal((await app.redeem(owner.cookie, code, 'line-row-1')).status, 409);
});

test('parallel confirmations redeem one selected line once and retain concurrent different-line claims', async (t) => {
  const app = await fixture(t);
  const signup = await app.customer('ParallelRewards');
  const owner = await app.owner();
  const code = signup.value.customer.code;
  await app.stamp(owner.cookie, code, categories);
  const parallel = await Promise.all(Array.from({length:5},()=>app.redeem(owner.cookie,code,'line-row-1')));
  assert.deepEqual(parallel.map(result=>result.status).sort(),[200,409,409,409,409]);
  const customer = (await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
  assert.equal(customer.redemptions.length,1);
  assert.deepEqual(customer.rewards.availableRewards.map(reward=>reward.id),[...lineIds.slice(1), 'blackout']);
  const distinct = await Promise.all(['line-row-2','line-column-1'].map(rewardId=>app.redeem(owner.cookie,code,rewardId)));
  assert.ok(distinct.every(result=>result.status===200));
  const afterDistinct = (await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
  assert.deepEqual(afterDistinct.redemptions.map(entry=>entry.rewardId).sort(), ['line-column-1','line-row-1','line-row-2']);
  const requestId=createRequestId();
  const retries = await Promise.all(Array.from({length:3},()=>app.redeem(owner.cookie,code,'blackout',{requestId})));
  assert.ok(retries.every(result=>result.status===200));
  assert.equal(retries.filter(result=>!result.value.repeated).length,1);
  assert.ok(retries.every(result=>result.value.customer.redemptions.length===4));
});

test('redemption requires an explicit current reward and customer profile updates cannot forge or clear its history', async (t) => {
  const app = await fixture(t);
  const signup=await app.customer('ProtectedRewards');
  const owner=await app.owner();
  const code=signup.value.customer.code;
  await app.stamp(owner.cookie,code,['maki','poke','gyoza','sushi-pizza']);
  const oldClient=await app.request('/api/owner/redeem',{method:'POST',cookie:owner.cookie,body:{code,requestId:createRequestId()}});
  assert.equal(oldClient.status,409);
  assert.match(oldClient.value.error,/Refresh this page/);
  const aggregateClient=await app.redeem(owner.cookie,code,'first-line');
  assert.equal(aggregateClient.status,409);
  assert.match(aggregateClient.value.error,/Refresh this page/);
  for(const rewardId of ['invalid',25,['line-row-1'],null]) assert.equal((await app.redeem(owner.cookie,code,rewardId)).status,400);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-1',{requestId:undefined})).status,400);
  assert.equal((await app.redeem(owner.cookie,code,'blackout')).status,409);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-2')).status,409);
  assert.equal((await app.redeem(owner.cookie,code,'line-column-1')).status,409);
  const redeemed=await app.redeem(owner.cookie,code,'line-row-1');
  assert.equal(redeemed.status,200);
  const forged=await app.request('/api/customer',{method:'PATCH',cookie:signup.cookie,body:{firstName:'ProtectedRewards',lastName:'Guest',email:signup.value.customer.email,redemptions:[],redeemed:false,redeemedDiscount:0,rewards:{availableRewards:[{id:'blackout',discount:25}]}}});
  assert.equal(forged.status,200);
  assert.deepEqual(forged.value.customer.redemptions,redeemed.value.customer.redemptions);
  assert.deepEqual(forged.value.customer.rewards.availableRewards,[]);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-1')).status,409);
});

test('an unredeemed full-card discount is unavailable after a correction and returns after a legitimate re-stamp', async (t) => {
  const app=await fixture(t);
  const signup=await app.customer('CorrectRewards');
  const owner=await app.owner();
  const code=signup.value.customer.code;
  const full=await app.stamp(owner.cookie,code,categories);
  const line=await app.redeem(owner.cookie,code,'line-row-1');
  const corrected=await app.request('/api/owner/stamps/remove',{method:'POST',cookie:owner.cookie,body:{code,categories:['maki'],requestId:createRequestId(),expectedStamps:{maki:full.value.customer.stamps.maki}}});
  assert.equal(corrected.status,200);
  assert.deepEqual(corrected.value.customer.redemptions,line.value.customer.redemptions);
  assert.deepEqual(corrected.value.customer.rewards.availableRewards.map(reward=>reward.id),lineIds.filter(id=>!['line-row-1','line-column-1','line-diagonal-main'].includes(id)));
  assert.equal((await app.redeem(owner.cookie,code,'blackout')).status,409);
  const restamped=await app.stamp(owner.cookie,code,['maki']);
  assert.deepEqual(restamped.value.customer.rewards.availableRewards.map(reward=>reward.id),[...lineIds.slice(1), 'blackout']);
  assert.equal((await app.redeem(owner.cookie,code,'blackout')).status,200);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-1')).status,409);
});

test('legacy summaries preserve one unknown-line credit for known 10%, only blackout for 25%, and block unknown history', async (t) => {
  const app=await fixture(t);
  const owner=await app.owner();
  const date=new Date().toISOString();
  for(const [name,previousDiscount,usedId,remainingLines] of [['UsedTen',10,'first-line',9],['UsedTwentyFive',25,'blackout',10],['Unknown',null,'legacy-unknown',0]]){
    const signup=await app.customer(name);
    await app.store.transaction(state=>{
      const customer=state.customers[signup.value.customer.id];
      customer.stamps=Object.fromEntries(categories.map(id=>[id,date]));
      customer.redeemed=true;
      customer.redeemedDiscount=previousDiscount;
      // An older in-flight function can write these summary fields after a
      // newer deployment first created an empty ledger. Preserve that use.
      customer.redemptions=[];
    });
    await app.restart();
    let restored=(await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
    assert.equal(restored.redemptions.length,1);
    assert.equal(restored.redemptions[0].rewardId,usedId);
    assert.equal(restored.redemptions[0].discount,previousDiscount);
    assert.equal(restored.rewards.availableRewards.filter(reward=>reward.discount===10).length,remainingLines);
    assert.equal(restored.rewards.availableRewards.some(reward=>reward.id==='blackout'),previousDiscount===10);
    if(previousDiscount===null){
      assert.equal(restored.rewards.legacyUnknown,true);
      assert.deepEqual(restored.rewards.availableRewards,[]);
      for(const rewardId of [...lineIds,'blackout']) assert.equal((await app.redeem(owner.cookie,restored.code,rewardId)).status,409);
      continue;
    }
    const oldRequest=await app.redeem(owner.cookie,restored.code,usedId);
    assert.equal(oldRequest.status,409);
    if(previousDiscount===10) assert.match(oldRequest.value.error,/Refresh this page/);
    while(restored.rewards.availableRewards.length){
      const next=await app.redeem(owner.cookie,restored.code,restored.rewards.availableRewards[0].id);
      assert.equal(next.status,200);
      restored=next.value.customer;
    }
    assert.equal(restored.redemptions.length,11);
    assert.equal(restored.redemptions.filter(entry=>entry.discount===10).length,10);
    assert.equal(restored.redemptions.filter(entry=>entry.discount===25).length,1);
    // Retain the old aggregate receipt as a credit; never rewrite it as a
    // specific row, column, or diagonal that the old record cannot prove.
    assert.equal(restored.redemptions[0].rewardId,usedId);
  }
});

test('a failed durable redemption is not acknowledged or recorded and the same request can succeed later', async (t) => {
  const app=await fixture(t);
  const signup=await app.customer('DurableReward');
  const owner=await app.owner();
  const code=signup.value.customer.code;
  await app.stamp(owner.cookie,code,['maki','poke','gyoza','sushi-pizza']);
  const requestId=createRequestId(),persist=app.store.persist;
  app.store.persist=async()=>{throw new Error('Simulated unavailable private storage');};
  const failed=await app.redeem(owner.cookie,code,'line-row-1',{requestId});
  assert.equal(failed.status,500);
  assert.equal(await app.store.read(state=>state.customers[signup.value.customer.id].redemptions.length),0);
  assert.equal(await app.store.read(state=>state.requests[requestId]),undefined);
  app.store.persist=persist;
  const succeeded=await app.redeem(owner.cookie,code,'line-row-1',{requestId});
  assert.equal(succeeded.status,200);
  assert.equal(succeeded.value.customer.redemptions.length,1);
});

test('a legacy aggregate reward receipt replays its original discount with the current customer after deployment', async (t) => {
  const app=await fixture(t);
  const signup=await app.customer('LegacyReceipt');
  const owner=await app.owner();
  const code=signup.value.customer.code;
  const requestId=randomUUID(),date=new Date().toISOString();
  const redemption={id:requestId,rewardId:'first-line',discount:10,date,actor:'owner'};
  await app.store.transaction(state=>{
    const customer=state.customers[signup.value.customer.id];
    customer.stamps=Object.fromEntries(categories.map(id=>[id,date]));
    customer.redemptions=[redemption];
    customer.redeemed=true;
    customer.redeemedDiscount=10;
    state.requests[requestId]={operation:'redeem',fingerprint:createHash('sha256').update(JSON.stringify({operation:'redeem',code,rewardId:'first-line'})).digest('hex'),redemption,date};
  });
  const next=await app.redeem(owner.cookie,code,'line-row-2');
  assert.equal(next.status,200);
  const replay=await app.redeem(owner.cookie,code,'first-line',{requestId:requestId.toUpperCase()});
  assert.equal(replay.status,200);
  assert.equal(replay.value.repeated,true);
  assert.deepEqual(replay.value.redemption,redemption);
  assert.deepEqual(replay.value.customer.redemptions,next.value.customer.redemptions);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-3',{requestId})).status,409);
  const stale=await app.redeem(owner.cookie,code,'first-line');
  assert.equal(stale.status,409);
  assert.match(stale.value.error,/Refresh this page/);
  assert.equal((await app.request('/api/customer',{cookie:signup.cookie})).value.customer.redemptions.length,2);
});

test('expired request receipts are pruned while permanent line history still prevents another use', async (t) => {
  const app=await fixture(t);
  const signup=await app.customer('PrunedReward');
  const owner=await app.owner();
  const code=signup.value.customer.code;
  await app.stamp(owner.cookie,code,categories);
  const saved=await app.redeem(owner.cookie,code,'line-row-1');
  const expired=Date.now()-REQUEST_MAX_AGE_MS-1000;
  const timestamp=expired.toString(16).padStart(12,'0');
  const requestId=`${timestamp.slice(0,8)}-${timestamp.slice(8)}-${createRequestId().slice(14)}`;
  const redemption={...saved.value.redemption,id:requestId,date:new Date(expired).toISOString()};
  await app.store.transaction(state=>{
    const customer=state.customers[signup.value.customer.id];
    customer.redemptions=[redemption];
    customer.rewardHistory=[redemption];
    delete state.requests[saved.value.redemption.id];
    state.requests[requestId]={operation:'redeem',fingerprint:createHash('sha256').update(JSON.stringify({operation:'redeem',code,rewardId:'line-row-1'})).digest('hex'),redemption,date:redemption.date};
  });
  await app.store.transaction(()=>{});
  assert.equal(await app.store.read(state=>state.requests[requestId]),undefined);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-1',{requestId})).status,410);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-1')).status,409);
  await app.restart();
  const customer=(await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
  assert.deepEqual(customer.redemptions,[redemption]);
  assert.equal(customer.rewards.availableRewards.some(reward=>reward.id==='line-row-1'),false);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-2')).status,200);
});

test('a previous warm function cannot erase a named line use by rewriting its older public ledger', async (t) => {
  const app=await fixture(t);
  const signup=await app.customer('WarmFunction');
  const owner=await app.owner();
  const code=signup.value.customer.code;
  await app.stamp(owner.cookie,code,categories);
  const saved=await app.redeem(owner.cookie,code,'line-row-3');
  for(const replacement of [[],[{...saved.value.redemption,rewardId:'first-line'}],[{id:'legacy-first-line',rewardId:'first-line',discount:10,date:null,actor:'owner',legacy:true}]]){
    await app.store.transaction(state=>{state.customers[signup.value.customer.id].redemptions=replacement;});
    await app.restart();
    const restored=(await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
    assert.deepEqual(restored.redemptions,saved.value.customer.redemptions);
    assert.equal(restored.rewardHistory,undefined);
    assert.equal(restored.rewards.availableRewards.filter(reward=>reward.discount===10).length,9);
    assert.equal((await app.redeem(owner.cookie,code,'line-row-3')).status,409);
  }
  const forged=await app.request('/api/customer',{method:'PATCH',cookie:signup.cookie,body:{firstName:'WarmFunction',lastName:'Guest',email:signup.value.customer.email,rewardHistory:[],redemptions:[]}});
  assert.deepEqual(forged.value.customer.redemptions,saved.value.customer.redemptions);
  assert.equal((await app.redeem(owner.cookie,code,'line-row-1')).status,200);
});

test('real old warm-function rewards join private history even after their request receipts are pruned', async (t) => {
  const app=await fixture(t);
  const owner=await app.owner();
  for(const [name,firstReward,oldReward,oldDiscount] of [['OldBlackout','line-row-3','blackout',25],['OldLine','blackout','first-line',10]]){
    const signup=await app.customer(name);
    const code=signup.value.customer.code;
    await app.stamp(owner.cookie,code,categories);
    const first=await app.redeem(owner.cookie,code,firstReward);
    assert.equal(first.status,200);
    const expired=Date.now()-REQUEST_MAX_AGE_MS-1000;
    const timestamp=expired.toString(16).padStart(12,'0');
    const requestId=`${timestamp.slice(0,8)}-${timestamp.slice(8)}-${createRequestId().slice(14)}`;
    const oldRedemption={id:requestId,rewardId:oldReward,discount:oldDiscount,date:new Date(expired).toISOString(),actor:'owner'};
    await app.store.transaction(state=>{
      const customer=state.customers[signup.value.customer.id];
      // The old function preserves private history but rewrites its known
      // public schema, then records the genuine new discount it just applied.
      customer.redemptions=oldReward==='blackout'
        ? [{id:'legacy-first-line',rewardId:'first-line',discount:10,date:null,actor:'owner',legacy:true},oldRedemption]
        : [first.value.redemption,oldRedemption];
      customer.redeemed=true;
      customer.redeemedDiscount=oldDiscount;
      state.requests[requestId]={operation:'redeem',fingerprint:createHash('sha256').update(JSON.stringify({operation:'redeem',code,rewardId:oldReward})).digest('hex'),redemption:oldRedemption,date:oldRedemption.date};
    });
    // Local and Blob transactions prune receipts before account migration.
    // History must remain recoverable from the durable public UUID record.
    await app.store.transaction(()=>{});
    assert.equal(await app.store.read(state=>state.requests[requestId]),undefined);
    await app.restart();
    const restored=(await app.request('/api/customer',{cookie:signup.cookie})).value.customer;
    assert.deepEqual(restored.redemptions,[first.value.redemption,oldRedemption]);
    assert.equal(restored.rewards.availableRewards.filter(reward=>reward.discount===10).length,9);
    assert.equal(restored.rewards.availableRewards.some(reward=>reward.id==='blackout'),false);
    assert.equal((await app.redeem(owner.cookie,code,oldReward)).status,409);
    const next=await app.redeem(owner.cookie,code,restored.rewards.availableRewards[0].id);
    assert.equal(next.status,200);
    assert.deepEqual(next.value.customer.redemptions.slice(0,2),restored.redemptions);
    assert.deepEqual(await app.store.read(state=>state.customers[signup.value.customer.id].rewardHistory),next.value.customer.redemptions);
  }
});
