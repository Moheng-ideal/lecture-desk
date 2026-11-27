// Right-side (chat) text selection: mirror of the left-hand excerpt tool.
//
// The left pane can crop a PDF page because PDF.js can re-render any region.
// The chat pane is plain DOM, so instead of a screenshot we map the dragged
// rectangle onto text nodes with caretRangeFromPoint and quote the text.
//
// Design notes:
// - No overlay element: a transparent overlay swallows caretRangeFromPoint.
// - The rectangle lives on <body> with position:fixed so no ancestor layout can
//   shift its coordinates.
// - The rectangle only appears after the pointer moves >3px, so a click, a
//   wheel scroll or a stray pointerdown never flashes a box.
// - The start caret is re-locked while dragging if the press landed on blank
//   space, so starting slightly off the text still works.
// - The rectangle start follows the anchored caret rect, so scrolling with the
//   wheel while dragging keeps the box glued to the text; the end follows the
//   pointer.

const byId = (id) => document.getElementById(id);

function caretAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

function textBetween(anchor, end) {
  if (!anchor || !end) return '';
  const [first, last] = anchor.compareBoundaryPoints(Range.START_TO_START, end) <= 0
    ? [anchor, end] : [end, anchor];
  const range = document.createRange();
  try {
    range.setStart(first.startContainer, first.startOffset);
    range.setEnd(last.endContainer, last.endOffset);
  } catch {
    return '';
  }
  return range.toString()
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function installChatSelection({ quote, notify, pageNumber }) {
  const scroll = byId('chat-scroll');
  let rect = byId('chat-selection-rect');
  if (!scroll) return { setEnabled() {} };
  if (!rect) {
    rect = document.createElement('div');
    rect.id = 'chat-selection-rect';
    rect.hidden = true;
    document.body.append(rect);
  } else if (rect.parentElement !== document.body) {
    document.body.append(rect);
  }
  let press = null;      // viewport point where the pointer went down
  let pointer = null;    // latest viewport pointer position
  let anchor = null;     // caret range locked at the start of the selection
  let drawing = false;

  const distance = (event) => Math.hypot(event.clientX - press.x, event.clientY - press.y);

  // Where the box starts: prefer the live caret rect so the box follows the
  // text while the container scrolls; fall back to the original press point.
  const origin = () => {
    const live = anchor?.getBoundingClientRect?.();
    if (live && (live.width || live.height)) return { x: live.left, y: live.top };
    return press;
  };

  // Keep the rectangle inside the chat viewport: the anchored origin can scroll
  // out of view, and a fixed-position box would otherwise spill over the book
  // pane and the header.
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  const paint = (endX, endY) => {
    const box = scroll.getBoundingClientRect();
    const from = origin();
    const x1 = clamp(from.x, box.left, box.right);
    const y1 = clamp(from.y, box.top, box.bottom);
    const x2 = clamp(endX, box.left, box.right);
    const y2 = clamp(endY, box.top, box.bottom);
    rect.style.left = `${Math.min(x1, x2)}px`;
    rect.style.top = `${Math.min(y1, y2)}px`;
    rect.style.width = `${Math.abs(x2 - x1)}px`;
    rect.style.height = `${Math.abs(y2 - y1)}px`;
  };

  const reset = () => {
    press = null;
    pointer = null;
    anchor = null;
    drawing = false;
    rect.hidden = true;
  };

  scroll.addEventListener('pointerdown', (event) => {
    if (scroll.dataset.chatSelect !== 'true' || event.button !== 0) return;
    press = { x: event.clientX, y: event.clientY };
    pointer = { ...press };
    anchor = caretAt(press.x, press.y);
    drawing = false;
    rect.hidden = true;
    try { scroll.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
  }, true);

  scroll.addEventListener('pointermove', (event) => {
    if (!press) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (!drawing) {
      if (distance(event) < 3) return;
      drawing = true;
      rect.hidden = false;
    }
    if (!anchor) anchor = caretAt(event.clientX, event.clientY);
    paint(pointer.x, pointer.y);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // Keep the box attached to the anchored text when the wheel scrolls the pane
  // mid-drag; the pointer stays where it is, so only the origin moves.
  scroll.addEventListener('scroll', () => {
    if (!press || !drawing) return;
    paint(pointer.x, pointer.y);
  }, { passive: true });

  const finish = (event) => {
    if (!press) return;
    const from = press;
    const moved = Math.hypot(event.clientX - from.x, event.clientY - from.y);
    if (!drawing || moved < 5) {
      reset();
      return;
    }
    const end = caretAt(event.clientX, event.clientY);
    const text = textBetween(anchor, end);
    reset();
    event.preventDefault();
    event.stopPropagation();
    if (!text) {
      notify('框选区域里没有可引用的文字，换个位置再试。');
      return;
    }
    quote({
      bookId: 'chat-answer', book: '讲解师回答', page: pageNumber(),
      text: text.slice(0, 24000), method: '问答摘录',
    });
  };

  scroll.addEventListener('pointerup', finish, true);
  scroll.addEventListener('pointercancel', (event) => {
    if (!press) return;
    reset();
    event.preventDefault();
    event.stopPropagation();
  }, true);

  return {
    setEnabled(on) {
      scroll.dataset.chatSelect = String(on);
      if (!on) reset();
    },
  };
}
