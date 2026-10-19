// Writes build/icon.png (1024px): a rounded square split into three colored sectors, matching the in-app logo.
// electron-builder turns it into .ico / .icns. Run: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const COLORS = [[0x39, 0x87, 0xe5], [0xd9, 0x59, 0x26], [0x19, 0x9e, 0x70]]; // blue, orange, aqua

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** coverage of a rounded square (macOS-style margin) at pixel center, antialiased by distance */
function cover(x, y) {
  const m = SIZE * 0.1, r = SIZE * 0.2;
  const lo = m + r, hi = SIZE - m - r;
  const dx = Math.max(lo - x, 0, x - hi), dy = Math.max(lo - y, 0, y - hi);
  return Math.max(0, Math.min(1, r - Math.hypot(dx, dy) + 0.5));
}

const row = SIZE * 4 + 1;
const raw = Buffer.alloc(row * SIZE);
const c = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  raw[y * row] = 0;
  for (let x = 0; x < SIZE; x++) {
    // angle clockwise from 12 o'clock, like CSS conic-gradient
    const ang = (Math.atan2(x + 0.5 - c, -(y + 0.5 - c)) + 2 * Math.PI) % (2 * Math.PI);
    const col = COLORS[Math.min(2, Math.floor((ang / (2 * Math.PI)) * 3))];
    const o = y * row + 1 + x * 4;
    raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2];
    raw[o + 3] = Math.round(cover(x + 0.5, y + 0.5) * 255);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
