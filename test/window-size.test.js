'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resizeBounds, minimumSize, sizeKey } = require('../src/window-size');

const bounds = { x: 100, y: 200, width: 330, height: 300 };
const min = { width: 180, height: 40 };

test('resizes all edges and corners while keeping the opposite edges fixed', () => {
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const result = resizeBounds(bounds, edge, { x: 30, y: 20 }, min);
    if (edge.includes('w')) assert.equal(result.x + result.width, bounds.x + bounds.width);
    else assert.equal(result.x, bounds.x);
    if (edge.includes('n')) assert.equal(result.y + result.height, bounds.y + bounds.height);
    else assert.equal(result.y, bounds.y);
    assert.equal(result.width, edge.includes('w') ? 300 : edge.includes('e') ? 360 : 330);
    assert.equal(result.height, edge.includes('n') ? 280 : edge.includes('s') ? 320 : 300);
  }
});

test('clamps shrinking and expanding drags without moving the opposite corner', () => {
  assert.deepEqual(resizeBounds(bounds, 'nw', { x: 1000, y: 1000 }, min),
    { x: 250, y: 460, width: 180, height: 40 });
  assert.deepEqual(resizeBounds(bounds, 'se', { x: 2000, y: 2000 }, min),
    { x: 100, y: 200, width: 1200, height: 1000 });
});

test('each presentation has its own saved size and usable minimum', () => {
  const keys = new Set();
  for (const minimalistic of [false, true]) {
    for (const layout of ['bars', 'gauge']) {
      const settings = { minimalistic, layout };
      keys.add(sizeKey(settings));
      const size = minimumSize(settings);
      assert.ok(size.width >= 140 && size.height >= 40);
    }
  }
  assert.equal(keys.size, 4);
});
