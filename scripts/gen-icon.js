'use strict';

// Generates the app/tray icons with zero dependencies (raw PNG encoding):
//   assets/icon.png            32x32 color icon (Windows/Linux tray + window icon)
//   assets/trayTemplate.png    16x16 macOS menu-bar template image (black + alpha)
//   assets/trayTemplate@2x.png 32x32 retina variant
// Electron treats *Template.png names as macOS template images automatically.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function canvas(size) {
  const px = Buffer.alloc(size * size * 4); // RGBA

  function setPx(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }

  function insideRoundRect(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + r; // +r softens corners a touch
  }

  function fillRoundRect(x0, y0, x1, y1, r, color) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (insideRoundRect(x, y, x0, y0, x1, y1, r)) setPx(x, y, color);
  }

  return { px, size, fillRoundRect };
}

// ---- PNG encoding ----

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ px, size }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawings ----

function colorIcon() {
  const c = canvas(32);
  c.fillRoundRect(1, 1, 30, 30, 8, [30, 30, 38, 255]); // card background
  c.fillRoundRect(6, 9, 25, 13, 2, [217, 119, 87, 255]); // Claude bar (orange), fuller
  c.fillRoundRect(6, 19, 18, 23, 2, [105, 179, 162, 255]); // Codex bar (teal), shorter
  c.fillRoundRect(19, 19, 25, 23, 2, [70, 70, 82, 255]); // faint track remainder
  return c;
}

// Template images must be black + alpha only; macOS recolors them for the menu bar.
function templateIcon(scale) {
  const c = canvas(16 * scale);
  const k = (n) => n * scale;
  const bar = [0, 0, 0, 255];
  const track = [0, 0, 0, 70];
  c.fillRoundRect(k(2), k(4), k(13), k(6), scale, bar);
  c.fillRoundRect(k(2), k(10), k(13), k(12), scale, track);
  c.fillRoundRect(k(2), k(10), k(9), k(12), scale, bar);
  return c;
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, c] of [
  ['icon.png', colorIcon()],
  ['trayTemplate.png', templateIcon(1)],
  ['trayTemplate@2x.png', templateIcon(2)],
]) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodePng(c));
  console.log('wrote', file);
}
