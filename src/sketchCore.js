// SKETCHPAD core: the document (layers), the view (zoom / pan / rotate), the
// undo history, compositing to the screen, selection state, adjustments and
// saving. The tools (brush, fill, select ...) live in sketchTools.js and the
// popup UI in sketchUI.js; both talk to the object returned by createCore().
import { clamp, adjustPixels, blurPixels } from './sketchUtil.js';
import { loadDoc, saveDoc, loadPrefs, savePrefs, listSketches, putSketch, getSketch, deleteSketch as deleteSketchEntry, patchSketchMeta } from './sketchStore.js';
import { createTools } from './sketchTools.js';
import { showToast } from './toast.js';

import { PAPER_W, PAPER_H, RS, LW, LH, MAX_LAYERS, MAX_ZOOM, SHARE_W, SHARE_H } from './sketchConst.js';
import { MARGIN_STYLES, marginPicture } from './sketchMargin.js';
export { PAPER_W, PAPER_H, RS, LW, LH, MAX_LAYERS, MAX_ZOOM };
export const BLENDS = [
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Colour dodge'], ['color-burn', 'Colour burn'],
  ['soft-light', 'Soft light'], ['hard-light', 'Hard light'], ['difference', 'Difference'], ['luminosity', 'Luminosity'],
];
const HIST_MAX_BYTES = 90 * 1024 * 1024;
const HIST_MAX_ENTRIES = 100;
const OLD_STORE_KEY = 'spac3.sketch.v1';

const mkCanvas = (w = LW, h = LH) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};
const toBlob = (c) => new Promise((res) => c.toBlob((b) => res(b), 'image/png'));

