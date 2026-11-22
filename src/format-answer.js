import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Marked } from 'marked';
import { drawDiagram, parseDiagram } from './diagrams.js';

const displayRule = /^(?:\$\$\s*([\s\S]+?)\s*\$\$|\\\[\s*([\s\S]+?)\s*\\\])/;
const formats = [
  { name: 'mathBlock', level: 'block', rule: displayRule },
  { name: 'mathInline', level: 'inline', rule: /^(?:\$(?!\$)([^$\n]+?)\$|\\\(([^\n]+?)\\\))/ },
  { name: 'mathDisplayInline', level: 'inline', rule: displayRule },
];

const parser = new Marked();
parser.use({
  extensions: formats.map(({ name, level, rule }) => ({
    name, level,
    start: (text) => text.search(name === 'mathInline' ? /\$|\\\(/ : /\$\$|\\\[/),
    tokenizer(text) {
      const match = rule.exec(text);
      if (match) return { type: name, raw: match[0], text: match[1] ?? match[2] };
    },
    renderer(token) {
      return katex.renderToString(token.text, { displayMode: name !== 'mathInline', throwOnError: false,
        trust: false, maxExpand: 200, maxSize: 20 });
    },
  })),
});

export function formatAnswer(target, text) {
  target.className = 'formatted';
  target.innerHTML = DOMPurify.sanitize(parser.parse(text), {
    FORBID_TAGS: ['img', 'iframe', 'audio', 'video', 'style', 'form', 'input'],
  });
  for (const code of target.querySelectorAll('pre > code.language-diagram')) {
    const diagram = parseDiagram(code.textContent);
    if (!diagram) continue;
    const figure = document.createElement('figure');
    figure.className = 'teaching-diagram';
    figure.append(drawDiagram(diagram));
    code.parentElement.replaceWith(figure);
  }
  for (const link of target.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}
