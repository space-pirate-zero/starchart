#!/usr/bin/env node
// Generates the X-Ray toolbar icons: a cel-shaded hot-pink star on black, as PNGs.
// Dependency-free: rasterises with 4x4 supersampling and encodes PNG with node:zlib.
// Usage: node scripts/make-icons.mjs   (writes icons/icon-{16,32,48,128}.png)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZES = [16, 32, 48, 128];
const PINK = [0xff, 0x14, 0x93];
const INK = [0x00, 0x00, 0x00];
const SURFACE = [0x03, 0x03, 0x03];
const GREEN = [0x00, 0xff, 0x41];
const SAMPLES = 4;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Five-pointed star polygon centred at (cx, cy). */
function star(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function inside(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function inRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function render(size) {
  const s = size;
  const radius = s * 0.18;
  const cx = s * 0.47;
  const cy = s * 0.52;
  const outline = Math.max(1, s * 0.07);
  const outer = s * 0.44;
  const inner = outer * 0.45;
  const fillStar = star(cx, cy, outer, inner);
  const inkStar = star(cx, cy, outer + outline, inner + outline * 0.6);
  const shadowOffset = Math.max(1, s * 0.06);
  const shadowStar = star(cx + shadowOffset, cy + shadowOffset, outer + outline, inner + outline * 0.6);
  const out = Buffer.alloc(s * s * 4);

  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          if (!inRoundedSquare(x, y, s, radius)) continue;
          let color = SURFACE;
          if (inside(fillStar, x, y)) color = PINK;
          else if (inside(inkStar, x, y)) color = INK;
          else if (inside(shadowStar, x, y)) color = GREEN;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const i = (py * s + px) * 4;
      const n = SAMPLES * SAMPLES;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(s, out);
}

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(iconsDir, { recursive: true });
for (const size of SIZES) {
  const file = join(iconsDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  process.stdout.write(`wrote ${file}\n`);
}
