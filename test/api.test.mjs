import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleApi } from '../server/api.mjs';

const origin = 'https://lecture.example';
const environment = {
  DEEPSEEK_API_KEY: 'test-key', TEACH_PASS: 'local-test-code',
  FEISHU_APP_ID: 'cli_fixture', FEISHU_APP_SECRET: 'test-secret',
  FEISHU_FOLDER_URL: 'https://fixture.feishu.cn/drive/folder/fldFixture',
};
const ref = { book: '函数与图像', page: 2, method: '选文', text: '图像最低点是 (0, 0)' };
const question = { question: '最低点是什么？', references: [ref], history: [] };
const fixture = {
  title: '课堂问答录',
  records: [{
    ...question, date: '2026-11-22T01:00:00.000Z',
    answer: Array.from({ length: 63 }, (_, index) => `第 ${index + 1} 段解释。`).join('\n\n'),
  }],
};
const post = (path, body, override = {}) => new Request(origin + path, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Teach-Code': environment.TEACH_PASS, ...override },
  body: JSON.stringify(body),
});

test('protects configured credentials and rejects cross-origin requests', async () => {
  const denied = await handleApi(post('/api/chat', question, { Origin: 'https://elsewhere.example' }), environment);
  assert.equal(denied.status, 403);
  const badPass = await handleApi(post('/api/chat', question, { 'X-Teach-Code': 'wrong' }), environment);
  assert.equal(badPass.status, 401);
  const deniedHosted = await handleApi(post('/api/chat', question), environment, { hosted: true });
  assert.equal(deniedHosted.status, 422);
});

test('streams a grounded teaching request without sending the original PDF', async () => {
  let outgoing;
  const result = await handleApi(post('/api/chat', question), environment, {
    fetcher: async (url, config) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(config.headers.Authorization, 'Bearer test-key');
      outgoing = JSON.parse(config.body);
      return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /\[DONE\]/);
  assert.equal(outgoing.model, 'deepseek-flash');
  assert.match(outgoing.messages[1].content, /《函数与图像》第 2 页/);
  assert.match(outgoing.messages[1].content, /图像最低点/);
});

test('resumes a partly written Feishu document using the same idempotency key', async () => {
  let created = 0;
  let failure = true;
  const appends = [];
  const fetcher = async (url, config) => {
    const address = new URL(url);
    const body = JSON.parse(config.body);
    if (address.pathname.endsWith('/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'access-fixture' });
    }
    assert.equal(config.headers.Authorization, 'Bearer access-fixture');
    if (address.pathname.endsWith('/documents')) {
      created++;
      assert.equal(body.folder_token, 'fldFixture');
      return Response.json({ code: 0, data: { document: { document_id: 'docxFixture' } } });
    }
    assert.match(address.pathname, /docxFixture\/blocks\/docxFixture\/children$/);
    appends.push({ url, body });
    if (body.index === 30 && failure) {
      failure = false;
      return Response.json({ code: 1 }, { status: 502 });
    }
    return Response.json({ code: 0, data: {} });
  };
  const first = await handleApi(post('/api/feishu', fixture), environment, { fetcher });
  assert.equal(first.status, 502);
  const { resume } = await first.json();
  assert.equal(resume.cursor, 30);
  const changed = await handleApi(post('/api/feishu', { ...fixture, title: '另一份记录', resume }), environment, { fetcher });
  assert.equal(changed.status, 400);
  const retried = await handleApi(post('/api/feishu', { ...fixture, resume }), environment, { fetcher });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).url, 'https://fixture.feishu.cn/docx/docxFixture');
  assert.equal(created, 1);
  assert.equal(appends[1].url, appends[2].url);
  const expected = appends[0].body.children.map((block) => Object.values(block)[1].elements[0].text_run.content);
  assert.ok(expected.includes('最低点是什么？'));
  assert.ok(expected.includes('图像最低点是 (0, 0)'));
});
