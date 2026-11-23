export function installScrollThumb(scroller) {
  const thumb = scroller.nextElementSibling;
  let drag;
  let timer;
  let frame;
  let range = 0;
  let travel = 0;
  const inset = 4;

  function paint() {
    frame = null;
    const height = scroller.clientHeight;
    range = scroller.scrollHeight - height;
    thumb.hidden = range <= 1 || height < 48;
    if (thumb.hidden) return;
    const track = height - inset * 2;
    const length = Math.min(track - 8, Math.max(34, track * height / scroller.scrollHeight));
    travel = track - length;
    const ratio = Math.min(1, Math.max(0, scroller.scrollTop / range));
    thumb.style.height = length + 'px';
    thumb.style.transform = 'translateY(' + Math.round(inset + ratio * travel) + 'px)';
    thumb.setAttribute('aria-valuenow', Math.round(ratio * 100));
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function reveal() {
    thumb.dataset.visible = '';
    clearTimeout(timer);
    if (!drag) timer = setTimeout(() => { delete thumb.dataset.visible; }, 1300);
    schedule();
  }

  scroller.addEventListener('scroll', reveal, { passive: true });
  const size = new ResizeObserver(schedule);
  size.observe(scroller);
  for (const child of scroller.children) size.observe(child);

  thumb.onpointerdown = (event) => {
    if (drag || event.button !== 0 || !travel || thumb.hidden) return;
    drag = { id: event.pointerId, y: event.clientY, top: scroller.scrollTop };
    thumb.setPointerCapture(event.pointerId);
    thumb.dataset.dragging = '';
    reveal();
    event.preventDefault();
  };
  thumb.onpointermove = (event) => {
    if (drag?.id === event.pointerId && travel) {
      scroller.scrollTop = drag.top + (event.clientY - drag.y) * range / travel;
    }
  };
  thumb.onpointerup = thumb.onpointercancel = thumb.onlostpointercapture = (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    delete thumb.dataset.dragging;
    reveal();
  };
  thumb.onkeydown = (event) => {
    const page = scroller.clientHeight;
    const offset = { ArrowUp: -40, ArrowDown: 40, PageUp: -page, PageDown: page,
      Home: -range, End: range }[event.key];
    if (offset == null) return;
    event.preventDefault();
    scroller.scrollTop += offset;
    reveal();
  };
  schedule();
}
