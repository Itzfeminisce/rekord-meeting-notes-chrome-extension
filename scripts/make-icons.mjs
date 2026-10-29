// Writes public/icon/{16,32,48,128}.png: the TopBar brand mark (white sound bars) on a rounded accent square. No dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const ACCENT = [0x4f, 0x46, 0xe5];
// The mark's bars in its 24-unit viewBox: [x, y1, y2], stroke 2.2 with round caps.
const BARS = [[5, 9, 15], [9, 6, 18], [13, 9, 15], [17, 11, 13]];
const STROKE = 2.2;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** Coverage 0..1 of a pixel by a shape, using 4x4 supersampling for smooth edges. */
const coverage = (x, y, inside) => {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
  return hits / 16;
};

const png = (size) => {
  // Same proportions as .brand-mark: 28px square, 9px radius, 16px glyph.
  const r = size * (9 / 28);
  const c = size / 2;
  const unit = (size * (16 / 28)) / 24;
  // The bars span x 5..17, so centre on x 11 rather than the viewBox middle.
  const ox = c - 11 * unit;
  const oy = c - 12 * unit;
  const square = (px, py) => {
    const dx = Math.max(Math.abs(px - c) - (c - r), 0);
    const dy = Math.max(Math.abs(py - c) - (c - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const bars = (px, py) => {
    const ux = (px - ox) / unit;
    const uy = (py - oy) / unit;
    return BARS.some(([x, y1, y2]) => {
      const dy = Math.max(y1 - uy, 0, uy - y2);
      return (ux - x) ** 2 + dy * dy <= (STROKE / 2) ** 2;
    });
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, square);
      const w = coverage(x, y, bars);
      const o = 1 + x * 4;
      for (let i = 0; i < 3; i++) row[o + i] = Math.round(ACCENT[i] * (1 - w) + 255 * w);
      row[o + 3] = Math.round(a * 255);
    }
    rows.push(row);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

mkdirSync('public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icon/${size}.png`, png(size));
