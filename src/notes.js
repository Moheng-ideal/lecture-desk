// Note-taking data layer: multiple independent notes, each with pages of
// normalised ink strokes (same 0~1 coordinate convention as the whiteboard).
import { listNotes, saveNote, removeNote, newId } from './storage.js';

export const BACKGROUNDS = ['lined', 'grid', 'dots', 'blank'];
export const BACKGROUND_LABELS = { lined: '横线', grid: '方格', dots: '点阵', blank: '空白' };

export function newPage() {
  return { id: newId(), strokes: [] };
}

export function createNote(title = '未命名笔记', background = 'lined') {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title,
    background,
    pages: [newPage()],
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadNotes() {
  const notes = await listNotes().catch(() => []);
  return notes.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function persistNote(note) {
  note.updatedAt = new Date().toISOString();
  await saveNote(note);
  return note;
}

export async function dropNote(id) {
  await removeNote(id);
}

// Keep note titles unique enough to tell apart in the list.
export function uniqueTitle(notes, base = '未命名笔记') {
  const used = new Set(notes.map((note) => note.title));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function strokeCount(note) {
  return note.pages.reduce((total, page) => total + page.strokes.length, 0);
}
