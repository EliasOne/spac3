// The one notification ("toast") for the whole app. Every page uses it:
//   showToast('Saved.')                       short message at the bottom, fades after ~3 s
//   showToast('No connection.', { error: true })
//   showToast('Layout: wide', { duration: 2400 })
// The room has a themed #toasts holder in its stage (styled by room.css); other pages get one created on the fly
// (styled by style.css). Both sit above everything, including the full-screen sketchpad.
export function showToast(message, opts = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = opts.error ? 'toast toast-error' : 'toast';
  el.setAttribute('role', opts.error ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), opts.duration || 3200);
}
