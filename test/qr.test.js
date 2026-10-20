import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startQrScanner } from '../src/qr.js';

function scannerCamera(t) {
  const originalGlobals = new Map();
  function replaceGlobal(name, value) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track] };
  const camera = { payload: null, opens: 0 };
  const video = {
    readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null,
    setAttribute() {}, async play() {}, pause() {},
  };
  replaceGlobal('isSecureContext', true);
  replaceGlobal('navigator', { mediaDevices: { async getUserMedia() { camera.opens++; return stream; } } });
  replaceGlobal('document', { createElement: () => ({ getContext: () => ({}) }) });
  replaceGlobal('BarcodeDetector', class {
    static async getSupportedFormats() { return ['qr_code']; }
    async detect() { return camera.payload ? [{ rawValue: camera.payload }] : []; }
  });
  async function settle() { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); }
  async function advance(ms = 160) { t.mock.timers.tick(ms); await settle(); }
  return { camera, track, video, advance, settle };
}

test('default QR scanner stops before delivering its one result, including rejected callbacks', async (t) => {
  const { camera, track, video, advance } = scannerCamera(t);
  camera.payload = 'one-shot-code';
  const values = [];
  const scanner = await startQrScanner(video, async (payload) => {
    assert.equal(track.readyState, 'ended');
    assert.equal(video.srcObject, null);
    values.push(payload);
    throw new Error('The customer lookup failed.');
  });
  t.after(() => scanner.stop());
  await advance(0);
  await advance(5000);
  assert.deepEqual(values, ['one-shot-code']);
  assert.equal(camera.opens, 1);
});

test('continuous QR scanner survives invalid and unknown lookups and reads the next customer without reopening the camera', async (t) => {
  const { camera, track, video, advance } = scannerCamera(t);
  const values = [];
  let scanner;
  camera.payload = 'https://unrelated.example/menu';
  scanner = await startQrScanner(video, async (payload) => {
    values.push(payload);
    if (payload !== 'known-customer') throw new Error('Not a known customer bingo.');
    scanner.stop();
  }, { continuous: true });
  t.after(() => scanner.stop());
  await advance(0);
  assert.equal(track.readyState, 'live');
  assert.notEqual(video.srcObject, null);
  camera.payload = 'unknown-customer';
  await advance();
  assert.equal(track.readyState, 'live');
  camera.payload = 'known-customer';
  await advance();
  assert.deepEqual(values, ['https://unrelated.example/menu', 'unknown-customer', 'known-customer']);
  assert.equal(camera.opens, 1);
  assert.equal(track.readyState, 'ended');
  assert.equal(video.srcObject, null);
});

test('continuous QR scanner throttles repeat codes and waits for an active lookup before delivering another result', async (t) => {
  const { camera, track, video, advance, settle } = scannerCamera(t);
  const values = [];
  let finishLookup;
  camera.payload = 'unknown-customer';
  const scanner = await startQrScanner(video, async (payload) => {
    values.push(payload);
    if (values.length === 1) await new Promise((resolve) => { finishLookup = resolve; });
  }, { continuous: true });
  t.after(() => scanner.stop());
  await advance(0);
  await advance(5000);
  assert.deepEqual(values, ['unknown-customer']);
  finishLookup();
  await settle();
  await advance(160);
  await advance(1000);
  assert.deepEqual(values, ['unknown-customer']);
  await advance(340);
  assert.deepEqual(values, ['unknown-customer', 'unknown-customer']);
  camera.payload = 'different-customer';
  await advance();
  assert.deepEqual(values, ['unknown-customer', 'unknown-customer', 'different-customer']);
  scanner.stop();
  await advance(5000);
  assert.equal(values.length, 3);
  assert.equal(camera.opens, 1);
  assert.equal(track.readyState, 'ended');
});
