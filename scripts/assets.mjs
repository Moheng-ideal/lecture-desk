import { copyFile, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function copyDeskResources(destination) {
  const target = (path) => join(destination, path);
  await Promise.all([
    cp('node_modules/pdfjs-dist/cmaps', target('pdf/cmaps'), { recursive: true }),
    cp('node_modules/pdfjs-dist/standard_fonts', target('pdf/fonts'), { recursive: true }),
    cp('node_modules/pdfjs-dist/wasm', target('pdf/wasm'), { recursive: true }),
    mkdir(target('ocr/core'), { recursive: true }),
    mkdir(target('ocr/lang'), { recursive: true }),
  ]);
  await Promise.all([
    ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'].map((file) =>
      copyFile(`node_modules/tesseract.js-core/${file}`, target(`ocr/core/${file}`))),
    ...['chi_sim', 'eng'].map((lang) =>
      copyFile(`node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
        target(`ocr/lang/${lang}.traineddata.gz`))),
  ]);
}
