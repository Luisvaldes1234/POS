// Service worker del POS Mostrador (módulo retail independiente).
//   1) Pre-cache del shell + CDNs comunes
//   2) Cache-first para assets estáticos (CDNs, fuentes)
//   3) Network-first para el shell HTML (deploys urgentes)
//   4) Network-only para Supabase (REST + RPC)
//
// El POS está en mostrador con WiFi estable, pero igual cacheamos el
// shell para tolerar cortes de red/luz.

const CACHE_VERSION = 'pos-retail-v5-2026-06-30';

const PRECACHE = [
  './',
  './index.html',
  './app.html',
  './login.html',
  './signup.html',
  './manifest.webmanifest',
  './icon.svg',
  './js/config.js',
  './js/shared/dialogs.js',
  './js/shared/errors.js',
  './js/sentry-init.js',
];

const CDN_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'api.mapbox.com',
]);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(
      PRECACHE.map((url) =>
        cache.add(url).catch((e) => console.warn('[sw-pos] precache miss', url, e))
      )
    );
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.postMessage({ type: 'sw-updated', version: CACHE_VERSION });
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase: network-only (la cache key no incluye Authorization).
  if (url.hostname.endsWith('.supabase.co')) return;

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin === self.location.origin) {
    // Todo lo propio (HTML, JS, CSS, manifest) va network-first: así un deploy
    // nuevo se ve en la próxima carga y no queda código viejo en caché. La
    // caché queda solo como respaldo offline.
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const clone = res.clone();
    caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
  }
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw e;
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
