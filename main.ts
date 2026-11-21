// The Banana Straightener — catalogue photograph of an impossible gadget.
// Renders a studio product shot (1024x1024 PNG) to /output/entry.png.
// Node 22, standard library only (node:fs, node:zlib, node:path).
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import * as path from "node:path";

const W = 1024;
const H = 1024;
const S = 2; // supersample factor
const RW = W * S;
const RH = H * S;

const buf = new Uint8Array(RW * RH * 3);

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Blend an RGB colour over the pixel at 1x-space coordinates (cx, cy are
// pixel indices in the supersampled buffer).
function blend(i: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  if (a >= 1) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    return;
  }
  buf[i] = buf[i] * (1 - a) + r * a;
  buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
  buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
}

// ---- background: warm pale-grey seamless sweep + light pool + vignette ----
{
  const top: [number, number, number] = [236, 234, 230];
  const bot: [number, number, number] = [216, 213, 208];
  for (let y = 0; y < RH; y++) {
    const t = y / (RH - 1);
    const br = lerp(top[0], bot[0], t);
    const bg = lerp(top[1], bot[1], t);
    const bb = lerp(top[2], bot[2], t);
    for (let x = 0; x < RW; x++) {
      const dx = (x / S - 512) / 560;
      const dy = (y / S - 420) / 560;
      const d = Math.sqrt(dx * dx + dy * dy);
      const pool = Math.max(0, 1 - d) ** 2 * 12; // soft radial light pool
      const vx = (x / S - 512) / 512;
      const vy = (y / S - 512) / 512;
      const vd = Math.sqrt(vx * vx + vy * vy);
      const vig = smoothstep(0.75, 1.45, vd) * 16; // faint corner vignette
      const i = (y * RW + x) * 3;
      buf[i] = clamp(br + pool - vig, 0, 255);
      buf[i + 1] = clamp(bg + pool - vig, 0, 255);
      buf[i + 2] = clamp(bb + pool - vig, 0, 255);
    }
  }
}

// ---- soft contact shadow (blurred ellipse, composited dark) ----
{
  const mask = new Float32Array(RW * RH);
  const cx = 512, cy = 700, rx = 330, ry = 40;
  for (let y = Math.floor((cy - ry) * S); y < Math.ceil((cy + ry) * S); y++) {
    if (y < 0 || y >= RH) continue;
    for (let x = Math.floor((cx - rx) * S); x < Math.ceil((cx + rx) * S); x++) {
      if (x < 0 || x >= RW) continue;
      const dx = (x / S - cx) / rx;
      const dy = (y / S - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) mask[y * RW + x] = 1 - d2;
    }
  }
  // separable box blur, radius 14 at 2x, 3 passes
  const tmp = new Float32Array(RW * RH);
  const R = 14;
  for (let p = 0; p < 3; p++) {
    for (let y = 0; y < RH; y++) {
      let acc = 0;
      const row = y * RW;
      for (let x = -R; x <= R; x++) acc += mask[row + clamp(x, 0, RW - 1)];
      for (let x = 0; x < RW; x++) {
        tmp[row + x] = acc / (2 * R + 1);
        acc += mask[row + clamp(x + R + 1, 0, RW - 1)] - mask[row + clamp(x - R, 0, RW - 1)];
      }
    }
    for (let x = 0; x < RW; x++) {
      let acc = 0;
      for (let y = -R; y <= R; y++) acc += tmp[clamp(y, 0, RH - 1) * RW + x];
      for (let y = 0; y < RH; y++) {
        mask[y * RW + x] = acc / (2 * R + 1);
        acc += tmp[clamp(y + R + 1, 0, RH - 1) * RW + x] - tmp[clamp(y - R, 0, RH - 1) * RW + x];
      }
    }
  }
  for (let i = 0; i < RW * RH; i++) {
    const v = mask[i] * 0.34;
    if (v > 0) {
      const j = i * 3;
      buf[j] *= 1 - v; buf[j + 1] *= 1 - v; buf[j + 2] *= 1 - v;
    }
  }
}

// ---- shape helpers (coordinates in 1x space, AA via signed distance) ----
function roundRectGrad(
  x0: number, y0: number, x1: number, y1: number, r: number,
  cTop: [number, number, number], cBot: [number, number, number], alpha = 1
): void {
  const px0 = Math.max(0, Math.floor(x0 * S)), px1 = Math.min(RW, Math.ceil(x1 * S));
  const py0 = Math.max(0, Math.floor(y0 * S)), py1 = Math.min(RH, Math.ceil(y1 * S));
  for (let y = py0; y < py1; y++) {
    const cy = (y + 0.5) / S;
    const t = clamp((cy - y0) / (y1 - y0), 0, 1);
    const cr = lerp(cTop[0], cBot[0], t);
    const cg = lerp(cTop[1], cBot[1], t);
    const cb = lerp(cTop[2], cBot[2], t);
    for (let x = px0; x < px1; x++) {
      const cx = (x + 0.5) / S;
      const qx = Math.abs(cx - (x0 + x1) / 2) - (x1 - x0) / 2 + r;
      const qy = Math.abs(cy - (y0 + y1) / 2) - (y1 - y0) / 2 + r;
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
      const d = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
      const cov = clamp(0.5 - d, 0, 1);
      if (cov > 0) blend((y * RW + x) * 3, cr, cg, cb, cov * alpha);
    }
  }
}

