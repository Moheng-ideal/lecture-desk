import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { networkInterfaces } from 'node:os';
import { handleApi } from './api.mjs';

const root = fileURLToPath(new URL('../dist/client', import.meta.url));
const host = process.env.TEACH_HOST || '127.0.0.1';
const port = Number(process.env.TEACH_PORT || 8787);
const localAddresses = ['localhost', '127.0.0.1', '::1'];
if (!localAddresses.includes(host) && (process.env.TEACH_PASS || '').length < 12) {
  console.error('开启局域网访问前，请在 .env 中配置至少 12 个字符的 TEACH_PASS。');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.png': 'image/png',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
  '.gz': 'application/gzip', '.bcmap': 'application/octet-stream',
};

async function serveAsset(request, response, url) {
  if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405).end();
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const path = resolve(root, '.' + pathname);
  if (!path.startsWith(root + sep)) return response.writeHead(404).end();
  const file = await stat(path).catch(() => null);
  if (!file?.isFile()) return response.writeHead(404).end('未找到文件。请先运行 npm run build。');
  response.writeHead(200, {
    'Content-Type': types[extname(path)] || 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') return response.end();
  await pipeline(createReadStream(path), response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!url.pathname.startsWith('/api/')) return await serveAsset(request, response, url);
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const result = await handleApi(new Request(url, {
      method: request.method, headers: request.headers, signal: controller.signal,
      ...(hasBody && { body: Readable.toWeb(request), duplex: 'half' }),
    }), process.env);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await pipeline(Readable.fromWeb(result.body), response);
    else response.end();
  } catch {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('请求处理失败。');
  }
});

server.listen(port, host, () => {
  console.log(`讲课台 http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  if (host === '0.0.0.0') {
    for (const item of Object.values(networkInterfaces()).flat()) {
      if (item?.family === 'IPv4' && !item.internal) console.log(`平板访问 http://${item.address}:${port}`);
    }
  }
});
