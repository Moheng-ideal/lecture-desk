// Lecture-desk 0.8.6: end-to-end check of /api/chat (NK-GeniOS text + Zhipu vision).
const BASE = 'http://127.0.0.1:8787';
const CODE = process.env.TEACH_PASS || 'YOUR_TEACH_PASS';
const GENIOS = process.env.NK_KEY || 'YOUR_NK_KEY';
const ZHIPU = process.env.ZHIPU_KEY || 'YOUR_ZHIPU_KEY';

async function chat(label, body, credentials) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Teach-Code': CODE, Origin: BASE },
    body: JSON.stringify({ ...body, credentials }),
  });
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  let text = '';
  let reason = '';
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const packet = JSON.parse(payload);
      if (packet.error) { console.log(`[${label}] stream error: ${packet.error}`); return; }
      if (packet.choices?.[0]?.delta?.content) text += packet.choices[0].delta.content;
      if (packet.choices?.[0]?.finish_reason) reason = packet.choices[0].finish_reason;
    } catch { /* ignore */ }
  }
  console.log(`[${label}] ok, ${text.length} chars, finish=${reason || 'n/a'}`);
  console.log(text.slice(0, 220).replace(/\n/g, ' '));
  console.log('---');
}

// 1) NK-GeniOS text
await chat('genios-text', {
  question: '用一句话说明什么是半导体。',
  references: [], history: [],
}, { deepseek: GENIOS, vision: '' });

// 2) Zhipu vision (needs an image; reuse the tiny test png as data URL)
import { readFileSync } from 'node:fs';
const b64 = readFileSync('D:/Dsh_project/lecture-desk-0.7.5-android/tools/test_image_small_b64.txt', 'utf8').trim();
await chat('zhipu-vision', {
  question: '图里写了什么？有什么图形？',
  references: [{ image: `data:image/jpeg;base64,${b64}`, page: 1, width: 260, height: 130, book: '测试图', method: 'excerpt' }],
  history: [],
}, { deepseek: GENIOS, vision: ZHIPU });
