// SKETCHPAD interface: a slim icon bar under the page, popup sheets for
// tools / colour / size / layers / more, a floating bar for selections and
// transforms, and a fullscreen mode. Built to be used with thumbs on a small
// screen: big tap targets, one sheet open at a time, the page stays visible.
import { BRUSHES, brushById, stampTip } from './sketchBrushes.js';
import { clamp, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from './sketchUtil.js';
import { BLENDS, MAX_LAYERS, PAPER_W, PAPER_H } from './sketchCore.js';
import { showToast } from './toast.js';
import { makeFloatable } from './floatBox.js';
import { addOutbox, listOutbox } from './sketchStore.js';
import { avatarBackground, avatarGlyph } from './utils.js';
import { makeReorderable } from './barReorder.js';
import { createBarCustom } from './sketchBarCustom.js';
import { openDialog } from './dialog.js';
import { DRAW_PAGE_URL } from './sketchConst.js';
import { cutSticker } from './stickerCut.js';
import { STICKER_NAME_MAX } from './stickersCore.js';

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach((c) => { if (c == null || c === false) return; e.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return e;
};

const TOOLS = [
  ['brush', '✏️', 'Brush'], ['smudge', '👆', 'Smudge'], ['eraser', '🧽', 'Eraser'],
  ['fill', '🪣', 'Fill'], ['eyedrop', '🎯', 'Pick colour'], ['select', '⬚', 'Select'],
  ['shape', '◻️', 'Shapes'], ['transform', '⤢', 'Transform'], ['hand', '✋', 'Move view'],
];
const BASE_COLORS = ['#111827', '#6b7280', '#ffffff', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#92400e'];
const PAPERS = [['#ffffff', 'White'], ['#fdf6e3', 'Cream'], ['#d1d5db', 'Grey'], ['#111827', 'Dark'], ['transparent', 'Clear']];
const SYMS = [['off', 'Off'], ['v', '│ Vertical'], ['h', '─ Horizontal'], ['quad', '✚ Quad'], ['radial', '✳ Radial']];

export function mountSketchUI(core, { onSend, getRoom, getFriends, onSendFriend } = {}) {
  const panel = document.getElementById('sketchPanel');
  const wrap = core.wrap;
  const bar = document.getElementById('sketchBar');
  const syncs = []; // functions that refresh controls from core state
  const sync = () => syncs.forEach((fn) => fn());

  // ------------------------------------------------------------ helpers
  function slider({ label, min, max, step = 1, get, set, fmt = (v) => v, id, toSlider = (v) => v, fromSlider = (v) => v }) {
    const input = h('input', { type: 'range', min, max, step, id, 'aria-label': label });
    const val = h('span', { class: 'sk-val' });
    const row = h('label', { class: 'sk-slider' }, h('span', { class: 'sk-label' }, label), input, val);
    input.addEventListener('input', () => { const v = fromSlider(Number(input.value)); set(v); val.textContent = fmt(v); });
    const refresh = () => { const v = get(); input.value = toSlider(v); val.textContent = fmt(v); };
    syncs.push(refresh);
    refresh();
    return row;
  }
  function chips(items, get, set, cls = '') {
    const wrapEl = h('div', { class: `sk-chips ${cls}` });
    const btns = items.map(([val, text, title]) => {
      const b = h('button', { type: 'button', class: 'sk-chip', title: title || text, onClick: () => { set(val); sync(); } }, text);
      wrapEl.append(b);
      return [val, b];
    });
    syncs.push(() => btns.forEach(([val, b]) => { const on = get() === val; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); }));
    return wrapEl;
  }
  function toggle(label, get, set, id) {
    const b = h('button', { type: 'button', class: 'sk-toggle', id, onClick: () => { set(!get()); sync(); } }, h('span', { class: 'sk-box' }), label);
    syncs.push(() => { const on = !!get(); b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
    return b;
  }
  const btn = (text, onClick, props = {}) => h('button', { type: 'button', class: 'sk-act', onClick, ...props }, text);

  // -------------------------------------------------------------- sheets
  const sheets = {};
  const floats = {};
  const openHooks = {}; // name -> function run each time that sheet opens
  let openName = null;
  let openAnchor = null;
  const sheetHost = h('div', { class: 'sketch-sheets' });
  document.body.append(sheetHost);
  function makeSheet(name, title, body, { closable = true } = {}) {
    const close = closable ? h('button', { type: 'button', class: 'sk-x', 'aria-label': `Close ${title}`, onClick: () => closeSheet() }, '✕') : null;
    const s = h('div', { class: 'sketch-sheet', dataset: { sheet: name }, hidden: true, role: 'dialog', 'aria-label': title },
      h('div', { class: 'sk-sheet-head', title: 'Drag here to move this panel (double-tap to put it back)' }, h('strong', {}, title), close), h('div', { class: 'sk-sheet-body' }, body));
    sheetHost.append(s);
    sheets[name] = s;
    floats[name] = makeFloatable(s, { head: s.querySelector('.sk-sheet-head'), key: `sketch.${name}`, minW: 220, minH: 130, place: () => placeAnchored(s) });
    new ResizeObserver(() => { if (openName === name) positionSheet(); }).observe(s);
    return s;
  }
  // Default spot: next to the button that opened it. Drag the title bar to
  // move a panel and the corner grip to resize it (floatBox.js); where you
  // leave it is remembered, and a double-tap on the title bar puts it back.
  function placeAnchored(s) {
    if (!openAnchor) return;
    const r = openAnchor.getBoundingClientRect();
    const vw = window.innerWidth; const vh = window.innerHeight;
    const w = s.offsetWidth;
    const hh = s.offsetHeight;
    const left = clamp(r.left + r.width / 2 - w / 2, 8, Math.max(8, vw - w - 8));
    let top = r.top - hh - 8;
    if (top < 8) top = r.bottom + 8;
    if (top + hh > vh - 8) top = Math.max(8, vh - hh - 8);
    s.style.left = `${left}px`;
    s.style.top = `${top}px`;
  }
  function positionSheet() {
    if (openName && sheets[openName]) floats[openName].apply();
  }
  function openSheet(name, anchor) {
    if (openName === name) { closeSheet(); return; }
    closeSheet();
    openName = name; openAnchor = anchor;
    const s = sheets[name];
    s.hidden = false;
    sync();
    openHooks[name]?.();
    positionSheet();
    anchor?.classList.add('is-open');
    anchor?.setAttribute('aria-expanded', 'true');
    core.emit('sheet', name);
  }
  function closeSheet() {
    if (!openName) return;
    if (openName === 'adjust' && core.adj) core.cancelAdjust();
    sheets[openName].hidden = true;
    openAnchor?.classList.remove('is-open');
    openAnchor?.setAttribute('aria-expanded', 'false');
    openName = null; openAnchor = null;
    core.emit('sheet', null);
  }
  core.openSheet = openSheet; core.closeSheet = closeSheet;
  window.addEventListener('scroll', positionSheet, { passive: true });
  window.addEventListener('resize', positionSheet);
  // tapping the page closes a sheet that sits over it, but the tap still draws
  document.addEventListener('pointerdown', (e) => {
    if (!openName || openName === 'adjust') return;
    if (e.target.closest('.sketch-sheet, #sketchBar, .sketch-context, .sketch-sidebars')) return;
    closeSheet();
  }, true);

  // ================================================================= BAR
  const barBtns = {};
  const strip = h('div', { class: 'sk-strip' }); bar.append(strip); // the tool buttons live in here (it scrolls sideways on a phone in full screen); Send to chat sits beside it
  function barButton(id, icon, label, onClick, { sheet } = {}) {
    const b = h('button', { type: 'button', class: 'sk-btn', id, title: label, 'aria-label': label }, h('span', { class: 'sk-ico' }, icon));
    if (sheet) b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => onClick(b));
    (id === 'sketchSend' || id === 'sketchLock' || id === 'sketchFullBtn' ? bar : strip).append(b); // Full screen, Lock and Send stay put at the right, beside the (scrolling) tool strip
    barBtns[id] = b;
    return b;
  }
  const toolBtn = barButton('sketchToolsBtn', '✏️', 'Tools and brushes', (b) => openSheet('tools', b), { sheet: true });
  // full-screen only: every tool one tap away (Procreate-style), the hand included. Tapping Brush again opens the brush library.
  const quickBtns = TOOLS.map(([id, icon, name]) => {
    const b = barButton(`sketchQuick_${id}`, icon, name, (btn) => { if (id === 'brush' && core.tool === 'brush') openSheet('tools', btn); else { core.setTool(id); sync(); } });
    b.classList.add('sk-quick');
    return [id, b];
  });
  barButton('sketchQuickFit', '⌖', 'Fit the whole page in view', () => core.resetView()).classList.add('sk-quick');
  syncs.push(() => quickBtns.forEach(([id, b]) => { const on = core.tool === id; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); }));
  const colorBtn = barButton('sketchColorBtn', '', 'Colour', (b) => openSheet('color', b), { sheet: true });
  colorBtn.firstChild.classList.add('sk-dot');
  barButton('sketchSizeBtn', '◉', 'Brush size and opacity', (b) => openSheet('size', b), { sheet: true });
  // the hand (move / zoom the view) takes the Layers button's place; Layers now lives in the ⋯ More sheet. In full screen the hand is in the tool row, so this one hides.
  const handBtn = barButton('sketchHandBtn', '✋', 'Hand: move and zoom the view', () => { core.setTool(core.tool === 'hand' ? (core.prevTool || 'brush') : 'hand'); sync(); });
  handBtn.classList.add('sk-nonfull');
  syncs.push(() => { const on = core.tool === 'hand'; handBtn.classList.toggle('is-active', on); handBtn.setAttribute('aria-pressed', String(on)); });
  // ✂️ Sticker: with a piece selected it cuts the sticker; with nothing selected it switches to Select so you can choose the piece (tap it again when you have).
  const stickerBtn = barButton('sketchStickerBtn', '✂️', 'Make a sticker: select a piece of your drawing, then tap this to cut it out', () => {
    if (core.selection) { makeSticker(); return; }
    core.setTool('select'); sync();
    showToast('Select the part you want to cut out (Box, Oval or Freehand), then tap ✂️ again.', { duration: 3200 });
  });
  syncs.push(() => { const on = core.tool === 'select'; stickerBtn.classList.toggle('is-active', on); stickerBtn.setAttribute('aria-pressed', String(on)); });
  barButton('sketchLayersBtn', '▤', 'Layers', (b) => openSheet('layers', b), { sheet: true }).classList.add('sk-gone');
  const undoBtn = barButton('sketchUndo', '↩', 'Undo (or tap with two fingers)', () => core.undo());
  const redoBtn = barButton('sketchRedo', '↪', 'Redo (or tap with three fingers)', () => core.redo());
  const lockBtn = barButton('sketchLock', '🔓', 'Lock the drawing area so touching or scrolling over it doesn\'t draw', () => core.setLocked(!core.locked));
  barButton('sketchMoreBtn', '⋯', 'More: view, guides, adjustments, save', (b) => openSheet('more', b), { sheet: true });
  const fullBtn = barButton('sketchFullBtn', '⛶', 'Full screen', () => toggleFull());
  bar.insertBefore(fullBtn, lockBtn); // always directly beside the lock, on its left: ... ⋯  ⛶ 🔓 Send
  barButton('sketchSend', '💬', 'Send this drawing to the room chat', async (b) => {
    if (!onSend && !getRoom) return;
    if (core.isEmpty()) { showToast('Draw something first.'); return; }
    b.disabled = true;
    try {
      const blob = await core.exportShareBlob();
      if (!blob) throw new Error("Couldn't make the picture.");
      // Pop up a preview with a box for a message to go along with the picture.
      const room = getRoom ? getRoom() : null;
      const answer = await askSendNote(blob, room && room.name);
      if (!answer) return; // cancelled
      const note = answer.message;
      // "Send to friend": a direct message to the friend picked in the pop-up (needs a connection; it is not queued for later)
      if (answer.friend) {
        if (!navigator.onLine) { showToast('You need a connection to send a drawing to a friend.', { error: true }); return; }
        await onSendFriend(blob, { message: note, friend: answer.friend });
        return;
      }
      // No connection (or one too poor to upload): keep the picture and send it
      // later, the next time you are online in that room.
      if (!onSend || !navigator.onLine) { await queueForLater(blob, note); return; }
      try { await onSend(blob, { message: note }); } catch (err) {
        if (/failed to fetch|network|load failed|timed out|offline/i.test(String(err?.message || err))) { await queueForLater(blob, note); return; }
        throw err;
      }
    } catch (err) { showToast(err?.message || "Couldn't send that.", { error: true }); } finally { b.disabled = false; }
  }).classList.add('sk-send');
  { const sb = barBtns.sketchSend; if (sb) { sb.append(h('span', { class: 'sk-send-lbl' }, 'SEND TO ', h('span', { class: 'sk-spac3' }, 'SPAC3 '), 'CHAT')); } }
  // The tool buttons can be dragged into any order (press and hold on a phone), and the order is remembered. Lock and Send stay put.
  // The ⋯ More sheet has a "Bottom bar" tab to choose which buttons are on the bar at all (sketchBarCustom.js); they keep this drag-to-move.
  const barCustom = createBarCustom({ core, bar, strip, barBtns, barButton, h, syncs, toast: showToast, acts: {
    zoomBy: (f) => zoomBy(f), rotateBy: (d) => rotateBy(d), save: () => quickSave(), newDrawing: () => startNew(), gallery: () => openGallery(), photo: () => fileInput.click(),
  } });
  const barOrder = makeReorderable(strip, { key: 'spac3.sketchBarOrder' });
  barCustom.attach(barOrder);
  strip.addEventListener('reordered', () => { if (openName) positionSheet(); });
  // The "send to chat" pop-up: the picture, a message box, Send / Cancel.
  // Resolves { message } on Send (message may be ''), or null when cancelled.
  const NOTE_MAX = 300; // chat lines are capped at 500 characters, and the picture's link takes ~130
  // A small pop-up over the send page: tap a friend to send the drawing to them as a direct message.
  function pickFriend() {
    return new Promise((resolve) => {
      let list = [];
      try { list = getFriends() || []; } catch { list = []; }
      const rows = list.length
        ? list.map((f) => {
          const b = h('button', { type: 'button', class: 'sk-friend', dataset: { id: f.id } },
            h('span', { class: 'av', style: `--s:30px;${avatarBackground(f)}` }, avatarGlyph(f)),
            h('span', { class: 'sk-friend-name' }, f.username || 'someone'),
            h('span', { class: `sk-friend-dot${f.online ? ' on' : ''}`, title: f.online ? 'Online now' : 'Offline' }));
          b.addEventListener('click', () => finish(f));
          return b;
        })
        : [h('p', { class: 'sk-hint' }, "You haven't added any friends yet. Add friends from the Chat box's Friends tab.")];
      const cancel = h('button', { type: 'button', class: 'secondary' }, 'Back');
      const box = h('div', { class: 'modal dialog-modal sk-friend-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a friend' },
        h('h2', {}, 'Send to which friend?'),
        h('div', { class: 'sk-friend-list' }, rows),
        h('div', { class: 'actions' }, cancel));
      const d = openDialog(box, { backdropClass: 'sk-friend-backdrop', focus: false });
      const finish = d.close;
      cancel.addEventListener('click', () => finish(null));
      d.closed.then(resolve);
    });
  }
  function askSendNote(blob, roomName) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = h('img', { class: 'sk-send-img', src: url, alt: 'Your drawing' });
      const note = h('textarea', { id: 'sketchSendNote', class: 'sk-send-note', rows: '2', maxlength: String(NOTE_MAX), placeholder: 'Add a message to go with it (optional)' });
      const count = h('span', { class: 'sk-send-count' }, `0/${NOTE_MAX}`);
      const send = h('button', { type: 'button', id: 'sketchSendGo', class: 'sk-send-go' }, 'Send to chat');
      const cancel = h('button', { type: 'button', id: 'sketchSendCancel', class: 'secondary' }, 'Cancel');
      const canFriend = !!(getFriends && onSendFriend);
      const sendFriend = canFriend ? h('button', { type: 'button', id: 'sketchSendFriend', class: 'secondary sk-send-friend' }, 'Send to friend') : null;
      const box = h('div', { class: 'modal dialog-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Send your drawing to the chat' },
        h('h2', {}, 'Send your drawing to the chat'),
        roomName ? h('p', { class: 'sk-hint' }, `It will appear in ${roomName}'s chat.`) : null,
        h('div', { class: 'sk-send-prev' }, img),
        note, count,
        h('div', { class: 'actions sk-send-actions' }, cancel, send, sendFriend));
      const d = openDialog(box, {
        focus: () => note,
        onKey: (e, close) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); close({ message: note.value.trim() }); } },
      });
      const finish = d.close;
      d.closed.then((val) => { URL.revokeObjectURL(url); resolve(val); });
      note.addEventListener('input', () => { count.textContent = `${note.value.length}/${NOTE_MAX}`; });
      send.addEventListener('click', () => finish({ message: note.value.trim() }));
      cancel.addEventListener('click', () => finish(null));
      sendFriend?.addEventListener('click', async () => {
        const friend = await pickFriend();
        if (friend) finish({ message: note.value.trim(), friend });
      });
    });
  }
  // "Sticker" on the selection bar: cut the selected piece out as a see-through picture, name it, and keep it on My stickers.
  // The page that hosts the Sketchpad says how a sticker is kept (core.stickerSaver); without one the button explains.
  function askStickerName(cut) {
    return new Promise((resolve) => {
      const img = h('img', { class: 'sk-sticker-img', src: cut.url, alt: 'Your sticker' });
      const name = h('input', { type: 'text', id: 'sketchStickerName', class: 'sk-sticker-name', maxlength: String(STICKER_NAME_MAX), placeholder: 'Name it (optional)', value: '' });
      const save = h('button', { type: 'button', id: 'sketchStickerSave', class: 'sk-send-go' }, 'Save sticker');
      const cancel = h('button', { type: 'button', id: 'sketchStickerCancel', class: 'secondary' }, 'Cancel');
      const box = h('div', { class: 'modal dialog-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Make a sticker' },
        h('h2', {}, 'Make a sticker'),
        h('div', { class: 'sk-sticker-prev' }, img),
        h('p', { class: 'sk-hint' }, `${cut.width} x ${cut.height} px, see-through around your drawing.`),
        name,
        h('div', { class: 'actions sk-send-actions' }, cancel, save));
      const d = openDialog(box, { focus: () => name, onKey: (e, close) => { if (e.key === 'Enter') { e.preventDefault(); close({ name: name.value.trim() }); } } });
      d.closed.then(resolve);
      save.addEventListener('click', () => d.close({ name: name.value.trim() }));
      cancel.addEventListener('click', () => d.close(null));
    });
  }
  async function makeSticker() {
    const cut = await cutSticker(core);
    if (cut.error) { showToast(cut.error, { error: true }); return; }
    const out = await askStickerName(cut); URL.revokeObjectURL(cut.url);
    if (!out) return;
    if (!core.stickerSaver) { showToast('Stickers can be kept from the Stickers page or from inside a room.', { error: true }); return; }
    try { await core.stickerSaver({ blob: cut.blob, width: cut.width, height: cut.height, name: out.name }); showToast('Saved to My stickers.'); }
    catch (err) { if (err?.cancelled) return; showToast(err?.message || 'Could not keep that sticker.', { error: true }); }
  }
  async function queueForLater(blob, message = '') {
    const room = getRoom ? getRoom() : null;
    if (!room || !room.id) { showToast('Open one of your rooms once while online, then Send to chat can wait here for it.', { error: true }); return; }
    const ok = await addOutbox({ id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, roomId: room.id, roomName: room.name || '', blob, message: message || '', at: Date.now() });
    if (!ok) { showToast("Couldn't keep the picture for later on this device.", { error: true }); return; }
    showToast(`No connection -- the drawing will be sent to ${room.name || 'the room'}'s chat when you are back online in that room.`, { duration: 5200 });
    refreshOutbox();
  }
  async function refreshOutbox() {
    const n = (await listOutbox()).length;
    const btn = document.getElementById('sketchSend');
    if (btn) { btn.dataset.queued = n ? String(n) : ''; btn.title = n ? `Send this drawing to the room chat (${n} waiting to send)` : 'Send this drawing to the room chat'; }
  }
  refreshOutbox();
  window.addEventListener('spac3-outbox', refreshOutbox);

  syncs.push(() => {
    const t = TOOLS.find((x) => x[0] === core.tool) || TOOLS[0];
    const ic = core.tool === 'brush' ? brushById(core.brushId).icon : t[1];
    toolBtn.firstChild.textContent = ic;
    toolBtn.title = `${t[2]} — tools and brushes`;
    colorBtn.firstChild.style.background = core.color;
    undoBtn.disabled = !core.canUndo();
    redoBtn.disabled = !core.canRedo();
    lockBtn.firstChild.textContent = core.locked ? '🔒' : '🔓';
    lockBtn.classList.toggle('is-active', core.locked);
    lockBtn.setAttribute('aria-pressed', String(core.locked));
    lockBtn.title = core.locked ? 'Unlock to draw again' : "Lock the drawing area so touching or scrolling over it doesn't draw";
  });
  ['tool', 'color', 'history', 'lock'].forEach((e) => core.on(e, sync));

  // ============================================================== TOOLS
  const toolGrid = h('div', { class: 'sk-toolgrid' });
  const toolBtns = TOOLS.map(([id, icon, name]) => {
    const b = h('button', { type: 'button', class: 'sk-toolbtn', dataset: { tool: id }, title: name, onClick: () => { core.setTool(id); sync(); if (id === 'transform' || id === 'hand' || id === 'fill' || id === 'eyedrop') closeSheet(); } }, h('span', { class: 'sk-ico' }, icon), h('span', { class: 'sk-tn' }, name));
    toolGrid.append(b);
    return [id, b];
  });
  syncs.push(() => toolBtns.forEach(([id, b]) => { const on = core.tool === id; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); }));

  const brushList = h('div', { class: 'sk-brushes' });
  const brushBtns = BRUSHES.map((br) => {
    const cv = h('canvas', { width: 160, height: 44, class: 'sk-brushprev' });
    const b = h('button', { type: 'button', class: 'sk-brush', dataset: { brush: br.id }, title: br.name, onClick: () => { core.setBrush(br.id, br); sync(); } }, cv, h('span', {}, br.name));
    brushList.append(b);
    return [br, b, cv];
  });
  let previewsDrawn = false;
  function drawBrushPreviews() {
    if (previewsDrawn) return;
    previewsDrawn = true;
    brushBtns.forEach(([br, , cv]) => {
      const g = cv.getContext('2d');
      const d0 = clamp(br.defSize * 0.55, 4, 20);
      const color = '#e5e7eb';
      const state = { carry: 0 };
      for (let i = 0; i <= 120; i++) {
        const t = i / 120;
        const x = 12 + t * 136;
        const y = 22 + Math.sin(t * Math.PI * 2) * 9;
        const pr = Math.sin(t * Math.PI);
        const d = br.pressureSize ? d0 * (0.3 + 0.7 * pr) : d0;
        stampTip(g, br, color, x, y, d, br.flow < 0.5 ? Math.min(1, br.flow * 2.4) : br.flow, i);
      }
      void state;
    });
  }
  syncs.push(() => brushBtns.forEach(([br, b]) => { const on = core.brushId === br.id; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); }));

  const logSize = {
    toSlider: (v) => (100 * Math.log(clamp(v, 1, 160))) / Math.log(160),
    fromSlider: (v) => Math.max(1, Math.round(Math.exp((v / 100) * Math.log(160)))),
  };
  const sizeSlider = (id) => slider({ label: 'Size', min: 0, max: 100, step: 0.5, id, get: () => core.size, set: (v) => core.setSetting('size', v), fmt: (v) => `${v}`, ...logSize });
  const opacitySlider = (id) => slider({ label: 'Opacity', min: 1, max: 100, id, get: () => core.opacity, set: (v) => core.setSetting('opacity', v), fmt: (v) => `${v}%` });
  const smoothSlider = (id) => slider({ label: 'Smoothing', min: 0, max: 100, id, get: () => core.smoothing, set: (v) => core.setSetting('smoothing', v), fmt: (v) => `${v}%` });

  const secBrush = h('div', { class: 'sk-sec', dataset: { for: 'brush eraser smudge' } },
    brushList, sizeSlider('sketchSize'), opacitySlider('sketchOpacity'), smoothSlider('sketchSmooth'),
    toggle('QuickShape: hold at the end of a stroke to snap lines & shapes', () => core.quickShape, (v) => core.setSetting('quickShape', v), 'sketchQuickShape'));
  const secFill = h('div', { class: 'sk-sec', dataset: { for: 'fill' } },
    h('p', { class: 'sk-hint' }, 'Tap an area to fill it with the current colour.'),
    slider({ label: 'Tolerance', min: 0, max: 100, id: 'sketchFillTol', get: () => core.fillTol, set: (v) => core.setSetting('fillTol', v), fmt: (v) => `${v}%` }),
    slider({ label: 'Edge grow', min: 0, max: 4, id: 'sketchFillGrow', get: () => core.fillGrow, set: (v) => core.setSetting('fillGrow', v), fmt: (v) => `${v}px` }),
    toggle('Look at all layers (not just this one)', () => core.fillAll, (v) => core.setSetting('fillAll', v), 'sketchFillAll'),
    btn('Fill the whole layer / selection', () => core.tools.fillSelection(), { id: 'sketchFillAllBtn' }));
  const secSelect = h('div', { class: 'sk-sec', dataset: { for: 'select' } },
    h('p', { class: 'sk-hint' }, 'Drag to select. Then move, copy, cut or fill the selection.'),
    chips([['rect', '▭ Box'], ['ellipse', '◯ Oval'], ['lasso', '✎ Freehand']], () => core.selMode, (v) => core.setSetting('selMode', v)),
    h('div', { class: 'sk-actions' },
      btn('Select all', () => core.tools.selectAll()), btn('Invert', () => core.tools.invertSelection()), btn('Deselect', () => core.tools.deselect()),
      btn('Paste', () => { core.tools.pasteClipboard(); closeSheet(); })));
  const secShape = h('div', { class: 'sk-sec', dataset: { for: 'shape' } },
    h('p', { class: 'sk-hint' }, 'Drag to draw a shape with the current brush. Hold Shift for a square or circle.'),
    chips([['line', '╱ Line'], ['rect', '▭ Rectangle'], ['ellipse', '◯ Ellipse']], () => core.shapeKind, (v) => core.setSetting('shapeKind', v)),
    toggle('Filled', () => core.shapeFill, (v) => core.setSetting('shapeFill', v), 'sketchShapeFill'),
    sizeSlider('sketchShapeSize'), opacitySlider('sketchShapeOpacity'));
  const secOthers = [secBrush, secFill, secSelect, secShape];
  const toolsBody = h('div', {}, toolGrid, secOthers);
  syncs.push(() => secOthers.forEach((s) => { s.hidden = !s.dataset.for.split(' ').includes(core.tool); }));
  makeSheet('tools', 'Tools & brushes', toolsBody);
  core.on('sheet', (n) => { if (n === 'tools') drawBrushPreviews(); });

  // ============================================================== COLOUR
  const SBW = 240; const SBH = 130;
  const sb = h('canvas', { width: SBW, height: SBH, class: 'sk-sb', 'aria-label': 'Saturation and brightness' });
  const hueBar = h('canvas', { width: SBW, height: 22, class: 'sk-hue', 'aria-label': 'Hue' });
  const hex = h('input', { type: 'text', class: 'sk-hex', maxlength: 7, 'aria-label': 'Hex colour', id: 'sketchHex', autocapitalize: 'off', spellcheck: 'false' });
  const hsv = { h: 0, s: 0, v: 0.1 };
  function drawSB() {
    const g = sb.getContext('2d');
    const [r, gg, b] = hsvToRgb(hsv.h, 1, 1);
    const gx = g.createLinearGradient(0, 0, SBW, 0);
    gx.addColorStop(0, '#fff'); gx.addColorStop(1, `rgb(${r},${gg},${b})`);
    g.fillStyle = gx; g.fillRect(0, 0, SBW, SBH);
    const gy = g.createLinearGradient(0, 0, 0, SBH);
    gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, '#000');
    g.fillStyle = gy; g.fillRect(0, 0, SBW, SBH);
    const x = hsv.s * SBW; const y = (1 - hsv.v) * SBH;
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = '#000'; g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
  }
  function drawHue() {
    const g = hueBar.getContext('2d');
    const gr = g.createLinearGradient(0, 0, SBW, 0);
    for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    g.fillStyle = gr; g.fillRect(0, 0, SBW, 22);
    const x = (hsv.h / 360) * SBW;
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 2;
    g.beginPath(); g.rect(x - 3, 1, 6, 20); g.fill(); g.stroke();
  }
  function hsvFromColor(c) {
    const rgb = hexToRgb(c);
    if (!rgb) return;
    const [hh, s, v] = rgbToHsv(...rgb);
    // keep the hue when the colour is grey so the hue bar doesn't jump
    hsv.h = s > 0.02 && v > 0.02 ? hh : hsv.h; hsv.s = s; hsv.v = v;
  }
  function pushHsv(remember) {
    core.setColor(rgbToHex(...hsvToRgb(hsv.h, hsv.s, hsv.v)), { remember });
  }
  function drag(el, fn, done) {
    let id = null;
    el.addEventListener('pointerdown', (e) => { id = e.pointerId; try { el.setPointerCapture(id); } catch { /* ignore */ } e.preventDefault(); fn(e); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) fn(e); });
    const end = (e) => { if (e.pointerId === id) { id = null; done?.(); } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  drag(sb, (e) => {
    const r = sb.getBoundingClientRect();
    hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    pushHsv(false);
  }, () => pushHsv(true));
  drag(hueBar, (e) => {
    const r = hueBar.getBoundingClientRect();
    hsv.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    pushHsv(false);
  }, () => pushHsv(true));
  hex.addEventListener('change', () => {
    let v = hex.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (hexToRgb(v)) { const rgb = hexToRgb(v); core.setColor(rgbToHex(...rgb), { remember: true }); } else sync();
  });
  const swatchRow = (getList, extra) => {
    const row = h('div', { class: 'sk-swatches' });
    const render = () => {
      row.textContent = '';
      getList().forEach((c) => {
        const s = h('button', { type: 'button', class: 'sk-swatch', title: c, 'aria-label': `Colour ${c}`, style: `background:${c}`, onClick: () => core.setColor(c, { remember: true }) });
        if (c.toLowerCase() === core.color.toLowerCase()) s.classList.add('is-active');
        row.append(s);
      });
      if (extra) row.append(extra());
    };
    syncs.push(render);
    return row;
  };
  const historyRow = swatchRow(() => core.colorHistory);
  const paletteRow = swatchRow(() => core.palette, () => h('button', { type: 'button', class: 'sk-swatch sk-add', title: 'Save this colour to your palette', 'aria-label': 'Save colour to palette', id: 'sketchPaletteAdd', onClick: () => { if (!core.palette.includes(core.color)) { core.palette = [core.color, ...core.palette].slice(0, 16); core.savePrefsSoon(); sync(); } } }, '+'));
  const baseRow = swatchRow(() => BASE_COLORS);
  syncs.push(() => { hsvFromColor(core.color); drawSB(); drawHue(); hex.value = core.color; });
  const colorBody = h('div', {}, sb, hueBar,
    h('div', { class: 'sk-hexrow' }, h('span', { class: 'sk-cur', id: 'sketchCurColor' }), hex,
      btn('🎯 Pick from page', () => { core.setTool('eyedrop'); closeSheet(); }, { id: 'sketchPickBtn' })),
    h('div', { class: 'sk-sub' }, 'Basics'), baseRow,
    h('div', { class: 'sk-sub' }, 'Recent'), historyRow,
    h('div', { class: 'sk-sub' }, 'My palette'), paletteRow);
  syncs.push(() => { const c = colorBody.querySelector('#sketchCurColor'); if (c) c.style.background = core.color; });
  makeSheet('color', 'Colour', colorBody);

  // ================================================================ SIZE
  const sizeBody = h('div', {}, sizeSlider('sketchSizeQuick'), opacitySlider('sketchOpacityQuick'), smoothSlider('sketchSmoothQuick'));
  makeSheet('size', 'Size & opacity', sizeBody);

  // ============================================================== LAYERS
  const layerList = h('div', { class: 'sk-layers', role: 'list' });
  const propBox = h('div', { class: 'sk-layerprops' });
  const blendSel = h('select', { class: 'sk-select', 'aria-label': 'Blend mode', id: 'sketchBlend' }, BLENDS.map(([v, n]) => h('option', { value: v }, n)));
  blendSel.addEventListener('change', () => core.setLayerProp(core.active, 'blend', blendSel.value));
  const layerOpacity = slider({ label: 'Opacity', min: 0, max: 100, id: 'sketchLayerOpacity', get: () => Math.round((core.activeLayer()?.opacity ?? 1) * 100), set: (v) => core.setLayerProp(core.active, 'opacity', v / 100), fmt: (v) => `${v}%` });
  const layerToggle = (label, key, id) => toggle(label, () => !!core.activeLayer()?.[key], (v) => core.setLayerProp(core.active, key, v), id);
  propBox.append(layerOpacity, h('label', { class: 'sk-slider' }, h('span', { class: 'sk-label' }, 'Blend'), blendSel),
    h('div', { class: 'sk-togrow' }, layerToggle('Lock', 'locked', 'sketchLayerLock'), layerToggle('Alpha lock', 'alphaLock', 'sketchLayerAlpha'), layerToggle('Clip to below', 'clip', 'sketchLayerClip')));
  syncs.push(() => { const L = core.activeLayer(); if (L) blendSel.value = L.blend; });
  const layerActions = h('div', { class: 'sk-actions sk-layeracts' },
    btn('＋', () => core.addLayer(), { title: 'New layer', id: 'sketchLayerAdd', 'aria-label': 'New layer' }),
    btn('⎘', () => core.duplicateLayer(), { title: 'Duplicate layer', 'aria-label': 'Duplicate layer' }),
    btn('▲', () => core.moveLayer(core.active, 1), { title: 'Move layer up', 'aria-label': 'Move layer up', id: 'sketchLayerUp' }),
    btn('▼', () => core.moveLayer(core.active, -1), { title: 'Move layer down', 'aria-label': 'Move layer down', id: 'sketchLayerDown' }),
    btn('⤓', () => core.mergeDown(), { title: 'Merge into the layer below', 'aria-label': 'Merge down', id: 'sketchLayerMerge' }),
    btn('⌫', () => core.clearLayer(), { title: 'Clear this layer', 'aria-label': 'Clear layer' }),
    btn('🗑', () => core.deleteLayer(), { title: 'Delete layer', 'aria-label': 'Delete layer', id: 'sketchLayerDelete' }));
  makeSheet('layers', 'Layers', h('div', {}, layerActions, layerList, propBox, h('p', { class: 'sk-hint', id: 'sketchLayerCount' })));
  function renderLayers() {
    if (openName !== 'layers') return;
    layerList.textContent = '';
    for (let i = core.layers.length - 1; i >= 0; i--) {
      const L = core.layers[i];
      const thumb = h('canvas', { width: 54, height: 36, class: 'sk-thumb' });
      const g = thumb.getContext('2d');
      g.fillStyle = core.bg === 'transparent' ? '#cbd5e1' : core.bg; g.fillRect(0, 0, 54, 36);
      g.drawImage(L.canvas, 0, 0, 54, 36);
      const eye = h('button', { type: 'button', class: 'sk-eye', title: L.visible ? 'Hide layer' : 'Show layer', 'aria-label': L.visible ? 'Hide layer' : 'Show layer', 'aria-pressed': String(L.visible), onClick: (e) => { e.stopPropagation(); core.setLayerProp(i, 'visible', !L.visible); } }, L.visible ? '👁' : '◌');
      const tags = [L.locked ? '🔒' : '', L.alphaLock ? 'α' : '', L.clip ? '⤵' : '', L.blend !== 'source-over' ? 'fx' : '', L.opacity < 1 ? `${Math.round(L.opacity * 100)}%` : ''].filter(Boolean).join(' ');
      const row = h('div', { class: `sk-layer${i === core.active ? ' is-active' : ''}`, role: 'listitem', dataset: { index: i }, tabindex: 0, onClick: () => core.setActive(i), onKeydown: (e) => { if (e.key === 'Enter') core.setActive(i); } },
        eye, thumb, h('div', { class: 'sk-lname' }, h('span', {}, L.name), h('small', {}, tags)));
      layerList.append(row);
    }
    const c = document.getElementById('sketchLayerCount');
    if (c) c.textContent = `${core.layers.length} of ${MAX_LAYERS} layers`;
    sync();
  }
  let layerRaf = 0;
  core.on('layers', () => { if (layerRaf) return; layerRaf = requestAnimationFrame(() => { layerRaf = 0; renderLayers(); sync(); }); });
  core.on('sheet', (n) => { if (n === 'layers') renderLayers(); });

  // =============================================================== MORE
  const rotateBy = (deg) => core.zoomAt(core.VW / 2, core.VH / 2, core.view.z, core.view.rot + (deg * Math.PI) / 180);
  const zoomBy = (f) => core.zoomAt(core.VW / 2, core.VH / 2, core.view.z * f);
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, id: 'sketchPhotoInput' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { core.tools.insertImage(img); URL.revokeObjectURL(url); closeSheet(); };
    img.onerror = () => { URL.revokeObjectURL(url); showToast("Couldn't open that picture.", { error: true }); };
    img.src = url;
  });
  let clearArmed = false;
  const clearBtn = btn('🗑 Clear page', () => {
    if (core.isEmpty()) return;
    if (!clearArmed) {
      clearArmed = true; clearBtn.classList.add('is-armed'); clearBtn.textContent = 'Sure? Tap again';
      setTimeout(() => { clearArmed = false; clearBtn.classList.remove('is-armed'); clearBtn.textContent = '🗑 Clear page'; }, 3000);
      return;
    }
    clearArmed = false; clearBtn.classList.remove('is-armed'); clearBtn.textContent = '🗑 Clear page';
    core.clearAll();
  }, { id: 'sketchClear' });
  // ======================================================== MY SKETCHES
  // Save the drawing so it can be reopened later, start a fresh page, and keep a
  // little gallery of everything saved (this browser only). The open sketch
  // autosaves as you draw; starting a new drawing or opening another one always
  // saves the one you are leaving first, so nothing is lost by switching.
  const curName = h('div', { class: 'sk-curname', id: 'sketchCurName' });
  syncs.push(() => { curName.textContent = core.sketchId ? `✓ ${core.sketchName} · saved, keeps saving as you draw` : 'Untitled drawing · not saved yet'; curName.classList.toggle('is-saved', !!core.sketchId); });
  core.on('sketch', sync);
  core.on('savefail', () => showToast("Couldn't save. This browser's storage may be full.", { error: true }));
  let sketchBusy = false;
  async function guarded(fn) {
    if (sketchBusy) return;
    sketchBusy = true;
    try { await fn(); } finally { sketchBusy = false; }
  }
  const quickSave = (typed) => guarded(async () => {
    if (!core.sketchId && !core.hasInk()) { showToast('Draw something first.'); return; }
    const wasSaved = !!core.sketchId;
    const ok = await core.saveSketch(typed);
    if (ok) showToast(wasSaved ? `Saved “${core.sketchName}”.` : `Saved as “${core.sketchName}”. Find it under My sketches.`);
  });
  const startNew = () => guarded(async () => {
    const saved = await core.newDrawing();
    closeSheet();
    showToast(saved ? `Saved “${saved}” and started a new drawing.` : 'New drawing ready.');
  });
  const openGallery = () => openSheet('gallery', document.getElementById('sketchMoreBtn'));
  const moreBody = h('div', {},
    h('div', { class: 'sk-actions' }, h('button', { type: 'button', class: 'secondary', id: 'sketchMoreLayers', title: 'Layers', onClick: () => { const a = barBtns.sketchMoreBtn; closeSheet(); openSheet('layers', a); } }, '▤ Layers')),
    h('div', { class: 'sk-sub' }, 'My sketches'),
    curName,
    h('div', { class: 'sk-actions' },
      btn('💾 Save sketch', () => quickSave(), { id: 'sketchSaveSketch', title: 'Save this drawing so you can come back to it' }),
      btn('＋ New drawing', startNew, { id: 'sketchNewDrawing', title: 'Save this drawing and start a blank page' }),
      btn('🗂 My sketches', openGallery, { id: 'sketchOpenGallery', title: 'Open a saved sketch' })),
    h('p', { class: 'sk-hint', id: 'sketchOfflineHint' }, 'Your drawing is saved on this device every couple of minutes, and whenever you leave or lose connection. ',
      document.body.classList.contains('sketch-standalone') ? 'This page works with no connection.'
        : h('a', { href: 'sketch.html', target: '_blank', rel: 'noopener' }, 'Open the offline Sketchpad page')),
    h('div', { class: 'sk-sub' }, 'View'),
    h('div', { class: 'sk-actions' },
      btn('−', () => zoomBy(1 / 1.5), { id: 'sketchZoomOut', title: 'Zoom out', 'aria-label': 'Zoom out' }),
      btn('+', () => zoomBy(1.5), { id: 'sketchZoomIn', title: 'Zoom in', 'aria-label': 'Zoom in' }),
      btn('↺ 15°', () => rotateBy(-15), { id: 'sketchRotL', title: 'Rotate the page left' }),
      btn('↻ 15°', () => rotateBy(15), { id: 'sketchRotR', title: 'Rotate the page right' }),
      btn('Fit', () => core.resetView(), { id: 'sketchFit', title: 'Fit the whole page, unrotated' })),
    h('div', { class: 'sk-sub' }, 'Drawing guides'),
    h('div', { class: 'sk-actions' }, toggle('Grid', () => core.grid.on, (v) => { core.grid = { ...core.grid, on: v }; core.invalidate(); core.savePrefsSoon(); }, 'sketchGrid')),
    slider({ label: 'Grid size', min: 10, max: 200, step: 5, id: 'sketchGridSize', get: () => core.grid.size, set: (v) => { core.grid = { ...core.grid, size: v }; core.invalidate(); core.savePrefsSoon(); }, fmt: (v) => `${v}` }),
    h('div', { class: 'sk-sub' }, 'Symmetry'),
    chips(SYMS, () => core.symmetry, (v) => core.setSetting('symmetry', v), 'sk-symchips'),
    h('div', { class: 'sk-sub' }, 'Adjustments (this layer)'),
    h('div', { class: 'sk-actions' },
      btn('Hue · Sat · Bright', () => openAdjust('hsb'), { id: 'sketchAdjHsb' }), btn('Blur', () => openAdjust('blur'), { id: 'sketchAdjBlur' }), btn('Invert', () => openAdjust('invert'), { id: 'sketchAdjInvert' })),
    h('div', { class: 'sk-sub' }, 'Paper'),
    h('div', { class: 'sk-swatches' }, PAPERS.map(([v, n]) => h('button', { type: 'button', class: 'sk-paper', dataset: { paper: v }, title: n, 'aria-label': `${n} paper`, onClick: () => { core.setBg(v); sync(); }, style: v === 'transparent' ? '' : `background:${v}` }, v === 'transparent' ? '▦' : ''))),
    h('div', { class: 'sk-sub' }, 'Touch'),
    chips([['draw', '☝ Finger draws'], ['pan', '✋ Finger moves page']], () => core.fingerMode, (v) => core.setSetting('fingerMode', v)),
    h('div', { class: 'sk-sub' }, 'Picture'),
    h('div', { class: 'sk-actions' },
      btn('📷 Insert photo', () => fileInput.click(), { id: 'sketchInsert' }),
      btn('⬇ Save PNG', async () => {
        if (core.isEmpty()) { showToast('Draw something first.'); return; }
        const blob = await core.exportBlob();
        if (!blob) { showToast("Couldn't make the picture.", { error: true }); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'spac3-sketch.png';
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }, { id: 'sketchSave' }),
      clearBtn),
    fileInput,
    h('details', { class: 'sk-help' }, h('summary', {}, 'Gestures & shortcuts'),
      h('ul', {},
        h('li', {}, 'Two fingers: pinch to zoom, twist to rotate, drag to move. Tap with two fingers to undo, three to redo.'),
        h('li', {}, 'Hold at the end of a stroke to snap it to a line, circle or shape (when Quick shape is on). To pick a colour, use the Pick colour tool.'),
        h('li', {}, 'Mouse: scroll to zoom, Shift+scroll to rotate, middle-drag to move. Ctrl+Z undo, Ctrl+Shift+Z redo, [ and ] change brush size.'))));
  // two tabs: everything else (as before), and the choice of buttons for the bottom bar
  const tabMore = h('button', { type: 'button', class: 'sk-tab is-active', id: 'sketchTabMore' }, 'More');
  const tabBar = h('button', { type: 'button', class: 'sk-tab', id: 'sketchTabBar' }, 'Bottom bar');
  const showMoreTab = (which) => { const bt = which === 'bar'; moreBody.hidden = bt; barCustom.panel.hidden = !bt; tabMore.classList.toggle('is-active', !bt); tabBar.classList.toggle('is-active', bt); tabMore.setAttribute('aria-selected', String(!bt)); tabBar.setAttribute('aria-selected', String(bt)); if (bt) barCustom.refresh(); };
  tabMore.addEventListener('click', () => showMoreTab('more')); tabBar.addEventListener('click', () => showMoreTab('bar'));
  barCustom.panel.hidden = true;
  makeSheet('more', 'More', h('div', {}, h('div', { class: 'sk-tabs', role: 'tablist' }, tabMore, tabBar), moreBody, barCustom.panel));
  syncs.push(() => {
    moreBody.querySelectorAll('.sk-paper').forEach((b) => b.classList.toggle('is-active', b.dataset.paper === core.bg));
  });
  core.on('bg', sync);

  // ---- the gallery sheet
  const nameInput = h('input', { type: 'text', class: 'sk-nameinput', id: 'sketchNameInput', placeholder: 'Name this drawing', maxlength: 60, 'aria-label': 'Sketch name', autocomplete: 'off' });
  const galList = h('div', { class: 'sk-gallery', id: 'sketchGallery' });
  const galBody = h('div', {},
    h('div', { class: 'sk-namerow' }, nameInput, btn('💾 Save', () => {
      let typed = nameInput.value.trim();
      if (core.sketchId && typed === core.sketchName) typed = '';
      quickSave(typed);
    }, { id: 'sketchGalSave' })),
    h('div', { class: 'sk-actions' }, btn('＋ New drawing', startNew, { id: 'sketchGalNew' })),
    galList,
    h('p', { class: 'sk-hint' }, 'Sketches are kept in this browser only; clearing the site’s data removes them. The open sketch saves itself as you draw.'));
  makeSheet('gallery', 'My sketches', galBody);
  const fmtDate = (t) => { try { return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  let galSeq = 0;
  async function renderGallery() {
    const my = ++galSeq;
    const list = await core.listSketches();
    if (my !== galSeq) return;
    galList.replaceChildren();
    if (!list.length) { galList.append(h('p', { class: 'sk-hint sk-empty' }, 'Nothing saved yet. Draw something, then tap Save.')); return; }
    list.forEach((m) => {
      const isCur = m.id === core.sketchId;
      const nameEl = h('div', { class: 'sk-cardname', title: `${m.name} (tap to rename)` }, m.name);
      nameEl.addEventListener('click', () => startRename());
      const startRename = () => {
        const inp = h('input', { type: 'text', class: 'sk-nameinput sk-rename', value: m.name, maxlength: 60, 'aria-label': 'New name' });
        let done = false;
        const commit = async (ok) => { if (done) return; done = true; if (ok && inp.value.trim() && inp.value.trim() !== m.name) await core.renameSketch(m.id, inp.value); else renderGallery(); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); e.stopPropagation(); });
        inp.addEventListener('blur', () => commit(true));
        nameEl.replaceWith(inp); inp.focus(); inp.select();
      };
      let armed = false;
      const del = h('button', { type: 'button', class: 'sk-act sk-mini', title: 'Delete this sketch', 'aria-label': `Delete ${m.name}`, dataset: { act: 'delete' } }, '🗑');
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.classList.add('is-armed'); del.textContent = 'Delete?'; setTimeout(() => { armed = false; del.classList.remove('is-armed'); del.textContent = '🗑'; }, 3000); return; }
        await core.deleteSketch(m.id);
        showToast(`Deleted “${m.name}”.`);
      });
      galList.append(h('div', { class: `sk-card${isCur ? ' is-current' : ''}`, dataset: { id: m.id } },
        h('button', { type: 'button', class: 'sk-thumb', title: isCur ? 'This is the drawing you have open' : `Open ${m.name}`, dataset: { act: 'open' }, onClick: () => guarded(async () => {
          if (isCur) { closeSheet(); return; }
          const had = core.sketchId || core.hasInk();
          const ok = await core.openSketch(m.id);
          if (!ok) { showToast("Couldn't open that sketch.", { error: true }); return; }
          closeSheet();
          showToast(had ? `Opened “${m.name}”. Your last drawing is saved.` : `Opened “${m.name}”.`);
        }) }, m.thumb ? h('img', { src: m.thumb, alt: '', draggable: 'false' }) : h('span', {}, '🖼'), isCur ? h('span', { class: 'sk-badge' }, 'Open') : null),
        nameEl,
        h('div', { class: 'sk-cardmeta' }, `${fmtDate(m.updated)} · ${m.layers || 1} layer${m.layers === 1 ? '' : 's'}`),
        h('div', { class: 'sk-cardbtns' },
          h('button', { type: 'button', class: 'sk-act sk-mini', title: 'Rename this sketch', 'aria-label': `Rename ${m.name}`, dataset: { act: 'rename' }, onClick: startRename }, '✎ Rename'),
          h('button', { type: 'button', class: 'sk-act sk-mini', title: 'Make a copy', 'aria-label': `Duplicate ${m.name}`, dataset: { act: 'dup' }, onClick: () => guarded(async () => { if (await core.duplicateSketch(m.id)) showToast(`Copied “${m.name}”.`); }) }, '⧉'),
          del)));
    });
  }
  openHooks.gallery = () => { nameInput.value = core.sketchName || ''; renderGallery(); };
  core.on('gallery', () => { if (openName === 'gallery') renderGallery(); });
  core.on('sketch', () => { if (openName === 'gallery') nameInput.value = core.sketchName || ''; });

  // ============================================================== ADJUST
  const adjBody = h('div', { id: 'sketchAdjBody' });
  const adjSliders = {
    hsb: [['hue', 'Hue', -180, 180], ['sat', 'Saturation', -100, 100], ['bri', 'Brightness', -100, 100], ['con', 'Contrast', -100, 100]],
    blur: [['radius', 'Blur', 0, 40]],
    invert: [],
  };
  function openAdjust(kind) {
    if (!core.beginAdjust(kind)) return;
    adjBody.textContent = '';
    adjSliders[kind].forEach(([key, label, min, max]) => {
      const input = h('input', { type: 'range', min, max, step: 1, value: 0, 'aria-label': label, id: `sketchAdj_${key}` });
      const val = h('span', { class: 'sk-val' }, '0');
      input.addEventListener('input', () => { val.textContent = input.value; core.updateAdjust({ [key]: Number(input.value) }); });
      adjBody.append(h('label', { class: 'sk-slider' }, h('span', { class: 'sk-label' }, label), input, val));
    });
    if (kind === 'invert') { core.updateAdjust({}); adjBody.append(h('p', { class: 'sk-hint' }, 'Flips every colour on this layer.')); }
    adjBody.append(h('div', { class: 'sk-actions' }, btn('✓ Apply', () => { core.commitAdjust(); closeSheetKeep(); }, { id: 'sketchAdjApply' }), btn('✕ Cancel', () => { core.cancelAdjust(); closeSheetKeep(); }, { id: 'sketchAdjCancel' })));
    const anchor = barBtns.sketchMoreBtn;
    closeSheet();
    openSheet('adjust', anchor);
  }
  function closeSheetKeep() { closeSheet(); }
  makeSheet('adjust', 'Adjust layer', adjBody);

  // ================================================== chip + context bar
  const chip = h('button', { type: 'button', class: 'sketch-viewchip', id: 'sketchZoomReset', title: 'Back to the whole page', 'aria-label': 'Reset zoom and rotation', hidden: true }, h('span', { id: 'sketchZoomLabel' }, '100%'));
  wrap.append(chip);
  chip.addEventListener('click', () => core.resetView());
  const updateChip = () => {
    const v = core.view;
    const away = v.z > 1.001 || Math.abs(v.rot) > 1e-3;
    chip.hidden = !away;
    const deg = Math.round((v.rot * 180) / Math.PI);
    chip.firstChild.textContent = `${Math.round(v.z * 100)}%${deg ? ` ↻${deg}°` : ''}`;
    core.canvas.classList.toggle('is-zoomed', v.z > 1.001);
  };
  core.on('view', updateChip);

  const ctxBar = h('div', { class: 'sketch-context', id: 'sketchContext', hidden: true });
  wrap.append(ctxBar);
  const cbtn = (text, title, fn, id) => h('button', { type: 'button', class: 'sk-cbtn', title, 'aria-label': title, id, onClick: fn }, text);
  function renderContext() {
    ctxBar.textContent = '';
    if (core.tf) {
      ctxBar.append(
        cbtn('✓ Done', 'Put it down', () => core.tools.applyTransform(), 'sketchTfApply'),
        cbtn('✕', 'Cancel', () => core.tools.cancelTransform(), 'sketchTfCancel'),
        cbtn('⇋', 'Flip left–right', () => core.tools.flip('h'), 'sketchTfFlipH'),
        cbtn('⇅', 'Flip up–down', () => core.tools.flip('v'), 'sketchTfFlipV'),
        h('button', { type: 'button', class: `sk-cbtn${core.tf.free ? ' is-on' : ''}`, id: 'sketchTfFree', title: 'Free-form scaling', onClick: () => { core.tf.free = !core.tf.free; renderContext(); } }, 'Free'));
      ctxBar.hidden = false;
    } else if (core.selection) {
      ctxBar.append(
        cbtn('⤢ Move', 'Move, scale or rotate the selection', () => core.setTool('transform'), 'sketchSelTransform'),
        cbtn('✂️ Sticker', 'Cut the selection out as a sticker', () => makeSticker(), 'sketchSelSticker'),
        cbtn('⎘', 'Copy', () => core.tools.copySelection(), 'sketchSelCopy'),
        cbtn('Cut', 'Cut (to paste somewhere else)', () => core.tools.copySelection({ cutIt: true }), 'sketchSelCut'),
        core.clipboard ? cbtn('📋', 'Paste as a new layer', () => core.tools.pasteClipboard(), 'sketchSelPaste') : null,
        cbtn('🎨', 'Fill with the colour', () => core.tools.fillSelection(), 'sketchSelFill'),
        cbtn('⌫', 'Clear the selected pixels', () => core.tools.clearSelectionPixels(), 'sketchSelClear'),
        cbtn('◩', 'Invert the selection', () => core.tools.invertSelection(), 'sketchSelInvert'),
        cbtn('✕', 'Deselect', () => core.tools.deselect(), 'sketchSelNone'));
      ctxBar.hidden = false;
    } else ctxBar.hidden = true;
  }
  ['selection', 'transform', 'clipboard'].forEach((e) => core.on(e, renderContext));

  // ============================================ fullscreen side sliders
  function vbar(id, label, get, set, toV, fromV, fmt, caption) {
    const fill = h('div', { class: 'sk-vfill' });
    const knob = h('div', { class: 'sk-vknob' });
    const bubble = h('div', { class: 'sk-vbubble' });
    const el = h('div', { class: 'sk-vbar', id, role: 'slider', tabindex: 0, 'aria-label': label, 'aria-orientation': 'vertical' }, fill, caption ? h('span', { class: 'sk-vlabel', 'aria-hidden': 'true' }, ...[...caption].map((ch, i) => h('i', { class: `c${i % 4}` }, ch))) : null, knob, bubble); // the fun caption sits inside the bar, reading top to bottom
    const refresh = () => { const f = clamp(toV(get()), 0, 1); fill.style.height = `${f * 100}%`; knob.style.bottom = `calc(${f * 100}% - 9px)`; bubble.textContent = fmt(get()); el.setAttribute('aria-valuenow', String(get())); };
    syncs.push(refresh);
    drag(el, (e) => { const r = el.getBoundingClientRect(); set(fromV(1 - clamp((e.clientY - r.top) / r.height, 0, 1))); el.classList.add('is-drag'); refresh(); }, () => el.classList.remove('is-drag'));
    el.addEventListener('keydown', (e) => { const d = e.key === 'ArrowUp' ? 0.02 : e.key === 'ArrowDown' ? -0.02 : 0; if (d) { set(fromV(clamp(toV(get()) + d, 0, 1))); refresh(); e.preventDefault(); } });
    return el;
  }
  const sideBars = h('div', { class: 'sketch-sidebars' },
    vbar('sketchSideSize', 'Brush size', () => core.size, (v) => core.setSetting('size', v), (v) => logSize.toSlider(v) / 100, (f) => logSize.fromSlider(f * 100), (v) => `${v}`, 'LINE'),
    vbar('sketchSideOpacity', 'Brush opacity', () => core.opacity, (v) => core.setSetting('opacity', v), (v) => (v - 1) / 99, (f) => Math.round(1 + f * 99), (v) => `${v}%`, 'SHADE'));
  wrap.append(sideBars);
  // in full screen the sliders sit in the middle of the free space between the screen edge and the page (not hard against the edge)
  function placeSideBars() {
    if (!panel.classList.contains('sketch-full')) { sideBars.style.left = ''; return; }
    const r = core.canvas.getBoundingClientRect(); const wr = wrap.getBoundingClientRect();
    if (!r.width || !core.VW) return;
    const m = core.matrix(); const pageLeft = (r.left - wr.left) + m.e * (r.width / core.VW); // where the page begins, in wrapper pixels
    const barW = 26;
    sideBars.style.left = `${Math.max(8, Math.round((pageLeft - barW) / 2))}px`;
  }
  core.on('view', placeSideBars); core.on('full', () => setTimeout(placeSideBars, 0)); window.addEventListener('resize', placeSideBars);

  // ============================================================ FULLSCREEN
  let fullPlaceholder = null;
  let savedStyle = null;
  function isFull() { return panel.classList.contains('sketch-full'); }
  function enterFull() {
    if (isFull()) return;
    closeSheet();
    fullPlaceholder = document.createComment('sketch-panel-home');
    panel.before(fullPlaceholder);
    savedStyle = panel.getAttribute('style');
    panel.removeAttribute('style');
    document.body.append(panel);
    panel.classList.add('sketch-full');
    document.documentElement.classList.add('sketch-full-open');
    fullBtn.title = 'Leave full screen'; fullBtn.setAttribute('aria-label', 'Leave full screen'); // the button keeps its look: only what it says when pointed at changes
    core.syncViewport();
    core.emit('full', true);
    window.scrollTo?.(0, 0);
  }
  function exitFull() {
    if (!isFull()) return;
    closeSheet();
    panel.classList.remove('sketch-full');
    document.documentElement.classList.remove('sketch-full-open');
    if (fullPlaceholder?.parentNode) { fullPlaceholder.replaceWith(panel); } else document.getElementById('sketchDock')?.append(panel);
    if (savedStyle != null) panel.setAttribute('style', savedStyle); else panel.removeAttribute('style');
    fullPlaceholder = null;
    fullBtn.title = 'Full screen'; fullBtn.setAttribute('aria-label', 'Full screen');
    core.syncViewport();
    core.emit('full', false);
    window.dispatchEvent(new Event('resize')); // let the room layout re-place the box
  }
  function toggleFull() { if (isFull()) exitFull(); else enterFull(); }

  // ↗ in a room's Sketchpad title bar: open this drawing on the full page. The page is opened first (a browser only allows that
  // straight after the tap), then the drawing is saved, then the page is pointed at the app, which opens the saved drawing.
  const openPageBtn = document.getElementById('sketchOpenPage');
  if (openPageBtn) openPageBtn.addEventListener('click', async () => {
    const tab = window.open('', '_blank'); if (tab) tab.opener = null;
    try { await core.saveNow(); } catch { /* the page still opens, with the last saved drawing */ }
    if (tab) tab.location.href = DRAW_PAGE_URL; else window.location.href = DRAW_PAGE_URL;
  });
  core.toggleFull = toggleFull;
  core.isFull = isFull;

  // ============================================================= keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (openName && openName !== 'adjust') { closeSheet(); return; } if (isFull()) { exitFull(); return; } if (core.tf) core.tools.cancelTransform(); return; }
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'range') return;
    if (tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    const active = isFull() || panel.matches(':hover') || panel.contains(document.activeElement);
    if (!active) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) core.redo(); else core.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); core.redo(); }
    else if (e.key === '[') core.setSetting('size', Math.max(1, Math.round(core.size * 0.85 - 0.5)));
    else if (e.key === ']') core.setSetting('size', Math.min(160, Math.round(core.size * 1.18 + 0.5)));
    else if (e.key === 'Enter' && core.tf) core.tools.applyTransform();
    else if (!mod && !e.altKey) {
      const map = { b: 'brush', e: 'eraser', s: 'smudge', g: 'fill', i: 'eyedrop', m: 'select', u: 'shape', t: 'transform', h: 'hand' };
      const t = map[e.key.toLowerCase()];
      if (t) core.setTool(t);
    }
  });

  core.on('layers', sync);
  core.on('selection', sync);
  core.on('transform', sync);
  core.on('adjust', sync);
  core.on('full', () => { sync(); core.invalidate(); });
  sync();
  updateChip();
  renderContext();
  return { sync, openSheet, closeSheet, toggleFull };
}
