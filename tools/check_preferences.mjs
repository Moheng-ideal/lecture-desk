// Verify teaching preferences (profile + style) reach both NK-GeniOS and Zhipu.
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const CODE = process.env.TEACH_PASS || 'YOUR_TEACH_PASS';
const GENIOS = process.env.NK_KEY || 'YOUR_NK_KEY';
const ZHIPU = process.env.ZHIPU_KEY || 'YOUR_ZHIPU_KEY';
const b64 = readFileSync('.tmp/page.b64', 'utf8').trim();
const image = `data:image/jpeg;base64,${b64}`;
const ref = { image, page: 2, width: 1400, height: 875, book: '高数01-04：无穷小', method: '整页截图' };

const prefs = { profile: '我是刚接触高数的大一学生，基础较弱，容易紧张', style: '用大白话讲解，多打比方，称呼我"同学"' };

async function chat(body, credentials) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Teach-Code': CODE, Origin: BASE },
    body: JSON.stringify({ ...body, credentials }),
  });
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  let text = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { const d = JSON.parse(p); if (d.choices?.[0]?.delta?.content) text += d.choices[0].delta.content; } catch {}
  }
  return text;
}

// A) NK-GeniOS with preferences
const a = await chat({
  question: '什么是无穷小？', references: [], history: [], preferences: prefs,
}, { deepseek: GENIOS, vision: ZHIPU });
console.log('=== A) NK-GeniOS（带画像/风格）===');
console.log(a.slice(0, 500));
console.log('\n命中"同学":', /同学/.test(a) ? '✅' : '❌');
console.log('命中比喻/大白话:', /(像|好比|比如|打个比方|想象|可以理解为)/.test(a) ? '✅' : '❌');

// B) Zhipu vision with the same preferences
const b = await chat({
  question: '这一页讲了什么？', references: [ref], history: [], preferences: prefs,
}, { deepseek: GENIOS, vision: ZHIPU });
console.log('\n=== B) GLM-4V（带画像/风格）===');
console.log(b.slice(0, 500));
console.log('\n命中"同学":', /同学/.test(b) ? '✅' : '❌');
console.log('命中比喻/大白话:', /(像|好比|比如|打个比方|想象|可以理解为)/.test(b) ? '✅' : '❌');
