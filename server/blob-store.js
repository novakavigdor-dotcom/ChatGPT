import { getStore } from '@netlify/blobs';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyStore, prepareStore } from './store.js';

function unavailable(message = 'Passport storage is temporarily unavailable. Please try again.') {
  const error = new Error(message);
  error.name = 'StorageUnavailableError';
  error.status = 503;
  return error;
}

// SDK 11.1.4 can mark non-412 conditional HTTP errors as successful writes.
// Guard the HTTP result first, while allowing SDK retries and CAS conflicts.
export function verifiedBlobsFetch(fetcher = globalThis.fetch) {
  return async (input, options) => {
    const response = await fetcher(input, options);
    const method = String(options?.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (method === 'PUT' && !response.ok && response.status !== 412) {
      try { await response.body?.cancel(); } catch { /* Preserve the storage failure. */ }
      throw unavailable();
    }
    return response;
  };
}

/** Site-wide persistent state with optimistic compare-and-swap transactions. */
export class BlobStore {
  constructor({ blobs, key = 'passport-state', maxAttempts = 16, retryDelay } = {}) {
    this.blobs = blobs || getStore({ name: 'umami-passport', consistency: 'strong', fetch: verifiedBlobsFetch() });
    this.key = key;
    this.maxAttempts = maxAttempts;
    this.retryDelay = retryDelay || ((attempt) => delay(Math.random() * Math.min(100, 5 * 2 ** attempt)));
    this.ready = Promise.resolve();
  }

  async snapshot() {
    // A strong read on every operation prevents warm instances from serving stale state.
    const record = await this.blobs.getWithMetadata(this.key, { type: 'json', consistency: 'strong' });
    if (!record) return { state: emptyStore(), etag: null };
    if (!record.data || typeof record.data !== 'object' || !record.etag) throw unavailable();
    return { state: prepareStore(structuredClone(record.data)), etag: record.etag };
  }

  async read(callback) {
    const { state } = await this.snapshot();
    return callback(state);
  }

  async transaction(callback) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const { state, etag } = await this.snapshot();
      // Callbacks can run again after a concurrent commit. They must return any
      // response effects rather than writing cookies or sending a response here.
      const result = await callback(state);
      const condition = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const saved = await this.blobs.setJSON(this.key, state, condition);
      if (saved?.modified === true) {
        // SDK 11.1.4 reports some failed conditional HTTP writes as modified with
        // no ETag. A real commit must include a new version before we acknowledge it.
        if (typeof saved.etag !== 'string' || saved.etag.length === 0) throw unavailable();
        return result;
      }
      if (saved?.modified !== false) throw unavailable();
      if (attempt + 1 < this.maxAttempts) await this.retryDelay(attempt);
    }
    throw unavailable('The passport was updated at the same time. Please try saving again.');
  }
}
