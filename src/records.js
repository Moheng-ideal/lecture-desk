import { marked } from 'marked';
import { diagramDescription, parseDiagram } from './diagrams.js';

const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hour12: false,
});

export const formatDate = (date) => formatter.format(new Date(date));
export const sourceLabel = ({ book, page, method }) => `《${book}》第 ${page} 页 · ${method}`;

export function groupRecords(records, titles) {
  const groups = new Map();
  for (const record of records) {
    const id = record.bookId;
    if (!groups.has(id)) groups.set(id, { id, title: titles.get(id) || '', records: [] });
    const group = groups.get(id);
    group.title ||= record.bookTitle || record.references?.find((ref) => ref.book)?.book || '';
    group.records.push(record);
  }
  let unknown = 0;
  for (const group of groups.values()) {
    if (!group.title) group.title = `已移除的课本 ${++unknown}`;
  }
  return [...groups.values()];
}

function inlineText(tokens = []) {
  return tokens.map((token) => {
    if (token.type === 'br') return '\n';
    if (token.type === 'image') return token.text || '';
    if (token.type === 'link') {
      const label = inlineText(token.tokens) || token.text;
      return label === token.href ? label : `${label}（${token.href}）`;
    }
    if (token.tokens) return inlineText(token.tokens);
    return token.text || '';
  }).join('').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function blockText(tokens) {
  return tokens.flatMap((token) => {
    if (token.type === 'space' || token.type === 'hr') return [];
    if (token.type === 'list') return token.items.flatMap((item, index) =>
      blockText(item.tokens).map((line, part) => part ? `  ${line}` : `${token.ordered ? `${token.start + index}.` : '•'} ${line}`));
    if (token.type === 'blockquote') return blockText(token.tokens).map((line) => `› ${line}`);
    if (token.type === 'table') return [token.header, ...token.rows].map((row) => row.map((cell) => inlineText(cell.tokens)).join(' │ '));
    return [token.tokens ? inlineText(token.tokens) : token.text || ''];
  });
}

export function recordSections(records) {
  return records.map((record, index) => {
    const parts = marked.lexer(record.answer).flatMap((token) => {
      const diagram = token.type === 'code' && token.lang === 'diagram' ? parseDiagram(token.text) : null;
      return diagram ? [{ text: diagramDescription(diagram), diagram }] : blockText([token]).map((text) => ({ text }));
    });
    return {
      heading: `第 ${index + 1} 问`,
      date: formatDate(record.date),
      question: record.question,
      references: record.references.map((reference) => ({ label: sourceLabel(reference), text: reference.text })),
      answer: parts.map(({ text }) => text),
      figures: parts.flatMap(({ diagram }, index) => diagram ? [{ index, diagram }] : []),
    };
  });
}
