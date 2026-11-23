import { readState, saveState } from './storage.js';

const margin = 8;
const minWidth = 300;
const minHeight = 195;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function viewportBounds() {
  const viewport = window.visualViewport;
  const x = viewport?.offsetLeft || 0;
  const y = viewport?.offsetTop || 0;
  const width = viewport?.width || document.documentElement.clientWidth;
  const height = viewport?.height || document.documentElement.clientHeight;
  return { left: x + margin, top: y + margin, right: x + width - margin, bottom: y + height - margin };
}

function fit(rect, bounds) {
  const { left, top, right, bottom } = bounds;
  const maxWidth = right - left;
  const maxHeight = bottom - top;
  const width = clamp(rect.width, Math.min(minWidth, maxWidth), maxWidth);
  const height = clamp(rect.height, Math.min(minHeight, maxHeight), maxHeight);
  return { x: clamp(rect.x, left, right - width), y: clamp(rect.y, top, bottom - height), width, height };
}

function initialRect(bounds) {
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  const width = Math.min(620, availableWidth * (availableWidth < 720 ? .88 : .49));
  const height = Math.min(490, availableHeight * .55);
  return { x: bounds.left + 15, y: bounds.bottom - height - 16, width, height };
}

function move(rect, edge, dx, dy, bounds) {
  if (!edge) return fit({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const west = edge.includes('w');
  const north = edge.includes('n');
  const x = west ? clamp(rect.x + dx, bounds.left, right - Math.min(minWidth, rect.width)) : rect.x;
  const y = north ? clamp(rect.y + dy, bounds.top, bottom - Math.min(minHeight, rect.height)) : rect.y;
  const width = west ? right - x : rect.width + (edge.includes('e')
    ? clamp(dx, Math.min(minWidth, rect.width) - rect.width, bounds.right - right) : 0);
  const height = north ? bottom - y : rect.height + (edge.includes('s')
    ? clamp(dy, Math.min(minHeight, rect.height) - rect.height, bounds.bottom - bottom) : 0);
  return { x, y, width, height };
}

export function installBoardWindow(board, stopInkInput) {
  const heading = board.querySelector('.board-head');
  const title = board.querySelector('#board-move');
  let preferred;
  let rect;
  let drag;
  let pending;
  let frame;

  function paint(next) {
    rect = next;
    board.style.transform = 'translate3d(' + next.x + 'px, ' + next.y + 'px, 0)';
    board.style.width = next.width + 'px';
    board.style.setProperty('--board-window-height', next.height + 'px');
  }

  function refresh() {
    const bounds = viewportBounds();
    paint(fit(preferred || initialRect(bounds), bounds));
  }

  function remember() {
    preferred = rect;
    saveState('whiteboardWindow', preferred).catch(() => {});
  }

  function start(event) {
    if (drag || event.button !== 0 || !rect) return;
    if (event.currentTarget === heading && event.target.closest('button:not(#board-move)')) return;
    stopInkInput();
    const handle = event.currentTarget;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, rect, handle, edge: handle.dataset.boardResize };
    handle.setPointerCapture(event.pointerId);
    board.toggleAttribute('data-moving-window', !drag.edge);
    event.preventDefault();
  }

  function onMove(event) {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    pending = move(drag.rect, drag.edge, dx, dy, viewportBounds());
    if (!frame) frame = requestAnimationFrame(() => {
      frame = null;
      paint(pending);
      pending = null;
    });
  }

  function finish() {
    if (!drag) return;
    const { id, handle, rect: from } = drag;
    drag = null;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    if (pending) paint(pending);
    pending = null;
    board.removeAttribute('data-moving-window');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    if (rect.x !== from.x || rect.y !== from.y || rect.width !== from.width || rect.height !== from.height) remember();
  }

  function resizeViewport() {
    if (board.hidden) return;
    finish();
    refresh();
  }

  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  for (const handle of [heading, ...board.querySelectorAll('[data-board-resize]')]) {
    handle.onpointerdown = start;
    handle.onpointermove = onMove;
    handle.onpointerup = (event) => {
      if (drag?.id !== event.pointerId) return;
      onMove(event);
      finish();
    };
    handle.onpointercancel = handle.onlostpointercapture = (event) => {
      if (drag?.id === event.pointerId) finish();
    };
    const keyboard = handle === heading ? title : handle;
    keyboard.onkeydown = (event) => {
      const step = arrows[event.key];
      if (!step || drag) return;
      event.preventDefault();
      stopInkInput();
      const distance = event.shiftKey ? 24 : 8;
      paint(move(rect, handle.dataset.boardResize, step[0] * distance, step[1] * distance, viewportBounds()));
      remember();
    };
  }

  window.addEventListener('resize', resizeViewport);
  window.visualViewport?.addEventListener('resize', resizeViewport);
  window.visualViewport?.addEventListener('scroll', resizeViewport);
  readState('whiteboardWindow').then((saved) => {
    if (!preferred && saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
      preferred = saved;
      if (!board.hidden && !drag) refresh();
    }
  }).catch(() => {});
  return { refresh, finish };
}
