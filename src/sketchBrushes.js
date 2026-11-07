// SKETCHPAD brushes: the preset list and the "stamp" engine behind them.
// A brush lays down a series of dabs (little pre-rendered tip images) along
// the path of the pointer. Tip shape, hardness, spacing, grain, pressure
// response and blend mode are what make a pencil feel unlike a watercolour.
import { clamp, lerp } from './sketchUtil.js';

// size/opacity defaults are applied when you pick the brush (you can still
// change them with the sliders afterwards).
//   tip: round | flat | square     hardness: 0 (airbrush soft) .. 1 (hard edge)
//   spacing: gap between dabs as a fraction of the brush width
//   flow: opacity of one dab (dabs add up inside a single stroke)
//   grain: 0..1 roughness of the tip      angle/aspect: for flat tips
//   pressureSize / pressureOpacity: respond to a pressure-sensitive stylus
//   blend: how the finished stroke meets the layer ('multiply' for highlighters)
export const BRUSHES = [
  { id: 'pencil', name: 'Pencil', icon: '✏️', tip: 'round', hardness: 0.85, spacing: 0.1, flow: 0.55, grain: 0.7, sizeMul: 1, pressureSize: true, pressureOpacity: true, minSize: 0.35, defSize: 5, defOpacity: 90 },
  { id: 'ink', name: 'Ink pen', icon: '🖋️', tip: 'round', hardness: 1, spacing: 0.06, flow: 1, grain: 0, sizeMul: 1, pressureSize: true, pressureOpacity: false, minSize: 0.25, defSize: 6, defOpacity: 100 },
  { id: 'marker', name: 'Marker', icon: '🖍️', tip: 'round', hardness: 0.95, spacing: 0.08, flow: 1, grain: 0, sizeMul: 1, pressureSize: false, pressureOpacity: false, minSize: 1, defSize: 16, defOpacity: 80 },
  { id: 'paint', name: 'Paint', icon: '🖌️', tip: 'round', hardness: 0.55, spacing: 0.07, flow: 0.85, grain: 0.1, sizeMul: 1, pressureSize: true, pressureOpacity: true, minSize: 0.3, defSize: 20, defOpacity: 100 },
  { id: 'watercolor', name: 'Watercolour', icon: '💧', tip: 'round', hardness: 0.2, spacing: 0.1, flow: 0.22, grain: 0.15, sizeMul: 1, pressureSize: true, pressureOpacity: true, minSize: 0.5, defSize: 34, defOpacity: 60 },
  { id: 'airbrush', name: 'Airbrush', icon: '🌫️', tip: 'round', hardness: 0, spacing: 0.07, flow: 0.12, grain: 0, sizeMul: 1, pressureSize: false, pressureOpacity: true, minSize: 1, defSize: 46, defOpacity: 100 },
  { id: 'crayon', name: 'Crayon', icon: '🖍', tip: 'round', hardness: 0.8, spacing: 0.18, flow: 0.9, grain: 1, sizeMul: 1, pressureSize: false, pressureOpacity: true, minSize: 1, defSize: 18, defOpacity: 95 },
  { id: 'charcoal', name: 'Charcoal', icon: '⬛', tip: 'round', hardness: 0.45, spacing: 0.14, flow: 0.6, grain: 0.95, sizeMul: 1, pressureSize: true, pressureOpacity: true, minSize: 0.4, defSize: 24, defOpacity: 100 },
  { id: 'calligraphy', name: 'Calligraphy', icon: '🪶', tip: 'flat', hardness: 1, spacing: 0.04, flow: 1, grain: 0, sizeMul: 1, angle: 40, aspect: 0.22, pressureSize: false, pressureOpacity: false, minSize: 1, defSize: 14, defOpacity: 100 },
  { id: 'highlighter', name: 'Highlighter', icon: '🟨', tip: 'flat', hardness: 1, spacing: 0.05, flow: 1, grain: 0, sizeMul: 1, angle: 0, aspect: 0.4, blend: 'multiply', pressureSize: false, pressureOpacity: false, minSize: 1, defSize: 26, defOpacity: 55 },
];
export const brushById = (id) => BRUSHES.find((b) => b.id === id) || BRUSHES[0];

