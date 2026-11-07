// The Sketchpad's bottom bar, made to measure. In the ⋯ More sheet the "Bottom bar" tab lists every button the Sketchpad has; each can be switched
// onto the bar or off it. The bar always stays on ONE line: only as many buttons are allowed as fit the width (capacity() below), so it never scrolls
// sideways once it is customised. The chosen buttons can still be dragged into any order (barReorder.js), and the order is remembered.
//
// Until someone customises, nothing here changes: the bar keeps its usual layout (which differs between the window and full screen).
// The first switch freezes what is on the bar right now as the starting choice, then adds or removes from it.
//
//   const custom = createBarCustom({ core, bar, strip, barBtns, barButton, h, syncs, toast, acts });   // before makeReorderable
//   custom.attach(reorder);                                                                             // after it
//   custom.panel                                                                                        // the tab's content
import { clamp } from './sketchUtil.js';

const KEY = 'spac3.sketchBarItems';
const STICKER_KEY = 'spac3.sketchBarSticker';
export const MIN_BTN = 32; // narrowest a button is allowed to get (px)
const GAP = 4;             // space between buttons in the strip (px)
const HARD_MAX = 16;       // however wide the screen is
const FIXED = ['sketchMoreBtn', 'sketchFullBtn', 'sketchLock']; // always on the bar: without ⋯ there would be no way back to this tab, and without ⛶ no way out of full screen
const SYM_ORDER = ['off', 'v', 'h', 'quad', 'radial'];
const SYM_ICON = { off: '🦋', v: '│', h: '─', quad: '✚', radial: '✳' };
const SYM_NAME = { off: 'off', v: 'vertical', h: 'horizontal', quad: 'quad', radial: 'radial' };

// every button that can be put on the bar: [id, icon, name, group]. The id is the bar button's own id.
export const CATALOG = [
  ['sketchQuick_brush', '✏️', 'Brush', 'Tools'], ['sketchQuick_smudge', '👆', 'Smudge', 'Tools'], ['sketchQuick_eraser', '🧽', 'Eraser', 'Tools'],
  ['sketchQuick_fill', '🪣', 'Fill', 'Tools'], ['sketchQuick_eyedrop', '🎯', 'Pick colour', 'Tools'], ['sketchQuick_select', '⬚', 'Select', 'Tools'], ['sketchStickerBtn', '✂️', 'Make a sticker', 'Tools'],
  ['sketchQuick_shape', '◻️', 'Shapes', 'Tools'], ['sketchQuick_transform', '⤢', 'Transform', 'Tools'], ['sketchQuick_hand', '✋', 'Move view (hand)', 'Tools'],
  ['sketchColorBtn', '🎨', 'Colour', 'Colour and brush'], ['sketchSizeBtn', '◉', 'Brush size and opacity', 'Colour and brush'],
  ['sketchUndo', '↩', 'Undo', 'Edit'], ['sketchRedo', '↪', 'Redo', 'Edit'],
  ['sketchSymBtn', '🦋', 'Symmetry (tap to change)', 'Guides and view'], ['sketchGridBtn', '▦', 'Grid', 'Guides and view'], ['sketchLayersBtn', '▤', 'Layers', 'Guides and view'],
  ['sketchQuickFit', '⌖', 'Fit the page in view', 'Guides and view'], ['sketchZoomInBtn', '＋', 'Zoom in', 'Guides and view'], ['sketchZoomOutBtn', '－', 'Zoom out', 'Guides and view'],
  ['sketchRotLBtn', '↺', 'Rotate left', 'Guides and view'], ['sketchRotRBtn', '↻', 'Rotate right', 'Guides and view'], ['sketchSaveBtn', '💾', 'Save sketch', 'Drawings'], ['sketchNewBtn', '🆕', 'New drawing', 'Drawings'], ['sketchGalleryBtn', '🗂', 'My sketches', 'Drawings'], ['sketchPhotoBtn', '📷', 'Insert photo', 'Drawings'],
];
const IDS = new Set(CATALOG.map((c) => c[0]));

