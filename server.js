import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from './server/store.js';
import { OWNER_ACCESS_RECORD } from './server/owner-access.js';
import { BINGO_REWARDS, CATEGORIES, getBingoStatus, getRedemptions, getRewardStatus } from './src/loyalty.js';
import { requestTime, REQUEST_MAX_AGE_MS, FUTURE_SKEW_MS } from './src/request-id.js';

const deriveKey = promisify(scrypt);
const root = dirname(fileURLToPath(import.meta.url));
// Keep the original private storage location so the rename preserves accounts.
const defaultDataDir = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'UmamiPassport')
  : '/workspace/umami-data';
const categoryIds = CATEGORIES.map((category) => category.id);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new APIError(status, message); }
const digest = (value) => createHash('sha256').update(value).digest('hex');
function normalizeCode(value) {
  if (typeof value !== 'string') fail(400, 'Enter a customer bingo code.');
  const code = value.trim().replace(/^UMAMI\s*:/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(code)) fail(400, 'This is not a valid Umami Bingo QR code.');
  return code;
}
function publicCustomer(customer) {
  const { id, code, version, firstName = '', lastName = '', email = '', name, stamps, directOrders, orders } = customer;
  const redemptions = getRedemptions(customer);
  const redeemed = redemptions.length > 0;
  const redeemedDiscount = redeemed ? redemptions.at(-1).discount : 0;
  const needsProfile = !firstName || !lastName || !email;
  return { id, code, version, cardVersion: customer.cardVersion ?? 0, firstName, lastName, email, name, needsProfile, stamps: { ...stamps }, directOrders, orders: structuredClone(orders), corrections: structuredClone(customer.corrections || []), redemptions, rewards: getRewardStatus(customer), redeemed, redeemedDiscount, bingo: getBingoStatus(stamps) };
}
function findCustomer(state, code) {
  const customer = Object.values(state.customers).find((entry) => entry.code === code);
  if (!customer) fail(404, 'No customer found for this bingo code.');
  return customer;
}
function profileFrom(body) {
  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!firstName || !lastName || firstName.length > 60 || lastName.length > 60) fail(400, 'Enter your first and last name, up to 60 characters each.');
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  return { firstName, lastName, email, name: `${firstName} ${lastName}` };
}
function normalizedLastName(value) {
  return typeof value === 'string' ? value.trim().normalize('NFKC').toLowerCase() : '';
}
function requestIdentity(state, raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) fail(400, 'A valid request ID is required to save this change.');
  const id = raw.toLowerCase();
  const previous = state.requests[id] || state.requests[raw] || state.requests[raw.toUpperCase()];
  if (!previous) {
    const timestamp = requestTime(id);
    if (timestamp === null) fail(409, 'This save request is no longer recognized. Reload the customer before trying again.');
    if (timestamp - Date.now() > FUTURE_SKEW_MS) fail(400, 'This request has an invalid future date. Reload the customer before trying again.');
    if (Date.now() - timestamp > REQUEST_MAX_AGE_MS) fail(410, 'This save request has expired. Reload the customer before trying again.');
  }
  return { id, previous };
}
function requireCardVersion(customer, supplied) {
  const current = customer.cardVersion ?? 0;
  // Old clients may finish the original card, but cannot change a replacement.
  if (supplied === undefined && current === 0) return current;
  if (supplied === undefined) fail(409, 'This bingo card has been reset. Reload the customer before making another change.');
  if (!Number.isSafeInteger(supplied) || supplied < 0) fail(400, 'Include a valid bingo card version.');
  if (supplied !== current) fail(409, 'This bingo card has changed. Reload the customer before making another change.');
  return current;
}
function cardFingerprint(value, cardVersion) {
  // Preserve original fingerprints so saved version-zero receipts still replay.
  return digest(JSON.stringify({ ...value, ...(cardVersion ? { cardVersion } : {}) }));
}
function snapshotJSON(value) {
  if (Array.isArray(value)) return `[${value.map(snapshotJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${snapshotJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function recordedRedemption(customer, requestId) {
  for (const card of [customer, ...(customer.cardHistory || [])]) {
    const redemption = getRedemptions(card).find((entry) => entry.id === requestId);
    if (redemption) return { redemption, cardVersion: card.cardVersion ?? 0 };
  }
  return null;
}
function applyProfile(state, customer, profile) {
  if (Object.values(state.customers).some((entry) => entry.id !== customer.id && entry.email === profile.email)) fail(409, 'Unable to create this account. If you registered before, sign in with your last name and email.');
  Object.assign(customer, profile);
}
function migrateCustomer(customer) {
  customer.cardVersion ??= 0;
  const redemptions = getRedemptions(customer);
  // A warm older function can still record a real aggregate-line or blackout
  // redemption after private history exists. Keep those durable UUID entries,
  // even after their request receipts expire; exclude its synthetic fallbacks.
  for (const entry of getRedemptions({ redemptions: customer.redemptions })) {
    if (!['first-line', 'blackout'].includes(entry.rewardId) || entry.legacy === true) continue;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.id)) continue;
    if (typeof entry.date !== 'string' || Number.isNaN(Date.parse(entry.date))) continue;
    if (!redemptions.some((recorded) => recorded.id === entry.id || recorded.rewardId === entry.rewardId)) redemptions.push(entry);
  }
  customer.redemptions = redemptions;
  // Older warm functions may rewrite the public ledger using their old reward
  // schema. Preserve the full permanent history in a private companion field.
  customer.rewardHistory = structuredClone(customer.redemptions);
  if (customer.redeemedDiscount === undefined) customer.redeemedDiscount = customer.redeemed ? null : 0;
  if (customer.version >= 3) return;
  // The old broad categories cannot prove which new bingo item was bought.
  // Preserve that history while retaining only exact matching paid squares.
  customer.legacyStamps = { ...customer.legacyStamps, ...customer.stamps };
  const retainedIds = customer.version === 2 ? ['maki', 'poke', 'gyoza', 'onigiri', 'platter'] : ['maki', 'platter'];
  customer.stamps = Object.fromEntries(Object.entries(customer.stamps || {}).filter(([key, date]) => retainedIds.includes(key) && typeof date === 'string' && !Number.isNaN(Date.parse(date))));
  customer.version = 3;
  customer.corrections ||= [];
  customer.firstName ||= '';
  customer.lastName ||= '';
  customer.email ||= '';
  customer.redeemedDiscount ??= customer.redeemed ? null : 0;
}
function passwordFrom(body) {
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 256) fail(400, 'Use a password between 10 and 256 characters.');
  return body.password;
}
async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await deriveKey(password, salt, 64)).toString('hex') };
}
async function passwordMatches(password, record) {
  const actual = await deriveKey(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function cookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
    const position = part.indexOf('=');
    return position < 0 ? ['', ''] : [part.slice(0, position).trim(), part.slice(position + 1)];
  }));
}
function session(state, request, role) {
  const token = cookies(request)[`umami_${role}`];
  const entry = token && state.sessions[digest(token)];
  if (!entry || entry.role !== role || entry.expires <= Date.now()) fail(401, role === 'owner' ? 'Sign in as the owner to continue.' : 'Create or open your customer bingo card first.');
  return entry;
}
function newSessionCookie(state, request, role, customerId, secureCookies = false) {
  const token = randomBytes(32).toString('hex');
  const maxAge = role === 'owner' ? 12 * 60 * 60 : 365 * 24 * 60 * 60;
  const old = cookies(request)[`umami_${role}`];
  if (old) delete state.sessions[digest(old)];
  state.sessions[digest(token)] = { role, ...(customerId ? { customerId } : {}), expires: Date.now() + maxAge * 1000 };
  for (const [key, entry] of Object.entries(state.sessions)) if (entry.expires <= Date.now()) delete state.sessions[key];
  const secure = request.socket.encrypted || secureCookies;
  return `umami_${role}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
async function bodyFrom(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) fail(415, 'Send JSON with Content-Type: application/json.');
  if (Number(request.headers['content-length']) > 16384) fail(413, 'The request is too large.');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) fail(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object.');
    return body;
  } catch (error) {
    if (error instanceof APIError) throw error;
    fail(400, 'The JSON request could not be read.');
  }
}
function checkMutationOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Open the app directly to make changes.');
  if (request.headers.origin) {
    try {
      const origin = new URL(request.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) fail(403, 'This request came from a different site.');
    } catch (error) {
      if (error instanceof APIError) throw error;
      fail(403, 'This request came from a different site.');
    }
  }
}
function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}
function publicPath(pathname) {
  if (['/', '/index.html', '/owner', '/owner/', '/customer', '/customer/'].includes(pathname)) return 'index.html';
  if (pathname === '/style.css' || pathname === '/owner.css') return pathname.slice(1);
  if (/^\/src\/[a-zA-Z0-9_-]+\.js$/.test(pathname)) return pathname.slice(1);
  if (/^\/assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|gif|svg|ico|ttf|woff2?)$/i.test(pathname)) {
    if (pathname.split('/').some((part) => part === '..' || part === '.')) return null;
    return pathname.slice(1);
  }
  return null;
}