export function createCore(canvas, overlayCanvas) {
  const ctx = canvas.getContext('2d');
  const ov = overlayCanvas.getContext('2d');
  const wrap = canvas.parentElement;

  const core = {
    canvas, ctx, wrap,
    VW: PAPER_W, VH: PAPER_H, base: 1,
    view: { z: 1, x: 0, y: 0, rot: 0 },
    layers: [], active: 0, bg: '#ffffff',
    // tool settings (persisted as prefs)
    tool: 'brush', brushId: 'pencil', size: 6, opacity: 90, smoothing: 25,
    color: '#111827', colorHistory: [], palette: [],
    selMode: 'rect', shapeKind: 'line', shapeFill: false, fillTol: 28, fillAll: false, fillGrow: 1,
    symmetry: 'off', grid: { on: false, size: 50 }, quickShape: true, fingerMode: 'draw',
    locked: false,
    selection: null, // { pts: [[x, y]...] in paper units, invert }
    clipboard: null,
    overlay: null, // { layer, apply(g) } -- live preview painted on top of a layer
    ovExtra: null, // extra overlay-canvas drawing (selection preview, handles, loupe)
    tf: null,
    adj: null,
    marginColor: '#111827',
    // shared scratch canvases
    stroke: mkCanvas(),
    snap: mkCanvas(),
    tmp: mkCanvas(),
  };
  core.strokeCtx = core.stroke.getContext('2d');
  core.snapCtx = core.snap.getContext('2d');
  core.tmpCtx = core.tmp.getContext('2d');

  // ------------------------------------------------------------- events
  const handlers = {};
  core.on = (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); };
  core.emit = (evt, arg) => { (handlers[evt] || []).forEach((fn) => { try { fn(arg); } catch (e) { console.error(e); } }); };

  // -------------------------------------------------------------- layers
  let layerSeq = 0;
  function makeLayer(name) {
    const c = mkCanvas();
    return {
      id: `L${++layerSeq}`, name: name || `Layer ${layerSeq}`, canvas: c, ctx: c.getContext('2d'),
      visible: true, opacity: 1, blend: 'source-over', locked: false, alphaLock: false, clip: false,
      dirty: true, blob: null,
    };
  }
  core.makeLayer = makeLayer;
  core.activeLayer = () => core.layers[core.active];
  core.touch = (layer) => { layer.dirty = true; scheduleSave(); };

  core.canEdit = (layer = core.activeLayer(), quiet = false) => {
    if (!layer) return false;
    if (!layer.visible) { if (!quiet) showToast('That layer is hidden. Show it to draw on it.'); return false; }
    if (layer.locked) { if (!quiet) showToast('That layer is locked. Unlock it in the Layers panel.'); return false; }
    return true;
  };

  // ------------------------------------------------------------- history
  const hist = { undo: [], redo: [], bytes: 0 };
  core.history = hist;
  function trim() {
    while (hist.undo.length > HIST_MAX_ENTRIES || (hist.bytes > HIST_MAX_BYTES && hist.undo.length > 1)) {
      const e = hist.undo.shift();
      hist.bytes -= e.bytes || 0;
    }
  }
  core.pushHistory = (entry) => {
    hist.redo.forEach((e) => { hist.bytes -= e.bytes || 0; });
    hist.redo.length = 0;
    hist.undo.push(entry);
    hist.bytes += entry.bytes || 0;
    trim();
    core.emit('history');
  };
  core.undo = () => {
    cancelTransientEdits();
    const e = hist.undo.pop();
    if (!e) return false;
    e.undo();
    hist.redo.push(e);
    core.invalidate(); core.emit('history'); core.emit('layers');
    return true;
  };
  core.redo = () => {
    cancelTransientEdits();
    const e = hist.redo.pop();
    if (!e) return false;
    e.redo();
    hist.undo.push(e);
    core.invalidate(); core.emit('history'); core.emit('layers');
    return true;
  };
  core.canUndo = () => hist.undo.length > 0;
  core.canRedo = () => hist.redo.length > 0;

  // pixel-change entries keep just the changed rectangle, before and after
  core.rectOf = (x0, y0, x1, y1) => {
    const x = clamp(Math.floor(Math.min(x0, x1)), 0, LW - 1);
    const y = clamp(Math.floor(Math.min(y0, y1)), 0, LH - 1);
    const r = clamp(Math.ceil(Math.max(x0, x1)), x + 1, LW);
    const b = clamp(Math.ceil(Math.max(y0, y1)), y + 1, LH);
    return { x, y, w: r - x, h: b - y };
  };
  core.snapshot = (layer) => {
    core.snapCtx.globalCompositeOperation = 'copy';
    core.snapCtx.drawImage(layer.canvas, 0, 0);
    core.snapCtx.globalCompositeOperation = 'source-over';
    return core.snap;
  };
  const cut = (src, r) => {
    const c = mkCanvas(r.w, r.h);
    c.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return c;
  };
  const paste = (layer, r, img) => {
    layer.ctx.save();
    layer.ctx.clearRect(r.x, r.y, r.w, r.h);
    layer.ctx.drawImage(img, r.x, r.y);
    layer.ctx.restore();
    core.touch(layer);
  };
  // call right AFTER changing pixels in `rect`; `snapCanvas` holds the layer as it was
  core.commitPixels = (layer, rect, snapCanvas, label = 'edit') => {
    const before = cut(snapCanvas, rect);
    const after = cut(layer.canvas, rect);
    core.touch(layer);
    core.pushHistory({
      label, bytes: rect.w * rect.h * 8,
      undo() { paste(layer, rect, before); },
      redo() { paste(layer, rect, after); },
    });
    core.emit('layers');
  };

  // ------------------------------------------------------- layer actions
  function structural(label, doFn, undoFn, bytes = 0) {
    doFn();
    core.pushHistory({ label, bytes, undo: undoFn, redo: doFn });
    core.invalidate(); core.emit('layers'); scheduleSave();
  }
  core.addLayer = (name) => {
    if (core.layers.length >= MAX_LAYERS) { showToast(`Up to ${MAX_LAYERS} layers.`); return null; }
    const L = makeLayer(name);
    const at = core.active + 1;
    const prevActive = core.active;
    structural('add layer', () => { core.layers.splice(at, 0, L); core.active = at; }, () => { core.layers.splice(at, 1); core.active = Math.min(prevActive, core.layers.length - 1); });
    return L;
  };
  core.deleteLayer = (i = core.active) => {
    if (core.layers.length <= 1) { // keep one: just clear it
      return core.clearLayer(i);
    }
    const L = core.layers[i];
    const prevActive = core.active;
    structural('delete layer', () => { core.layers.splice(i, 1); core.active = clamp(core.active >= i ? core.active - 1 : core.active, 0, core.layers.length - 1); if (core.active < 0) core.active = 0; },
      () => { core.layers.splice(i, 0, L); core.active = prevActive; }, LW * LH * 4);
    return true;
  };
  core.duplicateLayer = (i = core.active) => {
    if (core.layers.length >= MAX_LAYERS) { showToast(`Up to ${MAX_LAYERS} layers.`); return null; }
    const src = core.layers[i];
    const L = makeLayer(`${src.name} copy`);
    L.ctx.drawImage(src.canvas, 0, 0);
    Object.assign(L, { visible: src.visible, opacity: src.opacity, blend: src.blend, alphaLock: src.alphaLock, clip: src.clip });
    const prevActive = core.active;
    structural('duplicate layer', () => { core.layers.splice(i + 1, 0, L); core.active = i + 1; }, () => { core.layers.splice(i + 1, 1); core.active = prevActive; });
    return L;
  };
  core.moveLayer = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= core.layers.length) return false;
    const swap = () => { const t = core.layers[i]; core.layers[i] = core.layers[j]; core.layers[j] = t; };
    const prevActive = core.active;
    structural('move layer', () => { swap(); core.active = core.active === i ? j : core.active === j ? i : core.active; }, () => { swap(); core.active = prevActive; });
    return true;
  };
  core.mergeDown = (i = core.active) => {
    if (i <= 0) { showToast('There is no layer below to merge into.'); return false; }
    const top = core.layers[i];
    const low = core.layers[i - 1];
    const lowBefore = mkCanvas();
    lowBefore.getContext('2d').drawImage(low.canvas, 0, 0);
    const lowAfter = mkCanvas();
    const ag = lowAfter.getContext('2d');
    ag.drawImage(low.canvas, 0, 0);
    ag.globalAlpha = top.visible ? top.opacity : 0;
    ag.globalCompositeOperation = top.blend;
    ag.drawImage(top.canvas, 0, 0);
    const prevActive = core.active;
    const setLow = (img) => { low.ctx.save(); low.ctx.globalCompositeOperation = 'copy'; low.ctx.drawImage(img, 0, 0); low.ctx.restore(); core.touch(low); };
    structural('merge down', () => { setLow(lowAfter); core.layers.splice(i, 1); core.active = i - 1; },
      () => { setLow(lowBefore); core.layers.splice(i, 0, top); core.active = prevActive; }, LW * LH * 8);
    return true;
  };
  core.clearLayer = (i = core.active) => {
    const L = core.layers[i];
    if (!core.canEdit(L)) return false;
    const snap = mkCanvas();
    snap.getContext('2d').drawImage(L.canvas, 0, 0);
    L.ctx.clearRect(0, 0, LW, LH);
    core.commitPixels(L, { x: 0, y: 0, w: LW, h: LH }, snap, 'clear layer');
    core.invalidate();
    return true;
  };
  core.clearAll = () => {
    const entries = core.layers.map((L) => { const s = mkCanvas(); s.getContext('2d').drawImage(L.canvas, 0, 0); return [L, s]; });
    structural('clear all', () => { core.layers.forEach((L) => { L.ctx.clearRect(0, 0, LW, LH); core.touch(L); }); },
      () => { entries.forEach(([L, s]) => { L.ctx.clearRect(0, 0, LW, LH); L.ctx.drawImage(s, 0, 0); core.touch(L); }); }, LW * LH * 4 * entries.length);
  };
  core.setActive = (i) => { core.active = clamp(i, 0, core.layers.length - 1); core.emit('layers'); };
  core.setLayerProp = (i, key, value) => {
    const L = core.layers[i];
    if (!L) return;
    L[key] = value;
    core.touch(L);
    core.invalidate(); core.emit('layers');
  };
  core.isEmpty = () => core.layers.every((L) => {
    // cheap-ish check on a downscaled copy
    const t = mkCanvas(90, 60);
    const g = t.getContext('2d');
    g.drawImage(L.canvas, 0, 0, 90, 60);
    const d = g.getImageData(0, 0, 90, 60).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  });

  // ---------------------------------------------------------------- view
  const view = core.view;
  core.matrix = () => {
    const s = core.base * view.z;
    const c = Math.cos(view.rot) * s;
    const sn = Math.sin(view.rot) * s;
    return { a: c, b: sn, c: -sn, d: c, e: view.x, f: view.y, s };
  };
  core.toPaper = (cx, cy) => {
    const m = core.matrix();
    const det = m.a * m.d - m.b * m.c;
    const dx = cx - m.e; const dy = cy - m.f;
    return [(m.d * dx - m.c * dy) / det, (-m.b * dx + m.a * dy) / det];
  };
  core.toCanvas = (px, py) => {
    const m = core.matrix();
    return [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f];
  };
  core.clampView = () => {
    view.z = clamp(view.z, 1, MAX_ZOOM);
    const m = core.matrix();
    if (Math.abs(view.rot) < 1e-3) {
      view.rot = 0;
      const pw = PAPER_W * m.s; const ph = PAPER_H * m.s;
      view.x = pw <= core.VW + 0.01 ? (core.VW - pw) / 2 : clamp(view.x, core.VW - pw, 0);
      view.y = ph <= core.VH + 0.01 ? (core.VH - ph) / 2 : clamp(view.y, core.VH - ph, 0);
    } else {
      // rotated: just keep the page's centre inside the window
      const [cx, cy] = core.toCanvas(PAPER_W / 2, PAPER_H / 2);
      view.x += clamp(cx, 0, core.VW) - cx;
      view.y += clamp(cy, 0, core.VH) - cy;
    }
  };
  core.zoomAt = (cx, cy, nextZ, nextRot = view.rot) => {
    const p = core.toPaper(cx, cy);
    view.z = clamp(nextZ, 1, MAX_ZOOM);
    view.rot = nextRot;
    const m = core.matrix();
    view.x = cx - (m.a * p[0] + m.c * p[1]);
    view.y = cy - (m.b * p[0] + m.d * p[1]);
    core.clampView();
    core.invalidate(); core.emit('view');
  };
  core.panBy = (dx, dy) => {
    view.x += dx; view.y += dy;
    core.clampView();
    core.invalidate(); core.emit('view');
  };
  core.resetView = () => {
    view.z = 1; view.x = 0; view.y = 0; view.rot = 0;
    core.clampView();
    core.invalidate(); core.emit('view');
  };
  core.snapRotation = () => {
    const q = Math.PI / 2;
    const near = Math.round(view.rot / q) * q;
    if (Math.abs(view.rot - near) < (5 * Math.PI) / 180) {
      core.zoomAt(core.VW / 2, core.VH / 2, view.z, Math.abs(near) < 1e-6 ? 0 : near);
    }
  };
  core.canvasCssToUnits = (n) => n * core.VW / (canvas.getBoundingClientRect().width || core.VW);
  core.canvasPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    return [
      clamp((e.clientX - r.left) * (core.VW / (r.width || core.VW)), 0, core.VW),
      clamp((e.clientY - r.top) * (core.VH / (r.height || core.VH)), 0, core.VH),
    ];
  };

  core.syncViewport = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    let h = clamp(Math.round(core.VW * r.height / r.width), 120, 4000);
    if (Math.abs(h - PAPER_H) <= 3) h = PAPER_H;
    const bg = getComputedStyle(wrap).backgroundColor;
    if (bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) core.marginColor = bg;
    if (h === core.VH && canvas.height === h) { core.invalidate(); return; }
    const centre = core.toPaper(core.VW / 2, core.VH / 2);
    core.VH = h;
    canvas.height = h;
    overlayCanvas.width = core.VW; overlayCanvas.height = h;
    core.base = Math.min(core.VW / PAPER_W, core.VH / PAPER_H);
    const m = core.matrix();
    view.x = core.VW / 2 - (m.a * centre[0] + m.c * centre[1]);
    view.y = core.VH / 2 - (m.b * centre[0] + m.d * centre[1]);
    core.clampView();
    core.invalidate(); core.emit('view');
  };
  if ('ResizeObserver' in window) new ResizeObserver(() => core.syncViewport()).observe(canvas);
  window.addEventListener('resize', () => core.syncViewport());

  // ---------------------------------------------------------- compositing
  const checker = (() => {
    const c = mkCanvas(32, 32);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#d9dde6'; g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16);
    return c;
  })();
  function fillPaper(g) {
    if (core.bg === 'transparent') {
      g.fillStyle = g.createPattern(checker, 'repeat');
    } else g.fillStyle = core.bg;
    g.fillRect(0, 0, PAPER_W, PAPER_H);
  }
  function overlayLayerCanvas(L) {
    const t = core.tmpCtx;
    t.save();
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalAlpha = 1; t.globalCompositeOperation = 'copy';
    t.drawImage(L.canvas, 0, 0);
    t.globalCompositeOperation = 'source-over';
    core.overlay.apply(t);
    t.restore();
    return core.tmp;
  }
  function clipBaseFor(i) {
    for (let k = i - 1; k >= 0; k--) if (!core.layers[k].clip) return core.layers[k];
    return null;
  }
  function composeLayers(g, forExport) {
    for (let i = 0; i < core.layers.length; i++) {
      const L = core.layers[i];
      if (!L.visible) continue;
      let src = L.canvas;
      if (!forExport && core.overlay && core.overlay.layer === L) src = overlayLayerCanvas(L);
      if (L.clip) {
        const baseL = clipBaseFor(i);
        if (baseL) {
          if (!core.clipTmp) { core.clipTmp = mkCanvas(); core.clipTmpCtx = core.clipTmp.getContext('2d'); }
          const t = core.clipTmpCtx;
          t.save(); t.setTransform(1, 0, 0, 1, 0, 0);
          t.globalCompositeOperation = 'copy'; t.drawImage(src, 0, 0);
          t.globalCompositeOperation = 'destination-in'; t.drawImage(baseL.canvas, 0, 0);
          t.restore();
          src = core.clipTmp;
        }
      }
      g.globalAlpha = L.opacity;
      g.globalCompositeOperation = L.blend;
      g.drawImage(src, 0, 0, PAPER_W, PAPER_H);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
  core.composeLayers = composeLayers;
  const marginStyle = () => MARGIN_STYLES[0];
  function compose() {
    const g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    // outside the page (where nothing can be drawn) is a little scene of space, and the page itself has a glowing edge, so the drawable area is always obvious
    const ms = marginStyle();
    g.drawImage(marginPicture(ms, core.VW, core.VH, mkCanvas), 0, 0, core.VW, core.VH);
    const m = core.matrix();
    const sc = Math.hypot(m.a, m.b) || 1;
    g.save();
    g.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    g.save();
    g.shadowColor = ms.glow; g.shadowBlur = 22;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, PAPER_W, PAPER_H);
    g.restore();
    g.save();
    g.beginPath(); g.rect(0, 0, PAPER_W, PAPER_H); g.clip();
    fillPaper(g);
    composeLayers(g, false);
    g.restore();
    g.strokeStyle = ms.edge; g.lineWidth = 2.5 / sc;
    g.strokeRect(-1.25 / sc, -1.25 / sc, PAPER_W + 2.5 / sc, PAPER_H + 2.5 / sc);
    g.restore();
  }

  // The flattened picture at full resolution (what Save / Send export).
  core.flatten = () => {
    const c = mkCanvas();
    const g = c.getContext('2d');
    g.setTransform(RS, 0, 0, RS, 0, 0);
    if (core.bg !== 'transparent') { g.fillStyle = core.bg; g.fillRect(0, 0, PAPER_W, PAPER_H); }
    composeLayers(g, true);
    return c;
  };
  // Just the layers, with no paper colour behind them: what a sticker is cut from.
  core.flattenLayers = () => {
    const c = mkCanvas(); const g = c.getContext('2d');
    g.setTransform(RS, 0, 0, RS, 0, 0);
    composeLayers(g, true);
    return c;
  };
  core.exportBlob = () => toBlob(core.flatten());
  // The picture that goes to a chat: 1200 x 800 and, when the browser can, WebP (a transparent page stays PNG so the see-through stays).
  core.exportShareBlob = async () => {
    const c = mkCanvas(SHARE_W, SHARE_H); const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(core.flatten(), 0, 0, SHARE_W, SHARE_H);
    if (core.bg !== 'transparent') {
      const w = await new Promise((res) => c.toBlob(res, 'image/webp', 0.85));
      if (w && w.type === 'image/webp') return w; // an old browser answers with a PNG instead: use that as is
    }
    return toBlob(c);
  };
  // colour of the picture at a point of the page (for the eyedropper)
  core.sampleColor = (px, py) => {
    const c = mkCanvas(1, 1);
    const g = c.getContext('2d');
    g.setTransform(RS, 0, 0, RS, -px * RS, -py * RS);
    g.fillStyle = core.bg === 'transparent' ? '#ffffff' : core.bg;
    g.fillRect(0, 0, PAPER_W, PAPER_H);
    composeLayers(g, true);
    const d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  // ------------------------------------------------------------ overlay UI
  let rafId = 0;
  let ovDirty = true;
  core.invalidate = () => {
    ovDirty = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; compose(); if (ovDirty) { drawOverlay(); ovDirty = false; } });
  };
  core.redrawNow = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } compose(); drawOverlay(); ovDirty = false; };
  let antsOffset = 0;
  setInterval(() => { if (core.selection || core.tf) { antsOffset = (antsOffset + 1) % 16; ovDirty = true; core.invalidate(); } }, 160);

  function pathPoly(g, pts, close = true) {
    pts.forEach((p, i) => { const [x, y] = core.toCanvas(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    if (close) g.closePath();
  }
  function drawOverlay() {
    const g = ov;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, core.VW, core.VH);
    if (core.grid.on) {
      g.save();
      g.strokeStyle = 'rgba(96,165,250,0.45)'; g.lineWidth = 1;
      g.beginPath();
      const gs = core.grid.size;
      for (let x = 0; x <= PAPER_W; x += gs) { const a = core.toCanvas(x, 0); const b = core.toCanvas(x, PAPER_H); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      for (let y = 0; y <= PAPER_H; y += gs) { const a = core.toCanvas(0, y); const b = core.toCanvas(PAPER_W, y); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      g.stroke();
      g.restore();
    }
    if (core.symmetry !== 'off') {
      g.save();
      g.strokeStyle = 'rgba(244,114,182,0.8)'; g.lineWidth = 1.5; g.setLineDash([8, 6]);
      g.beginPath();
      const line = (x0, y0, x1, y1) => { const a = core.toCanvas(x0, y0); const b = core.toCanvas(x1, y1); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); };
      if (core.symmetry === 'v' || core.symmetry === 'quad') line(PAPER_W / 2, 0, PAPER_W / 2, PAPER_H);
      if (core.symmetry === 'h' || core.symmetry === 'quad') line(0, PAPER_H / 2, PAPER_W, PAPER_H / 2);
      if (core.symmetry === 'radial') {
        for (let i = 0; i < 3; i++) {
          const t = (i / 3) * Math.PI;
          const R = 700;
          line(PAPER_W / 2 - Math.cos(t) * R, PAPER_H / 2 - Math.sin(t) * R, PAPER_W / 2 + Math.cos(t) * R, PAPER_H / 2 + Math.sin(t) * R);
        }
      }
      g.stroke();
      g.restore();
    }
    const outline = (pts, invert) => {
      g.save();
      g.beginPath();
      if (invert) { pathPoly(g, [[0, 0], [PAPER_W, 0], [PAPER_W, PAPER_H], [0, PAPER_H]]); }
      pathPoly(g, pts);
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.setLineDash([]); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#ffffff'; g.setLineDash([6, 5]); g.lineDashOffset = -antsOffset; g.stroke();
      g.restore();
    };
    if (core.selection) outline(core.selection.pts, core.selection.invert);
    if (core.ovExtra) core.ovExtra(g);
  }
  core.drawPoly = pathPoly;
  core.setOvExtra = (fn) => { core.ovExtra = fn; core.invalidate(); };

  // --------------------------------------------------------- selection
  core.setSelection = (sel) => {
    core.selection = sel;
    core.invalidate(); core.emit('selection');
  };
  // Restrict the context to the selection (raster coordinates). Call inside save()/restore().
  core.clipSelection = (g) => {
    const sel = core.selection;
    if (!sel) return;
    g.beginPath();
    if (sel.invert) g.rect(0, 0, LW, LH);
    sel.pts.forEach((p, i) => { if (i) g.lineTo(p[0] * RS, p[1] * RS); else g.moveTo(p[0] * RS, p[1] * RS); });
    g.closePath();
    g.clip(sel.invert ? 'evenodd' : 'nonzero');
  };
  core.selectionBounds = () => {
    const sel = core.selection;
    if (!sel || sel.invert) return { x: 0, y: 0, w: LW, h: LH };
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    sel.pts.forEach((p) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    return core.rectOf(x0 * RS - 1, y0 * RS - 1, x1 * RS + 1, y1 * RS + 1);
  };

  // --------------------------------------------------------- adjustments
  // beginAdjust('hsb' | 'blur' | ...) shows a live preview of the active layer
  // with the change applied; commitAdjust() keeps it, cancelAdjust() drops it.
  core.beginAdjust = (kind) => {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return false;
    if (core.tf) core.tools.applyTransform();
    cancelTransientEdits();
    const snap = mkCanvas();
    snap.getContext('2d').drawImage(L.canvas, 0, 0);
    core.adj = { kind, layer: L, snap, params: {}, result: null };
    core.overlay = { layer: L, apply: (g) => { if (core.adj && core.adj.result) { g.save(); core.clipSelection(g); g.clearRect(0, 0, LW, LH); g.drawImage(core.adj.result, 0, 0); g.restore(); } } };
    core.emit('adjust');
    return true;
  };
  let adjRaf = 0;
  core.updateAdjust = (params) => {
    if (!core.adj) return;
    core.adj.params = { ...core.adj.params, ...params };
    if (adjRaf) return;
    adjRaf = requestAnimationFrame(() => { adjRaf = 0; renderAdjust(); });
  };
  function renderAdjust() {
    const a = core.adj;
    if (!a) return;
    const p = a.params;
    const out = mkCanvas();
    const og = out.getContext('2d');
    // work on a half-size copy while previewing big blurs? keep it simple: full size
    og.drawImage(a.snap, 0, 0);
    const img = og.getImageData(0, 0, LW, LH);
    if (a.kind === 'hsb') adjustPixels(img.data, { hue: p.hue || 0, sat: (p.sat || 0) / 100, bri: (p.bri || 0) / 100, con: (p.con || 0) / 100 });
    else if (a.kind === 'invert') adjustPixels(img.data, { invert: true });
    else if (a.kind === 'blur') blurPixels(img.data, LW, LH, (p.radius || 0) * RS);
    og.putImageData(img, 0, 0);
    a.result = out;
    core.invalidate();
  }
  core.renderAdjustNow = () => { if (adjRaf) { cancelAnimationFrame(adjRaf); adjRaf = 0; } renderAdjust(); };
  core.commitAdjust = () => {
    const a = core.adj;
    if (!a) return;
    core.renderAdjustNow();
    const L = a.layer;
    if (a.result) {
      L.ctx.save();
      core.clipSelection(L.ctx);
      if (L.alphaLock) L.ctx.globalCompositeOperation = 'source-atop';
      else L.ctx.clearRect(0, 0, LW, LH);
      L.ctx.drawImage(a.result, 0, 0);
      L.ctx.restore();
    }
    const snap = a.snap;
    core.adj = null; core.overlay = null;
    core.commitPixels(L, { x: 0, y: 0, w: LW, h: LH }, snap, 'adjust');
    core.invalidate(); core.emit('adjust');
  };
  core.cancelAdjust = () => {
    if (!core.adj) return;
    core.adj = null; core.overlay = null;
    core.invalidate(); core.emit('adjust');
  };
  function cancelTransientEdits() {
    if (core.adj) core.cancelAdjust();
  }

  // ------------------------------------------------------------- pointers
  const ptrs = new Map();
  let session = null;
  let gesture = null;
  let maxCount = 0;
  let downT = 0;
  let gestureMoved = false;
  let tapOk = true; // all fingers landed together and stayed put
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function metrics() {
    const [p1, p2] = [...ptrs.values()];
    return { mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, d: dist(p1, p2) || 1, ang: Math.atan2(p2.y - p1.y, p2.x - p1.x) };
  }
  function panSession(start) {
    let last = start;
    return {
      move(e, c) { core.panBy(c[0] - last[0], c[1] - last[1]); last = c; },
      up() {}, cancel() {},
    };
  }
  function startSession(e, c) {
    if (core.adj || !core.tools) return null;
    const isMiddle = e.button === 1;
    if (isMiddle || core.tool === 'hand' || (core.fingerMode === 'pan' && e.pointerType === 'touch')) return panSession(c);
    return core.tools.start(core.tool, e, c);
  }
  function endSession(e) { if (session) { const s = session; session = null; s.up(e); } }
  core.cancelSession = () => { if (session) { const s = session; session = null; s.cancel(); } };

  canvas.addEventListener('pointerdown', (e) => {
    if (core.locked) return;
    if (e.button !== undefined && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const c = core.canvasPoint(e);
    ptrs.set(e.pointerId, { x: c[0], y: c[1], sx: c[0], sy: c[1], type: e.pointerType });
    if (ptrs.size === 1) {
      maxCount = 1; downT = performance.now(); gestureMoved = false; tapOk = true;
      session = startSession(e, c);
    } else {
      maxCount = Math.max(maxCount, ptrs.size);
      if (performance.now() - downT > 220) tapOk = false;
      core.cancelSession();
      if (ptrs.size === 2) gesture = metrics();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const c = core.canvasPoint(e);
    p.x = c[0]; p.y = c[1];
    if (Math.hypot(c[0] - p.sx, c[1] - p.sy) > core.canvasCssToUnits(12)) tapOk = false;
    if (ptrs.size >= 2) {
      if (!gesture || ptrs.size !== 2) return;
      const g = metrics();
      const dz = g.d / gesture.d;
      let dAng = g.ang - gesture.ang;
      dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
      if (Math.abs(dz - 1) > 0.04 || Math.hypot(g.mx - gesture.mx, g.my - gesture.my) > 10 || Math.abs(dAng) > 0.08) gestureMoved = true;
      // zoom + rotate about the old midpoint, then slide to the new midpoint
      const anchor = core.toPaper(gesture.mx, gesture.my);
      view.z = clamp(view.z * dz, 1, MAX_ZOOM);
      view.rot += dAng;
      const m = core.matrix();
      view.x = g.mx - (m.a * anchor[0] + m.c * anchor[1]);
      view.y = g.my - (m.b * anchor[0] + m.d * anchor[1]);
      core.clampView();
      gesture = g;
      core.invalidate(); core.emit('view');
      return;
    }
    if (session) session.move(e, c);
  });
  function onUp(e) {
    const had = ptrs.delete(e.pointerId);
    if (!had) return;
    if (ptrs.size === 0) {
      if (session) endSession(e);
      else if (tapOk && !gestureMoved && performance.now() - downT < 380 && e.type === 'pointerup') {
        // Procreate-style taps: two fingers = undo, three fingers = redo
        if (maxCount === 2) core.undo();
        else if (maxCount === 3) core.redo();
      }
      if (gesture) core.snapRotation();
      gesture = null; maxCount = 0;
    } else if (ptrs.size < 2) {
      gesture = null;
    }
  }
  // a plain tap (not a swipe) on a locked drawing area explains why nothing was drawn
  let lockHintAt = 0;
  canvas.addEventListener('click', () => { if (!core.locked || Date.now() - lockHintAt < 6000) return; lockHintAt = Date.now(); showToast('The drawing area is locked so you can scroll past it. Tap the 🔓/🔒 button to draw.'); });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', (e) => {
    if (core.locked) return;
    e.preventDefault();
    if (session) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = clamp(e.deltaY * unit, -200, 200);
    const c = core.canvasPoint(e);
    if (e.shiftKey && !e.ctrlKey) { core.zoomAt(c[0], c[1], view.z, view.rot + dy * 0.004); return; }
    core.zoomAt(c[0], c[1], view.z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  core.setLocked = (v, { save = true } = {}) => {
    if (save) core._lockTouched = true;
    core.locked = !!v;
    if (core.locked) { core.cancelSession(); ptrs.clear(); gesture = null; }
    canvas.classList.toggle('is-locked', core.locked);
    wrap.classList.toggle('is-locked', core.locked);
    if (save) { try { localStorage.setItem('spac3.sketchLocked', core.locked ? '1' : '0'); } catch { /* ignore */ } }
    core.emit('lock');
  };

  // ------------------------------------------------------------- settings
  core.prevTool = 'brush';
  core.setTool = (t) => {
    if (t === core.tool) { core.emit('tool'); return; }
    if (core.tf && t !== 'transform') core.tools.applyTransform();
    if (core.adj) core.cancelAdjust();
    core.cancelSession();
    if (t !== 'transform' && t !== 'eyedrop') core.prevTool = t;
    core.tool = t;
    if (t === 'transform') {
      if (!core.tools.beginTransform()) core.tool = core.prevTool;
    }
    core.emit('tool'); core.savePrefsSoon();
  };
  core.setBrush = (id, brush) => {
    core.brushId = id;
    if (brush) { core.size = brush.defSize; core.opacity = brush.defOpacity; }
    if (core.tool !== 'brush' && core.tool !== 'eraser' && core.tool !== 'smudge') core.setTool('brush');
    core.emit('tool'); core.savePrefsSoon();
  };
  core.setSetting = (key, value) => { core[key] = value; core.invalidate(); core.emit('tool'); core.savePrefsSoon(); };
  core.setColor = (hex, { remember = false } = {}) => {
    core.color = hex;
    if (remember) {
      core.colorHistory = [hex, ...core.colorHistory.filter((c) => c !== hex)].slice(0, 14);
    }
    core.emit('color'); core.savePrefsSoon();
  };

  // --------------------------------------------------------------- prefs
  const PREF_KEYS = ['tool', 'brushId', 'size', 'opacity', 'smoothing', 'color', 'colorHistory', 'palette', 'selMode', 'shapeKind', 'shapeFill', 'fillTol', 'fillAll', 'fillGrow', 'symmetry', 'quickShape', 'fingerMode'];
  let prefTimer = 0;
  const flushPrefs = () => {
    clearTimeout(prefTimer); prefTimer = 0;
    const p = {};
    PREF_KEYS.forEach((k) => { p[k] = core[k]; });
    p.grid = core.grid;
    savePrefs(p);
  };
  core.savePrefsSoon = () => {
    clearTimeout(prefTimer);
    prefTimer = setTimeout(flushPrefs, 400);
  };
  window.addEventListener('pagehide', () => { if (prefTimer) flushPrefs(); });
  function applyPrefs() {
    const p = loadPrefs();
    PREF_KEYS.forEach((k) => { if (p[k] !== undefined && typeof p[k] === typeof core[k]) core[k] = p[k]; });
    if (p.grid && typeof p.grid === 'object') core.grid = { on: !!p.grid.on, size: clamp(Number(p.grid.size) || 50, 10, 300) };
    if (core.tool === 'transform') core.tool = 'brush'; // never start mid-transform
    if (!Array.isArray(core.colorHistory)) core.colorHistory = [];
    if (!Array.isArray(core.palette)) core.palette = [];
  }

  // -------------------------------------------------------- persistence
  // SAVE POINTS. Turning every stroke into PNGs and writing them to disk makes
  // drawing stutter on a big page, so changes are only written every few minutes
  // (the first change starts the clock), whenever the page is hidden / closed /
  // goes offline, and whenever a save is asked for (Save sketch, New drawing,
  // Open ...). A save point never fires in the middle of a stroke -- it waits.
  const SAVE_EVERY = (typeof window !== 'undefined' && window.__sketchSaveEvery) || 120000;
  let saveTimer = 0; let savePending = false; let penDown = 0;
  function scheduleSave() {
    savePending = true;
    if (saveTimer) return;
    saveTimer = setTimeout(savePoint, SAVE_EVERY);
  }
  function savePoint() {
    saveTimer = 0;
    if (penDown > 0) { saveTimer = setTimeout(savePoint, 4000); return; } // not mid-stroke
    persistNow();
  }
  window.addEventListener('pointerdown', () => { penDown += 1; }, true);
  const penUp = () => { penDown = Math.max(0, penDown - 1); };
  window.addEventListener('pointerup', penUp, true);
  window.addEventListener('pointercancel', penUp, true);
  const saveIfPending = () => { if (savePending || core.layers.some((L) => L.dirty)) persistNow(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveIfPending(); });
  window.addEventListener('offline', saveIfPending);
  // The picture that is open may be a saved sketch (core.sketchId): then every
  // autosave also updates its entry in the gallery.
  core.sketchId = null; core.sketchName = ''; core.sketchCreated = 0;
  async function buildDoc() {
    const doc = { v: 2, bg: core.bg, active: core.active, layers: [], sketchId: core.sketchId, sketchName: core.sketchName, sketchCreated: core.sketchCreated };
    for (const L of core.layers) {
      if (!L.blob || L.dirty) { L.blob = await toBlob(L.canvas); L.dirty = false; }
      doc.layers.push({ id: L.id, name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, locked: L.locked, alphaLock: L.alphaLock, clip: L.clip, png: L.blob });
    }
    return doc;
  }
  function makeThumb() {
    const t = mkCanvas(240, 160);
    const g = t.getContext('2d');
    g.fillStyle = core.bg === 'transparent' ? '#e5e7eb' : core.bg; g.fillRect(0, 0, 240, 160);
    g.drawImage(core.flatten(), 0, 0, 240, 160);
    try { return t.toDataURL('image/jpeg', 0.72); } catch { return ''; }
  }
  async function doPersist() {
    try {
      const doc = await buildDoc();
      await saveDoc(doc);
      if (doc.sketchId) {
        const now = Date.now();
        const ok = await putSketch({ id: doc.sketchId, name: doc.sketchName || 'Untitled', created: doc.sketchCreated || now, updated: now, thumb: makeThumb(), layers: doc.layers.length }, doc);
        if (!ok) { core.saveFailed = true; core.emit('savefail'); } else core.emit('gallery');
      }
    } catch { /* not remembered, but drawing carries on */ }
  }
  // Runs one save at a time; asking while one is running just makes it go round
  // once more, and every caller can await the final result.
  let running = null; let again = false;
  function persistNow() {
    clearTimeout(saveTimer); saveTimer = 0; savePending = false;
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; await doPersist(); } while (again); })().finally(() => { running = null; });
    return running;
  }
  core.saveNow = persistNow;
  core.setBg = (bg) => { core.bg = bg; core.invalidate(); scheduleSave(); core.emit('bg'); };

  async function decode(blob, into) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
      into.ctx.drawImage(img, 0, 0, LW, LH);
    } finally { URL.revokeObjectURL(url); }
  }
  function migrateOldStrokes(layer) {
    try {
      const raw = JSON.parse(localStorage.getItem(OLD_STORE_KEY) || 'null');
      if (!Array.isArray(raw) || !raw.length) return false;
      const g = layer.ctx;
      raw.forEach((s) => {
        if (!s || !Array.isArray(s.pts) || !s.pts.length) return;
        const w = typeof s.w === 'number' ? Math.max(0.02, s.w) : Math.max(1, (s.size || 4) * 1.5);
        g.strokeStyle = g.fillStyle = s.tool === 'eraser' ? '#ffffff' : s.color || '#111827';
        g.lineWidth = w * RS; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        g.arc(s.pts[0][0] * RS, s.pts[0][1] * RS, (w * RS) / 2, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(s.pts[0][0] * RS, s.pts[0][1] * RS);
        for (let i = 1; i < s.pts.length; i++) g.lineTo(s.pts[i][0] * RS, s.pts[i][1] * RS);
        g.stroke();
      });
      return true;
    } catch { return false; }
  }
  // ------------------------------------------------------- saved sketches
  const newSketchId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  core.listSketches = listSketches;
  // exact check (the downscaled isEmpty() can miss a tiny dot)
  core.hasInk = () => core.layers.some((L) => {
    const d = L.ctx.getImageData(0, 0, LW, LH).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
  });
  function settle() {
    if (core.tf) core.tools.applyTransform();
    if (core.adj) core.cancelAdjust();
    core.cancelSession();
  }
  async function freeName() {
    const used = new Set((await listSketches()).map((m) => m.name));
    for (let n = 1; ; n++) if (!used.has(`Sketch ${n}`)) return `Sketch ${n}`;
  }
  // Save the picture that is open as a sketch (or, if it already is one, save
  // it now and optionally give it a new name). From then on it autosaves.
  core.saveSketch = async (name) => {
    settle();
    const wanted = (name || '').trim().slice(0, 60);
    if (!core.sketchId) {
      core.sketchId = newSketchId(); core.sketchCreated = Date.now();
      core.sketchName = wanted || await freeName();
    } else if (wanted) core.sketchName = wanted;
    core.saveFailed = false;
    await persistNow();
    core.emit('sketch');
    return !core.saveFailed;
  };
  // blank page; the old picture is saved to the gallery first if it has anything on it
  function clearDocState() {
    hist.undo.length = 0; hist.redo.length = 0; hist.bytes = 0;
    core.selection = null; core.overlay = null; core.ovExtra = null;
    core.view.z = 1; core.view.x = 0; core.view.y = 0; core.view.rot = 0;
  }
  async function stashCurrent() {
    settle();
    if (core.sketchId) { await persistNow(); return core.sketchName; }
    if (core.hasInk()) { await core.saveSketch(); return core.sketchName; }
    return null;
  }
  core.newDrawing = async () => {
    const saved = await stashCurrent();
    clearDocState();
    core.layers = [makeLayer('Layer 1')]; core.active = 0;
    core.sketchId = null; core.sketchName = ''; core.sketchCreated = 0;
    core.clampView(); core.invalidate();
    core.emit('layers'); core.emit('history'); core.emit('view'); core.emit('sketch');
    await persistNow();
    return saved;
  };
  core.openSketch = async (id) => {
    if (id === core.sketchId) return true;
    const doc = await getSketch(id);
    if (!doc || !Array.isArray(doc.layers) || !doc.layers.length) return false;
    const meta = (await listSketches()).find((m) => m.id === id);
    await stashCurrent();
    await applyDoc(doc);
    clearDocState();
    core.sketchId = id; core.sketchName = meta?.name || doc.sketchName || 'Untitled'; core.sketchCreated = meta?.created || doc.sketchCreated || Date.now();
    core.clampView(); core.invalidate();
    core.emit('layers'); core.emit('history'); core.emit('view'); core.emit('bg'); core.emit('sketch');
    try { await saveDoc(await buildDoc()); } catch { /* ignore */ }
    return true;
  };
  core.renameSketch = async (id, name) => {
    const n = (name || '').trim().slice(0, 60);
    if (!n) return false;
    if (id === core.sketchId) { core.sketchName = n; await persistNow(); } else await patchSketchMeta(id, { name: n });
    core.emit('sketch'); core.emit('gallery');
    return true;
  };
  core.duplicateSketch = async (id) => {
    if (id === core.sketchId) await persistNow();
    const doc = await getSketch(id);
    const meta = (await listSketches()).find((m) => m.id === id);
    if (!doc || !meta) return false;
    const nid = newSketchId(); const now = Date.now();
    const name = `${meta.name} copy`.slice(0, 60);
    const ok = await putSketch({ ...meta, id: nid, name, created: now, updated: now }, { ...doc, sketchId: nid, sketchName: name, sketchCreated: now });
    core.emit('gallery');
    return ok;
  };
  core.deleteSketch = async (id) => {
    const ok = await deleteSketchEntry(id);
    if (id === core.sketchId) { core.sketchId = null; core.sketchName = ''; core.sketchCreated = 0; await persistNow(); core.emit('sketch'); }
    core.emit('gallery');
    return ok;
  };

  // Fill the page from a saved document (boot, or opening a saved sketch).
  async function applyDoc(doc) {
    const layers = [];
    for (const d of doc.layers.slice(0, MAX_LAYERS)) {
      const L = makeLayer(d.name);
      Object.assign(L, { id: d.id || L.id, visible: d.visible !== false, opacity: typeof d.opacity === 'number' ? d.opacity : 1, blend: d.blend || 'source-over', locked: !!d.locked, alphaLock: !!d.alphaLock, clip: !!d.clip });
      try { if (d.png) await decode(d.png, L); L.blob = d.png; L.dirty = false; } catch { /* leave blank */ }
      layers.push(L);
    }
    core.bg = typeof doc.bg === 'string' ? doc.bg : '#ffffff';
    core.layers = layers;
    core.active = clamp(doc.active || 0, 0, layers.length - 1);
  }
  core.ready = (async () => {
    applyPrefs();
    core.tools = createTools(core);
    let doc = null;
    try { doc = await loadDoc(); } catch { doc = null; }
    if (doc && Array.isArray(doc.layers) && doc.layers.length) {
      await applyDoc(doc);
      if (typeof doc.sketchId === 'string' && doc.sketchId) { core.sketchId = doc.sketchId; core.sketchName = doc.sketchName || ''; core.sketchCreated = doc.sketchCreated || 0; }
    } else {
      const L = makeLayer('Layer 1');
      if (migrateOldStrokes(L)) L.dirty = true;
      core.layers.push(L);
      core.active = 0;
    }
    // on a touch screen the drawing area starts locked (a swipe over it scrolls the page instead of drawing); unlock it with the 🔒 button. On a computer the saved choice is kept.
    try { const coarse = !!window.matchMedia?.('(pointer: coarse)').matches; core.setLocked(coarse ? (core._lockTouched ? core.locked : true) : localStorage.getItem('spac3.sketchLocked') === '1', { save: false }); } catch { /* ignore */ }
    core.syncViewport();
    core.redrawNow();
    core.emit('layers'); core.emit('tool'); core.emit('color'); core.emit('history');
    return core;
  })();

  window.addEventListener('pagehide', saveIfPending);
  return core;
}
