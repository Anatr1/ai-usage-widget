'use strict';

const fs = require('fs');
const path = require('path');

let filePath = null;
let cache = null;

function init(userDataDir) {
  filePath = path.join(userDataDir, 'widget-config.json');
  try {
    cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    cache = {};
  }
}

function get(key, fallback) {
  return cache && key in cache ? cache[key] : fallback;
}

function set(values) {
  if (!cache) cache = {};
  Object.assign(cache, values);
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* non-fatal: widget still works without persisted config */
  }
}

module.exports = { init, get, set };
