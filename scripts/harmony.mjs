import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'vite';
import { copyDeskResources } from './assets.mjs';

const android = process.argv[2] === 'android';
const outDir = android ? 'android/assets/desk' : 'harmony/entry/src/main/resources/rawfile/desk';
const iconDir = android ? 'android/res/drawable-nodpi' : 'harmony/AppScope/resources/base/media';
const licenses = {
  'pdfjs-dist': 'LICENSE',
  docx: 'LICENSE',
  dompurify: 'LICENSE',
  katex: 'LICENSE',
  marked: 'LICENSE.md',
  'tesseract.js': 'LICENSE.md',
  'tesseract.js-core': 'LICENSE',
  jszip: 'LICENSE.markdown',
  '@silurus/ooxml': 'LICENSE',
  '@silurus/ooxml-legacy-office': 'LICENSE',
  'pdf-lib': 'LICENSE.md',
};
await build({ mode: android ? 'android' : 'harmony', build: { outDir, emptyOutDir: true } });
await Promise.all([
  copyDeskResources(outDir),
  mkdir(iconDir, { recursive: true }).then(() => copyFile('public/icon-512.png', `${iconDir}/app_icon.png`)),
  mkdir(`${outDir}/licenses`, { recursive: true }).then(() =>
    Promise.all([
      ...Object.entries(licenses).map(([pkg, file]) =>
        copyFile(`node_modules/${pkg}/${file}`, `${outDir}/licenses/${pkg.replace('@', '').replace('/', '-')}.txt`)),
      ...['ooxml', 'ooxml-legacy-office'].map((pkg) =>
        copyFile(`node_modules/@silurus/${pkg}/THIRD_PARTY_NOTICES.md`, `${outDir}/licenses/${pkg}-notices.txt`)),
    ])),
]);
console.log(android ? 'Android 工程资源已准备好。' : '鸿蒙工程资源已准备好。');
