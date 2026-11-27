// Guess My Fridge — cache hors ligne de l'app (les données restent dans IndexedDB)
const CACHE = 'gmf-v1.1.0';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'jsqr.js', 'barcode-detector.js', 'zxing_reader.wasm',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;   // Open Food Facts : toujours en direct
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