function ellipseGrad(
  cx: number, cy: number, rx: number, ry: number,
  cTop: [number, number, number], cBot: [number, number, number], alpha = 1
): void {
  const px0 = Math.max(0, Math.floor((cx - rx) * S)), px1 = Math.min(RW, Math.ceil((cx + rx) * S));
  const py0 = Math.max(0, Math.floor((cy - ry) * S)), py1 = Math.min(RH, Math.ceil((cy + ry) * S));
  for (let y = py0; y < py1; y++) {
    const yy = (y + 0.5) / S;
    const t = clamp((yy - (cy - ry)) / (2 * ry), 0, 1);
    const cr = lerp(cTop[0], cBot[0], t);
    const cg = lerp(cTop[1], cBot[1], t);
    const cb = lerp(cTop[2], cBot[2], t);
    for (let x = px0; x < px1; x++) {
      const xx = (x + 0.5) / S;
      const dx = (xx - cx) / rx, dy = (yy - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cov = clamp(1.5 - d * 1.5, 0, 1) * clamp((1 - d) * S + 0.5, 0, 1);
      if (d < 1) blend((y * RW + x) * 3, cr, cg, cb, Math.min(1, cov) * alpha);
    }
  }
}

function fillRect(x0: number, y0: number, x1: number, y1: number,
  c: [number, number, number], alpha = 1): void {
  const px0 = Math.max(0, Math.floor(x0 * S)), px1 = Math.min(RW, Math.ceil(x1 * S));
  const py0 = Math.max(0, Math.floor(y0 * S)), py1 = Math.min(RH, Math.ceil(y1 * S));
  for (let y = py0; y < py1; y++) {
    for (let x = px0; x < px1; x++) blend((y * RW + x) * 3, c[0], c[1], c[2], alpha);
  }
}

// Convex polygon fill with vertical gradient and edge AA.
function polyGrad(pts: [number, number][], cTop: [number, number, number],
  cBot: [number, number, number], alpha = 1): void {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const px0 = Math.max(0, Math.floor(minX * S)), px1 = Math.min(RW, Math.ceil(maxX * S));
  const py0 = Math.max(0, Math.floor(minY * S)), py1 = Math.min(RH, Math.ceil(maxY * S));
  for (let y = py0; y < py1; y++) {
    const cy = (y + 0.5) / S;
    const t = clamp((cy - minY) / (maxY - minY), 0, 1);
    const cr = lerp(cTop[0], cBot[0], t);
    const cg = lerp(cTop[1], cBot[1], t);
    const cb = lerp(cTop[2], cBot[2], t);
    for (let x = px0; x < px1; x++) {
      const cx = (x + 0.5) / S;
      let allPos = true, allNeg = true;
      let minD = 1e9;
      for (let e = 0; e < pts.length; e++) {
        const [ax, ay] = pts[e];
        const [bx, by] = pts[(e + 1) % pts.length];
        const ex = bx - ax, ey = by - ay;
        const cross = ex * (cy - ay) - ey * (cx - ax);
        const len = Math.sqrt(ex * ex + ey * ey);
        const d = cross / len; // signed distance to edge
        if (d > 0) allNeg = false;
        if (d < 0) allPos = false;
        minD = Math.min(minD, Math.abs(d));
      }
      const inside = allPos || allNeg;
      if (!inside) continue;
      const cov = clamp(minD + 0.5, 0, 1);
      blend((y * RW + x) * 3, cr, cg, cb, cov * alpha);
    }
  }
}

// Circle with radial shading (for rollers and the knob).
function shadedCircle(cx: number, cy: number, r: number,
  base: [number, number, number], hi: [number, number, number], alpha = 1): void {
  const px0 = Math.max(0, Math.floor((cx - r) * S)), px1 = Math.min(RW, Math.ceil((cx + r) * S));
  const py0 = Math.max(0, Math.floor((cy - r) * S)), py1 = Math.min(RH, Math.ceil((cy + r) * S));
  for (let y = py0; y < py1; y++) {
    const yy = (y + 0.5) / S;
    for (let x = px0; x < px1; x++) {
      const xx = (x + 0.5) / S;
      const dx = (xx - cx) / r, dy = (yy - cy) / r;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) continue;
      const shade = clamp(0.62 - 0.45 * dy - 0.25 * dx, 0, 1.15);
      const spec = Math.exp(-((dx + 0.42) ** 2 + (dy + 0.42) ** 2) / 0.10) * 0.85;
      const rim = 1 - 0.35 * smoothstep(0.82, 1, d);
      const cr = clamp(base[0] * shade + hi[0] * spec, 0, 255) * rim;
      const cg = clamp(base[1] * shade + hi[1] * spec, 0, 255) * rim;
      const cb = clamp(base[2] * shade + hi[2] * spec, 0, 255) * rim;
      const cov = clamp((1 - d) * S + 0.5, 0, 1);
      blend((y * RW + x) * 3, cr, cg, cb, cov * alpha);
    }
  }
}

