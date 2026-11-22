import { AlignmentType, Document, HeadingLevel, Packer, PageNumber, Paragraph, TextRun, Footer } from 'docx';
import { recordSections } from './records.js';

const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '等线', cs: 'Calibri' };
const paragraph = (text, options = {}) => new Paragraph({ text, ...options });
const heading = (text, level) => paragraph(text, { heading: level, keepNext: true });
const lines = (text, options) => text.split(/\r?\n/).map((line) => paragraph(line, options));
const excerpt = (text) => new Paragraph({
  style: 'TextbookQuote',
  children: text.split(/\r?\n/).map((line, index) => new TextRun({ text: line, break: index ? 1 : 0 })),
});

export function createWord(title, records) {
  const children = [
    heading(title, HeadingLevel.TITLE),
    paragraph(`共 ${records.length} 条问答，包含问题、课本摘录及讲解。`),
  ];
  for (const section of recordSections(records)) {
    children.push(
      heading(section.heading, HeadingLevel.HEADING_1),
      paragraph(section.date, { style: 'Meta' }),
      heading('问题', HeadingLevel.HEADING_2),
      ...lines(section.question),
    );
    for (const quote of section.references) {
      children.push(heading(quote.label, HeadingLevel.HEADING_2), excerpt(quote.text));
    }
    children.push(heading('讲解', HeadingLevel.HEADING_2));
    for (const block of section.answer) children.push(...lines(block));
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

export async function downloadWord(title, records) {
  const blob = await Packer.toBlob(createWord(title, records));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.docx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
