// The one pop-up frame (dimmed backdrop + box) used by the small dialogs: "Send to chat", the friend picker and the
// "Show address" steps. It closes on Escape and on a click outside the box, removes itself, and resolves a promise.
//
//   const d = openDialog(box, { backdropClass: 'addr-backdrop' });
//   d.close(value);          // close from your own buttons
//   const value = await d.closed;   // null when dismissed with Escape / outside click
//
// `onKey(event, close)` lets a dialog add its own shortcut (e.g. Ctrl+Enter to send).
const open = []; // dialogs currently showing, last = on top; only the top one reacts to the keyboard

export function openDialog(box, { backdropClass = '', onKey = null, focus = null } = {}) {
  const back = document.createElement('div');
  back.className = `modal-backdrop dialog-backdrop ${backdropClass}`.trim();
  back.append(box);
  let isOpen = true; let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const close = (value = null) => {
    if (!isOpen) return; isOpen = false; open.splice(open.indexOf(close), 1);
    document.removeEventListener('keydown', onKeyDown, true); back.remove(); resolveClosed(value);
  };
  const onKeyDown = (e) => {
    if (open[open.length - 1] !== close) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(null); return; }
    if (onKey) onKey(e, close);
  };
  open.push(close); document.addEventListener('keydown', onKeyDown, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
  document.body.append(back);
  const target = typeof focus === 'function' ? focus() : focus;
  if (target !== false) setTimeout(() => (target || box.querySelector('input,textarea,button') || box).focus?.(), 0);
  return { close, closed, back };
}
