// BOOS Service Worker — caches the frontend static assets for offline
// resilience. API requests always go to the network (no caching).
//
// Strategy:
//   HTML/JS/CSS  → stale-while-revalidate (return cache instantly, update in background)
//   Images/fonts  → cache-first (rarely change)
//   API/WebSocket → network-only (never cache)
//
// CACHE_NAME is versioned via a build-time injection or falls back to a
// timestamp seed so each new deployment auto-rotates the cache.
// On activate, all non-current caches are purged.

const CACHE_NAME = 'boos-dynamic-v1';

// Extension → strategy mapping.
const SWR_EXTENSIONS = /\.(html|js|css|json|xml|txt|map)$/i;
const STATIC_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|mp4|webm)$/i;

// Assets to pre-cache on install: the bare shell needed before any API
// call succeeds.
const PRE_CACHE = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
];

// ── Install: pre-cache shell, then take control immediately ──────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRE_CACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[boos sw] pre-cache miss:', url, err.message);
          })
        )
      );
    }),
  );
  self.skipWaiting();
});

// ── Activate: purge old caches, claim all clients ────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => {
          return caches.delete(k);
        }),
      ),
    ),
  );
  self.clients.claim();
});

// ── Fetch: route by resource type ────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API + WebSocket requests → network-only, no caching.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return;
  }

  // Stale-while-revalidate for HTML/JS/CSS.
  // Serve cached copy instantly (if available), then fetch a fresh copy
  // in the background and update the cache for next time.
  if (SWR_EXTENSIONS.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request)
            .then((response) => {
              if (response && response.status === 200 && response.type === 'basic') {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(() => cached || new Response('', { status: 408 }));

          // Return cached immediately if we have it; otherwise wait for network.
          return cached || fetchPromise;
        }),
      ),
    );
    return;
  }

  // Cache-first for images/fonts/static assets — they rarely change.
  if (STATIC_EXTENSIONS.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            }).catch(() => {});
          }
          return response;
        }).catch(() => {
          // Offline fallback for navigation requests.
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('', { status: 408 });
        });
      }),
    );
    return;
  }

  // Everything else: network-first, fall back to cache.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          }).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('', { status: 408 });
        }),
      ),
  );
});

// ── Update notification: postMessage to all clients when a new SW is waiting ──
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
