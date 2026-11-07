// sw.js -- makes the app work with a bad or missing connection.
// Same-site files (pages, scripts, styles, pictures) are fetched from the network
// first, but only given a few seconds: if the connection is down or too slow the
// copy saved on this device is used instead, so the Sketchpad (and the pages
// around it) open with no lag and no connection. Every good answer from the
// network refreshes the saved copy, so updates still arrive. Things from other
// sites (the database, maps, video) are never touched.
const CACHE = 'spac3-offline-v147';
const WAIT_MS = 3500;
const PRECACHE = [
  'sketch.html', 'manifest.webmanifest', 'sketch-icon-192.png', 'sketch-icon-512.png',
  'shared.css', 'sketch.css', 'sketch-page.css', 'siteHeader.css', 'style.css', 'toast.js', 'floatBox.js', 'snapSwitch.js',
  'sketchpad.js', 'sketchMargin.js', 'sketchCore.js', 'sketchTools.js', 'sketchBrushes.js', 'sketchUtil.js',
  'sketchStore.js', 'sketchBarCustom.js', 'sketchUI.js', 'sketchConst.js', 'barReorder.js', 'dialog.js', 'stickerCut.js', 'stickersCore.js',
  'index.html', 'room.html', 'room.css', 'room.app.js', 'globe-orb.svg', // (only what the pages really load -- the separate source copies of the room code are bundled into room.app.js and were being downloaded for nothing)
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // one by one, so a missing file never stops the rest from being saved
    await Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('spac3-offline-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = () => cache.match(req, { ignoreSearch: true });
    const fromNet = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    });
    try {
      // network first, but not for long
      return await Promise.race([
        fromNet,
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), WAIT_MS)),
      ]);
    } catch {
      const hit = await saved();
      if (hit) { fromNet.catch(() => {}); return hit; }
      try { return await fromNet; } catch { /* nothing saved and no network */ }
      if (req.mode === 'navigate') {
        const page = await cache.match('sketch.html');
        if (page) return page;
      }
      return new Response('Offline, and this file was not saved yet. Open it once while online.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
