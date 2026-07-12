/* PCW/PRO Timesheet — service worker.
 * App-shell caching so the PWA opens offline and is installable. We deliberately do NOT cache
 * API (Apps Script /exec) responses — offline writes are queued in IndexedDB by the app itself.
 *
 * Strategy: network-first with a 3s race — fresh deploys reach phones immediately, but a flaky
 * rural connection falls back to the cached shell after 3s instead of hanging to a full timeout.
 */
const CACHE = 'pcw-pro-timesheet-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest'];
const NET_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw-timeout')), ms);
    fetch(req).then((resp) => { clearTimeout(t); resolve(resp); }, (err) => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept API calls or Google auth — always hit the network.
  if (e.request.method !== 'GET' || url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com') || url.hostname.includes('accounts.google.com') ||
      url.hostname.includes('googleapis.com')) {
    return; // let the browser handle it
  }
  e.respondWith(
    fetchWithTimeout(e.request, NET_TIMEOUT_MS).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() =>
      caches.match(e.request).then((cached) => cached || caches.match('./index.html'))
    )
  );
});
