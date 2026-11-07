// SKETCHPAD helpers: colour maths, flood fill, pixel adjustments, blur and
// QuickShape recognition. Pure functions -- no DOM, no state -- so they are
// easy to test on their own.

export { clamp } from './utils.js'; // one shared copy; re-exported so the sketch modules keep importing it from here
import { clamp } from './utils.js';
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- colour
export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex(r, g, b) {
  const x = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}
// h 0..360, s 0..1, v 0..1
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}
export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// ------------------------------------------------------------- flood fill
// data: RGBA bytes of a w x h image. Returns { mask, minx, miny, maxx, maxy }
// where mask[y*w+x] = 1 for every pixel connected to (sx, sy) whose colour is
// within `tol` (0..255, per channel, alpha included) of the seed pixel.
export function floodFill(data, w, h, sx, sy, tol) {
  const mask = new Uint8Array(w * h);
  sx = clamp(Math.round(sx), 0, w - 1);
  sy = clamp(Math.round(sy), 0, h - 1);
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0]; const g0 = data[i0 + 1]; const b0 = data[i0 + 2]; const a0 = data[i0 + 3];
  const match = (p) => {
    const i = p * 4;
    const a = data[i + 3];
    if (a0 < 8 && a < 8) return true; // two see-through pixels are the same
    return Math.abs(a - a0) <= tol && Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol;
  };
  let minx = sx; let maxx = sx; let miny = sy; let maxy = sy;
  const stack = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop();
    if (mask[p] || !match(p)) continue;
    const y = Math.floor(p / w);
    const row = y * w;
    let lx = p - row;
    let rx = lx;
    while (lx > 0 && !mask[row + lx - 1] && match(row + lx - 1)) lx--;
    while (rx < w - 1 && !mask[row + rx + 1] && match(row + rx + 1)) rx++;
    for (let x = lx; x <= rx; x++) mask[row + x] = 1;
    if (lx < minx) minx = lx;
    if (rx > maxx) maxx = rx;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
    for (const yy of [y - 1, y + 1]) {
      if (yy < 0 || yy >= h) continue;
      let inSpan = false;
      for (let x = lx; x <= rx; x++) {
        const q = yy * w + x;
        if (!mask[q] && match(q)) {
          if (!inSpan) { stack.push(q); inSpan = true; }
        } else inSpan = false;
      }
    }
  }
  return { mask, minx, miny, maxx, maxy };
}

// Grow a fill mask by `n` pixels (4-neighbourhood) so the fill tucks under
// anti-aliased line edges instead of leaving a pale halo.
export function dilateMask(res, w, h, n) {
  let { mask, minx, miny, maxx, maxy } = res;
  for (let k = 0; k < n; k++) {
    const x0 = Math.max(0, minx - 1); const x1 = Math.min(w - 1, maxx + 1);
    const y0 = Math.max(0, miny - 1); const y1 = Math.min(h - 1, maxy + 1);
    const next = mask.slice();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * w + x;
        if (mask[p]) continue;
        if ((x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (y > 0 && mask[p - w]) || (y < h - 1 && mask[p + w])) next[p] = 1;
      }
    }
    mask = next; minx = x0; maxx = x1; miny = y0; maxy = y1;
  }
  return { mask, minx, miny, maxx, maxy };
}

// ------------------------------------------------------------ adjustments
// In place on ImageData.data. hue in degrees, sat/bri/con in -1..1.
export function adjustPixels(data, { hue = 0, sat = 0, bri = 0, con = 0, invert = false } = {}) {
  const sF = 1 + sat;
  const cF = 1 + con;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (!a) continue;
    let r = data[i]; let g = data[i + 1]; let b = data[i + 2];
    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    if (hue || sat) {
      const hsv = rgbToHsv(r, g, b);
      const rgb = hsvToRgb(hsv[0] + hue, clamp(hsv[1] * sF, 0, 1), hsv[2]);
      r = rgb[0]; g = rgb[1]; b = rgb[2];
    }
    if (bri) { r += bri * 255; g += bri * 255; b += bri * 255; }
    if (con) { r = (r - 128) * cF + 128; g = (g - 128) * cF + 128; b = (b - 128) * cF + 128; }
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}