export async function createApp({ dataDir = process.env.UMAMI_DATA_DIR || defaultDataDir, store: injectedStore, ownerPassword = process.env.OWNER_PASSWORD, ownerAccessRecord = OWNER_ACCESS_RECORD, clientAddress = (request) => request.socket.remoteAddress || 'unknown', secureCookies = process.env.UMAMI_HTTPS === '1', allowOwnerSetup = true } = {}) {
  if (ownerAccessRecord !== null && (!ownerAccessRecord || typeof ownerAccessRecord.salt !== 'string' || !/^[a-f0-9]{128}$/i.test(ownerAccessRecord.hash || ''))) {
    throw new Error('The private owner access record is invalid.');
  }
  const persistentStore = injectedStore || new Store(dataDir);
  await persistentStore.ready;
  const validLegacyPassword = typeof ownerPassword === 'string' && ownerPassword.length >= 10 && ownerPassword.length <= 256;
  if (ownerPassword) {
    if (!validLegacyPassword && !ownerAccessRecord) throw new Error('OWNER_PASSWORD must contain 10 to 256 characters.');
  }
  const migrate = (state) => { for (const customer of Object.values(state.customers)) migrateCustomer(customer); return state; };
  // Migrate the one fresh snapshot already needed by each operation. Reads stay
  // read-only on durable storage; the next mutation persists migrated records.
  const store = {
    read: (callback) => persistentStore.read((state) => callback(migrate(state))),
    transaction: (callback) => persistentStore.transaction(async (state) => {
      migrate(state);
      if (validLegacyPassword && !state.owner) state.owner = await passwordRecord(ownerPassword);
      return callback(state);
    }),
  };
  async function authentication(request, scope, identity, callback) {
    const result = await store.transaction(async (state) => {
      state.authAttempts ||= {};
      const now = Date.now();
      for (const [address, entry] of Object.entries(state.authAttempts)) if (now - entry.since >= 15 * 60 * 1000) delete state.authAttempts[address];
      const key = `${scope}:${digest(`${String(clientAddress(request))}|${identity}`)}`;
      const entry = state.authAttempts[key];
      if (entry?.count >= 12) return { failure: { status: 429, message: 'Too many failed attempts. Try again in 15 minutes.' } };
      try {
        const value = await callback(state);
        delete state.authAttempts[key];
        return { value };
      } catch (error) {
        if (!(error instanceof APIError) || error.status >= 500) throw error;
        state.authAttempts[key] = { since: entry?.since || now, count: (entry?.count || 0) + 1 };
        return { failure: { status: error.status, message: error.message } };
      }
    });
    if (result.failure) fail(result.failure.status, result.failure.message);
    return result.value;
  }
  function signedIn(response, result, status = 200) {
    response.setHeader('Set-Cookie', result.cookie);
    return json(response, result.payload, status);
  }

  async function api(request, response, url) {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/status') return json(response, await store.read((state) => ({ ownerConfigured: Boolean(state.owner || ownerAccessRecord || validLegacyPassword), ownerSetupAllowed: allowOwnerSetup && !ownerAccessRecord })));
    if (route === 'GET /api/health') return json(response, { ready: true });
    if (route === 'GET /api/customer') return json(response, await store.read((state) => {
      const auth = session(state, request, 'customer');
      return { customer: publicCustomer(state.customers[auth.customerId]) };
    }));
    if (route === 'GET /api/owner/session') {
      await store.read((state) => session(state, request, 'owner'));
      return json(response, { authenticated: true });
    }
    if (route === 'GET /api/owner/customer') return json(response, await store.read((state) => {
      session(state, request, 'owner');
      return { customer: publicCustomer(findCustomer(state, normalizeCode(url.searchParams.get('code')))) };
    }));
    if (route === 'GET /api/owner/accounts') return json(response, await store.read((state) => {
      session(state, request, 'owner');
      const offsetText = url.searchParams.get('offset') ?? '0';
      const limitText = url.searchParams.get('limit') ?? '50';
      const offset = Number(offsetText), limit = Number(limitText);
      if (!/^\d+$/.test(offsetText) || !/^\d+$/.test(limitText) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Use a valid account page and page size.');
      const directory = Object.values(state.customers).map(({ id, name, firstName = '', lastName = '', email = '', code }) => ({ id, name: name || [firstName, lastName].filter(Boolean).join(' '), email, code }));
      directory.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
      const accounts = directory.slice(offset, offset + limit), total = directory.length;
      return { accounts, total, nextOffset: offset + accounts.length < total ? offset + accounts.length : null };
    }));
    if (route === 'GET /api/owner/customers') return json(response, await store.read((state) => {
      session(state, request, 'owner');
      const query = (url.searchParams.get('q') || '').trim().normalize('NFKC').toLowerCase();
      if (query.length < 2 || query.length > 120) fail(400, 'Search using between 2 and 120 characters.');
      const customers = Object.values(state.customers).filter((customer) => [customer.name || `${customer.firstName || ''} ${customer.lastName || ''}`, customer.email || ''].some((value) => value.normalize('NFKC').toLowerCase().includes(query))).slice(0, 20).map(({ id, name, email, code }) => ({ id, name, email, code }));
      return { customers };
    }));
    if (!['POST', 'PATCH'].includes(request.method)) fail(404, 'This API endpoint was not found.');
    checkMutationOrigin(request);
    const body = await bodyFrom(request);
    if (route === 'POST /api/customer') {
      const registrationEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const result = await authentication(request, 'registration', registrationEmail, (state) => {
        const profile = profileFrom(body);
        // Repeated setup taps should not silently replace an existing bingo card.
        try {
          const auth = session(state, request, 'customer');
          const customer = state.customers[auth.customerId];
          if (customer.email && customer.email !== profile.email) fail(409, 'You are already signed in. Sign out before creating another account.');
          applyProfile(state, customer, profile);
          return { payload: { customer: publicCustomer(customer) } };
        } catch (error) { if (error.status !== 401) throw error; }
        const id = randomUUID();
        const customer = { id, code: randomBytes(16).toString('hex').toUpperCase(), version: 3, cardVersion: 0, stamps: {}, directOrders: 0, orders: [], corrections: [], redemptions: [], rewardHistory: [], redeemed: false, redeemedDiscount: 0 };
        applyProfile(state, customer, profile);
        state.customers[id] = customer;
        return { cookie: newSessionCookie(state, request, 'customer', id, secureCookies), payload: { customer: publicCustomer(customer) } };
      });
      if (result.cookie) return signedIn(response, result, 201);
      return json(response, result.payload, 201);
    }
    if (route === 'PATCH /api/customer') {
      const profile = profileFrom(body);
      return json(response, await store.transaction((state) => {
        const auth = session(state, request, 'customer');
        const customer = state.customers[auth.customerId];
        applyProfile(state, customer, profile);
        return { customer: publicCustomer(customer) };
      }));
    }
    if (route === 'POST /api/customer/login') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const lastName = normalizedLastName(body.lastName);
      const result = await authentication(request, 'customer', email, (state) => {
        const customer = Object.values(state.customers).find((entry) => entry.email === email);
        if (!customer || !lastName || normalizedLastName(customer.lastName) !== lastName) fail(401, 'The last name or email is incorrect.');
        return { cookie: newSessionCookie(state, request, 'customer', customer.id, secureCookies), payload: { customer: publicCustomer(customer) } };
      });
      return signedIn(response, result);
    }
    if (route === 'POST /api/customer/logout') {
      await store.transaction((state) => {
        const token = cookies(request).umami_customer;
        if (token) delete state.sessions[digest(token)];
      });
      response.setHeader('Set-Cookie', `umami_customer=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`);
      return json(response, { authenticated: false });
    }
    if (route === 'POST /api/owner/setup') {
      if (!allowOwnerSetup || ownerAccessRecord) fail(403, 'Owner setup is disabled. Sign in using the private owner access code.');
      const result = await authentication(request, 'owner', '', async (state) => {
        const password = passwordFrom(body);
        if (state.owner) fail(409, 'The owner is already set up. Sign in instead.');
        state.owner = await passwordRecord(password);
        return { cookie: newSessionCookie(state, request, 'owner', undefined, secureCookies), payload: { authenticated: true } };
      });
      return signedIn(response, result, 201);
    }
    if (route === 'POST /api/owner/login') {
      const usingCode = body.code !== undefined;
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const result = await authentication(request, 'owner', '', async (state) => {
        const password = usingCode ? null : passwordFrom(body);
        if (usingCode) {
          if (!ownerAccessRecord || !/^[0-9]{1,64}$/.test(code) || !await passwordMatches(code, ownerAccessRecord)) fail(401, 'That owner access code is incorrect.');
        } else {
          if (!state.owner) fail(401, 'Sign in using the private owner access code.');
          if (!await passwordMatches(password, state.owner)) fail(401, 'That owner password is incorrect.');
        }
        return { cookie: newSessionCookie(state, request, 'owner', undefined, secureCookies), payload: { authenticated: true } };
      });
      return signedIn(response, result);
    }
    if (route === 'POST /api/owner/logout') {
      await store.transaction((state) => {
        const token = cookies(request).umami_owner;
        if (token) delete state.sessions[digest(token)];
      });
      response.setHeader('Set-Cookie', `umami_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`);
      return json(response, { authenticated: false });
    }
    if (route === 'POST /api/owner/stamps') return json(response, await store.transaction((state) => {
      session(state, request, 'owner');
      const code = normalizeCode(body.code);
      if (!Array.isArray(body.categories) || body.categories.length === 0 || body.categories.length > categoryIds.length || body.categories.some((category) => !categoryIds.includes(category))) fail(400, 'Select at least one valid category.');
      if (typeof body.directOrder !== 'boolean') fail(400, 'Specify whether this was a direct order.');
      const { id: requestId, previous } = requestIdentity(state, body.requestId);
      const categories = [...new Set(body.categories)].sort();
      const customer = findCustomer(state, code);
      const cardVersion = requireCardVersion(customer, body.cardVersion);
      const fingerprint = cardFingerprint({ operation: 'award', code, categories, directOrder: body.directOrder }, cardVersion);
      if (previous) {
        const legacyFingerprint = cardVersion === 0 && !previous.operation && digest(JSON.stringify({ code, categories, directOrder: body.directOrder }));
        if (previous.fingerprint !== fingerprint && previous.fingerprint !== legacyFingerprint) fail(409, 'This request ID was already used for a different visit.');
        return { customer: publicCustomer(customer), earned: previous.earned, repeated: true };
      }
      // Distinct visits need distinct dates so a stale correction cannot remove
      // a legitimate re-award that happened within the same clock millisecond.
      const previousVisit = Date.parse(customer.orders[0]?.date);
      const date = new Date(Math.max(Date.now(), Number.isNaN(previousVisit) ? 0 : previousVisit + 1)).toISOString();
      const earned = categories.filter((category) => !customer.stamps[category]);
      if (earned.length) {
        for (const category of earned) customer.stamps[category] = date;
        if (body.directOrder) customer.directOrders += 1;
        customer.orders.unshift({ id: randomUUID(), date, total: 0, categories, directOrder: body.directOrder });
        customer.orders = customer.orders.slice(0, 50);
      }
      state.requests[requestId] = { operation: 'award', cardVersion, fingerprint, earned, date };
      return { customer: publicCustomer(customer), earned };
    }));
    if (route === 'POST /api/owner/stamps/remove') return json(response, await store.transaction((state) => {
      session(state, request, 'owner');
      const code = normalizeCode(body.code);
      if (!Array.isArray(body.categories) || body.categories.length === 0 || body.categories.length > categoryIds.length || body.categories.some((category) => !categoryIds.includes(category))) fail(400, 'Select at least one valid category to correct.');
      const { id: requestId, previous } = requestIdentity(state, body.requestId);
      const categories = [...new Set(body.categories)].sort();
      const expected = body.expectedStamps;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || categories.some((category) => !Object.hasOwn(expected, category) || typeof expected[category] !== 'string' || Number.isNaN(Date.parse(expected[category])))) fail(400, 'Include the original stamp date for each category being corrected.');
      const expectedStamps = Object.fromEntries(categories.map((category) => [category, expected[category]]));
      const customer = findCustomer(state, code);
      const cardVersion = requireCardVersion(customer, body.cardVersion);
      const fingerprint = cardFingerprint({ operation: 'remove', code, categories, expectedStamps }, cardVersion);
      if (previous) {
        if (previous.operation !== 'remove' || previous.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different change.');
        return { customer: publicCustomer(customer), removed: previous.removed, repeated: true };
      }
      if (categories.some((category) => customer.stamps[category] && customer.stamps[category] !== expectedStamps[category])) fail(409, 'A selected stamp has changed. Reload this customer before correcting it.');
      const removed = categories.filter((category) => customer.stamps[category]);
      const previousStamps = Object.fromEntries(removed.map((category) => [category, customer.stamps[category]]));
      for (const category of removed) delete customer.stamps[category];
      const date = new Date().toISOString();
      if (removed.length) {
        customer.corrections ||= [];
        customer.corrections.push({ id: requestId, date, cardVersion, categories: removed, previousStamps, actor: 'owner' });
      }
      state.requests[requestId] = { operation: 'remove', cardVersion, fingerprint, removed, date };
      return { customer: publicCustomer(customer), removed };
    }));
    if (route === 'POST /api/owner/redeem') return json(response, await store.transaction((state) => {
      session(state, request, 'owner');
      const code = normalizeCode(body.code);
      if (body.rewardId === undefined) fail(409, 'Refresh this page to choose the specific reward before redeeming it.');
      const rewardId = body.rewardId;
      // Keep the old aggregate identity solely for replaying a saved receipt.
      // A stale client must refresh rather than select an arbitrary new line.
      if (rewardId !== 'first-line' && !BINGO_REWARDS.some((reward) => reward.id === rewardId)) fail(400, 'Choose a valid bingo reward.');
      const { id: requestId, previous } = requestIdentity(state, body.requestId);
      const customer = findCustomer(state, code);
      const cardVersion = requireCardVersion(customer, body.cardVersion);
      const fingerprint = cardFingerprint({ operation: 'redeem', code, rewardId }, cardVersion);
      if (previous) {
        if (previous.operation !== 'redeem' || previous.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different change.');
        return { customer: publicCustomer(customer), redemption: structuredClone(previous.redemption), repeated: true };
      }
      if (rewardId === 'first-line') fail(409, 'Refresh this page to choose the specific completed line before redeeming it.');
      // The permanent ledger outlives request receipt pruning. A request UUID
      // can never consume a second reward, including on a different customer.
      for (const entry of Object.values(state.customers)) {
        const recorded = recordedRedemption(entry, requestId);
        if (!recorded) continue;
        if (entry.id !== customer.id || recorded.cardVersion !== cardVersion || recorded.redemption.rewardId !== rewardId) fail(409, 'This request ID was already used for a different change.');
        return { customer: publicCustomer(customer), redemption: structuredClone(recorded.redemption), repeated: true };
      }
      const rewards = getRewardStatus(customer);
      const reward = rewards.availableRewards.find((entry) => entry.id === rewardId);
      if (!reward) {
        if (rewards.legacyUnknown) fail(409, 'This account has a previous reward with an unknown percentage. Its reward history needs review before another discount can be redeemed.');
        if (rewards.usedRewards.some((entry) => entry.id === rewardId)) fail(409, 'This reward has already been redeemed. Each reward can be used once.');
        fail(409, rewardId === 'blackout' ? `Collect all ${categoryIds.length} food stamps before using the 25% full-card reward.` : 'Complete a row, column or diagonal of four before using the 10% reward.');
      }
      const date = new Date().toISOString();
      const redemption = { id: requestId, rewardId, discount: reward.discount, date, actor: 'owner' };
      customer.redemptions = [...getRedemptions(customer), redemption];
      customer.rewardHistory = structuredClone(customer.redemptions);
      // Retain the original fields for older account readers; eligibility comes
      // from the individual permanent ledger entries, never this summary flag.
      customer.redeemed = true;
      customer.redeemedDiscount = reward.discount;
      customer.redeemedAt = date;
      state.requests[requestId] = { operation: 'redeem', cardVersion, fingerprint, redemption: { ...redemption }, date };
      return { customer: publicCustomer(customer), redemption };
    }));
    if (route === 'POST /api/owner/card/reset') return json(response, await store.transaction((state) => {
      session(state, request, 'owner');
      const code = normalizeCode(body.code);
      if (!Number.isSafeInteger(body.cardVersion) || body.cardVersion < 0 || body.cardVersion >= Number.MAX_SAFE_INTEGER) fail(400, 'Include the bingo card version being reset.');
      const expected = body.expectedStamps;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.entries(expected).some(([key, value]) => !categoryIds.includes(key) || typeof value !== 'string' || Number.isNaN(Date.parse(value)))) fail(400, 'Include the current bingo stamps before resetting the card.');
      if (!Array.isArray(body.expectedRedemptions)) fail(400, 'Include the current reward history before resetting the card.');
      const { id: requestId, previous } = requestIdentity(state, body.requestId);
      const customer = findCustomer(state, code);
      const fingerprint = digest(snapshotJSON({ operation: 'reset', code, cardVersion: body.cardVersion, expectedStamps: expected, expectedRedemptions: body.expectedRedemptions }));
      const history = customer.cardHistory || [];
      const savedReset = history.find((card) => card.resetId === requestId);
      if (previous || savedReset) {
        if ((previous && (previous.operation !== 'reset' || previous.fingerprint !== fingerprint)) || (savedReset && savedReset.resetFingerprint !== fingerprint)) fail(409, 'This request ID was already used for a different change.');
        if (customer.cardVersion !== body.cardVersion + 1) fail(409, 'A newer bingo card is already active. Reload the customer before making another change.');
        return { customer: publicCustomer(customer), repeated: true };
      }
      requireCardVersion(customer, body.cardVersion);
      // Check every stamp and reward inside the same durable transaction as reset.
      if (snapshotJSON(customer.stamps) !== snapshotJSON(expected) || snapshotJSON(getRedemptions(customer)) !== snapshotJSON(body.expectedRedemptions)) fail(409, 'This bingo card has changed. Reload it and review the stamps and rewards before resetting.');
      for (const entry of Object.values(state.customers)) {
        if ((entry.cardHistory || []).some((card) => card.resetId === requestId) || recordedRedemption(entry, requestId)) fail(409, 'This request ID was already used for a different change.');
      }
      const date = new Date().toISOString();
      customer.cardHistory = [...history, {
        cardVersion: customer.cardVersion, resetId: requestId, resetFingerprint: fingerprint, resetAt: date, actor: 'owner',
        stamps: { ...customer.stamps }, redemptions: getRedemptions(customer), rewardHistory: structuredClone(customer.rewardHistory || []),
        redeemed: customer.redeemed, redeemedDiscount: customer.redeemedDiscount, ...(customer.redeemedAt ? { redeemedAt: customer.redeemedAt } : {}),
      }];
      customer.cardVersion += 1;
      customer.stamps = {};
      customer.redemptions = [];
      customer.rewardHistory = [];
      customer.redeemed = false;
      customer.redeemedDiscount = 0;
      delete customer.redeemedAt;
      state.requests[requestId] = { operation: 'reset', fingerprint, cardVersion: body.cardVersion, nextCardVersion: customer.cardVersion, date };
      return { customer: publicCustomer(customer) };
    }));
    fail(404, 'This API endpoint was not found.');
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(self)');
    response.setHeader('Cache-Control', 'no-cache');
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/')) {
        response.setHeader('Cache-Control', 'no-store');
        await api(request, response, url);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Method not allowed'); return;
      }
      const relativePath = publicPath(pathname);
      if (!relativePath) { response.writeHead(404); response.end('Not found'); return; }
      try {
        const absolutePath = await realpath(resolve(root, relativePath));
        if (!absolutePath.startsWith(root + sep)) { response.writeHead(404); response.end('Not found'); return; }
        const body = await readFile(absolutePath);
        response.writeHead(200, { 'Content-Type': contentTypes[extname(absolutePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length });
        response.end(request.method === 'HEAD' ? undefined : body);
      } catch (error) {
        const status = ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500;
        response.writeHead(status); response.end(status === 404 ? 'Not found' : 'Unable to read file');
      }
    } catch (error) {
      if (!response.headersSent) {
        // A failed durable write must never leave an authenticated cookie behind.
        response.removeHeader('Set-Cookie');
        const status = error.status || (error instanceof URIError ? 400 : 500);
        if (status >= 500) console.error('Umami request failed:', error.message);
        json(response, { error: status < 500 ? error.message : 'The server could not save this change. Please try again.' }, status);
      } else response.end();
    }
  });
  server.requestTimeout = 15_000;
  return { server, store: persistentStore };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number between 1 and 65535.');
  const { server } = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Umami Bingo is ready at http://localhost:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
