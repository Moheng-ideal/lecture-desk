const palette = { blue: '#3b77ba', green: '#31855e', orange: '#bc672d', purple: '#7751a5', red: '#bf4848' };
const colors = Object.values(palette);
const label = (value, limit = 48) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const coordinate = (value) => Number.isFinite(value) && Math.abs(value) <= 1e12;
const colorOf = (name, index) => Object.hasOwn(palette, name) ? palette[name] : colors[index % colors.length];

export function parseDiagram(text) {
  if (typeof text !== 'string' || text.length > 24000) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const title = label(value?.title, 80);
  if (value?.type === 'structure' && Array.isArray(value.nodes) && value.nodes.length <= 64 &&
      Array.isArray(value.edges) && value.edges.length <= 150) {
    const nodes = new Map();
    for (const node of value.nodes) {
      const id = label(node?.id, 30);
      if (!id || nodes.has(id) || !coordinate(node.x) || !coordinate(node.y)) continue;
      nodes.set(id, { x: node.x, y: node.y, z: coordinate(node.z) ? node.z : null,
        label: label(node.label), color: colorOf(node.color, 0) });
    }
    const edges = value.edges.filter((edge) => Array.isArray(edge) && edge.length === 2 &&
      edge[0] !== edge[1] && edge.every((id) => nodes.has(id)));
    if (nodes.size) return { type: 'structure', title, nodes, edges };
  }
  if (value?.type === 'plot' && Array.isArray(value.series) && value.series.length <= 6) {
    const series = value.series.flatMap((line, index) => {
      if (!Array.isArray(line?.points) || !line.points.length || line.points.length > 240 ||
          !line.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(coordinate))) return [];
      return [{ label: label(line.label), color: colorOf(line.color, index), points: line.points }];
    });
    if (series.length) return { type: 'plot', title, xLabel: label(value.xLabel, 24), yLabel: label(value.yLabel, 24), series };
  }
  return null;
}

export function diagramDescription(diagram) {
  const names = diagram.type === 'structure'
    ? [...diagram.nodes.values()].map((node) => node.label).filter(Boolean)
    : diagram.series.map((line) => line.label).filter(Boolean);
  const title = diagram.title || (diagram.type === 'structure' ? '结构示意图' : '坐标图');
  return [...new Set([title, ...names.slice(0, 8)])].join(' · ');
}

function range(values, padding = 0) {
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < 1e-10) {
    low -= 1;
    high += 1;
  }
  const gap = (high - low) * padding;
  return [low - gap, high + gap];
}

export function drawDiagram(diagram) {
  const node = (tag, attributes, text) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if (text) element.textContent = text;
    return element;
  };
  const width = 640;
  const height = 350;
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'img', 'aria-label': diagramDescription(diagram), 'font-family': 'system-ui, sans-serif' });
  svg.append(node('title', {}, diagramDescription(diagram)),
    node('rect', { width, height, rx: 12, fill: '#f5f8fc' }));
  const line = (x1, y1, x2, y2, stroke, thickness = 1) =>
    svg.append(node('line', { x1, y1, x2, y2, stroke, 'stroke-width': thickness }));
  const text = (value, x, y, options = {}) => {
    if (value) svg.append(node('text', { x, y, fill: '#26384e', 'font-size': 14, ...options }, value));
  };
  const dot = (x, y, fill) => svg.append(node('circle', { cx: x, cy: y, r: 5, fill, stroke: '#fff' }));
  text(diagram.title, width / 2, 29, { 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 650 });

  if (diagram.type === 'structure') {
    const spatial = [...diagram.nodes.values()].some((point) => point.z !== null);
    const projected = [...diagram.nodes].map(([id, point]) => [id, { ...point,
      x: spatial ? (point.x - point.y) * .866 : point.x,
      y: spatial ? (point.z ?? 0) - (point.x + point.y) * .5 : point.y }]);
    const [left, right] = range(projected.map(([, point]) => point.x));
    const [bottom, top] = range(projected.map(([, point]) => point.y));
    const scale = Math.min(480 / (right - left), 245 / (top - bottom));
    const points = new Map(projected.map(([id, point]) => [id, { ...point,
      x: width / 2 + (point.x - (left + right) / 2) * scale,
      y: 183 - (point.y - (top + bottom) / 2) * scale }]));
    for (const [a, b] of diagram.edges) {
      const from = points.get(a);
      const to = points.get(b);
      line(from.x, from.y, to.x, to.y, '#74859b', 1.85);
    }
    for (const point of points.values()) {
      dot(point.x, point.y, point.color);
      text(point.label, point.x + 9, point.y - 8, { 'text-anchor': point.x > 500 ? 'end' : 'start' });
    }
    return svg;
  }

  const all = diagram.series.flatMap((item) => item.points);
  const [xmin, xmax] = range(all.map(([x]) => x), .04);
  const [ymin, ymax] = range(all.map(([, y]) => y), .07);
  const x = (value) => 68 + 519 * (value - xmin) / (xmax - xmin);
  const y = (value) => 275 - 224 * (value - ymin) / (ymax - ymin);
  const tick = (value) => Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 4 }).format(value);
  for (let i = 0; i <= 4; i++) {
    const xv = xmin + (xmax - xmin) * i / 4;
    const yv = ymin + (ymax - ymin) * i / 4;
    line(x(xv), 51, x(xv), 275, '#dae2ee');
    line(68, y(yv), 587, y(yv), '#dae2ee');
    text(tick(xv), x(xv), 294, { 'text-anchor': 'middle', 'font-size': 11 });
    text(tick(yv), 62, y(yv) + 4, { 'text-anchor': 'end', 'font-size': 11 });
  }
  line(68, 275, 587, 275, '#576d87', 1.5);
  line(68, 51, 68, 275, '#576d87', 1.5);
  text(diagram.xLabel, 587, 317, { 'text-anchor': 'end' });
  text(diagram.yLabel, 68, 44);
  diagram.series.forEach((item, index) => {
    if (item.points.length === 1) dot(x(item.points[0][0]), y(item.points[0][1]), item.color);
    else svg.append(node('polyline', { points: item.points.map(([a, b]) => `${x(a)},${y(b)}`).join(' '),
      fill: 'none', stroke: item.color, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    text(item.label.slice(0, 12), 74 + 85 * index, 338, { fill: item.color, 'font-size': 12 });
  });
  return svg;
}
