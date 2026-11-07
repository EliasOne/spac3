// Shared sketchpad dimensions.
export const PAPER_W = 1200; // the page, in "paper units"
export const PAPER_H = 800;
export const RS = 1.5; // raster pixels per paper unit (layers are 1800 x 1200)
export const LW = PAPER_W * RS;
export const LH = PAPER_H * RS;
export const MAX_LAYERS = 8;
export const MAX_ZOOM = 10;
export const DRAW_PAGE_URL = 'sketch.html'; // the full-page drawing app (becomes draw.html when that page exists)
export const SHARE_W = 1200; // a drawing sent to a chat is this big (the full page is 1800 x 1200): about 25 times fewer bytes, still sharp on a phone
export const SHARE_H = 800;
