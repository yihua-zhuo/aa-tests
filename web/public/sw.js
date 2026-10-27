/* Service worker: app-shell cache, offline fallback and web push display. */
const VERSION = 'pulse-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const shell = (await caches.match('/index.html')) ?? (await caches.match('/'));
    return shell ?? (await caches.match('/offline.html'));
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(ASSET_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API responses and signed files stay network-only; the app stores its own
  // read-only snapshots in localStorage so they never outlive a logout.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js') {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Pulse 通知', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Pulse 通知';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: payload.icon || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.tag || undefined,
      data: { link: payload.link || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = new URL(link, self.location.origin);
      for (const client of windows) {
        if (new URL(client.url).origin !== target.origin) continue;
        if ('focus' in client) await client.focus();
        if ('navigate' in client) await client.navigate(target.href).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
