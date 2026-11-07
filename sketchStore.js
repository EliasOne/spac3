// SKETCHPAD storage. The drawing (every layer as a PNG) is kept in this
// browser's IndexedDB so it comes back next visit; small preferences (brush,
// colour, ...) live in localStorage. Everything is wrapped so private mode or
// a full disk just means "not remembered" -- drawing still works.
const DB_NAME = 'spac3-sketch';
const STORE = 'docs';
const DOC_KEY = 'doc-v2';
// Saved sketches (the "My sketches" gallery): every sketch is one entry
// `sketch-<id>` (same shape as the working doc) and `sketch-index` lists their
// names / thumbnails so the gallery opens fast without loading any pictures.
const INDEX_KEY = 'sketch-index';
const entryKey = (id) => `sketch-${id}`;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDoc(doc) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(doc, DOC_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch { return false; }
}

export async function loadDoc() {
  try {
    const db = await openDb();
    const doc = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(DOC_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return doc;
  } catch { return null; }
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function listSketches() {
  try {
    const db = await openDb();
    const idx = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(INDEX_KEY));
    db.close();
    return (Array.isArray(idx) ? idx : []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  } catch { return []; }
}

// meta: { id, name, created, updated, thumb, layers }   doc: the sketch itself
export async function putSketch(meta, doc) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const idx = await reqP(st.get(INDEX_KEY));
    const list = Array.isArray(idx) ? idx.filter((m) => m.id !== meta.id) : [];
    list.push(meta);
    st.put(doc, entryKey(meta.id));
    st.put(list, INDEX_KEY);
    await txDone(tx);
    db.close();
    return true;
  } catch { return false; }
}

export async function getSketch(id) {
  try {
    const db = await openDb();
    const doc = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(entryKey(id)));
    db.close();
    return doc || null;
  } catch { return null; }
}

export async function deleteSketch(id) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const idx = await reqP(st.get(INDEX_KEY));
    st.delete(entryKey(id));
    st.put((Array.isArray(idx) ? idx : []).filter((m) => m.id !== id), INDEX_KEY);
    await txDone(tx);
    db.close();
    return true;
  } catch { return false; }
}

// change a few fields of one index row (rename) without touching the picture
export async function patchSketchMeta(id, patch) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const idx = await reqP(st.get(INDEX_KEY));
    const list = (Array.isArray(idx) ? idx : []).map((m) => (m.id === id ? { ...m, ...patch } : m));
    st.put(list, INDEX_KEY);
    await txDone(tx);
    db.close();
    return true;
  } catch { return false; }
}

const PREFS_KEY = 'spac3.sketch.prefs.v2';
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {}; } catch { return {}; }
}
export function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// ---- "Send to chat" waiting room. A drawing sent while offline (or on a
// connection too bad to upload) is kept here -- picture and all -- and posted
// the next time you are online inside that room. One list under one key.
const OUTBOX_KEY = 'send-outbox';
export async function listOutbox() {
  try {
    const db = await openDb();
    const v = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(OUTBOX_KEY));
    db.close();
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
async function editOutbox(fn) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const cur = await reqP(st.get(OUTBOX_KEY));
    st.put(fn(Array.isArray(cur) ? cur : []), OUTBOX_KEY);
    await txDone(tx);
    db.close();
    return true;
  } catch { return false; }
}
// item: { id, roomId, roomName, blob, at }
export const addOutbox = (item) => editOutbox((l) => [...l, item]);
export const removeOutbox = (id) => editOutbox((l) => l.filter((x) => x.id !== id));
