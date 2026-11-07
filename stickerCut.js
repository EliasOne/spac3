// stickerCut.js -- cut a sticker out of the Sketchpad: the pixels inside the selection (the Select tool's
// loop, box or oval), trimmed to their edges, shrunk to at most 512 px on the longest side, as a see-through PNG
// that is no more than 300 KB. Only the layers are cut (the paper colour is left behind), so what is not
// drawn inside the loop stays see-through.
import { STICKER_MAX_SIDE, STICKER_MAX_BYTES } from './stickersCore.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toBlob = (c) => new Promise((res) => c.toBlob((b) => res(b), 'image/png'));

// The smallest box (inclusive x0,y0 .. exclusive x1,y1) that holds every pixel that is not see-through, or null when there is none.
export function alphaBounds(data, w, h, min = 8) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= min) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// How much to shrink a w x h picture so its longest side is at most `max` (never enlarges).
export const fitScale = (w, h, max = STICKER_MAX_SIDE) => Math.min(1, max / Math.max(w, h));

// Cut from a Sketchpad core. Gives { blob, width, height, url } or { error } (a sentence for the person).
export async function cutSticker(core) {
  if (!core.selection) return { error: 'Select a piece of your drawing first (Select tool: loop, box or oval), then tap Sticker.' };
  const r = core.selectionBounds();
  if (!(r.w > 0 && r.h > 0)) return { error: 'That selection is empty.' };
  const region = mk(r.w, r.h); const g = region.getContext('2d');
  g.save(); g.translate(-r.x, -r.y); core.clipSelection(g); g.drawImage(core.flattenLayers(), 0, 0); g.restore();
  const box = alphaBounds(g.getImageData(0, 0, r.w, r.h).data, r.w, r.h);
  if (!box) return { error: 'Nothing is drawn inside that selection, so there is nothing to cut.' };
  const pad = 2; const sx = Math.max(0, box.x0 - pad); const sy = Math.max(0, box.y0 - pad);
  const sw = Math.min(r.w, box.x1 + pad) - sx; const sh = Math.min(r.h, box.y1 + pad) - sy;
  let scale = fitScale(sw, sh);
  for (let i = 0; i < 8; i++) {
    const w = Math.max(1, Math.round(sw * scale)); const h = Math.max(1, Math.round(sh * scale));
    const out = mk(w, h); const og = out.getContext('2d');
    og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
    og.drawImage(region, sx, sy, sw, sh, 0, 0, w, h);
    const blob = await toBlob(out);
    if (blob && blob.size <= STICKER_MAX_BYTES) return { blob, width: w, height: h, url: URL.createObjectURL(blob) };
    scale *= 0.8; // too heavy a picture: try a little smaller
  }
  return { error: 'That piece is too detailed to fit in a sticker. Try cutting a smaller piece.' };
}
