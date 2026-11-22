import { AnnotationEditorType, PermissionFlag } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { paintStrokes } from './ink.js';
import { nativeApp } from './platform.js';

export function annotatedFilename(title) {
  const safe = title.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim();
  return `${Array.from(safe || '课本').slice(0, 115).join('')}（批注）.pdf`;
}

export async function buildAnnotatedPdf(reader) {
  reader.finishPointer(true);
  const { pdf, lastWidth } = reader;
  if (!pdf) throw new Error('请先打开课本。');
  const pages = Object.entries(reader.pages).filter(([, strokes]) => strokes.length);
  if (!pages.length) return new Blob([await pdf.getData()], { type: 'application/pdf' });
  const permissions = await pdf.getPermissions();
  if (permissions && !permissions.includes(PermissionFlag.MODIFY_ANNOTATIONS)) {
    throw new Error('这份 PDF 的权限设置限制了写入批注。');
  }
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('此系统版本暂不支持导出笔触，请更新系统后重试。');
  }
  const storage = pdf.annotationStorage;
  const stamps = new Map();
  const canvas = document.createElement('canvas');
  try {
    for (const [number, strokes] of pages) {
      const index = Number(number) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) continue;
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const cssWidth = Math.min(lastWidth, viewport.width * 1.55);
      const pixelBudget = Math.min(2800000, 24000000 / pages.length);
      const pixels = Math.min(2.5, Math.sqrt(pixelBudget / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.round(viewport.width * pixels));
      canvas.height = Math.max(1, Math.round(viewport.height * pixels));
      paintStrokes(canvas, strokes, 1, null, cssWidth);
      // PDF.js 5.4 recognizes serialized editor entries by this prefix.
      const key = `pdfjs_internal_editor_lecture_desk_${index}`;
      const bitmap = await createImageBitmap(canvas);
      stamps.set(key, bitmap);
      storage.setValue(key, {
        annotationType: AnnotationEditorType.STAMP, bitmapId: key, bitmap,
        pageIndex: index, rect: page.view, rotation: viewport.rotation,
      });
    }
    return new Blob([await pdf.saveDocument()], { type: 'application/pdf' });
  } finally {
    for (const [key, bitmap] of stamps) {
      storage.remove(key);
      bitmap.close();
    }
    canvas.width = canvas.height = 0;
  }
}

export async function savePdfOnDevice(blob, filename) {
  if (nativeApp) {
    const { saveHarmonyDocument } = await import('./harmony.js');
    return saveHarmonyDocument(filename, blob);
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
