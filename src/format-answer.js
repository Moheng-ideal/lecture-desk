import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Marked } from 'marked';

const formats = [
  { name: 'mathBlock', level: 'block', rule: /^(?:\$\$\s*([\s\S]+?)\s*\$\$|\\\[\s*([\s\S]+?)\s*\\\])/ },
  { name: 'mathInline', level: 'inline', rule: /^(?:\$([^$\n]+?)\$|\\\(([^\n]+?)\\\))/ },
];

const parser = new Marked();
parser.use({
  extensions: formats.map(({ name, level, rule }) => ({
    name, level,
    start: (text) => text.search(level === 'block' ? /\$\$|\\\[/ : /\$|\\\(/),
    tokenizer(text) {
      const match = rule.exec(text);
      if (match) return { type: name, raw: match[0], text: match[1] ?? match[2] };
    },
    renderer(token) {
      return katex.renderToString(token.text, { displayMode: level === 'block', throwOnError: false, trust: false });
    },
  })),
});

export function formatAnswer(target, text) {
  target.className = 'formatted';
  target.innerHTML = DOMPurify.sanitize(parser.parse(text), {
    FORBID_TAGS: ['img', 'iframe', 'audio', 'video', 'style', 'form', 'input'],
  });
  for (const link of target.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}
