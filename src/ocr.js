import { createWorker, OEM, PSM } from 'tesseract.js';
import workerPath from 'tesseract.js/dist/worker.min.js?url';

export async function recognizeRegion(source, bounds, progress) {
  const { width, height } = source;
  const x = Math.floor(bounds.x * width);
  const y = Math.floor(bounds.y * height);
  const cropWidth = Math.max(1, Math.ceil(bounds.w * width));
  const cropHeight = Math.max(1, Math.ceil(bounds.h * height));
  const ratio = Math.min(1.8, 2600 / Math.max(cropWidth, cropHeight), Math.sqrt(3700000 / (cropWidth * cropHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cropWidth * ratio));
  canvas.height = Math.max(1, Math.round(cropHeight * ratio));
  canvas.getContext('2d').drawImage(source, x, y, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  const root = new URL('/ocr/', location.href);
  const worker = await createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
    workerPath,
    corePath: new URL('core/', root).href,
    langPath: new URL('lang/', root).href,
    logger: ({ status, progress: fraction }) => progress(
      status === 'recognizing text' ? `正在识字… ${Math.round(fraction * 100)}%` : '正在加载本地识字模型…',
    ),
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const result = await worker.recognize(canvas);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}
