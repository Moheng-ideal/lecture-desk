import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.window = new EventTarget();
globalThis.document = new EventTarget();
globalThis.location = new URL('https://lecture-desk.invalid');
const { requestFromHarmony, harmonyVoice } = await import('../src/harmony.js');

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

test('PDF upload passes a multipart file and folder token through the Harmony network bridge', async () => {
  globalThis.FileReader = class {
    async readAsDataURL(blob) {
      this.result = `data:;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
      this.onload();
    }
  };
  const pdf = '%PDF-1.7\nexample';
  const requests = [];
  window.LectureDeskNative = {
    startHttp(id, url, body, authorization, contentType) {
      requests.push({ url, body, authorization, contentType });
      const packet = url.includes('/auth/')
        ? { code: 0, tenant_access_token: 'fixture-token' }
        : { code: 0, data: { file_token: 'PdfToken' } };
      queueMicrotask(() => {
        sendEvent(id, 'headers', '{"Content-Type":"application/json"}');
        sendEvent(id, 'status', '200');
        sendEvent(id, 'data', Buffer.from(JSON.stringify(packet)).toString('base64'));
        sendEvent(id, 'end');
      });
      return true;
    },
    cancelHttp() {},
  };
  try {
    const result = await requestFromHarmony('/api/feishu-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '批注.pdf', data: Buffer.from(pdf).toString('base64'),
        credentials: { feishu: { appId: 'fixture', secret: 'fixture', folder: 'https://lesson.feishu.cn/drive/folder/FolderToken' } },
      }),
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).url, 'https://lesson.feishu.cn/drive/folder/FolderToken');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all');
    assert.equal(requests[1].authorization, 'Bearer fixture-token');
    const multipart = await new Response(Buffer.from(requests[1].body, 'base64'), {
      headers: { 'Content-Type': requests[1].contentType },
    }).formData();
    assert.equal(multipart.get('parent_type'), 'explorer');
    assert.equal(multipart.get('parent_node'), 'FolderToken');
    assert.equal(multipart.get('file_name'), '批注.pdf');
    assert.equal(multipart.get('size'), String(pdf.length));
    assert.equal(await multipart.get('file').text(), pdf);
  } finally {
    delete globalThis.FileReader;
  }
});

test('cancelling voice discards late results from the previous book', async () => {
  const cancelled = [];
  window.LectureDeskNative = {
    startVoice: () => true,
    cancelVoice: (id) => cancelled.push(id),
  };
  const voice = await harmonyVoice();
  const received = [];
  const record = (...event) => received.push(event);
  voice.start('old-book', record);
  voice.cancel('old-book');
  voice.start('new-book', record);
  sendEvent('old-book', 'voice-final', '上一册的内容');
  sendEvent('new-book', 'voice-final', '当前课本的内容');
  sendEvent('new-book', 'voice-done', '');
  sendEvent('new-book', 'voice-final', '迟到的内容');
  assert.deepEqual(cancelled, ['old-book']);
  assert.deepEqual(received, [['voice-final', '当前课本的内容'], ['voice-done', '']]);
});
