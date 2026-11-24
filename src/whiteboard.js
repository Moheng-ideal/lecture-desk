import { inkContact, mixPoint, paintInkStroke, traceInk } from './ink.js';
import { installBoardWindow } from './board-window.js';
import { InkTools } from './ink-tools.js';
import { readState, saveState } from './storage.js';

const home = { x: 0, y: 0, zoom: 1 };
const minZoom = .1;
const maxZoom = 8;

function migrateInk(strokes, width, height) {
  const oldWidth = Math.floor(Math.min(width, height * 4 / 3));
  const oldHeight = Math.round(oldWidth * .75);
  return strokes.map(({ basis, points, ...stroke }) => ({
    ...stroke,
    size: stroke.size * (basis ? oldWidth / basis : 1),
    points: points.map((point) => ({ ...point, x: (point.x - .5) * oldWidth, y: (point.y - .5) * oldHeight })),
  }));
}

function centerBetween(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
  };
}

export function installWhiteboard({ notify, allowFingerInk }) {
  const id = (name) => document.getElementById(name);
  const board = id('class-board');
  const open = id('board-open');
  const surface = id('board-surface');
  const canvas = id('board-ink');
  const overlay = id('board-draft');
  const undo = id('board-undo');
  const clear = id('board-clear');
  const zoomIn = id('board-zoom-in');
  const zoomOut = id('board-zoom-out');
  const zoomReset = id('board-zoom-reset');
  const toolbar = id('board-tools');
  const modes = toolbar.querySelectorAll('[data-board-tool]');
  const history = [];
  const contacts = new Map();
  const strokeBounds = new WeakMap();
  let ink = [];
  let oldInk;
  let camera = home;
  let mode = 'pen';
  let lastPen = mode;
  let action;
  let pinch;
  let pinchTail = false;
  let ready = false;
  let width = 0;
  let height = 0;
  let frame;
  let redrawInk = true;
  let previewVisible = false;
  let saveTimer;

  const tools = new InkTools({ get tool() { return mode; }, setTool }, {
    host: toolbar.parentElement, button: id('board-ink-config'), modes: toolbar,
    prefix: 'board-', storageKey: 'whiteboardInkTools', clear: clearInk, clearLabel: '清空白板',
  });

  const center = () => ({ x: width / 2, y: height / 2 });
  const worldAt = (screen) => ({
    x: camera.x + (screen.x - width / 2) / camera.zoom,
    y: camera.y + (screen.y - height / 2) / camera.zoom,
  });

  function setView(anchor, screen, zoom) {
    zoom = Math.min(maxZoom, Math.max(minZoom, zoom));
    camera = {
      x: anchor.x - (screen.x - width / 2) / zoom,
      y: anchor.y - (screen.y - height / 2) / zoom,
      zoom,
    };
    schedulePaint(true);
  }

  function paintContext(layer) {
    const ctx = layer.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    const dx = layer.width / width;
    const dy = layer.height / height;
    ctx.setTransform(camera.zoom * dx, 0, 0, camera.zoom * dy,
      (width / 2 - camera.x * camera.zoom) * dx, (height / 2 - camera.y * camera.zoom) * dy);
    return ctx;
  }

  function boundsOf(stroke) {
    if (strokeBounds.has(stroke)) return strokeBounds.get(stroke);
    const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const { x, y } of stroke.points) {
      bounds.left = Math.min(bounds.left, x - stroke.size);
      bounds.top = Math.min(bounds.top, y - stroke.size);
      bounds.right = Math.max(bounds.right, x + stroke.size);
      bounds.bottom = Math.max(bounds.bottom, y + stroke.size);
    }
    strokeBounds.set(stroke, bounds);
    return bounds;
  }

  function paint() {
    frame = null;
    if (board.hidden || !width || !height) return;
    if (redrawInk) {
      redrawInk = false;
      const ctx = paintContext(canvas);
      const first = worldAt({ x: 0, y: 0 });
      const last = worldAt({ x: width, y: height });
      for (const stroke of ink) {
        const b = boundsOf(stroke);
        if (b.right >= first.x && b.left <= last.x && b.bottom >= first.y && b.top <= last.y) {
          paintInkStroke(ctx, stroke);
        }
      }
    }
    if (action?.draft || action?.tool === 'eraser') {
      const ctx = paintContext(overlay);
      if (action.draft) {
        const draft = { ...action.draft, points: [...action.draft.points, action.last] };
        paintInkStroke(ctx, draft);
      } else drawEraser(ctx, action);
      previewVisible = true;
    } else if (previewVisible) {
      paintContext(overlay);
      previewVisible = false;
    }
    zoomReset.textContent = `${Math.round(camera.zoom * 100)}%`;
    zoomIn.disabled = camera.zoom >= maxZoom;
    zoomOut.disabled = camera.zoom <= minZoom;
  }

  function schedulePaint(full = false) {
    redrawInk ||= full;
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function drawEraser(ctx, active) {
    ctx.strokeStyle = '#506955';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
    ctx.beginPath();
    if (tools.eraser.mode === 'lasso') {
      for (const point of active.path) ctx.lineTo(point.x, point.y);
      ctx.closePath();
    } else {
      const point = active.last;
      ctx.arc(point.x, point.y, tools.radius(point, active.stylus) / camera.zoom, 0, 2 * Math.PI);
    }
    ctx.stroke();
  }

  function refresh() {
    undo.disabled = !history.length;
    clear.disabled = !ink.length;
    schedulePaint(true);
  }

  function persist() {
    clearTimeout(saveTimer);
    if (!ready || oldInk) return;
    saveState('whiteboard', { version: 1, strokes: ink, camera }).catch(() => notify('白板内容暂时无法保存到本机。'));
  }

  function rememberView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 240);
  }

  function remember(previous) {
    history.push(previous);
    if (history.length > 50) history.shift();
    persist();
  }

  function endAction(cancelled) {
    if (!action) return;
    const active = action;
    action = null;
    if (active.tool === 'pan') {
      rememberView();
      return;
    }
    if (cancelled) ink = active.previous;
    else if (active.draft) ink = [...ink, active.draft];
    else if (tools.eraser.mode === 'lasso') ink = tools.erase(ink, active.path, active.last, 1, 1, 1, active.stylus);
    if (ink !== active.previous) remember(active.previous);
    refresh();
    if (!cancelled && active.tool === 'eraser' && tools.eraser.returnToPen) setTool(lastPen);
  }

  function resize() {
    width = surface.clientWidth;
    height = surface.clientHeight;
    if (!width || !height) return;
    if (oldInk) {
      ink = migrateInk(oldInk, width, height);
      oldInk = null;
      persist();
      refresh();
    }
    const density = Math.min(devicePixelRatio || 1, 2.5);
    for (const layer of [canvas, overlay]) {
      const w = Math.round(width * density);
      const h = Math.round(height * density);
      if (layer.width !== w || layer.height !== h) {
        layer.width = w;
        layer.height = h;
      }
    }
    schedulePaint(true);
  }
  new ResizeObserver(resize).observe(surface);

  function stopInkInput() {
    const captures = new Set(contacts.keys());
    if (action) captures.add(action.id);
    endAction(false);
    if (pinch) rememberView();
    contacts.clear();
    pinch = null;
    pinchTail = false;
    for (const key of captures) if (canvas.hasPointerCapture(key)) canvas.releasePointerCapture(key);
    tools.toggle(false);
  }

  const boardWindow = installBoardWindow(board, stopInkInput);
  function toggle(visible) {
    if (visible) boardWindow.reset();
    else {
      boardWindow.finish();
      stopInkInput();
      persist();
    }
    board.hidden = !visible;
    open.setAttribute('aria-expanded', String(visible));
    if (visible) {
      resize();
      id('board-move').focus({ preventScroll: true });
    }
  }
  open.onclick = () => { stopInkInput(); toggle(true); };
  id('board-close').onclick = () => {
    toggle(false);
    open.focus();
  };

  function setTool(tool) {
    if (tool !== mode) endAction(true);
    mode = tool;
    if (tool === 'pen' || tool === 'marker') lastPen = tool;
    surface.toggleAttribute('data-moving', tool === 'pan');
    for (const button of modes) button.setAttribute('aria-pressed', String(button.dataset.boardTool === tool));
    tools.sync();
  }
  for (const button of modes) button.onclick = () => tools.select(button.dataset.boardTool);
  undo.onclick = () => {
    endAction(true);
    if (!history.length) return;
    ink = history.pop();
    persist();
    refresh();
  };
  function clearInk() {
    endAction(true);
    if (!ink.length) return;
    const previous = ink;
    ink = [];
    remember(previous);
    refresh();
  }
  clear.onclick = clearInk;

  function zoomAt(screen, scale) {
    if (!ready || !width || !height || action || pinch) return;
    setView(worldAt(screen), screen, camera.zoom * scale);
    rememberView();
  }
  zoomIn.onclick = () => zoomAt(center(), 1.25);
  zoomOut.onclick = () => zoomAt(center(), .8);
  zoomReset.onclick = () => {
    if (!ready || action || pinch) return;
    camera = home;
    schedulePaint(true);
    persist();
  };

  const pointOnCanvas = (event, box) => ({ x: event.clientX - box.left, y: event.clientY - box.top });
  function pointInWorld(event, screen, active) {
    return {
      ...worldAt(screen),
      pressure: active.stylus && event.pressure > 0 ? event.pressure : active.last?.pressure ?? .5,
    };
  }

  function erase(active, point) {
    const previous = active.last;
    const before = ink;
    if (tools.eraser.mode === 'lasso') {
      if (point.x !== previous.x || point.y !== previous.y) active.path.push(point);
    } else {
      const radius = Math.min(tools.radius(previous, active.stylus), tools.radius(point, active.stylus));
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y) * camera.zoom;
      const steps = Math.max(1, Math.ceil(distance / Math.max(2, radius * .6)));
      for (let i = 1; i <= steps && ink.length; i++) {
        const sample = mixPoint(previous, point, i / steps);
        ink = tools.erase(ink, active.path, sample, 1, 1, 1, active.stylus, 1 / camera.zoom);
      }
    }
    active.last = point;
    schedulePaint(ink !== before);
  }

  function moveAction(event, end = false) {
    const active = action;
    if (active?.id !== event.pointerId) return;
    const box = canvas.getBoundingClientRect();
    if (active.tool === 'pan') {
      setView(active.anchor, pointOnCanvas(event, box), camera.zoom);
      return;
    }
    const samples = !end && event.getCoalescedEvents?.();
    const scale = { width: camera.zoom, height: camera.zoom };
    for (const sample of samples?.length ? samples : [event]) {
      const point = pointInWorld(sample, pointOnCanvas(sample, box), active);
      if (active.draft) active.last = traceInk(active.draft.points, active.last, point, scale, end);
      else erase(active, point);
    }
    if (active.draft) schedulePaint();
  }

  canvas.onpointerdown = (event) => {
    if (!ready || !width || !height || event.button !== 0) return;
    const { touch, stylus, nativePressure } = inkContact(event);
    const finger = touch && !stylus;
    if (finger && action?.stylus) return;
    if (stylus && action?.finger) {
      endAction(true);
      contacts.clear();
    }
    const screen = pointOnCanvas(event, canvas.getBoundingClientRect());
    if (finger) {
      contacts.set(event.pointerId, screen);
      canvas.setPointerCapture(event.pointerId);
      if (contacts.size === 2 && !pinchTail && !pinch) {
        endAction(true);
        const ids = [...contacts.keys()];
        const start = centerBetween(...contacts.values());
        pinch = { ids, anchor: worldAt(start), distance: start.distance, zoom: camera.zoom };
      }
    }
    if (pinch || pinchTail || action) return;
    if (!canvas.hasPointerCapture(event.pointerId)) canvas.setPointerCapture(event.pointerId);
    const tool = finger && !allowFingerInk() ? 'pan' : mode;
    action = { id: event.pointerId, tool, finger, stylus, previous: ink };
    if (tool === 'pan') action.anchor = worldAt(screen);
    else {
      const point = pointInWorld(event, screen, action);
      if (nativePressure > 0) point.pressure = nativePressure;
      action.last = point;
      if (tool === 'pen' || tool === 'marker') {
        action.draft = tools.stroke([point]);
        // Store a world-space width that matches the selected screen width at this zoom.
        action.draft.size /= camera.zoom;
        schedulePaint();
      } else {
        action.path = [point];
        erase(action, point);
      }
    }
    event.preventDefault();
  };

  canvas.onpointermove = (event) => {
    if (contacts.has(event.pointerId)) {
      contacts.set(event.pointerId, pointOnCanvas(event, canvas.getBoundingClientRect()));
      if (pinch) {
        const screen = centerBetween(...pinch.ids.map((key) => contacts.get(key)));
        setView(pinch.anchor, screen, pinch.zoom * screen.distance / pinch.distance);
        return;
      }
    }
    moveAction(event);
  };

  function pointerEnd(event, cancelled) {
    if (pinch?.ids.includes(event.pointerId)) {
      pinch = null;
      pinchTail = true;
      rememberView();
    }
    contacts.delete(event.pointerId);
    if (!contacts.size) pinchTail = false;
    if (action?.id !== event.pointerId) return;
    if (!cancelled) moveAction(event, true);
    endAction(cancelled);
  }
  canvas.onpointerup = (event) => pointerEnd(event, false);
  canvas.onlostpointercapture = canvas.onpointercancel = (event) => pointerEnd(event, true);
  canvas.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const rate = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    zoomAt(pointOnCanvas(event, canvas.getBoundingClientRect()), Math.exp(-event.deltaY * rate * .002));
  }, { passive: false });

  readState('whiteboard').then((value) => {
    if (Array.isArray(value) && value.length) oldInk = value;
    if (value?.version === 1 && Array.isArray(value.strokes)) {
      ink = value.strokes;
      const saved = value.camera;
      if (Number.isFinite(saved?.x) && Number.isFinite(saved.y) && saved.zoom >= minZoom && saved.zoom <= maxZoom) {
        camera = saved;
      }
    }
  }).catch(() => {}).finally(() => {
    ready = true;
    resize();
    refresh();
  });
  return { setTool, stopInkInput };
}
