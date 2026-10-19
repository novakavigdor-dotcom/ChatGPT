import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from './server/store.js';

const deriveKey = promisify(scrypt);
const root = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'UmamiPassport')
  : '/workspace/umami-data';
const CATEGORIES = ['maki', 'rice', 'noodles', 'fish', 'platter', 'chef'];
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new APIError(status, message); }
const digest = (value) => createHash('sha256').update(value).digest('hex');
function normalizeCode(value) {
  if (typeof value !== 'string') fail(400, 'Enter a customer passport code.');
  const code = value.trim().replace(/^UMAMI\s*:/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(code)) fail(400, 'This is not a valid Umami Passport QR code.');
  return code;
}
function publicCustomer(customer) {
  const { id, code, version, name, stamps, directOrders, orders, redeemed } = customer;
  return { id, code, version, name, stamps: { ...stamps }, directOrders, orders: structuredClone(orders), redeemed };
}
function findCustomer(state, code) {
  const customer = Object.values(state.customers).find((entry) => entry.code === code);
  if (!customer) fail(404, 'No customer found for this passport code.');
  return customer;
}
function nameFrom(body) {
  if (body.name !== undefined && typeof body.name !== 'string') fail(400, 'Enter a valid name.');
  const name = (body.name || '').trim();
  if (name.length > 30) fail(400, 'Use a name of 30 characters or fewer.');
  return name;
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
  if (!entry || entry.role !== role || entry.expires <= Date.now()) fail(401, role === 'owner' ? 'Sign in as the owner to continue.' : 'Create or open your customer passport first.');
  return entry;
}
function setSession(state, request, response, role, customerId) {
  const token = randomBytes(32).toString('hex');
  const maxAge = role === 'owner' ? 12 * 60 * 60 : 365 * 24 * 60 * 60;
  const old = cookies(request)[`umami_${role}`];
  if (old) delete state.sessions[digest(old)];
  state.sessions[digest(token)] = { role, ...(customerId ? { customerId } : {}), expires: Date.now() + maxAge * 1000 };
  for (const [key, entry] of Object.entries(state.sessions)) if (entry.expires <= Date.now()) delete state.sessions[key];
  const secure = request.socket.encrypted || process.env.UMAMI_HTTPS === '1';
  response.setHeader('Set-Cookie', `umami_${role}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
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

export async function createApp({ dataDir = process.env.UMAMI_DATA_DIR || defaultDataDir, ownerPassword = process.env.OWNER_PASSWORD } = {}) {
  const store = new Store(dataDir);
  await store.ready;
  if (ownerPassword) {
    if (ownerPassword.length < 10 || ownerPassword.length > 256) throw new Error('OWNER_PASSWORD must contain 10 to 256 characters.');
    await store.transaction(async (state) => { if (!state.owner) state.owner = await passwordRecord(ownerPassword); });
  }
  const attempts = new Map();
  function loginRateLimit(request) {
    const key = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    for (const [address, entry] of attempts) if (now - entry.since >= 15 * 60 * 1000) attempts.delete(address);
    const entry = attempts.get(key) || { since: now, count: 0 };
    if (++entry.count > 12) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    attempts.set(key, entry);
  }

  async function api(request, response, url) {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/status') return json(response, await store.read((state) => ({ ownerConfigured: Boolean(state.owner) })));
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
    if (!['POST', 'PATCH'].includes(request.method)) fail(404, 'This API endpoint was not found.');
    checkMutationOrigin(request);
    const body = await bodyFrom(request);
    if (route === 'POST /api/customer') {
      const result = await store.transaction((state) => {
        // Repeated setup taps should not silently replace an existing passport.
        try {
          const auth = session(state, request, 'customer');
          return { customer: publicCustomer(state.customers[auth.customerId]) };
        } catch (error) { if (error.status !== 401) throw error; }
        const id = randomUUID();
        const customer = { id, code: randomBytes(16).toString('hex').toUpperCase(), version: 1, name: nameFrom(body), stamps: {}, directOrders: 0, orders: [], redeemed: false };
        state.customers[id] = customer;
        setSession(state, request, response, 'customer', id);
        return { customer: publicCustomer(customer) };
      });
      return json(response, result, 201);
    }
    if (route === 'PATCH /api/customer') return json(response, await store.transaction((state) => {
      const auth = session(state, request, 'customer');
      const customer = state.customers[auth.customerId];
      customer.name = nameFrom(body);
      return { customer: publicCustomer(customer) };
    }));
    if (route === 'POST /api/owner/setup') {
      loginRateLimit(request);
      const password = passwordFrom(body);
      const result = await store.transaction(async (state) => {
        if (state.owner) fail(409, 'The owner is already set up. Sign in instead.');
        state.owner = await passwordRecord(password);
        setSession(state, request, response, 'owner');
        return { authenticated: true };
      });
      return json(response, result, 201);
    }
    if (route === 'POST /api/owner/login') {
      loginRateLimit(request);
      const password = passwordFrom(body);
      return json(response, await store.transaction(async (state) => {
        if (!state.owner) fail(409, 'Set up the owner account first.');
        if (!await passwordMatches(password, state.owner)) fail(401, 'That owner password is incorrect.');
        setSession(state, request, response, 'owner');
        return { authenticated: true };
      }));
    }
    if (route === 'POST /api/owner/logout') return json(response, await store.transaction((state) => {
      const token = cookies(request).umami_owner;
      if (token) delete state.sessions[digest(token)];
      response.setHeader('Set-Cookie', 'umami_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return { authenticated: false };
    }));
    if (route === 'POST /api/owner/stamps') return json(response, await store.transaction((state) => {
      session(state, request, 'owner');
      const code = normalizeCode(body.code);
      if (!Array.isArray(body.categories) || body.categories.length === 0 || body.categories.length > CATEGORIES.length || body.categories.some((category) => !CATEGORIES.includes(category))) fail(400, 'Select at least one valid category.');
      if (typeof body.directOrder !== 'boolean') fail(400, 'Specify whether this was a direct order.');
      if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) fail(400, 'A valid request ID is required to save this visit.');
      const categories = [...new Set(body.categories)].sort();
      const fingerprint = digest(JSON.stringify({ code, categories, directOrder: body.directOrder }));
      const previous = state.requests[body.requestId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different visit.');
        return { customer: publicCustomer(findCustomer(state, code)), earned: previous.earned, repeated: true };
      }
      const customer = findCustomer(state, code);
      const date = new Date().toISOString();
      const earned = categories.filter((category) => !customer.stamps[category]);
      for (const category of earned) customer.stamps[category] = date;
      if (body.directOrder) customer.directOrders += 1;
      customer.orders.unshift({ id: randomUUID(), date, total: 0, categories, directOrder: body.directOrder });
      customer.orders = customer.orders.slice(0, 50);
      state.requests[body.requestId] = { fingerprint, earned, date };
      return { customer: publicCustomer(customer), earned };
    }));
    if (route === 'POST /api/owner/redeem') return json(response, await store.transaction((state) => {
      session(state, request, 'owner');
      const customer = findCustomer(state, normalizeCode(body.code));
      if (!CATEGORIES.every((category) => customer.stamps[category])) fail(409, 'This passport needs all six category stamps before redeeming.');
      if (customer.redeemed) fail(409, 'This customer has already redeemed the reward.');
      customer.redeemed = true;
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
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number between 1 and 65535.');
  const { server } = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Umami Passport is ready at http://localhost:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
