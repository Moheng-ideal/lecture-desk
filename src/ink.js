const pressure = (point) => point.pressure ?? .5;

export function mixPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    pressure: pressure(a) + (pressure(b) - pressure(a)) * t };
}

function diameter(stroke, point, width, zoom) {
  const p = pressure(point);
  const profile = stroke.brush ?? (stroke.tool === 'marker' ? 'marker' : 'legacy');
  const weight = {
    legacy: .48 + p, ball: .82 + p * .36, fountain: .4 + p * 1.2,
    felt: .7 + p * .6, brush: .16 + p * 1.68, marker: 1,
  }[profile] ?? 1;
  return stroke.size * (stroke.basis ? width / stroke.basis : zoom) * weight;
}

function circleCuts(a, b, point, width, height, radius) {
  const x = (a.x - point.x) * width;
  const y = (a.y - point.y) * height;
  const dx = (b.x - a.x) * width;
  const dy = (b.y - a.y) * height;
  const length = dx * dx + dy * dy;
  const c = x * x + y * y - radius * radius;
  if (!length) return c <= 0 ? [0, 1] : null;
  const projection = x * dx + y * dy;
  const discriminant = projection * projection - length * c;
  if (discriminant <= 0) return null;
  const root = Math.sqrt(discriminant);
  const start = Math.max(0, (-projection - root) / length);
  const end = Math.min(1, (-projection + root) / length);
  return start < end ? [start, end] : null;
}

export function eraseAt(strokes, point, width, height, radius, { mode, markerOnly, zoom }) {
  let changed = false;
  const remaining = strokes.flatMap((stroke) => {
    if (markerOnly && stroke.tool !== 'marker') return [stroke];
    const { points } = stroke;
    if (!points.length) return [stroke];
    const cut = (a, b) => circleCuts(a, b, point, width, height,
      radius + Math.max(diameter(stroke, a, width, zoom), diameter(stroke, b, width, zoom)) / 2);
    if (points.length === 1) {
      if (!cut(points[0], points[0])) return [stroke];
      changed = true;
      return [];
    }
    const fragments = [];
    let run = [points[0]];
    let hit = false;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const interval = cut(a, b);
      if (!interval) {
        if (!run.length) run.push(a);
        run.push(b);
        continue;
      }
      hit = true;
      changed = true;
      if (mode === 'stroke') return [];
      const [from, to] = interval;
      if (from > 0) {
        if (!run.length) run.push(a);
        run.push(mixPoint(a, b, from));
        fragments.push(run);
      }
      run = to < 1 ? [mixPoint(a, b, to), b] : [];
    }
    if (!hit) return [stroke];
    if (run.length) fragments.push(run);
    return fragments.map((points) => ({ ...stroke, points }));
  });
  return changed ? remaining : strokes;
}

function inside(point, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

function crosses(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

export function eraseInside(strokes, polygon, markerOnly) {
  if (polygon.length < 3) return strokes;
  const remaining = strokes.filter(({ points, tool }) => (markerOnly && tool !== 'marker') ||
    !points.some((point, i) => inside(point, polygon) || (i > 0 && polygon.some((vertex, j) =>
      crosses(points[i - 1], point, vertex, polygon[(j + 1) % polygon.length])))));
  return remaining.length === strokes.length ? strokes : remaining;
}

export function paintStrokes(canvas, strokes, zoom = 1, draft, cssWidth = canvas.clientWidth) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const pixels = width / Math.max(1, cssWidth);
  for (const stroke of draft ? [...strokes, draft] : strokes) {
    const { points, tool, color } = stroke;
    if (!points.length) continue;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = stroke.opacity ?? (tool === 'marker' ? .29 : 1);
    const radius = (p) => Math.max(.3, diameter(stroke, p, cssWidth, zoom) * pixels / 2);
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const x = p.x * width;
      const y = p.y * height;
      const r = radius(p);
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (!i) continue;
      const prev = points[i - 1];
      const px = prev.x * width;
      const py = prev.y * height;
      const distance = Math.hypot(x - px, y - py);
      if (!distance) continue;
      const nx = (py - y) / distance;
      const ny = (x - px) / distance;
      const previousRadius = radius(prev);
      ctx.moveTo(px - nx * previousRadius, py - ny * previousRadius);
      ctx.lineTo(x - nx * r, y - ny * r);
      ctx.lineTo(x + nx * r, y + ny * r);
      ctx.lineTo(px + nx * previousRadius, py + ny * previousRadius);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }
}
