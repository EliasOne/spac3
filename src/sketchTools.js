// SKETCHPAD tools: what a finger / pen / mouse does on the page for each tool
// (brush, eraser, smudge, fill, eyedropper, select, shapes, transform).
// createTools(core) returns { start(tool, event, canvasPoint), ... }; start()
// gives back a "session" { move, up, cancel } for the gesture that just began.
import { clamp, lerp, floodFill, dilateMask, recognizeShape, shapePoints, symmetryPoints, rgbToHex } from './sketchUtil.js';
import { brushById, stampTip, walkSegment, getTip } from './sketchBrushes.js';
import { PAPER_W, PAPER_H, RS, LW, LH } from './sketchConst.js';
import { showToast } from './toast.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export function createTools(core) {
  const toPaperClamped = (c) => {
    const p = core.toPaper(c[0], c[1]);
    return [clamp(p[0], 0, PAPER_W), clamp(p[1], 0, PAPER_H)];
  };
  // CSS pixels -> canvas pixels (the canvas is 1200 wide but shown much smaller)
  const cssPx = (n) => n * core.VW / (core.canvas.getBoundingClientRect().width || core.VW);
  const vibrate = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

  // ----------------------------------------------------------- stroke core
  // Brush, eraser and shape strokes are built on the scratch "stroke" canvas
  // and only merged into the layer when you lift -- so a stroke at 50% opacity
  // doesn't get darker where it overlaps itself, and the eraser can preview.
  function strokeOverlay(L, sess) {
    return {
      layer: L,
      apply(g) {
        g.save();
        core.clipSelection(g);
        applyStroke(g, L, sess);
        g.restore();
      },
    };
  }
  function applyStroke(g, L, sess) {
    g.globalAlpha = sess.opacity;
    g.globalCompositeOperation = sess.erase ? 'destination-out' : L.alphaLock ? 'source-atop' : (sess.brush.blend || 'source-over');
    g.drawImage(core.stroke, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
  function growBox(sess, x, y, r) {
    const b = sess.bb;
    b.x0 = Math.min(b.x0, x - r); b.y0 = Math.min(b.y0, y - r);
    b.x1 = Math.max(b.x1, x + r); b.y1 = Math.max(b.y1, y + r);
  }
  // one dab (and its symmetry copies) at a paper position
  function dab(sess, x, y, pr) {
    const br = sess.brush;
    let d = sess.dBase * br.sizeMul;
    if (br.pressureSize && sess.pen) d *= lerp(br.minSize, 1, pr);
    d = Math.max(0.5 / RS, d);
    let alpha = br.flow;
    if (br.pressureOpacity && sess.pen) alpha *= lerp(0.35, 1, pr);
    const variant = (sess.n = (sess.n || 0) + 1);
    const pts = symmetryPoints(core.symmetry, x, y, PAPER_W, PAPER_H);
    pts.forEach((p) => {
      stampTip(core.strokeCtx, br, sess.color, p[0] * RS, p[1] * RS, d * RS, alpha, variant + Math.floor(p[0] * 7));
      growBox(sess, p[0] * RS, p[1] * RS, (d * RS) / 2 + 3);
    });
  }
  const spacingFor = (sess) => (pr) => {
    const br = sess.brush;
    let d = sess.dBase * br.sizeMul;
    if (br.pressureSize && sess.pen) d *= lerp(br.minSize, 1, pr);
    return Math.max(0.15, br.spacing * d);
  };
  function stampPolyline(sess, pts) {
    sess.walk = { carry: 0 };
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) dab(sess, pts[0][0], pts[0][1], 1);
      else walkSegment(sess.walk, pts[i - 1][0], pts[i - 1][1], 1, pts[i][0], pts[i][1], 1, spacingFor(sess), (x, y, p) => dab(sess, x, y, p));
    }
  }
  // the same polyline copied through the symmetry mode, for shapes
  function symLines(pts) {
    if (core.symmetry === 'off') return [pts];
    const n = symmetryPoints(core.symmetry, 0, 0, PAPER_W, PAPER_H).length;
    const out = [];
    for (let k = 0; k < n; k++) out.push(pts.map((p) => symmetryPoints(core.symmetry, p[0], p[1], PAPER_W, PAPER_H)[k]));
    return out;
  }
  function newStroke(L, e, { erase = false } = {}) {
    const brush = brushById(core.brushId);
    const pen = e.pointerType === 'pen';
    core.snapshot(L);
    core.strokeCtx.clearRect(0, 0, LW, LH);
    const sess = {
      L, brush, erase, pen,
      color: erase ? '#000000' : core.color,
      opacity: core.opacity / 100,
      dBase: Math.max(0.6, core.size / core.view.z),
      bb: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      walk: { carry: 0 }, n: 0,
    };
    core.overlay = strokeOverlay(L, sess);
    return sess;
  }
  function finishStroke(sess, label) {
    const { L } = sess;
    core.overlay = null;
    if (!isFinite(sess.bb.x0)) { core.strokeCtx.clearRect(0, 0, LW, LH); core.invalidate(); return; }
    const rect = core.rectOf(sess.bb.x0, sess.bb.y0, sess.bb.x1, sess.bb.y1);
    L.ctx.save();
    core.clipSelection(L.ctx);
    applyStroke(L.ctx, L, sess);
    L.ctx.restore();
    core.commitPixels(L, rect, core.snap, label);
    core.strokeCtx.clearRect(0, 0, LW, LH);
    core.invalidate();
  }
  function dropStroke() {
    core.overlay = null;
    core.strokeCtx.clearRect(0, 0, LW, LH);
    core.invalidate();
  }

  // -------------------------------------------------------------- brush
  function brushSession(e, c) {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return null;
    const erase = core.tool === 'eraser';
    const sess = newStroke(L, e, { erase });
    const p0 = toPaperClamped(c);
    const pr0 = sess.pen && e.pressure > 0 ? e.pressure : 1;
    const raw = [p0];
    let sm = p0.slice();
    let prev = p0.slice();
    let prevPr = pr0;
    let lastMid = p0.slice();
    let lastMidPr = pr0;
    let snapped = false;
    let eyedropping = false;
    let lastC = c;
    let moved = false;
    let timer = 0;
    dab(sess, p0[0], p0[1], pr0);
    core.invalidate();

    const k = () => 1 - (core.smoothing / 100) * 0.92;
    const startHold = () => {
      clearTimeout(timer);
      if (erase || !core.quickShape) return;
      timer = setTimeout(() => {
        // (pressing and holding no longer picks up a colour: use the Pick colour tool instead)
        if (moved && core.quickShape && raw.length >= 6 && !snapped) {
          const shape = recognizeShape(raw);
          if (shape) {
            snapped = true;
            core.strokeCtx.clearRect(0, 0, LW, LH);
            sess.bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
            symLines(shape.pts).forEach((line) => stampPolyline(sess, line));
            core.invalidate();
            vibrate(20);
          }
        }
      }, moved ? 560 : 480);
    };
    startHold();

    const curveTo = (np, nPr) => {
      const mid = [(prev[0] + np[0]) / 2, (prev[1] + np[1]) / 2];
      const midPr = (prevPr + nPr) / 2;
      const len = Math.hypot(mid[0] - lastMid[0], mid[1] - lastMid[1]) + Math.hypot(prev[0] - lastMid[0], prev[1] - lastMid[1]);
      const n = clamp(Math.ceil(len / 3), 1, 28);
      let ax = lastMid[0]; let ay = lastMid[1]; let ap = lastMidPr;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const x = u * u * lastMid[0] + 2 * u * t * prev[0] + t * t * mid[0];
        const y = u * u * lastMid[1] + 2 * u * t * prev[1] + t * t * mid[1];
        const pr = lerp(lastMidPr, midPr, t);
        walkSegment(sess.walk, ax, ay, ap, x, y, pr, spacingFor(sess), (sx, sy, sp) => dab(sess, sx, sy, sp));
        ax = x; ay = y; ap = pr;
      }
      lastMid = mid; lastMidPr = midPr;
      prev = np.slice(); prevPr = nPr;
    };

    return {
      move(ev, cc) {
        if (snapped) return;
        const dxy = Math.hypot(cc[0] - lastC[0], cc[1] - lastC[1]);
        if (eyedropping) { core.tools.showLoupe(cc); lastC = cc; return; }
        const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
        (events.length ? events : [ev]).forEach((sub) => {
          const cp = core.canvasPoint(sub);
          const raw1 = toPaperClamped(cp);
          const pr = sess.pen && sub.pressure > 0 ? sub.pressure : 1;
          raw.push(raw1);
          const f = k();
          sm = [sm[0] + (raw1[0] - sm[0]) * f, sm[1] + (raw1[1] - sm[1]) * f];
          curveTo(sm, pr);
        });
        if (dxy > cssPx(1.5)) { moved = true; lastC = cc; startHold(); }
        core.invalidate();
      },
      up() {
        clearTimeout(timer);
        if (eyedropping) { core.tools.hideLoupe(); core.setColor(rgbToHex(...core.sampleColor(...toPaperClamped(lastC))), { remember: true }); return; }
        if (!snapped) {
          // catch up to the finger and finish the curve
          const last = raw[raw.length - 1];
          curveTo(last, prevPr);
          walkSegment(sess.walk, lastMid[0], lastMid[1], lastMidPr, last[0], last[1], prevPr, spacingFor(sess), (x, y, p) => dab(sess, x, y, p));
        }
        finishStroke(sess, erase ? 'erase' : 'draw');
      },
      cancel() { clearTimeout(timer); if (eyedropping) core.tools.hideLoupe(); dropStroke(); },
    };
  }

  // ------------------------------------------------------------- smudge
  function smudgeSession(e, c) {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return null;
    const brush = { ...brushById('paint'), hardness: 0.35, grain: 0, id: 'smudge-tip' };
    core.snapshot(L);
    const dPaper = Math.max(1.5, core.size / core.view.z);
    const D = Math.max(6, Math.round(dPaper * RS));
    const buf = mk(D, D);
    const bg = buf.getContext('2d');
    const masked = mk(D, D);
    const mg = masked.getContext('2d');
    const region = mk(D, D);
    const rg = region.getContext('2d');
    const strength = clamp(core.opacity / 100, 0.05, 1) * 0.7;
    const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grab = (g, x, y) => { g.clearRect(0, 0, D, D); g.drawImage(L.canvas, x - D / 2, y - D / 2, D, D, 0, 0, D, D); };
    const p0 = toPaperClamped(c);
    let last = [p0[0] * RS, p0[1] * RS];
    grab(bg, last[0], last[1]);
    const walk = { carry: 0 };
    const step = (x, y) => {
      grab(rg, x, y);
      mg.globalCompositeOperation = 'copy'; mg.drawImage(buf, 0, 0);
      mg.globalCompositeOperation = 'destination-in'; mg.drawImage(getTip(brush, '#000000', D, 0), 0, 0, D, D);
      mg.globalCompositeOperation = 'source-over';
      L.ctx.save();
      core.clipSelection(L.ctx);
      L.ctx.globalAlpha = strength;
      if (L.alphaLock) L.ctx.globalCompositeOperation = 'source-atop';
      L.ctx.drawImage(masked, x - D / 2, y - D / 2);
      L.ctx.restore();
      bg.globalAlpha = 0.3; bg.drawImage(region, 0, 0); bg.globalAlpha = 1;
      bb.x0 = Math.min(bb.x0, x - D / 2); bb.y0 = Math.min(bb.y0, y - D / 2);
      bb.x1 = Math.max(bb.x1, x + D / 2); bb.y1 = Math.max(bb.y1, y + D / 2);
    };
    return {
      move(ev, cc) {
        const p = toPaperClamped(cc);
        const now = [p[0] * RS, p[1] * RS];
        walkSegment(walk, last[0], last[1], 1, now[0], now[1], 1, () => Math.max(1.5, D * 0.12), (x, y) => step(x, y));
        last = now;
        core.invalidate();
      },
      up() {
        if (!isFinite(bb.x0)) return;
        core.commitPixels(L, core.rectOf(bb.x0, bb.y0, bb.x1, bb.y1), core.snap, 'smudge');
      },
      cancel() {
        L.ctx.save(); L.ctx.globalCompositeOperation = 'copy'; L.ctx.drawImage(core.snap, 0, 0); L.ctx.restore();
        core.invalidate();
      },
    };
  }

  // --------------------------------------------------------------- fill
  function fillAt(p) {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return;
    let srcCanvas = L.canvas;
    if (core.fillAll) srcCanvas = core.flatten();
    const sg = srcCanvas.getContext('2d');
    const img = sg.getImageData(0, 0, LW, LH);
    const x = Math.round(p[0] * RS); const y = Math.round(p[1] * RS);
    const tol = Math.round((core.fillTol / 100) * 255);
    let res = floodFill(img.data, LW, LH, x, y, tol);
    if (core.fillGrow > 0) res = dilateMask(res, LW, LH, core.fillGrow);
    const w = res.maxx - res.minx + 1; const h = res.maxy - res.miny + 1;
    if (w <= 0 || h <= 0) return;
    const rgb = hexParts(core.color);
    const out = new ImageData(w, h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if (res.mask[(res.miny + yy) * LW + res.minx + xx]) {
          const i = (yy * w + xx) * 4;
          out.data[i] = rgb[0]; out.data[i + 1] = rgb[1]; out.data[i + 2] = rgb[2]; out.data[i + 3] = 255;
        }
      }
    }
    const tmp = mk(w, h);
    tmp.getContext('2d').putImageData(out, 0, 0);
    core.snapshot(L);
    L.ctx.save();
    core.clipSelection(L.ctx);
    if (L.alphaLock) L.ctx.globalCompositeOperation = 'source-atop';
    L.ctx.globalAlpha = clamp(core.opacity / 100, 0.05, 1);
    L.ctx.drawImage(tmp, res.minx, res.miny);
    L.ctx.restore();
    core.commitPixels(L, { x: res.minx, y: res.miny, w, h }, core.snap, 'fill');
    core.invalidate();
  }
  function hexParts(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
  }
  function fillSession(e, c) {
    const start = c;
    return {
      move() {},
      up(ev) {
        const cc = core.canvasPoint(ev);
        if (Math.hypot(cc[0] - start[0], cc[1] - start[1]) < cssPx(14)) fillAt(toPaperClamped(cc));
      },
      cancel() {},
    };
  }
  // fill the selection (or the whole layer) with the colour
  function fillSelection() {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return;
    core.snapshot(L);
    L.ctx.save();
    core.clipSelection(L.ctx);
    if (L.alphaLock) L.ctx.globalCompositeOperation = 'source-atop';
    L.ctx.globalAlpha = clamp(core.opacity / 100, 0.05, 1);
    L.ctx.fillStyle = core.color;
    L.ctx.fillRect(0, 0, LW, LH);
    L.ctx.restore();
    core.commitPixels(L, core.selectionBounds(), core.snap, 'fill');
    core.invalidate();
  }

  // ---------------------------------------------------------- eyedropper
  let loupe = null;
  function showLoupe(c) {
    const p = toPaperClamped(c);
    const rgb = core.sampleColor(p[0], p[1]);
    loupe = { x: c[0], y: c[1], color: rgbToHex(...rgb) };
    core.setOvExtra(drawLoupe);
  }
  function hideLoupe() { loupe = null; core.setOvExtra(tfOverlay); }
  function drawLoupe(g) {
    tfOverlay(g);
    if (!loupe) return;
    const r = cssPx(26);
    const cx = loupe.x;
    const cy = Math.max(r + 4, loupe.y - cssPx(54));
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = loupe.color; g.fill();
    g.lineWidth = cssPx(4); g.strokeStyle = '#ffffff'; g.stroke();
    g.lineWidth = cssPx(1.5); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.stroke();
    g.beginPath(); g.arc(loupe.x, loupe.y, cssPx(5), 0, Math.PI * 2);
    g.lineWidth = cssPx(1.5); g.strokeStyle = '#fff'; g.stroke();
    g.restore();
  }
  function eyedropSession(e, c) {
    showLoupe(c);
    let last = c;
    return {
      move(ev, cc) { last = cc; showLoupe(cc); },
      up() {
        hideLoupe();
        const p = toPaperClamped(last);
        core.setColor(rgbToHex(...core.sampleColor(p[0], p[1])), { remember: true });
        if (core.tool === 'eyedrop') core.setTool(core.prevTool || 'brush');
      },
      cancel() { hideLoupe(); },
    };
  }

  // ------------------------------------------------------------ selection
  function selectSession(e, c) {
    const p0 = toPaperClamped(c);
    let pts = [p0];
    let cur = p0;
    const mode = core.selMode;
    const poly = () => {
      if (mode === 'lasso') return pts.concat([]);
      return shapePoints(mode === 'ellipse' ? 'ellipse' : 'rect', p0, cur).slice(0, mode === 'ellipse' ? 72 : 4);
    };
    core.setOvExtra((g) => {
      tfOverlay(g);
      const pl = poly();
      if (pl.length < 2) return;
      g.save(); g.beginPath(); core.drawPoly(g, pl, mode !== 'lasso');
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.setLineDash([6, 5]); g.stroke();
      g.fillStyle = 'rgba(96,165,250,0.12)'; if (mode === 'lasso') g.closePath(); g.fill();
      g.restore();
    });
    return {
      move(ev, cc) {
        cur = toPaperClamped(cc);
        if (mode === 'lasso') {
          const last = pts[pts.length - 1];
          if (Math.hypot(cur[0] - last[0], cur[1] - last[1]) > 1.2 / core.view.z) pts.push(cur);
        }
        core.invalidate();
      },
      up() {
        core.setOvExtra(tfOverlay);
        const pl = poly();
        let ok = pl.length >= 3;
        if (mode !== 'lasso') ok = Math.abs(cur[0] - p0[0]) > 3 / core.view.z && Math.abs(cur[1] - p0[1]) > 3 / core.view.z;
        else if (ok) { // too small a doodle -> treat as a tap
          const xs = pl.map((q) => q[0]); const ys = pl.map((q) => q[1]);
          ok = Math.max(...xs) - Math.min(...xs) > 4 && Math.max(...ys) - Math.min(...ys) > 4;
        }
        if (ok) { core.setSelection({ pts: pl, invert: false }); vibrate(8); }
        else core.setSelection(null);
      },
      cancel() { core.setOvExtra(tfOverlay); core.invalidate(); },
    };
  }
  function selectAll() { core.setSelection({ pts: [[0, 0], [PAPER_W, 0], [PAPER_W, PAPER_H], [0, PAPER_H]], invert: false }); }
  function deselect() { core.setSelection(null); }
  function invertSelection() {
    if (!core.selection) { selectAll(); return; }
    core.setSelection({ pts: core.selection.pts, invert: !core.selection.invert });
  }
  function clearSelectionPixels() {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return;
    core.snapshot(L);
    L.ctx.save(); core.clipSelection(L.ctx); L.ctx.clearRect(0, 0, LW, LH); L.ctx.restore();
    core.commitPixels(L, core.selectionBounds(), core.snap, 'clear selection');
    core.invalidate();
  }
  function copySelection({ cutIt = false } = {}) {
    const L = core.activeLayer();
    if (!L) return false;
    const r = core.selectionBounds();
    const c = mk(r.w, r.h);
    const g = c.getContext('2d');
    g.save(); g.translate(-r.x, -r.y); core.clipSelection(g); g.drawImage(L.canvas, 0, 0); g.restore();
    core.clipboard = { canvas: c, x: r.x, y: r.y };
    core.emit('clipboard');
    if (cutIt) clearSelectionPixels();
    else showToast('Copied.');
    return true;
  }
  function pasteClipboard() {
    const cb = core.clipboard;
    if (!cb) { showToast('Nothing copied yet.'); return false; }
    return beginFloating(cb.canvas, cb.x, cb.y, { newLayer: true, name: 'Pasted' });
  }
  function insertImage(img) {
    const iw = img.naturalWidth || img.width; const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return false;
    const fit = Math.min((LW * 0.8) / iw, (LH * 0.8) / ih, 1.5);
    const w = Math.max(8, Math.round(iw * fit)); const h = Math.max(8, Math.round(ih * fit));
    const c = mk(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return beginFloating(c, Math.round((LW - w) / 2), Math.round((LH - h) / 2), { newLayer: true, name: 'Photo' });
  }

  // ----------------------------------------------------------- transform
  // A floating piece of picture that can be moved, scaled and rotated before
  // it is put down. Comes from the selection (or the whole layer), a paste,
  // or an inserted photo.
  function tfCorners() {
    const t = core.tf;
    const hw = (t.rect.w * t.sx) / 2; const hh = (t.rect.h * t.sy) / 2;
    const cos = Math.cos(t.rot); const sin = Math.sin(t.rot);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => [
      t.cx + t.tx + lx * cos - ly * sin, t.cy + t.ty + lx * sin + ly * cos,
    ]); // raster coords
  }
  const rasterToCanvas = (p) => core.toCanvas(p[0] / RS, p[1] / RS);
  function tfCanvasGeom() {
    const cs = tfCorners().map(rasterToCanvas);
    const centre = rasterToCanvas([core.tf.cx + core.tf.tx, core.tf.cy + core.tf.ty]);
    const topMid = [(cs[0][0] + cs[1][0]) / 2, (cs[0][1] + cs[1][1]) / 2];
    let ux = topMid[0] - centre[0]; let uy = topMid[1] - centre[1];
    const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const knob = [topMid[0] + ux * cssPx(30), topMid[1] + uy * cssPx(30)];
    return { cs, centre, topMid, knob };
  }
  function tfOverlay(g) {
    if (!core.tf) return;
    const { cs, topMid, knob } = tfCanvasGeom();
    g.save();
    g.beginPath(); cs.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
    g.lineWidth = cssPx(3); g.strokeStyle = 'rgba(0,0,0,0.5)'; g.stroke();
    g.lineWidth = cssPx(1.5); g.strokeStyle = '#60a5fa'; g.stroke();
    g.beginPath(); g.moveTo(topMid[0], topMid[1]); g.lineTo(knob[0], knob[1]); g.stroke();
    const hs = cssPx(7);
    const dot = (p, fill) => { g.beginPath(); g.arc(p[0], p[1], hs, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.lineWidth = cssPx(2); g.strokeStyle = '#2563eb'; g.stroke(); };
    cs.forEach((p) => dot(p, '#fff'));
    dot(knob, '#60a5fa');
    g.restore();
  }
  function drawFloating(g, t) {
    g.save();
    g.translate(t.cx + t.tx, t.cy + t.ty);
    g.rotate(t.rot);
    g.scale(t.sx, t.sy);
    g.translate(-t.cx, -t.cy);
    g.drawImage(t.floating, t.rect.x, t.rect.y);
    g.restore();
  }
  function beginFloating(floating, x, y, { newLayer = false, name = 'Layer' } = {}) {
    if (core.tf) applyTransform();
    let L = core.activeLayer();
    let added = false;
    if (newLayer) {
      L = core.addLayer(name);
      if (!L) return false;
      added = true;
    } else if (!core.canEdit(L)) return false;
    const rect = { x, y, w: floating.width, h: floating.height };
    const snapC = mk(LW, LH);
    snapC.getContext('2d').drawImage(L.canvas, 0, 0);
    core.tf = { layer: L, floating, rect, cx: x + rect.w / 2, cy: y + rect.h / 2, tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, snap: snapC, free: false, added };
    core.overlay = { layer: L, apply(g) { drawFloating(g, core.tf); } };
    core.tool = 'transform';
    core.setOvExtra(tfOverlay);
    core.emit('tool'); core.emit('transform');
    core.invalidate();
    return true;
  }
  function beginTransform() {
    if (core.tf) return true;
    const L = core.activeLayer();
    if (!core.canEdit(L)) return false;
    const r = core.selection ? core.selectionBounds() : { x: 0, y: 0, w: LW, h: LH };
    const f = mk(r.w, r.h);
    const g = f.getContext('2d');
    g.save(); g.translate(-r.x, -r.y); core.clipSelection(g); g.drawImage(L.canvas, 0, 0); g.restore();
    const snapC = mk(LW, LH);
    snapC.getContext('2d').drawImage(L.canvas, 0, 0);
    // lift the pixels out of the layer while they float
    L.ctx.save(); core.clipSelection(L.ctx); L.ctx.clearRect(0, 0, LW, LH); L.ctx.restore();
    core.tf = { layer: L, floating: f, rect: r, cx: r.x + r.w / 2, cy: r.y + r.h / 2, tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, snap: snapC, free: false, added: false };
    core.overlay = { layer: L, apply(gg) { drawFloating(gg, core.tf); } };
    core.setOvExtra(tfOverlay);
    core.emit('transform');
    core.invalidate();
    return true;
  }
  function endTransformState() {
    core.tf = null; core.overlay = null;
    core.setOvExtra(tfOverlay);
    if (core.tool === 'transform') core.tool = core.prevTool || 'brush';
    core.emit('tool'); core.emit('transform');
    core.invalidate();
  }
  function applyTransform() {
    const t = core.tf;
    if (!t) return;
    const L = t.layer;
    drawFloating(L.ctx, t);
    // changed area: where it was + where it landed
    const cs = tfCorners();
    const xs = cs.map((p) => p[0]).concat([t.rect.x, t.rect.x + t.rect.w]);
    const ys = cs.map((p) => p[1]).concat([t.rect.y, t.rect.y + t.rect.h]);
    const rect = core.rectOf(Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2);
    const snapC = t.snap;
    core.selection && core.setSelection(null);
    endTransformState();
    core.commitPixels(L, rect, snapC, 'transform');
  }
  function cancelTransform() {
    const t = core.tf;
    if (!t) return;
    const L = t.layer;
    L.ctx.save(); L.ctx.globalCompositeOperation = 'copy'; L.ctx.drawImage(t.snap, 0, 0); L.ctx.restore();
    core.touch(L);
    const added = t.added;
    endTransformState();
    if (added) { core.undo(); core.history.redo.pop(); core.emit('history'); }
  }
  function flip(axis) {
    const t = core.tf;
    if (!t) return;
    if (axis === 'h') t.sx *= -1; else t.sy *= -1;
    core.invalidate(); core.emit('transform');
  }
  function transformSession(e, c) {
    const t = core.tf;
    if (!t) return null;
    const { cs, centre, knob } = tfCanvasGeom();
    const hit = cssPx(22);
    const near = (p) => Math.hypot(c[0] - p[0], c[1] - p[1]) < hit;
    const start = { tx: t.tx, ty: t.ty, rot: t.rot, sx: t.sx, sy: t.sy };
    let mode = 'move';
    if (near(knob)) mode = 'rotate';
    else if (cs.some(near)) mode = 'scale';
    else {
      // inside the quad? else still move (grab anywhere)
      mode = 'move';
    }
    const p0 = core.toPaper(c[0], c[1]);
    const ang0 = Math.atan2(c[1] - centre[1], c[0] - centre[0]);
    const d0 = Math.hypot(c[0] - centre[0], c[1] - centre[1]) || 1;
    return {
      move(ev, cc) {
        if (mode === 'move') {
          const p = core.toPaper(cc[0], cc[1]);
          t.tx = start.tx + (p[0] - p0[0]) * RS;
          t.ty = start.ty + (p[1] - p0[1]) * RS;
        } else if (mode === 'rotate') {
          let a = start.rot + (Math.atan2(cc[1] - centre[1], cc[0] - centre[0]) - ang0);
          const q = (15 * Math.PI) / 180;
          const near15 = Math.round(a / q) * q;
          if (Math.abs(a - near15) < (3 * Math.PI) / 180) a = near15;
          t.rot = a;
        } else {
          const d = Math.hypot(cc[0] - centre[0], cc[1] - centre[1]);
          if (!t.free) {
            const f = clamp(d / d0, 0.05, 40);
            t.sx = start.sx * f; t.sy = start.sy * f;
          } else {
            // free: size each side from where the pointer is in the box's own axes
            const pp = core.toPaper(cc[0], cc[1]);
            const rx = pp[0] * RS - (t.cx + t.tx); const ry = pp[1] * RS - (t.cy + t.ty);
            const cos = Math.cos(-t.rot); const sin = Math.sin(-t.rot);
            const lx = rx * cos - ry * sin; const ly = rx * sin + ry * cos;
            t.sx = Math.sign(start.sx || 1) * clamp(Math.abs(lx) / (t.rect.w / 2), 0.05, 40);
            t.sy = Math.sign(start.sy || 1) * clamp(Math.abs(ly) / (t.rect.h / 2), 0.05, 40);
          }
        }
        core.invalidate(); core.emit('transform');
      },
      up() {}, cancel() {},
    };
  }

  // -------------------------------------------------------------- shapes
  function shapeSession(e, c) {
    const L = core.activeLayer();
    if (!core.canEdit(L)) return null;
    const sess = newStroke(L, e, { erase: false });
    const p0 = toPaperClamped(c);
    let p1 = p0;
    let drawn = false;
    const render = (square) => {
      core.strokeCtx.clearRect(0, 0, LW, LH);
      sess.bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const pts = shapePoints(core.shapeKind, p0, p1, { square });
      const lines = symLines(pts);
      lines.forEach((line) => {
        if (core.shapeFill && core.shapeKind !== 'line') {
          const g = core.strokeCtx;
          g.save(); g.fillStyle = sess.color; g.beginPath();
          line.forEach((q, i) => (i ? g.lineTo(q[0] * RS, q[1] * RS) : g.moveTo(q[0] * RS, q[1] * RS)));
          g.closePath(); g.fill(); g.restore();
          line.forEach((q) => growBox(sess, q[0] * RS, q[1] * RS, 4));
        }
        stampPolyline(sess, line);
      });
      drawn = true;
      core.invalidate();
    };
    return {
      move(ev, cc) { p1 = toPaperClamped(cc); render(ev.shiftKey); },
      up(ev) {
        if (!drawn || Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 2 / core.view.z) { dropStroke(); return; }
        finishStroke(sess, 'shape');
      },
      cancel() { dropStroke(); },
    };
  }

  // ---------------------------------------------------------------- start
  function start(tool, e, c) {
    switch (tool) {
      case 'brush': case 'eraser': return brushSession(e, c);
      case 'smudge': return smudgeSession(e, c);
      case 'fill': return fillSession(e, c);
      case 'eyedrop': return eyedropSession(e, c);
      case 'select': return selectSession(e, c);
      case 'shape': return shapeSession(e, c);
      case 'transform': return transformSession(e, c);
      default: return null;
    }
  }

  core.setOvExtra(tfOverlay);
  return {
    start, showLoupe, hideLoupe,
    beginTransform, applyTransform, cancelTransform, flip,
    selectAll, deselect, invertSelection, clearSelectionPixels, fillSelection,
    copySelection, pasteClipboard, insertImage, fillAt,
    cssPx, geometry: () => (core.tf ? tfCanvasGeom() : null),
  };
}
