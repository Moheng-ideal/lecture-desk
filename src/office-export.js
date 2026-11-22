import { PDFDocument } from 'pdf-lib';
import { paintStrokes } from './ink.js';

export async function exportOfficePdf(source, annotations, lastWidth, progress) {
  const output = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const ink = document.createElement('canvas');
  try {
    for (let number = 1; number <= source.numPages; number++) {
      progress?.(number, source.numPages);
      const page = await source.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const { width, height } = viewport;
      const pixels = Math.min(2.4, Math.sqrt(2200000 / (width * height)));
      canvas.width = Math.max(1, Math.ceil(width * pixels));
      canvas.height = Math.max(1, Math.ceil(height * pixels));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, transform: [pixels] }).promise;
      const strokes = annotations[number];
      if (strokes?.length) {
        ink.width = canvas.width;
        ink.height = canvas.height;
        paintStrokes(ink, strokes, 1, null, Math.min(lastWidth, width * 1.55));
        ctx.drawImage(ink, 0, 0);
      }
      const image = await new Promise((resolve, reject) => canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`无法保存第 ${number} 页。`));
      }, 'image/jpeg', .9));
      const raster = await output.embedJpg(await image.arrayBuffer());
      output.addPage([width, height]).drawImage(raster, { x: 0, y: 0, width, height });
    }
    return new Blob([await output.save()], { type: 'application/pdf' });
  } finally {
    canvas.width = canvas.height = ink.width = ink.height = 0;
  }
}
