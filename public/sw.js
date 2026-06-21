const CACHE_NAME = 'parrobyte-crm-v1';

// Only cache SAME-ORIGIN assets — external CDNs are blocked by CSP
const STATIC_ASSETS = [
  '/',
  '/dashboard',
  '/login',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).catch(() => {})
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch: only handle same-origin requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip external URLs (CDNs, etc.) — CSP blocks them
  if (url.origin !== self.location.origin) return;

  // Skip API calls — always go to network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) {
    return;
  }

  // Skip Chrome extensions
  if (url.protocol === 'chrome-extension:') return;

  // Cache-first for static assets (CSS, JS, fonts, images)
  if (
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font' ||
    request.destination === 'image' ||
    url.pathname.match(/\.(css|js|png|jpg|jpeg|svg|woff|woff2)$/)
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        return cached || fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
          return response;
        });
      })
    );
    return;
  }

  // Network-first for HTML pages
  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request))
  );
});
