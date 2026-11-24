const V = 'va-shell-v1', TILES = 'va-tiles-v1', MAX_TILES = 6000;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/images/layers.png', 'vendor/images/layers-2x.png',
  'vendor/images/marker-icon.png', 'vendor/images/marker-icon-2x.png', 'vendor/images/marker-shadow.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
let puts = 0;
async function trim() {
  const c = await caches.open(TILES), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.hostname === 'tile.openstreetmap.org' || u.hostname === 'server.arcgisonline.com') {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { c.put(req, res.clone()); if (++puts % 200 === 0) trim(); }
      return res;
    }));
    return;
  }
  if (u.origin === location.origin) {
    // stale-while-revalidate: мигновено старт, обновяване във фон
    e.respondWith(caches.open(V).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
