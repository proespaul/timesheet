/* PCW/PRO Timesheet — service worker.
 * App-shell caching so the PWA opens offline and is installable. We deliberately do NOT cache
 * API (Apps Script /exec) responses — offline writes are queued in IndexedDB by the app itself.
 *
 * Strategy: CACHE-FIRST with background revalidation (stale-while-revalidate). Network-first
 * cost every single open 1.5–3s waiting on GH Pages over rural LTE even though the shell was
 * already cached. Now the app paints instantly from cache and the fetch that runs in the
 * background updates the cache, so a fresh deploy lands on the SECOND open after it ships.
 */
const CACHE = 'pcw-pro-timesheet-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept API calls or Google auth — always hit the network.
  if (e.request.method !== 'GET' || url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com') || url.hostname.includes('accounts.google.com') ||
      url.hostname.includes('googleapis.com')) {
    return; // let the browser handle it
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request).then((resp) => {
        if (resp && resp.ok) caches.open(CACHE).then((c) => c.put(e.request, resp.clone())).catch(() => {});
        return resp;
      }).catch(() => null);
      // Serve the cached copy instantly; fall back to the network (then the shell) when new.
      return cached || net.then((r) => r || caches.match('./index.html'));
    })
  );
});
