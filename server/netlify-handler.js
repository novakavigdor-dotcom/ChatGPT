import serverless from 'serverless-http';
import { createApp } from '../server.js';
import { BlobStore } from './blob-store.js';

const maximumBody = 16384;
function failure(message, status = 503) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function requestBytes(request) {
  if (Number(request.headers.get('content-length')) > maximumBody) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBody) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally { reader.releaseLock(); }
}

/** Bridge Netlify's modern Request API to the shared Node HTTP application. */
export function createNetlifyHandler({ storeFactory = () => new BlobStore(), appFactory = createApp } = {}) {
  return async (request, context = {}) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
    if (!path.startsWith('/api/')) return failure('This API endpoint was not found.', 404);
    const body = await requestBytes(request);
    if (body === null) return failure('The request is too large.', 413);
    try {
      // Netlify supplies the Blobs context to modern functions automatically.
      // Build a fresh SDK client per invocation so credentials cannot go stale.
      const { server } = await appFactory({
        store: await storeFactory(),
        clientAddress: () => context.ip || 'unknown',
        secureCookies: true,
        allowOwnerSetup: false,
      });
      const headers = Object.fromEntries(request.headers);
      headers.host = url.host;
      headers['content-length'] = String(body.byteLength);
      const event = {
        version: '2.0', rawPath: path, rawQueryString: url.search.slice(1),
        headers, body: body.toString('base64'), isBase64Encoded: true,
        requestContext: { http: { method: request.method, sourceIp: context.ip || 'unknown' } },
      };
      // serverless-http emits an in-memory request; it does not listen on a port.
      const reply = await serverless(server)(event, {});
      const responseHeaders = new Headers(reply.headers);
      for (const [name, values] of Object.entries(reply.multiValueHeaders || {})) {
        for (const value of values) responseHeaders.append(name, value);
      }
      for (const cookie of reply.cookies || []) responseHeaders.append('Set-Cookie', cookie);
      responseHeaders.set('Cache-Control', 'no-store');
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(reply.statusCode);
      return new Response(empty ? null : Buffer.from(reply.body || '', reply.isBase64Encoded ? 'base64' : 'utf8'), {
        status: reply.statusCode, headers: responseHeaders,
      });
    } catch (error) {
      // Do not expose store contents, credentials, or provider error URLs.
      console.error('Bingo function failed:', error.name || 'Error');
      return failure('Bingo storage is temporarily unavailable. Please try again.');
    }
  };
}
