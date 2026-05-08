// Тенис Лига Велинград — minimal service worker.
// Goal: instant repeat loads + basic offline shell.
// Strategy:
//   /api/*           → network only (server's ETag does its own caching)
//   navigations (HTML) → network-first, fall back to cached index
//   other static     → stale-while-revalidate
//
// Bump CACHE_VERSION whenever shell assets change to force a refresh.
const CACHE_VERSION = 'tennis-v7';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/data.js',
  '/alpine.min.js',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Tolerant: if a single file 404s, don't fail the entire install.
    // The missing file will be fetched live (and possibly cached) on demand.
    await Promise.all(SHELL.map(url =>
      cache.add(url).catch(e => console.warn('[sw] precache miss', url, e && e.message))
    ));
    return self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: never cache. The server already returns 304s via ETag.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE_VERSION).then(c => c.put('/index.html', copy));
        return r;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  // ignoreSearch: server appends ?v=<hash> to asset URLs in HTML for HTTP
  // cache busting. We want SW cache to hit regardless of query string,
  // since the server returns the same bytes for every version of the URL.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then(r => {
        if (r && r.status === 200) cache.put(req, r.clone());
        return r;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
