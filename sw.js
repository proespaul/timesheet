/* PCW/PRO Timesheet — service worker.
 * App-shell caching so the PWA opens offline and is installable. We deliberately do NOT cache
 * API (Apps Script /exec) responses — offline writes are queued in IndexedDB by the app itself.
 *
 * Strategy: CACHE-FIRST with background revalidation (stale-while-revalidate). Network-first
 * cost every single open 1.5–3s waiting on GH Pages over rural LTE even though the shell was
 * already cached. Now the app paints instantly from cache and the fetch that runs in the
 * background updates the cache, so a fresh deploy lands on the SECOND open after it ships.
 *
 * v43 — BACKGROUND SYNC. The app registers a 'flush-punches' sync whenever a punch is left
 * waiting on the phone. The browser then fires the 'sync' event below the next time the phone
 * has a connection — app closed, screen off, phone in a pocket — and this worker sends the
 * queue itself (it reads the same IndexedDB the app writes). If the app is open and visible it
 * is asked to do the sending instead, so the two never race. No answer from the office → the
 * handler throws and the browser retries the sync later with backoff. Chrome/Android only:
 * Safari has no Background Sync, so on an iPhone the queue still goes on the next open.
 */
const CACHE = 'pcw-pro-timesheet-v74'; // v74: the PROJECT NAME now travels with the job everywhere you pick one. The contact or company name leads the row and the PO number and project name sit underneath it together - clocking in, adding time by hand, swapping the job on the clock-out review, and down the Jobs tab and its detail sheet. A list of ten open POs reading R26191, R26192, R26193 was not something anyone could tell apart from memory. The project name is searchable too, so typing boathouse or fire panel finds the job without remembering its number. Needs Code.gs deployed as well: the project name is read off the PO Log and sent with the job list, and the Jobs tab gets it off that same read rather than a second one. // v73: TWO offline fixes. (1) The app registers THIS worker as the first thing it does. The register call used to sit after the bootstrap call to Apps Script, so on every open the worker was only registered once the office had answered - 4 to 6 seconds warm, much longer cold - and anyone who opened the app, looked at the clock and closed it inside that window registered nothing at all. On the open after a phone's storage had been cleared that is the whole difference between an app that opens with no service and one that shows the browser's offline page: no worker, no cached shell, nothing to open. Paul could not open it offline on 15 Oct, which is what turned this up. Registration needs no session and nothing from the server, and it is no longer awaited either, so the first paint never waits on an sw.js fetch that offline is going to fail anyway. (2) The list of actions given write-ahead protection - saved to the phone BEFORE the network is tried - named two actions that no longer exist (useMaterial, returnMaterial). The live ones are takeMaterial and logMaterials, so the materials typed into the clock-out review were the one thing on that screen with no protection while the hours beside them had it: a phone pocketed mid clock-out kept the hours and silently dropped the parts, which under-bills the job and nobody finds out. Fixed, and because write-ahead makes a repeat possible, those actions now carry a submission id and the script remembers the first one for six hours - otherwise a lost answer would put two sets of parts on one job and take the shelf down twice. Needs Code.gs deployed too. // v72: the app keeps its session token in TWO places now - IndexedDB, because this worker reads it from there to deliver punches while the app is shut, and localStorage, which survives the browser throwing IndexedDB away. Whichever copy lives puts the other one back. Paul was locked out on 13 Oct with 27 days still left on his session server-side: the phone had simply lost the token, so the app had nothing to send and fell back to the Google sign-in screen, which then would not cooperate. The app also asks the browser not to evict it (navigator.storage.persist), the sign-in screen gained a 'Use a different Google account' link - the silent sign-in only fires when the browser has exactly ONE Google account signed in, and with two it gives up without a word - and it now says so when Google's own script never loads instead of showing an empty space where a button should be. In this file: the background half of stale-while-revalidate has never actually worked. resp.clone() was being called one microtask too late, after the response had already been handed to respondWith, which locks the body and makes clone() throw; the error was swallowed. So renaming this cache was the ONLY thing that ever refreshed a phone, which is why a missed version bump left phones on an old app indefinitely instead of for one extra open. Fixed below. // v71: the enquiry reads like an enquiry. 1 - what the customer typed into the website form, word for word, laid out question by question with what they wrote about the job itself given room, plus their photos. 2 - what it comes to: labour, parts, permit and the parts needed, per scenario, under the total. 3 - the whole ball park behind a '📋 See the full ball park' button instead of sitting open on every card, so the Requests tab is a list of customers again. Also fixes five figures that were being read wrong off every live lead: the grand total was picking up 'Total labour' (Barry Toker #48 showed $420 instead of $929.25), and the hours were reading the first '~1.5 hrs' on the block instead of adding up the billed lines (Dawn Lewis #45 showed 1.5 hrs instead of 3.5). Checked against #41, #45, #46, #48 and #49: labour + parts + permit now reconciles to the printed subtotal to the cent on all ten scenarios. // ...earlier notes from v46 through v70 were moved to the build log in Drive to keep this line readable: Code.gs and app version history, the deploy steps, and the rules learned the hard way.
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // cache:'reload' — fetch the shell from the network, not the browser's HTTP cache (GitHub Pages
  // serves index.html with max-age=600, so a phone opened just before a deploy could otherwise
  // cache the OLD page under the NEW version name).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
        // v72 — TAKE THE COPY HERE, NOT LATER.
        // This used to read:
        //     if (resp && resp.ok) caches.open(CACHE).then((c) => c.put(e.request, resp.clone()))
        // and resp.clone() therefore ran one microtask later, inside the caches.open callback. By
        // then `return resp` below had already handed the response to respondWith, which locks the
        // body — and clone() throws on a locked body. The .catch(() => {}) swallowed it, silently,
        // every time. So the background half of "stale-while-revalidate" was not revalidating
        // anything: the only thing that ever refreshed a phone was renaming the cache on the line
        // above, which is why a missed version bump left phones on an old app indefinitely rather
        // than for one extra open. Clone first, hand the response back second.
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => null);
      // Serve the cached copy instantly; fall back to the network (then the shell) when new.
      return cached || net.then((r) => r || caches.match('./index.html'));
    })
  );
});

