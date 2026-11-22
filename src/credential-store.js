import { nativeApp } from './platform.js';
import { readState, saveState } from './storage.js';

const recordName = 'deepSeekCredential';

async function nativeCredential(value) {
  if (!nativeApp) return undefined;
  const { nativeDeepSeekKey } = await import('./harmony.js');
  return nativeDeepSeekKey(value);
}

export async function loadDeepSeekKey() {
  const stored = await readState(recordName).catch(() => null);
  if (stored) {
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, stored.key, stored.encrypted);
    return new TextDecoder().decode(clear);
  }
  return (await nativeCredential()) ?? '';
}

export async function rememberDeepSeekKey(value) {
  const saved = await nativeCredential(value);
  if (saved === false && !value) throw new Error('本机已保存的 DeepSeek API Key 无法清除。');
  if (saved || !value) {
    await saveState(recordName, null);
    return;
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  await saveState(recordName, { key, iv, encrypted });
}
