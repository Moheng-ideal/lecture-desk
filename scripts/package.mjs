import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/.openai', { recursive: true });
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
await Promise.all([
  cp('node_modules/pdfjs-dist/cmaps', 'dist/client/pdf/cmaps', { recursive: true }),
  cp('node_modules/pdfjs-dist/standard_fonts', 'dist/client/pdf/fonts', { recursive: true }),
  cp('node_modules/pdfjs-dist/wasm', 'dist/client/pdf/wasm', { recursive: true }),
  mkdir('dist/client/ocr/core', { recursive: true }),
  mkdir('dist/client/ocr/lang', { recursive: true }),
  build({
    entryPoints: ['server/worker.mjs'],
    outfile: 'dist/server/index.js',
    format: 'esm',
    platform: 'browser',
    minify: true,
    bundle: true,
  }),
]);
for (const name of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']) {
  await copyFile(`node_modules/tesseract.js-core/${name}`, `dist/client/ocr/core/${name}`);
}
for (const lang of ['chi_sim', 'eng']) {
  await copyFile(`node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    `dist/client/ocr/lang/${lang}.traineddata.gz`);
}
await writeFile('dist/server/wrangler.json', JSON.stringify({
  name: 'lecture-desk',
  main: 'index.js',
  compatibility_date: '2026-11-20',
  assets: { directory: '../client', binding: 'ASSETS', run_worker_first: ['/api/*'] },
}, null, 2) + '\n');
