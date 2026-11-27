// Test the NK-GeniOS streaming -> DeepSeek SSE transformation in isolation.
const BASE = 'https://coze.nankai.edu.cn/api/proxy/api/v1';
const KEY = process.env.NK_KEY || 'YOUR_NK_KEY';

async function run() {
  const headers = { Apikey: KEY, Authorization: KEY, 'Content-Type': 'application/json' };
  const created = await fetch(`${BASE}/create_conversation`, {
    method: 'POST', headers,
    body: JSON.stringify({ Inputs: {}, UserID: 'lecture-desk' }),
  });
  console.log('create status:', created.status);
  const conv = (await created.json()).Conversation?.AppConversationID;
  console.log('conv:', conv);

  const upstream = await fetch(`${BASE}/chat_query_v2`, {
    method: 'POST', headers,
    body: JSON.stringify({
      AppConversationID: conv, UserID: 'lecture-desk',
      Query: '用两句话介绍你自己', ResponseMode: 'streaming',
    }),
  });
  console.log('chat status:', upstream.status, '| type:', upstream.headers.get('content-type'));
  // emulate TransformStream parse: read SSE and count converted chunks
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', chunks = 0, sample = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      try {
        const p = JSON.parse(raw);
        if (p.event === 'message' && p.answer) {
          chunks++; sample += p.answer;
          // this is what the frontend will receive:
          const out = `data: ${JSON.stringify({ choices: [{ delta: { content: p.answer } }] })}`;
          if (chunks === 1) console.log('converted SSE sample:', out.slice(0, 160));
        }
      } catch {}
    }
  }
  console.log('chunks:', chunks, '| answer:', sample.slice(0, 200));
}
run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
