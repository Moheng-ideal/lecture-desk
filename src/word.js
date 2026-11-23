import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, TextRun, Footer } from 'docx';
import { recordSections } from './records.js';
import { drawDiagram } from './diagrams.js';
import { nativeApp } from './platform.js';

const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '等线', cs: 'Calibri' };
const paragraph = (text, options = {}) => new Paragraph({ text, ...options });
const heading = (text, level) => paragraph(text, { heading: level, keepNext: true });
const lines = (text, options) => text.split(/\r?\n/).map((line) => paragraph(line, options));
const excerpt = (text) => new Paragraph({
  style: 'TextbookQuote',
  children: text.split(/\r?\n/).map((line, index) => new TextRun({ text: line, break: index ? 1 : 0 })),
});

export function createWord(title, records, figures = []) {
  const children = [
    heading(title, HeadingLevel.TITLE),
    paragraph(`共 ${records.length} 条问答，包含问题、课本截图或摘录及讲解。`),
  ];
  for (const [index, section] of recordSections(records).entries()) {
    children.push(
      heading(section.heading, HeadingLevel.HEADING_1),
      paragraph(section.date, { style: 'Meta' }),
      heading('问题', HeadingLevel.HEADING_2),
      ...lines(section.question),
    );
    for (const quote of section.references) {
      children.push(heading(quote.label, HeadingLevel.HEADING_2));
      if (quote.image) {
        const scale = Math.min(1, 518 / quote.width, 660 / quote.height);
        children.push(new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new ImageRun({ type: 'jpg', data: quote.image,
            transformation: { width: Math.max(1, Math.round(quote.width * scale)), height: Math.max(1, Math.round(quote.height * scale)) } })] }));
      } else children.push(excerpt(quote.text));
    }
    children.push(heading('讲解', HeadingLevel.HEADING_2));
    for (const [blockIndex, block] of section.answer.entries()) {
      children.push(...lines(block));
      const image = figures[index]?.get(blockIndex);
      if (image) children.push(new Paragraph({ alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: 'png', data: image, transformation: { width: 518, height: 283 } })] }));
    }
  }
  const document = new Document({
    title, creator: '讲课台',
    styles: {
      default: {
        document: { run: { font, color: '222222', size: 22 }, paragraph: { spacing: { after: 110, line: 315 } } },
        title: { run: { font, bold: true, color: '000000', size: 46 }, paragraph: { keepNext: true, spacing: { after: 220 } } },
        heading1: { run: { font, bold: true, color: '000000', size: 31 }, paragraph: { keepNext: true, spacing: { before: 270, after: 90 } } },
        heading2: { run: { font, bold: true, color: '000000', size: 24 }, paragraph: { keepNext: true, spacing: { before: 160, after: 60 } } },
      },
      paragraphStyles: [
        { id: 'Meta', name: '时间', basedOn: 'Normal', run: { size: 19, color: '555555' } },
        { id: 'TextbookQuote', name: '课本摘录', basedOn: 'Normal', paragraph: { indent: { left: 300 }, spacing: { after: 90, line: 310 } } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1240, bottom: 1240, left: 1330, right: 1330 } } },
      footers: { default: new Footer({
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT] })] })],
      }) },
      children,
    }],
  });
  return document;
}

async function diagramPng(diagram) {
  const svg = drawDiagram(diagram);
  const source = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 700;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadWord(title, records) {
  const figures = [];
  for (const section of recordSections(records)) {
    const images = new Map();
    for (const { index, diagram } of section.figures) {
      const image = await diagramPng(diagram).catch(() => null);
      if (image) images.set(index, image);
    }
    figures.push(images);
  }
  const blob = await Packer.toBlob(createWord(title, records, figures));
  const filename = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.docx`;
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
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
