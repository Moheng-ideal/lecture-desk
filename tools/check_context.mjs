// Cross-model context test: GLM-4V asks a question with a screenshot, then the
// student answers in plain text -> does NK-GeniOS see the earlier Q&A?
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const CODE = process.env.TEACH_PASS || 'YOUR_TEACH_PASS';
const GENIOS = process.env.NK_KEY || 'YOUR_NK_KEY';
const ZHIPU = process.env.ZHIPU_KEY || 'YOUR_ZHIPU_KEY';
const b64 = readFileSync('.tmp/page.b64', 'utf8').trim();
const image = `data:image/jpeg;base64,${b64}`;

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

const ref = { image, page: 2, width: 1400, height: 875, book: '高数01-04：无穷小', method: '整页截图' };

// 1) vision turn
const first = await chat({
  question: '请按课堂节奏讲解当前页，先梳理重点再给出例子。',
  references: [ref], history: [],
}, { deepseek: GENIOS, vision: ZHIPU });
console.log('=== 第一轮（视觉模型）结尾 ===');
console.log(first.slice(-200));

// 2) plain-text follow-up with history = the vision turn (as the app would send)
const second = await chat({
  question: '是 1/e^x 吗？',
  references: [],
  history: [{ question: '请按课堂节奏讲解当前页，先梳理重点再给出例子。', answer: first, references: [ref] }],
}, { deepseek: GENIOS, vision: ZHIPU });
console.log('\n=== 第二轮（NK-GeniOS，纯文字）===');
console.log(second.slice(0, 600));
console.log('\n=== 上下文判断 ===');
const aware = /(1\s*\/\s*e\^?x|e\^\{?x\}?|无穷小|刚才|上一)/.test(second);
console.log('是否接上上一轮话题:', aware ? '✅ 知道上下文' : '❌ 没有上下文');
