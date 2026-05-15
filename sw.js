// Тенис Лига Велинград — minimal service worker.
// Goal: instant repeat loads + basic offline shell.
// Strategy:
//   /api/*           → network only (server's ETag does its own caching)
//   navigations (HTML) → network-first, fall back to cached index
//   other static     → stale-while-revalidate, exact URL match
//
// CACHE_VERSION is substituted by the server at boot from a hash of all
// shell files. Any change to a shell file → different sw.js bytes → browser
// installs new SW automatically. No manual counter to forget.
const CACHE_VERSION = '__CACHE_VERSION__';

// Precache only files whose URLs are stable (no ?v=<hash> querystring).
// Versioned files (app.js, styles.css, data.js, alpine.min.js) are fetched
// on first request and cached under their versioned URL — a new deploy
// produces a new URL, which is a guaranteed cache miss.
const SHELL = [
  '/',
  '/index.html',
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

  // Static assets: stale-while-revalidate with exact URL match.
  // Versioned URLs (?v=<hash>) each get their own cache entry; on deploy
  // the new hash → cache miss → guaranteed fresh fetch. Old versioned
  // entries become orphaned and are purged when CACHE_VERSION changes
  // (every deploy that touches a shell file).
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then(r => {
        if (r && r.status === 200) cache.put(req, r.clone());
        return r;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// ===== Web Push =====
//
// Server sends JSON payload via web-push. We render it as an OS notification.
// `tag` per match key collapses repeated notifications for the same match,
// so the user sees the latest state instead of a stack of stale ones.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Тенис Лига', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Тенис Лига Велинград';
  const options = {
    body: data.body || '',
    icon: '/apple-touch-icon.png',
    badge: '/favicon.svg',
    tag: data.key ? 'match:' + data.key : 'tennis',
    renotify: true,
    data: { url: '/', key: data.key || null, type: data.type || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Click → focus an existing tab if open, else open a new one. Cheap UX win:
// users with the site already open don't get a duplicate tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try {
          await client.focus();
          if ('navigate' in client && new URL(client.url).pathname !== targetUrl) {
            await client.navigate(targetUrl);
          }
          return;
        } catch (e) { /* try next */ }
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
