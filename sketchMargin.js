// What the sketchpad shows around the page, where nothing can be drawn: a little scene of space instead of plain white.
// Each style paints a w x h picture; `edge` is the colour of the line round the page and `glow` the soft light behind it.
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const stars = (g, w, h, n, seed, cols = ['#ffffff', '#cfe6ff', '#fff3c4']) => {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * w; const y = r() * h; const s = r(); const rad = s > 0.97 ? 2.2 : s > 0.85 ? 1.4 : 0.8;
    g.globalAlpha = 0.35 + r() * 0.65; g.fillStyle = cols[Math.floor(r() * cols.length)];
    g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill();
    if (rad > 2) { g.globalAlpha = 0.5; g.fillRect(x - 5, y - 0.5, 10, 1); g.fillRect(x - 0.5, y - 5, 1, 10); }
  }
  g.globalAlpha = 1;
};
const glowBlob = (g, x, y, rad, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2); };

export const MARGIN_STYLES = [
  // a teal-and-blue nebula with a few constellations drawn across it
  { id: 'nebula-constellations', name: 'Nebula and constellations', edge: '#5eead4', glow: 'rgba(94,234,212,0.5)',
    paint(g, w, h) {
      g.fillStyle = '#04101c'; g.fillRect(0, 0, w, h);
      glowBlob(g, w * 0.2, h * 0.3, h * 0.7, 'rgba(20,184,166,0.55)'); glowBlob(g, w * 0.8, h * 0.75, h * 0.8, 'rgba(37,99,235,0.5)'); glowBlob(g, w * 0.5, h * 0.1, h * 0.5, 'rgba(14,165,233,0.3)');
      stars(g, w, h, Math.round(w * h / 1500), 22);
      const r = rng(55); const pts = []; const n = Math.max(8, Math.round(w * h / 6500));
      for (let k = 0; k < n; k++) pts.push([r() * w, r() * h]);
      g.strokeStyle = 'rgba(186,230,253,0.4)'; g.lineWidth = 1;
      for (let a = 0; a < pts.length; a++) {
        let best = -1; let bd = 1e9;
        for (let b = 0; b < pts.length; b++) { if (a === b) continue; const d = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]); if (d < bd && d > 12) { bd = d; best = b; } }
        if (best >= 0 && bd < 130) { g.beginPath(); g.moveTo(pts[a][0], pts[a][1]); g.lineTo(pts[best][0], pts[best][1]); g.stroke(); }
      }
      g.fillStyle = '#ffffff'; pts.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 2, 0, 6.2832); g.fill(); });
    } },
];

const cache = new Map();
// the picture for this size, painted once and reused every frame
export function marginPicture(style, w, h, mkCanvas) {
  const key = `${style.id}:${w}x${h}`;
  let c = cache.get(key);
  if (!c) {
    if (cache.size > 6) cache.clear();
    c = mkCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    style.paint(c.getContext('2d'), c.width, c.height);
    cache.set(key, c);
  }
  return c;
}
