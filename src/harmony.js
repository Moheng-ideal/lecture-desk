import { handleApi } from '../server/api.mjs';
import { blobBase64, getConnections } from './api.js';

const pending = new Map();
const events = 'lecture-desk-native';
const nativeReady = 'lecture-desk-native-ready';

window.addEventListener(events, ({ detail }) => pending.get(detail?.id)?.(detail));

function bridge() {
  if (window.LectureDeskNative) return Promise.resolve(window.LectureDeskNative);
  return new Promise((resolve, reject) => {
    const ready = () => {
      clearTimeout(timer);
      if (window.LectureDeskNative) resolve(window.LectureDeskNative);
      else reject(new Error('应用的系统接口不可用。'));
    };
    const timer = setTimeout(() => {
      window.removeEventListener(nativeReady, ready);
      reject(new Error('应用的系统接口未就绪。'));
    }, 5000);
    window.addEventListener(nativeReady, ready, { once: true });
  });
}

export async function checkAndroidUpdate() {
  const native = await bridge();
  if (typeof native.checkForUpdate !== 'function') throw new Error('此版本的安装包暂不支持应用内更新。');
  native.checkForUpdate();
}

export async function nativeDeepSeekKey(value) {
  const native = await bridge();
  if (typeof native.readDeepSeekKey !== 'function' || typeof native.saveDeepSeekKey !== 'function') return undefined;
  if (value === undefined) {
    const stored = native.readDeepSeekKey();
    if (typeof stored === 'string') return stored;
    throw new Error('本机已保存的 DeepSeek API Key 无法读取，请重新填写。');
  }
  return Boolean(native.saveDeepSeekKey(value));
}

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href]');
  if (!link || !event.isTrusted || link.protocol !== 'https:' || link.origin === location.origin) return;
  event.preventDefault();
  bridge().then((native) => native.openLink(link.href)).catch(() => {});
});

async function fetchFromHarmony(url, { headers, body, signal }) {
  const native = await bridge();
  const requestHeaders = new Headers(headers);
  if (body instanceof FormData) {
    const encoded = new Response(body);
    requestHeaders.set('content-type', encoded.headers.get('content-type'));
    body = await blobBase64(await encoded.blob());
  }
  if (signal?.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let controller;
    let status;
    let contentType;
    let done = false;
    let resolved = false;
    const finish = () => {
      pending.delete(id);
      signal?.removeEventListener('abort', abort);
    };
    const stop = (error) => {
      finish();
      if (resolved) controller.error(error);
      else reject(error);
    };
    const abort = () => {
      native.cancelHttp(id);
      stop(signal.reason);
    };
    const stream = new ReadableStream({
      start(streamController) { controller = streamController; },
      cancel() {
        finish();
        native.cancelHttp(id);
      },
    });
    pending.set(id, (message) => {
      if (message.kind === 'error') {
        stop(new Error('应用无法连接在线服务。'));
        return;
      }
      if (message.kind === 'headers') {
        const value = JSON.parse(message.value);
        const pair = Object.entries(value).find(([key]) => key.toLowerCase() === 'content-type');
        contentType = pair ? String(pair[1]) : '';
      }
      if (message.kind === 'status') status = Number(message.value);
      if (message.kind === 'data') {
        controller.enqueue(Uint8Array.from(atob(message.value), (char) => char.charCodeAt(0)));
      }
      if (message.kind === 'end') done = true;
      const responseStatus = status || (contentType?.includes('text/event-stream') ? 200 : 0);
      if (!resolved && responseStatus && (contentType != null || done)) {
        resolved = true;
        const responseBody = [204, 205, 304].includes(responseStatus) ? null : stream;
        resolve(new Response(responseBody, {
          status: responseStatus, headers: { 'Content-Type': contentType || 'application/json' },
        }));
      }
      if (done && resolved) {
        controller.close();
        finish();
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (!native.startHttp(id, url, body, requestHeaders.get('authorization') || '', requestHeaders.get('content-type') || 'application/json')) {
        stop(new Error('应用无法处理该请求。'));
      }
    } catch (error) { stop(error); }
  });
}

export async function requestFromHarmony(path, options = {}) {
  const url = new URL(path, location.origin);
  const result = await handleApi(new Request(url, options), {}, { localApp: true, fetcher: fetchFromHarmony });
  if (options.signal?.aborted) throw options.signal.reason;
  return result;
}

export async function harmonyVoice() {
  const native = await bridge();
  const cloud = typeof native.startCloudVoice === 'function';
  return {
    start(id, onEvent) {
      const key = getConnections().deepseek;
      if (cloud && !key) throw new Error('请在设置中配置 DeepSeek API Key，再使用语音提问。');
      pending.set(id, ({ kind, value }) => {
        if (kind === 'voice-done' || kind === 'voice-error') pending.delete(id);
        onEvent(kind, value);
      });
      try {
        if (cloud ? native.startCloudVoice(id, key) : native.startVoice(id)) return;
        throw new Error('无法开始语音输入。');
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    },
    finish: (id) => native.finishVoice(id),
    cancel(id) {
      pending.delete(id);
      native.cancelVoice(id);
    },
  };
}

export async function saveHarmonyDocument(filename, blob) {
  const native = await bridge();
  if (blob.size > 100 * 1024 * 1024) throw new Error('文件超过 100 MB，无法通过应用保存。');
  const base64 = await blobBase64(blob);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, ({ kind }) => {
      pending.delete(id);
      if (kind === 'error') reject(new Error('文件保存失败。'));
      else resolve(kind === 'saved');
    });
    try {
      if (!native.saveDocument(id, filename, base64)) {
        pending.delete(id);
        reject(new Error('应用无法保存此文件。'));
      }
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}
