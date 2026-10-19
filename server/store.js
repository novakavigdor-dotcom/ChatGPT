import { mkdir, readFile, rename, chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function emptyStore() {
  return { version: 1, owner: null, customers: {}, sessions: {}, requests: {}, authAttempts: {} };
}

export function prepareStore(state) {
  if (state?.version !== 1 || !state.customers || !state.sessions || !state.requests) {
    throw new Error('The private passport store has an unsupported format.');
  }
  state.authAttempts ||= {};
  return state;
}

// The private store deliberately lives outside the public checkout.
export class Store {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'store.json');
    this.queue = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      this.state = prepareStore(JSON.parse(await readFile(this.path, 'utf8')));
      await chmod(this.path, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = emptyStore();
      await this.persist(this.state);
    }
  }

  async persist(state) {
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
  }

  async read(callback) {
    await this.ready;
    await this.queue;
    return callback(this.state);
  }

  transaction(callback) {
    const operation = this.queue.then(async () => {
      await this.ready;
      const next = structuredClone(this.state);
      const result = await callback(next);
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
