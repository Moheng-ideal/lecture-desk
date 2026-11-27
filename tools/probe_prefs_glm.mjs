// Does moving preferences into the user message improve GLM-4V adherence?
import { readFileSync } from 'node:fs';

const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const KEY = process.env.ZHIPU_KEY || 'YOUR_ZHIPU_KEY';
const b64 = readFileSync('.tmp/page.b64', 'utf8').trim();
const image = `data:image/jpeg;base64,${b64}`;
const prefs = '我是刚接触高数的大一学生，基础较弱，容易紧张；用大白话讲解，多打比方，称呼我"同学"。';
const TEACHER = '你是中文课程讲解师。先说核心概念，再解释推导或举例。用 Markdown，数学公式使用 LaTeX。';

async function run(label, messages) {
  const res = await fetch(ZHIPU, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4v-flash', messages, stream: false, max_tokens: 1024 }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || JSON.stringify(data).slice(0, 200);
  console.log(`\n=== ${label} ===`);
  console.log(text.slice(0, 280));
  console.log('称呼同学:', /同学/.test(text) ? '✅' : '❌', '| 比喻:', /(像|好比|比如|想象|可以理解为)/.test(text) ? '✅' : '❌');
}

const userParts = (extra) => [
  { type: 'image_url', image_url: { url: image } },
  { type: 'text', text: extra + '这一页讲了什么？' },
];

// A: preferences only in system
await run('A) 设置在 system', [
  { role: 'system', content: `${TEACHER}\n用户设置：${prefs}` },
  { role: 'user', content: userParts('') },
]);

// B: preferences repeated at the start of the user text
await run('B) 设置在 user 开头', [
  { role: 'system', content: TEACHER },
  { role: 'user', content: userParts(`【用户设置】${prefs}\n\n`) },
]);

// C: preferences at the end of the user text (last instruction wins)
await run('C) 设置在 user 结尾', [
  { role: 'system', content: TEACHER },
  { role: 'user', content: [{ type: 'image_url', image_url: { url: image } },
    { type: 'text', text: `这一页讲了什么？\n\n【用户设置，必须遵守】${prefs}` }] },
]);
