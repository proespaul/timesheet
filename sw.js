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
const CACHE = 'pcw-pro-timesheet-v71'; // v71: the enquiry reads like an enquiry. 1 - what the customer typed into the website form, word for word, laid out question by question with what they wrote about the job itself given room, plus their photos. 2 - what it comes to: labour, parts, permit and the parts needed, per scenario, under the total. 3 - the whole ball park behind a '📋 See the full ball park' button instead of sitting open on every card, so the Requests tab is a list of customers again. Also fixes five figures that were being read wrong off every live lead: the grand total was picking up 'Total labour' (Barry Toker #48 showed $420 instead of $929.25), and the hours were reading the first '~1.5 hrs' on the block instead of adding up the billed lines (Dawn Lewis #45 showed 1.5 hrs instead of 3.5). Checked against #41, #45, #46, #48 and #49: labour + parts + permit now reconciles to the printed subtotal to the cent on all ten scenarios. // v70: 📨 The enquiry now opens in three layers - what the CUSTOMER actually sent (fetched from the original form email, plus their photos), then the ball park as numbers (each scenario with its total, the hours, and the open question), then the whole block as filed. Their own words were never stored, only Claude's write-up of them, and the two can mean very different jobs. // v69: choosing 📧 Email now shows the letter first, with a suggested sentence you can rewrite and the finished email underneath it, before anything is sent. Only the message is editable - the time, address and the Yes/Reschedule/Cancel buttons are built by the script, and their one-off tokens are minted at the moment of sending so a preview never hands one out. // v68: after any change to a booking the app asks whether to tell the customer - 📞 call them (the phone dials, the app records it), 📧 email them, or nothing for now - instead of a tick-box you had to notice beforehand, and it says when an email already went so nobody sends two. Moving a BOOKED job can now take an occupied slot: the job in the way goes back to Requests under '⚡ Needs a new time', which until now only the day picker could do. // v67: one ✏️ Modify button on any booking instead of a scatter of them, with the same list whatever created the booking: Date & time · Customer & job details (name, phone, email, address, scope, materials, hours, quoted range - through to the PO Log) · What it is, appointment or estimate · The original enquiry · Cancel. Each entry says what it will and will not touch, and a return visit can now be corrected at all - its details belong to the job it continues. // v66: tapping a booking is given 75 s instead of 30 before it gives up (the Google script can be slow to wake), the timeout message no longer blames your signal, and a booked job opened from the calendar now fetches the Requests list if this session has not loaded it, so its Move / Cancel / Correct buttons appear. // v65: a quoted estimate can be worked on like a booked job - 📅 Move the call (asks for the CALL length, 15/30/60/120, instead of blocking out the whole estimated job) and ✏️ Change the details, which now also carries the job hours and the quoted price range. // v64: tapping a job on the Schedule tab now asks the office what it is, so a RETURN VISIT works too - it shows the customer, the phone number and a 📨 See the original enquiry button that opens the customer's own words and photos instead of an unclickable Gmail link, and it can be moved or called off. Calling off a return visit does NOT cancel the job: the PO stays open and still gets invoiced under the same number. Calendar notes are collapsed and their links are clickable. // v63: ✏️ Change the details added to a job opened from the Schedule tab, alongside Move it and Cancel job - and the action behind that button now exists server-side, which it never did. // v62: tapping a job on the Schedule tab now opens 📅 Move it and Cancel job, the customer's phone number, and 📨 the original website enquiry with its photos - until now those actions existed only on the Requests tab under 'Booked jobs', which is not where you look when you have just booked the wrong day. ⚡ Add a job and 📞 Schedule a call are on the Schedule tab too. A booking with no job behind it (a return visit, or one added straight to Google Calendar) says so instead of showing buttons that cannot work. // v61: the 'More' button no longer carries a red dot. It was showing the Requests count - left over from when Requests lived inside that menu - so More pointed at a tab sitting right beside it and the menu itself had nothing marked. Nothing in More is badged, so it no longer claims to be. // v60: SPEED. The Requests tab now paints from what the phone already has and refreshes behind it, the way the Jobs, Materials and Customers tabs already did - it was the one screen with no cache, so every visit sat on a spinner for a whole round trip. The onboarding checklist was also the one loader with no freshness check and refetched on every single app open; it now follows the same 10-minute rule as the rest. // v59: the time picker opens on a FULL MONTH - a dot on every day that has a job, weekends, stat holidays and days off shaded - and tapping a day shows that day's bookings and the start-time field. ‹ › move the month; the day screen keeps its own ‹ › and a '‹ The whole month' button. Also: --good was used in seven places and never defined, so every '✓ that is fine' line had been rendering in the ordinary text colour instead of green. // v58: Requests tab — ⚡ Add a job and 📞 Schedule a call put an emergency or a walk-in straight on the calendar, with a day view of what is already there (tap any booking for its details) and a start time that accepts anything: after hours, today, a weekend, or a slot that already has a job in it. A job booked over comes OFF the calendar and waits under '⚡ Needs a new time' at the top of Requests — job number, customer and scope intact — where Paul rings or emails them and then picks a time or takes the next opening; if that time is taken too, that job comes back the same way, one step at a time. A manually added job gets the next job number and a full PO Log row; a phone call does not. Rebooking never changes a job number. // v57: on the Jobs tab a job now has three buttons - Build Initial Draft, Build Final Draft, and Job details, which opens ONE page carrying the day-by-day hours, the materials and supplier POs, and the job photos, each clearly headed. The three sections load together and one that fails says so without holding up the other two. // v56: Requests tab opens with 'Needs your OK' — hours, time off and allowances to approve/deny/edit in one place; admins can add or change any employee's hours (Add time 'For' picker, or 'Add or change someone's hours'). // v55: Build Initial Draft first shows the job's PO parts with editable quantities (saved list is what Claude bills); PRO / PCW / GNG no longer listed on the Jobs tab; Jobs removed from the More menu. // v54: on the Jobs tab the internal company rows (PRO, PCW...) always sit at the top. // v53: Build Initial Draft waits up to 90 s (the script now also starts Claude) and a slow answer says 'probably sent' instead of an error. // v52: Estimate calls pick 15 min / 30 min / 1 h / 2 h and the Schedule sheet shows real open times (a time that does not fit moves to the next open one). Return visit at any day + time - jobs already there move to the same time next work day, shown as a plan to confirm; moved customers go on a Call these customers list with call + reschedule. Receipt camera asks for the full 4:3 sensor frame and offers the phone's own camera (0.5x wide lens). Clock-out materials carry their SKU so they come off the shelf. Build Initial Draft starts Claude straight away. // v51: Invoicing in two steps - Build Initial Draft (every part at cost, no markup, for Paul to correct in QuickBooks) and Build Final Draft (reads the corrections back, rolls the parts up, applies the markup to the same invoice). Return visits on the clock-out review. Customer form photos on the Requests cards and job details. // v50: Clock-out review books the return visit when a job is not finished - the app reads Paul's calendar and offers the openings that fit, and the booking carries the original event's colour, name and notes. Requests show the customer's form photos on the card and at the top of the job details. // v50: Cancel job emails the customer by default (box starts ticked). v48: Cancel job checks whether the cancel landed when the phone got no answer, instead of staying stuck on the confirm screen. v47: tap any request / quoted estimate / booked job for its details, with ✏️ Correct details (synced to calendar + PO Log); a booked job that was never asked gets a 📧 Email customer button; booked jobs show ⚫ Customer cancelled when the customer taps Cancel in the confirmation email. v46: Requests — Estimate/Appointment switch on the Schedule sheet (decides PO Log vs Estimate tab); an Estimate blocks a 30-min call, not the full job; quoted estimates stay listed so "they said yes" books the job and burns the PO; booked jobs email the customer a yes/no confirmation and show 🟠🟢🔴, and Move it re-asks them. Monthly estimate audit: AI vs booked vs clocked man-hours, with a calibration the ball-park reads; two-man crew default; entry number leads the customer name; estimate detail rendered as readable prose with photo thumbnails; scheduling given a longer timeout; Cancel job frees the calendar and marks the PO Log Cancelled. v45: "Add time" — manual entries get the job/PO picker + materials, a Hours field that computes the end time, a date range for backdating several days, an Add-time button on the Clock screen, and an admin's own entries land approved. v44: scan a receipt from the Review screen and its lines fill Materials used; Take a photo vs From album; wide-lens toggle; an AI hiccup queues the photo instead of losing it. v43: clock-out time is the Submit tap; punches sent in the background (Background Sync + keepalive); waiting punches show their age, a day-old one is reported to the office
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
        if (resp && resp.ok) caches.open(CACHE).then((c) => c.put(e.request, resp.clone())).catch(() => {});
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