export function createBarCustom({ core, bar, strip, barBtns, barButton, h, syncs, toast, acts }) {
  let toastAt = 0; const say = (m) => { const t = Date.now(); if (t - toastAt > 1500) { toastAt = t; toast(m); } }; // one message, not one per tap
  const sendBtn = barBtns.sketchSend;
  let chosen = null; // null = the usual layout; otherwise the ids on the bar
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (Array.isArray(v)) chosen = v.filter((x) => typeof x === 'string' && IDS.has(x)); } catch { /* none */ }
  // The ✂️ sticker button takes the place of Pick colour (🎯) on a bar that was already customised, once (Pick colour stays in the Tools menu and the ⋯ Bottom bar tab).
  let swapped = false;
  try {
    if (localStorage.getItem(STICKER_KEY) !== '1') {
      const i = chosen ? chosen.indexOf('sketchQuick_eyedrop') : -1;
      if (i >= 0 && !chosen.includes('sketchStickerBtn')) { chosen[i] = 'sketchStickerBtn'; swapped = true; }
      localStorage.setItem(STICKER_KEY, '1');
    }
  } catch { /* private mode: nothing to swap */ }
  let reorder = null; let lastCap = 6;
  const save = () => { try { if (chosen) localStorage.setItem(KEY, JSON.stringify(chosen)); else localStorage.removeItem(KEY); } catch { /* private mode: it just won't be remembered */ } };

  // ---- the buttons that only exist for this: they sit in the strip, hidden unless chosen ----------------------------------------------------
  const extra = (id, icon, label, onClick) => barButton(id, icon, label, onClick).classList.add('sk-opt');
  const symBtn = barButton('sketchSymBtn', SYM_ICON.off, 'Symmetry: off. Tap to change it.', () => { const i = SYM_ORDER.indexOf(core.symmetry); core.setSetting('symmetry', SYM_ORDER[(i + 1) % SYM_ORDER.length]); syncs.forEach((f) => f()); });
  symBtn.classList.add('sk-opt');
  syncs.push(() => { const s = core.symmetry || 'off'; symBtn.firstChild.textContent = SYM_ICON[s] || SYM_ICON.off; symBtn.title = `Symmetry: ${SYM_NAME[s] || s}. Tap to change it.`; symBtn.setAttribute('aria-label', symBtn.title); symBtn.classList.toggle('is-active', s !== 'off'); });
  const gridBtn = barButton('sketchGridBtn', '▦', 'Grid on or off', () => { core.grid = { ...core.grid, on: !core.grid.on }; core.invalidate(); core.savePrefsSoon(); syncs.forEach((f) => f()); });
  gridBtn.classList.add('sk-opt');
  syncs.push(() => { gridBtn.classList.toggle('is-active', !!core.grid.on); gridBtn.setAttribute('aria-pressed', String(!!core.grid.on)); });
  extra('sketchZoomInBtn', '＋', 'Zoom in', () => acts.zoomBy(1.5));
  extra('sketchZoomOutBtn', '－', 'Zoom out', () => acts.zoomBy(1 / 1.5));
  extra('sketchRotLBtn', '↺', 'Rotate the page left', () => acts.rotateBy(-15));
  extra('sketchRotRBtn', '↻', 'Rotate the page right', () => acts.rotateBy(15));
  extra('sketchSaveBtn', '💾', 'Save this drawing', () => acts.save());
  extra('sketchNewBtn', '🆕', 'Save this drawing and start a new one', () => acts.newDrawing());
  extra('sketchGalleryBtn', '🗂', 'My sketches', () => acts.gallery());
  extra('sketchPhotoBtn', '📷', 'Insert a photo', () => acts.photo());

  // ---- how many fit on one line ----------------------------------------------------------------------------------------------------------------
  function capacity() { // the number of chosen buttons the bar can hold in one line right now (More and Full screen are not counted)
    const cs = getComputedStyle(bar); const W = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (W < 120) return lastCap; // the window is closed: keep the last answer
    const room = W - (sendBtn.offsetWidth || 48) - 6;
    const slots = Math.floor((room + GAP) / (MIN_BTN + GAP));
    lastCap = clamp(slots - FIXED.length, 1, HARD_MAX);
    return lastCap;
  }
  const isShown = (el) => !!el && getComputedStyle(el).display !== 'none';
  function seed() { // what is on the bar now, as the starting choice
    const out = [];
    for (const el of [...strip.children]) {
      if (!isShown(el)) continue; let id = el.id; if (id === 'sketchHandBtn') id = 'sketchQuick_hand'; if (id === 'sketchToolsBtn') id = 'sketchQuick_brush'; // the pencil that opens the tools menu is now the Brush button (tap it again for the brush library)
      if (IDS.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  }

  // ---- put the choice on the bar ---------------------------------------------------------------------------------------------------------------
  let panelRefresh = () => {};
  function apply() {
    const on = chosen !== null;
    bar.classList.toggle('is-custom', on); // Full screen and Lock never leave their place beside Send; Lock is simply shown or hidden
    if (!on) { [...strip.children].forEach((el) => el.classList.remove('sk-off')); panelRefresh(); return; }
    const cap = capacity(); let n = 0;
    for (const el of [...strip.children]) {
      if (FIXED.includes(el.id)) { el.classList.remove('sk-off'); continue; }
      const want = chosen.includes(el.id) && n < cap; // a screen too narrow for the whole choice shows the first ones that fit; nothing is forgotten
      el.classList.toggle('sk-off', !want); if (want) n++;
    }
    panelRefresh();
  }
  // when the usual bar has more buttons than one line holds, the ones people reach for most are kept
const KEEP_FIRST = ['sketchQuick_brush', 'sketchColorBtn', 'sketchUndo', 'sketchRedo', 'sketchQuick_eraser', 'sketchQuick_fill', 'sketchSizeBtn', 'sketchQuick_hand', 'sketchQuickFit'];
function seedFit() {
  const all = seed(); const cap = capacityIfCustom(); if (all.length <= cap) return all;
  const rank = (id) => { const i = KEEP_FIRST.indexOf(id); return i < 0 ? 99 : i; };
  const keep = new Set([...all].sort((x, y) => rank(x) - rank(y)).slice(0, cap));
  return all.filter((id) => keep.has(id));
}
const currentSet = () => (chosen !== null ? chosen : seedFit()); // before customising: the usual bar, as far as one line holds it
  function setOn(id, want) {
    if (chosen === null) chosen = currentSet().slice();
    if (want) {
      if (chosen.includes(id)) return true;
      const cap = capacityIfCustom();
      if (chosen.length >= cap) { say(`The bar is full: ${cap} buttons fit in one line on this screen. Turn one off first.`); return false; }
      chosen.push(id);
      const el = document.getElementById(id); if (el && strip.contains(el)) { strip.insertBefore(el, barBtns.sketchMoreBtn); reorder?.save(); } // new buttons join just before ⋯
    } else chosen = chosen.filter((x) => x !== id);
    save(); apply(); return true;
  }
  function capacityIfCustom() { const was = bar.classList.contains('is-custom'); bar.classList.add('is-custom'); const c = capacity(); if (!was) bar.classList.remove('is-custom'); return c; }
  function reset() { chosen = null; save(); apply(); }

  // ---- the tab -----------------------------------------------------------------------------------------------------------------------------------
  const info = h('p', { class: 'sk-hint', id: 'sketchBarInfo' });
  const rows = new Map();
  const groups = []; let lastGroup = '';
  for (const [id, icon, name, group] of CATALOG) {
    if (group !== lastGroup) { groups.push(h('div', { class: 'sk-sub' }, group)); lastGroup = group; }
    const b = h('button', { type: 'button', class: 'sk-toggle sk-barrow', id: `sketchBarRow_${id}`, dataset: { item: id }, onClick: () => { setOn(id, !currentSet().includes(id)); } },
      h('span', { class: 'sk-box' }), h('span', { class: 'sk-rowico', 'aria-hidden': 'true' }, icon), h('span', {}, name));
    rows.set(id, b); groups.push(b);
  }
  const resetBtn = h('button', { type: 'button', class: 'sk-act', id: 'sketchBarReset', onClick: () => reset() }, 'Back to the usual bar');
  const panel = h('div', { class: 'sk-bartab', id: 'sketchBarTab' }, info, h('div', { class: 'sk-actions' }, resetBtn), ...groups,
    h('p', { class: 'sk-hint' }, 'To move a button: press and hold it on the bar (or drag it with a mouse) and slide it where you want it. ⋯ and Full screen are always on the bar.'));
  panelRefresh = () => {
    const set = currentSet(); const cap = capacityIfCustom();
    for (const [id, b] of rows) { const on = set.includes(id); b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); }
    info.textContent = chosen === null ? `This is the usual bar. Switch any button on or off to make it your own: up to ${cap} fit in one line on this screen${seed().length > cap ? `, so the ones you use most are ticked` : ''}.`
      : `${Math.min(chosen.length, cap)} of ${cap} buttons used. That is all that fits in one line on this screen.${chosen.length > cap ? ` (${chosen.length - cap} more are chosen but wait for a wider screen.)` : ''}`;
    resetBtn.hidden = chosen === null;
  };

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => apply()).observe(bar);
  core.on('full', () => setTimeout(apply, 0));
  window.addEventListener('resize', apply);
  apply();
  return { panel, apply, refresh: () => panelRefresh(), reset, get chosen() { return chosen; }, capacity: capacityIfCustom,
    attach(r) { // after the saved order is applied: a swapped-in sticker button sits exactly where Pick colour was
      reorder = r;
      if (swapped) { save(); const st = barBtns.sketchStickerBtn; const old = strip.querySelector('#sketchQuick_eyedrop'); if (st && old) { strip.insertBefore(st, old); r.save(); } }
    } };
}
