// stickersCore.js -- the DOM-free half of stickers (see supabase/stickers.sql for the server side).
// A sticker is one small see-through PNG kept on your account. My stickers are the ones you made;
// Collected are copies of other people's you saved (from a tag in a room, or a gift).
//
// The Supabase client and who I am are passed in, so a test can drive it with a fake backend.
// Writing always goes through the sticker_* database functions (they check the limits);
// the picture files go to the public "stickers" storage bucket, in your own folder.

export const STICKER_MAX_SIDE = 512;
export const STICKER_MAX_BYTES = 300 * 1024;
export const STICKER_NAME_MAX = 40;
export const STICKER_BUCKET = 'stickers';
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/;

// A friendly sentence for what the database says when it refuses.
export function friendlyStickerError(err) {
  const code = err?.code || '';
  const msg = String(err?.message || err || '');
  if (code === 'P0402' || /shelf is full/i.test(msg)) return /Collected/.test(msg) ? 'Your Collected shelf is full. Remove one to make room.' : 'My stickers is full. Delete one to make room.';
  if (code === 'P0429' || /too many/i.test(msg)) return 'That is a lot of new stickers in a short time. Try again in a little while.';
  if (code === 'P0403' || /display only/i.test(msg)) return 'Its maker keeps this sticker for display only.';
  if (code === 'P0404' || /cannot be found|not found|not there|does not exist/i.test(msg)) return 'That sticker is not there any more.';
  if (code === '28000' || /sign in/i.test(msg)) return 'Sign in to keep stickers.';
  if (/Failed to fetch|NetworkError|offline/i.test(msg)) return 'No connection. Try again when you are back online.';
  return msg || 'Something went wrong with that sticker.';
}

export function cleanStickerName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, STICKER_NAME_MAX);
}

// The path inside the "stickers" bucket of a picture link, or null when the link is not one of ours.
// Tags and gifts carry a link; a page must only ever draw links that pass this check.
export function stickerPathFromUrl(url, projectUrl) {
  try {
    const u = new URL(String(url));
    const base = new URL(String(projectUrl));
    if (u.origin !== base.origin || u.search || u.hash) return null;
    const m = u.pathname.match(/^\/storage\/v1\/object\/public\/stickers\/([^/]+\/[^/]+)$/);
    return m && PATH_RE.test(m[1]) ? m[1] : null;
  } catch { return null; }
}

export function createStickers({ supabase: sb, userId, newId = () => globalThis.crypto.randomUUID() } = {}) {
  const state = { made: [], collected: [], loaded: false };
  const listeners = new Set();
  const emit = () => listeners.forEach((cb) => { try { cb(state); } catch (err) { console.error(err); } });
  const onChange = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  const bucket = () => sb.storage.from(STICKER_BUCKET);
  const fail = (error) => { const e = new Error(friendlyStickerError(error)); e.code = error?.code; e.cause = error; return e; };

  const url = (path) => bucket().getPublicUrl(path).data.publicUrl;
  const sortNew = (rows) => rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const put = (row) => {
    const list = row.origin === 'collected' ? state.collected : state.made;
    if (!list.some((r) => r.id === row.id)) list.unshift(row);
    return row;
  };

  async function load() {
    const { data, error } = await sb.from('stickers').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (error) throw fail(error);
    const rows = sortNew(data || []).filter((r) => r.user_id === userId);
    state.made = rows.filter((r) => r.origin !== 'collected');
    state.collected = rows.filter((r) => r.origin === 'collected');
    state.loaded = true; emit();
    return state;
  }

  // Keep a picture on My stickers: upload it to my folder, then ask the database to file it.
  async function save({ blob, name, width, height }) {
    if (!blob || blob.type !== 'image/png') throw new Error('A sticker has to be a PNG picture.');
    if (blob.size > STICKER_MAX_BYTES) throw new Error('That sticker is too big. Cut a smaller piece.');
    if (!(width >= 1 && height >= 1 && width <= STICKER_MAX_SIDE && height <= STICKER_MAX_SIDE)) throw new Error('A sticker can be at most 512 pixels on its longest side.');
    const path = `${userId}/${newId()}.png`;
    const up = await bucket().upload(path, blob, { contentType: 'image/png', upsert: false });
    if (up.error) throw fail(up.error);
    const { data, error } = await sb.rpc('sticker_save', { p_path: path, p_name: cleanStickerName(name) || 'Sticker', p_width: width, p_height: height, p_bytes: blob.size });
    if (error) { await bucket().remove([path]).catch(() => {}); throw fail(error); }
    put(data); emit();
    return data;
  }

  // Save a copy of someone else's sticker on Collected. `sourcePath` is where the original lives in the bucket.
  async function collect(sourcePath) {
    if (!PATH_RE.test(String(sourcePath || ''))) throw new Error('That is not a sticker.');
    const have = [...state.collected].find((r) => r.source_path === sourcePath);
    if (have) return have;
    const dl = await bucket().download(sourcePath);
    if (dl.error || !dl.data) throw fail(dl.error || { message: 'That sticker is not there any more.' });
    const path = `${userId}/${newId()}.png`;
    const up = await bucket().upload(path, dl.data, { contentType: 'image/png', upsert: false });
    if (up.error) throw fail(up.error);
    const { data, error } = await sb.rpc('sticker_collect', { p_path: path, p_source_path: sourcePath });
    if (error) { await bucket().remove([path]).catch(() => {}); throw fail(error); }
    if (data.path !== path) await bucket().remove([path]).catch(() => {}); // already had it: the first copy stays
    put(data); emit();
    return data;
  }

  async function rename(id, name) {
    const clean = cleanStickerName(name);
    if (!clean) throw new Error('A sticker needs a name.');
    const { error } = await sb.rpc('sticker_rename', { p_id: id, p_name: clean });
    if (error) throw fail(error);
    [...state.made, ...state.collected].forEach((r) => { if (r.id === id) r.name = clean; });
    emit();
  }

  async function setCollectible(id, on) {
    const { error } = await sb.rpc('sticker_set_collectible', { p_id: id, p_on: !!on });
    if (error) throw fail(error);
    state.made.forEach((r) => { if (r.id === id) r.collectible = !!on; });
    emit();
  }

  async function remove(id) {
    const { data, error } = await sb.rpc('sticker_delete', { p_id: id });
    if (error) throw fail(error);
    state.made = state.made.filter((r) => r.id !== id);
    state.collected = state.collected.filter((r) => r.id !== id);
    emit();
    if (data) await bucket().remove([data]).catch(() => {}); // the row is gone either way; a leftover file is harmless
  }

  return { state, load, save, collect, rename, setCollectible, remove, url, onChange };
}
