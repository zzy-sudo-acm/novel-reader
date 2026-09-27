// 生成 PWA 图标：深色圆角方块 + 白色打开的书本图形
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function makeIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * 0.22;
  const bg = [26, 26, 30];
  const fg = [240, 230, 200];
  // 书页（左右两个四边形），maskable 图标缩小一点留出安全区
  const g = maskable ? 0.8 : 1;
  const cx = (v) => size * (0.5 + (v - 0.5) * g);
  const cy = (v) => size * (0.5 + (v - 0.5) * g);
  const left = [
    [cx(0.2), cy(0.32)],
    [cx(0.48), cy(0.4)],
    [cx(0.48), cy(0.74)],
    [cx(0.2), cy(0.66)],
  ];
  const right = [
    [cx(0.52), cy(0.4)],
    [cx(0.8), cy(0.32)],
    [cx(0.8), cy(0.66)],
    [cx(0.52), cy(0.74)],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // 圆角外透明
      if (radius > 0) {
        const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
        const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
        if (dx * dx + dy * dy > radius * radius) {
          px[o + 3] = 0;
          continue;
        }
      }
      const inBook = pointInPoly(x, y, left) || pointInPoly(x, y, right);
      const c = inBook ? fg : bg;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
  }
  return encodePNG(size, px);
}

const outDir = path.resolve(import.meta.dirname, '../public/icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makeIcon(192, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makeIcon(512, false));
fs.writeFileSync(path.join(outDir, 'maskable-512.png'), makeIcon(512, true));
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), makeIcon(180, false));
console.log('icons written to', outDir);
