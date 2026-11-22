const pointPerEmu = 1 / 12700;

async function openWord(data, extension, options) {
  const { DocxDocument, buildDocxTextLayer } = await import('@silurus/ooxml/docx');
  const legacyDoc = extension === 'doc' ? (await import('@silurus/ooxml-legacy-office/doc')).legacyDoc : undefined;
  const model = await DocxDocument.load(data, { ...options, legacyDoc });
  return {
    model, textLayer: buildDocxTextLayer,
    size(index) {
      const { widthPt, heightPt } = model.pageSize(index);
      return { width: widthPt, height: heightPt };
    },
    count: () => model.pageCount,
    bitmap: (index, width, dpr) => model.renderPageToBitmap(index, { width, dpr }),
    runs: (index, width) => model.collectPageRuns(index, { width }),
  };
}

async function openSlides(data, extension, options) {
  const { PptxPresentation, buildPptxTextLayer } = await import('@silurus/ooxml/pptx');
  const legacyPpt = extension === 'ppt' ? (await import('@silurus/ooxml-legacy-office/ppt')).legacyPpt : undefined;
  const model = await PptxPresentation.load(data, { ...options, legacyPpt });
  return {
    model, textLayer: buildPptxTextLayer,
    size: () => ({ width: model.slideWidth * pointPerEmu, height: model.slideHeight * pointPerEmu }),
    count: () => model.slideCount,
    bitmap: (index, width, dpr) => model.renderSlideToBitmap(index, { width, dpr }),
    runs: (index, width) => model.collectSlideRuns(index, width),
  };
}

function officePage(source, index) {
  const { width, height } = source.size(index);
  if (!(width > 0 && height > 0)) throw new Error('文档页尺寸无效。');
  return {
    getViewport: ({ scale }) => ({ width: width * scale, height: height * scale, scale, userUnit: 1 }),
    render({ canvasContext, viewport, transform }) {
      let cancelled = false;
      return {
        cancel() { cancelled = true; },
        promise: source.bitmap(index, viewport.width, transform[0]).then((bitmap) => {
          try {
            if (!cancelled) {
              const target = canvasContext.canvas;
              canvasContext.fillStyle = 'white';
              canvasContext.fillRect(0, 0, target.width, target.height);
              canvasContext.drawImage(bitmap, 0, 0, target.width, target.height);
            }
          } finally { bitmap.close(); }
        }),
      };
    },
    async textRuns(viewport) { return source.runs(index, viewport.width); },
    placeText(layer, viewport, runs) {
      source.textLayer(layer, runs, viewport.width, viewport.height);
      const spans = [];
      for (const span of layer.querySelectorAll('[data-run-index]')) spans[Number(span.dataset.runIndex)] = span;
      return spans;
    },
  };
}

export function openOffice(file, extension) {
  let source;
  let cancelled = false;
  const promise = (async () => {
    if (typeof OffscreenCanvas !== 'function') throw new Error('此设备的文档组件需要更新才能打开 Office 课件。');
    const open = extension.startsWith('doc') ? openWord : openSlides;
    const data = await file.arrayBuffer();
    if (cancelled) throw new DOMException('文档已取消打开', 'AbortError');
    source = await open(data, extension, { mode: 'worker', useGoogleFonts: false });
    if (cancelled) {
      source.model.destroy();
      throw new DOMException('文档已取消打开', 'AbortError');
    }
    await source.model.waitUntilLayoutComplete();
    const numPages = source.count();
    if (!numPages || source.model.partFailures.length) throw new Error('文档内容不完整，无法读取全部页面。');
    return {
      office: true, numPages,
      async getPage(number) { return officePage(source, number - 1); },
      async destroy() { await task.destroy(); },
    };
  })();
  const task = {
    promise,
    async destroy() {
      if (cancelled) return;
      cancelled = true;
      source?.model.destroy();
    },
  };
  return task;
}

export function officeTextItems(runs) {
  return runs.map((run, index) => {
    const next = runs[index + 1];
    const y = run.y ?? run.shapeY + run.inShapeY;
    const nextY = next?.y ?? next?.shapeY + next?.inShapeY;
    return { str: run.text, hasEOL: Math.abs(y - nextY) > run.h * .5 ||
      run.paragraphId !== next?.paragraphId || run.shapeId !== next?.shapeId };
  });
}
