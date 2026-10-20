/**
 * 生成应用图标（build/icon.ico + build/icon.png）。
 *
 * 不依赖任何图形库：用 zlib 手工编码 PNG，再把多个尺寸的 PNG 打包成 ICO
 * （Vista 之后 ICO 允许直接内嵌 PNG 数据）。图形是左侧实心、右侧描边的
 * 两个面板，中间用比较符号分开，对应「文件比较」这一主功能。
 *
 * 运行：node build/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = __dirname;

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- 绘制 ---
const roundRect = (x, y, w, h, r, px, py) => {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r && px >= x && px <= x + w && py >= y && py <= y + h;
};

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = size / 32; // 以 32 为设计网格
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    // 简单 alpha 混合：叠加在已有像素上
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };

  // 4x 超采样抗锯齿
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0; let left = 0; let right = 0; let rightBorder = 0; let gap = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / S;
          const v = (y + (sy + 0.5) / SS) / S;
          if (roundRect(1.5, 1.5, 29, 29, 7, u, v)) bg++;
          // 左面板（实心）
          if (roundRect(5, 8, 8.5, 16, 1.6, u, v)) left++;
          // 右面板（描边）
          const inOuter = roundRect(18.5, 8, 8.5, 16, 1.6, u, v);
          const inInner = roundRect(20, 9.5, 5.5, 13, 1.1, u, v);
          if (inOuter && !inInner) right++;
          // 中间的比较符号：两个短横
          if (roundRect(14.6, 12.2, 2.8, 1.5, 0.6, u, v)) gap++;
          if (roundRect(14.6, 18.3, 2.8, 1.5, 0.6, u, v)) gap++;
        }
      }
      const n = SS * SS;
      if (bg) put(x, y, 0x2f, 0x6f, 0xed, Math.round((bg / n) * 255));
      if (gap) put(x, y, 0xe8, 0xef, 0xff, Math.round((gap / n) * 255));
      if (left) put(x, y, 0xff, 0xff, 0xff, Math.round((left / n) * 255));
      if (right) put(x, y, 0xc7, 0xd8, 0xff, Math.round((right / n) * 255));
      void rightBorder;
    }
  }
  return px;
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);             // planes
    e.writeUInt16LE(32, 6);            // bpp
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: encodePng(size, render(size)) }));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(images));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), images.at(-1).data);
console.log('icon.ico', fs.statSync(path.join(OUT_DIR, 'icon.ico')).size, 'bytes |',
  'icon.png', fs.statSync(path.join(OUT_DIR, 'icon.png')).size, 'bytes');
