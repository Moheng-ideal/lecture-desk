import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eraseAt, eraseInside, traceInk } from '../src/ink.js';

const line = (tool = 'pen', y = .5) => ({
  tool, size: 3,
  points: [{ x: .1, y, pressure: .3 }, { x: .9, y, pressure: .7 }],
});
const center = { x: .5, y: .5 };

test('ink sampling rounds a corner and preserves the exact lifted endpoint', () => {
  const size = { width: 400, height: 400 };
  const first = { x: .2, y: .2, pressure: .2 };
  const corner = { x: .6, y: .2, pressure: .5 };
  const last = { x: .6, y: .6, pressure: .8 };
  const points = [first];
  let previous = traceInk(points, first, corner, size);
  previous = traceInk(points, previous, last, size);
  traceInk(points, previous, last, size, true);
  assert.equal(points[0], first);
  assert.deepEqual(points.at(-1), last);
  assert.ok(points.some(({ x, y }) => x > .4 && x < .6 && y > .2 && y < .4));
  assert.ok(points.every(({ pressure }) => pressure >= first.pressure && pressure <= last.pressure));
});

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