// ---------------------------------------------------------------- tips
const tipCache = new Map();
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const GRAIN_VARIANTS = 4;

function tipSize(px) {
  let s = 8;
  while (s < px && s < 256) s *= 2;
  return s;
}

// A tip is a square canvas with the dab drawn in the brush colour.
function makeTip(brush, color, S, variant) {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const r = S / 2;
  g.translate(r, r);
  if (brush.tip === 'flat' || brush.tip === 'square') {
    g.rotate(((brush.angle || 0) * Math.PI) / 180);
    const ry = brush.tip === 'square' ? r : r * (brush.aspect || 0.3);
    g.fillStyle = color;
    g.beginPath();
    if (brush.tip === 'square') g.rect(-r * 0.92, -ry * 0.92, r * 1.84, ry * 1.84);
    else g.ellipse(0, 0, r * 0.96, Math.max(1, ry), 0, 0, Math.PI * 2);
    g.fill();
  } else if (brush.hardness >= 0.98) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(0, 0, r - 0.5, 0, Math.PI * 2);
    g.fill();
  } else {
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
    const hard = clamp(brush.hardness, 0, 0.97);
    grad.addColorStop(0, color);
    grad.addColorStop(hard, color);
    // soft falloff: fade the colour out towards the edge
    const rgba = (a) => {
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
      return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : color;
    };
    grad.addColorStop(hard, rgba(1));
    grad.addColorStop(lerp(hard, 1, 0.5), rgba(0.45 * (1 - hard) + 0.12));
    grad.addColorStop(1, rgba(0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
  }
  if (brush.grain > 0) {
    const rnd = mulberry(1234 + variant * 977 + S);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const img = g.getImageData(0, 0, S, S);
    const d = img.data;
    const keep = 1 - 0.62 * brush.grain;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const n = rnd();
      // some grains vanish, the rest are a little lighter
      d[i + 3] = n > keep ? 0 : d[i + 3] * (0.55 + 0.45 * (1 - n / keep * 0.6));
    }
    g.putImageData(img, 0, 0);
  }
  return c;
}

export function getTip(brush, color, sizePx, variant = 0) {
  const S = tipSize(sizePx);
  const v = brush.grain > 0 ? variant % GRAIN_VARIANTS : 0;
  const key = `${brush.id}|${color}|${S}|${v}`;
  let t = tipCache.get(key);
  if (!t) {
    if (tipCache.size > 80) tipCache.clear();
    t = makeTip(brush, color, S, v);
    tipCache.set(key, t);
  }
  return t;
}

// Paint one dab: centre (x, y) and diameter d in canvas pixels.
export function stampTip(g, brush, color, x, y, d, alpha, variant = 0) {
  if (d < 0.2 || alpha <= 0) return;
  const tip = getTip(brush, color, d, variant);
  g.globalAlpha = clamp(alpha, 0, 1);
  const flat = brush.tip === 'flat' || brush.tip === 'square';
  const grainFlip = brush.grain > 0 && variant % 2 ? -1 : 1;
  if (grainFlip < 0 && !flat) {
    g.save(); g.translate(x, y); g.scale(-1, 1); g.drawImage(tip, -d / 2, -d / 2, d, d); g.restore();
  } else {
    g.drawImage(tip, x - d / 2, y - d / 2, d, d);
  }
  g.globalAlpha = 1;
}

// Walk along a segment, calling stepFn(x, y, pressure) every `spacing(p)` units
// of distance. `state.carry` remembers the left-over distance between calls so
// dabs stay evenly spaced around corners.
export function walkSegment(state, x0, y0, p0, x1, y1, p1, spacing, stepFn) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1e-6) return;
  let pos = state.carry;
  while (pos <= len) {
    const t = pos / len;
    const p = lerp(p0, p1, t);
    stepFn(lerp(x0, x1, t), lerp(y0, y1, t), p);
    pos += Math.max(0.25, spacing(p));
  }
  state.carry = pos - len;
}
