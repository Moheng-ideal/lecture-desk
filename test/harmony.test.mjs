import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.window = new EventTarget();
globalThis.document = new EventTarget();
globalThis.location = new URL('https://lecture-desk.invalid');
const { requestFromHarmony } = await import('../src/harmony.js');

const sendEvent = (id, kind, value) => window.dispatchEvent(
  new CustomEvent('lecture-desk-native', { detail: { id, kind, value } }),
);
const ask = (signal) => requestFromHarmony('/api/chat', {
  method: 'POST', signal, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question: '怎么理解？', references: [], history: [], credentials: { deepseek: 'fixture' } }),
});

test('the Harmony app can read configuration and receive DeepSeek chunks without a web server', async () => {
  const config = await requestFromHarmony('/api/config');
  assert.equal((await config.json()).canSupplyCredentials, true);
  let id;
  window.LectureDeskNative = {
    startHttp(requestId, url, body, authorization) {
      id = requestId;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(authorization, 'Bearer fixture');
      assert.match(body, /怎么理解/);
      queueMicrotask(() => sendEvent(id, 'headers', '{"Content-Type":"text/event-stream"}'));
      return true;
    },
    cancelHttp() {},
  };
  const stream = await ask();
  assert.equal(stream.status, 200);
  const output = stream.text();
  const data = Buffer.from('data: {"text":"你好"}\n\ndata: [DONE]\n\n', 'utf8');
  sendEvent(id, 'data', data.subarray(0, 18).toString('base64'));
  sendEvent(id, 'data', data.subarray(18).toString('base64'));
  sendEvent(id, 'end');
  assert.match(await output, /你好/);
});

test('stopping a Harmony request cancels the original native request', async () => {
  const controller = new AbortController();
  let started;
  let cancelled;
  const connected = new Promise((resolve) => {
    window.LectureDeskNative = {
      startHttp(id) { started = id; resolve(); return true; },
      cancelHttp(id) { cancelled = id; },
    };
  });
  const response = ask(controller.signal);
  await connected;
  controller.abort();
  await assert.rejects(response, { name: 'AbortError' });
  assert.equal(cancelled, started);
});
