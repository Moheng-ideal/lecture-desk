import { readState, saveState } from './storage.js';

function installDivider(handleId, containerId, { property, key, initial, min, max, vertical = false }) {
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
    const { left, width, top, height } = container.getBoundingClientRect();
    const distance = vertical ? event.clientY - top - handle.offsetHeight / 2 : event.clientX - left - handle.offsetWidth / 2;
    apply(distance / (vertical ? height : width) * 100);
  };
  handle.onlostpointercapture = () => {
    delete handle.dataset.dragging;
    remember();
  };
  handle.onkeydown = (event) => {
    const decrease = vertical ? 'ArrowUp' : 'ArrowLeft';
    const increase = vertical ? 'ArrowDown' : 'ArrowRight';
    const next = { [decrease]: ratio - 3, [increase]: ratio + 3, Home: min, End: max }[event.key];
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
  installDivider('board-divider', 'right-pane', {
    property: '--board-height', key: 'boardHeight', initial: 46, min: 25, max: 65, vertical: true,
  });
}
