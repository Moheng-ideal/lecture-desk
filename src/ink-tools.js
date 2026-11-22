import { eraseAt, eraseInside, paintStrokes } from './ink.js';
import { readState, saveState } from './storage.js';

const byId = (id) => document.getElementById(id);
const colors = [
  ['炭黑', '#242622'], ['朱红', '#ba472d'], ['金黄', '#dfad2e'],
  ['松绿', '#3b6850'], ['钴蓝', '#366b9a'], ['紫色', '#84568b'],
];
const presets = {
  ball: { size: 4, color: '#ba472d', opacity: 100 },
  fountain: { size: 5, color: '#242622', opacity: 100 },
  felt: { size: 6, color: '#366b9a', opacity: 100 },
  brush: { size: 10, color: '#242622', opacity: 100 },
  marker: { size: 14, color: '#dfad2e', opacity: 29 },
};

export class InkTools {
  constructor(reader) {
    this.reader = reader;
    this.brush = 'ball';
    this.pens = structuredClone(presets);
    this.eraser = { mode: 'point', size: 30, markerOnly: false, pressure: true, sensitivity: 72, returnToPen: false };
    this.panel = byId('ink-panel');
    this.preview = byId('ink-preview');
    for (const [name, color] of colors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = name;
      button.setAttribute('aria-label', name);
      button.dataset.color = color;
      button.style.setProperty('--swatch', color);
      button.onclick = () => this.update(this.pen, 'color', color);
      byId('ink-swatches').append(button);
    }
    byId('brush-choices').onclick = ({ target }) => {
      const brush = target.closest('[data-brush]')?.dataset.brush;
      if (!brush) return;
      if (brush !== 'marker') this.brush = brush;
      this.reader.setTool(brush === 'marker' ? 'marker' : 'pen');
      this.save();
    };
    byId('erase-choices').onclick = ({ target }) => {
      const mode = target.closest('[data-erase]')?.dataset.erase;
      if (mode) this.update(this.eraser, 'mode', mode);
    };
    this.controls = [
      ['ink-size', 'size'], ['ink-opacity', 'opacity'], ['ink-color', 'color'],
      ['erase-size', 'size'], ['erase-marker', 'markerOnly'], ['erase-pressure', 'pressure'],
      ['erase-sensitivity', 'sensitivity'], ['erase-return', 'returnToPen'],
    ];
    for (const [id, key] of this.controls) {
      byId(id).oninput = ({ target }) => {
        const value = { checkbox: target.checked, range: target.valueAsNumber, color: target.value }[target.type];
        this.update(id.startsWith('ink-') ? this.pen : this.eraser, key, value);
      };
    }
    byId('ink-config').onclick = () => {
      if (!['pen', 'marker', 'eraser'].includes(this.reader.tool)) this.reader.setTool('pen');
      this.toggle(this.panel.hidden);
    };
    byId('ink-close').onclick = () => this.toggle(false);
    byId('erase-page').onclick = () => this.reader.clearPageInk();
    document.addEventListener('pointerdown', ({ target }) => {
      if (!this.panel.hidden && !target.closest('#ink-panel, #modes, #ink-config')) this.toggle(false);
    });
    document.addEventListener('keydown', ({ key }) => { if (key === 'Escape') this.toggle(false); });
    readState('inkTools').then((saved) => {
      if (saved && !this.changed) {
        if (presets[saved.brush] && saved.brush !== 'marker') this.brush = saved.brush;
        for (const brush in presets) Object.assign(this.pens[brush], saved.pens?.[brush]);
        Object.assign(this.eraser, saved.eraser);
      }
      this.sync();
    }).catch(() => {});
  }

  get type() { return this.reader.tool === 'marker' ? 'marker' : this.brush; }
  get pen() { return this.pens[this.type]; }

  update(target, key, value) {
    target[key] = value;
    this.sync();
    this.save();
  }

  save() {
    this.changed = true;
    saveState('inkTools', { brush: this.brush, pens: this.pens, eraser: this.eraser }).catch(() => {});
  }

  toggle(open) {
    this.panel.hidden = !open;
    byId('ink-config').setAttribute('aria-expanded', String(open));
    if (open) this.sync();
  }

  sync() {
    const erasing = this.reader.tool === 'eraser';
    byId('pen-options').hidden = erasing;
    byId('eraser-options').hidden = !erasing;
    byId('ink-heading').textContent = erasing ? '橡皮擦' : '笔刷';
    for (const [id, key] of this.controls) {
      const control = byId(id);
      const value = (id.startsWith('ink-') ? this.pen : this.eraser)[key];
      if (control.type === 'checkbox') control.checked = value;
      else control.value = value;
      const output = control.parentElement.querySelector('output');
      if (output) output.value = value + (id === 'ink-opacity' ? '%' : '');
    }
    byId('erase-sensitivity').disabled = !this.eraser.pressure || this.eraser.mode === 'lasso';
    byId('erase-size').disabled = this.eraser.mode === 'lasso';
    for (const button of this.panel.querySelectorAll('[data-brush], [data-erase], [data-color]')) {
      const { brush, erase, color } = button.dataset;
      button.setAttribute('aria-pressed', String(brush === this.type || erase === this.eraser.mode || color === this.pen.color));
    }
    if (this.panel.hidden) return;
    const points = Array.from({ length: 47 }, (_, i) => ({
      x: .12 + i * .76 / 46, y: .5 + Math.sin(i / 4) * .21,
      pressure: .26 + .65 * Math.sin(i * Math.PI / 46),
    }));
    let strokes = [erasing
      ? { tool: 'marker', brush: 'felt', color: '#536552', opacity: .82, size: 7, points }
      : this.stroke(points, 0)];
    if (erasing && this.eraser.mode === 'point') {
      strokes = eraseAt(strokes, points[23], 260, 53, this.eraser.size / 2, { ...this.eraser, zoom: 1 });
    } else if (erasing && this.eraser.mode === 'lasso') {
      strokes = [...strokes, { ...strokes[0], color: '#758b78', points: [
        { x: .39, y: .13 }, { x: .66, y: .13 }, { x: .66, y: .88 }, { x: .39, y: .88 }, { x: .39, y: .13 },
      ], size: 1 }];
    } else if (erasing) {
      strokes[0].opacity = .24;
    }
    paintStrokes(this.preview, strokes, 1, null, 260);
  }

  stroke(points, basis) {
    return { tool: this.reader.tool, brush: this.type, ...this.pen, opacity: this.pen.opacity / 100, points, basis };
  }

  radius(point, stylus) {
    const sensitivity = this.eraser.pressure && stylus ? this.eraser.sensitivity / 100 : 0;
    return this.eraser.size / 2 * (1 + (point.pressure - .5) * 1.5 * sensitivity);
  }

  erase(strokes, path, point, width, height, zoom, stylus) {
    if (this.eraser.mode === 'lasso') return eraseInside(strokes, path, this.eraser.markerOnly);
    return eraseAt(strokes, point, width, height, this.radius(point, stylus), { ...this.eraser, zoom });
  }
}
