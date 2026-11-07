// SKETCHPAD -- a personal, Procreate-style drawing box (see #sketchPanel in
// room.html). Layers, brushes, fill, selection, shapes, transform, symmetry,
// zoom / rotate, fullscreen. Entirely local: the drawing lives in this
// browser; nothing is shared until "Send to chat", which hands a PNG to
// room.js (it uploads the picture and posts the link as a chat message).
//
//   sketchCore.js   document, layers, view, history, compositing, saving
//   sketchTools.js  what each tool does under a finger / pen / mouse
//   sketchBrushes.js  the brush presets + dab engine
//   sketchUtil.js   colour maths, flood fill, blur, QuickShape recognition
//   sketchStore.js  IndexedDB + preferences
//   sketchUI.js     the icon bar, popup sheets and fullscreen mode
import { createCore } from './sketchCore.js';
import { mountSketchUI } from './sketchUI.js';

export function initSketchpad({ onSend, getRoom, getFriends, onSendFriend } = {}) {
  const canvas = document.getElementById('sketchCanvas');
  if (!canvas) return null;
  const overlay = document.createElement('canvas');
  overlay.id = 'sketchOverlay';
  overlay.className = 'sketch-overlay';
  overlay.width = 1200;
  overlay.height = 800;
  overlay.setAttribute('aria-hidden', 'true');
  canvas.after(overlay);
  const core = createCore(canvas, overlay);
  canvas.__sketch = core; // handy for tests / debugging
  mountSketchUI(core, { onSend, getRoom, getFriends, onSendFriend });
  return core;
}
