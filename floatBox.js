// floatBox.js -- makes any position:fixed box movable and resizable.
//
//   const fb = makeFloatable(el, { head, key: 'sketch.layers', place });
//
//   head   the title bar: drag it to move the box, double-tap it to put the
//          box back to its default place and size
//   key    where the chosen position / size is remembered (localStorage)
//   place  () => void   puts the box in its DEFAULT spot (called whenever the
//          box has not been moved by hand)
//   onMove / onDrop  (pointerEvent) => void   called while the title bar is
//          being dragged / when it is let go (used e.g. for snap-back zones)
//   The box gets the class `fb-sized` while it has a hand-picked height.
//
// A strip along the bottom edge ALSO moves the box (so a tall box can be grabbed
// from either end), a grip in the bottom-right corner resizes it, and on a touch
// screen two fingers pinching on the box resize it (the box keeps its centre and
// follows the fingers); dragging any of the four edges resizes from that side. Works with mouse, touch and pen. RULE FOR THIS APP: every new floating box / popup / panel should go
// through this helper so it can always be moved and resized.
import { isFreeMode, snapPosition } from './snapSwitch.js';
import { clamp } from './utils.js';
const KEY_PREFIX = 'spac3.float.';

// Which boxes currently have a handle held (a drag, a resize...): while any does, the page carries the class
// `fb-dragging`, which lays a see-through sheet over everything and makes videos let the pointer through.
const frozenBy = new Set();
function freezePage(owner, on) {
  if (on) frozenBy.add(owner); else frozenBy.delete(owner);
  document.body.classList.toggle('fb-dragging', frozenBy.size > 0);
}

