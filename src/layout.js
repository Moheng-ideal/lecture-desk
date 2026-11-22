import { readState, saveState } from './storage.js';

export function installDivider() {
  const workspace = document.getElementById('workspace');
  const handle = document.getElementById('pane-divider');
  let ratio = 61;
  let changed = false;
  const apply = (value) => {
    ratio = Math.max(35, Math.min(75, value));
    workspace.style.setProperty('--book-width', `${ratio}%`);
    handle.setAttribute('aria-valuenow', Math.round(ratio));
  };
  const remember = () => saveState('bookWidth', ratio).catch(() => {});
  readState('bookWidth').then((saved) => {
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
    const { left, width } = workspace.getBoundingClientRect();
    apply((event.clientX - left - handle.offsetWidth / 2) / width * 100);
  };
  handle.onlostpointercapture = () => {
    delete handle.dataset.dragging;
    remember();
  };
  handle.onkeydown = (event) => {
    const next = { ArrowLeft: ratio - 3, ArrowRight: ratio + 3, Home: 35, End: 75 }[event.key];
    if (next == null) return;
    event.preventDefault();
    changed = true;
    apply(next);
    remember();
  };
}