// ---- device: anodized-aluminum press, three-quarter view ----
// Top face (parallelogram, lighter silver).
polyGrad([[250, 470], [310, 408], [814, 408], [774, 470]], [226, 229, 233], [196, 200, 206]);
// Front face.
roundRectGrad(250, 470, 774, 665, 14, [216, 220, 226], [178, 183, 191]);
// Subtle horizontal brushed bands on the front face (flat, compression-friendly).
for (let y = 486; y < 660; y += 18) {
  fillRect(258, y, 766, y + 1, [255, 255, 255], 0.05);
  fillRect(258, y + 2, 766, y + 3, [90, 96, 104], 0.05);
}
// Bright edge highlight along the top-left, cool rim on the right edges.
fillRect(250, 470, 774, 472.5, [245, 247, 250], 0.9);
fillRect(771.5, 470, 774, 665, [120, 128, 138], 0.5);
fillRect(250, 470, 252.5, 665, [240, 242, 246], 0.55);
// Seam line where the top face meets the front face.
fillRect(252, 468, 772, 469.5, [140, 146, 154], 0.6);

// ---- channel: dark slot the banana runs through ----
roundRectGrad(256, 542, 768, 592, 8, [52, 55, 61], [40, 43, 48]);

// ---- banana: dead straight, protruding from both ends ----
roundRectGrad(196, 548, 830, 588, 19, [255, 224, 77], [243, 180, 28]);
fillRect(210, 550, 816, 555, [255, 240, 130], 0.55); // top-edge highlight
fillRect(210, 583, 816, 587, [214, 150, 16], 0.45); // deeper bottom edge
// Small brown stem nub at the left tip.
fillRect(192, 560, 200, 576, [120, 84, 40], 0.9);
// Tiny brown speckles near the right tip.
const speckles: [number, number, number][] = [
  [792, 560, 2.2], [806, 570, 1.8], [798, 578, 1.5], [814, 562, 1.6], [782, 572, 1.4],
];
for (const [sx, sy, sr] of speckles) {
  ellipseGrad(sx, sy, sr, sr, [122, 88, 34], [110, 78, 30], 0.65);
}

// ---- three charcoal-rubber rollers pressing down on the banana ----
for (const rx of [380, 512, 644]) {
  shadedCircle(rx, 545, 36, [58, 61, 67], [210, 214, 220]);
  shadedCircle(rx, 545, 11, [140, 145, 152], [220, 224, 230]); // axle hub
  fillRect(rx - 1.5, 534, rx + 1.5, 556, [40, 42, 46], 0.8); // axle pin
}

// ---- bubble level on the top face ----
roundRectGrad(430, 419, 594, 443, 11, [206, 226, 208], [178, 202, 182], 0.92);
fillRect(432, 421, 592, 423, [255, 255, 255], 0.5);
shadedCircle(512, 431, 7.5, [64, 178, 92], [190, 245, 205]); // centred green bubble
fillRect(478, 429.5, 484, 432.5, [90, 110, 96], 0.8); // level marks
fillRect(540, 429.5, 546, 432.5, [90, 110, 96], 0.8);

// ---- adjustment screw: safety-orange knob on the top face ----
shadedCircle(706, 434, 24, [255, 138, 26], [255, 205, 120]);
fillRect(690, 432, 722, 436, [150, 62, 0], 0.85); // screwdriver slot
shadedCircle(706, 434, 6, [210, 92, 0], [255, 170, 90]);

// ---- tiny product text on the front face: "CURVATURE: ZERO" ----
// Minimal 5x7 bitmap font for exactly the glyphs used.
const FONT: Record<string, string[]> = {
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  ":": ["00000", "00100", "00000", "00000", "00000", "00100", "00000"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
{
  const text = "CURVATURE: ZERO";
  const scale = 2; // each font pixel is 2x2 units
  const adv = 6 * scale; // 5px glyph + 1px gap
  const tw = text.length * adv - scale;
  let tx = (W - tw) / 2;
  const ty = 612;
  for (const ch of text) {
    const glyph = FONT[ch];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") {
          fillRect(tx + col * scale, ty + row * scale, tx + (col + 1) * scale, ty + (row + 1) * scale, [58, 62, 68], 0.9);
        }
      }
    }
    tx += adv;
  }
}

// ---- downsample 2x2 box average to 1024x1024 ----
const out = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < S; dy++) {
      for (let dx = 0; dx < S; dx++) {
        const i = ((y * S + dy) * RW + x * S + dx) * 3;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      }
    }
    out[o] = Math.round(r / (S * S));
    out[o + 1] = Math.round(g / (S * S));
    out[o + 2] = Math.round(b / (S * S));
  }
}

// ---- minimal PNG encoder: IHDR / IDAT / IEND, RGB 8-bit, filter 0 ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter: None
  raw.set(out.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type 2 = RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);

fs.mkdirSync("/output", { recursive: true });
fs.writeFileSync("/output/entry.png", png);
console.log(`wrote /output/entry.png ${png.length} bytes`);
