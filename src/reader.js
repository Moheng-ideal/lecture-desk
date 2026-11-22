import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { mixPoint, paintStrokes } from './ink.js';
import { InkTools } from './ink-tools.js';
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
    this.stack = byId('page-stack');
    this.surfaces = [];
    this.nearby = new Set();
    this.surfacesByElement = new WeakMap();
    this.pageObserver = new IntersectionObserver((entries) => this.observePages(entries), {
      root: this.reader, rootMargin: '85% 0px',
    });
    this.zoom = 1;
    this.tool = 'read';
    this.page = 1;
    this.pages = {};
    this.history = new Map();
    this.bookHistories = new Map();
    this.revision = 0;
    this.openRevision = 0;
    this.inkTools = new InkTools(this);
    this.setTool('read');

    byId('modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tool]');
      if (!button) return;
      const tool = button.dataset.tool;
      const open = this.inkTools.panel.hidden || tool !== this.tool;
      this.setTool(tool);
      this.inkTools.toggle(open && ['pen', 'marker', 'eraser'].includes(tool));
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
    this.stack.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.stack.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.stack.addEventListener('pointerup', (event) => this.pointerEnd(event));
    this.stack.addEventListener('pointercancel', (event) => this.pointerEnd(event, true));
    this.stack.addEventListener('lostpointercapture', (event) => this.pointerEnd(event, true));
    document.addEventListener('selectionchange', () => {
      if (this.tool !== 'native') return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const paper = selection.anchorNode?.parentElement?.closest('.page-slot');
      if (paper && paper === selection.focusNode?.parentElement?.closest('.page-slot')) {
        this.selectPage(this.surfacesByElement.get(paper), false);
      }
    });
    this.reader.addEventListener('scroll', () => {
      if (!this.restoring && this.book) this.queuePositionSave();
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.pageAtScroll();
      });
    }, { passive: true });
    let resize;
    new ResizeObserver(() => {
      clearTimeout(resize);
      resize = setTimeout(() => {
        const width = this.availableWidth();
        if (this.pdf && width > 0 && Math.abs(width - this.lastWidth) > 1) this.reflow();
      }, 140);
    }).observe(this.reader);
    this.sync();
  }

  get currentSurface() { return this.surfaces[this.page - 1]; }
  get rendered() { return this.currentSurface?.rendered; }
  get canvas() { return this.currentSurface?.canvas; }
  get ink() { return this.currentSurface?.ink; }
  get textLayer() { return this.currentSurface?.textLayer; }
  get rect() { return this.currentSurface?.rect; }
  get textItems() { return this.currentSurface?.textItems || []; }
  get textDivs() { return this.currentSurface?.textDivs || []; }

  get fingerInk() { return this.reader.dataset.fingerInk === 'true'; }
  set fingerInk(value) { this.reader.dataset.fingerInk = String(Boolean(value)); }

  async open(book) {
    this.stopGlide();
    if (this.pan) this.endPan();
    if (this.book) {
      clearTimeout(this.scrollSave);
      this.persistPosition();
    }
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
      const [prior, position, first] = await Promise.all([
        readState(`reader:${book.id}`).catch(() => null),
        readState(`reader-position:${book.id}`).catch(() => null),
        pdf.getPage(1),
      ]);
      if (revision !== this.openRevision) {
        await task.destroy();
        return false;
      }
      this.finishPointer(true);
      this.clearSelection();
      this.pageObserver.disconnect();
      for (const surface of this.surfaces) this.releaseSurface(surface);
      this.nearby.clear();
      this.pdf?.destroy().catch(() => {});
      this.revision++;
      this.pdf = pdf;
      this.book = book;
      this.pages = prior?.pages || {};
      const view = position || prior;
      this.savedOffset = Number(view?.offset) || 0;
      this.zoom = clamp(Number(view?.zoom) || 1, .75, 2.5);
      this.page = clamp(view?.page || 1, 1, pdf.numPages);
      if (!this.bookHistories.has(book.id)) this.bookHistories.set(book.id, new Map());
      this.history = this.bookHistories.get(book.id);
      const fallback = first.getViewport({ scale: 1 });
      this.lastWidth = this.availableWidth() || this.lastWidth || 560;
      const list = document.createDocumentFragment();
      this.surfaces = Array.from({ length: pdf.numPages }, (_, i) => {
        const paper = document.createElement('div');
        paper.className = 'page-slot';
        const surface = { pdf, number: i + 1, paper, viewport: fallback, generation: 0 };
        this.surfacesByElement.set(paper, surface);
        this.sizeSurface(surface);
        list.append(paper);
        return surface;
      });
      this.stack.replaceChildren(list);
      this.restoring = true;
      for (const surface of this.surfaces) this.pageObserver.observe(surface.paper);
      const surface = this.currentSurface;
      this.scrollToPage(surface, view?.offset);
      this.sync();
      await this.render(surface);
      if (revision === this.openRevision) this.scrollToPage(surface, view?.offset);
      return revision === this.openRevision;
    } catch (error) {
      if (revision !== this.openRevision) return false;
      task.destroy().catch(() => {});
      this.showStatus(this.pdf ? '' : '打开失败，请尝试另一份 PDF。');
      throw new Error(`无法打开课本。 ${error.message || ''}`);
    } finally {
      if (revision === this.openRevision) this.restoring = false;
      if (this.loading === task) this.loading = null;
    }
  }

  availableWidth() {
    const style = getComputedStyle(this.reader);
    return Math.max(0, this.reader.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  }

  sizeSurface(surface) {
    const { width, height } = surface.viewport;
    const scale = Math.min(1.55, this.lastWidth / width) * this.zoom;
    surface.paper.style.width = `${width * scale}px`;
    surface.paper.style.height = `${height * scale}px`;
    return scale;
  }

  scrollToPage(surface, offset = 0) {
    const padding = parseFloat(getComputedStyle(this.reader).paddingTop);
    this.reader.scrollTop = surface.paper.offsetTop - padding + (Number(offset) || 0) * surface.paper.offsetHeight;
  }

  selectPage(surface, clear = true) {
    if (!surface || surface === this.currentSurface) return;
    if (clear) this.clearSelection();
    this.page = surface.number;
    this.revision++;
    this.queuePositionSave();
    this.sync();
  }

  pageAtScroll() {
    if (this.restoring || this.pointer || !this.pdf || (this.tool === 'native' && !window.getSelection()?.isCollapsed)) return;
    const reader = this.reader.getBoundingClientRect();
    const focus = reader.top + Math.min(120, reader.height * .22);
    let best;
    let distance = Infinity;
    for (const surface of this.nearby) {
      const { top, bottom } = surface.paper.getBoundingClientRect();
      if (bottom <= reader.top || top >= reader.bottom) continue;
      const delta = Math.max(top - focus, focus - bottom, 0);
      if (delta < distance) {
        best = surface;
        distance = delta;
      }
    }
    this.selectPage(best);
  }

  observePages(entries) {
    let releasedCurrent = false;
    for (const entry of entries) {
      const surface = this.surfacesByElement.get(entry.target);
      if (!surface || surface.pdf !== this.pdf) continue;
      if (entry.isIntersecting) {
        this.nearby.add(surface);
        this.render(surface).catch(this.onError);
      } else {
        this.nearby.delete(surface);
        if (surface === this.currentSurface && surface.rendered) {
          this.finishPointer(true);
          releasedCurrent = true;
        }
        this.releaseSurface(surface);
      }
    }
    this.pageAtScroll();
    if (releasedCurrent) this.sync();
  }

  releaseSurface(surface) {
    if (!surface.canvas && !surface.pending) return;
    surface.generation++;
    surface.renderTask?.cancel();
    surface.layerTask?.cancel();
    for (const canvas of [surface.canvas, surface.ink]) {
      if (canvas) canvas.width = canvas.height = 0;
    }
    surface.paper.replaceChildren();
    Object.assign(surface, {
      canvas: null, ink: null, textLayer: null, rect: null, textItems: null, textDivs: null,
      renderTask: null, layerTask: null, textPending: null, displayViewport: null, pending: null, rendered: false,
    });
  }

  reflow() {
    const width = this.availableWidth();
    if (!width || !this.currentSurface) return;
    this.finishPointer(true);
    this.clearSelection();
    this.revision++;
    const anchor = this.currentSurface.paper;
    const offset = (this.reader.scrollTop - anchor.offsetTop) / anchor.offsetHeight;
    this.lastWidth = width;
    for (const surface of this.surfaces) this.sizeSurface(surface);
    this.reader.scrollTop = anchor.offsetTop + offset * anchor.offsetHeight;
    for (const surface of new Set([this.currentSurface, ...this.nearby])) {
      this.releaseSurface(surface);
      this.render(surface).catch(this.onError);
    }
    this.sync();
  }

  render(surface) {
    if (surface.rendered) return Promise.resolve();
    if (!surface.pending) {
      const generation = ++surface.generation;
      surface.pending = this.drawSurface(surface, generation).finally(() => {
        if (surface.generation === generation) surface.pending = null;
      });
    }
    return surface.pending;
  }

  async drawSurface(surface, generation) {
    const stillCurrent = () => surface.generation === generation && surface.pdf === this.pdf;
    try {
      const page = await surface.pdf.getPage(surface.number);
      if (!stillCurrent()) return;
      surface.viewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: this.sizeSurface(surface) });
      const contents = byId('page-template').content.firstElementChild.cloneNode(true);
      const [canvas, textLayer, ink, rect] = contents.children;
      surface.paper.setAttribute('aria-label', `第 ${surface.number} 页`);
      surface.paper.replaceChildren(contents);
      Object.assign(surface, { canvas, textLayer, ink, rect, displayViewport: viewport });
      contents.style.setProperty('--total-scale-factor', viewport.scale * viewport.userUnit);
      const pixels = Math.min(window.devicePixelRatio || 1, 2.3, Math.sqrt(5000000 / (viewport.width * viewport.height)));
      for (const layer of [canvas, ink]) {
        layer.width = Math.max(1, Math.ceil(viewport.width * pixels));
        layer.height = Math.max(1, Math.ceil(viewport.height * pixels));
      }
      surface.renderTask = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: [pixels, 0, 0, pixels, 0, 0],
      });
      await surface.renderTask.promise;
      if (!stillCurrent()) return;
      surface.rendered = true;
      this.paint(surface);
      if (this.tool === 'native') this.ensureTextLayer(surface).catch(this.onError);
      if (surface === this.currentSurface) {
        this.showStatus('');
        this.sync();
      }
    } catch (error) {
      if (stillCurrent() && !['RenderingCancelledException', 'AbortException'].includes(error.name)) throw error;
    }
  }

  ensureTextLayer(surface) {
    if (surface.textItems) return Promise.resolve(true);
    if (surface.textPending) return surface.textPending;
    const generation = surface.generation;
    const current = () => surface.generation === generation && surface.pdf === this.pdf;
    surface.textPending = (async () => {
      try {
        const page = await surface.pdf.getPage(surface.number);
        const content = await page.getTextContent();
        if (!current()) return false;
        surface.textLayer.replaceChildren();
        surface.layerTask = new TextLayer({
          textContentSource: content, container: surface.textLayer, viewport: surface.displayViewport,
        });
        await surface.layerTask.render();
        if (!current()) return false;
        surface.textItems = content.items.filter((item) => typeof item.str === 'string');
        surface.textDivs = surface.layerTask.textDivs;
        return true;
      } catch (error) {
        if (current()) throw error;
        return false;
      } finally {
        if (current()) surface.textPending = null;
      }
    })();
    return surface.textPending;
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
    byId('pdf-export').disabled = !canRead;
    byId('page-total').textContent = `/ ${this.pdf?.numPages || '—'}`;
    byId('prev').disabled = !canRead || this.page <= 1;
    byId('next').disabled = !canRead || this.page >= this.pdf.numPages;
    byId('page-quote').disabled = !this.rendered;
    byId('zoom-reset').textContent = `${Math.round(this.zoom * 100)}%`;
    byId('zoom-out').disabled = !canRead || this.zoom <= .75;
    byId('zoom-in').disabled = !canRead || this.zoom >= 2.5;
    byId('use-selection').disabled = !this.rendered || this.recognizing;
    const history = this.history.get(this.page);
    byId('undo').disabled = !history?.undo.length;
    byId('redo').disabled = !history?.redo.length;
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
    const surface = this.surfaces[target - 1];
    this.selectPage(surface);
    this.scrollToPage(surface);
    await this.render(surface);
  }

  setZoom(value) {
    if (!this.pdf) return;
    this.zoom = clamp(value, .75, 2.5);
    this.reflow();
    this.persistPosition();
  }

  setTool(tool) {
    this.stopGlide();
    if (this.pan) this.endPan();
    this.finishPointer(true);
    this.tool = tool;
    if (this.tool === 'pen' || this.tool === 'marker') this.lastPen = this.tool;
    this.reader.dataset.tool = tool;
    this.clearSelection();
    for (const button of byId('modes').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === (tool === 'native' ? 'select' : tool)));
    }
    const selecting = tool === 'select' || tool === 'native';
    byId('selection-bar').hidden = !selecting;
    byId('native-select').textContent = tool === 'native' ? '返回框选' : '系统选区';
    byId('selection-note').textContent = tool === 'native' ? '长按或拖动选择文字，再点引用选文。' : scanMessage;
    if (tool === 'native') {
      for (const page of new Set([this.currentSurface, ...this.nearby])) {
        if (page?.rendered) this.ensureTextLayer(page).catch(this.onError);
      }
    }
    this.inkTools.sync();
  }

  clearSelection() {
    this.bounds = null;
    if (this.rect) this.rect.hidden = true;
    const selection = window.getSelection();
    if (selection?.anchorNode && this.stack.contains(selection.anchorNode)) selection.removeAllRanges();
    if (this.tool === 'select') byId('selection-note').textContent = scanMessage;
  }

  point(event, stylus = this.pointer?.stylus, fallback = this.pointer?.last?.pressure || .5) {
    const box = this.ink.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
      pressure: stylus && event.pressure > 0 ? clamp(event.pressure, 0, 1) : fallback,
    };
  }

  pointerDown(event) {
    this.stopGlide();
    if (this.pointer || event.button !== 0) return;
    const canvas = event.target.closest('.ink-canvas');
    if (!canvas) return;
    const touch = event.pointerType === 'touch' || !event.pointerType;
    let nativePressure = -1;
    if (touch) {
      try { nativePressure = window.LectureDeskNative?.penAtContact?.() ?? -1; } catch { /* Browser fallback. */ }
    }
    const stylus = event.pointerType === 'pen' || nativePressure >= 0;
    if (touch && !stylus && !this.fingerInk) {
      if (!this.pan) {
        this.pan = { id: event.pointerId, x: event.clientX, y: event.clientY,
          time: event.timeStamp, dx: 0, dy: 0, vx: 0, vy: 0, frame: null };
        this.stack.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
      return;
    }
    if (this.pan) this.endPan();
    const surface = this.surfacesByElement.get(canvas.closest('.page-slot'));
    if (!surface?.rendered) return;
    this.selectPage(surface);
    const p = this.point(event, stylus);
    if (nativePressure > 0) p.pressure = nativePressure;
    this.pointer = {
      id: event.pointerId, tool: this.tool, stylus,
      initial: p, last: p, before: this.currentStrokes, path: [p],
    };
    this.ink.setPointerCapture(event.pointerId);
    if (this.pointer.tool === 'select') this.setBounds(p, p);
    if (this.pointer.tool === 'eraser') this.erase(p);
    if (['pen', 'marker'].includes(this.pointer.tool)) {
      this.draft = this.inkTools.stroke([p], this.ink.clientWidth / this.zoom);
      this.paint();
    }
    event.preventDefault();
  }

  pointerMove(event) {
    const pan = this.pan;
    if (pan?.id === event.pointerId) {
      const dx = pan.x - event.clientX;
      const dy = pan.y - event.clientY;
      const interval = Math.max(10, event.timeStamp - pan.time);
      const weight = 1 - Math.exp(-interval / 26);
      pan.dx += dx;
      pan.dy += dy;
      Object.assign(pan, {
        x: event.clientX, y: event.clientY, time: event.timeStamp,
        vx: pan.vx + (clamp(dx / interval, -3.5, 3.5) - pan.vx) * weight,
        vy: pan.vy + (clamp(dy / interval, -3.5, 3.5) - pan.vy) * weight,
      });
      if (pan.frame === null) {
        pan.frame = requestAnimationFrame(() => {
          pan.frame = null;
          this.flushPan(pan);
        });
      }
      return;
    }
    const active = this.pointer;
    if (active?.id !== event.pointerId) return;
    if (active.tool === 'select') this.setBounds(active.initial, this.point(event));
    const samples = event.getCoalescedEvents?.() || [];
    const points = (samples.length ? samples : [event]).map((sample) => this.point(sample));
    if (active.tool === 'eraser') {
      for (const point of points) this.erase(point, false);
      this.paint();
    }
    if (this.draft) {
      this.draft.points.push(...points);
      active.last = points.at(-1);
      this.paint();
    }
  }

  pointerEnd(event, cancelled = false) {
    if (this.pan?.id === event.pointerId) {
      this.endPan(!cancelled && event.timeStamp - this.pan.time < 85);
      return;
    }
    if (this.pointer?.id !== event.pointerId) return;
    if (!cancelled && this.draft) {
      const point = this.point(event);
      const last = this.draft.points.at(-1);
      if (point.x !== last.x || point.y !== last.y) this.draft.points.push(point);
    }
    if (!cancelled && this.pointer.tool === 'select') this.setBounds(this.pointer.initial, this.point(event));
    if (!cancelled && this.pointer.tool === 'eraser') {
      this.erase(this.point(event), false);
      if (this.inkTools.eraser.mode === 'lasso') {
        this.pages[this.page] = this.inkTools.erase(this.currentStrokes, this.pointer.path,
          this.pointer.last, this.ink.clientWidth, this.ink.clientHeight, this.zoom, this.pointer.stylus);
      }
    }
    this.finishPointer(cancelled);
  }

  endPan(coast = false) {
    const pan = this.pan;
    this.pan = null;
    if (pan.frame !== null) cancelAnimationFrame(pan.frame);
    this.flushPan(pan);
    if (this.stack.hasPointerCapture(pan.id)) this.stack.releasePointerCapture(pan.id);
    if (!coast || Math.hypot(pan.vx, pan.vy) < .16) return;
    let last = performance.now();
    let x = this.reader.scrollLeft;
    let y = this.reader.scrollTop;
    const maxX = this.reader.scrollWidth - this.reader.clientWidth;
    const maxY = this.reader.scrollHeight - this.reader.clientHeight;
    const frame = (time) => {
      const interval = clamp(time - last, 0, 32);
      last = time;
      const friction = Math.exp(-interval / 170);
      x = clamp(x + pan.vx * 170 * (1 - friction), 0, maxX);
      y = clamp(y + pan.vy * 170 * (1 - friction), 0, maxY);
      pan.vx *= friction;
      pan.vy *= friction;
      if ((x === 0 && pan.vx < 0) || (x === maxX && pan.vx > 0)) pan.vx = 0;
      if ((y === 0 && pan.vy < 0) || (y === maxY && pan.vy > 0)) pan.vy = 0;
      this.reader.scrollTo(x, y);
      this.glide = Math.hypot(pan.vx, pan.vy) > .04 ? requestAnimationFrame(frame) : null;
    };
    this.glide = requestAnimationFrame(frame);
  }

  flushPan(pan) {
    if (pan.dx || pan.dy) this.reader.scrollBy(pan.dx, pan.dy);
    pan.dx = pan.dy = 0;
  }

  stopGlide() {
    if (this.glide) cancelAnimationFrame(this.glide);
    this.glide = null;
  }

  finishPointer(cancelled) {
    const active = this.pointer;
    if (!active) return;
    this.pointer = null;
    if (this.ink?.hasPointerCapture(active.id)) this.ink.releasePointerCapture(active.id);
    if (active.tool === 'select' && cancelled) this.clearSelection();
    if (cancelled) this.pages[this.page] = active.before;
    else if (this.draft) this.pages[this.page] = [...active.before, this.draft];
    this.draft = null;
    if (this.currentStrokes !== active.before && !cancelled) this.remember(active.before);
    if (!cancelled && active.tool === 'eraser' && this.inkTools.eraser.returnToPen) this.setTool(this.lastPen || 'pen');
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

  discardHistory(bookId) {
    if (bookId !== this.book?.id) this.bookHistories.delete(bookId);
  }

  erase(point, repaint = true) {
    const active = this.pointer;
    const { mode } = this.inkTools.eraser;
    if (mode === 'lasso') {
      if (active.last.x !== point.x || active.last.y !== point.y) active.path.push(point);
    } else {
      const { clientWidth: width, clientHeight: height } = this.ink;
      const distance = Math.hypot((point.x - active.last.x) * width, (point.y - active.last.y) * height);
      const radius = Math.min(this.inkTools.radius(active.last, active.stylus), this.inkTools.radius(point, active.stylus));
      const steps = Math.max(1, Math.ceil(distance / Math.max(2, radius * .6)));
      let strokes = this.currentStrokes;
      for (let i = 1; i <= steps && strokes.length; i++) {
        const p = mixPoint(active.last, point, i / steps);
        strokes = this.inkTools.erase(strokes, active.path, p, width, height, this.zoom, active.stylus);
      }
      if (strokes !== this.currentStrokes) this.pages[this.page] = strokes;
    }
    active.last = point;
    if (repaint) this.paint();
  }

  remember(before) {
    const history = this.getHistory();
    history.undo.push(before);
    if (history.undo.length > 60) history.undo.shift();
    history.redo.length = 0;
    this.persist();
  }

  clearPageInk() {
    if (!this.currentStrokes.length) return;
    this.finishPointer(true);
    const before = this.currentStrokes;
    this.pages[this.page] = [];
    this.remember(before);
    this.paint();
    this.sync();
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

  paint(surface = this.currentSurface) {
    if (!surface?.ink) return;
    const current = surface === this.currentSurface;
    paintStrokes(surface.ink, this.pages[surface.number] || EMPTY, this.zoom, current ? this.draft : null);
    const active = current && this.pointer;
    if (active?.tool !== 'eraser') return;
    const canvas = surface.ink;
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / canvas.clientWidth;
    ctx.save();
    ctx.strokeStyle = '#506955';
    ctx.lineWidth = 1.5 * scale;
    ctx.setLineDash([4 * scale, 3 * scale]);
    ctx.beginPath();
    if (this.inkTools.eraser.mode === 'lasso') {
      for (const p of active.path) ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
      ctx.closePath();
    } else {
      const p = active.last;
      ctx.arc(p.x * canvas.width, p.y * canvas.height, this.inkTools.radius(p, active.stylus) * scale, 0, 2 * Math.PI);
    }
    ctx.stroke();
    ctx.restore();
  }

  readingPosition() {
    const anchor = this.currentSurface?.paper;
    const padding = parseFloat(getComputedStyle(this.reader).paddingTop);
    const offset = anchor?.offsetHeight
      ? (this.reader.scrollTop + padding - anchor.offsetTop) / anchor.offsetHeight : this.savedOffset || 0;
    this.savedOffset = offset;
    return { page: this.page, offset, zoom: this.zoom };
  }

  queuePositionSave() {
    clearTimeout(this.scrollSave);
    this.scrollSave = setTimeout(() => this.persistPosition(), 320);
  }

  persistPosition() {
    if (this.book) saveState(`reader-position:${this.book.id}`, this.readingPosition()).catch(() => {});
  }

  persist() {
    this.persistPosition();
    saveState(`reader:${this.book.id}`, { page: this.page, offset: this.savedOffset, zoom: this.zoom, pages: { ...this.pages } })
      .catch(() => this.notify('本机存储写入失败，本次批注可能无法保留。'));
  }

  getReference(text, method) {
    return { book: this.book.title, page: this.page, text, method };
  }

  async quotePage() {
    if (!this.rendered) throw new Error('请等课本页面显示后再引用。');
    const revision = this.revision;
    if (!await this.ensureTextLayer(this.currentSurface) || revision !== this.revision) {
      throw new Error('课本页面已改变，请重新引用。');
    }
    const text = joinText(this.textItems);
    return text ? this.getReference(text, '整页') : this.runOcr({ x: 0, y: 0, w: 1, h: 1 });
  }

  async quoteSelection() {
    if (this.tool === 'native') {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || !this.textLayer?.contains(selection.anchorNode) || !this.textLayer.contains(selection.focusNode)) {
        this.notify('请先长按或拖动选中课本文字。');
        return;
      }
      this.onQuote(this.getReference(text, '选文'));
      this.clearSelection();
      return;
    }
    if (!this.bounds || !this.ink || this.bounds.w * this.ink.clientWidth < 5 || this.bounds.h * this.ink.clientHeight < 5) {
      this.notify('请在课本上拖动框选一段文字。');
      return;
    }
    const revision = this.revision;
    const bounds = this.bounds;
    if (!await this.ensureTextLayer(this.currentSurface) || revision !== this.revision || this.bounds !== bounds) {
      throw new Error('课本选区已改变，请重新引用。');
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
