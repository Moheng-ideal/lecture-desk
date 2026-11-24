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
  let expanded = false;
  let animation;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function transition(opening) {
    const resting = { opacity: 1, transform: 'scale(1)' };
    const folded = { opacity: 0, transform: 'scale(.52)' };
    let from = opening ? folded : resting;
    if (animation) {
      const style = getComputedStyle(palette);
      from = { opacity: style.opacity, transform: style.transform };
      animation.cancel();
      animation = null;
    }
    if (motion.matches || typeof palette.animate !== 'function') {
      if (!opening) palette.hidden = true;
      return;
    }
    const next = palette.animate([from, opening ? resting : folded], {
      duration: opening ? 230 : 145,
      easing: opening ? 'cubic-bezier(.2,.75,.28,1)' : 'cubic-bezier(.4,0,1,1)',
      fill: 'forwards',
    });
    animation = next;
    next.onfinish = () => {
      if (animation !== next) return;
      animation = null;
      if (!expanded) palette.hidden = true;
      next.cancel();
    };
  }

  function close(restoreFocus = false) {
    if (!expanded) return;
    expanded = false;
    if (restoreFocus || palette.contains(document.activeElement)) shortcut.focus({ preventScroll: true });
    palette.inert = true;
    shortcut.setAttribute('aria-expanded', 'false');
    transition(false);
  }

  function open(keyboard = false) {
    if (document.querySelector('dialog[open]')) return;
    if (expanded) {
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

    expanded = true;
    palette.hidden = false;
    palette.inert = false;
    shortcut.setAttribute('aria-expanded', 'true');
    const menuWidth = palette.offsetWidth;
    const menuHeight = palette.offsetHeight;
    const anchor = lastContact && Boolean(lastContact.onBoard) === Boolean(onBoard) ? lastContact : null;
    const x = anchor?.x ?? (area.width ? area.left + area.width / 2 : left + width / 2);
    const y = anchor?.y ?? (area.height ? area.top + area.height / 3 : top + height / 3);
    const menuX = Math.max(left + 8, Math.min(x - menuWidth / 2, left + width - menuWidth - 8));
    const menuY = Math.max(top + 8, Math.min(y - menuHeight / 2, top + height - menuHeight - 8));
    palette.style.left = menuX + 'px';
    palette.style.top = menuY + 'px';
    palette.style.transformOrigin = (x - menuX) + 'px ' + (y - menuY) + 'px';
    transition(true);
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
    if (expanded) {
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
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close(palette.contains(document.activeElement));
    }
  }, true);
  window.addEventListener('resize', () => close());
}