export function makeFloatable(el, { head, key, minW = 200, minH = 120, place, onMove, onDrop } = {}) {
  const g = { x: null, y: null, w: null, h: null };
  function load() {
    g.x = g.y = g.w = g.h = null;
    if (!key) return;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_PREFIX + key) || 'null');
      if (saved && typeof saved === 'object') {
        ['x', 'y', 'w', 'h'].forEach((k) => { if (typeof saved[k] === 'number') g[k] = saved[k]; });
      }
    } catch { /* ignore */ }
  }
  load();
  const save = () => {
    if (!key) return;
    try {
      if (g.x == null && g.w == null) localStorage.removeItem(KEY_PREFIX + key);
      else localStorage.setItem(KEY_PREFIX + key, JSON.stringify(g));
    } catch { /* private mode */ }
  };

  function apply() {
    const vw = window.innerWidth; const vh = window.innerHeight;
    el.classList.toggle('fb-sized', g.h != null);
    if (g.w != null) el.style.width = `${clamp(g.w, minW, vw - 8)}px`; else el.style.width = '';
    if (g.h != null) { el.style.height = `${clamp(g.h, minH, vh - 8)}px`; el.style.maxHeight = 'none'; } else { el.style.height = ''; el.style.maxHeight = ''; }
    if (g.x != null && g.y != null) {
      const w = el.offsetWidth;
      el.style.left = `${clamp(g.x, 4, Math.max(4, vw - w - 4))}px`;
      el.style.top = `${clamp(g.y, 4, Math.max(4, vh - 56))}px`; // keep the title bar reachable
    } else if (place) place();
  }
  const fixHere = () => { const r = el.getBoundingClientRect(); g.x = r.left; g.y = r.top; };

  // ---- move: by the title bar, or by the strip along the bottom edge
  const drag = { id: null, handle: null, dx: 0, dy: 0 };
  const owner = {};
  let pinching = false;
  let hold = null;
  const HOLD_MS = 500;
  const clearHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  const NO_HOLD = 'input, select, textarea, canvas, video, iframe, [role="slider"], [role="dialog"], .fb-resize, .fb-edge, .fb-foot';
  // carry the box from the spot of the original press (handle = whichever bar owns the move events)
  function beginDrag(handle, ev, viaWindow = false) {
    const r = el.getBoundingClientRect();
    drag.viaWindow = viaWindow; // a press that started on a button: capture may not stick, so the window also feeds the drag
    drag.id = ev.pointerId; drag.handle = handle; drag.dx = ev.clientX - r.left; drag.dy = ev.clientY - r.top;
    try { handle.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    handle.classList.add('is-dragging');
    if (ev.pointerType !== 'touch') freezePage(owner, true); // (a finger keeps its pointer by itself; a shield would also catch a second finger of a pinch)
  }
  // A press that has to wait: on a button (it works as a button on a quick press, but grabbing it and moving,
  // or holding it still for half a second, takes the whole box along) or on the box body (holding still for
  // half a second picks it up; moving first just cancels, so scrolling and text selection work as usual).
  function armHold(e, handle, canDrag) {
    clearHold();
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, handle, canDrag, timer: setTimeout(() => {
      const h = hold; hold = null;
      if (!h || drag.id != null || pinching) return;
      beginDrag(h.handle, { pointerId: h.id, clientX: h.x, clientY: h.y }, true);
      const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, true), 400);
    }, HOLD_MS) };
  }
  if (head) {
    el.addEventListener('pointerdown', (e) => {
      if (pinching || drag.id != null || (e.button !== undefined && e.button !== 0)) return;
      const hit = e.target.closest(NO_HOLD);
      if ((hit && hit !== el && el.contains(hit)) || head.contains(e.target)) return;
      armHold(e, head, false);
    }, true);
    window.addEventListener('pointerup', (e) => { if (hold && e.pointerId === hold.id) clearHold(); }, true);
    window.addEventListener('pointercancel', (e) => { if (hold && e.pointerId === hold.id) clearHold(); }, true);
    window.addEventListener('pointermove', (e) => {
      if (!hold || e.pointerId !== hold.id || Math.hypot(e.clientX - hold.x, e.clientY - hold.y) <= 6) return;
      const h = hold; clearHold();
      if (h.canDrag && drag.id == null && !pinching) {
        beginDrag(h.handle, { pointerId: h.id, clientX: h.x, clientY: h.y }, true);
        const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, true), 400);
        // carry on with this very movement
        e.__fb = true; dragMove(h.handle, e);
      }
    }, true);
    window.addEventListener('pointermove', (e) => { if (drag.viaWindow && drag.id === e.pointerId && drag.handle && !e.__fb) { e.__fb = true; dragMove(drag.handle, e); } }, true);
    const winEnd = (e) => { if (drag.viaWindow && drag.id === e.pointerId && drag.handle && !e.__fbEnd) { e.__fbEnd = true; dragEnd(drag.handle, e); } };
    window.addEventListener('pointerup', winEnd, true); window.addEventListener('pointercancel', winEnd, true);
  }
  function dragMove(handle, e) {
    if (e.pointerId !== drag.id || drag.handle !== handle || pinching) return;
    g.x = e.clientX - drag.dx; g.y = e.clientY - drag.dy;
    if (!isFree()) {
      const sp = snapPosition({ x: g.x, y: g.y, w: el.offsetWidth, h: el.offsetHeight }, { skip: el });
      g.x = sp.x; g.y = sp.y; el.classList.toggle('fb-snapped', sp.hit);
    }
    apply();
    onMove?.(e);
  }
  function dragEnd(handle, e) {
    if (hold && e.pointerId === hold.id) clearHold();
    if (e.pointerId !== drag.id || drag.handle !== handle) return;
    drag.id = null; drag.handle = null; drag.viaWindow = false; handle.classList.remove('is-dragging'); freezePage(owner, false); el.classList.remove('fb-snapped'); save();
    if (e.type === 'pointerup') onDrop?.(e); else onDrop?.(null);
  }
  function bindDrag(handle) {
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
      if (pinching || drag.id != null) return;
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('button, input, select, textarea, a')) {
        if (handle === head && !e.target.closest('input, select, textarea')) armHold(e, handle, true);
        return;
      }
      beginDrag(handle, e);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (!e.__fb) { e.__fb = true; dragMove(handle, e); } });
    handle.addEventListener('pointerup', (e) => { if (!e.__fbEnd) { e.__fbEnd = true; dragEnd(handle, e); } });
    handle.addEventListener('pointercancel', (e) => { if (!e.__fbEnd) { e.__fbEnd = true; dragEnd(handle, e); } });
    handle.addEventListener('dblclick', (e) => { if (e.target.closest('button, input, select, textarea, a')) return; reset(); });
  }
  if (head) bindDrag(head);
  // Snapping (the default) clicks the box onto window edges and other boxes while it is dragged; the single
  // Snap | Free switch in the settings menu turns that off for every box (free = exactly where you drop it).
  const isFree = () => isFreeMode();
  const foot = document.createElement('div');
  foot.className = 'fb-foot';
  foot.title = 'Drag here to move (double-tap to reset)';
  foot.setAttribute('aria-hidden', 'true');
  el.append(foot);
  bindDrag(foot);

  // ---- two fingers on the box resize it (touch screens)
  {
    const touches = new Map();
    let p0 = null;
    const dist = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
    const mid = () => { const [a, b] = [...touches.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    const stop = (e) => {
      if (!touches.delete(e.pointerId)) return;
      if (pinching && touches.size < 2) { pinching = false; p0 = null; save(); onDrop?.(null); }
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && !pinching) {
        // hand over from any one-finger drag/resize that was already going
        if (drag.handle) { drag.handle.classList.remove('is-dragging'); freezePage(owner, false); drag.id = null; drag.handle = null; }
        pinching = true;
        const r = el.getBoundingClientRect();
        const m = mid();
        p0 = { d: dist(), w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, mx: m.x, my: m.y };
        e.preventDefault();
      }
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinching || !p0 || touches.size < 2) return;
      const vw = window.innerWidth; const vh = window.innerHeight;
      // one scale factor for both sides, so the picture keeps its shape; limited by the window and the minimum size
      const k = Math.max(minW / p0.w, minH / p0.h, Math.min(dist() / p0.d, (vw - 8) / p0.w, (vh - 8) / p0.h));
      const m = mid();
      g.w = p0.w * k;
      g.h = p0.h * k;
      g.x = p0.cx + (m.x - p0.mx) - g.w / 2; // the box follows the middle of the two fingers (as before)
      g.y = p0.cy + (m.y - p0.my) - g.h / 2;
      apply();
      onMove?.(null);
    }, true);
    ['pointerup', 'pointercancel'].forEach((t) => el.addEventListener(t, stop, true));
  }

  // ---- resize (bottom-right grip)
  const grip = document.createElement('div');
  grip.className = 'fb-resize';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-label', 'Drag to resize');
  grip.title = 'Drag to resize';
  grip.style.touchAction = 'none';
  el.append(grip);
  {
    let id = null; let sx = 0; let sy = 0; let sw = 0; let sh = 0;
    grip.addEventListener('pointerdown', (e) => {
      if (pinching || (e.button !== undefined && e.button !== 0)) return;
      const r = el.getBoundingClientRect();
      fixHere(); // freeze the top-left corner so it grows from there
      id = e.pointerId; sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      try { grip.setPointerCapture(id); } catch { /* ignore */ }
      e.preventDefault(); e.stopPropagation();
    });
    grip.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const vw = window.innerWidth; const vh = window.innerHeight;
      g.w = clamp(sw + (e.clientX - sx), minW, Math.max(minW, vw - g.x - 4));
      g.h = clamp(sh + (e.clientY - sy), minH, Math.max(minH, vh - g.y - 4));
      apply();
    });
    const end = (e) => { if (e.pointerId === id) { id = null; save(); } };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // ---- resize from any edge (top / bottom / left / right): a thin strip inside each edge
  [['n', 'ns-resize'], ['s', 'ns-resize'], ['e', 'ew-resize'], ['w', 'ew-resize']].forEach(([side, cursor]) => {
    const edge = document.createElement('div');
    edge.className = `fb-edge fb-edge-${side}`;
    edge.setAttribute('aria-hidden', 'true');
    edge.style.cursor = cursor; edge.style.touchAction = 'none';
    el.append(edge);
    let id = null; let sx = 0; let sy = 0; let r0 = null;
    edge.addEventListener('pointerdown', (e) => {
      if (pinching || (e.button !== undefined && e.button !== 0)) return;
      r0 = el.getBoundingClientRect();
      fixHere();
      id = e.pointerId; sx = e.clientX; sy = e.clientY;
      try { edge.setPointerCapture(id); } catch { /* ignore */ }
      e.preventDefault(); e.stopPropagation();
    });
    edge.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id || !r0) return;
      if (pinching) { id = null; r0 = null; return; } // a second finger turns it into a pinch
      const vw = window.innerWidth; const vh = window.innerHeight;
      const dx = e.clientX - sx; const dy = e.clientY - sy;
      if (side === 'e') g.w = clamp(r0.width + dx, minW, Math.max(minW, vw - r0.left - 4));
      else if (side === 'w') { const w = clamp(r0.width - dx, minW, Math.max(minW, r0.right - 4)); g.w = w; g.x = r0.right - w; }
      else if (side === 's') g.h = clamp(r0.height + dy, minH, Math.max(minH, vh - r0.top - 4));
      else { const h = clamp(r0.height - dy, minH, Math.max(minH, r0.bottom - 4)); g.h = h; g.y = r0.bottom - h; }
      apply();
    });
    const end = (e) => { if (e.pointerId === id) { id = null; r0 = null; save(); } };
    edge.addEventListener('pointerup', end);
    edge.addEventListener('pointercancel', end);
  });

  // ---- resize from the other three corners too (the bottom-right one has the visible grip above): a small
  // invisible square in each corner; dragging it moves those two edges and keeps the opposite corner fixed
  [['tl', 'nwse-resize'], ['tr', 'nesw-resize'], ['bl', 'nesw-resize']].forEach(([c, cursor]) => {
    const z = document.createElement('div');
    z.className = `fb-corner fb-corner-${c}`;
    z.setAttribute('aria-hidden', 'true');
    z.style.cursor = cursor; z.style.touchAction = 'none';
    el.append(z);
    let id = null; let sx = 0; let sy = 0; let r0 = null;
    z.addEventListener('pointerdown', (e) => {
      if (pinching || (e.button !== undefined && e.button !== 0)) return;
      r0 = el.getBoundingClientRect();
      fixHere();
      id = e.pointerId; sx = e.clientX; sy = e.clientY;
      try { z.setPointerCapture(id); } catch { /* ignore */ }
      e.preventDefault(); e.stopPropagation();
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id || !r0) return;
      if (pinching) { id = null; r0 = null; return; }
      const vw = window.innerWidth; const vh = window.innerHeight;
      const dx = e.clientX - sx; const dy = e.clientY - sy;
      if (c.includes('l')) { const w = clamp(r0.width - dx, minW, Math.max(minW, r0.right - 4)); g.w = w; g.x = r0.right - w; }
      else g.w = clamp(r0.width + dx, minW, Math.max(minW, vw - r0.left - 4));
      if (c.includes('t')) { const h = clamp(r0.height - dy, minH, Math.max(minH, r0.bottom - 4)); g.h = h; g.y = r0.bottom - h; }
      else g.h = clamp(r0.height + dy, minH, Math.max(minH, vh - r0.top - 4));
      apply();
    });
    const end = (e) => { if (e.pointerId === id) { id = null; r0 = null; save(); } };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  });

  // While a handle of this box is held (a resize edge / corner, the bottom strip, the title bar), videos let the
  // pointer through so a drag can never get lost inside a player's frame.
  let heldId = null;
  el.addEventListener('pointerdown', (e) => {
    // (a press on a button / field is a click until it turns into a drag, which freezes the page itself; freezing now would swallow the click)
    if (e.target.closest('button, input, select, textarea, a')) return;
    if (e.target.closest('.fb-edge, .fb-corner, .fb-resize, .fb-foot') || (head && head.contains(e.target))) {
      heldId = e.pointerId; if (e.pointerType !== 'touch') freezePage(owner, true);
      // (while the page is frozen the browser's own double-click lands on the shield, so a double-tap on the bottom strip / title bar is spotted here)
      heldTap = e.target.closest('.fb-foot') || (head && head.contains(e.target) && !e.target.closest('.fb-edge, .fb-corner, .fb-resize')) ? { x: e.clientX, y: e.clientY } : null;
    }
  }, true);
  let heldTap = null; let lastTap = 0;
  const unfreezeFrames = (e) => {
    if (e.pointerId !== heldId) return;
    heldId = null;
    if (e.type === 'pointerup' && heldTap && Math.hypot(e.clientX - heldTap.x, e.clientY - heldTap.y) < 10) {
      const now = Date.now();
      if (now - lastTap < 450) { lastTap = 0; reset(); } else lastTap = now;
    }
    heldTap = null;
    // (straight away: a quick second press of a double-tap must land on the box, not on the shield)
    if (drag.id == null) freezePage(owner, false);
  };
  window.addEventListener('pointerup', unfreezeFrames, true);
  window.addEventListener('pointercancel', unfreezeFrames, true);

  function reset() {
    g.x = g.y = g.w = g.h = null;
    save();
    apply();
  }
  return { apply, reset, reload: load, state: () => ({ ...g }), isCustom: () => g.x != null || g.w != null };
}
