export function hermesEndpoint(address) {
  if (typeof address !== 'string' || address.length > 600 || /[?#\r\n\t\\]/.test(address)) return null;
  let url;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port === '0') return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1/chat/completions')) return url.origin + path;
  return url.origin + path + (path.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
}

export function validHermesKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && !/[^\x21-\x7e]/.test(key);
}

export async function matchesHermesPin(pin, expectedHash) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin) || !globalThis.crypto?.subtle) return false;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex === expectedHash;
}
