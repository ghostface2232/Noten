// Pixel difference of the before/after screenshot pairs that `run.mjs
// --visual` wrote: differing pixel count, their bounding box and the largest
// channel delta. Decodes 8-bit RGB/RGBA non-interlaced PNG (what CDP emits)
// with zlib only, so the bench keeps no image dependency.
//   node bench/pngdiff.mjs [<cache>/results/visual]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const CACHE = process.env.NOTEN_BENCH_CACHE ?? join(process.env.LOCALAPPDATA, "noten-bench");
const dir = process.argv[2] ?? join(CACHE, "results", "visual");

function decode(buf) {
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error(`unsupported color type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

for (const f of readdirSync(dir).filter((n) => n.endsWith("-before.png")).sort()) {
  const a = decode(readFileSync(join(dir, f)));
  const b = decode(readFileSync(join(dir, f.replace("-before", "-after"))));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`${f}: size ${a.width}x${a.height} -> ${b.width}x${b.height}`);
    continue;
  }
  let n = 0, maxDelta = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      let d = 0;
      for (let ch = 0; ch < 3; ch++) {
        d = Math.max(d, Math.abs(a.data[(y * a.width + x) * a.channels + ch] - b.data[(y * b.width + x) * b.channels + ch]));
      }
      if (d) {
        n++; maxDelta = Math.max(maxDelta, d);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  // A whole-pixel vertical move shows up as an exact match at some dy; a
  // sub-pixel move (anti-aliasing only) matches at no dy.
  let shift = "";
  if (n) {
    const px = (img, x, y, ch) => img.data[(y * img.width + x) * img.channels + ch];
    for (const dy of [-2, -1, 1, 2]) {
      let bad = 0;
      for (let y = Math.max(y0, -dy); y <= Math.min(y1, a.height - 1 - dy); y++) {
        for (let x = x0; x <= x1 && bad === 0; x++) {
          for (let ch = 0; ch < 3; ch++) if (px(a, x, y, ch) !== px(b, x, y + dy, ch)) { bad++; break; }
        }
      }
      if (bad === 0) { shift = `, equals before moved dy=${dy}`; break; }
    }
  }
  console.log(`${f.replace("-before.png", "")}: ${n} px differ${n ? `, box (${x0},${y0})-(${x1},${y1}), max delta ${maxDelta}${shift}` : ""}`);
}
