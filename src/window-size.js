'use strict';

function sizeKey(settings) {
  return `${settings.minimalistic ? 'minimal' : 'full'}-${settings.layout}`;
}

function minimumSize(settings) {
  if (!settings.minimalistic) return { width: 240, height: 160 };
  return settings.layout === 'gauge' ? { width: 140, height: 140 } : { width: 180, height: 40 };
}

function resizeBounds(bounds, edge, delta, minimum) {
  let { x, y, width, height } = bounds;
  if (edge.includes('e') || edge.includes('w')) {
    width = Math.max(minimum.width, Math.min(1200, bounds.width + (edge.includes('w') ? -delta.x : delta.x)));
    if (edge.includes('w')) x += bounds.width - width;
  }
  if (edge.includes('n') || edge.includes('s')) {
    height = Math.max(minimum.height, Math.min(1000, bounds.height + (edge.includes('n') ? -delta.y : delta.y)));
    if (edge.includes('n')) y += bounds.height - height;
  }
  return { x, y, width, height };
}

module.exports = { sizeKey, minimumSize, resizeBounds };
