import { eraseAt, eraseInside, paintStrokes } from './ink.js';
import { readState, saveState } from './storage.js';

const byId = (id) => document.getElementById(id);
const isInkTool = (tool) => ['pen', 'marker', 'eraser'].includes(tool);
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
  constructor(target, { host, button, modes, clear, prefix = '', storageKey = 'inkTools', clearLabel }) {
    this.target = target;
    this.button = button;
    this.storageKey = storageKey;
    this.brush = 'ball';
    this.pens = structuredClone(presets);
    this.eraser = { mode: 'point', size: 30, markerOnly: false, pressure: true, sensitivity: 72, returnToPen: false };
    this.panel = byId('ink-panel-template').content.firstElementChild.cloneNode(true);
    this.elements = new Map();
    for (const element of [this.panel, ...this.panel.querySelectorAll('[id]')]) {
      this.elements.set(element.id, element);
      element.id = prefix + element.id;
    }
    for (const output of this.panel.querySelectorAll('output[for]')) {
      output.setAttribute('for', prefix + output.getAttribute('for'));
    }
    host.append(this.panel);
    this.preview = this.get('ink-preview');
    for (const [name, color] of colors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = name;
      button.setAttribute('aria-label', name);
      button.dataset.color = color;
      button.style.setProperty('--swatch', color);
      button.onclick = () => this.update(this.pen, 'color', color);
      this.get('ink-swatches').append(button);
    }
    this.get('brush-choices').onclick = ({ target }) => {
      const brush = target.closest('[data-brush]')?.dataset.brush;
      if (!brush) return;
      if (brush !== 'marker') this.brush = brush;
      this.target.setTool(brush === 'marker' ? 'marker' : 'pen');
      this.save();
    };
    this.get('erase-choices').onclick = ({ target }) => {
      const mode = target.closest('[data-erase]')?.dataset.erase;
      if (mode) this.update(this.eraser, 'mode', mode);
    };
    this.controls = [
      ['ink-size', 'size'], ['ink-opacity', 'opacity'], ['ink-color', 'color'],
      ['erase-size', 'size'], ['erase-marker', 'markerOnly'], ['erase-pressure', 'pressure'],
      ['erase-sensitivity', 'sensitivity'], ['erase-return', 'returnToPen'],
    ];
    for (const [id, key] of this.controls) {
      this.get(id).oninput = ({ target }) => {
        const value = { checkbox: target.checked, range: target.valueAsNumber, color: target.value }[target.type];
        this.update(id.startsWith('ink-') ? this.pen : this.eraser, key, value);
      };
    }
    this.button.onclick = () => {
      if (!isInkTool(this.target.tool)) this.target.setTool('pen');
      this.toggle(this.panel.hidden);
    };
    this.get('ink-close').onclick = () => this.toggle(false);
    this.get('erase-page').onclick = clear;
    if (clearLabel) this.get('erase-page').textContent = clearLabel;
    document.addEventListener('pointerdown', ({ target }) => {
      if (!this.panel.hidden && !this.panel.contains(target) && !modes.contains(target) && !this.button.contains(target)) this.toggle(false);
    });
    document.addEventListener('keydown', ({ key }) => { if (key === 'Escape') this.toggle(false); });
    readState(this.storageKey).then((saved) => {
      if (saved && !this.changed) {
        if (presets[saved.brush] && saved.brush !== 'marker') this.brush = saved.brush;
        for (const brush in presets) Object.assign(this.pens[brush], saved.pens?.[brush]);
        Object.assign(this.eraser, saved.eraser);
      }
      this.sync();
    }).catch(() => {});
  }

  get(id) { return this.elements.get(id); }
  get type() { return this.target.tool === 'marker' ? 'marker' : this.brush; }
  get pen() { return this.pens[this.type]; }

  select(tool) {
    const open = this.panel.hidden || tool !== this.target.tool;
    this.target.setTool(tool);
    this.toggle(open && isInkTool(tool));
  }

  update(target, key, value) {
    target[key] = value;
    this.sync();
    this.save();
  }

  save() {
    this.changed = true;
    saveState(this.storageKey, { brush: this.brush, pens: this.pens, eraser: this.eraser }).catch(() => {});
  }

  toggle(open) {
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) this.sync();
  }

  sync() {
    const erasing = this.target.tool === 'eraser';
    this.get('pen-options').hidden = erasing;
    this.get('eraser-options').hidden = !erasing;
    this.get('ink-heading').textContent = erasing ? '橡皮擦' : '笔刷';
    for (const [id, key] of this.controls) {
      const control = this.get(id);
      const value = (id.startsWith('ink-') ? this.pen : this.eraser)[key];
      if (control.type === 'checkbox') control.checked = value;
      else control.value = value;
      const output = control.parentElement.querySelector('output');
      if (output) output.value = value + (id === 'ink-opacity' ? '%' : '');
    }
    this.get('erase-sensitivity').disabled = !this.eraser.pressure || this.eraser.mode === 'lasso';
    this.get('erase-size').disabled = this.eraser.mode === 'lasso';
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
    return { tool: this.target.tool === 'marker' ? 'marker' : 'pen', brush: this.type, ...this.pen,
      opacity: this.pen.opacity / 100, points, basis };
  }

  radius(point, stylus) {
    const sensitivity = this.eraser.pressure && stylus ? this.eraser.sensitivity / 100 : 0;
    return this.eraser.size / 2 * (1 + (point.pressure - .5) * 1.5 * sensitivity);
  }

  erase(strokes, path, point, width, height, zoom, stylus, radiusScale = 1) {
    if (this.eraser.mode === 'lasso') return eraseInside(strokes, path, this.eraser.markerOnly);
    return eraseAt(strokes, point, width, height, this.radius(point, stylus) * radiusScale, { ...this.eraser, zoom });
  }
}
