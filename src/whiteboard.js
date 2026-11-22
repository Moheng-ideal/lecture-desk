import { eraseAt, mixPoint, paintStrokes } from './ink.js';
import { readState, saveState } from './storage.js';

export function installWhiteboard({ notify }) {
  const board = document.getElementById('class-board');
  const workspace = document.getElementById('workspace');
  const divider = document.getElementById('board-divider');
  const open = document.getElementById('board-open');
  const surface = document.getElementById('board-surface');
  const canvas = document.getElementById('board-ink');
  const undo = document.getElementById('board-undo');
  const clear = document.getElementById('board-clear');
  const modes = board.querySelectorAll('[data-board-tool]');
  const history = [];
  let ink = [];
  let mode = 'pen';
  let gesture;
  let ready = false;

  const paint = () => paintStrokes(canvas, ink, 1, gesture?.draft);
  function refresh() {
    undo.disabled = !history.length;
    clear.disabled = !ink.length;
    paint();
  }
  function persist() {
    saveState('whiteboard', ink).catch(() => notify('白板内容暂时无法保存到本机。'));
    refresh();
  }
  function remember(previous) {
    history.push(previous);
    if (history.length > 50) history.shift();
    persist();
  }
  function end(cancelled) {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    if (canvas.hasPointerCapture(active.id)) canvas.releasePointerCapture(active.id);
    if (cancelled) ink = active.previous;
    else if (active.draft) ink = [...ink, active.draft];
    if (ink === active.previous || cancelled) refresh();
    else remember(active.previous);
  }

  function resize() {
    const width = Math.floor(Math.min(surface.clientWidth, surface.clientHeight * 4 / 3));
    if (!width) return;
    const height = Math.round(width * .75);
    const pixels = Math.min(devicePixelRatio || 1, 2.5);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * pixels);
    canvas.height = Math.round(height * pixels);
    paint();
  }
  new ResizeObserver(resize).observe(surface);

  function toggle(visible) {
    if (!visible) end(false);
    board.hidden = !visible;
    divider.hidden = !visible;
    workspace.toggleAttribute('data-board-open', visible);
    open.setAttribute('aria-expanded', String(visible));
    if (visible) resize();
  }
  open.onclick = () => toggle(board.hidden);
  document.getElementById('board-close').onclick = () => {
    toggle(false);
    open.focus();
  };
  for (const control of modes) {
    control.onclick = () => {
      mode = control.dataset.boardTool;
      for (const button of modes) button.setAttribute('aria-pressed', String(button === control));
    };
  }
  undo.onclick = () => {
    if (!history.length) return;
    ink = history.pop();
    persist();
  };
  clear.onclick = () => {
    const previous = ink;
    ink = [];
    remember(previous);
  };

  function point(event) {
    const box = canvas.getBoundingClientRect();
    const fraction = (n) => Math.min(1, Math.max(0, n));
    return {
      x: fraction((event.clientX - box.left) / box.width),
      y: fraction((event.clientY - box.top) / box.height),
      pressure: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : .5,
    };
  }
  function step(event) {
    if (gesture?.id !== event.pointerId) return;
    const p = point(event);
    if (gesture.draft) gesture.draft.points.push(p);
    else {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const last = gesture.last;
      const count = Math.max(1, Math.ceil(Math.hypot((p.x - last.x) * width, (p.y - last.y) * height) / 8));
      for (let i = 1; i <= count && ink.length; i++) {
        ink = eraseAt(ink, mixPoint(last, p, i / count), width, height, 15, { mode: 'point', zoom: 1 });
      }
    }
    gesture.last = p;
    paint();
  }
  canvas.onpointerdown = (event) => {
    if (!ready || gesture || event.button !== 0) return;
    const p = point(event);
    const draft = mode === 'pen' ? {
      tool: 'pen', brush: 'ball', basis: canvas.clientWidth, points: [],
      color: document.getElementById('board-color').value,
      size: Number(document.getElementById('board-size').value),
    } : null;
    gesture = { id: event.pointerId, previous: ink, last: p, draft };
    canvas.setPointerCapture(event.pointerId);
    step(event);
    event.preventDefault();
  };
  canvas.onpointermove = step;
  canvas.onpointerup = (event) => {
    if (gesture?.id !== event.pointerId) return;
    step(event);
    end(false);
  };
  canvas.onlostpointercapture = canvas.onpointercancel = (event) => {
    if (gesture?.id === event.pointerId) end(true);
  };
  readState('whiteboard').then((value) => {
    if (Array.isArray(value)) ink = value;
  }).catch(() => {}).finally(() => { ready = true; refresh(); });
}
