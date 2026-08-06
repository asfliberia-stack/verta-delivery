// sw.js — minimal service worker, just enough to satisfy PWA
// installability criteria (a registered SW with a fetch handler) and
// give a usable app shell if the network briefly drops. This is NOT a
// full offline-first architecture — API calls always go to the network
// first, since this app's data changes in real time and stale cached
// data would be actively misleading (an old order list, wrong stock
// counts, etc).
// Bumped v1 -> v2: forces every previously-installed service worker to
// drop its old cached copy of index.html/app-shell on next activate
// (see the activate handler below, which deletes any cache whose name
// isn't CACHE_NAME) — otherwise a browser that installed this SW
// before a given deploy could keep serving that stale shell from the
// Cache Storage fallback indefinitely. Bump this again on any future
// deploy where a stale client-side cache could hide a real fix.
const CACHE_NAME = 'golib-shell-v2';
const APP_SHELL = ['/', '/manifest.json', '/assets/icon-192.png', '/assets/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or the Socket.io connection — always real,
  // live data.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
