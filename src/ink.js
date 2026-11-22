const distanceToSegment = (x, y, a, b, width, height) => {
  const dx = (b.x - a.x) * width;
  const dy = (b.y - a.y) * height;
  const px = (x - a.x) * width;
  const py = (y - a.y) * height;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
};

export function eraseAt(strokes, point, width, height) {
  return strokes.filter(({ points, size }) => !points.some((p, i) =>
    distanceToSegment(point.x, point.y, points[i - 1] || p, p, width, height) < 11 + size / 2));
}

export function paintStrokes(canvas, strokes, scale, draft) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const factor = width / Math.max(1, canvas.clientWidth) * scale;
  for (const stroke of draft ? [...strokes, draft] : strokes) {
    const { points, tool, color, size } = stroke;
    if (!points.length) continue;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (tool === 'marker') {
      ctx.globalAlpha = .29;
      ctx.lineWidth = size * factor;
      if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0].x * width, points[0].y * height, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(points[0].x * width, points[0].y * height);
        for (const point of points.slice(1)) ctx.lineTo(point.x * width, point.y * height);
        ctx.stroke();
      }
    } else {
      const diameter = (p) => Math.max(.6, size * factor * (.48 + p.pressure));
      ctx.beginPath();
      ctx.arc(points[0].x * width, points[0].y * height, diameter(points[0]) / 2, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        ctx.beginPath();
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
        ctx.lineWidth = (diameter(a) + diameter(b)) / 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
