// Lets the buttons in a row be rearranged by dragging, like app icons on a phone:
// press and hold a button (or just drag it with a mouse), slide it along the row, the others make room, let go.
// The order is remembered on this device. A drag never counts as a click.
//
//   makeReorderable(strip, { key: 'spac3.sketchBarOrder' })
//
// Only direct children that are <button>s with an id take part. Buttons that are currently hidden (display:none) keep
// their place in the saved order, so a button that only shows in full screen is not lost when the order changes.

const HOLD_MS = 320;      // finger must rest this long before the button lifts (so scrolling the row still works)
const HOLD_SLOP = 9;      // px a finger may wander while holding before we treat it as a scroll
const MOUSE_SLOP = 6;     // px a mouse must move before a press becomes a drag

export function makeReorderable(strip, { key } = {}) {
  const items = () => [...strip.children].filter((el) => el.tagName === 'BUTTON' && el.id);
  const shown = () => items().filter((el) => el.offsetParent !== null || getComputedStyle(el).display !== 'none');

  // ---- remembered order -------------------------------------------------------------------------------------------
  const load = () => { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null; } catch { return null; } };
  const save = () => { try { localStorage.setItem(key, JSON.stringify(items().map((el) => el.id))); } catch { /* private mode: order just won't be remembered */ } };
  function applySaved() {
    const saved = load(); if (!saved || !saved.length) return;
    const rank = new Map(saved.map((id, i) => [id, i]));
    const cur = items(); const known = cur.filter((el) => rank.has(el.id)).sort((x, y) => rank.get(x.id) - rank.get(y.id));
    // a button the saved order has never seen (added in a later version) keeps its own slot
    let k = 0; cur.map((el) => (rank.has(el.id) ? known[k++] : el)).forEach((el) => strip.append(el));
  }

  // ---- dragging ---------------------------------------------------------------------------------------------------
  let drag = null; let suppressClick = false;

  function flip(before) { // slide the other buttons from where they were to where they are now
    for (const el of shown()) {
      if (el === drag?.el) continue; const a = before.get(el); if (!a) continue; const b = el.getBoundingClientRect();
      const dx = a.left - b.left; const dy = a.top - b.top; if (!dx && !dy) continue;
      el.style.transition = 'none'; el.style.transform = `translate(${dx}px,${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = 'transform .16s ease'; el.style.transform = ''; });
    }
  }
  const snapshot = () => new Map(shown().map((el) => [el, el.getBoundingClientRect()]));

  function place() { // keep the lifted button under the finger, whatever the layout does around it
    const { el, x, y } = drag; el.style.transition = 'none'; el.style.transform = 'none';
    const r = el.getBoundingClientRect(); const dx = x - (r.left + r.width / 2); const dy = y - (r.top + r.height / 2);
    el.style.transform = `translate(${dx}px,${dy}px) scale(1.16)`;
  }

  function target() { // the visible button nearest the finger, and whether to go before or after it
    const { el, x, y } = drag; let best = null; let bd = Infinity;
    for (const o of shown()) { if (o === el) continue; const r = o.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
      const d = Math.hypot(cx - x, (cy - y) * 2); if (d < bd) { bd = d; best = { o, after: x > cx && Math.abs(cy - y) < r.height } ; } }
    return best;
  }

  function reorder() {
    const t = target(); if (!t) return;
    const els = shown(); const from = els.indexOf(drag.el); const to = els.indexOf(t.o);
    const wantAfter = t.after; const already = wantAfter ? from === to + 1 : from === to - 1;
    if (already) return;
    const before = snapshot(); drag.el.style.transform = 'none';
    if (wantAfter) t.o.after(drag.el); else t.o.before(drag.el);
    flip(before); place(); drag.moved = true;
  }

  let raf = 0;
  function autoScroll() {
    cancelAnimationFrame(raf); if (!drag) return;
    const r = strip.getBoundingClientRect(); const scrolls = strip.scrollWidth > strip.clientWidth + 2;
    if (scrolls) { const edge = 30; if (drag.x < r.left + edge) strip.scrollLeft -= 7; else if (drag.x > r.right - edge) strip.scrollLeft += 7; place(); reorder(); }
    raf = requestAnimationFrame(autoScroll);
  }

  function lift(e) {
    drag.lifted = true; drag.el.classList.add('is-lifted'); strip.classList.add('is-reordering');
    try { drag.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    try { navigator.vibrate && navigator.vibrate(12); } catch { /* ignore */ }
    drag.startOrder = items().map((b) => b.id).join();
    place(); autoScroll();
  }

  function end(commit) {
    if (!drag) return; clearTimeout(drag.timer); cancelAnimationFrame(raf);
    const d = drag; drag = null;
    document.removeEventListener('touchmove', stopScroll, true);
    if (d.lifted) {
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 350); // the click that follows letting go must not press the button
      d.el.style.transition = 'transform .16s ease'; d.el.style.transform = ''; // settle into its slot
      setTimeout(() => { d.el.style.transition = ''; d.el.classList.remove('is-lifted'); strip.classList.remove('is-reordering'); }, 170);
      if (commit && d.startOrder !== items().map((b) => b.id).join()) { save(); strip.dispatchEvent(new CustomEvent('reordered', { bubbles: true })); }
      else if (!commit) { /* cancelled: leave as is */ }
    }
  }
  const stopScroll = (e) => { if (e.cancelable) e.preventDefault(); }; // once lifted, moving a finger must not scroll the page or the row

  // Listen on the row's parent and find the button by position: a disabled button (Undo with nothing to undo) receives no
  // events of its own, yet it should still be movable.
  const host = strip.parentElement || strip;
  const hit = (x, y) => items().find((el) => { const r = el.getBoundingClientRect(); return r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
  host.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || drag) return; const el = hit(e.clientX, e.clientY); if (!el) return;
    drag = { el, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', lifted: false, moved: false };
    if (drag.touch) { drag.timer = setTimeout(() => { if (drag && !drag.lifted) { document.addEventListener('touchmove', stopScroll, { capture: true, passive: false }); lift(e); } }, HOLD_MS); }
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.lifted) {
      const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
      if (drag.touch) { if (moved > HOLD_SLOP) { clearTimeout(drag.timer); drag = null; } return; } // a scroll, not a hold
      if (moved > MOUSE_SLOP) lift(e); else return;
    }
    e.preventDefault(); place(); reorder();
  }, { passive: false });
  window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) end(true); });
  window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) end(true); });
  window.addEventListener('blur', () => end(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag?.lifted) end(false); });

  host.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  host.addEventListener('contextmenu', (e) => { if (drag?.touch) e.preventDefault(); }); // long-press must not open the phone's menu

  applySaved();
  return { applySaved, save, reset() { try { localStorage.removeItem(key); } catch { /* ignore */ } } };
}
