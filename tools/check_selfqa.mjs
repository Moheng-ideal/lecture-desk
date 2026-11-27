// Verify the vision path no longer answers its own closing question.
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const CODE = process.env.TEACH_PASS || 'YOUR_TEACH_PASS';
const GENIOS = process.env.NK_KEY || 'YOUR_NK_KEY';
const ZHIPU = process.env.ZHIPU_KEY || 'YOUR_ZHIPU_KEY';

const imagePath = process.argv[2] ||
  'C:/Users/jjf/.dsh/attachments/v1/objects/0c/0c44323130bb7d04b2a02c59853ab4b0.jpg';
const b64 = readFileSync(imagePath).toString('base64');
const image = `data:image/jpeg;base64,${b64}`;

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Teach-Code': CODE, Origin: BASE },
  body: JSON.stringify({
    question: '请按课堂节奏讲解当前页，先梳理重点再给出例子。',
    references: [{ image, page: 2, width: 1600, height: 1000, book: '高数01-04：无穷小', method: '整页截图' }],
    history: [],
    credentials: { deepseek: GENIOS, vision: ZHIPU },
  }),
});

let text = '';
for (const line of (await res.text()).split('\n')) {
  if (!line.startsWith('data:')) continue;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  try {
    const packet = JSON.parse(payload);
    if (packet.choices?.[0]?.delta?.content) text += packet.choices[0].delta.content;
  } catch {}
}

console.log('=== 回答 ===');
console.log(text || '(空)');
console.log('\n=== 自问自答检查 ===');
const selfQA = /(问题|问)[：:][\s\S]{0,200}(答|答案)[：:]/.test(text);
const endsWithQuestion = /[？?]\s*$/.test(text.trim());
console.log('匹配"问：…答："模式:', selfQA ? '❌ 仍有自问自答' : '✅ 未发现');
console.log('结尾是提问:', endsWithQuestion ? '✅ 是的（引导学生）' : '（结尾非问句）');
