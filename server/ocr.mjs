// Node-only helper: OCR a data: URL image with Windows built-in OCR.
// Imported dynamically from api.mjs so the browser bundle never pulls in
// node:child_process.
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ocr.ps1', import.meta.url));

// Chinese OCR often inserts spaces between every glyph; drop those but keep
// spaces between latin words / numbers.
function tidy(text) {
  return text
    .replace(/\r/g, '')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/([\u4e00-\u9fff])\s+(?=[，。！？；：、（）《》])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function ocrDataUrl(dataUrl) {
  const match = /^data:image\/(\w+);base64,([\s\S]+)$/.exec(dataUrl || '');
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  if (!['png', 'jpg', 'bmp', 'gif', 'webp'].includes(ext)) return null;
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 12 * 1024 * 1024) return null;
  const file = join(tmpdir(), `desk-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  await writeFile(file, buf);
  try {
    return await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', file],
        { timeout: 40000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : tidy(String(stdout || ''))));
    });
  } finally {
    await unlink(file).catch(() => {});
  }
}
