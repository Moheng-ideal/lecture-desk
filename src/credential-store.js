import { nativeApp } from './platform.js';
import { readState, saveState } from './storage.js';

const recordName = 'deepSeekCredential';
const hermesRecordName = 'hermesConnection';

async function decryptCredential({ key, iv, encrypted }) {
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(clear);
}

async function encryptCredential(value) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return { key, iv, encrypted };
}

async function nativeCredential(value) {
  if (!nativeApp) return undefined;
  const { nativeDeepSeekKey } = await import('./harmony.js');
  return nativeDeepSeekKey(value);
}

export async function loadDeepSeekKey() {
  const stored = await readState(recordName).catch(() => null);
  if (stored) return decryptCredential(stored);
  return (await nativeCredential()) ?? '';
}

export async function rememberDeepSeekKey(value) {
  const saved = await nativeCredential(value);
  if (saved === false && !value) throw new Error('本机已保存的 DeepSeek API Key 无法清除。');
  if (saved || !value) {
    await saveState(recordName, null);
    return;
  }
  await saveState(recordName, await encryptCredential(value));
}

export async function loadHermesConnection() {
  const stored = await readState(hermesRecordName);
  if (!stored) return null;
  const key = stored.credential ? await decryptCredential(stored.credential) : '';
  return { provider: stored.provider, hermes: { baseUrl: stored.baseUrl, key } };
}

export async function rememberHermesConnection({ provider, hermes: { baseUrl, key } }) {
  await saveState(hermesRecordName, { provider, baseUrl, credential: key ? await encryptCredential(key) : null });
}