/* ---------------------------------------------------------------------------------------------
 * Background delivery of queued punches (v43). Same IndexedDB as the app: database
 * 'pcw-timesheet', store 'queue' (items {qid, action, payload, ts, tempId, …}) and store 'cache'
 * ({k, v}: 'session' = {token}, 'apiUrl' = the office's address, 'tempIdMap' = tmp_ id → real id).
 * v72 — the app now ALSO keeps the session in localStorage, which this worker cannot read. That
 * copy exists only because phones throw IndexedDB away; the app puts it back here on its next
 * open, so 'session' below stays the worker's source of truth and needs no change.
 * ------------------------------------------------------------------------------------------ */
const PUNCH = /^(clockIn|clockOut|switchJobSite|startBreak|endBreak)$/;
// The office was busy, not wrong — stop and let the browser retry the whole sync later.
const TRANSIENT = /Lock timeout|acquire lock|Too many requests|Service invoked too many times|busy right now|Rate Limit|temporarily unavailable|timed out|deadline/i;
// A replay of a punch that already landed (the app was killed before it heard the answer).
const DUPLICATE = /Already clocked out|Already on break|Not on break/i;

function idb_() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pcw-timesheet', 1);
    r.onupgradeneeded = () => { // same shape as the app's DB.open, in case the worker gets here first
      const db = r.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'qid' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req_(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
const cacheGet_ = (db, k) => req_(db.transaction('cache', 'readonly').objectStore('cache').get(k)).then((x) => (x ? x.v : null));
const cachePut_ = (db, k, v) => req_(db.transaction('cache', 'readwrite').objectStore('cache').put({ k, v }));
const queueAll_ = (db) => req_(db.transaction('queue', 'readonly').objectStore('queue').getAll()).then((x) => x || []);
const queueGet_ = (db, qid) => req_(db.transaction('queue', 'readonly').objectStore('queue').get(qid));
const queuePut_ = (db, it) => req_(db.transaction('queue', 'readwrite').objectStore('queue').put(it));
const queueDel_ = (db, qid) => req_(db.transaction('queue', 'readwrite').objectStore('queue').delete(qid));

/* Send what is waiting. Returns {deferred} when the app is open and visible — it has its own
 * timers and will send; the worker only steps in when nobody is looking (the app re-registers
 * the sync the moment it goes to the background). Returns {sent, left, stopped} otherwise.
 * Throws on "no answer" so the browser schedules a retry with backoff. opts.force skips the
 * visibility check (tests).
 * The worker must NOT poke a visible app into flushing: register → sync fires at once while
 * online → poke → flush fails on a busy office → app re-registers → … a tight retry storm
 * against the backend. */
async function flushPunches_(opts) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!(opts && opts.force) && wins.some((c) => c.visibilityState === 'visible')) return { deferred: true };
  const db = await idb_();
  const session = await cacheGet_(db, 'session');
  const url = await cacheGet_(db, 'apiUrl');
  if (!session || !session.token || !url) return { sent: 0, left: 0, stopped: 'no session' };
  const idMap = Object.assign({}, (await cacheGet_(db, 'tempIdMap')) || {});
  const items = (await queueAll_(db)).filter((it) => PUNCH.test(it.action)).sort((a, b) => a.ts - b.ts);
  let sent = 0, stopped = null, left = 0;
  for (const it of items) {
    const p = Object.assign({}, it.payload || {}, { queuedAt: it.ts });
    if (typeof p.entryId === 'string' && idMap[p.entryId]) p.entryId = idMap[p.entryId];
    if (typeof p.entryId === 'string' && p.entryId.indexOf('tmp_') === 0) { left++; continue; } // its clock-in has not landed — the app resolves these
    let json;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ sessionToken: session.token, action: it.action, payload: p }) });
      json = await res.json();
    } catch (e) { stopped = 'network'; break; }            // no answer (or an error page): retry the sync later
    if (json && json.ok) {
      if (it.tempId && json.data && json.data.entry && json.data.entry.EntryID) idMap[it.tempId] = json.data.entry.EntryID;
      await queueDel_(db, it.qid); sent++;
      try { await patchBoot_(db, it.action, p, json.data || {}); } catch (e) {}
      continue;
    }
    const msg = String((json && json.error) || '');
    if (/Session expired/i.test(msg)) { stopped = 'auth'; break; }   // only the app can sign in again
    if (TRANSIENT.test(msg)) { stopped = 'transient'; break; }
    if (DUPLICATE.test(msg)) { await queueDel_(db, it.qid); sent++; continue; }
    // A real "no" (or "already have an open entry", which needs the app's judgement): leave it,
    // with the reason, for the app to show. Carry on with the next one.
    const cur = await queueGet_(db, it.qid);
    if (cur) await queuePut_(db, Object.assign({}, cur, { lastError: msg, lastTry: Date.now(), tries: (cur.tries || 0) + 1 }));
    left++;
  }
  if (sent) {
    try { await cachePut_(db, 'tempIdMap', idMap); } catch (e) {}
    wins.forEach((c) => c.postMessage({ type: 'punchesSent', n: sent }));
  }
  if (stopped === 'network' || stopped === 'transient') throw new Error('sync: ' + stopped); // → browser retries with backoff
  return { sent, left, stopped };
}
/* Keep the app's cached snapshot ('bootstrap') in step with what was just sent, so the next
 * open paints the truth at once instead of a running clock for the 4-6 s the re-read takes. */
