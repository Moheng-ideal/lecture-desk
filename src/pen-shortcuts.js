import { inkContact } from './ink.js';

const bookActions = [
  ['阅读', '[data-tool="read"]', 'read'],
  ['选文', '[data-tool="select"]', 'select'],
  ['批注笔', '[data-tool="pen"]', 'pen'],
  ['荧光笔', '[data-tool="marker"]', 'marker'],
  ['橡皮擦', '[data-tool="eraser"]', 'eraser'],
  ['撤销', '#undo'],
  ['重做', '#redo'],
  ['笔刷设置', '#ink-config'],
];
const boardActions = [
  ['笔', '[data-board-tool="pen"]', 'pen'],
  ['荧光笔', '[data-board-tool="marker"]', 'marker'],
  ['橡皮擦', '[data-board-tool="eraser"]', 'eraser'],
  ['移动', '[data-board-tool="pan"]', 'pan'],
  ['撤销', '#board-undo'],
  ['笔刷设置', '#board-ink-config'],
];

export function installPenShortcuts({ reader, whiteboard, showBook }) {
  const shortcut = document.getElementById('pen-shortcuts-open');
  const palette = document.getElementById('pen-shortcuts');
  const title = document.getElementById('pen-shortcuts-title');
  const actions = palette.querySelector('.pen-shortcuts-actions');
  const boardCanvas = document.getElementById('board-ink');
  const bookArea = document.getElementById('reader');
  let lastContact;

  function close(restoreFocus = false) {
    palette.hidden = true;
    shortcut.setAttribute('aria-expanded', 'false');
    if (restoreFocus) shortcut.focus({ preventScroll: true });
  }

  function open(keyboard = false) {
    if (document.querySelector('dialog[open]')) return;
    if (!palette.hidden) {
      close(keyboard);
      return;
    }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width || innerWidth;
    const height = viewport?.height || innerHeight;
    const board = boardCanvas.getBoundingClientRect();
    const boardVisible = board.width > 0 && board.height > 0 && board.right > left && board.bottom > top
      && board.left < left + width && board.top < top + height;
    const onBoard = lastContact?.onBoard && boardVisible;
    const area = onBoard ? board : bookArea.getBoundingClientRect();
    const setTool = onBoard ? (tool) => whiteboard.setTool(tool) : (tool) => reader.setTool(tool);
    if (onBoard) whiteboard.stopInkInput();
    else {
      reader.finishPointer(false);
      reader.inkTools.toggle(false);
    }
    title.textContent = onBoard ? '白板工具' : '课本工具';

    const options = onBoard ? boardActions : bookActions;
    const size = Math.min(302, width - 16, height - 16);
    const compact = size < 282;
    palette.style.width = (compact ? Math.min(302, width - 16) : size) + 'px';
    palette.style.height = compact ? '' : size + 'px';
    palette.toggleAttribute('data-compact', compact);
    actions.replaceChildren(...options.map(([label, selector, mode], index) => {
      const original = document.querySelector(selector);
      const control = document.createElement('button');
      control.type = 'button';
      control.textContent = label;
      control.disabled = original.disabled;
      if (mode) control.setAttribute('aria-pressed', original.getAttribute('aria-pressed'));
      if (!compact) {
        const angle = (index * 220 / (options.length - 1) - 160) * Math.PI / 180;
        const radius = (size - 62) / 2;
        control.style.left = size / 2 + radius * Math.cos(angle) + 'px';
        control.style.top = size / 2 + radius * Math.sin(angle) + 'px';
      }
      control.onclick = () => {
        close();
        if (!onBoard) showBook();
        if (mode) setTool(mode);
        else original.click();
      };
      return control;
    }));

    palette.hidden = false;
    shortcut.setAttribute('aria-expanded', 'true');
    const bounds = palette.getBoundingClientRect();
    const anchor = lastContact && Boolean(lastContact.onBoard) === Boolean(onBoard) ? lastContact : null;
    const x = anchor?.x ?? (area.width ? area.left + area.width / 2 : left + width / 2);
    const y = anchor?.y ?? (area.height ? area.top + area.height / 3 : top + height / 3);
    palette.style.left = Math.max(left + 8, Math.min(x - bounds.width / 2, left + width - bounds.width - 8)) + 'px';
    palette.style.top = Math.max(top + 8, Math.min(y - bounds.height / 2, top + height - bounds.height - 8)) + 'px';
    if (keyboard) actions.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  shortcut.onclick = (event) => open(!event.detail);
  window.addEventListener('lecture-desk-native', (event) => {
    if (event.detail?.kind === 'pen-shortcut') open();
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (palette.contains(target) || shortcut.contains(target)) return;
    const onBoard = boardCanvas.contains(target);
    const onBook = bookArea.contains(target);
    if (!palette.hidden) {
      close();
      if (onBoard || onBook) {
        // Dismissing the tool palette should not add a dot or start a selection underneath it.
        event.stopPropagation();
        event.preventDefault();
      }
      return;
    }
    if ((onBoard || onBook) && inkContact(event).stylus) {
      lastContact = { onBoard, x: event.clientX, y: event.clientY };
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !palette.hidden) {
      event.preventDefault();
      close(palette.contains(document.activeElement));
    }
  }, true);
  window.addEventListener('resize', () => close());
}
