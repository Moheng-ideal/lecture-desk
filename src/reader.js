import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { eraseAt, paintStrokes } from './ink.js';
import { readState, saveState } from './storage.js';

GlobalWorkerOptions.workerSrc = pdfWorker;
const byId = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const scanMessage = '框选课本文字，扫描版可直接识字。';

function joinText(items) {
  let text = '';
  for (const { str, hasEOL } of items) {
    if (/[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(str)) text += ' ';
    text += str + (hasEOL ? '\n' : '');
  }
  return text.trim();
}

function overlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function intersectsCharacter(box, character) {
  return overlap(box, character) &&
    Math.min(box.right, character.right) - Math.max(box.left, character.left) >= character.width * .25;
}

function getSpanText(span, box) {
  if (!span) return '';
  const rect = span.getBoundingClientRect();
  if (!overlap(rect, box)) return '';
  if (box.left <= rect.left && box.right >= rect.right) return span.textContent;
  if (!span.firstChild || span.firstChild.nodeType !== Node.TEXT_NODE) return span.textContent;
  const range = document.createRange();
  let position = 0;
  return Array.from(span.textContent).filter((letter) => {
    range.setStart(span.firstChild, position);
    position += letter.length;
    range.setEnd(span.firstChild, position);
    return intersectsCharacter(box, range.getBoundingClientRect());
  }).join('');
}

export class Reader {
  constructor({ quote, notify, change, error }) {
    this.onQuote = quote;
    this.notify = notify;
    this.onChange = change;
    this.onError = error;
    this.reader = byId('reader');
    this.paper = byId('page-wrap');
    this.canvas = byId('pdf-canvas');
    this.ink = byId('ink-canvas');
    this.textLayer = byId('text-layer');
    this.rect = byId('selection-rect');
    this.zoom = 1;
    this.tool = 'read';
    this.page = 1;
    this.pages = {};
    this.history = new Map();
    this.revision = 0;
    this.openRevision = 0;
    this.colorByTool = { pen: '#ba472d', marker: '#dfad2e' };

    byId('modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tool]');
      if (button) this.setTool(button.dataset.tool);
    });
    byId('ink-color').addEventListener('input', (event) => {
      this.colorByTool[this.tool === 'marker' ? 'marker' : 'pen'] = event.target.value;
    });
    byId('native-select').onclick = () => this.setTool(this.tool === 'native' ? 'select' : 'native');
    byId('use-selection').onclick = () => this.quoteSelection().catch(this.onError);
    byId('use-selection').onpointerdown = (event) => event.preventDefault();
    byId('page-quote').onclick = () => this.quotePage().then(this.onQuote).catch(this.onError);
    byId('prev').onclick = () => this.setPage(this.page - 1).catch(this.onError);
    byId('next').onclick = () => this.setPage(this.page + 1).catch(this.onError);
    byId('page-number').onchange = (event) => this.setPage(Number(event.target.value)).catch(this.onError);
    byId('zoom-in').onclick = () => this.setZoom(this.zoom + .25);
    byId('zoom-out').onclick = () => this.setZoom(this.zoom - .25);
    byId('zoom-reset').onclick = () => this.setZoom(1);
    byId('undo').onclick = () => this.travelHistory('undo', 'redo');
    byId('redo').onclick = () => this.travelHistory('redo', 'undo');
    this.reader.addEventListener('keydown', (event) => {
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        this.setPage(this.page + (event.key === 'PageUp' ? -1 : 1)).catch(this.onError);
      }
    });
    this.ink.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.ink.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.ink.addEventListener('pointerup', (event) => this.pointerEnd(event));
    this.ink.addEventListener('pointercancel', (event) => this.pointerEnd(event, true));
    this.ink.addEventListener('lostpointercapture', (event) => this.pointerEnd(event, true));
    let resize;
    new ResizeObserver(() => {
      clearTimeout(resize);
      resize = setTimeout(() => {
        const width = this.availableWidth();
        if (this.pdf && width > 0 && Math.abs(width - this.lastWidth) > 1) this.render().catch(this.onError);
      }, 140);
    }).observe(this.reader);
    this.sync();
  }

  async open(book) {
    const revision = ++this.openRevision;
    this.loading?.destroy().catch(() => {});
    this.showStatus('正在打开课本…');
    const options = {
      cMapUrl: '/pdf/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdf/fonts/',
      wasmUrl: '/pdf/wasm/',
      isEvalSupported: false,
    };
    const source = book.file ? { data: await book.file.arrayBuffer() } : { url: '/sample.pdf' };
    if (revision !== this.openRevision) return false;
    const task = getDocument({ ...options, ...source });
    this.loading = task;
    task.onPassword = (update, reason) => {
      const password = window.prompt(reason === 2 ? '密码错误，请重新输入 PDF 密码' : '请输入此 PDF 的密码');
      if (password) update(password);
      else task.destroy().catch(() => {});
    };
    try {
      const pdf = await task.promise;
      const prior = await readState(`reader:${book.id}`).catch(() => null);
      if (revision !== this.openRevision) {
        await task.destroy();
        return false;
      }
      this.renderTask?.cancel();
      this.layerTask?.cancel();
      this.pdf?.destroy().catch(() => {});
      this.pdf = pdf;
      this.book = book;
      this.pages = prior?.pages || {};
      this.page = clamp(prior?.page || 1, 1, pdf.numPages);
      this.history.clear();
      this.reader.scrollTop = 0;
      this.reader.scrollLeft = 0;
      await this.render();
      return revision === this.openRevision;
    } catch (error) {
      if (revision !== this.openRevision) return false;
      task.destroy().catch(() => {});
      this.showStatus(this.pdf ? '' : '打开失败，请尝试另一份 PDF。');
      throw new Error(`无法打开课本。 ${error.message || ''}`);
    } finally {
      if (this.loading === task) this.loading = null;
    }
  }

  availableWidth() {
    const style = getComputedStyle(this.reader);
    return Math.max(0, this.reader.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  }

  async render() {
    this.finishPointer(true);
    const revision = ++this.revision;
    this.renderTask?.cancel();
    this.layerTask?.cancel();
    this.clearSelection();
    this.rendered = false;
    this.sync();
    const available = this.availableWidth() || this.lastWidth;
    if (!available) return;
    this.lastWidth = available;
    const page = await this.pdf.getPage(this.page);
    if (revision !== this.revision) return;
    const scale = Math.min(1.55, available / page.getViewport({ scale: 1 }).width) * this.zoom;
    const viewport = page.getViewport({ scale });
    this.paper.style.width = `${viewport.width}px`;
    this.paper.style.height = `${viewport.height}px`;
    this.paper.style.setProperty('--total-scale-factor', viewport.scale * viewport.userUnit);
    const pixels = Math.min(window.devicePixelRatio || 1, 2.3, Math.sqrt(7500000 / (viewport.width * viewport.height)));
    for (const canvas of [this.canvas, this.ink]) {
      canvas.width = Math.max(1, Math.ceil(viewport.width * pixels));
      canvas.height = Math.max(1, Math.ceil(viewport.height * pixels));
    }
    this.textLayer.replaceChildren();
    this.renderTask = page.render({
      canvasContext: this.canvas.getContext('2d'),
      viewport,
      transform: [pixels, 0, 0, pixels, 0, 0],
    });
    try {
      const [content] = await Promise.all([page.getTextContent(), this.renderTask.promise]);
      if (revision !== this.revision) return;
      this.layerTask = new TextLayer({ textContentSource: content, container: this.textLayer, viewport });
      await this.layerTask.render();
      if (revision !== this.revision) return;
      this.textItems = content.items.filter((item) => typeof item.str === 'string');
      this.textDivs = this.layerTask.textDivs;
      this.rendered = true;
      this.paint();
      this.showStatus('');
      this.sync();
    } catch (error) {
      if (revision === this.revision && !['RenderingCancelledException', 'AbortException'].includes(error.name)) throw error;
    }
  }

  showStatus(message) {
    byId('reader-status').textContent = message;
    byId('reader-status').hidden = !message;
  }

  sync() {
    const canRead = Boolean(this.pdf);
    const { title, sample } = this.book || {};
    if (title) byId('book-title').textContent = title;
    if (canRead) byId('book-meta').textContent = sample ? '讲课台示例' : `本机课本 · ${this.pdf.numPages} 页`;
    byId('page-number').value = this.page;
    byId('page-number').max = this.pdf?.numPages || 1;
    byId('page-number').disabled = !canRead;
    byId('page-total').textContent = `/ ${this.pdf?.numPages || '—'}`;
    byId('prev').disabled = !canRead || this.page <= 1;
    byId('next').disabled = !canRead || this.page >= this.pdf.numPages;
    byId('page-quote').disabled = !this.rendered;
    byId('zoom-reset').textContent = `${Math.round(this.zoom * 100)}%`;
    byId('zoom-out').disabled = !canRead || this.zoom <= .75;
    byId('zoom-in').disabled = !canRead || this.zoom >= 2.5;
    byId('use-selection').disabled = !this.rendered || this.recognizing;
    const history = this.getHistory();
    byId('undo').disabled = !history.undo.length;
    byId('redo').disabled = !history.redo.length;
    this.onChange();
  }

  async setPage(number) {
    if (!this.pdf) return;
    const target = clamp(Math.trunc(number) || this.page, 1, this.pdf.numPages);
    if (target === this.page) {
      byId('page-number').value = this.page;
      return;
    }
    this.finishPointer(true);
    this.page = target;
    this.reader.scrollTop = this.reader.scrollLeft = 0;
    this.persist();
    await this.render();
  }

  setZoom(value) {
    if (!this.pdf) return;
    this.zoom = clamp(value, .75, 2.5);
    this.render().catch(this.onError);
  }

  setTool(tool) {
    this.finishPointer(true);
    this.tool = tool;
    this.paper.dataset.tool = tool;
    this.clearSelection();
    for (const button of byId('modes').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === (tool === 'native' ? 'select' : tool)));
    }
    const selecting = tool === 'select' || tool === 'native';
    byId('selection-bar').hidden = !selecting;
    byId('native-select').textContent = tool === 'native' ? '返回框选' : '系统选区';
    byId('selection-note').textContent = tool === 'native' ? '长按或拖动选择文字，再点引用选文。' : scanMessage;
    if (this.colorByTool[tool]) byId('ink-color').value = this.colorByTool[tool];
  }

  clearSelection() {
    this.bounds = null;
    this.rect.hidden = true;
    const selection = window.getSelection();
    if (selection?.anchorNode && this.textLayer.contains(selection.anchorNode)) selection.removeAllRanges();
    if (this.tool === 'select') byId('selection-note').textContent = scanMessage;
  }

  point(event) {
    const box = this.ink.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
      pressure: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : .5,
    };
  }

  pointerDown(event) {
    if (!this.rendered || this.pointer || event.button !== 0) return;
    const p = this.point(event);
    const isPan = event.pointerType === 'touch' && this.tool !== 'select' && !this.fingerInk;
    this.pointer = {
      id: event.pointerId, tool: isPan ? 'pan' : this.tool,
      initial: p, x: event.clientX, y: event.clientY, before: this.currentStrokes,
    };
    this.ink.setPointerCapture(event.pointerId);
    if (this.pointer.tool === 'select') this.setBounds(p, p);
    if (this.pointer.tool === 'eraser') this.erase(p);
    if (['pen', 'marker'].includes(this.pointer.tool)) {
      this.draft = {
        tool: this.tool,
        color: this.colorByTool[this.tool],
        size: Number(byId('ink-size').value) * (this.tool === 'marker' ? 3.5 : 1),
        points: [p],
      };
      this.paint();
    }
    event.preventDefault();
  }

  pointerMove(event) {
    const active = this.pointer;
    if (active?.id !== event.pointerId) return;
    if (active.tool === 'pan') {
      this.reader.scrollBy(active.x - event.clientX, active.y - event.clientY);
      active.x = event.clientX;
      active.y = event.clientY;
      return;
    }
    if (active.tool === 'select') this.setBounds(active.initial, this.point(event));
    if (active.tool === 'eraser') this.erase(this.point(event));
    if (this.draft) {
      const samples = event.getCoalescedEvents?.() || [];
      for (const sample of samples.length ? samples : [event]) this.draft.points.push(this.point(sample));
      this.paint();
    }
  }

  pointerEnd(event, cancelled = false) {
    if (this.pointer?.id !== event.pointerId) return;
    if (!cancelled && this.pointer.tool === 'select') this.setBounds(this.pointer.initial, this.point(event));
    this.finishPointer(cancelled);
  }

  finishPointer(cancelled) {
    const active = this.pointer;
    if (!active) return;
    this.pointer = null;
    if (this.ink.hasPointerCapture(active.id)) this.ink.releasePointerCapture(active.id);
    if (active.tool === 'select' && cancelled) this.clearSelection();
    if (cancelled) this.pages[this.page] = active.before;
    else if (this.draft) this.pages[this.page] = [...active.before, this.draft];
    this.draft = null;
    if (this.currentStrokes !== active.before && !cancelled) {
      const history = this.getHistory();
      history.undo.push(active.before);
      if (history.undo.length > 60) history.undo.shift();
      history.redo.length = 0;
      this.persist();
    }
    this.paint();
    this.sync();
  }

  setBounds(a, b) {
    const { style } = this.rect;
    const bounds = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    this.bounds = bounds;
    for (const [property, field] of [['left', 'x'], ['top', 'y'], ['width', 'w'], ['height', 'h']]) {
      style[property] = `${bounds[field] * 100}%`;
    }
    this.rect.hidden = false;
    byId('selection-note').textContent = '选区已标记，点引用选文加入右侧。';
  }

  get currentStrokes() {
    return this.pages[this.page] || EMPTY;
  }

  getHistory() {
    if (!this.history.has(this.page)) this.history.set(this.page, { undo: [], redo: [] });
    return this.history.get(this.page);
  }

  erase(point) {
    const updated = eraseAt(this.currentStrokes, point, this.ink.clientWidth, this.ink.clientHeight);
    if (updated.length !== this.currentStrokes.length) {
      this.pages[this.page] = updated;
      this.paint();
    }
  }

  travelHistory(from, to) {
    this.finishPointer(true);
    const history = this.getHistory();
    if (!history[from].length) return;
    history[to].push(this.currentStrokes);
    this.pages[this.page] = history[from].pop();
    this.persist();
    this.paint();
    this.sync();
  }

  paint() {
    paintStrokes(this.ink, this.currentStrokes, this.zoom, this.draft);
  }

  persist() {
    saveState(`reader:${this.book.id}`, { page: this.page, pages: { ...this.pages } })
      .catch(() => this.notify('本机存储写入失败，本次批注可能无法保留。'));
  }

  getReference(text, method) {
    return { book: this.book.title, page: this.page, text, method };
  }

  async quotePage() {
    if (!this.rendered) throw new Error('请等课本页面显示后再引用。');
    const text = joinText(this.textItems);
    return text ? this.getReference(text, '整页') : this.runOcr({ x: 0, y: 0, w: 1, h: 1 });
  }

  async quoteSelection() {
    if (this.tool === 'native') {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || !this.textLayer.contains(selection.anchorNode) || !this.textLayer.contains(selection.focusNode)) {
        this.notify('请先长按或拖动选中课本文字。');
        return;
      }
      this.onQuote(this.getReference(text, '选文'));
      this.clearSelection();
      return;
    }
    if (!this.bounds || this.bounds.w * this.ink.clientWidth < 5 || this.bounds.h * this.ink.clientHeight < 5) {
      this.notify('请在课本上拖动框选一段文字。');
      return;
    }
    const box = this.rect.getBoundingClientRect();
    const text = joinText(this.textItems
      .map((item, index) => ({ str: getSpanText(this.textDivs[index], box), hasEOL: item.hasEOL }))
      .filter(({ str }) => str));
    if (!text && this.textItems.some(({ str }) => str.trim())) {
      this.notify('框内没有文字层内容，可调整选区。正在尝试识字。');
    }
    this.onQuote(text ? this.getReference(text, '选文') : await this.runOcr(this.bounds));
    this.clearSelection();
  }

  async runOcr(bounds) {
    if (this.recognizing) throw new Error('正在识字，请稍候。');
    const revision = this.revision;
    this.recognizing = true;
    this.sync();
    try {
      const { recognizeRegion } = await import('./ocr.js');
      if (revision !== this.revision) throw new Error('页面已改变，请重新识字。');
      const text = await recognizeRegion(this.canvas, bounds, (message) => this.showStatus(message));
      if (revision !== this.revision) throw new Error('页面已改变，请重新识字。');
      if (!text) throw new Error('没有识别到文字，请放大后重试。');
      return this.getReference(text, 'OCR');
    } finally {
      this.recognizing = false;
      this.showStatus('');
      this.sync();
    }
  }
}

const EMPTY = Object.freeze([]);
