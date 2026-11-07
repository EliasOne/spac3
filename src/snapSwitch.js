// snapSwitch.js -- the ONE "Snap | Free" switch (in the ⚙️ settings menu) that governs every movable box,
// plus the snapping maths the floating boxes (floatBox.js, game windows) share.
//
//   makeSnapSwitch(key)            a <button class="snap-switch"> showing both choices side by
//                                  side: the ACTIVE one is lit (blue magnet = snapping, amber
//                                  arrows = free), the other one is dimmed -- click to switch.
//   paintSnapSwitch(btn, free)     (re)draws a switch for the given state
//   isLooseKey(key) / setLooseKey  the remembered choice per box (localStorage, per browser)
//   snapPosition(rect, opts)       where a box dragged to `rect` should end up when snapping:
//                                  its edges click onto the window edges and onto the edges
//                                  of the other visible boxes, within a few pixels.
//
// ONE setting for every box (the Snap | Free switch in the ⚙️ settings menu in the SPAC3's header):
// "snap" (default) = boxes snap onto edges and neighbours and nudge each other aside;
// "free" = boxes go exactly where you drop them and nothing is nudged. Remembered in this browser.
const STORE = 'spac3.snap.mode.v1';
let freeMode = false;
try { freeMode = localStorage.getItem(STORE) === 'free'; } catch { /* ignore */ }
const listeners = new Set();
export const isFreeMode = () => freeMode;
export function setFreeMode(free) {
  freeMode = !!free;
  try { if (freeMode) localStorage.setItem(STORE, 'free'); else localStorage.removeItem(STORE); } catch { /* private mode */ }
  document.documentElement.classList.toggle('snap-free', freeMode);
  listeners.forEach((fn) => { try { fn(freeMode); } catch { /* ignore */ } });
}
export function onSnapModeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
document.documentElement.classList.toggle('snap-free', freeMode);

const MAGNET = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3v8a7 7 0 0 0 14 0V3"/><path d="M5 7h4M15 7h4"/></svg>';
const ARROWS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';

export function paintSnapSwitch(btn, free) {
  btn.classList.toggle('is-free', free);
  btn.classList.toggle('is-snap', !free);
  btn.setAttribute('aria-pressed', String(!free));
  btn.innerHTML = `<span class="ss-seg ss-snap${free ? '' : ' is-on'}">${MAGNET}<b>Snap</b></span><span class="ss-seg ss-free${free ? ' is-on' : ''}">${ARROWS}<b>Free</b></span>`;
  btn.title = free
    ? 'FREE MOVING is on: boxes go exactly where you drop them and nothing is nudged. Click to switch SNAPPING back on.'
    : 'SNAPPING is on: boxes click onto window edges and neighbours, and nudge each other aside. Click to switch to FREE MOVING.';
  btn.setAttribute('aria-label', free ? 'Free moving is on. Activate to turn snapping on.' : 'Snapping is on. Activate to move freely.');
}

// The switch itself (used in the ⚙️ settings menu): both choices side by side, the lit one is on.
export function makeSnapSwitch({ onChange } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'snap-switch';
  paintSnapSwitch(btn, freeMode);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFreeMode(!freeMode);
    onChange?.(freeMode);
  });
  onSnapModeChange((f) => paintSnapSwitch(btn, f));
  return btn;
}

// ---- snapping maths ----
export const SNAP_TARGETS = '.free-box:not(.panel-minimized), .looks-panel, .sketch-sheet, .room-bg-settings-panel, .media-embed-wrap.is-floating, .modal-backdrop--floating > .modal, #topbar';
const visible = (el) => !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
// rect {x, y, w, h}: the box where the pointer has put it. Returns the same with x / y
// pulled onto the nearest edge within `tol` px, and `hit` = whether anything was snapped.
export function snapPosition(rect, { skip, tol = 12, margin = 4 } = {}) {
  const vw = document.documentElement.clientWidth; const vh = window.innerHeight;
  const others = [...document.querySelectorAll(SNAP_TARGETS)].filter((el) => el !== skip && !(skip && (skip.contains(el) || el.contains(skip))) && visible(el)).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 24 && r.height > 12);
  let bestX = null; let bestY = null; // { d, v }
  const offerX = (v) => { const d = Math.abs(v - rect.x); if (d <= tol && (!bestX || d < bestX.d)) bestX = { d, v }; };
  const offerY = (v) => { const d = Math.abs(v - rect.y); if (d <= tol && (!bestY || d < bestY.d)) bestY = { d, v }; };
  offerX(margin); offerX(vw - rect.w - margin); offerY(margin); offerY(vh - rect.h - margin);
  others.forEach((r) => {
    const yOverlap = rect.y < r.bottom + tol && rect.y + rect.h > r.top - tol;
    const xOverlap = rect.x < r.right + tol && rect.x + rect.w > r.left - tol;
    if (yOverlap) { offerX(r.right); offerX(r.left - rect.w); offerX(r.left); offerX(r.right - rect.w); }
    if (xOverlap) { offerY(r.bottom); offerY(r.top - rect.h); offerY(r.top); offerY(r.bottom - rect.h); }
  });
  return { x: bestX ? bestX.v : rect.x, y: bestY ? bestY.v : rect.y, hit: !!(bestX || bestY) };
}
