let settings = { access: '', deepseek: '', feishu: {} };

export function saveConnections(configuration) {
  settings = configuration;
}

export function getConnections() {
  return settings;
}

export async function getConfiguration() {
  const response = await fetch('/api/config', {
    headers: settings.access ? { 'X-Teach-Code': settings.access } : {},
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('讲课台服务暂时不可用。');
  return response.json();
}

export class ApiError extends Error {
  constructor(payload) {
    super(payload.error || '连接失败，请稍后重试。');
    this.details = payload;
  }
}

async function post(path, data, credentials, signal) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(settings.access && { 'X-Teach-Code': settings.access }) },
    body: JSON.stringify({ ...data, credentials }),
  });
  if (!response.ok) throw new ApiError(await response.json().catch(() => ({})));
  return response;
}

export async function streamAnswer(data, onText, signal) {
  const response = await post('chat', data, { deepseek: settings.deepseek }, signal);
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error('讲解服务没有返回有效的流式回答。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  let reason;
  let text = '';
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (done && buffer) lines.push(buffer);
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim();
        if (value === '[DONE]') {
          finished = true;
          break;
        }
        const packet = JSON.parse(value);
        if (packet.error) throw new Error('DeepSeek 中断了本次讲解。');
        const choice = packet.choices?.[0];
        if (choice?.finish_reason) reason = choice.finish_reason;
        if (choice?.delta?.content) {
          text += choice.delta.content;
          onText(text);
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!finished || (reason && !['stop', 'length'].includes(reason))) {
    throw new Error('讲解未完整返回，可以重试。');
  }
  if (!text.trim()) throw new Error('DeepSeek 没有返回讲解内容。');
  if (reason === 'length') text += '\n\n（本次讲解到达长度上限，可以继续追问。）';
  return text;
}

export async function sendToFeishu(data) {
  return (await post('feishu', data, { feishu: settings.feishu })).json();
}
