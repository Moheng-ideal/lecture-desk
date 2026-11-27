import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { inkContact, mixPoint, paintStrokes, traceInk } from './ink.js';
import { InkTools } from './ink-tools.js';
import { readState, saveState } from './storage.js';
import { formats } from './book-format.js';
import { IMAGE_LIMIT, isExcerptImage } from './excerpts.js';

GlobalWorkerOptions.workerSrc = pdfWorker;
const byId = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const scanMessage = '课本或右侧问答区都可以拖动框选：课本生成截图，问答区生成文字摘录。';
const zoomMin = .75;
const zoomMax = 2.5;

function midpoint([a, b]) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
}

export class Reader {
  constructor({ quote, notify, change, error, tool }) {
    this.onQuote = quote;
    this.notify = notify;
    this.onChange = change;
    this.onError = error;
    this.onTool = tool;
    this.reader = byId('reader');
    this.stage = byId('page-stage');
    this.stack = byId('page-stack');
    this.surfaces = [];
    this.nearby = new Set();
    this.renderQueue = new Map();
    this.surfacesByElement = new WeakMap();
    this.pageObserver = new IntersectionObserver((entries) => this.observePages(entries), {
      root: this.reader, rootMargin: '115% 0px',
    });
    this.zoom = 1;
    this.tool = 'read';
    this.page = 1;
    this.pages = {};
    this.history = new Map();
    this.bookHistories = new Map();
    this.openRevision = 0;
    this.inkTools = new InkTools(this, {
      host: byId('pdf-tools').parentElement, button: byId('ink-config'), modes: byId('modes'),
      clear: () => this.clearPageInk(),
    });
    this.setTool('read');

    byId('modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tool]');
      if (!button) return;
      this.inkTools.select(button.dataset.tool);
    });
    byId('use-selection').onclick = () => this.quoteSelection().catch(this.onError);
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
    this.reader.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.reader.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.reader.addEventListener('pointerup', (event) => this.pointerEnd(event));
    this.reader.addEventListener('pointercancel', (event) => this.pointerEnd(event, true));
    this.reader.addEventListener('lostpointercapture', (event) => this.pointerEnd(event, true));
    this.reader.addEventListener('touchstart', (event) => this.touchStart(event), { passive: false });
    this.reader.addEventListener('touchmove', (event) => this.touchMove(event), { passive: true });
    this.reader.addEventListener('touchend', (event) => this.touchEnd(event), { passive: true });
    this.reader.addEventListener('touchcancel', (event) => this.touchEnd(event), { passive: true });
    this.reader.addEventListener('scroll', () => {
      if (this.pinch || this.restoring || !this.book) return;
      this.queuePositionSave();
      if (this.scrollUpdate) return;
      this.scrollUpdate = setTimeout(() => {
        this.scrollUpdate = null;
        this.pageAtScroll();
      }, 70);
    }, { passive: true });
    let resize;
    new ResizeObserver(() => {
      clearTimeout(resize);
      resize = setTimeout(() => {
        const width = this.availableWidth();
        if (this.documentSource && !this.pinch && width > 0 && Math.abs(width - this.lastWidth) > 1) this.reflow();
      }, 140);
    }).observe(this.reader);
    this.sync();
  }

  get currentSurface() { return this.surfaces[this.page - 1]; }
  get rendered() { return this.currentSurface?.rendered; }
  get ink() { return this.currentSurface?.ink; }
  get rect() { return this.currentSurface?.rect; }
  get fingerInk() { return this.reader.dataset.fingerInk === 'true'; }
  set fingerInk(value) { this.reader.dataset.fingerInk = String(Boolean(value)); }

  async open(book) {
    if (this.pinch) this.endPinch();
    if (this.book) {
      clearTimeout(this.scrollSave);
      this.persistPosition();
    }
    const revision = ++this.openRevision;
    this.loading?.destroy().catch(() => {});
    const extension = book.extension || 'pdf';
    this.showStatus(extension === 'pdf' ? '正在打开课本…' : `正在本机打开 ${formats[extension]} 课件…`);
    let task;
    try {
      if (extension === 'pdf') {
        const source = book.file ? { data: await book.file.arrayBuffer() } : { url: '/sample.pdf' };
        if (revision !== this.openRevision) return false;
        task = getDocument({ cMapUrl: '/pdf/cmaps/', cMapPacked: true,
          standardFontDataUrl: '/pdf/fonts/', wasmUrl: '/pdf/wasm/', isEvalSupported: false, ...source });
        task.onPassword = (update, reason) => {
          const password = window.prompt(reason === 2 ? '密码错误，请重新输入 PDF 密码' : '请输入此 PDF 的密码');
          if (password) update(password);
          else task.destroy().catch(() => {});
        };
      } else {
        const { openOffice } = await import('./office.js');
        if (revision !== this.openRevision) return false;
        task = openOffice(book.file, extension);
      }
      this.loading = task;
      const documentSource = await task.promise;
      const [prior, position, first] = await Promise.all([
        readState(`reader:${book.id}`).catch(() => null),
        readState(`reader-position:${book.id}`).catch(() => null),
        documentSource.getPage(1),
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
      this.documentSource?.destroy().catch(() => {});
      this.documentSource = documentSource;
      this.book = book;
      this.pages = prior?.pages || {};
      const view = position || prior;
      this.savedOffset = Number(view?.offset) || 0;
      this.zoom = clamp(Number(view?.zoom) || 1, zoomMin, zoomMax);
      this.page = clamp(view?.page || 1, 1, documentSource.numPages);
      if (!this.bookHistories.has(book.id)) this.bookHistories.set(book.id, new Map());
      this.history = this.bookHistories.get(book.id);
      const fallback = first.getViewport({ scale: 1 });
      this.lastWidth = this.availableWidth() || this.lastWidth || 560;
      const list = document.createDocumentFragment();
      this.surfaces = Array.from({ length: documentSource.numPages }, (_, i) => {
        const paper = document.createElement('div');
        paper.className = 'page-slot';
        const surface = { source: documentSource, number: i + 1, paper, viewport: fallback, generation: 0 };
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
      this.reader.scrollLeft = Number(view?.left) || 0;
      this.sync();
      await this.render(surface, true);
      if (revision === this.openRevision) this.scrollToPage(surface, view?.offset);
      return revision === this.openRevision;
    } catch (error) {
      if (revision !== this.openRevision) return false;
      task?.destroy().catch(() => {});
      this.showStatus(this.documentSource ? '' : '打开失败，请尝试另一份课件。');
      if (extension !== 'pdf' && !error.message?.includes('文档')) {
        throw new Error(`无法打开此 ${formats[extension]} 文件。可以用 Office 或 WPS 另存为新版格式或 PDF 后再导入。`);
      }
      throw new Error(`无法打开课件。 ${error.message || ''}`);
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
    this.queuePositionSave();
    this.sync();
  }

  pageAtScroll() {
    if (this.restoring || this.pointer || this.pinch || !this.documentSource) return;
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
      if (!surface || surface.source !== this.documentSource) continue;
      if (entry.isIntersecting) {
        this.nearby.add(surface);
        if (!this.pinch) this.render(surface).catch(this.onError);
      } else {
        this.nearby.delete(surface);
        if (this.pinch) {
          this.pinch.departed.add(surface);
          continue;
        }
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
    this.cancelRender(surface);
    for (const canvas of [surface.canvas, surface.ink, surface.overlay]) {
      if (canvas) canvas.width = canvas.height = 0;
    }
    surface.paper.replaceChildren();
    Object.assign(surface, {
      canvas: null, ink: null, overlay: null, rect: null,
      renderTask: null, pending: null,
      rendered: false, needsRefresh: false,
    });
  }

  cancelRender(surface) {
    surface.generation++;
    surface.renderTask?.cancel();
    const queued = this.renderQueue.get(surface);
    if (queued) {
      this.renderQueue.delete(surface);
      queued.resolve();
    }
  }

  captureAnchor(x, y) {
    let target = this.currentSurface;
    let nearest = Infinity;
    for (const surface of this.nearby) {
      const { top, bottom } = surface.paper.getBoundingClientRect();
      const distance = Math.max(top - y, y - bottom, 0);
      if (distance < nearest) {
        target = surface;
        nearest = distance;
      }
    }
    const box = target.paper.getBoundingClientRect();
    return { target, x: (x - box.left) / box.width, y: (y - box.top) / box.height };
  }

  reflow(anchor, focus) {
    const width = this.availableWidth();
    if (!width || !this.currentSurface) return;
    this.finishPointer(true);
    this.clearSelection();
    const reader = this.reader.getBoundingClientRect();
    focus ??= { x: reader.left + reader.width / 2, y: reader.top + Math.min(120, reader.height * .22) };
    anchor ??= this.captureAnchor(focus.x, focus.y);
    this.lastWidth = width;
    for (const surface of this.surfaces) this.sizeSurface(surface);
    const box = anchor.target.paper.getBoundingClientRect();
    this.reader.scrollBy(box.left + anchor.x * box.width - focus.x, box.top + anchor.y * box.height - focus.y);
    for (const surface of new Set([anchor.target, this.currentSurface, ...this.nearby])) {
      if (surface.rendered) {
        // Leave the current bitmap and ink visible while a sharper page is prepared.
        this.cancelRender(surface);
        Object.assign(surface, { renderTask: null, pending: null, needsRefresh: true });
      } else this.releaseSurface(surface);
      this.render(surface).catch(this.onError);
    }
    this.pageAtScroll();
    this.sync();
  }

  render(surface, urgent = false) {
    if (surface.rendered && !surface.needsRefresh) return Promise.resolve();
    if (surface.pending) {
      const queued = this.renderQueue.get(surface);
      if (urgent && queued) queued.urgent = true;
      return surface.pending;
    }
    const generation = ++surface.generation;
    const promise = new Promise((resolve, reject) => {
      this.renderQueue.set(surface, { generation, urgent, resolve, reject });
    });
    surface.pending = promise.finally(() => {
      if (surface.generation === generation) surface.pending = null;
    });
    this.scheduleRender();
    return surface.pending;
  }

  scheduleRender() {
    if (this.renderFrame || this.rendering || this.pinch || !this.renderQueue.size) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      if (this.pinch || !this.renderQueue.size) return;
      const { top, bottom } = this.reader.getBoundingClientRect();
      let next;
      let nearest = Infinity;
      for (const [surface, job] of this.renderQueue) {
        const box = surface.paper.getBoundingClientRect();
        const priority = job.urgent ? -1 : Math.max(box.top - bottom, top - box.bottom, 0);
        if (priority < nearest) {
          next = surface;
          nearest = priority;
        }
      }
      const job = this.renderQueue.get(next);
      this.renderQueue.delete(next);
      this.rendering = true;
      this.drawSurface(next, job.generation).then(job.resolve, job.reject).finally(() => {
        this.rendering = false;
        this.scheduleRender();
      });
    });
  }

  async drawSurface(surface, generation) {
    const stillCurrent = () => surface.generation === generation && surface.source === this.documentSource;
    let buffer;
    let task;
    try {
      const page = await surface.source.getPage(surface.number);
      if (!stillCurrent()) return;
      surface.viewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: this.sizeSurface(surface) });
      if (!surface.canvas) {
        const contents = byId('page-template').content.firstElementChild.cloneNode(true);
        const [canvas, ink, overlay, rect] = contents.children;
        surface.paper.setAttribute('aria-label', `第 ${surface.number} 页`);
        surface.paper.replaceChildren(contents);
        Object.assign(surface, { canvas, ink, overlay, rect });
      }
      // Keep the displayed canvas attached while rendering a new zoom level.
      if (surface.rendered) buffer = document.createElement('canvas');
      const canvas = buffer || surface.canvas;
      const pixels = Math.min(window.devicePixelRatio || 1, 2.3, Math.sqrt(5000000 / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.ceil(viewport.width * pixels));
      canvas.height = Math.max(1, Math.ceil(viewport.height * pixels));
      task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: [pixels, 0, 0, pixels, 0, 0],
      });
      surface.renderTask = task;
      await task.promise;
      if (!stillCurrent()) return;
      if (buffer) {
        const display = surface.canvas;
        display.width = buffer.width;
        display.height = buffer.height;
        display.getContext('2d').drawImage(buffer, 0, 0);
      }
      surface.paper.firstElementChild.style.setProperty('--total-scale-factor', viewport.scale * viewport.userUnit);
      surface.rendered = true;
      surface.needsRefresh = false;
      this.paint(surface);
      if (surface === this.currentSurface) {
        this.showStatus('');
        this.sync();
      }
    } catch (error) {
      if (stillCurrent() && !['RenderingCancelledException', 'AbortException'].includes(error.name)) throw error;
    } finally {
      if (task && surface.renderTask === task) surface.renderTask = null;
      if (buffer) buffer.width = buffer.height = 0;
    }
  }

  showStatus(message) {
    byId('reader-status').textContent = message;
    byId('reader-status').hidden = !message;
  }

  sync() {
    const canRead = Boolean(this.documentSource);
    const { title, sample } = this.book || {};
    if (title) byId('book-title').textContent = title;
    const type = formats[this.book?.extension] || 'PDF';
    byId('book-format').textContent = type;
    if (canRead) byId('book-meta').textContent = sample ? '讲课台示例' : `${type} · ${this.documentSource.numPages} 页`;
    byId('pdf-save-note').textContent = this.documentSource?.office ? '将课件页面和手写批注保存为 PDF。' : '把本书的手写批注一起保存，保留原 PDF 的文字层。';
    byId('page-number').value = this.page;
    byId('page-number').max = this.documentSource?.numPages || 1;
    byId('page-number').disabled = !canRead;
    byId('pdf-export').disabled = !canRead;
    byId('page-total').textContent = `/ ${this.documentSource?.numPages || '—'}`;
    byId('prev').disabled = !canRead || this.page <= 1;
    byId('next').disabled = !canRead || this.page >= this.documentSource.numPages;
    byId('page-quote').disabled = !this.rendered;
    byId('zoom-reset').textContent = `${Math.round(this.zoom * 100)}%`;
    byId('zoom-out').disabled = !canRead || this.zoom <= zoomMin;
    byId('zoom-in').disabled = !canRead || this.zoom >= zoomMax;
    byId('use-selection').disabled = !this.rendered || this.capturing;
    const history = this.history.get(this.page);
    byId('undo').disabled = !history?.undo.length;
    byId('redo').disabled = !history?.redo.length;
    this.onChange();
  }

  async setPage(number) {
    if (!this.documentSource) return;
    if (this.pinch) this.endPinch();
    const target = clamp(Math.trunc(number) || this.page, 1, this.documentSource.numPages);
    if (target === this.page) {
      byId('page-number').value = this.page;
      return;
    }
    this.finishPointer(true);
    const surface = this.surfaces[target - 1];
    this.selectPage(surface);
    this.scrollToPage(surface);
    await this.render(surface, true);
  }

  setZoom(value) {
    if (!this.documentSource) return;
    if (this.pinch) this.endPinch();
    const zoom = clamp(value, zoomMin, zoomMax);
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.reflow();
    this.persistPosition();
  }

  setTool(tool) {
    if (this.pinch) this.endPinch();
    this.finishPointer(true);
    this.tool = tool;
    if (this.tool === 'pen' || this.tool === 'marker') this.lastPen = this.tool;
    this.reader.dataset.tool = tool;
    this.clearSelection();
    for (const button of byId('modes').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    }
    byId('selection-bar').hidden = tool !== 'select';
    this.onTool?.(tool);
    this.inkTools.sync();
  }

  clearSelection() {
    this.bounds = null;
    if (this.rect) this.rect.hidden = true;
    if (this.tool === 'select') byId('selection-note').textContent = scanMessage;
  }

  point(event, box, stylus, fallback = .5) {
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
      pressure: stylus && event.pressure > 0 ? clamp(event.pressure, 0, 1) : fallback,
    };
  }

  pointerDown(event) {
    if (!this.documentSource || this.pointer || this.pinch || this.pinchTail || event.button !== 0) return;
    const canvas = event.target.closest('.ink-canvas');
    if (!canvas) return;
    const { touch, stylus, nativePressure } = inkContact(event);
    if (touch && !stylus && !this.fingerInk && this.tool !== 'select') return;
    const surface = this.surfacesByElement.get(canvas.closest('.page-slot'));
    if (!surface?.rendered) return;
    this.selectPage(surface);
    const box = canvas.getBoundingClientRect();
    const p = this.point(event, box, stylus);
    if (nativePressure > 0) p.pressure = nativePressure;
    this.pointer = {
      id: event.pointerId, tool: this.tool, stylus, box, canvas,
      initial: p, last: p, before: this.currentStrokes, path: [p],
    };
    this.ink.setPointerCapture(event.pointerId);
    if (this.pointer.tool === 'select') this.setBounds(p, p);
    if (this.pointer.tool === 'eraser') this.erase(p);
    if (['pen', 'marker'].includes(this.pointer.tool)) {
      this.draft = this.inkTools.stroke([p], this.ink.clientWidth / this.zoom);
      this.paintPreview();
    }
    event.preventDefault();
  }

  pointerMove(event) {
    const active = this.pointer;
    if (active?.id !== event.pointerId) return;
    const point = (sample) => this.point(sample, active.box, active.stylus, active.last.pressure);
    if (active.tool === 'select') {
      this.setBounds(active.initial, point(event));
      return;
    }
    const samples = event.getCoalescedEvents?.() || [];
    for (const sample of samples.length ? samples : [event]) {
      const p = point(sample);
      if (this.draft) active.last = traceInk(this.draft.points, active.last, p, active.box);
      else this.erase(p, false);
    }
    this.queueInkPaint();
  }

  pointerEnd(event, cancelled = false) {
    if (event.type === 'lostpointercapture' && event.target !== this.pointer?.canvas) return;
    if (this.pointer?.id !== event.pointerId) return;
    const active = this.pointer;
    const p = this.point(event, active.box, active.stylus, active.last.pressure);
    if (!cancelled && this.draft) traceInk(this.draft.points, active.last, p, active.box, true);
    if (!cancelled && active.tool === 'select') this.setBounds(active.initial, p);
    if (!cancelled && active.tool === 'eraser') {
      this.erase(p, false);
      if (this.inkTools.eraser.mode === 'lasso') {
        this.pages[this.page] = this.inkTools.erase(this.currentStrokes, this.pointer.path,
          this.pointer.last, this.ink.clientWidth, this.ink.clientHeight, this.zoom, this.pointer.stylus);
      }
    }
    this.finishPointer(cancelled);
  }

  touchStart(event) {
    if (!this.documentSource) return;
    if (this.pointer?.stylus || this.pinch || this.pinchTail) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (event.touches.length < 2) return;
    const touches = Array.from(event.touches).filter((touch) =>
      this.reader.contains(touch.target) && touch.touchType !== 'stylus');
    if (touches.length < 2) return;
    if (event.cancelable) event.preventDefault();
    this.startPinch(touches.slice(0, 2));
  }

  touchMove(event) {
    const pinch = this.pinch;
    if (!pinch) return;
    const touches = Array.from(event.touches).filter((touch) => pinch.ids.includes(touch.identifier));
    if (touches.length !== 2) return;
    pinch.focus = midpoint(touches.map(({ clientX: x, clientY: y }) => ({ x, y })));
    if (pinch.frame === null) pinch.frame = requestAnimationFrame(() => this.previewPinch());
  }

  touchEnd(event) {
    if (this.pinch && Array.from(event.changedTouches).some((touch) => this.pinch.ids.includes(touch.identifier))) {
      this.endPinch();
    }
    if (this.pinchTail && !Array.from(event.touches).some((touch) => this.reader.contains(touch.target))) {
      this.pinchTail = false;
      requestAnimationFrame(() => {
        if (!this.pinch && !this.pinchTail) delete this.reader.dataset.pinching;
      });
    }
  }

  startPinch(touches) {
    this.finishPointer(true);
    this.clearSelection();
    clearTimeout(this.scrollSave);
    const ids = touches.map((touch) => touch.identifier);
    const focus = midpoint(touches.map(({ clientX: x, clientY: y }) => ({ x, y })));
    const stack = this.stack.getBoundingClientRect();
    const reader = this.reader.getBoundingClientRect();
    const stage = this.stage.getBoundingClientRect();
    this.pinch = {
      ids, initial: focus, focus, anchor: this.captureAnchor(focus.x, focus.y),
      width: stack.width, height: stack.height, viewportWidth: this.availableWidth(),
      x: focus.x - stack.left, y: focus.y - stack.top,
      baseX: stage.left - reader.left + this.reader.scrollLeft,
      baseY: stage.top - reader.top + this.reader.scrollTop,
      zoom: this.zoom, frame: null, departed: new Set(),
    };
    // Freeze unpainted pages until the gesture settles so their sizes cannot shift the content.
    for (const surface of this.nearby) {
      if (!surface.rendered) this.releaseSurface(surface);
    }
    this.stack.style.width = `${stack.width}px`;
    this.stage.dataset.pinching = '';
    // Stop a native drag that started before the second finger reached the reader.
    this.reader.dataset.pinching = '';
    this.previewPinch();
  }

  previewPinch() {
    const pinch = this.pinch;
    pinch.frame = null;
    pinch.zoom = clamp(this.zoom * pinch.focus.distance / pinch.initial.distance, zoomMin, zoomMax);
    const ratio = pinch.zoom / this.zoom;
    const width = pinch.width * ratio;
    const shift = Math.max(0, (pinch.viewportWidth - width) / 2);
    this.stage.style.width = `${Math.max(pinch.viewportWidth, width)}px`;
    this.stage.style.height = `${pinch.height * ratio}px`;
    this.stack.style.transform = `translateX(${shift}px) scale(${ratio})`;
    const reader = this.reader.getBoundingClientRect();
    this.reader.scrollTo(pinch.baseX + shift + pinch.x * ratio + reader.left - pinch.focus.x,
      pinch.baseY + pinch.y * ratio + reader.top - pinch.focus.y);
    byId('zoom-reset').textContent = `${Math.round(pinch.zoom * 100)}%`;
  }

  endPinch() {
    const pinch = this.pinch;
    if (pinch.frame !== null) {
      cancelAnimationFrame(pinch.frame);
      this.previewPinch();
    }
    this.pinch = null;
    this.pinchTail = true;
    delete this.stage.dataset.pinching;
    this.stage.style.removeProperty('width');
    this.stage.style.removeProperty('height');
    this.stack.style.removeProperty('width');
    this.stack.style.removeProperty('transform');
    for (const surface of pinch.departed) {
      if (!this.nearby.has(surface)) this.releaseSurface(surface);
    }
    this.zoom = pinch.zoom;
    this.reflow(pinch.anchor, pinch.focus);
    this.scheduleRender();
    this.persistPosition();
  }

  finishPointer(cancelled) {
    const active = this.pointer;
    if (!active) return;
    this.pointer = null;
    if (this.inkFrame) cancelAnimationFrame(this.inkFrame);
    this.inkFrame = null;
    if (active.canvas.hasPointerCapture(active.id)) active.canvas.releasePointerCapture(active.id);
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
    byId('selection-note').textContent = '选区已标记，点「添加截图」加入本次提问。';
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
    const { canvas, ink } = surface;
    const strokes = this.pages[surface.number] || EMPTY;
    const width = strokes.length ? canvas.width : 1;
    const height = strokes.length ? canvas.height : 1;
    if (ink.width !== width || ink.height !== height) {
      ink.width = width;
      ink.height = height;
    }
    if (strokes.length) paintStrokes(ink, strokes, this.zoom);
    if (surface === this.currentSurface) this.paintPreview();
  }

  queueInkPaint() {
    if (this.inkFrame) return;
    this.inkFrame = requestAnimationFrame(() => {
      this.inkFrame = null;
      if (this.pointer?.tool === 'eraser') this.paint();
      else this.paintPreview();
    });
  }

  paintPreview() {
    const surface = this.currentSurface;
    const canvas = surface?.overlay;
    if (!canvas) return;
    const active = this.pointer;
    if (!this.draft && active?.tool !== 'eraser') {
      if (canvas.width) canvas.width = canvas.height = 0;
      return;
    }
    if (canvas.width !== surface.canvas.width || canvas.height !== surface.canvas.height) {
      canvas.width = surface.canvas.width;
      canvas.height = surface.canvas.height;
    }
    if (this.draft) {
      const preview = { ...this.draft, points: [...this.draft.points, active.last] };
      paintStrokes(canvas, [preview], this.zoom);
      return;
    }
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / canvas.clientWidth;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.strokeStyle = '#506955';
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([6 * scale, 4 * scale]);
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
    return { page: this.page, offset, zoom: this.zoom, left: this.reader.scrollLeft };
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

  async capturePage(number = this.page, bounds = { x: 0, y: 0, w: 1, h: 1 }, method = '整页截图') {
    const source = this.documentSource;
    const book = this.book;
    if (!source) throw new Error('请先打开课本。');
    const page = await source.getPage(number);
    const view = page.getViewport({ scale: 1 });
    const width = view.width * bounds.w;
    const height = view.height * bounds.h;
    const scale = Math.min(4, 1700 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    let original;
    try {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      if (source.office) {
        original = document.createElement('canvas');
        const officeScale = Math.min(scale, 2200 / Math.max(view.width, view.height));
        original.width = Math.max(1, Math.round(view.width * officeScale));
        original.height = Math.max(1, Math.round(view.height * officeScale));
        await page.render({ canvasContext: original.getContext('2d'), viewport: view,
          transform: [officeScale, 0, 0, officeScale, 0, 0] }).promise;
        context.drawImage(original, bounds.x * original.width, bounds.y * original.height,
          bounds.w * original.width, bounds.h * original.height, 0, 0, canvas.width, canvas.height);
      } else {
        await page.render({ canvasContext: context, viewport: view,
          transform: [scale, 0, 0, scale, -bounds.x * view.width * scale, -bounds.y * view.height * scale] }).promise;
      }
      if (this.book?.id !== book.id || source !== this.documentSource) throw new Error('课本已切换，请重新截图。');
      let image = canvas.toDataURL('image/jpeg', .86);
      while (image.length > IMAGE_LIMIT && canvas.width > 1 && canvas.height > 1) {
        const smaller = document.createElement('canvas');
        smaller.width = Math.max(1, Math.floor(canvas.width * .8));
        smaller.height = Math.max(1, Math.floor(canvas.height * .8));
        smaller.getContext('2d').drawImage(canvas, 0, 0, smaller.width, smaller.height);
        canvas.width = smaller.width;
        canvas.height = smaller.height;
        context.drawImage(smaller, 0, 0);
        image = canvas.toDataURL('image/jpeg', .84);
      }
      if (!isExcerptImage(image)) throw new Error('截图生成失败，请缩小选区后重试。');
      return { bookId: book.id, book: book.title, page: number, method, image, width: canvas.width, height: canvas.height };
    } finally {
      canvas.width = canvas.height = 0;
      if (original) original.width = original.height = 0;
    }
  }

  async quotePage() {
    return this.capturePage();
  }

  async quoteSelection() {
    if (this.capturing) return;
    const bounds = this.bounds;
    if (!bounds || !this.ink || bounds.w * this.ink.clientWidth < 5 || bounds.h * this.ink.clientHeight < 5) {
      this.notify('请在课本上拖动框选一个区域。');
      return;
    }
    const page = this.page;
    this.capturing = true;
    this.sync();
    try {
      this.onQuote(await this.capturePage(page, bounds, '选文截图'));
      if (this.bounds === bounds) this.clearSelection();
    } finally {
      this.capturing = false;
      this.sync();
    }
  }
}

const EMPTY = Object.freeze([]);
