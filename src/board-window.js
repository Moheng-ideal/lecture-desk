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

function initialRect(bounds, pane, defaultWidth = 540, defaultHeight = 490) {
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  const width = Math.min(defaultWidth, pane.width ? Math.max(minWidth, pane.width - 24) : availableWidth * .88);
  const height = Math.min(defaultHeight, availableHeight * .55);
  return fit({
    x: (pane.width ? pane.right : bounds.right) - width - 12,
    y: (pane.height ? pane.top : bounds.top) + 62,
    width, height,
  }, bounds);
}

function move(rect, edge, dx, dy, bounds) {
  if (!edge) return { ...rect, x: rect.x + dx, y: rect.y + dy };
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const maxWidth = Math.max(rect.width, bounds.right - bounds.left);
  const maxHeight = Math.max(rect.height, bounds.bottom - bounds.top);
  const west = edge.includes('w');
  const north = edge.includes('n');
  const x = west ? clamp(rect.x + dx, right - maxWidth, right - Math.min(minWidth, rect.width)) : rect.x;
  const y = north ? clamp(rect.y + dy, bottom - maxHeight, bottom - Math.min(minHeight, rect.height)) : rect.y;
  const width = west ? right - x : rect.width + (edge.includes('e')
    ? clamp(dx, Math.min(minWidth, rect.width) - rect.width, maxWidth - rect.width) : 0);
  const height = north ? bottom - y : rect.height + (edge.includes('s')
    ? clamp(dy, Math.min(minHeight, rect.height) - rect.height, maxHeight - rect.height) : 0);
  return { x, y, width, height };
}

export function installBoardWindow(board, stopInkInput, { width: defaultWidth = 540, height: defaultHeight = 490 } = {}) {
  const heading = board.querySelector('.board-head');
  const title = board.querySelector('#board-move, #note-move');
  const pane = document.getElementById("right-pane");
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

  function reset() {
    finish();
    paint(initialRect(viewportBounds(), pane.getBoundingClientRect(), defaultWidth, defaultHeight));
  }

  // Reopening keeps the size the user last resized to, but puts the window back
  // at its default position (and clamps the size to the current viewport).
  function reopen() {
    finish();
    const bounds = viewportBounds();
    const base = initialRect(bounds, pane.getBoundingClientRect(), defaultWidth, defaultHeight);
    paint(fit({
      x: base.x, y: base.y,
      width: rect?.width ?? base.width,
      height: rect?.height ?? base.height,
    }, bounds));
  }

  // Restore the default window size anchored at the top-right corner: the
  // top-right stays put, the window grows/shrinks leftward. Ink is untouched.
  function resetSize() {
    finish();
    const bounds = viewportBounds();
    const base = initialRect(bounds, pane.getBoundingClientRect(), defaultWidth, defaultHeight);
    const right = rect ? rect.x + rect.width : base.x + base.width;
    const top = rect?.y ?? base.y;
    paint(fit({
      x: right - base.width,
      y: top,
      width: base.width,
      height: base.height,
    }, bounds));
  }

  function start(event) {
    if (drag || event.button !== 0 || !rect) return;
    if (event.currentTarget === heading &&
      event.target.closest('button:not(#board-move):not(#note-move), select, option, input, textarea, label')) return;
    stopInkInput();
    const handle = event.currentTarget;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, rect, handle, edge: handle.dataset.boardResize };
    handle.setPointerCapture(event.pointerId);
    board.toggleAttribute('data-moving-window', !drag.edge);
    if (drag.edge) handle.dataset.resizing = '';
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
    const { id, handle } = drag;
    drag = null;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    if (pending) paint(pending);
    pending = null;
    board.removeAttribute('data-moving-window');
    delete handle.dataset.resizing;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
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
    };
  }

  return { reset, reopen, resetSize, finish };
}
