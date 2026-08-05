// BOOS Self-destruct Service Worker — cleans stale caches then unregisters.
// The old SW cached stale HTML/CSS/JS causing blank pages after code changes.
// This SW: delete all caches → unregister self → network-only from then on.
self.addEventListener('install', () => {
  self.skipWaiting(); // activate immediately, don't wait for tabs to close
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => {
      console.log('[boos sw] all caches purged, unregistering...');
      return self.registration.unregister();
    })
  );
  self.clients.claim();
});

// Pass-through: never cache, always network.
self.addEventListener('fetch', (event) => {
  // Let all requests go directly to network.
  // Don't call event.respondWith() → browser handles normally.
});
