import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'vite';
import { copyDeskResources } from './assets.mjs';

const outDir = 'harmony/entry/src/main/resources/rawfile/desk';
const iconDir = 'harmony/AppScope/resources/base/media';
const licenses = {
  'pdfjs-dist': 'LICENSE',
  docx: 'LICENSE',
  dompurify: 'LICENSE',
  katex: 'LICENSE',
  marked: 'LICENSE.md',
  'tesseract.js': 'LICENSE.md',
  'tesseract.js-core': 'LICENSE',
  jszip: 'LICENSE.markdown',
};
await build({ mode: 'harmony', build: { outDir, emptyOutDir: true } });
await Promise.all([
  copyDeskResources(outDir),
  mkdir(iconDir, { recursive: true }).then(() => copyFile('public/icon-512.png', `${iconDir}/app_icon.png`)),
  mkdir(`${outDir}/licenses`, { recursive: true }).then(() =>
    Promise.all(Object.entries(licenses).map(([pkg, file]) =>
      copyFile(`node_modules/${pkg}/${file}`, `${outDir}/licenses/${pkg}.txt`)))),
]);
console.log('鸿蒙工程资源已准备好。');