async function patchBoot_(db, action, p, data) {
  const boot = await cacheGet_(db, 'bootstrap');
  if (!boot) return;
  const open = boot.openEntry;
  if (action === 'clockOut' && open && (open.EntryID === p.entryId)) {
    const closed = Object.assign({}, open, { ClockOut: p.at || new Date().toISOString(), Source: p.paused ? 'paused' : 'live' });
    if (data.hours != null) { closed.Hours = data.hours; closed['Gross Hours'] = data.gross; closed['Break Hrs'] = data.breakHrs; }
    boot.entries = (boot.entries || []).filter((e) => e && e.EntryID !== open.EntryID).concat([closed]);
    boot.openEntry = null;
  } else if ((action === 'clockIn' || action === 'switchJobSite') && data.entry) {
    if (action === 'switchJobSite' && open && open.EntryID !== data.entry.EntryID) {
      boot.entries = (boot.entries || []).filter((e) => e && e.EntryID !== open.EntryID)
        .concat([Object.assign({}, open, { ClockOut: p.at || data.entry.ClockIn, Source: 'paused' })]);
    }
    boot.openEntry = data.entry;
  } else return;
  await cachePut_(db, 'bootstrap', boot);
}
self.flushPunches_ = flushPunches_; // reachable from tests
self.syncCount_ = 0;                 // how many times the browser has fired the sync (tests)

self.addEventListener('sync', (e) => {
  if (e.tag !== 'flush-punches') return;
  self.syncCount_++;
  e.waitUntil(flushPunches_());
});
