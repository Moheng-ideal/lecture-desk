import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eraseAt, eraseInside } from '../src/ink.js';

const line = (tool = 'pen', y = .5) => ({
  tool, size: 3,
  points: [{ x: .1, y, pressure: .3 }, { x: .9, y, pressure: .7 }],
});
const center = { x: .5, y: .5 };

test('point erase splits a long stroke in place and preserves its original data for undo', () => {
  const original = [line()];
  const after = eraseAt(original, center, 400, 400, 20, { mode: 'point', zoom: 1 });
  assert.equal(after.length, 2);
  assert.equal(after[0].points[0].x, .1);
  assert.ok(after[0].points.at(-1).x < .45);
  assert.ok(after[1].points[0].x > .55);
  assert.equal(after[1].points.at(-1).x, .9);
  assert.equal(original[0].points.length, 2);
});

test('stroke and lasso modes only erase matching kinds when highlighter-only is on', () => {
  const pen = line();
  const marker = line('marker');
  const outside = line('marker', .8);
  const polygon = [{ x: .4, y: .4 }, { x: .6, y: .4 }, { x: .6, y: .6 }, { x: .4, y: .6 }];
  const original = [pen, marker, outside];
  assert.deepEqual(eraseAt(original, center, 400, 400, 12, { mode: 'stroke', markerOnly: true, zoom: 1 }), [pen, outside]);
  assert.deepEqual(eraseInside(original, polygon, true), [pen, outside]);
});
