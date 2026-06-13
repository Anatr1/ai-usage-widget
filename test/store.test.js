'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/store');

test('store round-trips values through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-store-'));
  store.init(dir);
  store.set({ foo: 1, bar: 'x' });

  store.init(dir); // reload from disk
  assert.equal(store.get('foo'), 1);
  assert.equal(store.get('bar'), 'x');
  assert.equal(store.get('missing', 'fallback'), 'fallback');
});

test('store survives a corrupt config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-store-'));
  fs.writeFileSync(path.join(dir, 'widget-config.json'), '{not json');
  store.init(dir);
  assert.equal(store.get('anything', 'default'), 'default');
  store.set({ recovered: true });
  store.init(dir);
  assert.equal(store.get('recovered'), true);
});
