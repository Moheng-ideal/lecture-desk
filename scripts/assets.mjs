import { cp } from 'node:fs/promises';
import { join } from 'node:path';

export async function copyDeskResources(destination) {
  const target = (path) => join(destination, path);
  await Promise.all([
    cp('node_modules/pdfjs-dist/cmaps', target('pdf/cmaps'), { recursive: true }),
    cp('node_modules/pdfjs-dist/standard_fonts', target('pdf/fonts'), { recursive: true }),
    cp('node_modules/pdfjs-dist/wasm', target('pdf/wasm'), { recursive: true }),
  ]);
}