// Box blur (three passes ~ gaussian) on premultiplied RGBA so transparent
// edges don't smear dark.
export function blurPixels(data, w, h, radius) {
  const r = Math.round(radius);
  if (r < 1) return;
  const n = w * h;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3] / 255;
    ch[0][p] = data[p * 4] * a; ch[1][p] = data[p * 4 + 1] * a; ch[2][p] = data[p * 4 + 2] * a; ch[3][p] = data[p * 4 + 3];
  }
  const tmp = new Float32Array(n);
  const pass = (src, horizontal) => {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const stride = horizontal ? 1 : w;
    const win = 2 * r + 1;
    for (let l = 0; l < lines; l++) {
      const base = horizontal ? l * w : l;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + clamp(k, 0, len - 1) * stride];
      for (let k = 0; k < len; k++) {
        tmp[base + k * stride] = sum / win;
        sum += src[base + clamp(k + r + 1, 0, len - 1) * stride] - src[base + clamp(k - r, 0, len - 1) * stride];
      }
    }
    src.set(tmp);
  };
  for (const c of ch) { for (let k = 0; k < 3; k++) { pass(c, true); pass(c, false); } }
  for (let p = 0; p < n; p++) {
    const a = ch[3][p];
    const f = a > 0.5 ? 255 / a : 0;
    data[p * 4] = ch[0][p] * f; data[p * 4 + 1] = ch[1][p] * f; data[p * 4 + 2] = ch[2][p] * f; data[p * 4 + 3] = a;
  }
}

// ------------------------------------------------------------ QuickShape
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}
function perpDistance(p, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}
// Ramer-Douglas-Peucker
export function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0; let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = simplify(pts.slice(0, idx + 1), eps);
  const right = simplify(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

// Looks at a freehand stroke and returns the shape it was trying to be:
// { type: 'line' | 'ellipse' | 'polygon', pts: [[x, y], ...] } (a polyline to
// draw) or null when it doesn't look like anything in particular.
export function recognizeShape(raw) {
  if (!raw || raw.length < 4) return null;
  const L = pathLength(raw);
  if (L < 24) return null;
  const first = raw[0]; const last = raw[raw.length - 1];
  const chord = dist(first, last);
  const closed = chord < 0.18 * L;
  if (!closed) {
    let maxDev = 0;
    raw.forEach((p) => { maxDev = Math.max(maxDev, perpDistance(p, first, last)); });
    if (maxDev < 0.07 * chord) return { type: 'line', pts: [first, last] };
    return null;
  }
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  raw.forEach((p) => { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); });
  const w = maxx - minx; const h = maxy - miny;
  if (w < 8 || h < 8) return null;
  // corners first: a handful of sharp corners -> polygon
  const corners = simplify(raw.concat([raw[0]]), 0.045 * L);
  if (corners.length - 1 >= 3 && corners.length - 1 <= 6) {
    let pts = corners.slice(0, -1);
    if (pts.length === 4) {
      // near-axis-aligned four-cornered shape -> a tidy rectangle
      const aligned = pts.every((p, i) => {
        const q = pts[(i + 1) % 4];
        const ang = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2);
        return Math.min(ang, Math.PI / 2 - ang) < 0.14;
      });
      if (aligned) pts = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]];
    }
    return { type: 'polygon', pts: pts.concat([pts[0]]) };
  }
  // otherwise: round? compare against the bounding ellipse
  const cx = (minx + maxx) / 2; const cy = (miny + maxy) / 2; const a = w / 2; const b = h / 2;
  let err = 0;
  raw.forEach((p) => { err += Math.abs(Math.hypot((p[0] - cx) / a, (p[1] - cy) / b) - 1); });
  err /= raw.length;
  if (err < 0.16) {
    const circle = Math.abs(a - b) / Math.max(a, b) < 0.14;
    const rx = circle ? (a + b) / 2 : a;
    const ry = circle ? (a + b) / 2 : b;
    const pts = [];
    for (let i = 0; i <= 72; i++) {
      const t = (i / 72) * Math.PI * 2;
      pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
    return { type: 'ellipse', pts };
  }
  return null;
}

// polygon points for a rectangle / ellipse dragged out from p0 to p1
export function shapePoints(kind, p0, p1, { square = false } = {}) {
  let [x0, y0] = p0; let [x1, y1] = p1;
  if (kind === 'line') return [p0, p1];
  if (square) {
    const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
  }
  if (kind === 'rect') return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; const rx = Math.abs(x1 - x0) / 2; const ry = Math.abs(y1 - y0) / 2;
  const pts = [];
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

// ------------------------------------------------------------- symmetry
// Copies of a point for a symmetry mode, mirrored about the page centre.
export function symmetryPoints(mode, x, y, W, H) {
  const cx = W / 2; const cy = H / 2;
  if (mode === 'v') return [[x, y], [2 * cx - x, y]];
  if (mode === 'h') return [[x, y], [x, 2 * cy - y]];
  if (mode === 'quad') return [[x, y], [2 * cx - x, y], [x, 2 * cy - y], [2 * cx - x, 2 * cy - y]];
  if (mode === 'radial') {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2;
      const dx = x - cx; const dy = y - cy;
      out.push([cx + dx * Math.cos(t) - dy * Math.sin(t), cy + dx * Math.sin(t) + dy * Math.cos(t)]);
    }
    return out;
  }
  return [[x, y]];
}
