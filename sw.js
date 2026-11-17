// Keeps the app itself available offline. Documents are stored separately,
// by app.js, in their own cache that survives app updates.

const VERSION = 'cef73c4315c5';
const SHELL = `gdoc-shell-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const list = await (await fetch('precache.json', { cache: 'no-store' })).json();
      const cache = await caches.open(SHELL);
      await cache.addAll(list.core.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  // Kept short on purpose: the browser holds back every request from the
  // page until this finishes.
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('gdoc-shell-') && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// The page asks for the optional files once it is up and running. Best
// effort: anything missed is fetched, and kept, the first time it is needed.
self.addEventListener('message', (event) => {
  if (event.data !== 'store-extras') return;
  event.waitUntil(
    (async () => {
      try {
        const list = await (await fetch('precache.json', { cache: 'no-store' })).json();
        const cache = await caches.open(SHELL);
        for (const url of list.extra) {
          if (!(await cache.match(url))) await cache.add(url).catch(() => {});
        }
      } catch {
        // Offline right now.
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return; // Supabase and Google go straight to the network.
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      // Any page load is the app, including the return from Google sign-in
      // with its ?code=... query.
      const cached =
        request.mode === 'navigate' ? await cache.match('index.html') : await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && request.mode !== 'navigate') cache.put(request, response.clone());
      return response;
    })(),
  );
});
