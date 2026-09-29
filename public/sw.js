const CACHE_NAME = 'family-hq-v2';

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/icon-192.png',
        '/icon-512.png',
        '/icon.svg',
        '/apple-touch-icon.png',
      ]);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first strategy (try network, fall back to cache)
// This ensures fresh data from Firebase while still working offline
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests and Firebase/API calls
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.hostname.includes('firestore') || url.hostname.includes('googleapis')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request);
      })
  );
});

// ------------------------------------------------------------
// Evening reminders (sent by /api/remind)
// ------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'Family HQ', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Family HQ', {
    body: data.body || '',
    icon: '/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
  }));
});

// Tapping a reminder opens the app on that kid's card (/?kid=Name),
// reusing an open Family HQ window if there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of windows) {
      if (win.url.startsWith(self.location.origin)) {
        await win.focus();
        return win.navigate ? win.navigate(url) : undefined;
      }
    }
    return self.clients.openWindow(url);
  })());
});
