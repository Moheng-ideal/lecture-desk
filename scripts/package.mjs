import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { copyDeskResources } from './assets.mjs';

await mkdir('dist/.openai', { recursive: true });
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
await Promise.all([
  copyDeskResources('dist/client'),
  build({
    entryPoints: ['server/worker.mjs'],
    outfile: 'dist/server/index.js',
    format: 'esm',
    platform: 'browser',
    minify: true,
    bundle: true,
  }),
]);
await writeFile('dist/server/wrangler.json', JSON.stringify({
  name: 'lecture-desk',
  main: 'index.js',
  compatibility_date: '2026-11-20',
  assets: { directory: '../client', binding: 'ASSETS', run_worker_first: ['/api/*'] },
}, null, 2) + '\n');
