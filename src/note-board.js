// Note board: a floating, resizable panel holding multiple independent notes.
// Each note is a vertical stack of A4-ish pages; scrolling to the bottom adds a
// fresh blank page. Ink is stored as normalised (0~1) strokes per page so the
// board can be resized without losing fidelity.
import { installBoardWindow } from './board-window.js';
import { eraseInsidePartial, paintStrokes, traceInk } from './ink.js';
import { InkTools } from './ink-tools.js';
import { newId } from './storage.js';
import {
  BACKGROUND_LABELS, createNote, dropNote, loadNotes, newPage,
  persistNote, strokeCount, uniqueTitle,
} from './notes.js';

const byId = (id) => document.getElementById(id);

export function installNoteBoard({ notify, onInkInput, snapshots, captureSelection }) {
  const board = document.getElementById('note-board');
  const pagesHost = document.getElementById('note-pages');
  const listHost = document.getElementById('note-list');
  const titleLabel = document.getElementById('note-title');
  const backgroundSelect = document.getElementById('note-background');
    if (!board || !pagesHost) return { open() {}, close() {}, toggle() {} };

  let notes = [];
  let active = null;
  let mode = 'pen';
  let draft = null;
  let undos = [];
  let saveTimer = null;
  let lastPage = null;      // page that owns the most recent stroke/erase
  let lastCanvas = null;
  let suppressGrowUntil = 0; // ignore auto-page growth right after a deletion

  const stopInkInput = () => { draft = null; };
  const window_ = installBoardWindow(board, stopInkInput, { width: 780, height: 640 });

  // Same brush engine as the book margins: brush type, size, opacity and colour
  // all come from InkTools, so the note panel matches the reader sidebar. There
  // is no dedicated "笔刷设置" button; tapping 笔/荧光笔 opens the panel, exactly
  // like the reader toolbar does.
  const toolArea = board.querySelector('.board-tool-area');
  const toolsButton = document.createElement('button');
  toolsButton.type = 'button';
  toolsButton.hidden = true;
  toolsButton.setAttribute('aria-expanded', 'false');
  toolArea.append(toolsButton);
  const noteTools = new InkTools(
    { get tool() { return mode; }, setTool(tool) { setTool(tool); } },
    {
      host: toolArea,
      button: toolsButton,
      modes: byId('note-tools'),
      prefix: 'note-',
      storageKey: 'noteInkTools',
      clear: () => clearCurrentPage(),
      clearLabel: '清空本页',
    },
  );

  function setTool(tool) {
    mode = tool;
    for (const button of board.querySelectorAll('[data-note-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.noteTool === tool));
    }
    const select = tool === 'select';
    // Ink only draws outside select mode; items stay draggable in every mode
    // because the item layer sits above the canvas.
    for (const canvas of pagesHost.querySelectorAll('.note-ink')) {
      canvas.style.pointerEvents = select ? 'none' : '';
    }
    for (const body of pagesHost.querySelectorAll('.note-item-text .note-item-body')) {
      if (!select) body.blur();
    }
    for (const pageEl of pagesHost.querySelectorAll('.note-page')) {
      pageEl.dataset.noteSelect = String(select);
    }
  }

  // --- persistence -----------------------------------------------------------
  function scheduleSave() {
    if (!active) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await persistNote(active); } catch { notify('笔记保存失败，请检查本机存储空间。'); }
    }, 400);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    if (!active) return;
    try { await persistNote(active); } catch { notify('笔记保存失败。'); }
  }

  // --- note list -------------------------------------------------------------
  function renderList() {
    if (!listHost) return;
    listHost.replaceChildren();
    const head = document.createElement('div');
    head.className = 'note-list-head';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'accent';
    add.textContent = '＋ 新建笔记';
    add.onclick = () => createAndSwitch();
    head.append(add);
    listHost.append(head);
    for (const note of notes) {
      const row = document.createElement('div');
      row.className = 'note-list-row' + (note.id === active?.id ? ' active' : '');
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'note-list-pick';
      pick.innerHTML = '<strong></strong><small></small>';
      pick.querySelector('strong').textContent = note.title;
      pick.querySelector('small').textContent = `${note.pages.length} 页 · ${strokeCount(note)} 笔`;
      pick.onclick = () => switchTo(note);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'quiet';
      rename.textContent = '重命名';
      rename.onclick = () => renameNote(note);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet';
      remove.textContent = '删除';
      remove.onclick = () => deleteNote(note);
      row.append(pick, rename, remove);
      listHost.append(row);
    }
  }

  async function createAndSwitch() {
    const note = createNote(uniqueTitle(notes));
    notes.unshift(note);
    await persistNote(note).catch(() => {});
    switchTo(note);
    renderList();
  }

  async function switchTo(note) {
    await flushSave();
    active = note;
    undos = [];
    titleLabel.textContent = note.title;
    if (backgroundSelect) backgroundSelect.value = note.background;
    renderPages();
    renderList();
    listHost?.setAttribute('hidden', '');
    notify(`已切换到「${note.title}」。`);
  }

  async function renameNote(note) {
    const next = window.prompt('笔记名称', note.title);
    if (next == null) return;
    const title = next.trim().slice(0, 60);
    if (!title) return;
    note.title = title;
    await persistNote(note).catch(() => {});
    if (note.id === active?.id) titleLabel.textContent = title;
    renderList();
  }

  async function deleteNote(note) {
    if (notes.length <= 1) {
      notify('至少保留一篇笔记。');
      return;
    }
    if (!window.confirm(`删除「${note.title}」？此操作不可撤销。`)) return;
    notes = notes.filter((item) => item.id !== note.id);
    await dropNote(note.id).catch(() => {});
    if (note.id === active?.id) {
      active = null;
      const next = notes[0];
      switchTo(next);
    } else {
      renderList();
    }
  }

  // --- pages -----------------------------------------------------------------
  function canvasScale(canvas) {
    return Math.max(0.35, canvas.clientWidth / 900);
  }

  function paintPage(canvas, page, extra) {
    paintStrokes(canvas, page.strokes, canvasScale(canvas), extra, canvas.clientWidth);
  }

  function sizeCanvas(canvas) {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function bindInk(canvas, page) {
    const point = (event) => {
      const box = canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
        pressure: event.pressure > 0 ? event.pressure : 0.5,
      };
    };
    let erasing = false;
    let lasso = null;
    // Draw the free-hand lasso path on top of the current page (dashed, same
    // colour as the reader/whiteboard lasso preview).
    const drawLasso = (path) => {
      const ctx = canvas.getContext('2d');
      if (!ctx || path.length < 2) return;
      const { width, height } = canvas;
      ctx.save();
      ctx.strokeStyle = '#506955';
      const ratio = canvas.width / Math.max(1, canvas.clientWidth);
      ctx.lineWidth = 2 * ratio;
      ctx.setLineDash([6 * ratio, 4 * ratio]);
      ctx.beginPath();
      path.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    };
    const eraseAtPoint = (p) => {
      page.strokes = noteTools.erase(page.strokes, [p], p, canvas.clientWidth, canvas.clientHeight,
        canvasScale(canvas));
      paintPage(canvas, page);
      scheduleSave();
      syncRemove(page, canvas.closest('.note-page'));
    };
    canvas.onpointerdown = (event) => {
      if (event.button !== 0) return;
      onInkInput?.();
      lastPage = page;
      lastCanvas = canvas;
      canvas.setPointerCapture(event.pointerId);
      const p = point(event);
      if (mode === 'eraser') {
        undos.push(page.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })));
        if (undos.length > 40) undos.shift();
        if (noteTools.eraser.mode === 'lasso') {
          // Free-hand lasso: collect the drag path and cut on release.
          lasso = { points: [p] };
        } else {
          erasing = true;
          eraseAtPoint(p);
        }
        event.preventDefault();
        return;
      }
      // InkTools owns brush type / colour / size / opacity for the note panel.
      draft = { ...noteTools.stroke([p], canvas.clientWidth), last: p };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    canvas.onpointermove = (event) => {
      if (lasso) {
        const p = point(event);
        const last = lasso.points[lasso.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 0.002) lasso.points.push(p);
        paintPage(canvas, page);
        drawLasso(lasso.points);
        event.preventDefault();
        return;
      }
      if (erasing) {
        eraseAtPoint(point(event));
        event.preventDefault();
        return;
      }
      if (!draft) return;
      const box = canvas.getBoundingClientRect();
      const next = point(event);
      // traceInk mutates draft.points in place and returns the new "previous" point.
      draft.last = traceInk(draft.points, draft.last, next, { width: box.width, height: box.height });
      paintPage(canvas, page, draft);
      event.preventDefault();
    };
    const end = (event) => {
      if (lasso) {
        const path = lasso.points;
        lasso = null;
        if (path.length >= 3) {
          page.strokes = eraseInsidePartial(page.strokes, path, noteTools.eraser.markerOnly);
          paintPage(canvas, page);
          scheduleSave();
          syncRemove(page, canvas.closest('.note-page'));
        }
        if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        return;
      }
      erasing = false;
      if (!draft) {
        if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        return;
      }
      const finished = draft;
      draft = null;
      if (finished.points.length) {
        undos.push(page.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })));
        if (undos.length > 40) undos.shift();
        page.strokes = [...page.strokes, finished];
        scheduleSave();
        syncRemove(page, canvas.closest('.note-page'));
      }
      paintPage(canvas, page);
      if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.onpointerup = end;
    canvas.onpointercancel = end;
    canvas.onlostpointercapture = () => end(null);
  }

  function appendPage() {
    if (!active) return;
    const page = newPage();
    active.pages.push(page);
    pagesHost.append(makePage(page));
    scheduleSave();
    renderList();
  }

  function isEmptyPage(page) {
    return page.strokes.length === 0 && (page.items || []).length === 0;
  }

  function syncRemove(page, element) {
    const button = element?.querySelector?.('.note-page-remove');
    if (button) button.hidden = !isEmptyPage(page);
  }

  function removePage(page) {
    if (!active) return;
    if (active.pages.length <= 1) {
      notify('至少保留一页笔记。');
      return;
    }
    const index = active.pages.indexOf(page);
    if (index < 0) return;
    active.pages.splice(index, 1);
    pagesHost.children[index]?.remove();
    if (lastPage === page) { lastPage = null; lastCanvas = null; }
    undos = [];
    // Deleting a page shortens the list while the viewport may still be at the
    // bottom; block the scroll-driven grow for a moment so the page does not
    // reappear immediately.
    suppressGrowUntil = performance.now() + 600;
    scheduleSave();
    renderList();
  }

  // --- page items (images / text boxes) --------------------------------------
  function applyTextStyle(body, item) {
    body.style.fontSize = `${Math.round((item.size ?? 0.028) * 1000) / 10}vh`;
    if (item.color) body.style.color = item.color;
  }

  function removeItem(item) {
    const page = active?.pages.find((candidate) => (candidate.items || []).some((entry) => entry.id === item.id));
    if (!page) return;
    page.items = page.items.filter((entry) => entry.id !== item.id);
    const index = active.pages.indexOf(page);
    const pageEl = pagesHost.children[index];
    pageEl?.querySelector(`[data-item-id="${item.id}"]`)?.remove();
    scheduleSave();
    syncRemove(page, pageEl);
  }

  function buildTools(item, body) {
    const tools = document.createElement('div');
    tools.className = 'note-item-tools';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '删除';
    remove.setAttribute('aria-label', '删除这个元素');
    remove.onclick = (event) => { event.stopPropagation(); removeItem(item); };
    tools.append(remove);
    if (item.type === 'text') {
      const smaller = document.createElement('button');
      smaller.type = 'button';
      smaller.textContent = 'A−';
      smaller.title = '缩小字号';
      smaller.onclick = (event) => {
        event.stopPropagation();
        item.size = Math.max(0.016, (item.size ?? 0.028) - 0.004);
        applyTextStyle(body, item);
        scheduleSave();
      };
      const larger = document.createElement('button');
      larger.type = 'button';
      larger.textContent = 'A+';
      larger.title = '放大字号';
      larger.onclick = (event) => {
        event.stopPropagation();
        item.size = Math.min(0.08, (item.size ?? 0.028) + 0.004);
        applyTextStyle(body, item);
        scheduleSave();
      };
      const color = document.createElement('input');
      color.type = 'color';
      color.title = '字体颜色';
      color.value = item.color || '#242622';
      color.oninput = () => {
        item.color = color.value;
        applyTextStyle(body, item);
        scheduleSave();
      };
      tools.append(smaller, larger, color);
    }
    return tools;
  }

  function bindResize(handle, item, element) {
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const page = element.closest('.note-page');
      const box = page?.getBoundingClientRect();
      drag = {
        id: event.pointerId, startX: event.clientX, startY: event.clientY,
        startLeft: box?.left ?? 0, startTop: box?.top ?? 0,
        w: item.w, h: item.h || 0.08,
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const page = element.closest('.note-page');
      if (!page) return;
      const box = page.getBoundingClientRect();
      const dx = (event.clientX - box.left) - (drag.startX - drag.startLeft);
      const dy = (event.clientY - box.top) - (drag.startY - drag.startTop);
      item.w = Math.min(0.95, Math.max(0.12, drag.w + dx / box.width));
      // Text boxes resize freely; images keep their own aspect ratio (height auto).
      if (item.type === 'text') {
        item.h = Math.min(0.9, Math.max(0.04, drag.h + dy / box.height));
      }
      paintItemPosition(element, item);
      event.preventDefault();
    });
    const finish = (event) => {
      if (!drag) return;
      drag = null;
      scheduleSave();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function makeItem(item) {
    const element = document.createElement('div');
    element.className = `note-item note-item-${item.type}`;
    element.dataset.itemId = item.id;
    const body = document.createElement(item.type === 'image' ? 'img' : 'div');
    body.className = 'note-item-body';
    if (item.type === 'image') {
      body.src = item.src;
      body.alt = item.alt || '课本截图';
      body.draggable = false;
    } else {
      body.contentEditable = 'true';
      body.spellcheck = false;
      body.dataset.placeholder = '请输入文本';
      body.textContent = item.text || '';
      applyTextStyle(body, item);
      body.addEventListener('input', () => {
        item.text = body.textContent;
        scheduleSave();
      });
    }
    element.append(body);
    element.append(buildTools(item, body));
    const handle = document.createElement('div');
    handle.className = 'note-item-handle';
    handle.title = '拖动调整大小';
    bindResize(handle, item, element);
    element.append(handle);
    paintItemPosition(element, item);
    bindItemDrag(element, item);
    return element;
  }

  function paintItemPosition(element, item) {
    element.style.left = `${item.x * 100}%`;
    element.style.top = `${item.y * 100}%`;
    element.style.width = `${item.w * 100}%`;
    if (item.h) element.style.height = `${item.h * 100}%`;
  }

  let editingItem = null;

  function setEditing(element) {
    if (editingItem === element) return;
    editingItem?.classList.remove('editing');
    editingItem = element;
    element?.classList.add('editing');
  }

  // Tapping anywhere outside the active item leaves the editing state.
  document.addEventListener('pointerdown', (event) => {
    if (!editingItem) return;
    if (event.target.closest?.('.note-item') === editingItem) return;
    editingItem.classList.remove('editing');
    editingItem = null;
  }, true);

  function beginTextEdit(body) {
    body.contentEditable = 'true';
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function bindItemDrag(element, item) {
    let drag = null;
    let lastPress = 0;
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.note-item-tools, .note-item-handle')) return;
      const now = performance.now();
      const double = now - lastPress < 350;
      lastPress = now;
      const body = element.querySelector('.note-item-body');
      // Double press on a text box enters editing. We detect it by hand because
      // preventDefault below suppresses the browser's own dblclick.
      if (double) {
        setEditing(element);
        if (body?.isContentEditable) beginTextEdit(body);
        event.preventDefault();
        return;
      }
      if (event.detail >= 2) return;
      const page = element.closest('.note-page');
      const box = page?.getBoundingClientRect();
      drag = {
        id: event.pointerId, startX: event.clientX, startY: event.clientY,
        startLeft: box?.left ?? 0, startTop: box?.top ?? 0,
        x: item.x, y: item.y, moved: false,
      };
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    element.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.moved = true;
      element.classList.add('dragging');
      // Allow dragging an item onto another page. Keep the element where it
      // visually is (map its rect into the target page) so it never teleports.
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      const targetPage = stack
        .map((entry) => entry.closest?.('.note-page'))
        .find((page) => page && !page.contains(element));
      if (targetPage && !targetPage.contains(element)) {
        const targetIndex = [...pagesHost.children].indexOf(targetPage);
        const toPage = active.pages[targetIndex];
        const fromPage = active.pages.find((candidate) => (candidate.items || []).some((entry) => entry.id === item.id));
        if (toPage && fromPage && fromPage !== toPage) {
          const elementBox = element.getBoundingClientRect();
          fromPage.items = fromPage.items.filter((entry) => entry.id !== item.id);
          toPage.items ||= [];
          toPage.items.push(item);
          targetPage.querySelector('.note-items')?.append(element);
          const box = targetPage.getBoundingClientRect();
          item.x = Math.min(1 - item.w, Math.max(0, (elementBox.left - box.left) / box.width));
          item.y = Math.min(0.94, Math.max(0, (elementBox.top - box.top) / box.height));
          paintItemPosition(element, item);
          event.preventDefault();
          return;
        }
      }
      const page = element.closest('.note-page');
      if (!page) return;
      const box = page.getBoundingClientRect();
      // Offsets relative to the page rect keep the item stable while the pane
      // scrolls under the pointer mid-drag.
      const dx = (event.clientX - box.left) - (drag.startX - drag.startLeft);
      const dy = (event.clientY - box.top) - (drag.startY - drag.startTop);
      item.x = Math.min(1 - item.w, Math.max(0, drag.x + dx / box.width));
      item.y = Math.min(0.94, Math.max(0, drag.y + dy / box.height));
      paintItemPosition(element, item);
      event.preventDefault();
    });
    const finish = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      element.classList.remove('dragging');
      if (moved) scheduleSave();
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
  }

  function renderItems(page, layer) {
    layer.replaceChildren(...(page.items || []).map((item) => makeItem(item)));
  }

  // The page the user is actually looking at (top of the viewport wins).
  function visiblePage() {
    if (!active) return null;
    const host = pagesHost.getBoundingClientRect();
    let best = null;
    let bestDistance = Infinity;
    active.pages.forEach((page, index) => {
      const element = pagesHost.children[index];
      if (!element) return;
      const box = element.getBoundingClientRect();
      const distance = Math.abs(box.top - host.top);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = page;
      }
    });
    return best || active.pages[0];
  }

  function addItem(item) {
    const page = visiblePage();
    if (!page) return;
    page.items ||= [];
    page.items.push(item);
    const index = active.pages.indexOf(page);
    const element = pagesHost.children[index];
    const layer = element?.querySelector('.note-items');
    if (layer && element) renderItems(page, layer);
    scheduleSave();
  }

  function makePage(page) {
    const element = document.createElement('div');
    element.className = 'note-page';
    element.dataset.background = active.background;
    const layer = document.createElement('div');
    layer.className = 'note-items';
    const canvas = document.createElement('canvas');
    canvas.className = 'note-ink';
    canvas.setAttribute('aria-label', '笔记手写画布');
    element.append(layer, canvas);
    renderItems(page, layer);
    const size = () => {
      // A4 proportions: derive the height from the measured width so the page
      // always has real geometry (aspect-ratio alone can collapse in flex/WebView).
      const width = element.clientWidth;
      const height = Math.round(width * 297 / 210);
      if (width > 0 && height > 0 && element.style.height !== `${height}px`) {
        element.style.height = `${height}px`;
      }
      sizeCanvas(canvas);
      paintPage(canvas, page);
    };
    requestAnimationFrame(size);
    if (typeof ResizeObserver === 'function') new ResizeObserver(size).observe(element);
    bindInk(canvas, page);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'note-page-remove';
    remove.textContent = '×';
    remove.title = '删除这张空白页';
    remove.setAttribute('aria-label', '删除这张空白页');
    remove.onclick = (event) => {
      event.stopPropagation();
      removePage(page);
    };
    element.append(remove);
    syncRemove(page, element);
    return element;
  }

  function renderPages() {
    if (!active) return;
    pagesHost.replaceChildren(...active.pages.map((page) => makePage(page)));
    pagesHost.scrollTop = 0;
  }

  // Add a page as soon as the user reaches the end of the stack.
  pagesHost.addEventListener('scroll', () => {
    if (!active) return;
    if (performance.now() < suppressGrowUntil) return;
    const nearEnd = pagesHost.scrollTop + pagesHost.clientHeight >= pagesHost.scrollHeight - 140;
    if (nearEnd) appendPage();
  }, { passive: true });

  // --- toolbar ---------------------------------------------------------------
  for (const button of board.querySelectorAll('[data-note-tool]')) {
    button.onclick = () => noteTools.select(button.dataset.noteTool);
  }
  const undoButton = document.getElementById('note-undo');
  if (undoButton) undoButton.onclick = () => {
    const previous = undos.pop();
    if (!previous || !lastPage || !lastCanvas) return;
    lastPage.strokes = previous;
    paintPage(lastCanvas, lastPage);
    scheduleSave();
    syncRemove(lastPage, lastCanvas.closest('.note-page'));
  };

  function clearCurrentPage() {
    if (!lastPage || !lastCanvas) {
      notify('先在页面上写几笔，再清空。');
      return;
    }
    if (!lastPage.strokes.length) return;
    undos.push(lastPage.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })));
    lastPage.strokes = [];
    paintPage(lastCanvas, lastPage);
    scheduleSave();
    syncRemove(lastPage, lastCanvas.closest('.note-page'));
  }

  const clearButton = document.getElementById('note-clear');
  if (clearButton) clearButton.onclick = () => clearCurrentPage();

  // --- insert image / text ---------------------------------------------------
  const pickLayer = byId('note-pick-image');
  const pickList = byId('note-pick-list');
  const pickClose = byId('note-pick-close');
  if (pickClose) pickClose.onclick = () => { if (pickLayer) pickLayer.hidden = true; };

  function insertImage(src) {
    addItem({ id: newId(), type: 'image', src, x: 0.08, y: 0.08, w: 0.5 });
    notify('已插入截图，切到「选择」可拖动位置。');
  }

  function renderPick(items, title, onPick) {
    if (!pickList) return;
    const titleEl = byId('note-pick-title');
    if (titleEl) titleEl.textContent = title;
    pickList.replaceChildren(...items.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-pick-item';
      if (item.image) {
        const img = document.createElement('img');
        img.src = item.image;
        img.alt = item.book ? `${item.book} 第 ${item.page} 页` : '课本截图';
        button.append(img);
      } else {
        button.classList.add('note-pick-quote');
        const text = document.createElement('span');
        text.textContent = (item.text || '').slice(0, 120) || '（空摘录）';
        button.append(text);
      }
      button.onclick = () => {
        if (pickLayer) pickLayer.hidden = true;
        onPick(item);
      };
      return button;
    }));
  }

  const insertImageButton = byId('note-insert-image');
  if (insertImageButton) insertImageButton.onclick = async () => {
    const captured = await captureSelection?.();
    if (captured?.image) { insertImage(captured.image); return; }
    const images = (await snapshots?.()) || [];
    if (!images.length) {
      notify('左侧还没有截图引用，请先在课本上框选，或点「添加整页截图」。');
      return;
    }
    renderPick(images, '插入哪张截图？', (item) => insertImage(item.image));
    if (pickLayer) pickLayer.hidden = false;
  };

  // Quotes collected from the chat pane (right-side text selection).
  const insertQuoteButton = byId('note-insert-quote');
  if (insertQuoteButton) insertQuoteButton.onclick = async () => {
    const quotes = (await snapshots?.({ text: true })) || [];
    if (!quotes.length) {
      notify('还没有问答摘录，请在右侧讲解师回答上框选一段文字。');
      return;
    }
    renderPick(quotes, '插入哪段摘录？', (item) => {
      addItem({ id: newId(), type: 'text', text: item.text || '', x: 0.08, y: 0.1, w: 0.74, h: 0.14, size: 0.026 });
      notify('已插入问答摘录，双击可编辑。');
    });
    if (pickLayer) pickLayer.hidden = false;
  };

  const insertTextButton = byId('note-insert-text');
  if (insertTextButton) insertTextButton.onclick = () => {
    const page = lastPage || active?.pages[0];
    if (!page) return;
    addItem({ id: newId(), type: 'text', text: '', x: 0.08, y: 0.1, w: 0.6, h: 0.08, size: 0.028 });
    notify('已添加文本框，直接输入文字；切到「选择」可拖动。');
  };

  // --- PDF export ------------------------------------------------------------
  // Each page is composited onto a canvas (background + images + text + ink) and
  // embedded into an A4 PDF with pdf-lib.
  function drawBackground(ctx, width, height, background) {
    const scale = width / 600;
    ctx.strokeStyle = '#c9d6e2';
    ctx.fillStyle = '#c9d6e2';
    ctx.lineWidth = Math.max(1, scale);
    if (background === 'lined') {
      const step = 28 * scale;
      for (let y = step; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    } else if (background === 'grid') {
      const step = 28 * scale;
      for (let y = step; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      for (let x = step; x < width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    } else if (background === 'dots') {
      const step = 24 * scale;
      for (let y = step; y < height; y += step) {
        for (let x = step; x < width; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2 * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text || '').split('\n')) {
      let line = '';
      for (const char of paragraph) {
        const next = line + char;
        if (ctx.measureText(next).width > maxWidth && line) {
          lines.push(line);
          line = char;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  async function renderPageCanvas(page, width = 1240) {
    const height = Math.round(width * 297 / 210);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    drawBackground(ctx, width, height, active.background);
    for (const item of page.items || []) {
      if (item.type === 'image') {
        try {
          const image = await loadImage(item.src);
          const w = item.w * width;
          const h = w * (image.height / image.width);
          ctx.drawImage(image, item.x * width, item.y * height, w, h);
        } catch { /* skip broken image */ }
      } else {
        const fontPx = Math.max(8, (item.size ?? 0.028) * height);
        ctx.fillStyle = item.color || '#242622';
        ctx.font = `${fontPx}px "Noto Sans SC", "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = 'top';
        const maxWidth = item.w * width;
        const lines = wrapText(ctx, item.text, maxWidth);
        lines.forEach((line, index) => {
          ctx.fillText(line, item.x * width, item.y * height + index * fontPx * 1.45);
        });
      }
    }
    // Ink goes on a transparent layer so it can composite over the content.
    const ink = document.createElement('canvas');
    ink.width = width;
    ink.height = height;
    paintStrokes(ink, page.strokes, width / 900, null, width);
    ctx.drawImage(ink, 0, 0);
    return canvas;
  }

  const exportPdfButton = byId('note-export-pdf');
  if (exportPdfButton) exportPdfButton.onclick = async () => {
    if (!active) return;
    exportPdfButton.disabled = true;
    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdf = await PDFDocument.create();
      const A4 = [595.28, 841.89];
      for (const page of active.pages) {
        const canvas = await renderPageCanvas(page);
        const image = await pdf.embedPng(canvas.toDataURL('image/png'));
        const pdfPage = pdf.addPage(A4);
        pdfPage.drawImage(image, { x: 0, y: 0, width: A4[0], height: A4[1] });
      }
      const bytes = await pdf.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(active.title || '笔记').replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      notify(`已导出 ${active.pages.length} 页 PDF。`);
    } catch (error) {
      notify(`导出失败：${error?.message || '未知错误'}`);
    } finally {
      exportPdfButton.disabled = false;
    }
  };

  // Remove every page that has no ink, always keeping at least one page.
  const clearBlankButton = document.getElementById('note-clear-blank');
  if (clearBlankButton) clearBlankButton.onclick = () => {
    if (!active) return;
    const keep = active.pages.filter((page) => !isEmptyPage(page));
    const removed = active.pages.length - keep.length;
    if (removed <= 0) {
      notify('没有空白页可以清除。');
      return;
    }
    if (!keep.length) keep.push(active.pages[0] || newPage());
    active.pages = keep;
    lastPage = null;
    lastCanvas = null;
    undos = [];
    suppressGrowUntil = performance.now() + 600;
    renderPages();
    renderList();
    scheduleSave();
    notify(`已清除 ${removed} 张空白页。`);
  };

  if (backgroundSelect) {
    for (const [value, label] of Object.entries(BACKGROUND_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      backgroundSelect.append(option);
    }
    backgroundSelect.onchange = () => {
      if (!active) return;
      active.background = backgroundSelect.value;
      for (const element of pagesHost.querySelectorAll('.note-page')) element.dataset.background = active.background;
      scheduleSave();
    };
  }

  const listButton = document.getElementById('note-list-open');
  if (listButton) listButton.onclick = () => {
    renderList();
    listHost.hidden = !listHost.hidden;
  };

  // --- open / close ----------------------------------------------------------
  let opened = false;
  async function open() {
    if (!notes.length) {
      notes = await loadNotes();
      if (!notes.length) {
        const note = createNote('课堂笔记');
        await persistNote(note).catch(() => {});
        notes = [note];
      }
    }
    if (!active) active = notes[0];
    window_.reopen();
    board.hidden = false;
    opened = true;
    titleLabel.textContent = active.title;
    if (backgroundSelect) backgroundSelect.value = active.background || 'lined';
    renderPages();
    renderList();
  }

  async function close() {
    board.hidden = true;
    opened = false;
    listHost?.setAttribute('hidden', '');
    await flushSave();
  }

  const openButton = document.getElementById('note-open');
  const closeButton = document.getElementById('note-close');
  if (openButton) openButton.onclick = () => { onInkInput?.(); open(); };
  if (closeButton) closeButton.onclick = () => { close(); openButton?.focus(); };

  return {
    open,
    close,
    toggle: () => (opened ? close() : open()),
  };
}
