import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { handleApi } from '../server/api.mjs';

const origin = 'https://lecture.example';
const environment = {
  DEEPSEEK_API_KEY: 'sk-test-key', VISION_API_KEY: 'sk-vision-test', TEACH_PASS: 'local-test-code',
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
      assert.equal(config.headers.Authorization, 'Bearer sk-test-key');
      outgoing = JSON.parse(config.body);
      return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /\[DONE\]/);
  assert.equal(outgoing.model, 'deepseek-flash');
  assert.equal(outgoing.max_tokens, 393216);
  assert.match(outgoing.messages[1].content, /《函数与图像》第 2 页/);
  assert.match(outgoing.messages[1].content, /图像最低点/);
});

test('adds optional learner context and style without truncating a long prior answer', async () => {
  const longAnswer = '推导步骤。'.repeat(12000);
  const preferences = { profile: '第一次学晶体结构', style: '用助教的口吻' };
  const result = await handleApi(post('/api/chat', {
    ...question, preferences, history: [{ ...question, answer: longAnswer }],
  }), environment, {
    fetcher: async (_url, config) => {
      const { messages } = JSON.parse(config.body);
      assert.match(messages[0].content, /第一次学晶体结构/);
      assert.match(messages[0].content, /用助教的口吻/);
      assert.equal(messages[2].content, longAnswer);
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(result.status, 200);
});

test('Hermes receives screenshots and conversation history using the configured profile and model defaults', async () => {
  const baseUrl = 'https://hermes.example/p/teacher/v1/';
  const pin = '962507';
  const env = { ...environment, HERMES_BASE_URL: baseUrl, HERMES_API_KEY: 'hermes-fixture',
    HERMES_PIN_HASH: createHash('sha256').update(pin).digest('hex') };
  const screenshot = { book: ref.book, page: 3, method: '选文截图', image: 'data:image/jpeg;base64,/9j/2Q==', width: 100, height: 80 };
  const response = await handleApi(post('/api/chat', { ...question, provider: 'hermes', references: [screenshot],
    history: [{ ...question, answer: '上次回答。' }],
    credentials: { hermes: { baseUrl: 'https://ignored.example/v1', key: 'ignored-key' } },
  }, { 'X-Hermes-Pin': pin }), env, {
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://hermes.example/p/teacher/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer hermes-fixture');
      assert.equal(options.redirect, 'error');
      const payload = JSON.parse(options.body);
      assert.equal(payload.stream, true);
      assert.equal(payload.model, undefined);
      assert.equal(payload.messages[2].content, '上次回答。');
      assert.match(payload.messages[3].content[1].text, /第 3 页/);
      assert.equal(payload.messages[3].content[2].image_url.url, screenshot.image);
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[DONE\]/);
  const config = await handleApi(new Request(origin + '/api/config', { headers: { 'X-Teach-Code': env.TEACH_PASS } }), env);
  const publicConfig = await config.json();
  assert.equal(publicConfig.hermes, true);
  assert.equal(publicConfig.canConfigureHermes, false);
  assert.doesNotMatch(JSON.stringify(publicConfig), /hermes-fixture|hermes\.example/);
});

test('Hermes keeps browser requests locked and refuses plaintext connections', async () => {
  const body = { ...question, provider: 'hermes', credentials: { hermes: { baseUrl: 'https://unconfigured.example', key: 'fixture' } } };
  const fetcher = async () => assert.fail('Unexpected Hermes request');
  assert.equal((await handleApi(post('/api/chat', body), environment, { fetcher })).status, 422);
  const hostedEnv = { ...environment, HERMES_BASE_URL: 'https://hermes.example/v1', HERMES_API_KEY: 'fixture',
    HERMES_PIN_HASH: createHash('sha256').update('962507').digest('hex') };
  assert.equal((await handleApi(post('/api/chat', body), hostedEnv, { hosted: true, fetcher })).status, 422);
  assert.equal((await handleApi(post('/api/chat', body), { ...hostedEnv, TEACH_PASS: '' }, { fetcher })).status, 422);
  assert.equal((await handleApi(post('/api/chat', body), hostedEnv, { fetcher })).status, 403);
  assert.equal((await handleApi(post('/api/chat', body, { 'X-Hermes-Pin': '123456' }), hostedEnv, { fetcher })).status, 403);
  for (const baseUrl of ['http://hermes.example/v1', 'https://user@hermes.example/v1', 'https://hermes.example/v1?key=fixture']) {
    body.credentials.hermes.baseUrl = baseUrl;
    const response = await handleApi(post('/api/chat', body), {}, { localApp: true, hermesFetcher: fetcher });
    assert.equal(response.status, 422, baseUrl);
  }
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

test('sends multiple screenshots with ordered page labels and uses the naming prompt separately', async () => {
  const screenshots = [2, 5].map((page) => ({ ...ref, text: undefined, page, method: '选文截图',
    image: 'data:image/jpeg;base64,/9j/2Q==', width: 100, height: 80 }));
  for (const path of ['/api/chat', '/api/book-title']) {
    let outgoing;
    const response = await handleApi(post(path, { ...question, references: screenshots }), environment, {
      fetcher: async (_url, config) => {
        outgoing = JSON.parse(config.body);
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    assert.equal(response.status, 200);
    const [system, user] = outgoing.messages;
    assert.deepEqual(user.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
      screenshots.map((quote) => quote.image));
    assert.match(user.content[1].text, /第 2 页/);
    assert.match(user.content[3].text, /第 5 页/);
    if (path.endsWith('book-title')) assert.match(system.content, /只输出一行/);
  }
  const invalid = await handleApi(post('/api/chat', { ...question,
    references: [{ ...screenshots[0], image: 'https://example.com/remote-image.jpg' }] }), environment);
  assert.equal(invalid.status, 400);
});

test('resumes a screenshot upload without creating a second Feishu image block', async () => {
  const selected = { ...fixture, records: [{ ...fixture.records[0], answer: '讲解',
    references: [{ ...ref, text: undefined, method: '选文截图', image: 'data:image/jpeg;base64,/9j/2Q==',
      width: 100, height: 80 }] }] };
  let inserts = 0;
  let uploads = 0;
  let patches = 0;
  const fetcher = async (url, config) => {
    if (url.endsWith('/internal')) return Response.json({ code: 0, tenant_access_token: 'access-fixture' });
    if (url.endsWith('/documents')) return Response.json({ code: 0, data: { document: { document_id: 'docxFixture' } } });
    if (url.endsWith('/medias/upload_all')) {
      assert.equal(config.body.get('parent_type'), 'docx_image');
      assert.equal(config.body.get('parent_node'), 'imageBlock');
      assert.equal(config.body.get('file').type, 'image/jpeg');
      uploads++;
      return Response.json({ code: 0, data: { file_token: 'mediaToken' } });
    }
    if (config.method === 'PATCH') {
      assert.match(url, /docxFixture\/blocks\/imageBlock$/);
      assert.equal(JSON.parse(config.body).replace_image.token, 'mediaToken');
      patches++;
      return Response.json({ code: patches === 1 ? 1234 : 0 });
    }
    inserts++;
    const { children } = JSON.parse(config.body);
    assert.deepEqual(children.find((block) => block.block_type === 27), { block_type: 27, image: {} });
    return Response.json({ code: 0, data: { children: children.map((block) =>
      ({ block_id: block.block_type === 27 ? 'imageBlock' : 'textBlock' })) } });
  };
  const partial = await handleApi(post('/api/feishu', selected), environment, { fetcher });
  assert.equal(partial.status, 502);
  const { resume } = await partial.json();
  const response = await handleApi(post('/api/feishu', { ...selected, resume }), environment, { fetcher });
  assert.equal(response.status, 200);
  assert.equal(inserts, 1);
  assert.equal(uploads, 2);
  assert.equal(patches, 2);
});
