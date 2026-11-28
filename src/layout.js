import { readState, saveState } from './storage.js';

function installDivider(handleId, containerId, { property, key, initial, min, max }) {
  const container = document.getElementById(containerId);
  const handle = document.getElementById(handleId);
  let ratio = initial;
  let changed = false;
  const apply = (value) => {
    ratio = Math.max(min, Math.min(max, value));
    container.style.setProperty(property, `${ratio}%`);
    handle.setAttribute('aria-valuenow', Math.round(ratio));
  };
  const remember = () => saveState(key, ratio).catch(() => {});
  readState(key).then((saved) => {
    if (!changed && Number.isFinite(saved)) apply(saved);
  }).catch(() => {});
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    changed = true;
    handle.dataset.dragging = '';
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  handle.onpointermove = (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const { left, width } = container.getBoundingClientRect();
    apply((event.clientX - left - handle.offsetWidth / 2) / width * 100);
  };
  handle.onlostpointercapture = () => {
    delete handle.dataset.dragging;
    remember();
  };
  handle.onkeydown = (event) => {
    const next = { ArrowLeft: ratio - 3, ArrowRight: ratio + 3, Home: min, End: max }[event.key];
    if (next == null) return;
    event.preventDefault();
    changed = true;
    apply(next);
    remember();
  };
}

export function installDividers() {
  installDivider('pane-divider', 'workspace', {
    property: '--book-width', key: 'bookWidth', initial: 61, min: 35, max: 75,
  });
}

export function installToolPressFeedback() {
  const buttons = ':is(.header-actions, .mobile-tabs, .tools, .board-tools, .history-tools, .selection-bar) button';
  let pressed;
  let pointerId;
  const release = () => {
    pressed?.removeAttribute('data-pressing');
    pressed = null;
  };
  document.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    release();
    const button = event.target.closest(buttons);
    if (!button || button.disabled) return;
    pressed = button;
    pointerId = event.pointerId;
    button.dataset.pressing = '';
  }, true);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    document.addEventListener(type, (event) => {
      if (event.pointerId === pointerId) release();
    }, true);
  }
  window.addEventListener('blur', release);
}
