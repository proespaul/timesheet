/**************************************************************************************************
 * PCW / PRO Timesheet — Google Apps Script backend
 * ------------------------------------------------------------------------------------------------
 * STANDING FACT — ALBERTA NO LONGER CHANGES ITS CLOCKS. The province made daylight time
 * permanent in 2026, so it sits at UTC-6 all year and there is no spring or autumn shift to
 * allow for. Two consequences for this file, and for anyone reading it later:
 *   - Never print a zone name or offset next to a time. Since 1 November 2026 the zone database
 *     calls Alberta's permanent -6 "CST", so anything that prints the abbreviation now says
 *     Central Standard Time in Peace River, which is worse than useless. The day and the time
 *     are all anybody here needs. Session.getScriptTimeZone() / America/Edmonton still give the
 *     right INSTANT - it is only the label that is now misleading.
 *   - Nothing in here hardcodes -6 or -7, and nothing should start. Keep using the zone.
 * ------------------------------------------------------------------------------------------------
 * Runs as a Web App ("Execute as: Me", "Who has access: Anyone"). The single-file PWA frontend
 * (index.html) calls this over fetch() using Content-Type: text/plain (to dodge CORS preflight),
 * sending { idToken, action, payload }. This backend:
 *   - verifies the Google ID token server-side (so roles/permissions can't be spoofed client-side)
 *   - owns the master spreadsheet, the PO tracking sheet, and the master Drive folder
 *   - enforces roles + a per-person permission checklist
 *   - assigns the next PO number atomically (LockService)
 *
 * FIRST-TIME SETUP:
 *   1. Fill in the CONFIG block below (or use Project Settings > Script Properties for secrets).
 *   2. Run initializeSpreadsheet() once from the editor to build all tabs.
 *   3. Deploy > New deployment > Web app. Copy the /exec URL into index.html CONFIG.APPS_SCRIPT_URL.
 * See SETUP.md for the full walkthrough.
 **************************************************************************************************/

// ================================ CONFIG — FILL THESE IN =======================================
const CONFIG = {
  // OAuth 2.0 Web Client ID (same one used in index.html). Used to verify ID tokens.
  GOOGLE_CLIENT_ID: '378684710856-ptq2bpavssjjii856ufbuu03uef97ivr.apps.googleusercontent.com',

  // The spreadsheet this app owns (one tab per employee + summaries). If blank, initializeSpreadsheet()
  // creates a new one and logs its ID — paste it back here.
  MASTER_SPREADSHEET_ID: '1iJCb-71UVbbBUYpEtH7wnfB68tF0r22RkVm0jqOPJBE',

  // Your EXISTING PO tracking spreadsheet ("PO Log" tab). Columns:
  //   A PO Number | B Contact | C Company Name | D Start Date | E End Date | F Type
  //   G Email | H Phone | I Job Address | J Description | K Status
  PO_SPREADSHEET_ID: '1pSfLkYYJItxYx5CBdBGvfUfRYo9lJFCK9gJ-jhgApA8',
  PO_SHEET_NAME: 'PO Log',
  // The Estimate tab of the same workbook. Matched loosely (see poTab_) because the live tab
  // has been called 'Estimate', 'Estimates' and 'ProES - Estimate' at different times.
  PO_ESTIMATE_SHEET_NAME: 'Estimate',
  PO_NUMBER_COL: 1,        // A = PO Number
  PO_CONTACT_COL: 2,       // B = Contact person
  PO_CUSTOMER_COL: 3,      // C = Company Name (this is the customer/job-site name)
  // Column layout per Charles's Sept 2026 redesign of the PO Log:
  // A PO | B Contact | C Company | D Project Name | E Start | F End | G QB PO# | H Type
  // I Email | J Phone | K Job Address | L Description | M Status
  PO_PROJECT_COL: 4,       // D = Project Name / Work Place
  PO_STARTDATE_COL: 5,     // E = Start Date
  PO_ENDDATE_COL: 6,       // F = End Date
  PO_QB_COL: 7,            // G = PO Number in Quickbooks
  PO_TYPE_COL: 8,          // H = Type (Commercial/Residential/Industrial/Mix)
  PO_EMAIL_COL: 9,         // I = Email Address
  PO_PHONE_COL: 10,        // J = Phone Number
  PO_ADDRESS_COL: 11,      // K = Job Address
  PO_DESC_COL: 12,         // L = Description of Work
  PO_STATUS_COL: 13,       // M = Status
  PO_HEADER_ROWS: 1,       // header rows to skip
  // PO number format: <TypeLetter><YY><sequence>, e.g. C26010 = Commercial, 2026, seq 010.
  // The sequence is one global running counter (zero-padded to PO_SEQ_MIN_DIGITS). To make the
  // sequence reset per calendar year instead, set PO_SEQ_PER_YEAR: true.
  PO_SEQ_MIN_DIGITS: 3,
  PO_SEQ_PER_YEAR: false,
  PO_TYPE_LETTERS: { Commercial: 'C', Residential: 'R', Industrial: 'I', Mix: 'M' },
  PO_DEFAULT_TYPE: 'Commercial',

  // Master Drive folder that all job-site media subfolders nest inside.
  MASTER_DRIVE_FOLDER_ID: '1y1Jkc8dv2hDgpVkXAUR1I2BdHpFR5nF1',

  // Paul's own PO archive ("1. Ongoing Invoice") — one subfolder per job, named by hand and
  // inconsistently: '26156', 'I26156', 'C26011', 'KFC (June)', 'Amanda Wood April'. Older jobs
  // live ONLY here, which is why Fuel Co's materials screen looked empty: the app was searching
  // the master media folder and nowhere else.
  PO_ARCHIVE_FOLDER_ID: '1UdWh9tf4uqvFmqX-q1cgjH5oOUH2caXe',

  // "2. Completed invoices". A job folder moves here once its invoice exists in QuickBooks,
  // into <year>/<N. Month> of the INVOICE date. Month folders are looked up by name at run
  // time, never by a cached id — a renamed or recreated folder would otherwise swallow a job.
  PO_COMPLETED_FOLDER_ID: '1E9I-bzn0cIC73ieVDafCCyaS22hGGLEt',
  // Not job folders, and never a destination or a thing to archive.
  PO_NEVER_ARCHIVE: ['0. Staging (auto-filed invoices)', '1. No PO', 'Tools', 'Paul',
                     '_NEEDS REVIEW', 'Northern Metallic', 'PCW', 'Stock', 'Shop Supplies'],

  // Seed admins/bookkeepers. After first run these live in the Employees tab and can be edited there.
  ADMIN_EMAILS: ['admin@proes.ca', 'cm@proes.ca'],  // Paul, Charles
  BOOKKEEPER_EMAILS: ['jnkrahn@gmail.com'],         // Janelle

  // Internal (non-PO) companies for internal time.
  COMPANIES: ['PRO', 'PCW', 'GNG', 'General'],

  // Pay period + overtime. Built so this is the ONLY place to change period logic later.
  PAY_PERIOD_TYPE: 'SEMI_MONTHLY',   // 'SEMI_MONTHLY' (1–15, 16–end) or 'MONTHLY'
  OT_WEEKLY_THRESHOLD: 44,           // Alberta standard overtime after 44 hrs/week
  FORGOT_CLOCKOUT_HOURS: 12,         // a clock-out that closes a shift longer than this is flagged pending for review
  CLOCKOUT_AHEAD_MIN: 120,           // v67 - how far ahead of the phone's clock a clock-out time may be set. Paul asked
                                     // to be able to round the finish up (5:30 typed at 5:20); it was five minutes, and
                                     // anything over that was silently clamped back to "now". The app refuses past this
                                     // same number (CLOCKOUT_AHEAD_MIN in index.html) - keep the two in step.
  // v31 — the two "something is wrong" emails, both to the employee AND every admin:
  STILL_CLOCKED_IN_EMAIL_HOURS: 24,  // an entry still open this long after its clock-in (forgotten, or the clock-out never arrived)
  STUCK_PUNCH_HOURS: 24,             // a punch that reaches the office this long after it was tapped is reported as LATE;
                                     // the app reports one still stuck on the phone after this long (punchStuck)

  // AI receipt scanning: Gemini API key (Google AI Studio → "Timesheet App" key). Lives only in
  // this server-side script — never sent to or stored in the app itself.
  get GEMINI_API_KEY() { return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || ''; }, // stored in Project Settings > Script Properties
  // Google RETIRES model names. 'gemini-2.0-flash' died and every scan returned HTTP 404 for
  // days without anyone noticing. So we try a list in order and use the first that answers —
  // a retirement now costs a slower first call, not a dead feature. Run testGemini() to see
  // which one is live, and add newer names to the FRONT of this list over time.
  GEMINI_MODELS: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'],

  // Allowances: amounts live in Script Properties (Admin → Allowance settings) so Paul can
  // change them without touching code. These are only the fall-backs on a fresh install.
  MILEAGE_RATE: 0.60,        // $/km — Paul's rate, Sept 2026
  PHONE_ALLOWANCE: 30,       // $/month, posted automatically, no approval needed
  MEAL_CAP: 23,              // CRA reasonable amount per meal

  // Materials Price List spreadsheet (built Sept 2026 from 380 supplier invoices; tabs
  // "Price List" + "Price History"). Supplier-PO scans and the daily email sweep keep it current.
  PRICELIST_SPREADSHEET_ID: '1erIb5pS5gdMb8VdpCRmDH-GgLSQ_CrLkKIQfZxq2xRk',
  // Gmail search fragment matching the suppliers that email POs/invoices/quotes. Add new suppliers here
  // AND in SUPPLIER_DOMAINS below (the search finds the thread; the domain list decides which
  // messages inside it are read — a quote that a rep sends from their own address in a reply
  // thread still matches, a PDF Paul sent back to them does not).
  SUPPLIER_FROM: '{from:eecol.com from:billtrust.com from:bartlegibson.com from:homehardware.ca from:northernmetallic from:barobinson.com}',
  SUPPLIER_DOMAINS: ['eecol.com', 'billtrust.com', 'bartlegibson.com', 'homehardware.ca', 'northernmetallic', 'barobinson.com'],
  SUPPLIER_DONE_LABEL: 'App/POs processed',   // sweep labels handled emails so they run once
  QUOTE_DONE_LABEL: 'App/Quotes processed',   // v29 — quotes get their own label too (left in the inbox, unread)
  // v29 — a document whose date cannot be read plausibly (more than a year old, or in the
  // future) is NOT filed. The sweep labels the thread with this and leaves it in the inbox;
  // scanning it in the app lets you confirm the date by hand.
  SUPPLIER_REVIEW_LABEL: 'App/POs needs review',
  // How each supplier prints a numeric date. Read off real invoices, Sept 2026: EECOL prints
  // 09/10/26 for Sept 10 (month first); Bartle & Gibson prints 11/09/26 for Sept 11 (day first).
  // The AI read both as year-first and filed Sept 2026 purchases under 2009 and 2011. Unknown
  // suppliers fall back to whichever reading lands closest to the day the document arrived.
  SUPPLIER_DATE_FORMAT: { 'EECOL': 'MDY', 'Bartle & Gibson': 'DMY' },
  DATE_MAX_AGE_DAYS: 365,                     // older than this (or in the future) = needs review
  // Where Paul's own PO Classification script has always filed supplier invoices. The sweep
  // archived threads under its OWN label only, which took them out of the inbox before that
  // classifier could see them — so from Sept 9 they stopped being filed and stayed unread.
  // The sweep now finishes the job itself. Parent label only: the Skipped / Needs Review
  // sub-labels stay Paul's to use.
  SUPPLIER_FILED_LABEL: '3. Bills - Invoices',

  // Shared key for the ball-park sequence to file website leads (it has no browser session).
  // It can only reach 'requestAdd' — see doPost. Change it here and in the skill together.
  INBOUND_KEY: 'proes-ballpark-9f42c7a1',

  // v87 - Charles's MANUAL hour sheets, one per person, kept as a backup. READ ONLY: the Today screen
  // compares them with the app and flags any day more than half an hour apart. Nothing in this script
  // writes to them and nothing ever should - Paul, 7 Nov: "I dont want you to write or edit these data".
  // They are one workbook per year: point these at the new workbooks when Charles starts 2027's.
  HOUR_SHEETS: {
    'ejclay.h@gmail.com':   '1zNTAmqopFaKButGoBF1hKVOemyHjQZvHASfX-AlyLdo',   // Elijah Harder
    'cm.pcwagyu@gmail.com': '1NQb917JcpmGIjmjy6pDSoz16leAQQ0zw52dWlu1jonA'    // Charles Marinier
  },

  SESSION_HOURS: 720,                // 30 days — sign in once per phone; each use renews it (rolling)
  ENTRY_WINDOW_DAYS: 60,             // how much history the app loads per employee (payload cap)
  RATE_LIMIT_PER_10MIN: 200,         // per-user request ceiling (quota protection)
};
// ===============================================================================================

const SHEETS = {
  EMPLOYEES: 'Employees',
  MASTER: 'Master Summary',
  LOG: 'Activity Log',
  SETTINGS: 'Settings',
  MATERIALS: 'Materials',        // the catalog: Item | SKU | Unit | Aliases | Source | Added By | Added At
  MATLOG: 'Materials Log',       // per-entry usage: employees' items land here at clock-out
  JHA: 'JHA Log',                // one row per daily Job Hazard Assessment form
  ONBOARD: 'Onboarding',         // the checklist definition — edit rows here to change onboarding
  ONBOARDLOG: 'Onboarding Log',  // one row per employee: progress, completion signature PDF
  SCHED: 'Schedule',             // job assignments: calendar EventID -> assigned employee emails
  TIMEOFF: 'Time Off',           // crew time-off requests: pending/approved/denied
  ALLOW: 'Allowances',           // employee expense claims: cellphone/food/mileage/other
  REQUESTS: 'Requests',          // website estimate/appointment leads awaiting Paul's scheduling
  BUDGETS: 'Job Budgets',        // optional budget per job — most jobs never get one (v32)
  EDITLOG: 'Edit Log',           // v74 — one row per CHANGED FIELD on an edited entry, with the reason
  NEO: 'Neo Report',             // v76 — the inbox sweep's current report, plus its ignore memory
  PUSH: 'Push Subs',             // v79 — the phones that have asked to be told when Neo finds something
  PARTLOG: 'Parts Log',          // v84 — every naming decision, so a mis-tap can be taken back
  APVLOG: 'Approval Log',        // v85 — every approve/reject on an entry, and a way back
};

// Per-employee entry columns (1-based order must match ENTRY_HEADERS).
// 'Hours' = NET hours (gross minus breaks) so all summary formulas + payroll stay correct.
// v2 columns (Gross/Break/Breaks JSON) are appended at the END so existing tabs migrate
// in place — run migrateTabsV2() once to refresh header labels on existing tabs.
const ENTRY_HEADERS = ['EntryID','Date','Day','ClockIn','ClockOut','Hours','Company',
  'Customer/Job Site','PO#','Notes','GPS In','GPS Out','Media','Status','Source','PeriodKey',
  'Approved By','Approved At','Reject Note','Last Edited By','Last Edited At',
  'Gross Hours','Break Hrs','Breaks JSON'];
const COL = {}; ENTRY_HEADERS.forEach(function(h,i){ COL[h] = i+1; });
const ENTRY_HEADER_ROW = 8;   // entries table header lives on this row; data grows below.

// ---------------------------------- HTTP entrypoints -------------------------------------------

function doGet(e) {
  // v46 — the customer's Yes/No confirmation link lands here. No login: the one-off token in
  // the link is the whole credential, and it can only set one cell on one request row.
  var q = (e && e.parameter) || {};
  if (q.quote) {                                   // v89 - Yes / No under an emailed estimate
    try { return withLock_(function(){ return quoteAnswer_(String(q.quote), String(q.a || '') === 'yes' ? 'yes' : 'no'); }); }
    catch (err) { return confirmPage_('Something went wrong on our end. Please give us a call.', false); }
  }
  if (q.confirm) {
    try { return confirmAnswer_(String(q.confirm), confirmVerb_(q.a)); }
    catch (err) { return confirmPage_('Something went wrong on our end. Please give us a call.', false); }
  }
  // Health check + config fingerprint (safe to expose: client IDs are public by design,
  // and this only shows the tail — lets us verify which config version is actually live).
  return ContentService.createTextOutput(JSON.stringify({
    ok: true, service: 'PCW/PRO Timesheet API', v: 102, // v102 (9-10 Nov): price-list units by what the part is; customerFromPo; time off added by hand; last day worked on jobCosts; an existing customer's new job keeps their PO letter; bids ignore surveys and a GC's "not submitting a bid" notice. // v101: BID DEADLINES ON TODAY (Paul, 8 Nov). Every Today build also reads the inbox (read only) for invitations to tender or bid from GCs and the bid platforms and keeps a Bids tab: GC, project, the closing date and time - taken from the newest thing the GC wrote, so a reply moving the close beats the subject line, with the time zone honoured and a missing time left missing - and Sent once our own reply with the bid attached is in the thread. A date typed in the app is never overwritten. Today carries the open bids; bidSave adds one by hand or sets its status (not decided / bidding / sent / not bidding / won / lost), closing and note. // v100: MONEY PER JOB ON TODAY (Paul, 8 Nov). The Today build also works out every job's money: cost so far (hours x each person's pay rate + the supplier POs - the same figures as the Cost tab), what it is worth at your rates (hours x each person's Charged rate, rounded to the half hour like the invoice, the journeyman line raised to match an apprentice's, + materials with the markup tier on the job's material total), the margin, and the quote or budget beside it; for invoiced jobs and jobs paid in the last 90 days, the Amount Invoiced typed on the Cost tab. jobCosts also sends each person's hours, pending hours and cost per job (people). Read only - nothing is written anywhere. // v99: AUDIT FIXES for the follow-up list. A job dragged to a new time (no email) is listed as 'confirm' with detail 'not told' and counted from the move, not from the email about the OLD time; and anyone who can approve hours can log a follow-up, not only admins. // v98: LEADS TO FOLLOW UP ON TODAY (Paul, 8 Nov). The Today build also lists every customer who has gone quiet: a price sent 3+ days ago with no answer, a booking they were asked to confirm 2+ days ago that is still unanswered, someone who said the time does not work or cancelled by email, a job they said yes to that has waited 2+ days to be booked, and an estimate request not priced after 2 days. followUp logs a call, text or email on a new Follow-ups tab and puts the person aside until the next check (2, 3 or 7 days); the count of follow-ups travels with each one. Nothing is sent to a customer by this. // v97: AN ENTRY CAN BE DELETED (Paul, 7 Nov: a 0-hour 'break never ended' entry 'was obviously a mistake'). deleteEntry marks the row Status 'deleted' - the row stays, it comes off every hours total, pay period, job cost and the Today checks like a rejected one, it disappears from the app's lists, and it is written to the Approval Log so 'What we have decided lately' can put it back with one tap. Approvers only; a running (open) entry can be deleted too and stops being the running clock. // v96: NOBODY WAITS ON THE OFFICE. eventInfoMany answers the job details for many bookings in one call (the app fetches the month in the background and opens details at the tap); a 5-minute keepWarm timer, 6 am to 8 pm, keeps the first tap of the day from a 10-20 s cold start - it installs itself on the first bootstrap. // v95: scheduleAddDay - another day on the same job from the Schedule tab: a copy of one booking (same name with (cont'd), address, notes, crew, length) on a new day, the original left where it is, no slot check, no email. // v94: REVIEW FIXES for the block calendar. A drag clears the customer's old Yes / Reschedule links (the old email asked about a time that no longer exists); a repeating event is refused (every instance shares one id); an event with no colour reads as 'none' (booked, nobody asked) instead of 'waiting'; scheduleList says which events repeat; the email sent after a move says Changed, not Booked. // v93: scheduleYear - a whole year's booked hours and bookings per day in one call, for the app's Year view. // v92: THE BLOCK CALENDAR. scheduleMove moves one booking to where it was dropped - no slot check, no bump, no email - and marks it not confirmed (amber); scheduleConfirm sets confirmed / waiting / needs a new time from the app; scheduleList sends each booking's confirm state. See the v92 block above leadEmail. // v91: THE NOV 7 AUDIT FIXES (see the V91 block at the end): a replayed punch is answered before it waits for the lock and a punch waits 25 s, not 15; a break nobody ended counts as ZERO and is flagged on Today instead of eating the shift; a clock-in or break changed on the clock-out review is written to the Edit Log; material claims are posted once per entry even when the phone sends them again days later; the PO Log Estimates tab gets Accepted / Denied / Closed (the words its dropdown allows); a supplier reference that is not a job ('REEL FOR ORDER 3997990') files to 'Needs review' instead of becoming a job folder; Home Hardware sales invoices are read as invoices; the Neo report keeps each item's id across repeat posts; contacts match on the name before ' - ' or ','; Today lists entries to correct and punches that were refused and never landed; the Cost tab on the PO Log is refreshed daily from the timesheet and the supplier POs; the supplier sweep runs every 2 hours. // v90: requestAdd files an emailed estimate request (entryNo "email:<threadId>") only once and answers {duplicate:true} after that, so the inbox sweep can run twice a day without filing the same email twice. // v89: NAMES ON THE CALENDAR, AND AN ESTIMATES TAB (Paul, 7 Nov). Bookings are titled by who they are - "Karen Eastman · R26201 — Replace the panel" - with no APPOINTMENT / ESTIMATE / RETURN in front; retitleCalendar renames the ones already booked. Requests for an estimate (from the website or, through the inbox sweep, by email) wait on a new Estimates tab instead of Requests; estimateSend emails the customer the price with Yes, book it / No thanks, and a yes puts it on Requests as a job to book (its number is minted then). See the ESTIMATES block. // v88: the Today answer also carries the paid-job count and every job in progress with its hours, for the desktop layout (menu on the left, the job pipeline, On the go). Nothing else changed. // v87: THE TODAY SCREEN (Paul, 7 Nov - steps 2 and 3 of the dashboard build). A new action, today, answers "what needs me right now?" for the office: forgotten clock-outs, every day the app and Charles's manual hour sheets are more than half an hour apart (the sheets are READ ONLY - see CONFIG.HOUR_SHEETS), jobs with hours and no invoice that nobody has worked on for two days and that have nothing on the calendar, jobs in progress that were never booked, plus four numbers (jobs in progress, hours that don't match, invoiced and waiting, the crew's pay period). It is built on an hourly timer that installs itself on first use and kept in the cache, so the screen opens on a stored answer; Refresh rebuilds it. todayHide puts an item aside: an hours day until either number changes, a job for two weeks. Nothing is written anywhere except that list of what was put aside. // v86: STEP 1 OF THE DASHBOARD BUILD (Paul, 7 Nov) - two data fixes, nothing on screen moves. (1) A job invoiced on the 1st of a month is archived in THAT month: completedMonthFolder_ read a bare date as midnight UTC, i.e. the evening before in Alberta. (2) ONE JOB, ONE ROW on the Jobs tab: hours are grouped on the job number's five digits and named off the PO Log, so a customer name or a corrected letter no longer splits a job in two (C26170 was "Angelica Alberto" + "The Beauty Bar & Co."). See jobByPo_. // v85: AN APPROVAL CAN BE TAKEN BACK. Paul, 3 Nov, about an employee's request to change their hours: "a log for all the changes we've made, to be able to undo or edit them if we click confirm by accident." Approve and Reject are two buttons a thumb apart deciding somebody else's pay, and the only record was an Activity Log line that cannot put anything back - once an entry said "approved" there was nothing anywhere saying what it had said a second earlier. Every decision now keeps the row's PREVIOUS status, approver, timestamp and rejection note on an "Approval Log" tab, so undo restores exactly that: the request goes back to pending, onto the Requests tab, where it can be read properly, edited and decided again. Two refusals that matter: a decision cannot be undone twice, and it will not undo an entry that someone has DECIDED AGAIN since - that would silently overwrite their decision, so it says what the entry reads now and changes nothing. No hours are ever touched by an undo. // v84: EVERY NAMING DECISION IS WRITTEN DOWN AND CAN BE TAKEN BACK. Paul, 3 Nov: "a log for all the changes we've made, to undo or edit them if we click confirm by accident." Naming a part is one tap that does three things at once - writes a catalogue row, renames a live job's line, and clears the question off the Requests tab - and the only trace was an Activity Log line, which says what happened and cannot put it back. Each decision now gets a row on a "Parts Log" tab carrying what was typed, what it was named and whether the catalogue row was created by THAT decision, which is exactly what an undo needs. Undoing puts the job line back to a question under the words actually typed, and removes the catalogue row only if this decision created it and no other job line has used it since - otherwise it stays and the app says why, because deleting it would strand that other job. A decision can be undone once. // v83: WHAT THE PO LOG KNOWS NOW REACHES THE APP. The details have only ever travelled one way: the app writes a booking's phone, email, address and scope to the PO Log, and nothing has ever read them back. R26195 Paddy is the case in point - the Requests row has the name, the time and the PO and nothing else, while the PO Log row typed by hand has the email, the phone, 83368 RR 201 and the whole scope of work, so the app showed a blank card beside a full sheet row. Every booking now falls back to its own PO Log row for anything it is missing, on the Requests tab and on the Schedule tab's booking sheet. It FILLS GAPS and never overwrites - what the customer themselves typed into the website form stays the truth - and it says which fields came off the sheet. The old fallback only fired when even the customer's NAME was missing, which is why a booking with a name and nothing else got nothing. One read of the PO Log per call, shared by every row. // v82: an approval shows the day and the time and nothing else. The Edit Log keeps its before-and-after as the words a person reads ("Mon Oct 26, 1:00 PM"), but the column was General, so Sheets parsed them back into datetimes and the row came out of getValues() as a Date - whose String() is "Mon Oct 26 2026 13:00:00 GMT-0600 (Mountain Daylight Time)". That is what was on the card. Those cells are now plain text, and anything already coerced is formatted on the way out instead of stringified. ALBERTA NO LONGER CHANGES ITS CLOCKS (permanent daylight time, UTC-6 all year), and since 1 Nov 2026 the zone database labels that permanent -6 "CST" - so a printed abbreviation would now claim Central Standard Time in Peace River. Nothing here hardcodes an offset and nothing should: the zone still gives the right instant, it is only the label that has to go. // v81: THE APP LOOKS FOR THE PART BEFORE IT ASKS ABOUT ONE. Everything that ever reached the Requests tab got there the same way - the name somebody typed did not match a catalogue row CHARACTER FOR CHARACTER - so "15A 1P SQD Breaker" and "Square D CHOM115 1P 120V 15A Circuit Breaker" were two parts, while "2x4x8 Lumber", genuinely new, was asked about just the same. A typed name is now scored against the price list, the field catalogue and THIS JOB'S OWN PO lines, on shared words with anything carrying a digit worth three - 14/2, 15A, 4x4 and 1P are what tell parts apart, "box" is not, and 3-1/2 is no longer the same fraction as 1-1/2. Three outcomes: a near-perfect match IS that part, so the line takes the name we already use and nobody is asked; something close is a question, and the Requests card offers the candidates as one-tap buttons with where each came from; nothing close is simply new, so it is learned into the field catalogue then and there and never mentioned. The price list is deliberately NOT written to - the supplier sweep owns it, because it has the real part number and the real price, and a name typed on a phone beside the invoice's own wording would price the job twice. // v80: THE MATERIALS LIST IS THE INVOICE, not a catalogue. jobParts now sends the inventory's PLAIN NAME beside the supplier's shouting, so the app can lead with "1-gang device box" and put "2-1/2 IN DEEP 1 GANG DEVICE BOX" underneath it in small type; there was only ever the supplier text and no way to show anything shorter. And a part nobody has heard of - typed on the job by whoever is standing there - now reaches the Requests tab: approvalsAll carries the pending ones, and resolveMaterial takes the NAME the office gives it, writes that name to the catalogue AND back onto the usage row (so the invoice and the shelf cannot disagree), keeps what was actually typed as an alias so the next person who types "2104 box" lands on the right part, and refuses to add a second copy of something already in the list. The part is on the job from the moment it is typed; only its name waits. // v79: PAUL'S PHONE CAN BE TOLD WHEN NEO FINDS SOMETHING. Charles chose a push notification over a text, which means no carrier, no Twilio account and nobody's number written down anywhere - but this script cannot send one and never will: VAPID is ECDSA over P-256 and the payload is sealed with ECDH + AES128GCM, and Utilities offers HMAC and RSA. So the sweep that writes the report sends the push as its last step, and this script is the address book: pushSubscribe files a phone (approvers only), pushUnsubscribe turns it off, and the sweep reads the list and reports the dead ones on the inbound key (pushSubs, pushDrop). A subscription is one browser on one phone, keyed by its endpoint, so re-subscribing updates the row instead of making a second one; a phone the push service answers 404 or 410 for is marked gone rather than deleted, so "it stopped telling me" still has an answer on the tab in three months. The endpoint plus the VAPID private key is enough to make that phone buzz, which is why it is admins only and why the tab belongs under the same protection as the rest. // v78: the inbox report remembers WHEN it last ran, separately from what it found. A sweep that finds nothing to answer leaves no row on the Neo Report tab, so neither the tab nor the app could tell "the inbox is clear" from "the sweep has never run" - and the app, which drew no card at all for an empty report, showed a blank Requests tab on the afternoon the feature went live. The sweep time is now kept in script properties by neoReportPost and returned by neoReport as lastSweep, so the card can say which it is. // v77: EVERY edit to an approved entry goes back for approval, an admin's own included. It used to be waved through for admins on the grounds that an admin is the approver, which left their own corrections invisible on the Requests tab - a one-minute test change on 27 Oct appeared nowhere. It now lands pending with its before-and-after on the card; either admin can approve it, so it is a prompt and a record rather than a lock. Only when something actually changed: opening an entry and saving it untouched no longer moves its status, clears its approver or writes an audit row. And a field whose DISPLAYED value did not move is no longer listed as a change - the comparison is to the second while the display is to the minute, so a clock-out nudged by seconds was logging "5:20 PM -> 5:20 PM", which makes the whole comparison look untrustworthy. // v76: NEO'S REPORT. A scheduled task reads what is still sitting in the inbox three times a day, decides what a person actually has to deal with, and posts a one-line summary plus a suggested reply for each on the inbound key (neoReportPost). The app shows it on the Requests tab, where the reply can be edited and sent as PRO on the original thread (neoReply) or saved as a Gmail draft, and each item can be ignored or put off (neoDecide). The "Neo Report" tab is also the memory, which is why the report is stored rather than emailed: an ignored or answered thread stays out of the report until the NEXT message arrives on it - a follow-up from the customer brings it back, because that is new information - a "later" item returns on the very next sweep, and anything the sweep no longer finds and that carries no decision is dropped, so a fresh report always replaces the old one. // v75: an edited entry is refused above 24 hours. Both ends of a shift now carry their own day in the app, which is what was asked for and is unambiguous for a night shift - and it also means a mistyped year could otherwise slide a 2000-hour entry into payroll. Nothing legitimate is one entry longer than a day; the app itself warns above 16 h and asks for a second tap. // v74: every edit to an entry records WHAT CHANGED - one row per changed field on a new "Edit Log" tab (was, now, who, when, and the reason they typed) - and the approvals payload carries the latest one with each pending entry, so the app can show the original beside the updated one. A separate tab rather than another column on the entry, because the per-employee tabs are written a whole row at a time at ENTRY_HEADERS width and adding a column there means migrating every tab and risking every punch write; this costs one sheet read on the approvals call and nothing anywhere else. Times, dates, breaks and hours are stored in the words a person reads, not as ISO strings, so the tab is an audit trail somebody can actually use: edit an entry three times and all three are there. An edit that changes nothing writes no rows, and a failure to write the audit row never costs anybody their correction - the edit stands and the Activity Log says the diff was lost. // v73: the supplier-email sweep stops reporting Google's own hiccups. Its trigger runs hourly and Apps Script mails a daily digest of any failed run, so one dead run on 20 Oct - "We're sorry, a server error occurred", Google's backend, not this script - produced an email the next morning about something the 21:02 run had already put right (every message read is on the Sweep log, so the next run re-reads the same threads and files what the dead one missed). A transient failure is now caught, written to the Activity Log and swallowed; it is only reported once it has failed three runs in a row, which means it is not recovering by itself. Anything that is not a Google wobble - a bug, a missing tab, a permission taken away, execution time exceeded - is still reported on the first failure, because those never self-heal. testSweep() in the editor runs the sweep itself so a developer still sees the real error. // v72: "Schedule a job" can be booked onto a job that is already in progress, and then it KEEPS that job number - a PO number becomes the QuickBooks invoice number, so it is minted once and never re-minted, and the existing PO Log row is re-dated instead (requestSchedule_ has done that for a rebooked job since v51; requestAddManual now writes the number onto the row so it takes the same path). Refused for a job that is closed, invoiced or cancelled, and for an estimate call, which is not booked against a job number at all. // v71: jobParts - what a job actually bought, rolled up one row per part (the same wire across four EECOL invoices is one line reading bought 150 m, 60 logged, 90 left), with the shop count beside it as the separate number it is. Stock flagged to go back to the supplier is not counted as used; a part used on the job that came off the shelf rather than off one of its POs is not in the list, because this list is the POs. Crew get the parts, the supplier and what is left; prices and invoice numbers are admin and bookkeeper only. The app opens its materials screens with this list. // v70: MATCHING, to Charles's rule: if the name, the email OR the phone is already in Google Contacts, that is the person. A name NEARLY the same (every word of the shorter in the longer, sharing a word of five letters or more - "McGregor" against "McGregor Hostetler", a real pair on the PO Log) is reported and nothing is written at all, rather than merged: a duplicate contact is a tidying job, the wrong email on somebody's card is a letter to the wrong person. A bare first name is not enough - there are two Ricks on the log - nothing is created, nothing that has a value is corrected, and only empty fields are filled. A name is compared on what it says rather than character for character, so "McGregor " and "mcgregor" are the same man (the old exact-string test said they were not, which is how a duplicate gets made). A form with no person name on it is looked up under its company, so a second "KFC" is not created. If TWO contacts already match - a duplicated address book, which the log shows for Isaac Laboucan-Aviron - nothing is written at all and both are named, because picking one would be a coin flip and filling both would spread the duplication. A business already in the book under its own name is reported alongside, never written to: the contact person's email does not belong on the company's card unless somebody says so. Every answer now says what it matched on. // v69: the contacts repair is driven by what the Activity Log actually shows. It CREATED one contact from a test form - "Test 1 Appointment", people/c102738742546907694, 9 Oct, from the test sent with Hannah's address - and every other contactAdd in the log says "existing contact", a path that has never been able to write a name. So contactsFixReport() now lists every contact that looks like a test lead with its addresses attached, before anything is changed, and a fix entry can delete a contact (remove: true) as well as rename one. // v68: GOOGLE CONTACTS. Two website-form tests were written in as clients - one sent from Charles's own address became a contact called "Test Test", one sent from the Wagyu address with no name in the form became "PCW" (with no name to use, the code fell back to the company) - and because Gmail shows a sender under the name Contacts holds, their own mail then arrived under those names. Our own addresses are never a client, so a form carrying an admin, bookkeeper, employee or @proes.ca / @pcwagyu.com address is no longer written to Contacts at all, and a name that is plainly a test ("Test", the same word twice, a single letter) does not create one either; both are reported and logged instead, and force: true still gets a real client through. On a contact that already exists the rule is now written down and complete: what is in Contacts wins, we only fill an empty spot, and a NAME is filled only when the contact has none - a name that disagrees is reported, never written. contactsFixReport() and contactsFixApply(), run from the editor, put the two wrong names back; they write the name and nothing else, and leave merging to Google Contacts. // v67: the forgotten-clock-out fix is replay-safe, because the app now keeps it on the phone and sends it again if the answer is lost - the same stop time comes back with the stored hours instead of 'already clocked out', which the app would show as a failure of a fix that actually landed. A clock-out time may be set up to CLOCKOUT_AHEAD_MIN (2 h) ahead of the phone's clock instead of 5 minutes: Paul asked to be able to round the finish up, type 5:30 at 5:20, and the old five-minute window silently pulled it back to 'now' so the entry did not say what he had typed. And Project Name on the PO Log is no longer written by the script: creating a job from a website enquiry used to copy the whole scope paragraph into it, and that column is what the crew now read on the job picker, so it has to be the short name a person gives the job. The scope still goes in Description of Work. // v66: the PROJECT NAME travels with the job list - read off the PO Log once in getPoCustomers_ and sent with every job, and picked up by the Jobs tab off that same read instead of a second one. Also: takeMaterial and logMaterials carry a submission id and the first one is remembered for six hours (onceGuard_), because the app gained write-ahead for them and a lost answer would otherwise put two sets of parts on one job and take the shelf down twice. // v65: leadEmail fetches the ORIGINAL website form email for a lead, so Paul can read what the customer actually wrote rather than only the ball-park's write-up of it. The link is already in every ball-park block, so it works for leads filed months ago, not just new ones. v64: the email to the customer is shown before it is sent, with a suggested sentence Paul can rewrite. Only that paragraph is his - the time, the address, the Yes/Reschedule/Cancel buttons and their one-off tokens are still built by the script, because an edited link is a link that no longer works, and the tokens are minted when it actually sends so a preview can never hand one out twice. v63: after changing a booking the app can record that the customer was rung, or send them the right email for that kind of booking - the confirmation with Yes/No buttons for a booked job, the plainer note for a return visit - and either way it is written on the job's row so there is an answer to "did anyone ring them" weeks later. v62: eventInfo also returns the JOB's request row (jobRequestId) and its quote, so a return visit can correct the customer's details - those are facts about the job, not about one trip to it - while Move and Cancel still act only on the event in front of you. v61: speed - the Requests tab is read ONCE per call and shared by every lookup. Tapping a booking on the Schedule tab was reading it twice on top of the calendar, which on a cold start could pass the app's 30-second timeout and come back as "No answer from the server". v60: a quoted estimate can now be moved (the CALL moves, 15/30/60/120 min - it used to block out the whole estimated job length), relabelled estimate<->appointment where nothing has been spent on it yet, and corrected including the hours and the quoted price range. v59: a RETURN VISIT can now be opened, moved and called off from the Schedule tab, and shows the original website enquiry of the job it continues. Return visits are created as calendar events with no Requests row, so until now they were the one booking the calendar could not act on - which on a quiet fortnight is the only booking there is. Cancelling a return visit does NOT mark the PO Log Cancelled and moving one does not change the job's start date: the job is still open and still gets invoiced under the same number. v58: TWO REAL BUGS. The Schedule tab was reading getDefaultCalendar() - the only place in the script that did - while every booking is created on the admin@proes.ca calendar, so the tab could show almost nothing while the jobs were all there. And "Correct details" in the app has called requestUpdate since v47, an action that was never written; it exists now and writes the Requests row, re-titles the calendar event and carries the contact details to the PO Log. v57: requestList now returns each booking's calendar event id, so a job tapped on the Schedule tab can be moved, cancelled, or have its original website enquiry read - the actions that until now only existed on the Requests tab. v56: contactLookup and contactAdd now exist - the sweeps have been calling them for weeks and they were never built. Google Contacts via the People API (ContactsApp is deprecated); a client is matched on email, then phone, then name, so nobody is added twice, and an existing contact has only its EMPTY fields filled - anything that disagrees is reported, never overwritten. Needs the People API added under Services once, then contactsSelfTest() run from the editor to approve it. v55: a call that sends the inbound key but asks for an action the key does not open now says exactly that, and names the actions it does open. It used to fall through to the sign-in path and answer "Not signed in.", which pointed at the web app's account instead of at the action - the actual fault. v54: MORE SPEED. The master workbook and its tabs are opened once per call instead of once per use (25 call sites, several per action), and the waiting-leads badge counts one column instead of reading the entire Requests tab and Call List - which bootstrap_ did on every app open and every background refresh. v53: SPEED. Working out whose job a calendar booking is used to open the PO Log workbook and read the whole Requests tab ONCE PER BOOKING - six range reads and a cross-file open each - so a day with six jobs on it did that six times before the screen could paint. Both tables are now read once per call and reused. No behaviour change. v52: the time picker opens on a full month - a day with a job on it carries a dot - and tapping a day shows that day's bookings and the start-time field. v51: a job displaced by another booking goes back to the Requests tab with NO time - its PO number, customer and scope intact - where Paul picks a time or takes the next opening, and can ring or email the customer; if the time he picks is taken, that job comes back the same way, one step at a time. Paul can add an emergency call or a job by hand from the Requests tab (after hours and on top of an existing job if he says so), with a day-view calendar to pick from; a manually added JOB gets the next PO number and a full PO Log row, a phone call does not. A rebooked job keeps the PO number it already had. v50: PO Log and price-list columns are found by what they MEAN, not by position or exact spelling - a renamed, mistyped, re-spaced or moved header no longer stops the PO Log being filled or a part being added; anything unresolvable falls back to the old column number, and checkHeaders() shows what resolved where. v49: the INITIAL DRAFT warning goes in the invoice MEMO (PrivateNote), never the customer message, and the initial pass fills BLANK contact fields on the QuickBooks customer from the PO Log row (never overwriting one that has a value). v48: approvalsAll gives the Requests tab every pending approval (hours, time off, allowances); an admin can add time for any employee (approved, employee emailed). v47: a supplier invoice whose reference is not a job number is checked against the PO Log (contact / company name, last digits of a job number) and, if still no job, filed in a folder named after that reference (PCW, a client's name...) in the PO archive; repairJobPOs moves the ones already filed. Typo-tolerant names (one job that close, flagged in the report); a job number is matched on its last 3 digits (a typo in the letter/year in front is fixed; different last digits = a different job, never guessed). v46: Build Initial Draft opens the job's PO lines with editable quantities; the saved list (Invoice lists tab) is what Claude bills, then it fetches the hours. v45: shop consumables (po_ref SHOP / STOCK / none) file to "Shop Supplies" in the PO archive, TOOLS to Tools, PAUL to Paul; repairJobPOs moves the ones already filed. v44: repairJobPOs moves supplier purchases wrongly filed to Stock onto their job (Job POs tab + the PDF into the job-number folder). v43: repairJobNames takes an except list. // v42: a job number typed as the job name (R26184) is turned into the real job - PO# + the PO Log name - at clock-in, clock-out, edit and manual entry; repairJobNames fixes the entries already saved that way. v41: v41: supplier invoices and credit notes file by JOB NUMBER - a job with no company name, or not on the PO Log yet, still gets its own job-number folder and its stock record; I26156 vs C26156 match on the digits. v40: v40: estimate calls pick 15/30/60/120 min and get open times (no more overlapping); clock-out materials come off the shelf; residential supplier invoices file to the job; return visit at any day+time with a confirmed bump chain + Call List; Build Initial Draft starts Claude immediately. v39: Status dropdown removed - the script keeps Status to Estimated / In progress / Invoiced / Closed / Cancelled, and setupPoStatusColours() colours the column by its text. v38: Claude can edit the PO Log (poLogFind / poLogUpdate / poLogAdd on the inbound key), dropdown-safe writes, PO numbers refused as customer names. v37: v37: invoicing in two passes - the job card has Initial draft (every part at cost, no markup, for Paul to correct in QuickBooks) and Final draft (reads his corrections back, rolls the parts up and applies the markup to the same invoice). v36: the slot finder now uses the ball-park working day (Mon-Fri 08:30-18:00, lunch 12:30-13:00 that a job may span, 9 working hours); the customer's form photos and the original-enquiry link go back onto the calendar event; nothing books into the past, and an APPOINTMENT is refused if the slot is taken - the refusal names the clash and offers the next open times. An ESTIMATE call may still sit over a running job (30 min on the phone) but the reply says what it lands on. v35: the customer's appointment email is a branded card with real Yes / No buttons instead of two raw script.google.com URLs in plain text; same links, same tokens, same handler, plus a plain-text part for clients that refuse HTML. The return-visit email uses the same shell. v34: return visits — visitSlots reads Paul's calendar and offers the first openings that fit the hours still needed (weekends, Alberta stats, approved leave and a 30 min travel buffer excluded); visitBook books the one agreed with the customer, re-checking the slot is still free. v33: jobSetStatus writes Status on its own (Invoiced = sent, Closed = paid); jobSetDates fills a BLANK start/end date from the timesheets; fmtDate_ no longer shifts a bare YYYY-MM-DD back a day. v32: job spend = labour (approved + pending) + materials bought, with an optional budget per job. v31: 24 h still-clocked-in email to employee + admins; late and stuck punches emailed + logged; punchStuck action. v30: punches idempotent on tap time, refused punches logged. v29: quotes update the price list (newest price wins), one scan button for receipts + estimates, supplier date formats fixed
    clientIdTail: String(CONFIG.GOOGLE_CLIENT_ID).slice(0, 12) + '…' + String(CONFIG.GOOGLE_CLIENT_ID).slice(-30),
    masterSheetSet: !!CONFIG.MASTER_SPREADSHEET_ID
  })).setMimeType(ContentService.MimeType.JSON);
}

// v27 — the only actions the inbound key may reach. Adding to this list widens a door that
// has no session behind it, so each entry must be safe to run unattended and hard to abuse.
// jobInvoiced qualifies: it refuses to run without an invoice number that already exists,
// it writes three cells on one PO Log row, and it moves folders it can name.
// v33 - jobSetStatus joins them: it writes ONE cell on one named row, only ever one of
// three fixed words, and refuses anything else. Claude reads the QuickBooks balances and
// calls it so a paid job reads Closed instead of Invoiced.
// v38 - poLogFind / poLogUpdate / poLogAdd join them so Claude can keep the PO Log current.
// They find cells by header, never rewrite a PO number, honour the sheet's dropdowns and log
// every change (see the v38 block at the bottom of this file).
var KEY_ACTIONS_ = ['requestAdd', 'jobInvoiced', 'jobSetStatus', 'jobSetDates',
                    'poLogFind', 'poLogUpdate', 'poLogAdd', 'repairJobNames', 'repairJobPOs',
                    'invoiceMaterials',
                    'contactLookup', 'contactAdd',     // v56
                    'neoReportPost',                   // v76 — the inbox sweep posts its report
                    'pushSubs', 'pushDrop'];           // v79 — and tells the phones that asked

function doPost(e) {
  var out, t0 = Date.now();
  try {
    var req = JSON.parse(e.postData.contents);
    var user;
    if (req.action === 'login') {
      // Google ID token in → a session token out, good for CONFIG.SESSION_HOURS and renewed on
      // use (Google's own tokens die after ~1h; a field day doesn't). Login also returns the
      // full bootstrap to save a round-trip.
      // The comment here read "24h" long after SESSION_HOURS became 720. On 2026-10-13 that
      // stale number sent a lockout diagnosis down the wrong path. Read the constant.
      user = authenticate_(req.idToken);
      var result = createSession_(user);
    } else if (req.key && CONFIG.INBOUND_KEY && req.key === CONFIG.INBOUND_KEY &&
               KEY_ACTIONS_.indexOf(req.action) >= 0) {
      // Claude's sequences run with no browser session: the ball-park files a website lead,
      // and the invoice build closes the job out once QuickBooks has the invoice. The key
      // opens ONLY the actions named in KEY_ACTIONS_ — it is not a general admin login.
      var keyUser = { email: 'claude-task', role: 'admin', permissions: { approveHours: true } };
      var KEY_FNS_ = { requestAdd: requestAdd_, jobInvoiced: jobInvoiced_, jobSetStatus: jobSetStatus_,
                       jobSetDates: jobSetDates_, poLogFind: poLogFind_, poLogUpdate: poLogUpdate_,
                       poLogAdd: poLogAdd_, repairJobNames: function (u, q) { return withLock_(function(){ return repairJobNames_(u, q); }); },
                       repairJobPOs: function (u, q) { return repairJobPOs_(u, q); },
                       invoiceMaterials: invoiceMaterials_,
                       contactLookup: contactLookup_,                                      // v56
                       contactAdd: function (u, q) { return withLock_(function(){ return contactAdd_(u, q); }); },
                       neoReportPost: function (u, q) { return withLock_(function(){ return neoReportPost_(u, q); }); },  // v76
                       pushSubs: pushSubs_,                                                 // v79
                       pushDrop: function (u, q) { return withLock_(function(){ return pushDrop_(u, q); }); } };
      var result = KEY_FNS_[req.action](keyUser, req.payload || {});
    } else if (req.key) {
      /* v55 - A KEY WAS SENT AND THE CALL STILL DID NOT TAKE THE KEY PATH.
       *
       * Until now it just fell through to the browser-session branch below, found no sign-in
       * token there, and came back "Not signed in." That message is false in three different
       * ways at once: a credential WAS sent, the session is irrelevant to this caller, and the
       * thing actually refused was the ACTION. It cost a morning of looking at what account the
       * web app runs as - which was never involved.
       *
       * The three reasons a keyed call can land here are now told apart and named. */
      if (!CONFIG.INBOUND_KEY)
        throw new Error('This script has no inbound key configured, so key access is switched off entirely.');
      if (req.key !== CONFIG.INBOUND_KEY)
        throw new Error('The inbound key sent with this request does not match the one this script expects.');
      throw new Error('The inbound key is valid, but it does not open "' + String(req.action) +
        '". The key opens only: ' + KEY_ACTIONS_.join(', ') + '. ' +
        'If that action exists and the sweeps should be able to call it, add it to KEY_ACTIONS_ ' +
        'and to KEY_FNS_. If it is not in this script at all, it has to be built first - the key ' +
        'cannot open something that was never written.');
    } else {
      user = req.sessionToken ? sessionAuth_(req.sessionToken)
                              : authenticate_(req.idToken); // legacy path still accepted
      rateLimit_(user.email);
      var result = dispatch_(req.action, req.payload || {}, user);
      // v31 — a punch the phone held for a day or more before it could deliver it is saved as
      // normal, and the employee + admins are told (see noteLatePunch_).
      if (/^(clockIn|clockOut|switchJobSite|startBreak|endBreak)$/.test(req.action)) noteLatePunch_(user, req.action, req.payload || {}, result);
    }
    out = { ok: true, data: result };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
    // v30 — a refused punch leaves a trace. Until now a rejected clock-out vanished from the
    // record entirely (the log only wrote successes), which is why six days of lost
    // clock-outs could not be reconstructed from the sheet.
    try {
      if (req && /^(clockIn|clockOut|switchJobSite|startBreak|endBreak|fixForgotClockout)$/.test(req.action)) {
        var who = (user && user.email) || 'unknown';
        log_({ email: who }, 'REFUSED ' + req.action, who, String((req.payload || {}).entryId || ''),
          out.error + ' | at=' + String((req.payload || {}).at || ''));
      }
    } catch (e2) {}
  }
  out.ms = Date.now() - t0; // server-side elapsed, surfaced in the frontend's console profiling
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------- Sessions (CONFIG.SESSION_HOURS, rolling) ----------------------------

function createSession_(user) {
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g,'');
  var exp = Date.now() + CONFIG.SESSION_HOURS * 3600000;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('sess_' + token, JSON.stringify({ email: user.email, exp: exp, picture: user.picture || '' }));
  purgeSessions_(props); // opportunistic cleanup of expired sessions
  log_(user, 'login', user.email, '', CONFIG.SESSION_HOURS + 'h session');
  return { sessionToken: token, exp: exp, boot: bootstrap_(user) };
}
function sessionAuth_(token) {
  var raw = PropertiesService.getScriptProperties().getProperty('sess_' + token);
  if (!raw) throw new Error('Session expired. Please sign in again.');
  var s = JSON.parse(raw);
  if (Date.now() > s.exp) {
    try { PropertiesService.getScriptProperties().deleteProperty('sess_' + token); } catch(e){}
    throw new Error('Session expired. Please sign in again.');
  }
  // Rolling renewal: any use inside the second half of the window resets the 30 days,
  // so an active phone never sees the sign-in screen again.
  if (s.exp - Date.now() < CONFIG.SESSION_HOURS * 1800000) {
    s.exp = Date.now() + CONFIG.SESSION_HOURS * 3600000;
    try { PropertiesService.getScriptProperties().setProperty('sess_' + token, JSON.stringify(s)); } catch (e) {}
  }
  var rec = getEmployeeRecordCached_(s.email); // ≤2 min stale — saves a sheet read on EVERY call
  if (!rec) throw new Error('Session expired. Please sign in again.');
  if (!rec.active) throw new Error('Your account is inactive. Contact an admin.');
  if (s.picture && !rec.picture) rec.picture = s.picture; // keep the header avatar alive across days
  return rec;
}
function logout_(user, p) {
  if (p && p.sessionToken) {
    try { PropertiesService.getScriptProperties().deleteProperty('sess_' + p.sessionToken); } catch(e){}
  }
  log_(user, 'logout', user.email, '', '');
  return { ok: true };
}
function purgeSessions_(props) {
  try {
    var keys = props.getKeys();
    var now = Date.now();
    keys.forEach(function(k){
      if (k.indexOf('sess_') !== 0) return;
      try { var s = JSON.parse(props.getProperty(k)); if (s && now > s.exp) props.deleteProperty(k); }
      catch(e){ props.deleteProperty(k); }
    });
  } catch(e){}
}
/* ---------------------------------- Once-only actions (v66) ------------------------------------
 * The app keeps a copy of a punch on the phone BEFORE it tries to send it, so an app killed
 * mid-request loses nothing; the copy is replayed on the next open. From v73 the material actions
 * are protected the same way, and that makes a repeat possible: if the write LANDED but the answer
 * never got back, the phone still has the copy and sends it again.
 *
 * For a punch that is harmless - the script already recognises a repeat by its tap time. But
 * logMaterials_ appends its rows and takes stock off the shelf unconditionally, and takeMaterial_
 * is a read-modify-write on a count. Sent twice, those put two identical sets of parts on one job
 * and empty the shelf twice over, which over-bills the customer and loses the count. Nothing in
 * the sheet would show which of the two was real.
 *
 * So the app stamps each of those submissions with a subId, and the FIRST one through is
 * remembered here with the answer it gave. A repeat is handed that same answer and the work is not
 * done again. Six hours is CacheService's ceiling and far more than enough: the only way to get a
 * repeat is for the request to have REACHED the script, which means the phone had a connection,
 * and the replay follows on the next open minutes later. A call with no subId - an older copy of
 * the app on somebody's phone - behaves exactly as it always did.
 * ------------------------------------------------------------------------------------------- */
function onceGuard_(kind, p, fn) {
  var sub = String((p && p.subId) || '');
  if (!sub) return fn();
  var cache = null, key = 'once_' + kind + '_' + sub;
  try { cache = CacheService.getScriptCache(); } catch (e) { return fn(); }
  try {
    var prev = cache.get(key);
    if (prev) { var o = JSON.parse(prev); o.replay = true; return o; }
  } catch (e) {}
  var out = fn();
  try { cache.put(key, JSON.stringify(out), 21600); } catch (e) {}
  return out;
}
function rateLimit_(email) {
  try {
    var cache = CacheService.getScriptCache();
    var k = 'rl_' + email + '_' + Math.floor(Date.now() / 600000); // 10-min bucket
    var n = Number(cache.get(k) || 0) + 1;
    cache.put(k, String(n), 600);
    if (n > CONFIG.RATE_LIMIT_PER_10MIN) throw new Error('Too many requests — slow down and try again in a few minutes.');
  } catch (e) { if (/Too many requests/.test(e.message)) throw e; }
}

// ---------------------------------- Auth + roles -----------------------------------------------

function authenticate_(idToken) {
  // v55 - this is now reached only when NO credential of any kind arrived, so say that rather
  // than "Not signed in.", which reads like an expired phone session and sends people to the
  // wrong place. A keyed caller is answered before it ever gets here.
  if (!idToken) throw new Error('No credential sent with this request - no session token, no ' +
    'Google sign-in token and no inbound key. Nothing was refused; nothing was offered.');
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' +
    encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Invalid sign-in token.');
  var info = JSON.parse(resp.getContentText());
  if (info.aud !== CONFIG.GOOGLE_CLIENT_ID) throw new Error('Token audience mismatch.');
  if (info.email_verified !== 'true' && info.email_verified !== true) throw new Error('Email not verified.');
  var email = String(info.email).toLowerCase();

  var rec = getEmployeeRecord_(email);
  if (!rec) {
    // Auto-provision seed admins/bookkeepers on first sign-in; everyone else must be added by an admin.
    if (CONFIG.ADMIN_EMAILS.map(lc_).indexOf(email) >= 0) {
      rec = upsertEmployee_({ email: email, name: info.name || email, role: 'admin', active: true });
    } else if (CONFIG.BOOKKEEPER_EMAILS.map(lc_).indexOf(email) >= 0) {
      rec = upsertEmployee_({ email: email, name: info.name || email, role: 'bookkeeper', active: true });
    } else {
      throw new Error('Your account (' + email + ') has not been added yet. Ask an admin to add you.');
    }
  }
  if (!rec.active) throw new Error('Your account is inactive. Contact an admin.');
  rec.picture = info.picture || '';
  return rec;
}

function requirePerm_(user, perm) {
  if (user.role === 'admin') return; // admins have all permissions
  if (!user.permissions || !user.permissions[perm]) throw new Error('You do not have permission: ' + perm);
}
function requireAdmin_(user){ if (user.role !== 'admin') throw new Error('Admins only.'); }

// Default permission checklist per role.
function defaultPermissions_(role) {
  if (role === 'admin') return {
    approveHours: true, editPastEntries: true, manageEmployees: true, setRates: true,
    viewAllCompanies: true, viewAllEmployees: true, exportPayroll: true };
  if (role === 'bookkeeper') return {
    approveHours: false, editPastEntries: false, manageEmployees: false, setRates: false,
    viewAllCompanies: true, viewAllEmployees: true, exportPayroll: true };
  return { // employee
    approveHours: false, editPastEntries: false, manageEmployees: false, setRates: false,
    viewAllCompanies: false, viewAllEmployees: false, exportPayroll: false };
}

// ---------------------------------- Action dispatch --------------------------------------------

function dispatch_(action, p, user) {
  switch (action) {
    case 'bootstrap':        return bootstrap_(user);
    case 'logout':           return logout_(user, p);
    case 'clockIn':          return punchReplay_(user, 'clockIn', p) || punchLock_(user, 'clockIn', p, function(){ return clockIn_(user, p); });
    case 'clockOut':         return punchReplay_(user, 'clockOut', p) || punchLock_(user, 'clockOut', p, function(){ return clockOut_(user, p); });
    case 'switchJobSite':    return punchReplay_(user, 'switchJobSite', p) || punchLock_(user, 'switchJobSite', p, function(){ return switchJobSite_(user, p); });
    case 'startBreak':       return withLock_(function(){ return startBreak_(user, p); });
    case 'endBreak':         return withLock_(function(){ return endBreak_(user, p); });
    case 'fixForgotClockout': return withLock_(function(){ return fixForgotClockout_(user, p); });
    case 'punchStuck':       return punchStuck_(user, p); // v31 — the phone says a punch has been waiting on it for a day
    case 'patchGps':         return withLock_(function(){ return patchGps_(user, p); }); // entry rows are rewritten whole at clock-out — GPS patches must not interleave
    case 'addManualEntry':   return addManualEntry_(user, p);
    case 'editEntry':        return withLock_(function(){ return editEntry_(user, p); });
    case 'listEntries':      return listEntries_(user, p);
    case 'searchCustomers':  return searchCustomers_(user, p);
    case 'customerList':     return { customers: getPoCustomers_() };
    case 'customerFromPo':   return customerFromPo_(user, p);                                       // v102 - a new job for a customer we already have
    case 'createCustomer':   return createCustomer_(user, p);
    case 'uploadMedia':      return withLock_(function(){ return uploadMedia_(user, p); }); // same: the Media cell write races clock-out's full-row write
    // materials
    case 'materialsList':    return { materials: getMaterials_() };
    case 'seedMaterials':    return withLock_(function(){ return seedMaterials_(user); });
    case 'scanReceipt':      return scanReceipt_(user, p);
    case 'addMaterialsBulk': return withLock_(function(){ return addMaterialsBulk_(user, p); });
    case 'jobCosts':         return jobCosts_(user, p);
    case 'setJobBudget':     return withLock_(function(){ return setJobBudget_(user, p); }); // v32
    case 'jobEntries':       return jobEntries_(user, p);
    case 'jobMedia':         return jobMedia_(user, p);

    case 'jhaList':          return jhaList_(user, p);
    case 'jhaCreate':        return withLock_(function(){ return jhaCreate_(user, p); });
    case 'jhaSign':          return withLock_(function(){ return jhaSign_(user, p); });

    case 'onboardingGet':      return withLock_(function(){ return onboardingGet_(user); }); // first open appends the log row — two concurrent opens must not duplicate it
    case 'onboardingCheck':    return withLock_(function(){ return onboardingCheck_(user, p); });
    case 'onboardingComplete': return withLock_(function(){ return onboardingComplete_(user, p); });
    case 'onboardingStatus':   return onboardingStatus_(user);

    case 'scheduleList':       return scheduleList_(user, p);
    case 'scheduleAssign':     return withLock_(function(){ return scheduleAssign_(user, p); });
    case 'visitSlots':         return visitSlots_(user, p);                                    // v34 read-only: when could we come back?
    case 'visitBook':          return withLock_(function(){ return visitBook_(user, p); });    // v34 books the return visit
    case 'openSlots':          return openSlots_(user, p);                                     // v40 read-only: open times for a call or a job
    case 'bumpPlan':           return bumpPlan_(user, p);                                      // v40 read-only: what moves if I book here
    case 'bumpApply':          return withLock_(function(){ return bumpApply_(user, p); });    // v40 does it, only after Paul confirmed the plan
    case 'schedDay':           return schedDay_(user, p);                                      // v51 read-only: one day of the calendar, for the picker
    case 'schedMonth':         return schedMonth_(user, p);                                    // v52 read-only: the month grid behind the picker
    case 'eventInfo':          return eventInfo_(user, p);                                     // v59 read-only: what job is this booking, whatever created it
    case 'scheduleMove':       return withLock_(function(){ return scheduleMove_(user, p); });   // v92 drag a booking on the block calendar
    case 'scheduleYear':       return scheduleYear_(user, p);                                      // v93 read-only: the year at a glance
    case 'scheduleAddDay':     return withLock_(function(){ return scheduleAddDay_(user, p); }); // v95 another day on the same job
    case 'eventInfoMany':      return eventInfoMany_(user, p);                                     // v96 read-only: many bookings' details at once
    case 'scheduleConfirm':    return withLock_(function(){ return scheduleConfirm_(user, p); }); // v92 confirmed / waiting / needs a new time
    case 'eventMove':          return withLock_(function(){ return eventMove_(user, p); });     // v59 move a return visit
    case 'eventCancel':        return withLock_(function(){ return eventCancel_(user, p); });   // v59 call off a return visit
    case 'eventTell':          return withLock_(function(){ return eventTell_(user, p); });     // v63 rang or emailed the customer about a change
    case 'leadEmail':          return leadEmail_(user, p);                                      // v65 read-only: the customer's own words, fetched from the form email
    case 'callList':           return callList_(user);                                         // v40 customers to ring about a moved job
    case 'callDone':           return withLock_(function(){ return callDone_(user, p); });
    case 'repairJobNames':     return withLock_(function(){ return repairJobNames_(user, p); });   // v42
    case 'repairJobPOs':       return repairJobPOs_(user, p);                                         // v44
    case 'timeOffRequest':     return withLock_(function(){ return timeOffRequest_(user, p); });
    case 'timeOffCancel':      return withLock_(function(){ return timeOffCancel_(user, p); });
    case 'timeOffDecide':      return withLock_(function(){ return timeOffDecide_(user, p); });
    case 'allowanceList':      return allowanceList_(user, p);
    case 'allowanceClaim':     return withLock_(function(){ return allowanceClaim_(user, p); });
    case 'allowanceCancel':    return withLock_(function(){ return allowanceCancel_(user, p); });
    case 'allowanceDecide':    return withLock_(function(){ return allowanceDecide_(user, p); });
    case 'invoiceRequest':     return invoiceRequest_(user, p);
    case 'invoiceMaterials':   return invoiceMaterials_(user, p);                                     // v46
    case 'invoiceMaterialsSave': return invoiceMaterialsSave_(user, p);                               // v46 - saves Paul's list, then starts the build
    case 'jobInvoiced':        return withLock_(function(){ return jobInvoiced_(user, p); }); // closes + archives
    case 'jobSetStatus':       return withLock_(function(){ return jobSetStatus_(user, p); }); // Invoiced (sent) <-> Closed (paid)
    case 'jobSetDates':        return withLock_(function(){ return jobSetDates_(user, p); }); // fills a BLANK start/end date only
    case 'fileReceipt':        return fileReceipt_(user, p);
    // materials: company inventory, pricing, per-job usage (Sept 2026 round)
    // v29 — one endpoint for receipts/invoices AND estimates/quotes. The 10-20s AI read runs
    // OUTSIDE the script lock (it used to hold it, which could time out a clock-in happening at
    // the same moment); only the sheet writes are locked, inside scanSupplierDoc_ (docFile_).
    case 'scanSupplierDoc':    return scanSupplierDoc_(user, p);
    case 'scanSupplierPO':     p.kind = p.kind || 'receipt'; p.legacy = true; return scanSupplierDoc_(user, p); // older app builds + their offline queue: no confirm step (they could not answer it)
    case 'inventoryList':      return inventoryList_(user, p);
    case 'priceList':          return priceList_(user, p);
    case 'takeMaterial':       return onceGuard_('takeMaterial', p, function(){ return withLock_(function(){ return takeMaterial_(user, p); }); });   // read-modify-write on the count
    case 'returnToSupplier':   return withLock_(function(){ return returnToSupplier_(user, p); });
    case 'jobMaterials':       return jobMaterials_(user, p);
    case 'jobParts':           return jobParts_(user, p);                                            // v71 - the job's own PO parts, rolled up
    // allowance settings + Alberta stat pay
    case 'allowCfgGet':        return allowCfgGet_(user);
    case 'allowCfgSet':        return allowCfgSet_(user, p);
    case 'statPayRun':         return withLock_(function(){ return statPayRun_(user, p); });
    // website estimate/appointment requests
    case 'requestAdd':         return withLock_(function(){ return requestAdd_(user, p); });
    case 'requestList':        return requestList_(user, p);
    case 'requestSchedule':    return withLock_(function(){ return requestSchedule_(user, p); });
    case 'requestBook':        return withLock_(function(){ return requestBook_(user, p); });
    case 'requestReschedule':  return withLock_(function(){ return requestReschedule_(user, p); });
    case 'contactLookup':      requireAdmin_(user); return contactLookup_(user, p);                                  // v56
    case 'contactAdd':         requireAdmin_(user); return withLock_(function(){ return contactAdd_(user, p); });    // v56
    case 'requestUpdate':      return withLock_(function(){ return requestUpdate_(user, p); });      // v58 - the app's "Correct details" button, which had no action behind it
    case 'requestSetType':     return withLock_(function(){ return requestSetType_(user, p); });     // v60 - estimate <-> appointment, refused where a PO is already spent
    case 'requestRenotify':    return withLock_(function(){ return requestRenotify_(user, p); });
    case 'requestAddManual':   return withLock_(function(){ return requestAddManual_(user, p); });    // v51 Paul adds an emergency call or a job by hand
    case 'requestUnschedule':  return withLock_(function(){ return requestUnscheduleAction_(user, p); }); // v51 take it off the calendar, park it in Requests
    case 'requestTellCustomer':return withLock_(function(){ return requestTellCustomer_(user, p); });  // v51 rang or emailed the customer whose job moved
    case 'requestCancel':      return withLock_(function(){ return requestCancel_(user, p); });
    case 'estimateAudit':      requireAdmin_(user); return withLock_(function(){ var r = estimateAudit_(user); return { calib: r.calib, jobs: r.rows.length }; });
    case 'requestDismiss':     return withLock_(function(){ return requestDismiss_(user, p); });
    case 'logMaterials':     return onceGuard_('logMaterials', p, function(){ return withLock_(function(){ return logMaterials_(user, p); }); }); // getLastRow()+1 write — two simultaneous clock-outs must not collide
    case 'pendingMaterials': return pendingMaterials_(user);
    case 'resolveMaterial':  return withLock_(function(){ return resolveMaterial_(user, p); });
    case 'partsLog':         return partsLog_(user, p);                                   // v84
    case 'partsUndo':        return withLock_(function(){ return partsUndo_(user, p); });
    case 'approvalsLog':     return approvalsLog_(user, p);                               // v85
    case 'approvalUndo':     return withLock_(function(){ return approvalUndo_(user, p); });
    // admin / approvals
    case 'deleteEntry':      return withLock_(function(){ return deleteEntry_(user, p); });                     // v97
    case 'approveEntry':     return withLock_(function(){ return setEntryStatus_(user, p, 'approved'); });
    case 'rejectEntry':      return withLock_(function(){ return setEntryStatus_(user, p, 'rejected'); });
    case 'listEmployees':    return listEmployees_(user);
    case 'addEmployee':      return addEmployee_(user, p);
    case 'updateEmployee':   return updateEmployee_(user, p);
    case 'removeEmployee':   return removeEmployee_(user, p);
    case 'deleteEmployee':   return withLock_(function(){ return deleteEmployee_(user, p); });
    case 'setPermissions':   return setPermissions_(user, p);
    case 'setHourlyRate':    return setHourlyRate_(user, p);
    case 'pendingApprovals': return pendingApprovals_(user);
    case 'approvalsAll':     return approvalsAll_(user);   // v48 - everything waiting on an admin, for the Requests tab
    // v76 - Neo's inbox report
    case 'neoReportPost':    return withLock_(function(){ return neoReportPost_(user, p); });
    case 'neoReport':        return neoReport_(user);
    case 'neoDecide':        return withLock_(function(){ return neoDecide_(user, p); });
    case 'neoReply':         return neoReply_(user, p);
    case 'pushSubscribe':    return withLock_(function(){ return pushSubscribe_(user, p); });   // v79
    case 'pushUnsubscribe':  return withLock_(function(){ return pushUnsubscribe_(user, p); });
    case 'hoursOverview':    return hoursOverview_(user, p);
    case 'activityLog':      return activityLog_(user, p);
    case 'exportPayroll':    return exportPayroll_(user, p);
    case 'today':            return today_(user, p);                                      // v87 the office home screen
    case 'todayHide':        return withLock_(function(){ return todayHide_(user, p); });
    case 'followUp':         return withLock_(function(){ return followUp_(user, p); });          // v98
    case 'bidSave':          return withLock_(function(){ return bidSave_(user, p); });           // v101 bid deadlines
    case 'estimateList':     return estimateList_(user, p);                               // v89 the Estimates tab
    case 'estimateSend':     return p.preview ? estimateSend_(user, p) : withLock_(function(){ return estimateSend_(user, p); });
    case 'estimateMark':     return withLock_(function(){ return estimateMark_(user, p); });
    case 'retitleCalendar':  return retitleCalendar_(user, p);                            // v89 name first on the calendar
    default: throw new Error('Unknown action: ' + action);
  }
}

// All entry mutations run under one script lock: kills the double-clock-in race (two devices
// checking-then-appending simultaneously) and the lost-update race (clock-out's read-modify-write
// overlapping an admin edit). Ops are sub-second, so contention is negligible.
// v29 — re-entrant at code level. A locked section that reaches another withLock_ (the price
// list's lazy migration is called from inside docFile_, takeMaterial_ …) must neither wait 15 s
// on itself nor release the outer lock early; only the outermost call acquires and releases.
var lockDepth_ = 0;
/* v91 - A PUNCH THAT ALREADY LANDED IS ANSWERED WITHOUT WAITING FOR THE LOCK.
 * Elijah's clock-out on Nov 7 landed at 05:45:31 and its two retries, sent while the first call was
 * still inside the lock, were refused 30 s later with "Lock timeout" - logged as REFUSED punches,
 * although nothing was lost. A replay of a tap that is already on the sheet is now recognised by a
 * plain read before the lock is asked for, and a genuinely new punch waits 25 s instead of 15 and
 * checks once more for itself before it gives up. */
function punchReplay_(user, action, p) {
  try {
    p = p || {};
    if (!p.at) return null;
    if (action === 'clockIn') {
      var dup = findEntryByClockIn_(user.email, p.at);
      return dup ? { entry: dup, duplicate: true } : null;
    }
    if (action === 'clockOut') {
      if (!p.entryId) return null;
      var loc = findEntryRow_(user.email, p.entryId);
      if (!loc) return null;
      var r = loc.values;
      if (r[COL['ClockOut']-1] && sameInstant_(r[COL['ClockOut']-1], p.at))
        return { entryId: p.entryId, hours: Number(r[COL['Hours']-1]) || 0, gross: Number(r[COL['Gross Hours']-1]) || 0,
          breakHrs: Number(r[COL['Break Hrs']-1]) || 0, duplicate: true };
      return null;
    }
    if (action === 'switchJobSite') {
      var seg = findEntryByClockIn_(user.email, p.at);
      return seg ? { entry: seg, duplicate: true } : null;
    }
  } catch (e) {}
  return null;
}
function punchLock_(user, action, p, fn) {
  if (lockDepth_ > 0) return fn();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    var again = punchReplay_(user, action, p);
    if (again) return again;
    throw new Error('Lock timeout: another process was holding the lock for too long.');
  }
  lockDepth_++;
  try { return fn(); } finally { lockDepth_--; lock.releaseLock(); }
}
function withLock_(fn) {
  if (lockDepth_ > 0) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  lockDepth_++;
  try { return fn(); } finally { lockDepth_--; lock.releaseLock(); }
}

/* Guided repair for a forgotten clock-out: the employee tells us when they actually stopped
 * working; we close THAT day's entry there (pending admin approval) so today's punch starts
 * clean — instead of one 20-hour entry merging two days (the Elijah bug, late Aug 2026). */
function fixForgotClockout_(user, p) {
  var loc = findEntryRow_(user.email, p.entryId);
  if (!loc) throw new Error('Entry not found.');
  var row = loc.values;
  var out = new Date(p.outISO);
  if (isNaN(out)) throw new Error('Pick the day and time you stopped working.');
  if (String(row[COL['ClockOut']-1] || '') !== '') {
    // v67 - the app now writes this correction to the phone's queue BEFORE it tries the
    // network (same write-ahead as a punch), so a lost answer means it is sent again. The same
    // stop time is the same correction: answer it with the stored numbers instead of an error,
    // which the app would otherwise show the person as a failure of a fix that did land.
    if (sameInstant_(row[COL['ClockOut']-1], out.toISOString()))
      return { ok: true, hours: Number(row[COL['Hours']-1]) || 0, duplicate: true };
    throw new Error('That entry is already clocked out.');
  }
  var inTime = new Date(row[COL['ClockIn']-1]);
  if (out <= inTime) throw new Error('Stop time must be after the clock-in.');
  if (out - inTime > 16*3600000) throw new Error('That is over 16 hours — pick the day and time you actually stopped.');
  // 5 min of slack for a phone clock that runs fast; a queued fix always arrives in the past.
  if (out.getTime() > Date.now() + 5*60000) throw new Error("Stop time can't be in the future.");
  var br = computeBreaks_(row[COL['Breaks JSON']-1], out);
  var gross = Math.round(((out - inTime) / 3600000) * 100) / 100;
  var breakHrs = Math.min(br.hours, gross);
  var net = Math.max(0, Math.round((gross - breakHrs) * 100) / 100);
  var updated = row.slice();
  updated[COL['ClockOut']-1] = out.toISOString();
  updated[COL['Hours']-1] = net;
  updated[COL['Gross Hours']-1] = gross;
  updated[COL['Break Hrs']-1] = breakHrs;
  updated[COL['Breaks JSON']-1] = JSON.stringify(br.arr);
  updated[COL['Status']-1] = 'pending'; // retroactive — the admin confirms it
  updated[COL['Notes']-1] = txt_(appendNote_(row[COL['Notes']-1], 'forgot clock-out — fixed in app'));
  var unF = unendedNote_(br, breakHrs);                                  // v91
  if (unF) updated[COL['Notes']-1] = txt_(appendNote_(updated[COL['Notes']-1], unF));
  updated[COL['Last Edited By']-1] = user.email;
  updated[COL['Last Edited At']-1] = new Date().toISOString();
  loc.sheet.getRange(loc.row, 1, 1, ENTRY_HEADERS.length).setValues([updated]);
  refreshSummaries_(user);
  log_(user, 'fixForgotClockout', user.email, String(p.entryId), gross + 'h closed retroactively');
  return { ok: true, hours: net };
}

// Late GPS fix: the app records the entry immediately (no GPS wait) and patches the location
// in once the phone gets a proper fix. Only fills EMPTY GPS cells — never overwrites.
function patchGps_(user, p) {
  var loc = findEntryRow_(user.email, p.entryId);
  if (!loc) throw new Error('Entry not found.');
  var col = p.which === 'out' ? COL['GPS Out'] : COL['GPS In'];
  if (String(loc.values[col-1] || '') === '') {
    loc.sheet.getRange(loc.row, col).setValue(gpsStr_(p.gps));
    return { patched: true };
  }
  return { patched: false };
}

// ---------------------------------- Bootstrap --------------------------------------------------

function bootstrap_(user) {
  try { warmEnsureTrigger_(); } catch (e) {}   // v96 - installs the keep-awake timer once
  var entries = listEntries_(user, { email: user.email }).entries;
  // Derive the open entry from the list we already have (entries are newest-first) instead of
  // re-reading the whole sheet via findOpenEntry_ — saves a full-tab read on every load.
  var open = null;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.ClockIn && !e.ClockOut && e.Source === 'live') { open = e; break; }
  }
  var out = {
    me: publicUser_(user),
    companies: CONFIG.COMPANIES,
    config: { payPeriodType: CONFIG.PAY_PERIOD_TYPE, otThreshold: CONFIG.OT_WEEKLY_THRESHOLD,
      forgotClockoutHours: CONFIG.FORGOT_CLOCKOUT_HOURS, allowances: allowCfg_() },
    entries: entries,
    openEntry: open,
  };
  if (user.role === 'admin' || (user.permissions && user.permissions.viewAllEmployees)) {
    out.employees = listEmployees_(user).employees;
  }
  // Cellphone allowance is a fixed monthly benefit, not a claim — post it on first use each
  // month for whoever is entitled to it. Cheap: one sheet read, and only when it's missing.
  allowMonthlyPhone_(user);
  // Count of website leads waiting to be scheduled, so the app can nudge Paul on open.
  // v54 - this used to call requestList_, which reads every row of the Requests tab across all
  // 33 columns AND the whole Call List, to arrive at one number. bootstrap_ runs on every app
  // open and every background refresh, so that was the most-repeated wasted read in the script.
  // One column is enough.
  if (user.permissions && user.permissions.approveHours) {
    try {
      var rsh = reqSheet_(), rlast = rsh.getLastRow(), waiting = 0, ests = 0;
      if (rlast >= 2) {
        // v89 - a request for an estimate waits on the Estimates tab, a job on Requests: two counts.
        var st = rsh.getRange(2, 4, rlast - 1, 12).getValues();      // 4 = Type ... 15 = Status
        for (var si = 0; si < st.length; si++) if (String(st[si][11]) === 'pending') {
          if (String(st[si][0]).toUpperCase() === 'ESTIMATE') ests++; else waiting++;
        }
      }
      out.pendingRequests = waiting; out.pendingEstimates = ests;
    } catch (e) {}
  }
  // NOTE: pending approvals are intentionally NOT loaded here — that scanned every employee's
  // tab (N sheet reads) on every app open. The frontend fetches 'pendingApprovals' on demand
  // when an admin opens the Admin tab.
  return out;
}

function publicUser_(u) {
  return { email: u.email, name: u.name, role: u.role, permissions: u.permissions,
    hourlyRate: u.hourlyRate, picture: u.picture || '' };
}

// ---------------------------------- Clock in / out ---------------------------------------------


// Employees without the viewAllCompanies permission can only book internal time to the
// primary company (COMPANIES[0] = shop work). Admins + flagged employees get all of them.
function companyGuard_(user, company) {
  if (!company) return;
  if (user.role === 'admin' || (user.permissions && user.permissions.viewAllCompanies)) return;
  var home = (user.permissions && user.permissions.homeCompany) || CONFIG.COMPANIES[0];
  if (lc_(company) !== lc_(home))
    throw new Error('Your account books ' + home + ' time only — ask an admin if you need another company.');
}

function clockIn_(user, p) {
  companyGuard_(user, p.company);
  // v30 — IDEMPOTENT ON THE TAP TIME. The phone keeps every punch queued until the office
  // answers, and retries it after a timeout or a dropped connection. If the first attempt did
  // land, the retry must get the SAME entry back — not "already have an open entry", which
  // the old app read as a rejection and dropped (or, worse, a second entry).
  var dup = p.at ? findEntryByClockIn_(user.email, p.at) : null;
  if (dup) return { entry: dup, duplicate: true };
  var open = findOpenEntry_(user.email);
  if (open) throw new Error('You already have an open entry. Clock out first or switch job site.');
  // Punch time = the moment the button was tapped on the phone (p.at), not when the request
  // reaches the server — critical for offline entries that sync hours later.
  var now = clientTime_(p.at);
  jobResolveTyped_(p);   // v42 - "R26184" typed as the job becomes R26184 / Koltin Hachey
  // If a brand-new customer was entered (e.g. created while offline), assign its PO + Drive folder now.
  if (p.newCustomer && p.jobSite && !p.poNumber) {
    try {
      var c = createCustomerCore_(user, { name: p.jobSite, type: p.newType }); // already inside withLock_
      if (c && c.customer) p.poNumber = c.customer.po;
      else if (c && c.duplicate) {
        // Someone (or another device) already created this customer — adopt the existing
        // PO instead of forking a duplicate. Logged so admins can double-check the match.
        p.jobSite = c.existing.name; p.poNumber = c.existing.po;
        log_(user, 'dupCustomerAdopted', user.email, c.existing.po, p.jobSite);
      }
    } catch (e) {
      // Never block a clock-in on PO assignment — but never fail silently either.
      log_(user, 'poAssignFailed', user.email, '', p.jobSite + ': ' + e.message);
    }
  }
  var entry = {
    EntryID: newId_(), Date: fmtDate_(now), Day: dayName_(now), ClockIn: now.toISOString(),
    ClockOut: '', Hours: '', Company: p.company || '', 'Customer/Job Site': p.jobSite || '',
    'PO#': p.poNumber || '', Notes: p.notes || '', 'GPS In': gpsStr_(p.gps), 'GPS Out': '',
    Media: '', Status: 'approved', Source: 'live', PeriodKey: periodKey_(now),
    'Approved By': 'auto', 'Approved At': now.toISOString(), 'Reject Note': '',
    'Last Edited By': user.email, 'Last Edited At': now.toISOString()
  };
  appendEntry_(user, entry);
  log_(user, 'clockIn', user.email, entry.EntryID, p.jobSite || p.company);
  refreshSummaries_(user);
  return { entry: entry };
}

// Parse a Breaks JSON cell → { arr, hours, open, unended }. If closeAt is given, any still-open
// break is closed at that time (used at clock-out so a forgotten break can't run forever).
// v91 - Paul, Nov 7: "don't guess, just flag it". A break that was started and never ended used to
// be closed AT THE CLOCK-OUT and counted whole - 4.07 h of Paul's C26197 shift went that way. It is
// still closed there (marked auto: true, so the record says what happened), but it counts as ZERO,
// and the entry is flagged on the Today screen for a person to put the real break in.
function computeBreaks_(breaksJson, closeAt) {
  var arr = []; try { arr = JSON.parse(breaksJson || '[]') || []; } catch (e) { arr = []; }
  var ms = 0, open = false, unended = [];
  arr.forEach(function(b){
    if (!b.e && closeAt) { b.e = new Date(closeAt).toISOString(); b.auto = true; unended.push(b.s); return; }
    if (!b.e) { open = true; return; }
    if (b.auto) return;                           // closed by the clock-out, never ended by a person
    ms += Math.max(0, new Date(b.e) - new Date(b.s));
  });
  return { arr: arr, hours: Math.round(ms / 36000) / 100, open: open, unended: unended };
}
function unendedNote_(br, breakHrs) {
  if (!br || !br.unended || !br.unended.length) return '';
  var tz = Session.getScriptTimeZone();
  var when = br.unended.map(function (s) { var d = new Date(s); return isNaN(d) ? String(s) : Utilities.formatDate(d, tz, 'h:mm a'); }).join(', ');
  return '⚠ break started ' + when + ' was never ended - counted as ' + Math.round((Number(breakHrs) || 0) * 60) +
    ' min of break; check it';
}

function startBreak_(user, p) {
  var loc = findEntryRow_(user.email, p.entryId);
  if (!loc) throw new Error('Entry not found.');
  if (loc.values[COL['ClockOut']-1]) throw new Error('Already clocked out.');
  var br = computeBreaks_(loc.values[COL['Breaks JSON']-1]);
  if (br.open) throw new Error('Already on break.');
  // Tap time from the phone (p.at), same as clock in/out — an offline break that syncs
  // an hour later must not be recorded as starting at sync time.
  br.arr.push({ s: clientTime_(p.at).toISOString() });
  loc.sheet.getRange(loc.row, COL['Breaks JSON']).setValue(JSON.stringify(br.arr));
  log_(user, 'startBreak', user.email, p.entryId, '');
  return { breaks: br.arr };
}

function endBreak_(user, p) {
  var loc = findEntryRow_(user.email, p.entryId);
  if (!loc) throw new Error('Entry not found.');
  var br = computeBreaks_(loc.values[COL['Breaks JSON']-1]);
  if (!br.open) throw new Error('Not on break.');
  var endAt = clientTime_(p.at); // tap time — see startBreak_
  var startAt = new Date(br.arr[br.arr.length-1].s);
  if (endAt < startAt) endAt = startAt; // never let a skewed clock make a negative break
  br.arr[br.arr.length-1].e = endAt.toISOString();
  var done = computeBreaks_(JSON.stringify(br.arr));
  loc.sheet.getRange(loc.row, COL['Breaks JSON']).setValue(JSON.stringify(br.arr));
  log_(user, 'endBreak', user.email, p.entryId, done.hours + 'h total');
  return { breaks: br.arr, breakHrs: done.hours };
}

// p: { entryId, gps, at?, notes?, paused?, clockInAt?, breakMin?, jobSite?, poNumber?, company? }
// The review-and-submit screen sends the optional overrides: `at` is the moment Clock Out was
// confirmed (form-filling time doesn't count as work), clockInAt/breakMin/job fields are the
// employee's corrections. A plain pause (switch job site) sends none of them.
function clockOut_(user, p) {
  if (p.jobSite !== undefined) jobResolveTyped_(p);   // v42
  var loc = findEntryRow_(user.email, p.entryId);
  if (!loc) throw new Error('Entry not found.');
  var row = loc.values;
  if (row[COL['ClockOut']-1]) {
    // v30 — a replay of THIS clock-out (same tap time) is answered with the stored numbers,
    // so a retry after a lost response is harmless. A different time is a genuine duplicate.
    if (p.at && sameInstant_(row[COL['ClockOut']-1], p.at)) {
      return { entryId: p.entryId, hours: Number(row[COL['Hours']-1]) || 0, gross: Number(row[COL['Gross Hours']-1]) || 0,
        breakHrs: Number(row[COL['Break Hrs']-1]) || 0, duplicate: true };
    }
    throw new Error('Already clocked out.');
  }
  var now = p.at ? new Date(p.at) : new Date();
  if (isNaN(now)) now = new Date();
  // Past is fine (offline entries sync late); the far future is not (would pad hours). Clamp
  // rather than throw so a phone with a skewed clock can still clock out.
  // v67 - the window was five minutes, so a finish rounded up to the half hour was quietly
  // pulled back to "now" and the entry did not say what the person had typed. CONFIG now.
  if (now.getTime() > Date.now() + (Number(CONFIG.CLOCKOUT_AHEAD_MIN) || 5) * 60000) now = new Date();
  var inTime = new Date(row[COL['ClockIn']-1]);
  if (p.clockInAt) {
    inTime = new Date(p.clockInAt);
    if (isNaN(inTime)) throw new Error('Invalid clock-in time.');
  }
  if (!(now > inTime)) throw new Error('Clock-out must be after clock-in — check the times.');
  var gross = Math.round(((now - inTime) / 3600000) * 100) / 100;
  var br = computeBreaks_(row[COL['Breaks JSON']-1], now.toISOString()); // close any open break
  var breakHrs = br.hours;
  var autoBreakHrs = br.hours;                                          // v91 - for the Edit Log below
  if (p.breakMin !== undefined && p.breakMin !== null && p.breakMin !== '') {
    // Reviewed break total from the summary screen (e.g. forgot to hit Resume). The raw
    // break intervals stay in Breaks JSON untouched, so the auto-tracked truth is auditable.
    breakHrs = Math.round((Math.max(0, Number(p.breakMin) || 0) / 60) * 100) / 100;
    // Break exceeding the shift is warned-and-confirmed on the review screen, not blocked —
    // clamp so the entry clocks in at 0 net hours instead of refusing the clock-out.
    if (breakHrs > gross) breakHrs = gross;
  }
  var net = Math.max(0, Math.round((gross - breakHrs) * 100) / 100);
  // Batch all cell updates into one write (each setValue is a separate slow API op).
  var updated = row.slice();
  if (p.clockInAt) updated[COL['ClockIn']-1] = inTime.toISOString();
  updated[COL['ClockOut']-1] = now.toISOString();
  updated[COL['Hours']-1] = net;
  updated[COL['Gross Hours']-1] = gross;
  updated[COL['Break Hrs']-1] = breakHrs;
  updated[COL['Breaks JSON']-1] = JSON.stringify(br.arr);
  updated[COL['GPS Out']-1] = gpsStr_(p.gps);
  if (p.jobSite !== undefined)  updated[COL['Customer/Job Site']-1] = txt_(p.jobSite);
  if (p.poNumber !== undefined) updated[COL['PO#']-1] = txt_(p.poNumber);
  if (p.company !== undefined)  updated[COL['Company']-1] = txt_(p.company);
  if (p.notes) updated[COL['Notes']-1] = txt_(appendNote_(row[COL['Notes']-1], p.notes));
  var unN = unendedNote_(br, breakHrs);                                 // v91 - flagged on Today too
  if (unN) updated[COL['Notes']-1] = txt_(appendNote_(updated[COL['Notes']-1], unN));
  updated[COL['Last Edited By']-1] = user.email;
  updated[COL['Last Edited At']-1] = new Date().toISOString();
  if (gross > CONFIG.FORGOT_CLOCKOUT_HOURS) {
    // Marathon "shift" = almost certainly a forgotten clock-out merging two days. Don't let
    // it auto-approve into payroll — flag it for the admin.
    updated[COL['Status']-1] = 'pending';
    updated[COL['Notes']-1] = txt_(appendNote_(updated[COL['Notes']-1], '⚠ ' + gross + 'h shift — check for forgotten clock-out'));
  }
  // Segments closed via "Pause & Switch" are marked 'paused' (still resumable in the UI);
  // a proper clock-out keeps Source 'live'. This is what the "Paused today" list keys on.
  if (p.paused) updated[COL['Source']-1] = 'paused';
  loc.sheet.getRange(loc.row, 1, 1, ENTRY_HEADERS.length).setValues([updated]);
  // v91 - a clock-in moved, or a tracked break changed, on the clock-out review is a correction to
  // the record like any other, so it goes in the Edit Log with what it said before. (The audit found
  // four entries whose clock-in sat hours before they were written and nothing said why.)
  try {
    var rv = [], origIn = row[COL['ClockIn']-1];
    if (p.clockInAt && origIn && !sameInstant_(origIn, inTime))
      rv.push({ field: 'Clock in', was: editShow_(origIn, 'time'), now: editShow_(inTime.toISOString(), 'time') });
    if (br.arr.length && Math.abs(breakHrs - autoBreakHrs) >= 5 / 60)
      rv.push({ field: 'Break', was: editShow_(autoBreakHrs, 'mins') + ' (tracked)', now: editShow_(breakHrs, 'mins') });
    if (rv.length) {
      var elg = editLogSheet_(), batch = newId_(), at = new Date().toISOString();
      elg.getRange(elg.getLastRow() + 1, 1, rv.length, EDITLOG_HEADERS.length).setValues(rv.map(function (c) {
        return [batch, at, String(p.entryId), user.email, user.email, 'changed on the clock-out review', c.field, c.was, c.now];
      }));
    }
  } catch (e) {}
  log_(user, p.paused ? 'pauseJob' : 'clockOut', user.email, p.entryId, net + ' hrs net (' + gross + ' gross, ' + breakHrs + ' break)');
  refreshSummaries_(user);
  return { entryId: p.entryId, hours: net, gross: gross, breakHrs: breakHrs,
    weekOvertime: weekOvertimeFlag_(user.email, now) };
}

function switchJobSite_(user, p) {
  var open = findOpenEntry_(user.email);
  // v30 — a replay of this same switch (the open segment already starts at this tap time)
  // is answered with that segment, not by pausing it again.
  if (open && p.at && sameInstant_(open.ClockIn, p.at)) return { entry: open, duplicate: true };
  if (open) clockOut_(user, { entryId: open.EntryID, gps: p.gps, paused: true, at: p.at }); // pause, not end
  return clockIn_(user, p); // p.at also stamps the new segment — one boundary, same instant
}

// ---------------------------------- Manual entries + edits -------------------------------------

function addManualEntry_(user, p) {
  // v48 - an admin can add time FOR another employee (payload employeeEmail). It lands on that
  // employee's tab, approved (the admin entering it is the approval), and the employee is emailed.
  var forEmail = lc_(p.employeeEmail || '');
  var forOther = !!forEmail && forEmail !== lc_(user.email);
  if (forOther) {
    requireAdmin_(user);
    var tgt = getEmployeeRecordCached_(forEmail);
    if (!tgt) throw new Error('No employee ' + forEmail + '.');
  }
  companyGuard_(user, p.company);
  jobResolveTyped_(p);   // v42
  var d = p.date ? new Date(p.date + 'T00:00:00') : new Date();
  var inISO = combineDateTime_(p.date, p.clockIn);
  var outISO = combineDateTime_(p.date, p.clockOut);
  // Overnight shift: out earlier than (or equal to) in means it ended the NEXT day.
  // Without this, a 22:00–06:00 manual entry computed NEGATIVE hours.
  if (inISO && outISO && new Date(outISO) <= new Date(inISO)) {
    outISO = new Date(new Date(outISO).getTime() + 86400000).toISOString();
  }
  var gross = (inISO && outISO) ? Math.round(((new Date(outISO) - new Date(inISO)) / 3600000) * 100) / 100 : '';
  var breakHrs = p.breakMin ? Math.round((Number(p.breakMin) / 60) * 100) / 100 : 0;
  var hours = (gross === '') ? '' : Math.max(0, Math.round((gross - breakHrs) * 100) / 100);
  // v45 — an admin's OWN manual entry lands approved: Paul was submitting his time and then
  // approving it himself in the Admin tab. Anyone else's still goes to 'pending' as before.
  var selfApprove = user.role === 'admin';
  var nowISO = new Date().toISOString();
  if (forOther) selfApprove = true;
  var entry = {
    EntryID: newId_(), Date: fmtDate_(d), Day: dayName_(d), ClockIn: inISO || '', ClockOut: outISO || '',
    Hours: hours, Company: p.company || '', 'Customer/Job Site': p.jobSite || '', 'PO#': p.poNumber || '',
    Notes: p.notes || '', 'GPS In': '', 'GPS Out': '', Media: '',
    Status: selfApprove ? 'approved' : 'pending', Source: 'manual', PeriodKey: periodKey_(d),
    'Approved By': selfApprove ? user.email : '', 'Approved At': selfApprove ? nowISO : '', 'Reject Note': '',
    'Last Edited By': user.email, 'Last Edited At': nowISO,
    'Gross Hours': gross, 'Break Hrs': breakHrs || '', 'Breaks JSON': ''
  };
  if (forOther) {
    appendEntry_({ email: forEmail }, entry);
    log_(user, 'addManualEntry', forEmail, entry.EntryID, 'added by admin for ' + forEmail + ' (approved)');
    refreshSummaries_({ email: forEmail });
    try {
      MailApp.sendEmail(forEmail, 'Time added to your timesheet — ' + entry.Date,
        user.email + ' added time to your timesheet:\n\n  ' + entry.Date + '  ' + (p.clockIn || '') + '–' + (p.clockOut || '') +
        '  (' + hours + ' h)\n  ' + (p.jobSite || p.company || '') + (p.poNumber ? ' · PO ' + p.poNumber : '') +
        (p.notes ? '\n  Note: ' + p.notes : '') + '\n\nYou can see it in the app under Entries.', { name: 'PCW / PRO Timesheet' });
    } catch (e) {}
    return { entry: entry, forEmail: forEmail };
  }
  appendEntry_(user, entry);
  log_(user, 'addManualEntry', user.email, entry.EntryID, selfApprove ? 'self-approved (admin)' : 'pending approval');
  if (selfApprove) refreshSummaries_(user); // approved hours change the tab summary right away
  return { entry: entry };
}

function editEntry_(user, p) {
  // Whose entry? admins can edit anyone; employees only their own.
  var targetEmail = (p.employeeEmail || user.email).toLowerCase();
  var isSelf = targetEmail === user.email;
  if (!isSelf) requirePerm_(user, 'editPastEntries');
  if (p.company !== undefined) companyGuard_(user, p.company);

  if (p.jobSite !== undefined) jobResolveTyped_(p);   // v42
  var loc = findEntryRow_(targetEmail, p.entryId);
  if (!loc) throw new Error('Entry not found.');
  var updated = loc.values.slice();
  var wasApproved = String(updated[COL['Status']-1]) === 'approved';

  var fields = ['Company','Customer/Job Site','PO#','Notes','ClockIn','ClockOut','Date'];
  fields.forEach(function(f){
    if (p[keyFor_(f)] !== undefined) updated[COL[f]-1] = txt_(p[keyFor_(f)]);
  });
  if (p.date) updated[COL['Day']-1] = dayName_(new Date(p.date + 'T00:00:00'));
  // recompute hours + period if times present (Hours = net of breaks)
  var newIn = updated[COL['ClockIn']-1];
  var newOut = updated[COL['ClockOut']-1];
  if (newIn && newOut) {
    var ti = new Date(newIn), to = new Date(newOut);
    if (isNaN(ti) || isNaN(to)) throw new Error('Invalid clock in/out time.');
    if (!(to > ti)) throw new Error('Clock-out must be after clock-in — check the days and times.');
    var gross = Math.round(((to - ti) / 3600000) * 100) / 100;
    // v75 - both ends of a shift now carry their own DAY (v81 of the app), which is what Charles
    // asked for and which also means a mistyped year can no longer slide a 2000-hour entry into
    // payroll. Nothing legitimate is one entry of more than a day; the app warns above 16 h.
    if (gross > 24) throw new Error('That is ' + gross + ' hours on one entry — check the days. ' +
      'A shift longer than a day has to be entered as separate days.');
    var breakHrs = p.breakMin !== undefined ? Math.round((Math.max(0, Number(p.breakMin) || 0)/60)*100)/100
      : (Number(updated[COL['Break Hrs']-1]) || 0);
    if (breakHrs > gross) throw new Error('Break time is longer than the whole shift — check the times.');
    updated[COL['Hours']-1] = Math.max(0, Math.round((gross - breakHrs) * 100) / 100);
    updated[COL['Gross Hours']-1] = gross;
    updated[COL['Break Hrs']-1] = breakHrs || '';
    updated[COL['PeriodKey']-1] = periodKey_(ti);
  }
  // v74 - what actually changed, worked out BEFORE the row is overwritten, and before the
  // status is touched: these are the fields a person cares about, not the bookkeeping.
  var changes = editDiff_(loc.values, updated);
  var reason = String(p.reason || '').trim();
  /* Any edit to an already-approved entry goes back to 'pending' so it is re-checked — the
   * correction is never lost, but it cannot silently change approved payroll hours.
   *
   * v77 - INCLUDING AN ADMIN'S OWN. It used to be waved through for admins, on the grounds that
   * an admin is the approver, which left an admin's own corrections invisible on the Requests
   * tab: Charles changed one minute on 27 Oct as a test and nothing appeared. Now it lands
   * pending with its before-and-after on the card, which is the record he was looking for.
   * Either admin can approve it, so it is a prompt and a record rather than a lock.
   *
   * Only when something actually changed: opening an entry and saving it untouched leaves the
   * status, the approver and the Edit Log alone. */
  var reflagged = false;
  if (wasApproved && changes.length) {
    updated[COL['Status']-1] = 'pending';
    updated[COL['Approved By']-1] = '';
    updated[COL['Approved At']-1] = '';
    reflagged = true;
  }
  updated[COL['Last Edited By']-1] = user.email;
  var editedAt = new Date().toISOString();
  updated[COL['Last Edited At']-1] = editedAt;
  loc.sheet.getRange(loc.row, 1, 1, ENTRY_HEADERS.length).setValues([updated]); // one batched write
  var logNote = '';
  if (changes.length) {
    // The audit row must never cost somebody their correction: if this write fails the edit
    // still stands, and the Activity Log says the diff was lost.
    try {
      var elg = editLogSheet_(), batch = newId_();
      elg.getRange(elg.getLastRow() + 1, 1, changes.length, EDITLOG_HEADERS.length).setValues(
        changes.map(function (c) {
          return [batch, editedAt, String(p.entryId), targetEmail, user.email, reason, c.field, c.was, c.now];
        }));
    } catch (e) { logNote = ' — Edit Log not written (' + e.message + ')'; }
  }
  log_(user, 'editEntry', targetEmail, p.entryId,
    (isSelf ? 'self-edit' : 'admin-edit') + (reflagged ? ' — re-flagged for approval' : '') +
    (changes.length ? (' — ' + changes.map(function (c) { return c.field + ': ' + c.was + ' → ' + c.now; }).join('; ')) : ' — nothing changed') +
    (reason ? (' — reason: ' + reason) : '') + logNote);
  refreshSummaries_({ email: targetEmail });
  return { ok: true, reflagged: reflagged, changes: changes, reason: reason };
}

/* ============================================================================================
 * v74 - WHAT CHANGED, AND WHY  (the "Edit Log" tab)
 *
 * An edited entry went back for approval showing only its new numbers, so approving one meant
 * taking it on trust: there was nothing anywhere that said what the old numbers were. Every
 * edit now writes one row PER CHANGED FIELD - was, now, who, when and the reason they gave -
 * and the approvals screen shows that beside the entry.
 *
 * It is a separate tab rather than another column on the entry, on purpose: the per-employee
 * tabs are written a whole row at a time at ENTRY_HEADERS width, so adding a column there means
 * migrating every tab and risking every punch write. This costs one sheet read on the approvals
 * call (which already reads every employee tab) and nothing at all anywhere else. It is also an
 * audit trail: edit an entry three times and all three are there, oldest first.
 *
 * Charles, 26 Oct: "We would also like to see what is the change that is asked for under the
 * requests tab: the original entry and the updated one."
 * ==========================================================================================*/
var EDITLOG_HEADERS = ['Batch','At','EntryID','Employee','Edited by','Reason','Field','Was','Now'];
function editLogSheet_() {
  var sh = masterSheet_(SHEETS.EDITLOG);
  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1,EDITLOG_HEADERS.length).setValues([EDITLOG_HEADERS]).setFontWeight('bold');
    // v82 - "At", "Was" and "Now" hold words a person reads ("Mon Oct 26, 1:00 PM"), not
    // instants. Left as General, Sheets parses them back into datetimes, and what comes out of
    // getValues() is a Date whose String() is "Mon Oct 26 2026 13:00:00 GMT-0600 (Mountain
    // Daylight Time)" - which is what the approval card was showing Charles.
    try { sh.getRange(2, 2, sh.getMaxRows()-1, 1).setNumberFormat('@'); } catch (e) {}
    try { sh.getRange(2, 8, sh.getMaxRows()-1, 2).setNumberFormat('@'); } catch (e) {}
  }
  return sh;
}
/* A cell that Sheets turned back into a date, said the way the rest of the app says it: the day
 * and the time and nothing else. No zone, no offset, no "Mountain Daylight Time" - Alberta does
 * not change its clocks any more, so the label is both noise and, since 1 Nov 2026, wrong
 * (the zone database now calls the province's permanent -6 "CST"). */
function editCell_(v, field) {
  if (!(v instanceof Date)) return String(v === null || v === undefined ? '' : v);
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(v, tz, field === 'Date' ? 'EEE MMM d, yyyy' : 'EEE MMM d, h:mm a');
}
/* The fields worth showing a human, in the order an approver reads them. */
var EDIT_WATCH_ = [
  { col: 'Date',              label: 'Date',      how: 'day'  },
  { col: 'ClockIn',           label: 'Clock in',  how: 'time' },
  { col: 'ClockOut',          label: 'Clock out', how: 'time' },
  { col: 'Break Hrs',         label: 'Break',     how: 'mins' },
  { col: 'Hours',             label: 'Hours',     how: 'hrs'  },
  { col: 'Customer/Job Site', label: 'Job',       how: ''     },
  { col: 'PO#',               label: 'PO',        how: ''     },
  { col: 'Company',           label: 'Company',   how: ''     },
  { col: 'Notes',             label: 'Notes',     how: ''     }
];
/* Readable on the sheet as well as in the app - a bare ISO timestamp tells nobody anything. */
function editShow_(v, how) {
  if (v === null || v === undefined || v === '') return '(blank)';
  var tz = Session.getScriptTimeZone();
  if (how === 'time') { var d = new Date(v); return isNaN(d) ? String(v) : Utilities.formatDate(d, tz, 'EEE MMM d, h:mm a'); }
  if (how === 'day') {
    var raw = String(v), d2 = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? (raw + 'T12:00:00') : v);
    return isNaN(d2) ? raw : Utilities.formatDate(d2, tz, 'EEE MMM d, yyyy');
  }
  if (how === 'mins') { return Math.round((Number(v) || 0) * 60) + ' min'; }
  if (how === 'hrs')  { return (Math.round((Number(v) || 0) * 100) / 100) + ' hrs'; }
  return String(v);
}
/* Same instant, same number, same text? Then nothing changed and nothing is logged. */
function editSame_(a, b, how) {
  if (how === 'time') {
    var da = new Date(a), db = new Date(b);
    if (!isNaN(da) && !isNaN(db)) return Math.abs(da.getTime() - db.getTime()) < 1000;
  }
  if (how === 'mins' || how === 'hrs') return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
  if (how === 'day') return editShow_(a, 'day') === editShow_(b, 'day');
  return String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
}
function editDiff_(before, after) {
  var out = [];
  EDIT_WATCH_.forEach(function (f) {
    var i = COL[f.col] - 1;
    if (editSame_(before[i], after[i], f.how)) return;
    var was = editShow_(before[i], f.how), now = editShow_(after[i], f.how);
    // v77 - the instant moved but what a person READS did not. Charles's test edit on 27 Oct
    // logged "Clock out: 5:20 PM -> 5:20 PM", because the comparison is to the second and the
    // display is to the minute. A line that shows no change is worse than no line: it makes
    // the whole comparison look untrustworthy.
    if (was === now) return;
    out.push({ field: f.label, was: was, now: now });
  });
  return out;
}
/* The LATEST edit for every entry that has one, in a single read. Bounded to the last 3000 rows
 * so a year of edits cannot make the approvals screen slow. */
function editLogLatest_() {
  var out = {};
  try {
    var sh = editLogSheet_(), last = sh.getLastRow();
    if (last < 2) return out;
    var first = Math.max(2, last - 3000 + 1);
    var vals = sh.getRange(first, 1, last - first + 1, EDITLOG_HEADERS.length).getValues();
    vals.forEach(function (r) {
      var entry = String(r[2] || ''); if (!entry) return;
      var batch = String(r[0] || '');
      var at = (r[1] instanceof Date) ? r[1].toISOString() : String(r[1] || '');
      var rec = out[entry];
      if (!rec || rec.batch !== batch) {
        // rows are appended in order, so a new batch id for this entry supersedes the last one
        if (!rec || at >= rec.at) rec = out[entry] = { batch: batch, at: at, by: String(r[4] || ''), reason: String(r[5] || ''), changes: [] };
        else return;
      }
      var fld = String(r[6] || '');
      rec.changes.push({ field: fld, was: editCell_(r[7], fld), now: editCell_(r[8], fld) });
    });
  } catch (e) {}
  return out;
}

function setEntryStatus_(user, p, status) {
  requirePerm_(user, 'approveHours');
  if (!p.employeeEmail) throw new Error('No employee given.');
  var loc = findEntryRow_(String(p.employeeEmail).toLowerCase(), p.entryId);
  if (!loc) throw new Error('Entry not found.');
  var now = new Date().toISOString();
  // v85 - what it was BEFORE this tap, so the decision can be taken back. Approve and Reject sit
  // next to each other on a phone and are both one tap on somebody else's pay.
  var was = {
    status: String(loc.sheet.getRange(loc.row, COL['Status']).getValue() || ''),
    by:     String(loc.sheet.getRange(loc.row, COL['Approved By']).getValue() || ''),
    at:     String(loc.sheet.getRange(loc.row, COL['Approved At']).getValue() || ''),
    note:   String(loc.sheet.getRange(loc.row, COL['Reject Note']).getValue() || '')
  };
  loc.sheet.getRange(loc.row, COL['Status']).setValue(status);
  loc.sheet.getRange(loc.row, COL['Approved By']).setValue(user.email);
  loc.sheet.getRange(loc.row, COL['Approved At']).setValue(now);
  if (status === 'rejected' || status === 'deleted') loc.sheet.getRange(loc.row, COL['Reject Note']).setValue(p.note || '');
  log_(user, status, p.employeeEmail, p.entryId, p.note || '');
  var logId = apvLogWrite_(user, p.employeeEmail, p.entryId, status, was, p.note || '');
  refreshSummaries_({ email: p.employeeEmail.toLowerCase() });
  return { ok: true, logId: logId };
}

/* ============== EVERY APPROVAL, AND A WAY BACK (v85) ======================================
 * Paul, 3 Nov: "a log for all the changes we've made, to be able to undo or edit them if we
 * click confirm by accident" - about the HOURS an employee asks to have changed.
 *
 * Approve and Reject are two buttons a thumb apart, on somebody else's pay, and until now the
 * only record was an Activity Log line that cannot put anything back: once an entry said
 * "approved" there was nothing to say what it had said a second earlier. Each decision now keeps
 * what the row was BEFORE it - status, approver, timestamp, rejection note - so undoing restores
 * exactly that, usually "pending", which puts the request back on the Requests tab where it can
 * be read properly, edited and decided again. Nothing is deleted and no hours are touched. */
var APVLOG_HEADERS = ['ID','At','Who','Employee','EntryID','Action','Was Status','Was By','Was At',
                      'Was Note','Note','Undone At','Undone By'];
var AL_ = { ID:0, AT:1, WHO:2, EMP:3, ENTRY:4, ACTION:5, WSTAT:6, WBY:7, WAT:8, WNOTE:9, NOTE:10,
            UNAT:11, UNBY:12 };
function apvLogSheet_() {
  var sh = masterSheet_(SHEETS.APVLOG);
  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1,APVLOG_HEADERS.length).setValues([APVLOG_HEADERS]).setFontWeight('bold');
    try { sh.getRange(2, 2, sh.getMaxRows()-1, 1).setNumberFormat('@'); } catch (e) {}
    try { sh.getRange(2, 9, sh.getMaxRows()-1, 1).setNumberFormat('@'); } catch (e) {}
  }
  return sh;
}
function apvLogRows_() {
  var sh = apvLogSheet_(), last = sh.getLastRow();
  return { sheet: sh, rows: last < 2 ? [] : sh.getRange(2,1,last-1,APVLOG_HEADERS.length).getValues() };
}
function apvLogWrite_(user, email, entryId, action, was, note) {
  try {
    var sh = apvLogSheet_(), id = newId_();
    sh.getRange(sh.getLastRow() + 1, 1, 1, APVLOG_HEADERS.length).setValues([[
      id, new Date().toISOString(), user.email, lc_(email), String(entryId || ''), action,
      was.status, was.by, was.at, txt_(was.note), txt_(note || ''), '', '' ]]);
    return id;
  } catch (e) { return ''; }
}
/* action: "approvalsLog" - what has been decided lately, newest first. */
function approvalsLog_(user, p) {
  requirePerm_(user, 'approveHours');
  var t = apvLogRows_(), names = employeeNameMap_(), out = [];
  for (var i = t.rows.length - 1; i >= 0 && out.length < 40; i--) {
    var r = t.rows[i];
    if (!String(r[AL_.ID] || '')) continue;
    var em = String(r[AL_.EMP] || '');
    out.push({ id: String(r[AL_.ID]), at: String(r[AL_.AT] || ''), who: String(r[AL_.WHO] || ''),
      employee: em, name: names[em] || em.split('@')[0], entryId: String(r[AL_.ENTRY] || ''),
      action: String(r[AL_.ACTION] || ''), wasStatus: String(r[AL_.WSTAT] || ''),
      note: String(r[AL_.NOTE] || ''), undoneAt: String(r[AL_.UNAT] || ''),
      undoneBy: String(r[AL_.UNBY] || '') });
  }
  return { decisions: out };
}
/* action: "approvalUndo"  payload: { id } */
/* v97 - DELETE AN ENTRY. Paul, 7 Nov, looking at a 0.7 h entry that was all break: "I want an
 * option to be able to delete them as it was obviously a mistake." Nothing is removed from the
 * sheet: the row's Status becomes 'deleted', which every total, pay period, job cost, hours check
 * and the app's lists already treat the way they treat 'rejected' - it simply no longer counts -
 * and the decision goes on the Approval Log with what the row said before, so the same Undo that
 * puts an approval back puts a deleted entry back. Approvers only, same as reject. */
function deleteEntry_(user, p) {
  requirePerm_(user, 'approveHours');
  if (!p || !p.employeeEmail) throw new Error('No employee given.');
  var loc = findEntryRow_(String(p.employeeEmail).toLowerCase(), p.entryId);
  if (!loc) throw new Error('Entry not found.');
  if (String(loc.values[COL['Status']-1]) === 'deleted') throw new Error('Already deleted.');
  return setEntryStatus_(user, p, 'deleted');
}
function approvalUndo_(user, p) {
  requirePerm_(user, 'approveHours');
  var t = apvLogRows_(), ix = -1;
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i][AL_.ID]) === String(p && p.id)) { ix = i; break; }
  if (ix < 0) throw new Error('That decision is not in the log any more.');
  var r = t.rows[ix];
  if (String(r[AL_.UNAT] || '')) throw new Error('That one has already been undone.');
  var email = String(r[AL_.EMP] || ''), entryId = String(r[AL_.ENTRY] || '');
  var loc = findEntryRow_(lc_(email), entryId);
  if (!loc) throw new Error('That entry is not there any more — nothing was changed.');
  // Only undo a row that still says what this decision made it say. If somebody has decided it
  // again since, putting it back would quietly overwrite THEIR decision.
  var nowStatus = String(loc.sheet.getRange(loc.row, COL['Status']).getValue() || '');
  if (lc_(nowStatus) !== lc_(String(r[AL_.ACTION] || '')))
    throw new Error('That entry has been decided again since (it says "' + nowStatus + '" now), so this cannot be undone.');
  loc.sheet.getRange(loc.row, COL['Status']).setValue(String(r[AL_.WSTAT] || 'pending'));
  loc.sheet.getRange(loc.row, COL['Approved By']).setValue(String(r[AL_.WBY] || ''));
  loc.sheet.getRange(loc.row, COL['Approved At']).setValue(String(r[AL_.WAT] || ''));
  loc.sheet.getRange(loc.row, COL['Reject Note']).setValue(String(r[AL_.WNOTE] || ''));
  var now = new Date().toISOString();
  t.sheet.getRange(ix + 2, AL_.UNAT + 1, 1, 2).setValues([[now, user.email]]);
  log_(user, 'approvalUndo', email, entryId,
       'put back to "' + (String(r[AL_.WSTAT] || 'pending')) + '" (was ' + String(r[AL_.ACTION] || '') + ')');
  try { refreshSummaries_({ email: lc_(email) }); } catch (e) {}
  return { ok: true, status: String(r[AL_.WSTAT] || 'pending') };
}

// ---------------------------------- Listing entries --------------------------------------------

function listEntries_(user, p) {
  var email = (p.email || user.email).toLowerCase();
  if (email !== user.email) {
    // Viewing someone else requires admin or view-all (bookkeeper).
    if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
      throw new Error('Not allowed to view other employees.');
  }
  var sheet = getEmployeeSheet_(email, false);
  if (!sheet) return { entries: [] };
  var last = sheet.getLastRow();
  if (last <= ENTRY_HEADER_ROW) return { entries: [] };
  // Bounded window: rows append chronologically, so read only the tail (max 400 rows), then
  // filter to the requested day-window (default ENTRY_WINDOW_DAYS). Keeps payloads flat as
  // history grows; history views can request wider windows via p.days.
  var MAX_ROWS = Math.min(20000, Number(p.maxRows) || 400); // internal callers (payroll, job costs) need full history
  var count = last - ENTRY_HEADER_ROW;
  var take = Math.min(count, MAX_ROWS);
  var rng = sheet.getRange(last - take + 1, 1, take, ENTRY_HEADERS.length).getValues();
  var days = Math.max(1, Number(p.days) || CONFIG.ENTRY_WINDOW_DAYS);
  var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days); cutoff.setHours(0,0,0,0);
  var entries = rng.map(rowToEntry_).filter(function(e){
    if (!e.EntryID) return false;
    if (e.Status === 'deleted') return false;   // v97 - gone from every list; the row stays for Undo
    var d = new Date(e.ClockIn || e.Date);
    return isNaN(d) ? true : d >= cutoff; // keep undated oddities visible rather than hiding them
  });
  entries.reverse(); // newest first
  return { entries: entries };
}

// ---------------------------------- Customers + PO numbers -------------------------------------

function searchCustomers_(user, p) {
  var q = String(p.query || '').trim().toLowerCase();
  var all = getPoCustomers_();
  var exact = [], fuzzy = [];
  all.forEach(function(c){
    var name = c.name.toLowerCase();
    if (!q) { fuzzy.push(c); return; }
    if (name.indexOf(q) >= 0) exact.push(c);
    else if (similar_(name, q)) fuzzy.push(c);
  });
  return { matches: exact.slice(0, 8), suggestions: fuzzy.slice(0, 5) };
}

// Dispatch path: takes the shared script lock. clockIn_/switchJobSite_ already HOLD that lock
// (via withLock_), so they call createCustomerCore_ directly — the old nested waitLock/releaseLock
// released the outer critical section early, silently disarming the double-clock-in guard.
function createCustomer_(user, p) {
  return withLock_(function(){ return createCustomerCore_(user, p); });
}
function createCustomerCore_(user, p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Customer name required.');
  // v38 - a PO number typed into the name box made a brand-new job called "R26184" (R26191,
  // Sept 29 2026). Pick the existing job from the list instead.
  if (/^[A-Z]{1,2}-?\s?\d{5,}$/i.test(name))
    throw new Error('"' + name + '" is a PO number, not a customer name. Search for the customer and pick their job instead.');
  var typeName = p.type || CONFIG.PO_DEFAULT_TYPE;
  var typeLetter = CONFIG.PO_TYPE_LETTERS[typeName] || String(typeName).charAt(0).toUpperCase();
  {
    // duplicate guard (against Company Name column): exact match first, then fuzzy
    // ("Smith Farm" vs "Smith Farms") so offline-created customers can't silently fork.
    var all = getPoCustomers_();
    var existing = all.filter(function(c){ return c.name.toLowerCase() === name.toLowerCase(); });
    if (!existing.length) existing = all.filter(function(c){ return similar_(c.name.toLowerCase(), name.toLowerCase()); });
    if (existing.length && !p.force) return { duplicate: true, existing: existing[0] };

    var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.PO_SHEET_NAME);
    if (!sh) throw new Error('PO sheet tab "' + CONFIG.PO_SHEET_NAME + '" not found.');
    poSyncCols_(sh);                                // v50
    var poStr = buildPo_(typeLetter, nextPoSeq_(sh));
    var row = sh.getLastRow() + 1;
    if (CONFIG.PO_STATUS_COL) poCanon_(sh.getRange(row, CONFIG.PO_STATUS_COL), 'In progress');  // v38 - fail before writing
    if (CONFIG.PO_TYPE_COL)   poCanon_(sh.getRange(row, CONFIG.PO_TYPE_COL), typeName);
    sh.getRange(row, CONFIG.PO_NUMBER_COL).setValue(poStr);
    sh.getRange(row, CONFIG.PO_CUSTOMER_COL).setValue(txt_(name));
    // v38 - check the dropdowns BEFORE writing anything: the old capital-P 'In Progress' was
    // rejected by the Status list and left a half-written row behind.
    var typeVal   = CONFIG.PO_TYPE_COL   ? poCanon_(sh.getRange(row, CONFIG.PO_TYPE_COL), typeName) : '';
    var statusVal = CONFIG.PO_STATUS_COL ? poCanon_(sh.getRange(row, CONFIG.PO_STATUS_COL), poStatus_('In progress')) : '';
    if (CONFIG.PO_TYPE_COL)      sh.getRange(row, CONFIG.PO_TYPE_COL).setValue(typeVal);
    if (CONFIG.PO_STARTDATE_COL) sh.getRange(row, CONFIG.PO_STARTDATE_COL).setValue(fmtDate_(new Date()));
    if (CONFIG.PO_STATUS_COL)    sh.getRange(row, CONFIG.PO_STATUS_COL).setValue(statusVal);
    if (p.contact && CONFIG.PO_CONTACT_COL) sh.getRange(row, CONFIG.PO_CONTACT_COL).setValue(txt_(p.contact));
    if (p.address && CONFIG.PO_ADDRESS_COL) sh.getRange(row, CONFIG.PO_ADDRESS_COL).setValue(txt_(p.address));
    if (p.description && CONFIG.PO_DESC_COL) sh.getRange(row, CONFIG.PO_DESC_COL).setValue(txt_(p.description));
    try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {} // invalidate customer cache
    var folder = ensureJobFolder_(name);
    log_(user, 'createCustomer', user.email, poStr, name + ' (' + typeName + ')');
    return { customer: { name: name, po: poStr, type: typeName, folderUrl: folder.getUrl(), folderId: folder.getId() } };
  }
}

// Next global sequence number by parsing the trailing digits of existing POs (format <letters><YY><seq>).
function nextPoSeq_(sh) {
  var last = sh.getLastRow();
  var max = 0;
  var yy = pad2_(new Date().getFullYear() % 100);
  if (last > CONFIG.PO_HEADER_ROWS) {
    var vals = sh.getRange(CONFIG.PO_HEADER_ROWS+1, CONFIG.PO_NUMBER_COL, last-CONFIG.PO_HEADER_ROWS, 1).getValues();
    vals.forEach(function(r){
      var m = String(r[0]||'').trim().match(/^[A-Za-z]+(\d{2})(\d+)$/);
      if (!m) return;
      if (CONFIG.PO_SEQ_PER_YEAR && m[1] !== yy) return; // only this year's when per-year resetting
      var n = parseInt(m[2], 10);
      if (!isNaN(n) && n > max) max = n;
    });
  }
  return max + 1;
}

function buildPo_(typeLetter, seq) {
  var yy = pad2_(new Date().getFullYear() % 100);
  var s = String(seq);
  while (s.length < CONFIG.PO_SEQ_MIN_DIGITS) s = '0' + s;
  return typeLetter + yy + s;
}

function getPoCustomers_() {
  // Server-side cache: the PO Log rarely changes, so avoid re-reading the whole sheet on
  // every search keystroke. Invalidated by createCustomer_. (Falls through gracefully if
  // the list ever exceeds CacheService's 100KB value limit.)
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var hit = cache.get('poCustomers');
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.PO_SHEET_NAME);
  if (!sh) return [];
  poSyncCols_(sh);                                  // v50 - read the columns off the real header
  var last = sh.getLastRow();
  if (last <= CONFIG.PO_HEADER_ROWS) return [];
  // v74 - the Project Name goes out with the list too. On a phone, a row of eight open POs
  // reading "R26191" and "R26193" is not something anyone can tell apart from memory, and the
  // project name is the only part of a job the crew actually recognise.
  var width = Math.max(CONFIG.PO_NUMBER_COL, CONFIG.PO_CONTACT_COL || 0, CONFIG.PO_CUSTOMER_COL,
                       CONFIG.PO_PROJECT_COL || 0, CONFIG.PO_STATUS_COL || 0);
  var vals = sh.getRange(1, 1, last, width).getValues();
  // Find the REAL header row by looking for "PO Number" in the PO column. The live sheet has
  // a title + PO-numbering-guide preamble above the table, so a fixed header count would
  // read guide rows (and the header itself) as customers.
  var startIx = CONFIG.PO_HEADER_ROWS; // fallback if no header cell is found
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][CONFIG.PO_NUMBER_COL-1] || '').trim().toLowerCase() === 'po number') { startIx = i + 1; break; }
  }
  var list = [];
  for (var r = startIx; r < vals.length; r++) {
    var row = vals[r];
    var name = String(row[CONFIG.PO_CUSTOMER_COL-1] || '').trim();
    // Company Name (col C) blank? Fall back to Contact person (col B) — residential jobs
    // are usually a person, and in practice that's the column that gets filled in.
    if (!name && CONFIG.PO_CONTACT_COL) name = String(row[CONFIG.PO_CONTACT_COL-1] || '').trim();
    if (!name) continue; // pre-typed PO numbers with no name yet stay hidden (correct)
    list.push({ name: name, po: String(row[CONFIG.PO_NUMBER_COL-1] || '').trim(),
      project: CONFIG.PO_PROJECT_COL ? String(row[CONFIG.PO_PROJECT_COL-1] || '').trim() : '',
      status: CONFIG.PO_STATUS_COL ? String(row[CONFIG.PO_STATUS_COL-1] || '').trim() : '' });
  }
  // 60s (was 300): rows added BY HAND in the PO Log only surface when this cache expires
  // (app-created customers invalidate it explicitly), so keep the window short.
  try { if (cache) cache.put('poCustomers', JSON.stringify(list), 60); } catch (e) {}
  return list;
}

// ---------------------------------- Materials --------------------------------------------------

var MAT_HEADERS = ['Item','SKU','Unit','Aliases','Source','Added By','Added At'];

// 1179 most-used electrical parts (Canadian trade names + slang aliases for search),
// generated by size/colour/brand family so the crew can pick the EXACT item. Loaded via
// the 'Load starter catalog' button in Admin (seedMaterials_) — dedupes by name, so your
// own additions are never overwritten.
var SEED_MATERIALS = [
  ['NMD90 14/2 w/ ground','m','loomex romex lumex 14-2'],
  ['NMD90 14/3 w/ ground','m','loomex romex lumex 14-3'],
  ['NMD90 12/2 w/ ground','m','loomex romex lumex 12-2'],
  ['NMD90 12/3 w/ ground','m','loomex romex lumex 12-3'],
  ['NMD90 10/2 w/ ground','m','loomex romex lumex 10-2'],
  ['NMD90 10/3 w/ ground','m','loomex romex lumex 10-3'],
  ['NMD90 8/2 w/ ground','m','loomex romex lumex 8-2'],
  ['NMD90 8/3 w/ ground','m','loomex romex lumex 8-3'],
  ['NMD90 6/3 w/ ground','m','loomex romex lumex 6-3'],
  ['NMWU 14/2 direct burial','m','underground 14-2'],
  ['NMWU 14/3 direct burial','m','underground 14-3'],
  ['NMWU 12/2 direct burial','m','underground 12-2'],
  ['NMWU 12/3 direct burial','m','underground 12-3'],
  ['NMWU 10/2 direct burial','m','underground 10-2'],
  ['NMWU 10/3 direct burial','m','underground 10-3'],
  ['NMWU 8/3 direct burial','m','underground 8-3'],
  ['NMWU 6/3 direct burial','m','underground 6-3'],
  ['RW90 #14 stranded black','m','t90 xlink black wire'],
  ['RW90 #14 stranded red','m','t90 xlink red wire'],
  ['RW90 #14 stranded white','m','t90 xlink white wire'],
  ['RW90 #14 stranded green','m','t90 xlink green wire insulated ground'],
  ['RW90 #14 stranded blue','m','t90 xlink blue wire'],
  ['RW90 #14 stranded yellow','m','t90 xlink yellow wire'],
  ['RW90 #12 stranded black','m','t90 xlink black wire'],
  ['RW90 #12 stranded red','m','t90 xlink red wire'],
  ['RW90 #12 stranded white','m','t90 xlink white wire'],
  ['RW90 #12 stranded green','m','t90 xlink green wire insulated ground'],
  ['RW90 #12 stranded blue','m','t90 xlink blue wire'],
  ['RW90 #12 stranded yellow','m','t90 xlink yellow wire'],
  ['RW90 #10 stranded black','m','t90 xlink black wire'],
  ['RW90 #10 stranded red','m','t90 xlink red wire'],
  ['RW90 #10 stranded white','m','t90 xlink white wire'],
  ['RW90 #10 stranded green','m','t90 xlink green wire insulated ground'],
  ['RW90 #10 stranded blue','m','t90 xlink blue wire'],
  ['RW90 #10 stranded yellow','m','t90 xlink yellow wire'],
  ['RW90 #8 stranded black','m','t90 xlink black wire'],
  ['RW90 #8 stranded red','m','t90 xlink red wire'],
  ['RW90 #8 stranded white','m','t90 xlink white wire'],
  ['RW90 #8 stranded green','m','t90 xlink green wire insulated ground'],
  ['RW90 #8 stranded blue','m','t90 xlink blue wire'],
  ['RW90 #8 stranded yellow','m','t90 xlink yellow wire'],
  ['RW90 #6 stranded black','m','t90'],
  ['RW90 #6 stranded green','m','insulated ground wire green six'],
  ['RW90 #4 stranded green','m','insulated ground wire green'],
  ['RW90 #4 stranded black','m',''],
  ['RW90 #3 stranded black','m',''],
  ['RW90 #2 stranded black','m',''],
  ['RW90 #1 stranded black','m',''],
  ['RW90 #1/0 stranded black','m','aught'],
  ['RW90 #2/0 stranded black','m','aught'],
  ['RW90 #3/0 stranded black','m','aught'],
  ['RW90 #4/0 stranded black','m','aught'],
  ['RW90 250 kcmil stranded black','m','mcm'],
  ['RW90 300 kcmil stranded black','m','mcm'],
  ['RW90 350 kcmil stranded black','m','mcm'],
  ['RW90 400 kcmil stranded black','m','mcm'],
  ['RW90 500 kcmil stranded black','m','mcm'],
  ['RW90 #14 solid black','m','solid t90 black'],
  ['RW90 #14 solid red','m','solid t90 red'],
  ['RW90 #14 solid white','m','solid t90 white'],
  ['RW90 #14 solid green','m','solid t90 green insulated ground'],
  ['RW90 #14 solid blue','m','solid t90 blue'],
  ['RW90 #14 solid yellow','m','solid t90 yellow'],
  ['RW90 #12 solid black','m','solid t90 black'],
  ['RW90 #12 solid red','m','solid t90 red'],
  ['RW90 #12 solid white','m','solid t90 white'],
  ['RW90 #12 solid green','m','solid t90 green insulated ground'],
  ['RW90 #12 solid blue','m','solid t90 blue'],
  ['RW90 #12 solid yellow','m','solid t90 yellow'],
  ['RW90 #10 solid black','m','solid t90 black'],
  ['RW90 #10 solid red','m','solid t90 red'],
  ['RW90 #10 solid white','m','solid t90 white'],
  ['RW90 #10 solid green','m','solid t90 green insulated ground'],
  ['RW90 #10 solid blue','m','solid t90 blue'],
  ['RW90 #10 solid yellow','m','solid t90 yellow'],
  ['Bare copper #14','m','ground wire bare bond'],
  ['Bare copper #12','m','ground wire bare bond'],
  ['Bare copper #10','m','ground wire bare bond'],
  ['Bare copper #8','m','ground wire bare bond'],
  ['Bare copper #6','m','ground wire bare bond'],
  ['Bare copper #4','m','ground wire bare bond'],
  ['Bare copper #2','m','ground wire bare bond'],
  ['Bare copper #1/0','m','ground wire bare bond'],
  ['RW90 aluminum #6','m','al'],
  ['RW90 aluminum #4','m','al'],
  ['RW90 aluminum #2','m','al'],
  ['RW90 aluminum #1/0','m','al'],
  ['RW90 aluminum #2/0','m','al'],
  ['RW90 aluminum #3/0','m','al'],
  ['RW90 aluminum #4/0','m','al'],
  ['RW90 aluminum 250 kcmil','m','al mcm'],
  ['RW90 aluminum 350 kcmil','m','al mcm'],
  ['RW90 aluminum 500 kcmil','m','al mcm'],
  ['URD triplex aluminum #2','m','underground service'],
  ['URD quadruplex aluminum #2','m','quadplex'],
  ['URD triplex aluminum 1/0','m','underground service'],
  ['URD quadruplex aluminum 1/0','m','quadplex'],
  ['URD triplex aluminum 4/0','m','underground service'],
  ['URD quadruplex aluminum 4/0','m','quadplex'],
  ['URD triplex aluminum 350','m','underground service'],
  ['URD quadruplex aluminum 350','m','quadplex'],
  ['AC90 14/2 (BX)','m','bx armoured armored'],
  ['AC90 14/3 (BX)','m','bx armoured armored'],
  ['AC90 12/2 (BX)','m','bx armoured armored'],
  ['AC90 12/3 (BX)','m','bx armoured armored'],
  ['AC90 10/3 (BX)','m','bx armoured armored'],
  ['ACWU90 copper 10/3','m','acwu'],
  ['ACWU90 copper 8/3','m','acwu'],
  ['ACWU90 copper 6/3','m','acwu'],
  ['ACWU90 copper 4/3','m','acwu'],
  ['ACWU90 aluminum 6/3','m','acwu al'],
  ['ACWU90 aluminum 4/3','m','acwu al'],
  ['ACWU90 aluminum 2/3','m','acwu al'],
  ['TECK90 12/2','m','teck cable'],
  ['TECK90 12/3','m','teck cable'],
  ['TECK90 10/3','m','teck cable'],
  ['TECK90 8/3','m','teck cable'],
  ['TECK90 6/3','m','teck cable'],
  ['TECK90 4/3','m','teck cable'],
  ['SOOW cord 16/3','m','rubber cord so'],
  ['SOOW cord 14/3','m','rubber cord so'],
  ['SOOW cord 14/4','m','rubber cord so'],
  ['SOOW cord 12/3','m','rubber cord so'],
  ['SOOW cord 12/4','m','rubber cord so'],
  ['SOOW cord 10/3','m','rubber cord so'],
  ['SOOW cord 10/4','m','rubber cord so'],
  ['SOOW cord 8/4','m','rubber cord so'],
  ['SOOW cord 6/4','m','rubber cord so'],
  ['SJOOW cord 18/3','m','light rubber cord'],
  ['SJOOW cord 16/3','m','light rubber cord'],
  ['SJOOW cord 14/3','m','light rubber cord'],
  ['Thermostat wire 18/2','m','stat lvt bell'],
  ['Thermostat wire 18/3','m','stat lvt bell'],
  ['Thermostat wire 18/4','m','stat lvt bell'],
  ['Thermostat wire 18/5','m','stat lvt bell'],
  ['Thermostat wire 18/7','m','stat lvt bell'],
  ['Thermostat wire 18/8','m','stat lvt bell'],
  ['Cat5e cable','m','network ethernet data'],
  ['Cat6 cable','m','network ethernet'],
  ['Cat6a shielded cable','m','stp'],
  ['RG6 coax','m','tv coaxial'],
  ['RG6 quad shield coax','m','satellite'],
  ['Speaker wire 16/2','m','audio'],
  ['Speaker wire 16/4','m','audio'],
  ['Security cable 22/2','m','alarm'],
  ['Security cable 22/4','m','alarm keypad'],
  ['Fire alarm FAS 18/2','m','fa'],
  ['Fire alarm FAS 16/2','m','fa'],
  ['Doorbell wire 20/2','m','chime'],
  ['TEW #18 black','m','hookup panel wire'],
  ['TEW #18 red','m','hookup panel wire'],
  ['TEW #18 white','m','hookup panel wire'],
  ['TEW #16 black','m','hookup panel wire'],
  ['TEW #16 red','m','hookup panel wire'],
  ['TEW #16 white','m','hookup panel wire'],
  ['TEW #14 black','m','hookup panel wire'],
  ['TEW #14 red','m','hookup panel wire'],
  ['TEW #14 white','m','hookup panel wire'],
  ['EMT 1/2" x 10ft','ea','emt thinwall pipe half inch'],
  ['EMT 3/4" x 10ft','ea','emt thinwall pipe'],
  ['EMT 1" x 10ft','ea','emt thinwall pipe'],
  ['EMT 1-1/4" x 10ft','ea','emt thinwall pipe'],
  ['EMT 1-1/2" x 10ft','ea','emt thinwall pipe'],
  ['EMT 2" x 10ft','ea','emt thinwall pipe'],
  ['EMT 2-1/2" x 10ft','ea','emt thinwall pipe'],
  ['EMT 3" x 10ft','ea','emt thinwall pipe'],
  ['EMT 4" x 10ft','ea','emt thinwall pipe'],
  ['PVC conduit sch40 1/2" x 10ft','ea','pipe'],
  ['PVC conduit sch40 3/4" x 10ft','ea','pipe'],
  ['PVC conduit sch40 1" x 10ft','ea','pipe'],
  ['PVC conduit sch40 1-1/4" x 10ft','ea','pipe'],
  ['PVC conduit sch40 1-1/2" x 10ft','ea','pipe'],
  ['PVC conduit sch40 2" x 10ft','ea','pipe'],
  ['PVC conduit sch40 2-1/2" x 10ft','ea','pipe'],
  ['PVC conduit sch40 3" x 10ft','ea','pipe'],
  ['PVC conduit sch40 4" x 10ft','ea','pipe'],
  ['PVC conduit sch80 1/2" x 10ft','ea','heavy wall'],
  ['PVC conduit sch80 3/4" x 10ft','ea','heavy wall'],
  ['PVC conduit sch80 1" x 10ft','ea','heavy wall'],
  ['PVC conduit sch80 1-1/4" x 10ft','ea','heavy wall'],
  ['PVC conduit sch80 1-1/2" x 10ft','ea','heavy wall'],
  ['PVC conduit sch80 2" x 10ft','ea','heavy wall'],
  ['DB2 duct 2" x 10ft','ea','direct burial'],
  ['DB2 duct 3" x 10ft','ea','direct burial'],
  ['DB2 duct 4" x 10ft','ea','direct burial'],
  ['Rigid conduit 1/2" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 3/4" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 1" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 1-1/4" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 1-1/2" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 2" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 2-1/2" x 10ft','ea','rigid galvanized'],
  ['Rigid conduit 3" x 10ft','ea','rigid galvanized'],
  ['Flex conduit 3/8"','m','greenfield flexible'],
  ['Flex conduit 1/2"','m','greenfield flexible'],
  ['Flex conduit 3/4"','m','greenfield flexible'],
  ['Flex conduit 1"','m','greenfield flexible'],
  ['Flex conduit 1-1/4"','m','greenfield flexible'],
  ['Liquid-tight conduit 3/8"','m','sealtight'],
  ['Liquid-tight conduit 1/2"','m','sealtight'],
  ['Liquid-tight conduit 3/4"','m','sealtight'],
  ['Liquid-tight conduit 1"','m','sealtight'],
  ['Liquid-tight conduit 1-1/4"','m','sealtight'],
  ['Liquid-tight conduit 1-1/2"','m','sealtight'],
  ['Liquid-tight conduit 2"','m','sealtight'],
  ['ENT conduit 1/2"','m','smurf tube'],
  ['ENT conduit 3/4"','m','smurf tube'],
  ['ENT conduit 1"','m','smurf tube'],
  ['EMT connector 1/2" set-screw','ea','ss'],
  ['EMT coupling 1/2" set-screw','ea','ss'],
  ['EMT connector 3/4" set-screw','ea','ss'],
  ['EMT coupling 3/4" set-screw','ea','ss'],
  ['EMT connector 1" set-screw','ea','ss'],
  ['EMT coupling 1" set-screw','ea','ss'],
  ['EMT connector 1-1/4" set-screw','ea','ss'],
  ['EMT coupling 1-1/4" set-screw','ea','ss'],
  ['EMT connector 1-1/2" set-screw','ea','ss'],
  ['EMT coupling 1-1/2" set-screw','ea','ss'],
  ['EMT connector 2" set-screw','ea','ss'],
  ['EMT coupling 2" set-screw','ea','ss'],
  ['EMT connector 2-1/2" set-screw','ea','ss'],
  ['EMT coupling 2-1/2" set-screw','ea','ss'],
  ['EMT connector 3" set-screw','ea','ss'],
  ['EMT coupling 3" set-screw','ea','ss'],
  ['EMT connector 4" set-screw','ea','ss'],
  ['EMT coupling 4" set-screw','ea','ss'],
  ['EMT connector 1/2" compression','ea','raintight'],
  ['EMT coupling 1/2" compression','ea','raintight'],
  ['EMT connector 3/4" compression','ea','raintight'],
  ['EMT coupling 3/4" compression','ea','raintight'],
  ['EMT connector 1" compression','ea','raintight'],
  ['EMT coupling 1" compression','ea','raintight'],
  ['EMT connector 1-1/4" compression','ea','raintight'],
  ['EMT coupling 1-1/4" compression','ea','raintight'],
  ['EMT connector 1-1/2" compression','ea','raintight'],
  ['EMT coupling 1-1/2" compression','ea','raintight'],
  ['EMT connector 2" compression','ea','raintight'],
  ['EMT coupling 2" compression','ea','raintight'],
  ['EMT 90 elbow 1-1/4"','ea','factory bend'],
  ['EMT 90 elbow 1-1/2"','ea','factory bend'],
  ['EMT 90 elbow 2"','ea','factory bend'],
  ['EMT 90 elbow 2-1/2"','ea','factory bend'],
  ['EMT 90 elbow 3"','ea','factory bend'],
  ['EMT 90 elbow 4"','ea','factory bend'],
  ['EMT strap 1/2" one-hole','ea','pipe strap'],
  ['EMT strap 3/4" one-hole','ea','pipe strap'],
  ['EMT strap 1" one-hole','ea','pipe strap'],
  ['EMT strap 1-1/4" one-hole','ea','pipe strap'],
  ['EMT strap 1-1/2" one-hole','ea','pipe strap'],
  ['EMT strap 2" one-hole','ea','pipe strap'],
  ['EMT strap 2-1/2" one-hole','ea','pipe strap'],
  ['EMT strap 1/2" two-hole','ea',''],
  ['EMT strap 3/4" two-hole','ea',''],
  ['EMT strap 1" two-hole','ea',''],
  ['EMT strap 1-1/4" two-hole','ea',''],
  ['EMT strap 1-1/2" two-hole','ea',''],
  ['Conduit hanger 1/2" w/ bolt','ea','minnie'],
  ['Conduit hanger 3/4" w/ bolt','ea','minnie'],
  ['Conduit hanger 1" w/ bolt','ea','minnie'],
  ['Conduit hanger 1-1/4" w/ bolt','ea','minnie'],
  ['Conduit hanger 1-1/2" w/ bolt','ea','minnie'],
  ['Conduit hanger 2" w/ bolt','ea','minnie'],
  ['Conduit hanger 2-1/2" w/ bolt','ea','minnie'],
  ['KO seal 1/2"','ea','knockout plug'],
  ['KO seal 3/4"','ea','knockout plug'],
  ['KO seal 1"','ea','knockout plug'],
  ['KO seal 1-1/4"','ea','knockout plug'],
  ['KO seal 1-1/2"','ea','knockout plug'],
  ['EMT offset connector 1/2"','ea',''],
  ['EMT offset connector 3/4"','ea',''],
  ['Pulling elbow 1/2"','ea','capri'],
  ['Pulling elbow 3/4"','ea','capri'],
  ['PVC female adapter 1/2"','ea','fa'],
  ['PVC female adapter 3/4"','ea','fa'],
  ['PVC female adapter 1"','ea','fa'],
  ['PVC female adapter 1-1/4"','ea','fa'],
  ['PVC female adapter 1-1/2"','ea','fa'],
  ['PVC female adapter 2"','ea','fa'],
  ['PVC female adapter 3"','ea','fa'],
  ['PVC male adapter 1/2"','ea','ma ta'],
  ['PVC male adapter 3/4"','ea','ma ta'],
  ['PVC male adapter 1"','ea','ma ta'],
  ['PVC male adapter 1-1/4"','ea','ma ta'],
  ['PVC male adapter 1-1/2"','ea','ma ta'],
  ['PVC male adapter 2"','ea','ma ta'],
  ['PVC male adapter 3"','ea','ma ta'],
  ['PVC coupling 1/2"','ea',''],
  ['PVC coupling 3/4"','ea',''],
  ['PVC coupling 1"','ea',''],
  ['PVC coupling 1-1/4"','ea',''],
  ['PVC coupling 1-1/2"','ea',''],
  ['PVC coupling 2"','ea',''],
  ['PVC coupling 3"','ea',''],
  ['PVC coupling 4"','ea',''],
  ['PVC 90 elbow 1/2"','ea','ell'],
  ['PVC 90 elbow 3/4"','ea','ell'],
  ['PVC 90 elbow 1"','ea','ell'],
  ['PVC 90 elbow 1-1/4"','ea','ell'],
  ['PVC 90 elbow 1-1/2"','ea','ell'],
  ['PVC 90 elbow 2"','ea','ell'],
  ['PVC 90 elbow 3"','ea','ell'],
  ['PVC 90 elbow 4"','ea','ell'],
  ['PVC 45 elbow 1/2"','ea',''],
  ['PVC 45 elbow 3/4"','ea',''],
  ['PVC 45 elbow 1"','ea',''],
  ['PVC 45 elbow 1-1/4"','ea',''],
  ['PVC 45 elbow 1-1/2"','ea',''],
  ['PVC 45 elbow 2"','ea',''],
  ['PVC 45 elbow 3"','ea',''],
  ['PVC LB 1/2"','ea','lb condulet'],
  ['PVC LB 3/4"','ea','lb condulet'],
  ['PVC LB 1"','ea','lb condulet'],
  ['PVC LB 1-1/4"','ea','lb condulet'],
  ['PVC LB 1-1/2"','ea','lb condulet'],
  ['PVC LB 2"','ea','lb condulet'],
  ['PVC LB 3"','ea','lb condulet'],
  ['PVC T fitting 3/4"','ea','tee'],
  ['PVC T fitting 1"','ea','tee'],
  ['PVC T fitting 2"','ea','tee'],
  ['PVC expansion joint 3/4"','ea',''],
  ['PVC expansion joint 1"','ea',''],
  ['PVC expansion joint 2"','ea',''],
  ['PVC cap 2"','ea',''],
  ['PVC cap 3"','ea',''],
  ['PVC cap 4"','ea',''],
  ['PVC strap 1/2"','ea',''],
  ['PVC strap 3/4"','ea',''],
  ['PVC strap 1"','ea',''],
  ['PVC strap 1-1/4"','ea',''],
  ['PVC strap 1-1/2"','ea',''],
  ['PVC strap 2"','ea',''],
  ['PVC strap 3"','ea',''],
  ['PVC reducer bushing 3/4"x1/2"','ea',''],
  ['PVC reducer bushing 1"x3/4"','ea',''],
  ['PVC reducer bushing 1-1/4"x1"','ea',''],
  ['PVC reducer bushing 2"x1-1/2"','ea',''],
  ['PVC box adapter 1/2"','ea',''],
  ['PVC box adapter 3/4"','ea',''],
  ['PVC box adapter 1"','ea',''],
  ['PVC box adapter 1-1/4"','ea',''],
  ['PVC box adapter 1-1/2"','ea',''],
  ['Meter offset 2" PVC','ea',''],
  ['Locknut 1/2"','ea',''],
  ['Locknut 3/4"','ea',''],
  ['Locknut 1"','ea',''],
  ['Locknut 1-1/4"','ea',''],
  ['Locknut 1-1/2"','ea',''],
  ['Locknut 2"','ea',''],
  ['Locknut 2-1/2"','ea',''],
  ['Plastic bushing 1/2"','ea',''],
  ['Plastic bushing 3/4"','ea',''],
  ['Plastic bushing 1"','ea',''],
  ['Plastic bushing 1-1/4"','ea',''],
  ['Plastic bushing 1-1/2"','ea',''],
  ['Plastic bushing 2"','ea',''],
  ['Plastic bushing 2-1/2"','ea',''],
  ['Grounding bushing 3/4"','ea','bond'],
  ['Grounding bushing 1"','ea','bond'],
  ['Grounding bushing 1-1/4"','ea','bond'],
  ['Grounding bushing 2"','ea','bond'],
  ['Chase nipple 1/2"','ea',''],
  ['Chase nipple 3/4"','ea',''],
  ['Chase nipple 1"','ea',''],
  ['Chase nipple 1-1/4"','ea',''],
  ['Chase nipple 1-1/2"','ea',''],
  ['Close nipple 1/2"','ea',''],
  ['Close nipple 3/4"','ea',''],
  ['Close nipple 1"','ea',''],
  ['Close nipple 1-1/4"','ea',''],
  ['Close nipple 1-1/2"','ea',''],
  ['Reducing washer 3/4"x1/2"','pk',''],
  ['Reducing washer 1"x3/4"','pk',''],
  ['Reducing washer 1-1/4"x1"','pk',''],
  ['Reducing washer 2"x1-1/4"','pk',''],
  ['TECK connector 1/2"','ea','teck'],
  ['TECK connector 3/4"','ea','teck'],
  ['TECK connector 1"','ea','teck'],
  ['TECK connector 1-1/4"','ea','teck'],
  ['TECK connector 1-1/2"','ea','teck'],
  ['TECK connector 2"','ea','teck'],
  ['TECK connector 2-1/2"','ea','teck'],
  ['NM cable connector 3/8"','ea','loomex romex connector'],
  ['NM cable connector 1/2"','ea',''],
  ['AC90 connector 3/8"','ea','bx connector'],
  ['AC90 connector 1/2"','ea',''],
  ['Two-screw NM connector 3/8"','ea',''],
  ['Two-screw NM connector 1/2"','ea',''],
  ['Liquid-tight connector 1/2" straight','ea','sealtight'],
  ['Liquid-tight connector 3/4" straight','ea','sealtight'],
  ['Liquid-tight connector 1" straight','ea','sealtight'],
  ['Liquid-tight connector 1-1/4" straight','ea','sealtight'],
  ['Liquid-tight connector 1-1/2" straight','ea','sealtight'],
  ['Liquid-tight connector 1/2" 90','ea','sealtight'],
  ['Liquid-tight connector 3/4" 90','ea','sealtight'],
  ['Liquid-tight connector 1" 90','ea','sealtight'],
  ['Liquid-tight connector 1-1/4" 90','ea','sealtight'],
  ['Liquid-tight connector 1-1/2" 90','ea','sealtight'],
  ['Cord grip connector 1/2"','ea','strain relief'],
  ['Cord grip connector 3/4"','ea','strain relief'],
  ['Cord grip connector 1"','ea','strain relief'],
  ['Anti-short bushing 3/8"','pk','redhead'],
  ['Anti-short bushing 1/2"','pk','redhead'],
  ['Octagon box 1104','ea','ceiling'],
  ['Octagon box 1104 deep','ea','ceiling'],
  ['Octagon box w/ bar hanger','ea','hanger'],
  ['Octagon extension ring','ea',''],
  ['Pancake box','ea','shallow'],
  ['Device box 2104','ea','metal single gang'],
  ['Device box 2104 deep','ea',''],
  ['Handy box','ea','utility'],
  ['Handy box cover switch','ea',''],
  ['Handy box cover duplex','ea',''],
  ['4x4 square box 52151','ea','1900 four square'],
  ['4x4 square box deep','ea','2-1/8'],
  ['4x4 extension ring','ea',''],
  ['4-11/16 square box','ea','big square'],
  ['4-11/16 square box deep','ea',''],
  ['4x4 mud ring 1-gang 1/2"','ea','plaster ring'],
  ['4x4 mud ring 1-gang 5/8"','ea',''],
  ['4x4 mud ring 2-gang 1/2"','ea',''],
  ['4x4 mud ring 2-gang 5/8"','ea',''],
  ['4x4 flat blank cover','ea',''],
  ['4x4 raised cover duplex','ea',''],
  ['4x4 raised cover switch','ea',''],
  ['Masonry box 1-gang','ea','block'],
  ['Masonry box 2-gang','ea','block'],
  ['Multi-gang box 3-gang metal','ea',''],
  ['Multi-gang box 4-gang metal','ea',''],
  ['Plastic nail-on box 1-gang','ea','device'],
  ['Plastic nail-on box 2-gang','ea',''],
  ['Plastic nail-on box 3-gang','ea',''],
  ['Plastic nail-on box 4-gang','ea',''],
  ['Old-work box 1-gang','ea','cut-in remodel'],
  ['Old-work box 2-gang','ea','cut-in'],
  ['Old-work box 3-gang','ea',''],
  ['Old-work octagon box','ea','cut-in ceiling'],
  ['Vapour barrier box 1-gang','ea','poly airtight'],
  ['Vapour barrier box 2-gang','ea',''],
  ['Vapour barrier octagon box','ea',''],
  ['Poly vapour hat','ea','vapor hat'],
  ['Ceiling fan rated box','ea','fan'],
  ['Ceiling fan old-work box','ea',''],
  ['FS box 1-gang PVC','ea','surface'],
  ['FS box 2-gang PVC','ea',''],
  ['FD box 1-gang PVC','ea','deep'],
  ['Weatherproof box 1-gang aluminum','ea','bell'],
  ['Weatherproof box 2-gang aluminum','ea','bell'],
  ['Weatherproof in-use cover 1-gang','ea','bubble extra duty'],
  ['Weatherproof in-use cover 2-gang','ea','bubble'],
  ['Weatherproof flat cover GFCI','ea','wp'],
  ['Weatherproof flat cover duplex','ea',''],
  ['Weatherproof flat cover toggle','ea',''],
  ['Weatherproof blank cover','ea',''],
  ['Pull box 6x6x4','ea','junction'],
  ['Pull box 8x8x4','ea',''],
  ['Pull box 10x10x4','ea',''],
  ['Pull box 12x12x6','ea',''],
  ['Floor box kit','ea',''],
  ['Duplex receptacle 15A white','ea','plug outlet'],
  ['Decora receptacle 15A white','ea','plug outlet'],
  ['Single-pole switch 15A white','ea','toggle'],
  ['Decora switch single-pole white','ea','rocker'],
  ['3-way switch 15A white','ea','three way'],
  ['Decora 3-way switch white','ea','three way rocker'],
  ['Duplex receptacle 15A ivory','ea','plug outlet'],
  ['Decora receptacle 15A ivory','ea','plug outlet'],
  ['Single-pole switch 15A ivory','ea','toggle'],
  ['Decora switch single-pole ivory','ea','rocker'],
  ['3-way switch 15A ivory','ea','three way'],
  ['Decora 3-way switch ivory','ea','three way rocker'],
  ['Duplex receptacle 15A black','ea','plug outlet'],
  ['Decora receptacle 15A black','ea','plug outlet'],
  ['Single-pole switch 15A black','ea','toggle'],
  ['Decora switch single-pole black','ea','rocker'],
  ['3-way switch 15A black','ea','three way'],
  ['Decora 3-way switch black','ea','three way rocker'],
  ['Duplex receptacle 15A almond','ea','plug outlet'],
  ['Decora receptacle 15A almond','ea','plug outlet'],
  ['Single-pole switch 15A almond','ea','toggle'],
  ['Decora switch single-pole almond','ea','rocker'],
  ['3-way switch 15A almond','ea','three way'],
  ['Decora 3-way switch almond','ea','three way rocker'],
  ['Duplex receptacle 20A T-slot white','ea','20 amp'],
  ['Decora receptacle 20A white','ea',''],
  ['Tamper-resistant duplex 15A white','ea','tr'],
  ['4-way switch white','ea','four way'],
  ['Decora 4-way switch white','ea',''],
  ['20A single-pole switch white','ea','spec grade'],
  ['USB-A/C receptacle white','ea','usb charger'],
  ['GFCI receptacle 20A white','ea','gfi'],
  ['Duplex receptacle 20A T-slot ivory','ea','20 amp'],
  ['Decora receptacle 20A ivory','ea',''],
  ['Tamper-resistant duplex 15A ivory','ea','tr'],
  ['4-way switch ivory','ea','four way'],
  ['Decora 4-way switch ivory','ea',''],
  ['20A single-pole switch ivory','ea','spec grade'],
  ['USB-A/C receptacle ivory','ea','usb charger'],
  ['GFCI receptacle 20A ivory','ea','gfi'],
  ['GFCI receptacle 15A white','ea','gfi ground fault'],
  ['GFCI receptacle 15A ivory','ea','gfi ground fault'],
  ['GFCI receptacle 15A black','ea','gfi ground fault'],
  ['Weather-resistant GFCI 15A','ea','wr outdoor gfi'],
  ['GFCI/switch combo','ea','gfi switch'],
  ['Switch/pilot light combo','ea',''],
  ['Lighted toggle switch','ea',''],
  ['LED dimmer SP/3-way','ea','dimmer'],
  ['Decora slide dimmer','ea','lutron'],
  ['Toggle dimmer','ea',''],
  ['Fan speed control','ea','rheostat'],
  ['Timer switch digital','ea','countdown'],
  ['Timer switch spring-wound','ea','crank'],
  ['In-wall programmable timer','ea',''],
  ['Motion sensor switch','ea','occupancy'],
  ['Vacancy sensor switch','ea',''],
  ['Range receptacle 14-50R','ea','stove plug 50a'],
  ['Dryer receptacle 14-30R','ea','30a'],
  ['Welder receptacle 6-50R','ea','welder'],
  ['6-30R receptacle','ea',''],
  ['RV receptacle TT-30R','ea','rv 30a'],
  ['Generator inlet L14-30','ea','power inlet'],
  ['L5-15R twist-lock receptacle','ea','locking'],
  ['L5-20R twist-lock receptacle','ea',''],
  ['L5-30R twist-lock receptacle','ea',''],
  ['L6-20R twist-lock receptacle','ea','240'],
  ['L6-30R twist-lock receptacle','ea',''],
  ['L14-20R twist-lock receptacle','ea',''],
  ['L14-30R twist-lock receptacle','ea','generator'],
  ['L5-20P twist-lock plug','ea',''],
  ['L5-30P twist-lock plug','ea',''],
  ['L6-20P twist-lock plug','ea',''],
  ['L6-30P twist-lock plug','ea',''],
  ['L14-20P twist-lock plug','ea',''],
  ['L14-30P twist-lock plug','ea','generator plug'],
  ['Cord cap 5-15P','ea','male plug end'],
  ['Cord cap 5-20P','ea',''],
  ['Cord connector 5-15C','ea','female end'],
  ['Cord connector 5-20C','ea',''],
  ['Cord cap 6-15P','ea',''],
  ['Cord cap 6-20P','ea',''],
  ['Cord cap 6-50P','ea','welder plug'],
  ['Cord cap 14-30P','ea','dryer plug'],
  ['Cord cap 14-50P','ea','range plug'],
  ['Range cord 4-wire','ea','stove cord'],
  ['Dryer cord 4-wire','ea',''],
  ['1-gang toggle plate white','ea','switch'],
  ['2-gang toggle plate white','ea',''],
  ['3-gang toggle plate white','ea',''],
  ['1-gang decora plate white','ea',''],
  ['2-gang decora plate white','ea',''],
  ['3-gang decora plate white','ea',''],
  ['4-gang decora plate white','ea',''],
  ['1-gang duplex plate white','ea','plug'],
  ['2-gang duplex plate white','ea',''],
  ['1-gang blank plate white','ea',''],
  ['Toggle/duplex combo plate white','ea',''],
  ['Toggle/decora combo plate white','ea',''],
  ['1-gang toggle plate ivory','ea','switch'],
  ['2-gang toggle plate ivory','ea',''],
  ['3-gang toggle plate ivory','ea',''],
  ['1-gang decora plate ivory','ea',''],
  ['2-gang decora plate ivory','ea',''],
  ['3-gang decora plate ivory','ea',''],
  ['4-gang decora plate ivory','ea',''],
  ['1-gang duplex plate ivory','ea','plug'],
  ['2-gang duplex plate ivory','ea',''],
  ['1-gang blank plate ivory','ea',''],
  ['Toggle/duplex combo plate ivory','ea',''],
  ['Toggle/decora combo plate ivory','ea',''],
  ['1-gang toggle plate stainless','ea','switch'],
  ['2-gang toggle plate stainless','ea',''],
  ['3-gang toggle plate stainless','ea',''],
  ['1-gang decora plate stainless','ea',''],
  ['2-gang decora plate stainless','ea',''],
  ['3-gang decora plate stainless','ea',''],
  ['4-gang decora plate stainless','ea',''],
  ['1-gang duplex plate stainless','ea','plug'],
  ['2-gang duplex plate stainless','ea',''],
  ['1-gang blank plate stainless','ea',''],
  ['Toggle/duplex combo plate stainless','ea',''],
  ['Toggle/decora combo plate stainless','ea',''],
  ['1-gang toggle plate almond','ea','switch'],
  ['2-gang toggle plate almond','ea',''],
  ['3-gang toggle plate almond','ea',''],
  ['1-gang decora plate almond','ea',''],
  ['2-gang decora plate almond','ea',''],
  ['3-gang decora plate almond','ea',''],
  ['4-gang decora plate almond','ea',''],
  ['1-gang duplex plate almond','ea','plug'],
  ['2-gang duplex plate almond','ea',''],
  ['1-gang blank plate almond','ea',''],
  ['Toggle/duplex combo plate almond','ea',''],
  ['Toggle/decora combo plate almond','ea',''],
  ['1-gang toggle plate black','ea','switch'],
  ['2-gang toggle plate black','ea',''],
  ['3-gang toggle plate black','ea',''],
  ['1-gang decora plate black','ea',''],
  ['2-gang decora plate black','ea',''],
  ['3-gang decora plate black','ea',''],
  ['4-gang decora plate black','ea',''],
  ['1-gang duplex plate black','ea','plug'],
  ['2-gang duplex plate black','ea',''],
  ['1-gang blank plate black','ea',''],
  ['Toggle/duplex combo plate black','ea',''],
  ['Toggle/decora combo plate black','ea',''],
  ['Jumbo 1-gang toggle plate white','ea','oversize'],
  ['Jumbo 1-gang decora plate white','ea','oversize'],
  ['Jumbo 2-gang decora plate white','ea',''],
  ['Round ceiling blank plate','ea','octagon cover'],
  ['Breaker 15A 1-pole Homeline','ea','square d hom'],
  ['Breaker 20A 1-pole Homeline','ea','square d hom'],
  ['Breaker 25A 1-pole Homeline','ea','square d hom'],
  ['Breaker 30A 1-pole Homeline','ea','square d hom'],
  ['Breaker 40A 1-pole Homeline','ea','square d hom'],
  ['Breaker 15A 2-pole Homeline','ea','square d hom'],
  ['Breaker 20A 2-pole Homeline','ea','square d hom'],
  ['Breaker 30A 2-pole Homeline','ea','square d hom'],
  ['Breaker 40A 2-pole Homeline','ea','square d hom'],
  ['Breaker 50A 2-pole Homeline','ea','square d hom'],
  ['Breaker 60A 2-pole Homeline','ea','square d hom'],
  ['Breaker 70A 2-pole Homeline','ea','square d hom'],
  ['Breaker 80A 2-pole Homeline','ea','square d hom'],
  ['Breaker 90A 2-pole Homeline','ea','square d hom'],
  ['Breaker 100A 2-pole Homeline','ea','square d hom'],
  ['AFCI breaker 15A Homeline','ea','arc fault square d hom'],
  ['AFCI breaker 20A Homeline','ea','arc fault square d hom'],
  ['Dual-function breaker 15A Homeline','ea','df cafi gfci square d hom'],
  ['Dual-function breaker 20A Homeline','ea','df cafi gfci square d hom'],
  ['GFCI breaker 30A 2-pole Homeline','ea','hot tub spa square d hom'],
  ['GFCI breaker 40A 2-pole Homeline','ea','hot tub spa square d hom'],
  ['GFCI breaker 50A 2-pole Homeline','ea','hot tub spa square d hom'],
  ['GFCI breaker 60A 2-pole Homeline','ea','hot tub spa square d hom'],
  ['Tandem breaker 15A/15A Homeline','ea','cheater square d hom'],
  ['Tandem breaker 20A/20A Homeline','ea','square d hom'],
  ['Breaker 15A 1-pole QO','ea','square d'],
  ['Breaker 20A 1-pole QO','ea','square d'],
  ['Breaker 25A 1-pole QO','ea','square d'],
  ['Breaker 30A 1-pole QO','ea','square d'],
  ['Breaker 40A 1-pole QO','ea','square d'],
  ['Breaker 15A 2-pole QO','ea','square d'],
  ['Breaker 20A 2-pole QO','ea','square d'],
  ['Breaker 30A 2-pole QO','ea','square d'],
  ['Breaker 40A 2-pole QO','ea','square d'],
  ['Breaker 50A 2-pole QO','ea','square d'],
  ['Breaker 60A 2-pole QO','ea','square d'],
  ['Breaker 70A 2-pole QO','ea','square d'],
  ['Breaker 80A 2-pole QO','ea','square d'],
  ['Breaker 90A 2-pole QO','ea','square d'],
  ['Breaker 100A 2-pole QO','ea','square d'],
  ['AFCI breaker 15A QO','ea','arc fault square d'],
  ['AFCI breaker 20A QO','ea','arc fault square d'],
  ['Dual-function breaker 15A QO','ea','df cafi gfci square d'],
  ['Dual-function breaker 20A QO','ea','df cafi gfci square d'],
  ['GFCI breaker 30A 2-pole QO','ea','hot tub spa square d'],
  ['GFCI breaker 40A 2-pole QO','ea','hot tub spa square d'],
  ['GFCI breaker 50A 2-pole QO','ea','hot tub spa square d'],
  ['GFCI breaker 60A 2-pole QO','ea','hot tub spa square d'],
  ['Tandem breaker 15A/15A QO','ea','cheater square d'],
  ['Tandem breaker 20A/20A QO','ea','square d'],
  ['Breaker 15A 1-pole Siemens','ea','itec'],
  ['Breaker 20A 1-pole Siemens','ea','itec'],
  ['Breaker 25A 1-pole Siemens','ea','itec'],
  ['Breaker 30A 1-pole Siemens','ea','itec'],
  ['Breaker 40A 1-pole Siemens','ea','itec'],
  ['Breaker 15A 2-pole Siemens','ea','itec'],
  ['Breaker 20A 2-pole Siemens','ea','itec'],
  ['Breaker 30A 2-pole Siemens','ea','itec'],
  ['Breaker 40A 2-pole Siemens','ea','itec'],
  ['Breaker 50A 2-pole Siemens','ea','itec'],
  ['Breaker 60A 2-pole Siemens','ea','itec'],
  ['Breaker 70A 2-pole Siemens','ea','itec'],
  ['Breaker 80A 2-pole Siemens','ea','itec'],
  ['Breaker 90A 2-pole Siemens','ea','itec'],
  ['Breaker 100A 2-pole Siemens','ea','itec'],
  ['AFCI breaker 15A Siemens','ea','arc fault itec'],
  ['AFCI breaker 20A Siemens','ea','arc fault itec'],
  ['Dual-function breaker 15A Siemens','ea','df cafi gfci itec'],
  ['Dual-function breaker 20A Siemens','ea','df cafi gfci itec'],
  ['GFCI breaker 30A 2-pole Siemens','ea','hot tub spa itec'],
  ['GFCI breaker 40A 2-pole Siemens','ea','hot tub spa itec'],
  ['GFCI breaker 50A 2-pole Siemens','ea','hot tub spa itec'],
  ['GFCI breaker 60A 2-pole Siemens','ea','hot tub spa itec'],
  ['Tandem breaker 15A/15A Siemens','ea','cheater itec'],
  ['Tandem breaker 20A/20A Siemens','ea','itec'],
  ['Breaker 15A 1-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 20A 1-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 25A 1-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 30A 1-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 40A 1-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 15A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 20A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 30A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 40A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 50A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 60A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 70A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 80A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 90A 2-pole Eaton BR','ea','cutler hammer'],
  ['Breaker 100A 2-pole Eaton BR','ea','cutler hammer'],
  ['AFCI breaker 15A Eaton BR','ea','arc fault cutler hammer'],
  ['AFCI breaker 20A Eaton BR','ea','arc fault cutler hammer'],
  ['Dual-function breaker 15A Eaton BR','ea','df cafi gfci cutler hammer'],
  ['Dual-function breaker 20A Eaton BR','ea','df cafi gfci cutler hammer'],
  ['GFCI breaker 30A 2-pole Eaton BR','ea','hot tub spa cutler hammer'],
  ['GFCI breaker 40A 2-pole Eaton BR','ea','hot tub spa cutler hammer'],
  ['GFCI breaker 50A 2-pole Eaton BR','ea','hot tub spa cutler hammer'],
  ['GFCI breaker 60A 2-pole Eaton BR','ea','hot tub spa cutler hammer'],
  ['Tandem breaker 15A/15A Eaton BR','ea','cheater cutler hammer'],
  ['Tandem breaker 20A/20A Eaton BR','ea','cutler hammer'],
  ['Bolt-on breaker 15A 1-pole QOB','ea','commercial bolt on'],
  ['Bolt-on breaker 15A 2-pole QOB','ea',''],
  ['Bolt-on breaker 20A 1-pole QOB','ea','commercial bolt on'],
  ['Bolt-on breaker 20A 2-pole QOB','ea',''],
  ['Bolt-on breaker 30A 1-pole QOB','ea','commercial bolt on'],
  ['Bolt-on breaker 30A 2-pole QOB','ea',''],
  ['Cartridge fuse class P 30A','ea','main fuse'],
  ['Cartridge fuse class P 60A','ea','main fuse'],
  ['Cartridge fuse class P 100A','ea','main fuse'],
  ['Cartridge fuse class P 200A','ea','main fuse'],
  ['HRCI-R fuse 15A','ea','rejection'],
  ['HRCI-R fuse 20A','ea','rejection'],
  ['HRCI-R fuse 30A','ea','rejection'],
  ['HRCI-R fuse 40A','ea','rejection'],
  ['HRCI-R fuse 50A','ea','rejection'],
  ['HRCI-R fuse 60A','ea','rejection'],
  ['Plug fuse 15A','ea','screw in'],
  ['Plug fuse 20A','ea','screw in'],
  ['Plug fuse 30A','ea','screw in'],
  ['Fuse holder 30A','ea',''],
  ['Fuse holder 60A','ea',''],
  ['Panel 100A 32-circuit Homeline','ea','loadcentre'],
  ['Panel 125A 24-circuit','ea','loadcentre'],
  ['Panel 200A 40-circuit Homeline','ea','loadcentre'],
  ['Panel 200A 64-circuit','ea','loadcentre'],
  ['Panel 100A 24-circuit QO','ea',''],
  ['Panel 200A 42-circuit QO','ea',''],
  ['Sub-panel 60A 12-circuit','ea','garage'],
  ['Sub-panel 100A 24-circuit','ea','subpanel'],
  ['Sub-panel 125A 24-circuit','ea',''],
  ['Generator panel 30A 8-circuit','ea','gen'],
  ['Meter socket 100A','ea',''],
  ['Meter socket 200A','ea',''],
  ['Meter main combo 200A','ea',''],
  ['Splitter trough 200A','ea','splitter'],
  ['Disconnect 30A fusible','ea',''],
  ['Disconnect 30A non-fusible','ea','ac'],
  ['Disconnect 60A fusible','ea',''],
  ['Disconnect 60A non-fusible','ea',''],
  ['Disconnect 100A fusible','ea',''],
  ['Disconnect 100A non-fusible','ea',''],
  ['Disconnect 200A fusible','ea',''],
  ['Spa pack 50A GFCI','ea','hot tub'],
  ['Manual transfer switch 30A','ea','generator'],
  ['Manual transfer switch 60A','ea',''],
  ['Whole-home surge protector','ea','spd'],
  ['Panel surge breaker','ea',''],
  ['Contactor 30A 2-pole 120V coil','ea','lighting'],
  ['Contactor 40A 2-pole 120V coil','ea',''],
  ['Contactor 40A 3-pole 120V coil','ea',''],
  ['Contactor 60A 3-pole 120V coil','ea',''],
  ['Definite purpose contactor 40A 24V coil','ea','hvac'],
  ['Relay 120V SPDT','ea','ice cube'],
  ['Relay 24V SPDT','ea',''],
  ['RIB relay','ea','functional devices'],
  ['Time clock 24hr mechanical','ea','timeclock intermatic'],
  ['Time clock 7-day digital','ea',''],
  ['Astronomic time clock','ea',''],
  ['Photocell 120V stem','ea','dusk to dawn'],
  ['Photocell 120-277V','ea',''],
  ['Doorbell transformer 16V','ea','chime'],
  ['Control transformer 120/24V 40VA','ea','hvac'],
  ['Motor starter manual M-0','ea',''],
  ['Motor starter magnetic size 0','ea','mag'],
  ['Marrette yellow','pk','wire nut marr small'],
  ['Marrette red','pk','wire nut marr '],
  ['Marrette orange','pk','wire nut marr tiny'],
  ['Marrette blue','pk','wire nut marr large'],
  ['Marrette grey','pk','wire nut marr big'],
  ['Marrette green','pk','wire nut marr ground'],
  ['WAGO 221 2-port','pk','lever nut'],
  ['WAGO 221 3-port','pk','lever nut'],
  ['WAGO 221 5-port','pk','lever nut'],
  ['WAGO inline splice','pk','lever'],
  ['Push-in connector 3-port','pk',''],
  ['Ring terminal 12-10 stud #10','pk','crimp'],
  ['Ring terminal 12-10 stud 1/4"','pk',''],
  ['Ring terminal 12-10 stud 5/16"','pk',''],
  ['Ring terminal 12-10 stud 3/8"','pk',''],
  ['Spade terminal 16-14','pk','fork'],
  ['Spade terminal 12-10','pk',''],
  ['Butt splice 16-14','pk','crimp'],
  ['Butt splice 12-10','pk',''],
  ['Female quick-disconnect 16-14','pk','fqd'],
  ['Female quick-disconnect 12-10','pk',''],
  ['Split bolt #10','ea','kearney'],
  ['Split bolt #6','ea','kearney'],
  ['Split bolt #2','ea','kearney'],
  ['Split bolt 2/0','ea','kearney'],
  ['Compression lug #6 1-hole','ea','crimp'],
  ['Compression lug #2 1-hole','ea','crimp'],
  ['Compression lug 1/0 1-hole','ea','crimp'],
  ['Compression lug 2/0 1-hole','ea','crimp'],
  ['Compression lug 4/0 1-hole','ea','crimp'],
  ['Compression lug 250 1-hole','ea','crimp'],
  ['Compression lug 350 1-hole','ea','crimp'],
  ['Mechanical lug #2 2-hole','ea',''],
  ['Mechanical lug 2/0 2-hole','ea',''],
  ['Mechanical lug 4/0 2-hole','ea',''],
  ['H-tap #6-#2','ea','htap'],
  ['H-tap 2/0-4/0','ea','htap'],
  ['Ground rod 8ft 5/8"','ea','grounding rod'],
  ['Ground rod 10ft 5/8"','ea',''],
  ['Ground plate','ea','grounding'],
  ['Acorn ground rod clamp 5/8"','ea','acorn'],
  ['Water pipe ground clamp 1/2-1"','ea',''],
  ['Water pipe ground clamp 1-1/4-2"','ea',''],
  ['Ground bar kit 6-terminal','ea',''],
  ['Ground bar kit 12-terminal','ea',''],
  ['Neutral bar 21-terminal','ea',''],
  ['Ground pigtail w/ screw','pk','bond tail'],
  ['Ground screws 10-32','pk','green screws'],
  ['Rebar ground clamp','ea','ufer'],
  ['Intersystem bonding bridge','ea',''],
  ['Antioxidant compound','ea','noalox penetrox oxgard'],
  ['Insulated staples 1/4"','pk','lv'],
  ['Insulated staples 3/8"','pk','loomex'],
  ['Insulated staples 1/2"','pk','loomex'],
  ['Insulated staples 3/4"','pk',''],
  ['Metal staples 1/2"','pk',''],
  ['Cable stacker clips','pk','stackers'],
  ['Zip ties 4"','pk','cable tie'],
  ['Zip ties 8"','pk','cable tie tie wrap'],
  ['Zip ties 11"','pk',''],
  ['Zip ties 14"','pk',''],
  ['Zip ties 24"','pk','big'],
  ['Zip ties 8" black UV','pk','outdoor'],
  ['Zip ties 11" black UV','pk',''],
  ['Zip tie mounts','pk','tie base'],
  ['Screw-mount tie anchors','pk',''],
  ['Pan-head screws #8 x 1/2"','pk','zip screws'],
  ['Pan-head screws #8 x 3/4"','pk','zip screws'],
  ['Pan-head screws #8 x 1"','pk','zip screws'],
  ['Pan-head screws #8 x 1-1/2"','pk','zip screws'],
  ['Pan-head screws #10 x 1"','pk','zip screws'],
  ['Pan-head screws #10 x 2"','pk','zip screws'],
  ['Pan-head screws #10 x 3"','pk','zip screws'],
  ['Tek screws #8 x 1/2"','pk','self drilling'],
  ['Tek screws #10 x 3/4"','pk','self drilling'],
  ['Tapcon 3/16 x 1-1/4"','pk','concrete screw'],
  ['Tapcon 1/4 x 1-3/4"','pk','concrete'],
  ['Drywall screws 1-5/8"','pk',''],
  ['Plastic anchors w/ screws #8','pk','wall plug'],
  ['Plastic anchors w/ screws #10','pk',''],
  ['EZ anchors','pk','zip it'],
  ['Toggle bolts 1/8"','pk','butterfly'],
  ['Toggle bolts 3/16"','pk',''],
  ['Lag bolts 1/4 x 2"','pk',''],
  ['Strut channel 10ft deep','ea','unistrut kindorf'],
  ['Strut channel 10ft shallow','ea','half strut'],
  ['Strut spring nuts 1/4-20','ea','strut nut'],
  ['Strut spring nuts 3/8-16','ea',''],
  ['Strut 90 bracket','ea',''],
  ['Strut post base','ea',''],
  ['Strut strap 1/2"','ea','unistrut clamp'],
  ['Strut strap 3/4"','ea','unistrut clamp'],
  ['Strut strap 1"','ea','unistrut clamp'],
  ['Strut strap 1-1/4"','ea','unistrut clamp'],
  ['Strut strap 1-1/2"','ea','unistrut clamp'],
  ['Strut strap 2"','ea','unistrut clamp'],
  ['Strut strap 3"','ea','unistrut clamp'],
  ['Threaded rod 1/4-20 x 10ft','ea','allthread'],
  ['Threaded rod 3/8-16 x 10ft','ea','allthread'],
  ['Rod coupling 3/8"','ea',''],
  ['Beam clamp 3/8"','ea',''],
  ['Beam clamp w/ rod 1/4"','ea',''],
  ['Caddy clip MC/AC','ea','bx clip'],
  ['Caddy conduit clip 1/2"','ea','snap'],
  ['Caddy conduit clip 3/4"','ea',''],
  ['Caddy box mounting bracket','ea','far side'],
  ['Caddy K-16 clip','ea',''],
  ['J-hook 3/4"','ea','cable hook'],
  ['J-hook 1-5/16"','ea',''],
  ['J-hook 2"','ea',''],
  ['Bridle rings 1-1/4"','ea',''],
  ['4" LED pot light 3000K','ea','recessed can potlight'],
  ['4" LED pot light 5CCT','ea','selectable'],
  ['6" LED slim pot light 5CCT','ea','wafer'],
  ['6" LED pot light gimbal','ea',''],
  ['4" LED wafer light','ea','thin'],
  ['6" LED wafer light','ea','thin'],
  ['Pot light housing IC remodel','ea','can'],
  ['Pot light retrofit trim 6"','ea',''],
  ['Gimbal trim 4"','ea',''],
  ['4ft LED shop light','ea','garage strip'],
  ['4ft LED shop light linkable','ea',''],
  ['8ft LED shop light','ea',''],
  ['4ft LED wrap fixture','ea','wraparound'],
  ['2ft LED wrap fixture','ea',''],
  ['4ft LED strip fixture','ea','channel'],
  ['8ft LED strip fixture','ea',''],
  ['2ft LED strip fixture','ea',''],
  ['UFO high bay 100W','ea','highbay'],
  ['UFO high bay 150W','ea','shop barn'],
  ['UFO high bay 200W','ea',''],
  ['Linear high bay 2ft','ea',''],
  ['Linear high bay 4ft','ea',''],
  ['LED wall pack 30W','ea','exterior'],
  ['LED wall pack 60W','ea',''],
  ['LED wall pack w/ photocell','ea','dusk'],
  ['LED flood 30W','ea','yard'],
  ['LED flood 50W','ea',''],
  ['LED flood w/ photocell','ea','dusk to dawn barn'],
  ['Motion flood light','ea','security'],
  ['LED vapour tight 4ft','ea','wet location barn'],
  ['LED vapour tight 2ft','ea',''],
  ['LED canopy light','ea','soffit'],
  ['Exit sign LED','ea','running man'],
  ['Emergency light twin-head','ea','frog eyes'],
  ['Exit/emergency combo','ea','em'],
  ['Keyless lampholder','ea','pigtail socket'],
  ['Pull-chain lampholder','ea',''],
  ['Weatherproof lampholder','ea','outdoor socket'],
  ['Track light kit 4ft','ea',''],
  ['A19 LED bulb 2700K','ea','light bulb soft white'],
  ['A19 LED bulb 5000K','ea','daylight'],
  ['A21 LED bulb 100W eq','ea',''],
  ['BR30 LED bulb 2700K','ea','flood'],
  ['BR30 LED bulb 5000K','ea',''],
  ['PAR20 LED bulb','ea',''],
  ['PAR30 LED bulb','ea',''],
  ['PAR38 LED bulb','ea','outdoor flood'],
  ['MR16 LED bulb GU10','ea',''],
  ['Candelabra LED bulb','ea','chandelier'],
  ['3-way LED bulb','ea',''],
  ['G9 LED bulb','ea',''],
  ['T8 LED tube 4ft type A/B','ea','fluorescent replacement'],
  ['T8 LED tube 2ft','ea',''],
  ['ST19 Edison LED bulb','ea','vintage'],
  ['LED driver 12V 60W','ea','power supply'],
  ['LED driver 24V 96W','ea',''],
  ['LED strip tape 12V 5m','ea','ribbon'],
  ['Undercabinet LED 12"','ea',''],
  ['Undercabinet LED 24"','ea',''],
  ['Fixture whip 6ft','ea','quick connect'],
  ['Emergency ballast','ea','battery backup'],
  ['Bathroom exhaust fan 70 CFM','ea','bath fan'],
  ['Bathroom exhaust fan 110 CFM','ea',''],
  ['Bath fan w/ light','ea',''],
  ['Bath fan humidity sensing','ea',''],
  ['Baseboard heater 500W 240V','ea',''],
  ['Baseboard heater 750W 240V','ea',''],
  ['Baseboard heater 1000W 240V','ea',''],
  ['Baseboard heater 1500W 240V','ea',''],
  ['Baseboard heater 2000W 240V','ea',''],
  ['Baseboard heater 2500W 240V','ea',''],
  ['Baseboard thermostat SP','ea','built in'],
  ['Baseboard thermostat DP','ea',''],
  ['Wall thermostat 240V DP','ea','line voltage'],
  ['Programmable thermostat low-voltage','ea',''],
  ['Fan-forced wall heater 1500W','ea',''],
  ['Fan-forced wall heater 2000W','ea',''],
  ['Garage unit heater 4800W','ea','shop heater'],
  ['Construction heater 240V','ea','milkhouse'],
  ['Heat cable 6ft roof/gutter','ea','heat tape'],
  ['Heat cable 30ft','ea',''],
  ['Pipe heat cable 12ft','ea',''],
  ['EV charger 40A hardwired','ea','car charger evse'],
  ['EV charger 48A','ea','tesla'],
  ['Range hood 30"','ea',''],
  ['Smoke detector 120V interconnect','ea','smoke alarm'],
  ['Smoke detector 10-yr battery','ea',''],
  ['Smoke/CO combo detector 120V','ea','carbon monoxide'],
  ['CO detector plug-in','ea',''],
  ['Heat detector 120V','ea','garage'],
  ['Wired doorbell kit','ea','chime'],
  ['Wireless doorbell kit','ea',''],
  ['Doorbell button lighted','ea',''],
  ['Video doorbell','ea','ring'],
  ['Electrical tape black 3/4"','roll','tape super 33'],
  ['Electrical tape black economy','roll','tape'],
  ['Electrical tape red','roll','phasing'],
  ['Electrical tape white','roll',''],
  ['Electrical tape green','roll',''],
  ['Electrical tape blue','roll',''],
  ['Electrical tape yellow','roll',''],
  ['Duct seal 1lb','ea','sealing compound'],
  ['PVC cement 473ml','ea','glue solvent'],
  ['PVC primer','ea',''],
  ['Silicone sealant clear','ea','caulking'],
  ['Silicone sealant white','ea',''],
  ['Fire caulk','ea','firestop 3m'],
  ['Fire caulk sausage','ea',''],
  ['Wire pulling lubricant 1L','ea','soap lube'],
  ['Wire pulling lubricant 4L','ea',''],
  ['Wire markers 0-9 book','ea','numbers'],
  ['Panel labels sheet','ea','directory'],
  ['Heat shrink 1/8"','pk','shrink tube'],
  ['Heat shrink 1/4"','pk',''],
  ['Heat shrink 3/8"','pk',''],
  ['Heat shrink 1/2"','pk',''],
  ['Heat shrink assortment kit','ea',''],
  ['Split loom 1/4"','m','convoluted'],
  ['Split loom 1/2"','m',''],
  ['Split loom 3/4"','m',''],
  ['Grommet assortment','pk',''],
  ['Electrical putty pad','ea','poly pad'],
  ['Spec-grade duplex 15A white','ea','commercial 5262'],
  ['Spec-grade duplex 20A white','ea','commercial 5362'],
  ['Spec-grade decora 15A white','ea','commercial'],
  ['Spec-grade decora 20A white','ea','commercial'],
  ['Spec-grade duplex 15A ivory','ea','commercial 5262'],
  ['Spec-grade duplex 20A ivory','ea','commercial 5362'],
  ['Spec-grade decora 15A ivory','ea','commercial'],
  ['Spec-grade decora 20A ivory','ea','commercial'],
  ['Spec-grade duplex 15A grey','ea','commercial 5262'],
  ['Spec-grade duplex 20A grey','ea','commercial 5362'],
  ['Spec-grade decora 15A grey','ea','commercial'],
  ['Spec-grade decora 20A grey','ea','commercial'],
  ['Spec-grade duplex 15A red','ea','commercial 5262'],
  ['Spec-grade duplex 20A red','ea','commercial 5362'],
  ['Spec-grade decora 15A red','ea','commercial'],
  ['Spec-grade decora 20A red','ea','commercial'],
  ['Isolated ground receptacle 15A orange','ea','ig'],
  ['Isolated ground receptacle 20A orange','ea','ig'],
  ['Controlled receptacle 15A marked','ea','energy code'],
  ['347V single-pole switch 15A','ea','commercial'],
  ['347V 3-way switch 15A','ea','commercial'],
  ['Dead-front GFCI 20A','ea','blank face gfi'],
  ['Blank-face GFCI 15A','ea',''],
  ['Surge receptacle 15A','ea','tvss'],
  ['Smart switch WiFi','ea','kasa smart'],
  ['Smart dimmer WiFi','ea',''],
  ['Smart plug WiFi','ea',''],
  ['Stab-lok breaker 15A 1-pole NC','ea','federal pioneer pacific'],
  ['Stab-lok breaker 20A 1-pole NC','ea','federal pioneer pacific'],
  ['Stab-lok breaker 30A 1-pole NC','ea','federal pioneer pacific'],
  ['Stab-lok breaker 40A 1-pole NC','ea','federal pioneer pacific'],
  ['Stab-lok breaker 15A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 20A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 30A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 40A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 50A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 60A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 70A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok breaker 100A 2-pole NC','ea','federal pioneer'],
  ['Stab-lok tandem 15A/15A','ea','federal pioneer thin'],
  ['Stab-lok tandem 20A/20A','ea',''],
  ['Breaker 15A 1-pole CH','ea','cutler hammer brown'],
  ['Breaker 20A 1-pole CH','ea','cutler hammer brown'],
  ['Breaker 30A 1-pole CH','ea','cutler hammer brown'],
  ['Breaker 20A 2-pole CH','ea','cutler hammer'],
  ['Breaker 30A 2-pole CH','ea','cutler hammer'],
  ['Breaker 40A 2-pole CH','ea','cutler hammer'],
  ['Breaker 50A 2-pole CH','ea','cutler hammer'],
  ['Breaker 60A 2-pole CH','ea','cutler hammer'],
  ['Breaker 100A 2-pole CH','ea','cutler hammer'],
  ['AFCI breaker 15A CH','ea',''],
  ['GFCI breaker 50A 2-pole CH','ea','hot tub'],
  ['Breaker 15A 1-pole GE','ea','general electric thq'],
  ['Breaker 20A 1-pole GE','ea','general electric thq'],
  ['Breaker 30A 1-pole GE','ea','general electric thq'],
  ['Breaker 30A 2-pole GE','ea',''],
  ['Breaker 40A 2-pole GE','ea',''],
  ['Breaker 60A 2-pole GE','ea',''],
  ['Breaker 100A 2-pole GE','ea',''],
  ['Bolt-on breaker 15A 1-pole BL','ea','siemens commercial'],
  ['Bolt-on breaker 20A 1-pole BL','ea',''],
  ['Bolt-on breaker 20A 2-pole BL','ea',''],
  ['Panel 60A 8-circuit garage kit','ea','subpanel package'],
  ['Panel 200A 30-circuit Siemens','ea','loadcentre'],
  ['Panel 100A 30-circuit Eaton BR','ea','loadcentre'],
  ['Rigid nipple 1/2" x 2"','ea','pipe nipple'],
  ['Rigid nipple 1/2" x 3"','ea','pipe nipple'],
  ['Rigid nipple 1/2" x 4"','ea','pipe nipple'],
  ['Rigid nipple 1/2" x 6"','ea','pipe nipple'],
  ['Rigid nipple 3/4" x 2"','ea','pipe nipple'],
  ['Rigid nipple 3/4" x 3"','ea','pipe nipple'],
  ['Rigid nipple 3/4" x 4"','ea','pipe nipple'],
  ['Rigid nipple 3/4" x 6"','ea','pipe nipple'],
  ['Rigid nipple 1" x 2"','ea','pipe nipple'],
  ['Rigid nipple 1" x 3"','ea','pipe nipple'],
  ['Rigid nipple 1" x 4"','ea','pipe nipple'],
  ['Rigid nipple 1" x 6"','ea','pipe nipple'],
  ['Offset nipple 1/2"','ea',''],
  ['Offset nipple 3/4"','ea',''],
  ['Offset nipple 1"','ea',''],
  ['Rigid coupling 1/2"','ea',''],
  ['Rigid coupling 3/4"','ea',''],
  ['Rigid coupling 1"','ea',''],
  ['Rigid coupling 1-1/4"','ea',''],
  ['Rigid coupling 2"','ea',''],
  ['Myers hub 1/2"','ea','raintight hub'],
  ['Myers hub 3/4"','ea','raintight hub'],
  ['Myers hub 1"','ea','raintight hub'],
  ['EMT connector 1/2" insulated-throat','ea',''],
  ['EMT connector 3/4" insulated-throat','ea',''],
  ['EMT connector 1" insulated-throat','ea',''],
  ['EMT connector 1-1/4" insulated-throat','ea',''],
  ['Sealtight 45 connector 1/2"','ea',''],
  ['Sealtight 45 connector 3/4"','ea',''],
  ['Conduit body LB 3/4" metal w/ cover','ea','condulet'],
  ['Conduit body LB 1" metal w/ cover','ea','condulet'],
  ['Conduit body T 3/4" metal w/ cover','ea',''],
  ['Conduit body C 3/4" metal w/ cover','ea',''],
  ['Weatherproof hub 1/2"','ea','bell hub'],
  ['Weatherproof hub 3/4"','ea',''],
  ['Service entrance cap 1"','ea','weatherhead mast'],
  ['Service entrance cap 2"','ea','weatherhead'],
  ['Mast kit 2" w/ flashing','ea','service mast'],
  ['Sill plate 3/4"','ea','service entry'],
  ['Gangable metal box 3x2','ea','1104 gang'],
  ['Weatherproof extension ring 1-gang','ea',''],
  ['4x4 raised cover 1/2" 1-gang','ea','industrial'],
  ['4x4 raised cover 3/4" 2-gang','ea',''],
  ['Swing-out old-work brace bar','ea','fan brace retrofit'],
  ['Low-voltage bracket 1-gang','ea','lv ring mud ring'],
  ['Low-voltage bracket 2-gang','ea','lv ring'],
  ['RJ45 keystone jack Cat6','ea','data jack'],
  ['RJ45 keystone jack Cat5e','ea',''],
  ['Coax F keystone jack','ea','tv'],
  ['HDMI keystone jack','ea',''],
  ['Blank keystone insert','ea',''],
  ['Keystone plate 1-port white','ea',''],
  ['Keystone plate 2-port white','ea',''],
  ['Keystone plate 4-port white','ea',''],
  ['RJ45 plugs Cat6','ea','pk ends crimp'],
  ['F-connectors RG6 compression','ea','fittings'],
  ['Coax barrel connector','ea','f81'],
  ['Patch panel 12-port','ea',''],
  ['Data plate w/ bushing','ea','brush plate'],
  ['Fence energizer 110V','ea','fencer charger'],
  ['Poly wire 400m roll','ea','electric fence'],
  ['Fence insulator screw-in','ea','pk'],
  ['Fence insulator corner','ea','pk'],
  ['Gate handle electric fence','ea',''],
  ['Fence wire 14ga galvanized 400m','ea','smooth wire'],
  ['Ground rod clamp fence','ea',''],
  ['Compression lug #8 1-hole','ea','crimp'],
  ['Compression lug #1 1-hole','ea','crimp'],
  ['Compression lug 3/0 1-hole','ea','crimp'],
  ['Compression lug 500 1-hole','ea','crimp'],
  ['Mechanical lug #6 2-hole','ea',''],
  ['Mechanical lug 1/0 2-hole','ea',''],
  ['Mechanical lug 250 2-hole','ea',''],
  ['Pin adapter #6 to #12','ea','pin terminal'],
  ['Pin adapter #4 to #10','ea',''],
  ['Insulink #6','ea','insulated splice'],
  ['Insulink #2','ea',''],
  ['Polaris connector 3-port #6','ea','insulated multitap'],
  ['Polaris connector 3-port 2/0','ea',''],
  ['DIN rail 1m','ea',''],
  ['DIN terminal block 4mm','pk',''],
  ['DIN end stops','pk',''],
  ['Overload relay 9-13A','ea',''],
  ['Auxiliary contact block','ea',''],
  ['22mm pushbutton NO','ea','start'],
  ['22mm pushbutton NC','ea','stop'],
  ['22mm pilot light 120V red','ea',''],
  ['22mm pilot light 120V green','ea',''],
  ['E-stop pushbutton 22mm','ea','emergency'],
  ['Corn cob LED 36W E26','ea','hid replacement'],
  ['Corn cob LED 54W mogul','ea','hid replacement'],
  ['T5HO LED tube 4ft','ea',''],
  ['Fixture motion sensor add-on','ea','occupancy head'],
  ['Photo-eye button 120V','ea','button photocell'],
  ['Strip retrofit kit 4ft magnetic','ea','troffer kit'],
  ['2x4 LED troffer','ea','lay in flat panel'],
  ['2x2 LED troffer','ea','flat panel'],
  ['1x4 LED flat panel','ea',''],
  ['Welding cable #2','m','dlo flexible'],
  ['Welding cable 1/0','m','dlo'],
  ['Wiring duct 1x1 w/ cover','ea','panduit finger duct'],
  ['Wiring duct 2x2 w/ cover','ea','panduit'],
  ['In-use cover jumbo 1-gang','ea','deep bubble'],
  ['While-in-use cover 55-in-1','ea','universal'],
  ['Octagon to 4x4 adapter plate','ea',''],
  ['Ceiling medallion split','ea',''],
  ['Appliance pigtail 3-wire 30A','ea','dryer whip'],
  ['Appliance pigtail 3-wire 50A','ea','range whip'],
  ['Garbage disposal power cord','ea','dishwasher cord kit']
];

var MATLOG_HEADERS = ['Time','Employee','EntryID','Job Site','PO#','Item','Qty','Unit','Status','Resolved By'];

function matSheet_(){ var sh = masterSheet_(SHEETS.MATERIALS);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,MAT_HEADERS.length).setValues([MAT_HEADERS]).setFontWeight('bold');
  return sh; }
function matLogSheet_(){ var sh = masterSheet_(SHEETS.MATLOG);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,MATLOG_HEADERS.length).setValues([MATLOG_HEADERS]).setFontWeight('bold');
  return sh; }

function getMaterials_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); var hit = cache.get('materials'); if (hit) return JSON.parse(hit); } catch(e){}
  var sh = matSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2,1,last-1,4).getValues();
  var list = vals.map(function(r){
    return { name: String(r[0]||'').trim(), sku: String(r[1]||'').trim(), unit: String(r[2]||'').trim(), aliases: String(r[3]||'').trim() };
  }).filter(function(m){ return m.name; });
  // v40 - add the price-list items (the ones that carry stock), so a part picked at clock-out has
  // its SKU and comes off the shelf. Same name already in the catalog: it just gains the SKU.
  try {
    var byName = {}; list.forEach(function(m){ byName[lc_(m.name)] = m; });
    matRows_().rows.forEach(function(r){
      var sku = String(r[M_SKU-1]||'').trim(), desc = String(r[M_DESC-1]||'').trim();
      if (!sku || !desc) return;
      var hit = byName[lc_(desc)];
      if (hit) { if (!hit.sku) hit.sku = sku; return; }
      list.push({ name: desc, sku: sku, unit: String(r[M_UNIT-1]||'').trim(), aliases: sku });
    });
  } catch (e) {}
  try { if (cache) cache.put('materials', JSON.stringify(list), 300); } catch(e){}
  return list;
}

// p: { entryId, jobSite, poNumber, items: [{name, qty, unit, matched}] }
// Matched items log as 'ok'; free-typed ones as 'pending-review' for the admin to reconcile
// against supplier receipts (surfaced in the Admin tab).
function logMaterials_(user, p) {
  var sh = matLogSheet_();
  var now = new Date().toISOString();
  // v81 - a typed part only becomes a question when it might already exist under another name.
  var pool = null, learned = [];
  var rows = (p.items || []).filter(function(it){ return it && String(it.name||'').trim(); }).map(function(it){
    var name = String(it.name).trim(), status = 'ok';
    if (!it.matched) {
      if (!pool) pool = matKnown_().concat(matJobNames_(p.jobSite || '', p.poNumber || ''));
      var near = matLike_(name, pool);
      if (near.length && near[0].score >= MAT_SAME_) name = near[0].name;   // it is that part
      else if (near.length) status = 'pending-review';
      else { matLearn_(user, name, it.unit); learned.push(name); pool.push({ name: name, where: 'inventory' }); }
    }
    return [now, user.email, p.entryId||'', txt_(p.jobSite||''), p.poNumber||'',
      txt_(name), it.qty||'', txt_(it.unit||''), status, ''];
  });
  // v91 - ONE POSTING PER ENTRY. The subId guard remembers a submission for six hours, but a
  // clock-out that sat in Elijah's phone for 42 hours (ef669d51e, Oct 21 -> Oct 23) carried its
  // material claims with it and they were written a second time, so C26197 showed two of each.
  // If every line in this call is already logged against this entry, it is the same claim again.
  if (rows.length && p.entryId) {
    try {
      var lastM = sh.getLastRow();
      if (lastM >= 2) {
        var have = {};
        sh.getRange(2, 1, lastM - 1, MATLOG_HEADERS.length).getValues().forEach(function (r) {
          if (String(r[2]) !== String(p.entryId)) return;
          var k = lc_(r[5]) + '|' + String(r[6]); have[k] = (have[k] || 0) + 1;
        });
        var allThere = rows.every(function (r) {
          var k = lc_(r[5]) + '|' + String(r[6]);
          if (have[k] > 0) { have[k]--; return true; }
          return false;
        });
        if (allThere) {
          log_(user, 'logMaterials', user.email, p.entryId || '', 'already logged for this entry - not written again (' + rows.length + ' item(s))');
          return { ok: true, logged: 0, duplicate: true, taken: [], notInStockList: [], learned: [], pendingReview: 0 };
        }
      }
    } catch (e) {}
  }
  if (rows.length) sh.getRange(sh.getLastRow()+1, 1, rows.length, MATLOG_HEADERS.length).setValues(rows);
  var inv = { taken: [], notFound: [] };
  try { inv = invTakeForEntry_(user, p); } catch (e) { inv.error = e.message; }   // v40 - never lose the log over stock
  log_(user, 'logMaterials', user.email, p.entryId||'', rows.length + ' item(s)' +
       (inv.taken.length ? ' · off the shelf: ' + inv.taken.join(', ') : '') +
       (learned.length ? ' · learned: ' + learned.join(', ') : ''));
  return { ok: true, logged: rows.length, taken: inv.taken, notInStockList: inv.notFound,
    learned: learned,
    pendingReview: rows.filter(function(r){ return r[8] === 'pending-review'; }).length };
}

/* ============== DOES THIS ALREADY EXIST UNDER ANOTHER NAME? (v81) =========================
 * Charles, 2 Nov: "could the app just look through our old POs and parts and try to find a
 * similar description and suggest the name? ... could it just automatically add them if they
 * are new and we do not have anything like it?"
 *
 * Both, and the second one is the bigger saving. Everything on the Requests tab got there the
 * same way: the typed name did not match a catalogue row CHARACTER FOR CHARACTER. "15A 1P SQD
 * Breaker" and "Square D CHOM115 1P 120V 15A Circuit Breaker" are the same breaker and the old
 * test could not see it, while "2x4x8 Lumber" is genuinely new and was asked about anyway.
 *
 * So: score the typed name against the price list, the field catalogue and the job's OWN PO
 * lines. Something close → ask, with the candidates as one-tap buttons. Nothing close → it is
 * new, so learn it and say nothing. The office is only asked when there is a real chance of
 * making a second name for a part we already have, which is the only thing it was ever for.
 *
 * Scored on shared words, with anything containing a digit worth three - 14/2, 15A, 4x4 and 1P
 * are what tell two parts apart, and "box" is not. */
function matTokens_(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\/#.-]+/g, ' ')
    .split(' ')
    // A hyphen inside a size is part of it: 3-1/2 and 1-1/2 are different screws, and splitting
    // them both down to "1/2" made every fraction look like every other fraction.
    .map(function (w) { return w.replace(/^[.-]+|[.-]+$/g, ''); })
    .filter(function (w) { return w && w.length > 1 && !MAT_STOP_.test(w); });
}
var MAT_STOP_ = /^(the|and|for|with|w|c|of|in|inch|inches|box|pack|pk|ea|each|new|per)$/;
function matWeight_(w) { return /[0-9]/.test(w) ? 3 : 1; }
function matScore_(a, b) {
  var A = matTokens_(a), B = matTokens_(b);
  if (!A.length || !B.length) return { score: 0, shared: 0 };
  var seen = {}, shared = 0, wa = 0, wb = 0, i;
  for (i = 0; i < B.length; i++) seen[B[i]] = (seen[B[i]] || 0) + 1;
  for (i = 0; i < A.length; i++) { wa += matWeight_(A[i]); if (seen[A[i]] > 0) { seen[A[i]]--; shared += matWeight_(A[i]); } }
  for (i = 0; i < B.length; i++) wb += matWeight_(B[i]);
  return { score: (2 * shared) / (wa + wb), shared: shared };
}
var MAT_NEAR_ = 0.42;      // below this the two are not the same part in different words
var MAT_MINSHARE_ = 3;     // and one shared ordinary word ("breaker") is never enough on its own
var MAT_SAME_ = 0.95;      // and at the top it is not a near miss at all - it IS that part,
                           // typed in a different case or with the spacing moved. Nobody needs
                           // to be asked whether "wago inline splice" is "WAGO inline splice".
/* Every name we already know, each with where it came from. Built once per call. */
function matKnown_() {
  var out = [], seen = {};
  var add = function (name, where) {
    var n = String(name || '').trim(); if (!n) return;
    var k = lc_(n); if (seen[k]) return; seen[k] = true;
    out.push({ name: n, where: where });
  };
  try { matRows_().rows.forEach(function (r) { add(r[M_DESC-1], 'price list'); }); } catch (e) {}
  try {
    var sh = matSheet_(), last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, MAT_HEADERS.length).getValues().forEach(function (r) {
      add(r[0], 'inventory');
      String(r[3] || '').split(/\s*[,;|]\s*/).forEach(function (a) { add(a, 'inventory'); });
    });
  } catch (e) {}
  return out;
}
/* ...plus what this job's own POs call things, which is usually the supplier's exact wording. */
function matJobNames_(site, po) {
  var out = [];
  try {
    var sh = plTab_(POS_TAB, POS_HEADERS), last = sh.getLastRow();
    if (last < 2) return out;
    var si = lc_(site), pi = lc_(po);
    sh.getRange(2, 1, last - 1, POS_HEADERS.length).getValues().forEach(function (r) {
      if (!((pi && lc_(r[3]) === pi) || (si && lc_(r[2]) === si))) return;
      var d = String(r[7] || '').trim();
      if (d) out.push({ name: d, where: 'this job’s PO' });
    });
  } catch (e) {}
  return out;
}
function matLike_(typed, pool) {
  var hits = [];
  (pool || []).forEach(function (c) {
    var r = matScore_(typed, c.name);
    if (r.score >= MAT_NEAR_ && r.shared >= MAT_MINSHARE_)
      hits.push({ name: c.name, where: c.where, score: Math.round(r.score * 100) / 100 });
  });
  hits.sort(function (a, b) { return b.score - a.score; });
  var out = [], seen = {};
  for (var i = 0; i < hits.length && out.length < 3; i++) {
    var k = lc_(hits[i].name); if (seen[k]) continue; seen[k] = true; out.push(hits[i]);
  }
  return out;
}
/* A part nothing resembles is simply new: learn it, so the next person who types it finds it in
 * the search instead of raising a second question about the same thing. It goes into the FIELD
 * catalogue only. The price list is left to the supplier sweep, which has the real part number
 * and the real price - seeding it from a phone would put "4in Wall Vent w/ Damper" beside the
 * invoice's "ECCO 051094 4IN GALV WALL CAP W/DAMPER" and quietly price the job twice. */
function matLearn_(user, name, unit) {
  try {
    matSheet_().appendRow([String(name).trim(), '', String(unit || ''), '', 'auto-field',
                           user.email, new Date().toISOString()]);
    try { CacheService.getScriptCache().remove('materials'); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

function pendingMaterials_(user) {
  requirePerm_(user, 'approveHours');
  var sh = matLogSheet_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var vals = sh.getRange(2,1,last-1,MATLOG_HEADERS.length).getValues();
    vals.forEach(function(r,i){
      if (r[8] !== 'pending-review') return;
      out.push({ row: i+2, time: r[0] instanceof Date ? r[0].toISOString() : r[0], employee: r[1],
        entryId: r[2], jobSite: r[3], po: r[4], item: r[5], qty: r[6], unit: r[7] });
    });
  }
  // v81 - worked out when the list is READ, not when the row was written, so a suggestion
  // improves as the catalogue grows instead of being frozen at the moment somebody typed it.
  if (out.length) {
    var known = matKnown_(), byJob = {};
    out.forEach(function (m) {
      var k = lc_(m.po || '') + '|' + lc_(m.jobSite || '');
      if (!byJob[k]) byJob[k] = matJobNames_(m.jobSite || '', m.po || '');
      m.suggest = matLike_(m.item, known.concat(byJob[k]));
    });
  }
  return { pending: out };
}

// p: { row, action: 'addToList' | 'dismiss', unit? }
function resolveMaterial_(user, p) {
  requirePerm_(user, 'approveHours');
  var sh = matLogSheet_();
  var row = Number(p.row);
  if (!row || row < 2 || row > sh.getLastRow()) throw new Error('Invalid row.');
  var typed = String(sh.getRange(row, 6).getValue() || '').trim();
  // v80 - the office gives it its proper NAME. Whoever is standing on the job types what he
  // calls it ("2104 box"); the catalogue needs the name everything else will match on, and the
  // usage row has to carry that same name or the invoice says one thing and the shelf another.
  var item = String(p.name || '').trim() || typed;
  var created = false;      // v84 - the undo needs to know whether THIS decision made the row
  if (p.action === 'addToList' && item) {
    var have = matRows_().rows.some(function (r) { return lc_(r[M_DESC-1]) === lc_(item); })
            || matKnown_().some(function (c) { return lc_(c.name) === lc_(item); });
    if (!have) {
      matSheet_().appendRow([item, String(p.sku||''), p.unit||'', typed !== item ? typed : '',
                             'field-entry', user.email, new Date().toISOString()]);
      created = true;
    }
    if (item !== typed) sh.getRange(row, 6).setValue(txt_(item));
    if (p.unit) sh.getRange(row, 8).setValue(String(p.unit));
    try { CacheService.getScriptCache().remove('materials'); } catch(e){}
  }
  sh.getRange(row, 9).setValue(p.action === 'addToList' ? 'ok' : 'dismissed');
  sh.getRange(row, 10).setValue(user.email);
  log_(user, 'resolveMaterial', item, '', p.action + (item !== typed ? ' — named "' + item + '" (typed "' + typed + '")' : ''));
  var logId = partLogWrite_(user, row, typed, p.action === 'addToList' ? 'named' : 'dropped',
                            p.action === 'addToList' ? item : '', created);
  return { ok: true, name: item, logId: logId };
}

/* ===================== EVERY NAMING DECISION, AND A WAY BACK (v84) ========================
 * Paul, 3 Nov: "a log for all the changes we've made, to be able to undo or edit them if we
 * click confirm by accident."
 *
 * Naming a part is one tap and it does three things at once - writes a catalogue row, renames
 * the usage row on a live job, and takes the question off the Requests tab. Until now the only
 * trace was a line in the Activity Log, which says what happened and cannot put it back. Every
 * decision is now a row of its own, carrying what was typed, what it was named, and whether a
 * catalogue row was created, which is exactly what an undo needs.
 *
 * The undo is conservative: the usage row goes back to being a question, the typed name comes
 * back, and the catalogue row is removed ONLY if this decision created it and nothing else has
 * used it since. A part somebody has since logged against a job stays, because deleting it would
 * strand that job's line. */
var PARTLOG_HEADERS = ['ID','At','Who','Row','Typed','Action','Named','Created','Undone At','Undone By'];
var PL_ = { ID:0, AT:1, WHO:2, ROW:3, TYPED:4, ACTION:5, NAMED:6, CREATED:7, UNAT:8, UNBY:9 };
function partLogSheet_() {
  var sh = masterSheet_(SHEETS.PARTLOG);
  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1,PARTLOG_HEADERS.length).setValues([PARTLOG_HEADERS]).setFontWeight('bold');
    try { sh.getRange(2, 2, sh.getMaxRows()-1, 1).setNumberFormat('@'); } catch (e) {}
  }
  return sh;
}
function partLogRows_() {
  var sh = partLogSheet_(), last = sh.getLastRow();
  return { sheet: sh, rows: last < 2 ? [] : sh.getRange(2,1,last-1,PARTLOG_HEADERS.length).getValues() };
}
/* action: "partsLog" - what we have named lately, newest first. */
function partsLog_(user, p) {
  requirePerm_(user, 'approveHours');
  var t = partLogRows_(), out = [];
  for (var i = t.rows.length - 1; i >= 0 && out.length < 40; i--) {
    var r = t.rows[i];
    if (!String(r[PL_.ID] || '')) continue;
    out.push({ id: String(r[PL_.ID]), at: String(r[PL_.AT] || ''), who: String(r[PL_.WHO] || ''),
      typed: String(r[PL_.TYPED] || ''), action: String(r[PL_.ACTION] || ''),
      named: String(r[PL_.NAMED] || ''), created: String(r[PL_.CREATED] || '') === 'yes',
      undoneAt: String(r[PL_.UNAT] || ''), undoneBy: String(r[PL_.UNBY] || '') });
  }
  return { decisions: out };
}
/* action: "partsUndo"  payload: { id } */
function partsUndo_(user, p) {
  requirePerm_(user, 'approveHours');
  var t = partLogRows_(), ix = -1;
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i][PL_.ID]) === String(p && p.id)) { ix = i; break; }
  if (ix < 0) throw new Error('That decision is not in the log any more.');
  var r = t.rows[ix];
  if (String(r[PL_.UNAT] || '')) throw new Error('That one has already been undone.');
  var row = Number(r[PL_.ROW]) || 0, typed = String(r[PL_.TYPED] || ''), named = String(r[PL_.NAMED] || '');
  var removed = '', note = [];
  // 1. the job line goes back to being a question, under the words that were actually typed
  var sh = matLogSheet_();
  if (row >= 2 && row <= sh.getLastRow()) {
    if (typed) sh.getRange(row, 6).setValue(txt_(typed));
    sh.getRange(row, 9).setValue('pending-review');
    sh.getRange(row, 10).setValue('');
    note.push('back on the Requests tab');
  } else note.push('the job line was already gone');
  // 2. the catalogue row, only if this decision made it and nobody has used it since
  if (String(r[PL_.CREATED] || '') === 'yes' && named) {
    var used = 0, lastLog = sh.getLastRow();
    if (lastLog >= 2) sh.getRange(2, 6, lastLog - 1, 4).getValues().forEach(function (x, k) {
      if (lc_(x[0]) === lc_(named) && (k + 2) !== row && lc_(x[3]) !== 'dismissed') used++;
    });
    if (used) note.push('"' + named + '" stays in the inventory - ' + used + ' other job line(s) use it');
    else {
      var ms = matSheet_(), mlast = ms.getLastRow();
      if (mlast >= 2) {
        var vals = ms.getRange(2, 1, mlast - 1, 1).getValues();
        for (var j = vals.length - 1; j >= 0; j--) {
          if (lc_(vals[j][0]) === lc_(named)) { ms.deleteRow(j + 2); removed = named; break; }
        }
      }
      note.push(removed ? '"' + removed + '" taken back out of the inventory' : 'nothing to remove from the inventory');
      try { CacheService.getScriptCache().remove('materials'); } catch (e) {}
    }
  }
  var now = new Date().toISOString();
  t.sheet.getRange(ix + 2, PL_.UNAT + 1, 1, 2).setValues([[now, user.email]]);
  log_(user, 'partsUndo', typed, String(p.id), note.join(' · '));
  return { ok: true, note: note.join(' · '), removed: removed };
}
function partLogWrite_(user, row, typed, action, named, created) {
  try {
    var sh = partLogSheet_(), id = newId_();
    sh.getRange(sh.getLastRow() + 1, 1, 1, PARTLOG_HEADERS.length).setValues([[
      id, new Date().toISOString(), user.email, row, txt_(typed), action, txt_(named),
      created ? 'yes' : '', '', '' ]]);
    return id;
  } catch (e) { return ''; }
}

// One-tap starter catalog: appends every SEED_MATERIALS item not already in the Materials
// sheet (deduped by name, case-insensitive), so it's safe to tap more than once and it
// never clobbers parts you've added or edited yourself.
function seedMaterials_(user) {
  requireAdmin_(user);
  var sh = matSheet_();
  var last = sh.getLastRow();
  var have = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function(r){ have[lc_(r[0])] = true; });
  var now = new Date().toISOString();
  var rows = [];
  SEED_MATERIALS.forEach(function(m){
    if (!have[lc_(m[0])]) rows.push([m[0], '', m[1] || 'ea', m[2] || '', 'seed', user.email, now]);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, MAT_HEADERS.length).setValues(rows);
  try { CacheService.getScriptCache().remove('materials'); } catch (e) {}
  log_(user, 'seedMaterials', '', '', rows.length + ' added, ' + (SEED_MATERIALS.length - rows.length) + ' already present');
  return { added: rows.length, skipped: SEED_MATERIALS.length - rows.length };
}

// ---------------------------------- AI receipt scan --------------------------------------------

// p: { dataBase64, mimeType, filename? }. Admin/approver only. Saves the photo to a
// "Receipts" folder in Drive, has Gemini extract the line items, then fuzzy-matches each
// against the Materials catalog. Returns items marked matched/new for the review screen —
// NOTHING is added to the catalog until the admin confirms (addMaterialsBulk).
function scanReceipt_(user, p) {
  // Open to ALL signed-in users — the crew adds what they bought without waiting on an
  // admin. Every add is stamped with who scanned it (audit trail in the Materials sheet
  // and the Activity Log), and the receipt photo is kept in Drive.
  if (!CONFIG.GEMINI_API_KEY) throw new Error('Receipt scanning is not set up yet — paste a free Google AI key into CONFIG.GEMINI_API_KEY (see the note in Code.gs).');
  if (!p.dataBase64) throw new Error('No photo received.');
  var ex = geminiExtractReceipt_(p.dataBase64, p.mimeType || 'image/jpeg');
  var extracted = ex.items;
  // File a DIGITIZED PDF (Charles, 4.x): the photo plus a typed, readable summary — vendor,
  // date, total, every line item — named so Janelle can find it. Falls back to the raw photo
  // if PDF conversion ever fails; either way, scanning proceeds.
  var receiptUrl = '';
  try {
    // Filed INSIDE the job's folder (Receipts subfolder, beside the photos) when the scan is
    // tied to a job; scans made while not clocked in go to the central Receipts folder.
    var parent = p.jobSite ? ensureJobFolder_(p.jobSite) : DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
    var it = parent.getFoldersByName('Receipts');
    var folder = it.hasNext() ? it.next() : parent.createFolder('Receipts');
    var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
    var rowsHtml = extracted.map(function(x){ return '<tr><td>' + esc(x.description) + '</td><td>' + esc(x.qty||'') + ' ' + esc(x.unit||'') + '</td><td style="text-align:right">' + (x.price ? ('$' + Number(x.price).toFixed(2)) : '') + '</td></tr>'; }).join('');
    var html = '<html><head><meta charset="utf-8"><style>body{font-family:Arial;font-size:11px;color:#111}' +
      'table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:5px;text-align:left}th{background:#eee}' +
      'h1{font-size:15px;margin:0 0 2px}</style></head><body>' +
      '<h1>Receipt — ' + esc(ex.vendor || 'supplier') + '</h1>' +
      '<p style="margin:2px 0 8px;color:#444">' + esc(ex.date || fmtDate_(new Date())) +
      (ex.total ? (' · Total $' + ex.total.toFixed(2)) : '') +
      (p.jobSite ? (' · Job: ' + esc(p.jobSite) + (p.poNumber ? (' (PO ' + esc(p.poNumber) + ')') : '')) : '') +
      ' · Scanned by ' + esc(user.email.split('@')[0]) + ' on ' + esc(fmtDate_(new Date())) + '</p>' +
      '<img src="data:' + (p.mimeType || 'image/jpeg') + ';base64,' + p.dataBase64 + '" style="width:100%;max-width:640px">' +
      '<h1 style="margin-top:10px">Items read from this receipt</h1>' +
      '<table><tr><th>Item</th><th>Qty</th><th style="text-align:right">Price</th></tr>' + (rowsHtml || '<tr><td colspan="3">—</td></tr>') + '</table>' +
      '</body></html>';
    var pdfName = 'Receipt — ' + (ex.vendor || 'supplier').replace(/[\\\/:*?"<>|]/g,'-') + ' — ' + (ex.date || fmtDate_(new Date())) +
      (p.jobSite ? (' — ' + String(p.jobSite).replace(/[\\\/:*?"<>|]/g,'-')) : '') + '.pdf';
    var dup = folder.getFilesByName(pdfName);
    if (dup.hasNext()) {
      receiptUrl = dup.next().getUrl(); // same vendor+date+job already filed — no doubles
    } else {
      var file = folder.createFile(Utilities.newBlob(html, 'text/html', 'r.html').getAs('application/pdf').setName(pdfName));
      file.setDescription('Scanned by ' + user.email);
      try { file.addViewer(user.email); } catch (e) {}
      receiptUrl = file.getUrl();
    }
  } catch (e) {
    try { // fallback: raw photo, as before
      var master2 = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
      var it2 = master2.getFoldersByName('Receipts');
      var folder2 = it2.hasNext() ? it2.next() : master2.createFolder('Receipts');
      var f2 = folder2.createFile(Utilities.newBlob(Utilities.base64Decode(p.dataBase64), p.mimeType || 'image/jpeg',
        p.filename || ('receipt-' + fmtDate_(new Date()) + '-' + newId_() + '.jpg')));
      f2.setDescription('Scanned by ' + user.email);
      receiptUrl = f2.getUrl();
    } catch (e2) {}
  }
  var mats = getMaterials_();
  var items = extracted.map(function(it){
    var name = String(it.description || '').trim();
    if (!name) return null;
    return { desc: name, qty: Number(it.qty) || '', unit: String(it.unit || 'ea').trim(),
      match: matchMaterial_(name, mats) };
  }).filter(function(x){ return x; });
  log_(user, 'scanReceipt', '', '', items.length + ' line item(s), ' +
    items.filter(function(i){ return !i.match; }).length + ' new');
  return { items: items, receiptUrl: receiptUrl, vendor: ex.vendor, date: ex.date, total: ex.total };
}

function geminiExtractReceipt_(b64, mime) {
  var prompt =
    'This photo is a receipt or invoice from an electrical/building supplier. Extract every ' +
    'material line item (skip subtotals, taxes, deposit fees, and payment lines). Reply with ' +
    'ONLY this JSON, no other text: {"vendor":"...","date":"YYYY-MM-DD","total":0.00,' +
    '"items":[{"description":"...","qty":1,"unit":"ea","price":0.00}]} . vendor is the store name; ' +
    'date is the receipt date; total is the final amount incl. tax; price is the line total if visible, else omit. ' +
    'Rules: expand supplier shorthand into plain Canadian electrical trade names, e.g. ' +
    '"CONN EMT SS 1/2" -> "EMT connector 1/2\\" set-screw", "NMD90 142 CU 75M" -> ' +
    '"NMD90 14/2 w/ ground". unit is one of: ea, m, ft, roll, box, pk. qty is the quantity ' +
    'purchased as a number.';
  var data = JSON.parse(geminiCall_(prompt, b64, mime));
  var text = '';
  try { text = data.candidates[0].content.parts[0].text; }
  catch (e) { throw new Error('AI scan returned no result — try a clearer photo.'); }
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
  try { var parsed = JSON.parse(text); return { items: parsed.items || [], vendor: String(parsed.vendor||''), date: String(parsed.date||''), total: Number(parsed.total)||0 }; }
  catch (e) { throw new Error('Could not read the receipt — try a straighter, better-lit photo.'); }
}

// Best fuzzy match of an extracted description against the catalog (name + aliases).
// Token-overlap SCORING, not first-hit: with 1000+ parts, a single shared word fragment
// isn't evidence ("capacitor" must not match "PVC cap"). Requires two strong token hits.
function matchMaterial_(desc, mats) {
  var norm = function(s){ return lc_(s).replace(/["']/g, '').replace(/(\d+)\s*amps?\b/g, '$1a'); }; // "15 amp" -> "15a"
  var toks = function(s){ return s.split(/[\s,\/x()-]+/).filter(function(t){ return t.length >= 1; }); };
  var d = norm(desc), dt = toks(d);
  var best = null, bestScore = 0;
  for (var i = 0; i < mats.length; i++) {
    var name = mats[i].name, n = norm(name);
    if (n === d) return name;                               // exact — done
    var hay = n + ' ' + norm(mats[i].aliases || '');
    var ht = toks(hay);
    var score = 0;
    for (var a = 0; a < dt.length; a++) {
      for (var b = 0; b < ht.length; b++) {
        var x = dt[a], y = ht[b];
        if (x === y) { score += 2; break; }                  // exact token (incl. sizes like "14", "1/2")
        if (x.length >= 3 && y.length >= 3 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) { score += 1; break; }
      }
    }
    if (hay.indexOf(d) >= 0) score += 3;                     // whole description appears verbatim
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return bestScore >= 4 ? best : null;                       // two solid hits minimum — else "new"
}

// p: { items: [{name, unit}] } — the confirmed "add these" list from the review screen.
// Dedupes against the existing catalog, same as the seed loader.
function addMaterialsBulk_(user, p) {
  // Open to all signed-in users (see scanReceipt_) — Source 'receipt' + Added By give
  // admins a clean audit trail without being a gate.
  var sh = matSheet_();
  var last = sh.getLastRow();
  var have = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function(r){ have[lc_(r[0])] = true; });
  var now = new Date().toISOString();
  var rows = [];
  (p.items || []).forEach(function(m){
    var name = String(m.name || '').trim();
    if (name && !have[lc_(name)]) { rows.push([name, '', String(m.unit || 'ea'), '', 'receipt', user.email, now]); have[lc_(name)] = true; }
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, MAT_HEADERS.length).setValues(rows);
  try { CacheService.getScriptCache().remove('materials'); } catch (e) {}
  log_(user, 'addMaterialsBulk', '', '', rows.length + ' added from receipt');
  return { added: rows.length };
}

// ---------------------------------- Job costing ------------------------------------------------

// All-time hours + labour cost per customer/job (admin + bookkeeper). Includes INACTIVE
// employees (their past hours still cost money) but not bookkeepers. Cost = hours × the
// worker's CURRENT hourly rate — if you change a rate later, history is re-priced at the
// new rate. Internal company time (PRO/PCW/GNG/General) shows as its own "Internal" rows.
/* v32 — JOB BUDGETS. One optional budget per job, kept on its own tab in the master sheet so
 * nothing else has to change shape. Key is the same job key jobCosts_ uses (PO# + name), so a
 * budget follows the job whether it is found by PO or by name. A job with no row here simply
 * has no budget and the app shows no percentage — most jobs will never get one. */
var BUDGET_HEADERS = ['PO#', 'Job site', 'Budget', 'Note', 'Set by', 'Set at'];
function budgetSheet_() {
  var sh = masterSheet_(SHEETS.BUDGETS);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, BUDGET_HEADERS.length).setValues([BUDGET_HEADERS]).setFontWeight('bold');
  return sh;
}
function jobKey_(po, name) { return String(po || '').trim() + '|' + String(name || '').trim().toLowerCase(); }

/* v86 - ONE JOB, ONE ROW. The Jobs tab used to key a job on PO# + the name typed on each entry,
 * so the same job split in two whenever either drifted: C26170 showed as "Angelica Alberto"
 * (0.01 h, the contact's name) AND "The Beauty Bar & Co." (13.86 h, the company), and a PO whose
 * letter was later corrected (R26170 -> C26170) left its older hours on a row of their own.
 * A job number's five digits (year + sequence) are unique by design - the letter is only the
 * job type - so a number shaped like a job is now keyed on its digits and named off the PO Log.
 * Anything not shaped like a job number (PRO, PCW, Shop, a bare name) keeps the old key exactly.
 * Two PO Log rows sharing the same digits (should never happen) keep their letter, so they are
 * never merged on a guess.
 *   idx: poJobIndex_() or null. Returns { key, po, site } or null for "not a job number". */
function jobByPo_(idx, po) {
  var raw = String(po || '').trim(), d = raw.replace(/\D/g, '');
  if (d.length !== 5) return null;
  var job = idx ? poJobLookup_(idx, raw) : null;
  var listed = !!(job && !job.unlisted);
  var key = (idx && (idx.dupDigits || {})[d]) ? ('po:' + poKeyV_(raw)) : ('job:' + d);
  return { key: key, po: listed ? job.po : raw.toUpperCase(), site: listed ? String(job.site || '').trim() : '' };
}
/* The Jobs-tab key for an entry or a request: the job number's when it has one, else the old one. */
function jobRowKey_(idx, po, name) {
  var hit = jobByPo_(idx, po);
  return hit ? hit.key : jobKey_(po, name);
}
/* { key -> {budget, note, by, at} } for every job that has one. */
function budgetMap_() {
  var out = {};
  try {
    var sh = budgetSheet_(), last = sh.getLastRow();
    if (last < 2) return out;
    sh.getRange(2, 1, last - 1, BUDGET_HEADERS.length).getValues().forEach(function (r) {
      var amt = Number(r[2]);
      if (!isFinite(amt) || amt <= 0) return;           // a cleared budget is a 0/blank row — treated as none
      out[jobKey_(r[0], r[1])] = { budget: amt, note: String(r[3] || ''), by: String(r[4] || ''), at: String(r[5] || ''),
        po: String(r[0] || '').trim(), jobName: String(r[1] || '').trim() };
    });
  } catch (e) {}
  return out;
}
/* p: { jobSite, po, budget, note } — budget 0 or '' clears it. Admins (or setRates) only, same
 * audience that can see dollars at all. */
function setJobBudget_(user, p) {
  requirePerm_(user, 'setRates');
  var name = String(p.jobSite || '').trim();
  var po = String(p.po || '').trim();
  if (!name && !po) throw new Error('No job given.');
  var amt = Number(p.budget);
  if (!isFinite(amt) || amt < 0) amt = 0;
  var sh = budgetSheet_(), last = sh.getLastRow(), key = jobKey_(po, name), row = 0;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) if (jobKey_(vals[i][0], vals[i][1]) === key) { row = i + 2; break; }
  }
  var rec = [asText_(po), txt_(name), amt || '', txt_(p.note || ''), user.email, new Date().toISOString()];
  if (row) sh.getRange(row, 1, 1, BUDGET_HEADERS.length).setValues([rec]);
  else sh.appendRow(rec);
  try { CacheService.getScriptCache().remove('jobCosts'); } catch (e) {}  // the next read must show it
  log_(user, amt ? 'setJobBudget' : 'clearJobBudget', name || po, '', amt ? ('$' + amt) : 'cleared');
  return { ok: true, budget: amt };
}

/* Every purchase line filed against a job, totalled per job key.
 *
 * WHY PURCHASES AND NOT "USED": scanning a supplier invoice adds the items to inventory AND
 * records the purchase against the job ("Job POs"); taking material onto a job takes it back
 * OUT of inventory and writes a "Job usage" row. The same physical item is therefore in both
 * tabs, so adding them would double-count. Purchases are also the only one of the two that is
 * captured automatically (the daily supplier-email sweep files them) — the usage tab is manual
 * and, as of v32, has never been used. So "spent on materials" = what was BOUGHT for the job.
 * Credit notes arrive as negative quantities, so a return subtracts itself.
 *
 * A line is attributed to AT MOST ONE job: PO# first (the reliable key — a line can be marked
 * job site "Stock" but still carry the job's PO), falling back to the job-site name. */
function jobMaterialCosts_(jobs, pidx) {
  // v86 - takes jobCosts_'s own job map (key -> { po, names }) instead of 'PO|name' strings, so a
  // purchase finds its job by the job NUMBER (any letter) and by ANY name the crew used for it.
  var byPo = {}, byName = {}, out = {};
  Object.keys(jobs || {}).forEach(function (k) {
    var j = jobs[k] || {};
    out[k] = 0;
    if (j.po) { var pk = jobRowKey_(pidx, j.po, ''); if (byPo[pk] === undefined) byPo[pk] = k; }
    var names = Object.keys(j.names || {});
    if (!names.length && j.name) names = [lc_(j.name)];
    names.forEach(function (n) { if (n && byName[n] === undefined) byName[n] = k; });   // first job wins a shared name
  });
  try {
    var sh = plTab_(POS_TAB, POS_HEADERS), last = sh.getLastRow();
    if (last < 2) return out;
    sh.getRange(2, 1, last - 1, POS_HEADERS.length).getValues().forEach(function (r) {
      var qty = Number(r[8]) || 0, price = Number(r[9]) || 0;
      if (!qty || !price) return;
      var po = String(r[3] || '').trim(), name = lc_(r[2]);
      var k = (po && byPo[jobRowKey_(pidx, po, '')]) || byName[name];   // PO first, then the job-site name
      if (!k) return;
      out[k] += qty * price;
    });
  } catch (e) {}                                        // the price list is a separate file; never break the Jobs tab over it
  return out;
}

/* All-time cost per job: labour (approved + pending, each at the employee's rate), materials
 * bought for it, the two added together, and the budget if one was set. */
function jobCosts_(user, p) {
  if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
    throw new Error('Not allowed.');
  try { var hit = CacheService.getScriptCache().get('jobCosts'); if (hit) return JSON.parse(hit); } catch (e) {}
  var emps = listEmployees_(user).employees.filter(function(e){ return e.role !== 'bookkeeper'; });
  var days = Math.max(1, Number(p.days) || 3650);
  var pidx = null;
  try { pidx = poJobIndex_(); } catch (e) {}    // v86 - the PO Log says which job a number is; unreadable = old keys
  var jobs = {};
  emps.forEach(function(emp){
    var rate = Number(emp.hourlyRate) || 0;
    var entries = listEntries_(user, { email: emp.email, days: days, maxRows: 20000 }).entries; // full history — 'all-time' must mean all time
    entries.forEach(function(e){
      var h = Number(e.Hours) || 0;
      if (!h || e.Status === 'rejected' || e.Status === 'deleted') return;
      var poRaw = String(e['PO#'] || '').trim();
      var hit = poRaw ? jobByPo_(pidx, poRaw) : null;
      // v86 - an entry with a job number but no name still belongs to that job (named off the PO Log)
      var name = String(e['Customer/Job Site'] || e.Company || '').trim() || (hit ? hit.site : '');
      if (!name) return;
      var key = hit ? hit.key : jobKey_(poRaw, name);
      var j = jobs[key] || (jobs[key] = { name: name, po: hit ? hit.po : poRaw, site: hit ? hit.site : '',
        hours: 0, pending: 0, cost: 0, pendingCost: 0, emps: {}, names: {} });
      var nk = lc_(name);                         // every name this job was clocked under, with its hours
      (j.names[nk] = j.names[nk] || { name: name, hours: 0 }).hours += h;
      var dd = dstr_(e.Date); if (dd && dd > (j.last || '')) j.last = dd;   // v102 - last day worked, for the Jobs tab order
      // v100 - each person's hours on the job, approved AND pending, by email (Today's money needs
      // their charged rate, and a person with only pending hours is still owed and still billed).
      if (e.Status === 'approved' || e.Status === 'pending') {
        var pp = j.people || (j.people = {});
        var pe = pp[emp.email] || (pp[emp.email] = { email: emp.email, name: emp.name, role: emp.role, hours: 0, pending: 0, cost: 0, pendingCost: 0 });
        if (e.Status === 'approved') { pe.hours += h; pe.cost += h * rate; } else { pe.pending += h; pe.pendingCost += h * rate; }
      }
      if (e.Status === 'approved') {
        j.hours += h; j.cost += h * rate;
        var be = j.emps[emp.email] || (j.emps[emp.email] = { name: emp.name, hours: 0, cost: 0 });
        be.hours += h; be.cost += h * rate;
      } else if (e.Status === 'pending') {
        // v32 — pending hours are money already owed, so they are costed too. Kept separate
        // from approved so the screen can say which part of the figure is not signed off yet.
        j.pending += h; j.pendingCost += h * rate;
      }
    });
  });
  // v86 - a job clocked under more than one name shows ONE name: the PO Log's, when the crew used
  // it, else the name with the most hours. Every job folder (photos, POs) is named off what was
  // typed at clock-in, so the shown name is always one that was really used; the rest ride along
  // as `aliases` so nothing is hidden.
  Object.keys(jobs).forEach(function (k) {
    var j = jobs[k], ns = Object.keys(j.names || {});
    if (!ns.length) return;
    ns.sort(function (a, b) { return j.names[b].hours - j.names[a].hours; });
    var sk = lc_(j.site);
    j.name = (sk && j.names[sk]) ? j.names[sk].name : j.names[ns[0]].name;
    var others = ns.map(function (n) { return j.names[n].name; }).filter(function (n) { return n !== j.name; });
    if (others.length) j.aliases = others;
  });
  // v32 — a job can have purchases before anyone has clocked in on it (material bought ahead of
  // the crew). Those jobs belong in the list too, at zero hours.
  // v86 - budgets are re-keyed the same way, so a budget follows its job across a name or a letter.
  var budgetsRaw = budgetMap_(), budgets = {};
  Object.keys(budgetsRaw).forEach(function (k) {
    var b = budgetsRaw[k];
    budgets[jobRowKey_(pidx, b.po, b.jobName)] = b;
  });
  Object.keys(budgets).forEach(function (k) {
    if (jobs[k]) return;
    var b = budgets[k];
    if (!b.po && !b.jobName) return;
    var bh = b.po ? jobByPo_(pidx, b.po) : null;
    jobs[k] = { name: b.jobName || (bh && bh.site) || b.po, po: bh ? bh.po : b.po, hours: 0, pending: 0, cost: 0, pendingCost: 0, emps: {}, names: {} };
  });
  var mats = jobMaterialCosts_(jobs, pidx);
  var poStatus = {}, poProject = {};
  try {
    getPoCustomers_().forEach(function(c){
      if (!c.po) return;
      poStatus[c.po] = c.status;
      poProject[c.po] = c.project || '';      // v74 - shown under the name on the Jobs tab
    });
  } catch (e) {}
  var money = canSeePrices_(user);   // crew never see dollars; this action is admin-gated anyway
  var out = [];
  Object.keys(jobs).forEach(function(k){
    var j = jobs[k];
    var el = Object.keys(j.emps).map(function(em){ var b = j.emps[em];
      return { name: b.name, hours: Math.round(b.hours * 100) / 100, cost: Math.round(b.cost * 100) / 100 }; });
    el.sort(function(a, b){ return b.hours - a.hours; });
    var labour = j.cost, pendingCost = j.pendingCost, materials = Math.round((mats[k] || 0) * 100) / 100;
    var total = Math.round((labour + pendingCost + materials) * 100) / 100;
    var rec = { name: j.name, po: j.po, project: j.po ? (poProject[j.po] || '') : '',
      status: j.po ? (poStatus[j.po] || '') : 'Internal',
      hours: Math.round(j.hours * 100) / 100, pending: Math.round(j.pending * 100) / 100,
      cost: Math.round(labour * 100) / 100, pendingCost: Math.round(pendingCost * 100) / 100,
      materials: materials, total: total, employees: el };
    if (j.aliases) rec.aliases = j.aliases;       // v86 - the other names this job was clocked under
    rec.last = j.last || '';                      // v102 - last day anyone worked it
    rec.people = Object.keys(j.people || {}).map(function (em) { var q = j.people[em];   // v100
      return { email: q.email, name: q.name, role: q.role, hours: Math.round(q.hours * 100) / 100, pending: Math.round(q.pending * 100) / 100,
               cost: Math.round(q.cost * 100) / 100, pendingCost: Math.round(q.pendingCost * 100) / 100 }; });
    var b = budgets[k];
    if (b) {
      rec.budget = b.budget;
      rec.budgetNote = b.note;
      rec.pctUsed = b.budget > 0 ? Math.round((total / b.budget) * 1000) / 10 : null;
      rec.remaining = Math.round((b.budget - total) * 100) / 100;
    }
    if (!money) { delete rec.cost; delete rec.pendingCost; delete rec.materials; delete rec.total; delete rec.budget; delete rec.people; }
    out.push(rec);
  });
  out.sort(function(a, b){ return (b.total || 0) - (a.total || 0); });
  var res = { jobs: out };
  try { CacheService.getScriptCache().put('jobCosts', JSON.stringify(res), 120); } catch (e) {} // 2-min staleness is fine here
  return res;
}

// Day-by-day drill-down for one job: every entry (date, who, hours, status), newest first.
// Same job key as jobCosts_ (PO# + name) so the numbers always reconcile with the totals.
function jobEntries_(user, p) {
  if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
    throw new Error('Not allowed.');
  // v86 - the same job key jobCosts_ now uses (the job number's digits when there is one), so the
  // day-by-day list shows every shift the Jobs tab counted, under whichever name it was clocked.
  var pidx = null;
  try { pidx = poJobIndex_(); } catch (e) {}
  var wantKey = jobRowKey_(pidx, String(p.po || '').trim(), String(p.jobSite || '').trim());
  var emps = listEmployees_(user).employees.filter(function(e){ return e.role !== 'bookkeeper'; });
  var rows = [];
  emps.forEach(function(emp){
    listEntries_(user, { email: emp.email, days: 3650, maxRows: 20000 }).entries.forEach(function(e){
      var h = Number(e.Hours) || 0;
      if (!h || e.Status === 'rejected' || e.Status === 'deleted') return;
      var poRaw = String(e['PO#'] || '').trim();
      var hit = poRaw ? jobByPo_(pidx, poRaw) : null;
      var name = String(e['Customer/Job Site'] || e.Company || '').trim() || (hit ? hit.site : '');
      if (!name) return;
      if ((hit ? hit.key : jobKey_(poRaw, name)) !== wantKey) return;
      rows.push({ date: String(e.Date || '').slice(0, 10) || (e.ClockIn ? String(e.ClockIn).slice(0, 10) : ''),
        who: emp.name, hours: h, status: e.Status,
        in: e.ClockIn || '', out: e.ClockOut || '', notes: String(e.Notes || '').substring(0, 120) });
    });
  });
  rows.sort(function(a, b){ return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  if (rows.length > 400) rows = rows.slice(0, 400); // cap the payload; 400 shifts is years of history
  return { rows: rows };
}

// ================================ TODAY (v87) ====================================================
/* The office home screen answers one question: WHAT NEEDS ME RIGHT NOW? Paul, 7 Nov 2026, step 3
 * of the dashboard build. It is put together here on an hourly timer and kept in the script cache,
 * so the screen opens on a stored answer instead of waiting on a dozen sheet reads; Refresh rebuilds
 * it on the spot. Everything it looks at is READ ONLY:
 *   - every employee's entries: forgotten clock-outs, this pay period's hours, and per job the hours
 *     and the last day anyone worked on it;
 *   - the PO Log: what is in progress, what is invoiced and waiting on payment, and what each job is
 *     called;
 *   - Paul's calendar for the next 60 days: a job with a visit booked is not "ready to bill" and a job
 *     with a visit booked does not need booking;
 *   - Charles's MANUAL hour sheets (CONFIG.HOUR_SHEETS). They are his backup and NOTHING here writes
 *     to them. Each day since the 1st of last month is compared with the app and anything MORE than
 *     half an hour apart is flagged (Paul's threshold). Only days up to the last one written on the
 *     sheet are compared - a sheet a few days behind is not a discrepancy - and a row is matched by
 *     the date written in it, never by the tab it sits on (Elijah's Oct 3-9 are on his November tab).
 *     A sheet that cannot be opened says so; it is never shown as zero hours.
 * Anything on the list can be put aside from the screen: an hours day with "Looks right" (it comes
 * back by itself if either number changes), a job with "Not yet" (it comes back after two weeks).
 * The screen never claims a job is finished - it says "no hours since Nov 3 and nothing booked",
 * which is what is actually known, and Paul decides. */
var TODAY_ = {
  CACHE_KEY: 'today_v87',
  CACHE_SECS: 21600,       // CacheService's ceiling; the hourly timer rebuilds long before it lapses
  HIDE_PROP: 'today_hide', // what has been put aside, and until when / while what
  FLAG_HOURS: 0.5,         // Paul, 7 Nov: flag a day MORE than half an hour apart (was a quarter)
  IDLE_DAYS: 2,            // no hours for this many days and nothing booked = worth billing
  BOOKED_AHEAD_DAYS: 60,
  SNOOZE_DAYS: 14,
  // v98 - leads to follow up: how long each kind waits before it shows
  FU_QUOTE_DAYS: 3,        // a price sent, no answer
  FU_CONFIRM_DAYS: 2,      // asked to confirm a booking, no answer
  FU_LEAD_DAYS: 2,         // a job waiting to be booked / an estimate request not priced
  FU_NEXT_DAYS: 3          // after a follow-up, check again in
};

/* The Today screen. Admins only - it carries every person's hours. payload: { fresh: true } rebuilds
 * now instead of answering from the cache (the Refresh button). */
function today_(user, p) {
  requireAdmin_(user);
  p = p || {};
  todayEnsureTrigger_();
  var snap = null;
  if (!p.fresh) {
    try { var hit = CacheService.getScriptCache().get(TODAY_.CACHE_KEY); if (hit) snap = JSON.parse(hit); } catch (e) {}
  }
  if (!snap) snap = todayRebuild_();
  return todayView_(snap);
}

/* Build and keep. Also the body of the hourly timer. */
function todayRebuild_() {
  var snap = todayBuild_();
  try { CacheService.getScriptCache().put(TODAY_.CACHE_KEY, JSON.stringify(snap), TODAY_.CACHE_SECS); } catch (e) {}
  return snap;
}

/* The timer's handler. A failure is written to the Activity Log and swallowed - Google mails a digest
 * of every failed timed run, and one bad read must not turn into a morning email (see v73). The next
 * run, an hour later, simply tries again. */
function todayRefresh() {
  try { todayRebuild_(); }
  catch (e) { log_({ email: 'system' }, 'todayRefresh FAILED', '', '', String(e && e.message || e)); }
}

/* Run once from the editor if the timer ever goes missing. today_ also puts it back by itself. */
function setupTodayRefresh() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'todayRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('todayRefresh').timeBased().everyHours(1).create();
  todayRefresh();
}

/* The hourly timer installs itself the first time the screen is opened - nobody has to run anything
 * from the editor. Checked at most every six hours, and never allowed to stop the screen loading. */
function todayEnsureTrigger_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); if (cache.get('today_trig')) return; } catch (e) {}
  try {
    withLock_(function () {
      var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'todayRefresh'; });
      if (!has) {
        ScriptApp.newTrigger('todayRefresh').timeBased().everyHours(1).create();
        log_({ email: 'system' }, 'todayTimer', 'todayRefresh', '', 'hourly timer installed');
      }
    });
    if (cache) cache.put('today_trig', '1', 21600);
  } catch (e) {}
}

function todayR2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function todayR1_(n) { return Math.round((Number(n) || 0) * 10) / 10; }

/* The work day of an entry: its Date cell (the day the shift STARTED, which is what payroll keys on),
 * else the clock-in read in Alberta time. Never the first ten characters of a UTC clock-in - a shift
 * started at 9:30 pm is the next day in UTC (Charles, Nov 6). */
function todayEntryDay_(e) {
  var raw = e.Date;
  if (raw) {
    var s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    if (!isNaN(d)) return fmtDate_(d);
  }
  if (e.ClockIn) { var c = new Date(e.ClockIn); if (!isNaN(c)) return fmtDate_(c); }
  return '';
}

/* A date typed on a manual hour sheet, read loosely: 10/2/2026, 09/01/2026, 10/3/26, 2026-10-02.
 * '' for blank, null for something that cannot be read safely - 6/5/3026 is reported, never guessed. */
function todaySheetDate_(v, yNow) {
  if (v instanceof Date) return isNaN(v) ? null : fmtDate_(v);
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (yNow && Math.abs(y - yNow) > 1) return null;
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

/* A PO Log date cell (a real date, 2026-06-04 or 6/15/2026) as YYYY-MM-DD, or ''. */
function todayCellDate_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : fmtDate_(v);
  var d = todaySheetDate_(v, 0);
  return d || '';
}

/* Whole days from a to b, both YYYY-MM-DD (noon, so no clock change or zone can shift the count). */
function todayDaysBetween_(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

/* How an app entry reads on the hours check: "R26178 Nate hillman", or the internal company. */
function todayAppLabel_(e, hit) {
  var name = String(e['Customer/Job Site'] || '').trim();
  if (hit) return (hit.po + ' ' + (hit.site || name)).trim();
  return name || String(e.Company || '').trim() || 'Shop';
}

/* How an hour-sheet line reads: the job as the PO Log names it, else what was typed in Place. */
function todaySheetLabel_(place, d5, pidx) {
  if (d5.length === 5) {
    var hit = jobByPo_(pidx, place);
    if (hit) return (hit.po + ' ' + (hit.site || '')).trim();
    return place.toUpperCase();
  }
  return place;
}

/* Job numbers on the calendar from now on: { digits: {'26195':1}, text: 'every title, lower-cased' }.
 * Only numbers written as a job number and shaped like this year's or last year's jobs count - a
 * five-digit house number in a description must not mark a job as booked. */
function todayBooked_(now) {
  var end = new Date(now.getTime() + TODAY_.BOOKED_AHEAD_DAYS * 86400000);
  var yy = now.getFullYear() % 100, ok = {};
  ok[pad2_(yy)] = 1; ok[pad2_((yy + 99) % 100)] = 1;
  var out = { digits: {}, text: '' }, titles = [];
  visitCal_().getEvents(now, end).forEach(function (ev) {
    var title = '', desc = '';
    try { title = ev.getTitle() || ''; desc = ev.getDescription() || ''; } catch (e) {}
    // R26195 / C26170 - the job-type letter, as every booking the app makes writes it - or "PO 26195".
    // A bare five digits is NOT enough: "26170 Twp Rd 834" is a house, not job C26170.
    var re = /\b(?:[CRIMcrim]|PO\s*#?\s*|job\s*#?\s*)(\d{5})\b/g, m, s = title + ' ' + desc;
    while ((m = re.exec(s))) if (ok[m[1].slice(0, 2)]) out.digits[m[1]] = 1;
    titles.push(lc_(title));
  });
  out.text = titles.join(' | ');
  return out;
}
/* A booking typed by hand often carries only the customer's name ("Paddy - tie in"). */
function todayNameBooked_(booked, name) {
  var n = lc_(name);
  return !!(booked && n.length >= 5 && booked.text.indexOf(n) >= 0);
}

/* One person's manual hour sheet against the app, day by day.
 * The sheets are one workbook per year with a tab per month: in January only December is compared
 * until CONFIG.HOUR_SHEETS points at the new year's workbooks - `through` (the last day written)
 * goes out with the answer, so a sheet that has stopped being filled in shows as exactly that.
 *   rec: { email, name, days: { 'YYYY-MM-DD': { total, rows: [...] } } } from the app
 * Returns { email, name, from, to, through, error, unreadable: [...], days: [flagged day, ...] }. */
function todayHoursCheck_(rec, sheetId, winStart, lastDay, now, pidx) {
  var out = { email: rec.email, name: rec.name, from: '', to: '', through: '', error: '', unreadable: [], days: [] };
  var sheetDays = {}, first = '';
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                  'September', 'October', 'November', 'December'];
    var yNow = now.getFullYear();
    // Last month, this month and next month: rows are matched on the DATE in them, and a late
    // entry is usually typed onto a later month's tab than the one it belongs to.
    [-1, 0, 1].forEach(function (k) {
      var tabName = MONTHS[(now.getMonth() + k + 12) % 12];
      var sh = ss.getSheetByName(tabName);
      if (!sh) return;
      var last = sh.getLastRow();
      if (last < 1) return;
      sh.getRange(1, 1, last, 7).getDisplayValues().forEach(function (r, i) {
        var hrs = parseFloat(String(r[6] || '').replace(/[^0-9.\-]/g, ''));
        if (!(hrs > 0)) return;                        // empty lines carry 0.00; headers carry words
        var dateText = String(r[0] || '').trim();
        if (!dateText) return;                         // "Weekly Total:" lines have no date
        var day = todaySheetDate_(dateText, yNow);
        if (!day) {
          if (out.unreadable.length < 5) out.unreadable.push({ tab: tabName, row: i + 1, text: dateText });
          return;
        }
        var place = String(r[1] || '').trim(), pd = place.replace(/\D/g, '');
        var k2 = pd.length === 5 ? 'j' + pd : (place ? 'shop' : '');
        var sd = sheetDays[day] || (sheetDays[day] = { total: 0, rows: [], blank: false });
        sd.total += hrs;
        if (!k2) sd.blank = true;
        sd.rows.push({ k: k2, h: todayR2_(hrs), label: todaySheetLabel_(place, pd, pidx),
          task: String(r[2] || '').trim().slice(0, 60), start: String(r[3] || '').trim(), end: String(r[4] || '').trim() });
        if (day > out.through) out.through = day;
        if (day >= winStart && (!first || day < first)) first = day;
      });
    });
  } catch (e) {
    out.error = "Can't read " + rec.name + "'s hour sheet (" + String(e && e.message || e) + ').';
    return out;
  }
  if (!out.through || !first) return out;              // nothing written in the window yet
  var from = first, to = out.through < lastDay ? out.through : lastDay;
  out.from = from; out.to = to;
  var dayset = {};
  Object.keys(rec.days).forEach(function (d) { if (d >= from && d <= to) dayset[d] = 1; });
  Object.keys(sheetDays).forEach(function (d) { if (d >= from && d <= to) dayset[d] = 1; });
  var LIM = TODAY_.FLAG_HOURS + 1e-9;
  Object.keys(dayset).sort().forEach(function (d) {
    var a = rec.days[d] || { total: 0, rows: [] }, s = sheetDays[d] || { total: 0, rows: [], blank: false };
    var at = todayR2_(a.total), st = todayR2_(s.total), kind = '', off = [];
    if (Math.abs(at - st) > LIM) kind = 'total';
    else if (s.rows.length && !s.blank) {
      // Same hours that day - but on the same jobs? Only asked when every line on the sheet names
      // a place; Charles's own sheet leaves Place blank, so his days are checked on the total alone.
      var ak = {}, sk = {}, keys = {};
      a.rows.forEach(function (x) { ak[x.k] = (ak[x.k] || 0) + x.h; keys[x.k] = 1; });
      s.rows.forEach(function (x) { sk[x.k] = (sk[x.k] || 0) + x.h; keys[x.k] = 1; });
      Object.keys(keys).forEach(function (k) { if (Math.abs((ak[k] || 0) - (sk[k] || 0)) > LIM) off.push(k); });
      if (off.length) kind = 'job';
    }
    if (!kind) return;
    out.days.push({ date: d, app: at, sheet: st, kind: kind,
      appRows: a.rows.map(function (x) { return { label: x.label, h: todayR2_(x.h), in: x.in, out: x.out, st: x.st }; }),
      sheetRows: s.rows.map(function (x) { return { label: x.label, h: x.h, task: x.task, start: x.start, end: x.end }; }),
      key: 'hrs:' + rec.email + ':' + d,
      fp: at.toFixed(2) + '|' + st.toFixed(2) + (kind === 'job' ? '|' + off.sort().join(',') : '') });
  });
  return out;
}

/* Everything the screen shows, before anything put aside is taken out. */
function todayBuild_() {
  var t0 = Date.now(), now = new Date(), errors = [];
  var sys = { email: 'system', role: 'admin', permissions: defaultPermissions_('admin') };
  var todayStr = fmtDate_(now);
  var yestStr = fmtDate_(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
  var winStart = fmtDate_(new Date(now.getFullYear(), now.getMonth() - 1, 1, 12));
  var curPk = periodKey_(now), prevPk = prevPeriodKey_(now);
  var pidx = null;
  try { pidx = poJobIndex_(); } catch (e) { errors.push('PO Log: ' + String(e && e.message || e)); }
  var emps = listEmployees_(sys).employees.filter(function (e) { return e.active && e.role !== 'bookkeeper'; });

  // ---- every person's entries, read once ----
  var jobs = {}, people = [], items = [], fixes = [], byEmail = {};
  emps.forEach(function (emp) {
    var rec = { email: emp.email, name: emp.name, role: emp.role, cur: 0, prev: 0, pend: 0, days: {} };
    var list = [];
    try { list = listEntries_(sys, { email: emp.email, days: 3650, maxRows: 20000 }).entries; }
    catch (e) { errors.push(emp.name + "'s hours: " + String(e && e.message || e)); }
    byEmail[lc_(emp.email)] = list;
    list.forEach(function (e) {
      if (!e.EntryID || e.Status === 'rejected' || e.Status === 'deleted') return;
      var fx = todayFixCheck_(e);                     // v91 - entries that need a person to correct them
      if (fx) fixes.push(Object.assign(fx, { kind: 'fix', key: 'fix:' + e.EntryID, email: emp.email, name: emp.name,
        fp: String(e['Last Edited At'] || ''), entry: e, label: emp.name + ' · ' + fx.short }));
      if (e.ClockIn && !e.ClockOut) {                 // still on the clock - it has no hours yet
        if (e.Source === 'live') {
          var open = (now - new Date(e.ClockIn)) / 3600000;
          if (open >= (Number(CONFIG.FORGOT_CLOCKOUT_HOURS) || 12)) items.push({ kind: 'open',
            key: 'open:' + e.EntryID, email: emp.email, name: emp.name, since: String(e.ClockIn),
            hours: todayR1_(open), site: String(e['Customer/Job Site'] || e.Company || '').trim(),
            label: emp.name + ' still clocked in' });
        }
        return;
      }
      var h = Number(e.Hours) || 0;
      if (!h) return;
      var day = todayEntryDay_(e);
      var pk = String(e.PeriodKey || '') || (day ? periodKey_(new Date(day + 'T12:00:00')) : '');
      if (pk === curPk) { rec.cur += h; if (e.Status === 'pending') rec.pend += h; }
      else if (pk === prevPk) rec.prev += h;
      var poRaw = String(e['PO#'] || '').trim(), d5 = poRaw.replace(/\D/g, '');
      var hit = d5.length === 5 ? jobByPo_(pidx, poRaw) : null;
      if (day && day >= winStart) {
        var dd = rec.days[day] || (rec.days[day] = { total: 0, rows: [] });
        dd.total += h;
        dd.rows.push({ k: d5.length === 5 ? 'j' + d5 : 'shop', h: h, label: todayAppLabel_(e, hit),
          in: String(e.ClockIn || ''), out: String(e.ClockOut || ''), st: e.Status === 'pending' ? 'pending' : '' });
      }
      if (d5.length === 5) {
        var j = jobs[d5] || (jobs[d5] = { hours: 0, pending: 0, last: '' });
        if (e.Status === 'pending') j.pending += h; else j.hours += h;
        if (day && day > j.last) j.last = day;
      }
    });
    people.push(rec);
  });

  // ---- the hours check, against Charles's manual sheets (read only) ----
  var hoursGroups = [], cfg = CONFIG.HOUR_SHEETS || {};
  people.forEach(function (rec) {
    var id = cfg[lc_(rec.email)];
    if (id) hoursGroups.push(todayHoursCheck_(rec, id, winStart, yestStr, now, pidx));
  });

  // ---- the calendar, then the PO Log ----
  var booked = { digits: {}, text: '' }, calOk = true;
  try { booked = todayBooked_(now); } catch (e) { calOk = false; errors.push('Calendar: ' + String(e && e.message || e)); }
  var inProg = [], invoiced = [], bill = [], draft = [], book = [], poOk = true, closed = 0, paid = [];
  var paidFrom = fmtDate_(new Date(now.getFullYear(), now.getMonth(), now.getDate() - MONEY_.PAID_DAYS, 12));
  try {
    var t = poLogOpen_(), sh = t.sh, last = sh.getLastRow();
    if (last > t.headerRow) {
      var C = function (label, dflt) { return t.cols[label] || dflt; };
      var cPo = C('po number', CONFIG.PO_NUMBER_COL), cCon = C('contact person', CONFIG.PO_CONTACT_COL),
          cCo = C('company name', CONFIG.PO_CUSTOMER_COL), cPr = C('project name', CONFIG.PO_PROJECT_COL),
          cS = C('start date', CONFIG.PO_STARTDATE_COL), cE = C('end date', CONFIG.PO_ENDDATE_COL),
          cQb = C('po number in quickbooks', CONFIG.PO_QB_COL), cSt = C('status', CONFIG.PO_STATUS_COL),
          cPh = C('phone number', CONFIG.PO_PHONE_COL), cEm = C('email address', CONFIG.PO_EMAIL_COL);
      var cell = function (r, c) { return c ? r[c - 1] : ''; };
      sh.getRange(t.headerRow + 1, 1, last - t.headerRow, sh.getLastColumn()).getValues().forEach(function (r) {
        var po = String(cell(r, cPo) || '').trim(), d5 = po.replace(/\D/g, '');
        if (!po || d5.length !== 5) return;
        var st = lc_(cell(r, cSt));
        if (st !== 'closed' && st !== 'in progress' && st !== 'invoiced') return;
        var contact = String(cell(r, cCon) || '').trim();
        var row = { po: po, name: String(cell(r, cCo) || '').trim() || contact || po, contact: contact,
          project: String(cell(r, cPr) || '').trim(), start: todayCellDate_(cell(r, cS)), end: todayCellDate_(cell(r, cE)),
          qb: String(cell(r, cQb) || '').trim(), seq: Number(d5) };
        if (st === 'closed') {                            // v88 - paid, for the desktop's job pipeline
          closed++;
          if (row.end && row.end >= paidFrom) paid.push(row);   // v100 - the last 90 days, for money per job
          return;
        }
        if (st === 'invoiced') { invoiced.push(row); return; }
        var j = jobs[d5] || { hours: 0, pending: 0, last: '' };
        row.hours = todayR1_(j.hours + j.pending); row.last = j.last;    // v88 - the desktop's "On the go"
        inProg.push(row);
        var isBooked = !!booked.digits[d5] || todayNameBooked_(booked, row.name) || todayNameBooked_(booked, contact);
        var base = { po: po, name: row.name, project: row.project, label: po + ' ' + row.name };
        if (row.qb) {
          // The initial draft is in QuickBooks (it writes the number here) but the row still says In
          // progress: the invoice has not been finished and sent.
          draft.push(Object.assign(base, { kind: 'draft', key: 'draft:' + po, qb: row.qb,
            hours: todayR2_(j.hours), pending: todayR2_(j.pending) }));
        } else if (j.hours + j.pending > 0) {
          var idle = todayDaysBetween_(j.last, todayStr);
          if (idle >= TODAY_.IDLE_DAYS && !isBooked) bill.push(Object.assign(base, { kind: 'bill', key: 'bill:' + po,
            hours: todayR2_(j.hours), pending: todayR2_(j.pending), last: j.last, idle: idle, calOk: calOk }));
        } else if (!isBooked && !(row.start && row.start > todayStr)) {
          book.push(Object.assign(base, { kind: 'book', key: 'book:' + po, contact: contact, start: row.start,
            phone: String(cell(r, cPh) || '').trim(), email: String(cell(r, cEm) || '').trim(), calOk: calOk }));
        }
      });
    }
  } catch (e) { poOk = false; errors.push('PO Log: ' + String(e && e.message || e)); }
  bill.sort(function (a, b) { return b.idle - a.idle; });           // longest-waiting money first
  var refused = [];
  try { refused = todayRefused_(byEmail, emps, now); } catch (e) { errors.push('Activity Log: ' + String(e && e.message || e)); }
  items = items.concat(fixes, refused, bill, draft, book);
  var follow = [];
  try { follow = todayFollow_(now); } catch (e) { errors.push('Requests: ' + String(e && e.message || e)); }
  var money = null;
  if (poOk) { try { money = todayMoney_(sys, inProg, invoiced, paid, fixes); } catch (e) { errors.push('Money per job: ' + String(e && e.message || e)); } }
  // v101 - the inbox's invitations to bid, onto the Bids tab (Today reads the tab itself, fresh)
  try { bidsSweep_(now); } catch (e) { errors.push('Bids from the inbox: ' + String(e && e.message || e)); }

  // Newest = the one that started most recently (Paddy, Nov 6), not the highest number.
  inProg.sort(function (a, b) { return (a.start || '') < (b.start || '') ? 1 : (a.start || '') > (b.start || '') ? -1 : b.seq - a.seq; });
  invoiced.sort(function (a, b) { return (a.end || '9999') < (b.end || '9999') ? -1 : 1; });
  var crew = people.filter(function (p) { return p.role === 'employee'; }).map(function (p) {
    return { name: p.name, cur: todayR1_(p.cur), prev: todayR1_(p.prev), pend: todayR1_(p.pend) };
  });
  return {
    v: 87, builtAt: now.toISOString(), ms: Date.now() - t0, window: { from: winStart, to: yestStr },
    tiles: {
      // A PO Log that could not be read is null, never 0 - the screen says it could not read it.
      inProgress: { n: poOk ? inProg.length : null, newest: inProg[0] ? { po: inProg[0].po, name: inProg[0].name, start: inProg[0].start } : null },
      invoiced: { n: poOk ? invoiced.length : null, oldest: invoiced[0] ? { po: invoiced[0].po, name: invoiced[0].name, end: invoiced[0].end } : null },
      crew: crew, period: { cur: curPk, prev: prevPk },
      // v88 - the desktop layout: paid jobs for the pipeline, and every job in progress with its hours.
      closed: poOk ? closed : null,
      onGo: inProg.slice().sort(function (a, b) { return b.hours - a.hours; }).map(function (r) {
        return { po: r.po, name: r.name, hours: r.hours, last: r.last }; })
    },
    hours: hoursGroups, items: items, follow: follow, money: money, calendar: calOk, errors: errors
  };
}

/* ================= v100 - MONEY PER JOB (Paul, 8 Nov: "build money per job on the Today screen") ===
 * For every job in progress, invoiced and waiting to be paid, or paid in the last MONEY_.PAID_DAYS:
 *   cost      = labour (approved + pending hours x each person's PAY rate) + the supplier POs filed to
 *               the job - jobCosts_, so it is the same Payroll Cost and Material Cost as the Cost tab.
 *   worth     = what it comes to at Paul's rates: each person's hours (approved + pending) rounded to
 *               the half hour, x their CHARGED rate (Team > the person > Charged rate); the journeyman
 *               line raised to match an apprentice's hours (his invoice rule, Oct 29); plus materials
 *               with the markup tier chosen on the job's total material cost (43 / 36 / 30 / 20 %).
 *               Travel, km and permits are not in it.
 *   invoiced  = the Amount Invoiced typed on the Cost tab, for invoiced and paid jobs; when it is blank
 *               the screen shows the worth instead and says it is an estimate.
 * plus the quote the customer was sent (Estimates Sent, matched through the job number on Requests),
 * the job's budget if one was set, any entry on it that Today says needs fixing, and anyone whose
 * hours are on it with no charged rate. Read only. */
var MONEY_ = {
  TIERS: [[1000, 0.43], [5000, 0.36], [10000.0001, 0.30], [Infinity, 0.20]],   // on the job's TOTAL materials
  PAID_DAYS: 90
};
function moneyTier_(c) { for (var i = 0; i < MONEY_.TIERS.length; i++) if (c < MONEY_.TIERS[i][0]) return MONEY_.TIERS[i][1]; return 0.20; }
function moneyR0_(n) { return Math.round(Number(n) || 0); }
/* The Amount Invoiced column of the Cost tab, by the job number's five digits. Found by its header. */
function costTabInvoiced_() {
  var out = {};
  var cs = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID).getSheetByName('Cost');
  if (!cs) return out;
  var last = cs.getLastRow(); if (last < 2) return out;
  var width = Math.min(cs.getLastColumn(), 26);
  var top = cs.getRange(1, 1, Math.min(20, last), width).getValues(), hdr = -1, cInv = -1;
  for (var i = 0; i < top.length; i++) if (lc_(top[i][0]) === 'po number') { hdr = i; break; }
  if (hdr < 0) return out;
  top[hdr].forEach(function (h, k) { if (lc_(h) === 'amount invoiced') cInv = k; });
  if (cInv < 0 || last <= hdr + 1) return out;
  cs.getRange(hdr + 2, 1, last - hdr - 1, cInv + 1).getValues().forEach(function (r) {
    var d = String(r[0] || '').replace(/\D/g, ''); if (d.length !== 5 || out[d] !== undefined) return;   // first row wins, as the refresh does
    var v = r[cInv]; if (v === '' || v === null) return;
    var n = Number(String(v).replace(/[$,\s]/g, '')); if (isFinite(n)) out[d] = n;
  });
  return out;
}
function todayMoney_(sys, inProg, invoiced, paid, fixes) {
  var allEmps = listEmployees_(sys).employees, rate = {}, role = {}, nameOf = {}, top = '', topRate = 0;
  allEmps.forEach(function (e) {
    var em = lc_(e.email), r = Number(e.permissions && e.permissions.chargeRate) || 0;
    rate[em] = r; role[em] = e.role; nameOf[em] = e.name;
    if (e.active && r > topRate) { topRate = r; top = em; }          // the journeyman: the highest charged rate
  });
  try { CacheService.getScriptCache().remove('jobCosts'); } catch (e) {}
  var jc = jobCosts_(sys, { days: 3650 }).jobs || [];
  var byD = {};
  jc.forEach(function (j) {
    var d = String(j.po || '').replace(/\D/g, ''); if (d.length !== 5) return;
    var b = byD[d] || (byD[d] = { hours: 0, pending: 0, labour: 0, mat: 0, budget: 0, people: {} });
    b.hours += Number(j.hours) || 0; b.pending += Number(j.pending) || 0;
    b.labour += (Number(j.cost) || 0) + (Number(j.pendingCost) || 0);
    b.mat += Number(j.materials) || 0;
    if (j.budget) b.budget = Math.max(b.budget, Number(j.budget) || 0);
    (j.people || []).forEach(function (p) {
      var em = lc_(p.email), q = b.people[em] || (b.people[em] = { email: em, name: p.name, role: p.role, hours: 0, pending: 0, cost: 0 });
      q.hours += Number(p.hours) || 0; q.pending += Number(p.pending) || 0; q.cost += (Number(p.cost) || 0) + (Number(p.pendingCost) || 0);
    });
  });
  var inv = {};
  try { inv = costTabInvoiced_(); } catch (e) {}
  var quotes = {};
  try {
    var qm = quoteMap_();
    reqScan_().rows.forEach(function (r) {
      var d = String(r[23] || '').replace(/\D/g, ''), q = qm[String(r[0] || '')];
      if (d.length !== 5 || !q || !(q.high || q.low)) return;
      var have = quotes[d], yes = q.answer === 'yes';
      if (!have || (yes && have.answer !== 'yes') || (yes === (have.answer === 'yes') && String(q.sentAt) > String(have.sentAt)))
        quotes[d] = { low: q.low, high: q.high || q.low, answer: q.answer, sentAt: q.sentAt };
    });
  } catch (e) {}
  var fixByD = {};
  (fixes || []).forEach(function (f) {
    var d = String((f.entry && f.entry['PO#']) || '').replace(/\D/g, ''); if (d.length !== 5) return;
    (fixByD[d] = fixByD[d] || []).push({ key: f.key, short: f.short, name: f.name });
  });
  var noRateAll = {};
  var build = function (row, stage) {
    var d = String(row.po).replace(/\D/g, ''), c = byD[d] || { hours: 0, pending: 0, labour: 0, mat: 0, budget: 0, people: {} };
    var people = Object.keys(c.people).map(function (em) {
      var p = c.people[em], h = p.hours + p.pending, bh = Math.round(h * 2) / 2, r = rate[em] || 0;
      if (h > 0 && r <= 0) noRateAll[em] = nameOf[em] || p.name;
      return { email: em, name: nameOf[em] || p.name, hours: todayR2_(p.hours), pending: todayR2_(p.pending),
               cost: todayR2_(p.cost), billHours: bh, rate: r, bill: todayR2_(bh * r) };
    }).filter(function (p) { return p.hours || p.pending; });
    people.sort(function (a, b) { return (b.hours + b.pending) - (a.hours + a.pending); });
    // The journeyman was on site at least as long as the apprentice: his line is raised to match.
    var match = null;
    if (top && topRate > 0) {
      var need = 0;
      people.forEach(function (p) { if (p.email !== top && role[p.email] === 'employee' && p.billHours > need) need = p.billHours; });
      var jm = people.filter(function (p) { return p.email === top; })[0], have = jm ? jm.billHours : 0;
      if (need > have) match = { name: nameOf[top] || 'Journeyman', hours: need - have, rate: topRate, bill: todayR2_((need - have) * topRate) };
    }
    var labourBill = people.reduce(function (s, p) { return s + p.bill; }, 0) + (match ? match.bill : 0);
    var matCost = todayR2_(c.mat), tier = matCost > 0 ? moneyTier_(matCost) : 0, matBill = matCost > 0 ? todayR2_(matCost * (1 + tier)) : 0;
    var cost = todayR2_(c.labour + matCost), worth = todayR2_(labourBill + matBill);
    var o = { po: row.po, name: row.name, project: row.project || '', stage: stage, start: row.start || '', end: row.end || '', qb: row.qb || '',
      hours: todayR1_(c.hours + c.pending), pending: todayR1_(c.pending), labourCost: todayR2_(c.labour), labourBill: todayR2_(labourBill),
      matCost: matCost, tier: tier, matBill: matBill, cost: cost, worth: worth, people: people, match: match,
      budget: c.budget || 0, fixes: fixByD[d] || [],
      noRate: people.filter(function (p) { return p.rate <= 0; }).map(function (p) { return p.name; }) };
    if (quotes[d]) o.quote = quotes[d];
    if (stage !== 'wip') o.invoiced = inv[d] !== undefined ? todayR2_(inv[d]) : null;
    o.revenue = (stage !== 'wip' && o.invoiced != null) ? o.invoiced : worth;
    o.estimate = stage !== 'wip' && o.invoiced == null;
    o.margin = todayR2_(o.revenue - cost);
    o.pct = o.revenue > 0 ? Math.round(o.margin / o.revenue * 100) : null;
    return o;
  };
  var wip = inProg.map(function (r) { return build(r, 'wip'); });
  var owed = invoiced.map(function (r) { return build(r, 'invoiced'); });
  var done = paid.map(function (r) { return build(r, 'paid'); });
  var sum = function (list) {
    var t = { n: list.length, revenue: 0, cost: 0, margin: 0, estimates: 0, empty: 0 };
    list.forEach(function (j) {
      if (!j.cost && !j.revenue) { t.empty++; return; }
      t.revenue += j.revenue; t.cost += j.cost; t.margin += j.margin; if (j.estimate) t.estimates++;
    });
    t.revenue = moneyR0_(t.revenue); t.cost = moneyR0_(t.cost); t.margin = moneyR0_(t.margin);
    t.pct = t.revenue > 0 ? Math.round(t.margin / t.revenue * 100) : null;
    return t;
  };
  return { wip: wip, owed: owed, paid: done, totals: { wip: sum(wip), owed: sum(owed), paid: sum(done) },
    noRate: Object.keys(noRateAll).map(function (em) { return { email: em, name: noRateAll[em] }; }),
    journeyman: top ? { email: top, name: nameOf[top], rate: topRate } : null, paidDays: MONEY_.PAID_DAYS };
}

/* ================= v98 - LEADS TO FOLLOW UP (Paul, 8 Nov: "build the leads follow-up on the
 * Today screen") ===================================================================================
 * The customers who have gone quiet, read off the Requests tab and the Estimates Sent log:
 *   quote    - a price emailed FU_QUOTE_DAYS+ ago, no Yes or No back
 *   confirm  - asked to confirm a booking FU_CONFIRM_DAYS+ ago, no answer, the visit still ahead
 *   newtime  - they said the time does not work, or their slot was given to another job
 *   cancelled- they cancelled from the email and the booking is still on the calendar
 *   book     - a job waiting to be booked for FU_LEAD_DAYS+ (a website job, or a yes to a price)
 *   price    - an estimate request not priced after FU_LEAD_DAYS
 * Each carries what is needed to ring, text or email them, and how often they have been followed up
 * (the Follow-ups tab). Nothing here contacts a customer - the app opens the phone's own dialer,
 * messages or mail with the words filled in, and the person sends it. */
SHEETS.FOLLOWUPS = 'Follow-ups';
var FU_HEADERS_ = ['At', 'By', 'Request ID', 'Customer', 'Waiting on', 'How', 'Note', 'Check again'];
function fuSheet_() {
  var sh = masterSheet_(SHEETS.FOLLOWUPS);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, FU_HEADERS_.length).setValues([FU_HEADERS_]).setFontWeight('bold');
  return sh;
}
function fuDate_(v) { if (!v) return null; var d = v instanceof Date ? v : new Date(v); return isNaN(d) ? null : d; }
function todayFollow_(now) {
  var t = reqScan_(), q = quoteMap_(), DAY = 86400000, out = [];
  var tries = {};                                         // 'sub:id' -> { n, last }
  var fs = fuSheet_(), fl = fs.getLastRow();
  if (fl >= 2) fs.getRange(2, 1, fl - 1, FU_HEADERS_.length).getValues().forEach(function (r) {
    var k = String(r[4] || '') + ':' + String(r[2] || ''); if (!r[2]) return;
    var x = tries[k] || (tries[k] = { n: 0, last: null });
    x.n++; x.last = { at: fuDate_(r[0]) ? fuDate_(r[0]).toISOString() : String(r[0] || ''), by: String(r[1] || ''), how: String(r[5] || ''), note: String(r[6] || '') };
  });
  var todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  t.rows.forEach(function (r) {
    var id = String(r[0] || ''); if (!id) return;
    var type = String(r[3] || '').toUpperCase(), st = String(r[14] || ''), conf = String(r[25] || '');
    var start = fuDate_(r[15]), base = {
      id: id, name: String(r[4] || '').trim() || 'Customer', phone: String(r[5] || '').trim(), email: String(r[6] || '').trim(),
      address: String(r[7] || '').trim(), scope: String(r[8] || '').trim(), po: String(r[23] || '').trim(),
      eventId: String(r[18] || ''), start: start ? start.toISOString() : '' };
    var add = function (sub, since, detail) {
      var sd = fuDate_(since), k = sub + ':' + id, tr = tries[k] || { n: 0, last: null };
      out.push(Object.assign({}, base, { kind: 'fu', sub: sub, key: 'fu:' + k, since: sd ? sd.toISOString() : '',
        days: sd ? Math.max(0, Math.floor((now - sd) / DAY)) : 0, detail: detail || '', tries: tr.n, last: tr.last,
        label: base.name + ' · ' + sub }));
    };
    if (st === 'quoted') {
      var qs = q[id]; if (!qs || qs.answer) return;
      var sent = fuDate_(qs.sentAt); if (!sent || now - sent < TODAY_.FU_QUOTE_DAYS * DAY) return;
      add('quote', sent, quotePriceText_(qs.low, qs.high));
    } else if (st === 'scheduled') {
      if (start && start.getTime() < todayMid) return;               // the visit has been and gone
      if (conf === 'declined') add('newtime', fuDate_(r[20]) || fuDate_(r[27]) || now, '');
      else if (conf === 'cancelled') add('cancelled', fuDate_(r[20]) || fuDate_(r[27]) || now, '');
      else if (conf === 'waiting') {
        // v99 - a dragged job keeps 'waiting' but loses its token and nobody was emailed about the
        // NEW time: count from the move (Decided At), and say so, instead of from the old email.
        var told = String(r[26] || '').trim() !== '', asked = told ? fuDate_(r[27]) : (fuDate_(r[20]) || fuDate_(r[27]));
        if (!asked || now - asked < TODAY_.FU_CONFIRM_DAYS * DAY) return;
        add('confirm', asked, told ? '' : 'not told');
      }
    } else if (st === 'pending') {
      if (String(r[30] || '').trim()) { add('newtime', fuDate_(r[20]) || fuDate_(r[1]) || now, 'moved off ' + String(r[30])); return; }
      var qs2 = q[id], since = (qs2 && qs2.answer === 'yes' && fuDate_(qs2.answeredAt)) || fuDate_(r[1]);
      if (!since || now - since < TODAY_.FU_LEAD_DAYS * DAY) return;
      if (type === 'ESTIMATE') add('price', since, '');
      else add('book', since, qs2 && qs2.answer === 'yes' ? 'said yes to ' + quotePriceText_(qs2.low, qs2.high) : '');
    }
  });
  var order = { newtime: 0, cancelled: 1, confirm: 2, quote: 3, book: 4, price: 5 };
  out.sort(function (a, b) { return (order[a.sub] - order[b.sub]) || (b.days - a.days); });
  return out;
}

/* payload: { key, id, sub, name, how: call|text|email|voicemail|note, note, days }. Writes a
 * Follow-ups row and puts the person aside until the next check. */
function followUp_(user, p) {
  requirePerm_(user, 'approveHours');   // v99 - the office, not only admins
  p = p || {};
  var key = String(p.key || ''), id = String(p.id || ''), sub = String(p.sub || '');
  if (!/^fu:/.test(key) || !id) throw new Error('Nothing to log.');
  var how = /^(call|text|email|voicemail|note)$/.test(String(p.how)) ? String(p.how) : 'note';
  var days = Math.max(1, Math.min(30, Number(p.days) || TODAY_.FU_NEXT_DAYS));
  var next = new Date(Date.now() + days * 86400000);
  // Same tap sent twice (a lost answer and a replay): one row, not two.
  var sh = fuSheet_(), last = sh.getLastRow();
  if (last >= 2) {
    var tail = sh.getRange(Math.max(2, last - 20), 1, Math.min(21, last - 1), FU_HEADERS_.length).getValues();
    for (var i = 0; i < tail.length; i++) {
      var at = fuDate_(tail[i][0]);
      if (String(tail[i][2]) === id && String(tail[i][4]) === sub && String(tail[i][5]) === how && at && Date.now() - at < 120000)
        return { ok: true, until: next.toISOString(), duplicate: true };
    }
  }
  sh.appendRow([new Date().toISOString(), user.email, id, String(p.name || '').slice(0, 120), sub, how,
                String(p.note || '').slice(0, 500), next.toISOString()]);
  var map = todayHideMap_();
  map[key] = { until: next.getTime(), at: Date.now(), by: user.email };
  todayHideSave_(map);
  log_(user, 'followUp', String(p.name || ''), id, sub + ' · ' + how + (p.note ? ' · ' + p.note : '') + ' · next ' + days + ' d');
  return { ok: true, until: next.toISOString() };
}

/* What has been put aside: { key: { fp } } hides while the numbers are the same, { until } hides
 * until a time. */
function todayHideMap_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TODAY_.HIDE_PROP) || '{}') || {}; }
  catch (e) { return {}; }
}
function todayHideSave_(map) {
  var now = Date.now(), keys = Object.keys(map);
  keys.forEach(function (k) {
    var h = map[k] || {};
    if (h.until && Number(h.until) < now) delete map[k];                      // snooze ran out
    else if (h.fp != null && now - Number(h.at || 0) > 120 * 86400000) delete map[k];   // long-gone days
  });
  // A script property holds 9 KB: drop the oldest decisions first if it ever fills.
  var order = Object.keys(map).sort(function (a, b) { return Number(map[a].at || 0) - Number(map[b].at || 0); });
  while (order.length && JSON.stringify(map).length > 8500) delete map[order.shift()];
  PropertiesService.getScriptProperties().setProperty(TODAY_.HIDE_PROP, JSON.stringify(map));
}

/* payload: { key, fp } "looks right" (comes back if the numbers move), { key, days } "not yet",
 * { key, unhide: true } put it back. */
function todayHide_(user, p) {
  requireAdmin_(user);
  p = p || {};
  var key = String(p.key || '').slice(0, 140);
  if (!/^(hrs|bill|draft|book|open|fix|refused|fu):/.test(key)) throw new Error('Nothing to put aside.');
  var map = todayHideMap_();
  if (p.unhide) delete map[key];
  else if (p.fp != null && p.fp !== '') map[key] = { fp: String(p.fp).slice(0, 80), at: Date.now(), by: user.email };
  else {
    var days = Math.max(1, Math.min(90, Number(p.days) || TODAY_.SNOOZE_DAYS));
    map[key] = { until: Date.now() + days * 86400000, at: Date.now(), by: user.email };
  }
  todayHideSave_(map);
  log_(user, p.unhide ? 'todayUnhide' : 'todayHide', key, '',
       p.unhide ? '' : (p.fp ? 'while ' + p.fp : 'for ' + (Number(p.days) || TODAY_.SNOOZE_DAYS) + ' days'));
  return { ok: true };
}

/* The snapshot as the screen gets it: anything put aside moved to `hidden`, and the hours count
 * worked out from what is left. */
function todayView_(snap) {
  var map = todayHideMap_(), now = Date.now(), hidden = [];
  var isHidden = function (key, fp) {
    var h = map[key];
    if (!h) return false;
    if (h.fp != null) return h.fp === fp;
    return Number(h.until || 0) > now;
  };
  var hours = (snap.hours || []).map(function (g) {
    var keep = (g.days || []).filter(function (d) {
      if (!isHidden(d.key, d.fp)) return true;
      hidden.push({ key: d.key, label: g.name + ' · hours on ' + d.date });
      return false;
    });
    return Object.assign({}, g, { days: keep });
  });
  var items = (snap.items || []).filter(function (it) {
    if (!isHidden(it.key, it.fp)) return true;
    hidden.push({ key: it.key, label: it.label || it.key });
    return false;
  });
  var n = 0, people = [], unreadable = [];
  hours.forEach(function (g) {
    if (g.error) unreadable.push(g.name);
    if (g.days.length) { n += g.days.length; people.push({ name: g.name, n: g.days.length }); }
  });
  var tiles = Object.assign({}, snap.tiles || {}, { hours: { n: n, people: people, unreadable: unreadable } });
  // v98 - followed-up customers are not "put aside"; they are waiting, and are counted apart.
  var waiting = [];
  var follow = (snap.follow || []).filter(function (it) {
    var h = map[it.key];
    if (h && Number(h.until || 0) > now) { waiting.push({ key: it.key, label: it.name, sub: it.sub, until: new Date(Number(h.until)).toISOString(), tries: it.tries }); return false; }
    return true;
  });
  return { v: snap.v, builtAt: snap.builtAt, ms: snap.ms, window: snap.window, tiles: tiles, hours: hours,
           items: items, hidden: hidden, follow: follow, followWaiting: waiting, money: snap.money || null, calendar: snap.calendar, errors: snap.errors || [],
           bids: todayBids_() };
}

/* ================= v101 - BID DEADLINES (Paul, 8 Nov: "add bid deadlines to the app") =============
 * The GC tenders PRO is invited to price. Until now they lived only in the inbox - and a closing date
 * there is not where you would look for it: Lavergne filed the City Service Centre roof job under
 * "Closing Nov 13 2026" and then moved it to Nov 16 in a reply ("the tenders close date change to
 * Nov. 16th @ 2pm"); BuildingConnected puts "Bid Due: November 10, 2026" only in the body; and
 * ConstructConnect writes "Bid Date: Fri, Oct 16, 2026 02:00 PM ET" - Eastern, so noon here.
 *
 * bidsSweep_ runs with every Today build (the hourly timer, and Refresh). It reads - only reads - the
 * last BID_.LOOKBACK_DAYS days of invitations to tender or bid and keeps a "Bids" tab on the app's own
 * workbook, one row per bid:
 *   - the CLOSING DATE comes from the newest thing anyone at the GC wrote: a reply saying the date
 *     changed beats the subject line it sits under. A message's own words are read before what it
 *     quotes, so an old date in the quoted text never wins over the new one.
 *   - a time zone written beside the time is honoured; no time at all is kept as a date, and the app
 *     says the time was not given instead of inventing 2 pm.
 *   - an invitation whose closing had already passed by BID_.SKIP_PAST_DAYS when first seen is not
 *     added (the first run would otherwise fill the tab with September's tenders).
 *   - our own reply in the thread carrying an attachment and the word bid / tender / price / quote
 *     marks it Sent.
 *   - a closing date Paul typed in the app is never overwritten; a different date in a later email is
 *     written in the bid's note for him to see.
 *   - the same tender arriving again in a new thread (a forward, an addendum with its own subject) from
 *     the same GC is matched to the bid already there on the project's words, not added twice.
 * Nothing is sent, replied to, labelled or marked read. bidSave adds a bid by hand or changes one.
 * Statuses: new (not decided yet), bidding, sent, passed (not bidding), won, lost. */
SHEETS.BIDS = 'Bids';
var BID_HEADERS_ = ['ID', 'Added', 'Source', 'GC', 'Project', 'Where', 'Closes', 'Time given', 'Status',
  'Email threads', 'From', 'Subject', 'Date said', 'Date set by', 'Note', 'Updated', 'Updated by', 'Last email', 'Date emailed'];
var BC_ = { id: 0, added: 1, src: 2, gc: 3, proj: 4, where: 5, closes: 6, timed: 7, st: 8, th: 9, from: 10,
  subj: 11, said: 12, by: 13, note: 14, upd: 15, updBy: 16, last: 17, saidAt: 18 };
var BID_ = {
  LOOKBACK_DAYS: 45,       // how far back the inbox is read
  SKIP_PAST_DAYS: 2,       // a NEW invitation already this far past its closing is not added
  SHOW_PAST_DAYS: 3,       // an undecided / bidding bid stays on Today this long after it closes
  WAIT_DAYS: 60,           // a sent bid is listed as waiting to hear back for this long
  CACHE_KEY: 'bids_v1', LAST_PROP: 'bids_last', SKIP_PROP: 'bids_skip2',   // skip2 (10 Nov): the not-a-bid memory starts over once, so anything the looser rules of the morning dropped is read again
  STATUSES: ['new', 'bidding', 'sent', 'passed', 'won', 'lost'],
  PLATFORMS: /buildingconnected\.com|isqftmail\.com|isqft\.com|constructconnect\.com|bidsandtenders\.ca|merx\.com|procore\.com|planhub\.com|smartbidnet\.com|pipelinesuite\.com|bidnet/i,
  // Our own mail, the suppliers (their "bid closes today" is a reply to OUR quote request), and Google's
  // calendar reminders.
  SKIP_FROM: /@(?:[\w.-]+\.)?(?:proes\.ca|pcwagyu\.com)\b|eecol|bartlegibson|homehardware|northernmetallic|barobinson|calendar-notification@google\.com|@google\.com|surveymonkey/i,
  QUERY: '-in:spam -in:trash (subject:(tender OR "bid invite" OR "invitation to bid" OR "invited to bid" OR closing OR "bid closes" OR "bid due" OR rfq OR rfp OR "request for quote" OR "request for proposal" OR addendum OR addenda) OR from:(buildingconnected.com OR isqftmail.com OR constructconnect.com OR bidsandtenders.ca OR merx.com))'
};

function bidSheet_() {
  var sh = masterSheet_(SHEETS.BIDS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, BID_HEADERS_.length).setValues([BID_HEADERS_]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function bidRows_(sh) {
  var last = sh.getLastRow(); if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, BID_HEADERS_.length).getValues().map(function (v, i) { return { row: i + 2, v: v }; })
    .filter(function (x) { return String(x.v[BC_.id] || '').trim(); });
}
function bidObj_(v) {
  var c = fuDate_(v[BC_.closes]), t = v[BC_.timed];
  return { id: String(v[BC_.id]), added: fuDate_(v[BC_.added]) ? fuDate_(v[BC_.added]).toISOString() : '', src: String(v[BC_.src] || ''),
    gc: String(v[BC_.gc] || ''), project: String(v[BC_.proj] || ''), where: String(v[BC_.where] || ''),
    closes: c ? c.toISOString() : '', timed: t === true || lc_(t) === 'true',
    status: BID_.STATUSES.indexOf(lc_(v[BC_.st])) >= 0 ? lc_(v[BC_.st]) : 'new',
    threads: String(v[BC_.th] || '').split(/[\s,]+/).filter(Boolean), from: String(v[BC_.from] || ''),
    subject: String(v[BC_.subj] || ''), said: String(v[BC_.said] || ''), by: String(v[BC_.by] || ''),
    note: String(v[BC_.note] || ''), updated: fuDate_(v[BC_.upd]) ? fuDate_(v[BC_.upd]).toISOString() : '' };
}
function bidsAll_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); var hit = cache.get(BID_.CACHE_KEY); if (hit) return JSON.parse(hit); } catch (e) {}
  var list = bidRows_(bidSheet_()).map(function (x) { return bidObj_(x.v); });
  try { if (cache) cache.put(BID_.CACHE_KEY, JSON.stringify(list), 21600); } catch (e) {}
  return list;
}
function bidsCacheDrop_() { try { CacheService.getScriptCache().remove(BID_.CACHE_KEY); } catch (e) {} }

/* What Today shows: every bid still being decided, priced or waiting on its closing (and for
 * SHOW_PAST_DAYS after, so a missed one is seen), plus the ones sent and waiting to hear back. */
function bidsForToday_(now) {
  now = now || new Date();
  var DAY = 86400000, list = [];
  bidsAll_().forEach(function (b) {
    var c = b.closes ? new Date(b.closes).getTime() : null;
    if (b.status === 'new' || b.status === 'bidding') { if (c == null || c >= now - BID_.SHOW_PAST_DAYS * DAY) list.push(b); }
    else if (b.status === 'sent') { if (c == null || c >= now - BID_.WAIT_DAYS * DAY) list.push(b); }
  });
  var checked = '';
  try { checked = PropertiesService.getScriptProperties().getProperty(BID_.LAST_PROP) || ''; } catch (e) {}
  return { list: list, checked: checked };
}

/* ---------- reading a closing date out of words ---------- */
var BID_MON_ = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
// Alberta has been UTC-6 all year since Nov 2026 and the zone database now labels that "CST", so CST
// (and Saskatchewan's) is our own time; a GC here writing MST/MDT means local time too.
var BID_TZ_ = { et: 'America/Toronto', est: 'America/Toronto', edt: 'America/Toronto', eastern: 'America/Toronto',
  ct: 'America/Winnipeg', cdt: 'America/Winnipeg', central: 'America/Winnipeg', cst: 'America/Regina',
  mt: '', mst: '', mdt: '', mountain: '', pt: 'America/Vancouver', pst: 'America/Vancouver', pdt: 'America/Vancouver', pacific: 'America/Vancouver' };
var BID_KEY_RE_ = /\b(?:clos(?:e|es|ed|ing)|bid\s+due|due\s+date|bid\s+date|deadline|submissions?\s+(?:are\s+)?due|due\s+(?:on|by)|submit\s+by)\b/gi;
var BID_DATE_RE_ = /\b(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(20\d\d)\b)?|\b(20\d\d)-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s*(20\d\d)?\b/gi;
var BID_TIME_RE_ = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])\s*(et|est|edt|eastern|ct|cst|cdt|central|mt|mst|mdt|mountain|pt|pst|pdt|pacific)?\b|\b(\d{1,2}):(\d{2})\s*(et|est|edt|eastern|ct|cst|cdt|central|mt|mst|mdt|mountain|pt|pst|pdt|pacific)?\b|\b(noon)\b/i;

function bidTz_() { try { return Session.getScriptTimeZone() || 'America/Edmonton'; } catch (e) { return 'America/Edmonton'; } }
/* The instant a wall-clock time in a zone happens. */
function bidAt_(y, mo, d, h, mi, tz) {
  tz = tz || bidTz_();
  var guess = Date.UTC(y, mo, d, h, mi), at = guess;
  for (var i = 0; i < 2; i++) {
    var z = Utilities.formatDate(new Date(at), tz, 'Z');            // "-0600"
    var off = (z.charAt(0) === '-' ? -1 : 1) * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2)));
    at = guess - off * 60000;
  }
  return new Date(at);
}
function bidClean_(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&nbsp;/gi, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}
/* The first closing date said in these words (or the NEW one, when the sentence moves it), with the time
 * if one sits beside it. ref is when the words were written - it decides a missing year. */
function bidFindClose_(text, ref) {
  var s = bidClean_(text); if (!s) return null;
  ref = ref || new Date();
  BID_KEY_RE_.lastIndex = 0;
  var k;
  while ((k = BID_KEY_RE_.exec(s))) {
    var win = s.slice(k.index, k.index + 110), dates = [], m;
    BID_DATE_RE_.lastIndex = 0;
    while ((m = BID_DATE_RE_.exec(win))) dates.push(m);
    if (!dates.length) continue;
    // "moved from Nov 13 to Nov 16", "extended to ...", "changed to ...": the later date is the new one
    var pick = dates[0];
    if (dates.length > 1 && /\b(?:chang\w*|mov\w*|extend\w*|extension|postpon\w*|revis\w*|new\s+(?:clos\w*|date)|now)\b/i.test(win.slice(0, dates[dates.length - 1].index)))
      pick = dates[dates.length - 1];
    var y, mo, d;
    if (pick[1]) { mo = BID_MON_[pick[1].toLowerCase().slice(0, pick[1].toLowerCase() === 'sept' ? 4 : 3)]; d = +pick[2]; y = pick[3] ? +pick[3] : null; }
    else if (pick[4]) { y = +pick[4]; mo = +pick[5] - 1; d = +pick[6]; }
    else { d = +pick[7]; mo = BID_MON_[pick[8].toLowerCase().slice(0, 3)]; y = pick[9] ? +pick[9] : null; }
    if (mo == null || isNaN(mo) || d < 1 || d > 31) continue;
    if (!y) {
      y = ref.getFullYear();
      if (new Date(y, mo, d) < new Date(ref.getTime() - 60 * 86400000)) y++;      // "Jan 5" written in December
    }
    // the time: right after the date, or between the keyword and the date ("closes at 2 pm on Nov 16")
    var after = win.slice(pick.index + pick[0].length, pick.index + pick[0].length + 34);
    var before = win.slice(0, pick.index);
    var afterT = after.replace(/^[\s,.]*(?:@|at|by|-)?\s*/i, ' '), t = BID_TIME_RE_.exec(afterT);
    if (t && t.index > 8) t = null;
    if (!t) t = BID_TIME_RE_.exec(before);
    var h = 14, mi = 0, timed = false, tzName = '', zone = '';
    if (t) {
      if (t[8]) { h = 12; mi = 0; timed = true; }
      else if (t[1]) {
        h = +t[1] % 12 + (/^p/i.test(t[3]) ? 12 : 0); mi = t[2] ? +t[2] : 0; tzName = (t[4] || '').toLowerCase(); timed = h < 24 && mi < 60;
      } else if (t[5] && +t[5] <= 23) { h = +t[5]; mi = +t[6]; tzName = (t[7] || '').toLowerCase(); timed = mi < 60; }
      if (!timed) { h = 14; mi = 0; tzName = ''; }
    }
    if (tzName) zone = BID_TZ_[tzName] || '';
    var at = bidAt_(y, mo, d, h, mi, zone);
    var said = (win.slice(0, pick.index + pick[0].length) + (t && afterT.indexOf(t[0]) >= 0 && afterT.indexOf(t[0]) <= 9 ? ' ' + t[0].trim() : '')).trim();
    return { at: at, timed: timed, said: said.slice(0, 120), tz: tzName };
  }
  return null;
}

/* A message's own words: what it says before it starts quoting or forwarding. */
function bidFresh_(body) {
  var s = String(body || '');
  var cuts = [/\n[ \t]*On [^\n]{4,200}\n?[^\n]{0,120}wrote:/, /\n[ \t]*-{2,}\s*Forwarded message/i, /\n[ \t]*-{2,}\s*Original Message/i,
    /\n[ \t]*From:[^\n]*\n[ \t]*(?:Sent|Date):/i, /\n[ \t]*_{8,}/];
  cuts.forEach(function (re) { var m = re.exec(s); if (m) s = s.slice(0, m.index); });
  return s.split('\n').filter(function (l) { return !/^\s*>/.test(l); }).join('\n');
}
function bidIsUs_(from) { return /@(?:[\w.-]+\.)?proes\.ca\b/i.test(String(from || '')); }
function bidAddr_(from) { var m = /<([^>]+)>/.exec(String(from || '')); return lc_(m ? m[1] : from); }
function bidGc_(from, body) {
  var name = ((/^\s*"?([^"<]+?)"?\s*</.exec(String(from || '')) || [])[1] || '').trim();
  var paren = /\(([^)]+)\)\s*$/.exec(name);
  if (paren) return paren[1].trim();
  var bc = /\bfrom\s+(.{3,80}?)\s+has\s+invited\s+you/i.exec(bidClean_(body));
  if (bc) return bc[1].trim();
  if (name && !/\b(team|no-?reply|transmittals?|notifications?|bids?)\b/i.test(name)) return name;
  var dom = (/@([^>\s]+)/.exec(String(from || '')) || [])[1] || '';
  return dom.replace(/\.(com|ca|net|org)$/i, '');
}
function bidProject_(subject, body) {
  var b = bidClean_(body);
  var bc = /invited\s+you\s+to\s+bid\s+on\s+(.{4,200}?)\s*-{5,}/i.exec(b);
  var cc = /invitation\s+to\s+bid\s+on\s+(.{4,200}?)\s+from\s+/i.exec(b);
  var s = bidClean_(subject)
    .replace(/^((?:re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/^(?:bid\s+invite|invitation\s+to\s+(?:tender|bid)|itb|rfq|rfp|request\s+for\s+(?:quote|quotation|proposal)s?)\s*[:\-]\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, '')
    .replace(/^are\s+you\s+bidding\??\s*[-:]\s*/i, '')                                         // v102 - the platform's reminder
    .replace(/^.{0,80}?\b(?:will\s+not\s+be\s+submitting\s+a\s+bid|is\s+not\s+bidding|has\s+withdrawn)\s*[-:]\s*/i, '')   // v102 - a GC pulling out
    .replace(/\s*[-(]\s*(?:tender\s+|bid\s+)?(?:clos(?:e|es|ed|ing)|due)\b.*$/i, '')
    .replace(/\s*-\s*addend\w*.*$/i, '')
    .replace(/[\s\-:]+$/, '').trim();
  if ((/(\.\.\.|…)$/.test(s) || !s) && (bc || cc)) s = (bc || cc)[1];
  return s.replace(/(\.\.\.|…)$/, '').trim();
}
function bidWhere_(body) {
  var m = /Location:\s*\n?\s*([^\n]{3,80})/i.exec(String(body || ''));
  return m ? bidClean_(m[1]) : '';
}
function bidWords_(s) {
  var stop = { with: 1, from: 1, that: 1, this: 1, your: 1, bids: 1, tender: 1, tenders: 1, closing: 1, invitation: 1,
    project: 1, building: 1, buildings: 1, addendum: 1, addenda: 1, addendums: 1, electrical: 1, renovation: 1, peace: 1, river: 1 };
  var out = {};
  String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).forEach(function (w) {
    if (w.length >= 4 && !stop[w] && !/^20\d\d$/.test(w)) out[w] = 1;
  });
  return Object.keys(out);
}
/* Is this thread an invitation to bid, and what does it say? null = not a bid. */
function bidReadThread_(th, now) {
  var msgs = th.getMessages(); if (!msgs.length) return null;
  var first = null;
  for (var i = 0; i < msgs.length; i++) if (!bidIsUs_(msgs[i].getFrom())) { first = msgs[i]; break; }
  if (!first || bidIsUs_(msgs[0].getFrom())) return null;          // we started it (a quote request to a supplier)
  var from = first.getFrom();
  if (BID_.SKIP_FROM.test(from)) return null;
  var subject = first.getSubject() || th.getFirstMessageSubject() || '';
  var body = first.getPlainBody() || '';
  var head = bidClean_(subject + ' ' + body.slice(0, 2500));
  var platform = BID_.PLATFORMS.test(from);
  // v102 - a survey about the platform is not an invitation (ConstructConnect's "Share your experience")
  // (audit, 10 Nov: not when the subject is itself an invitation - "RFQ - infrared survey of the panels" is work)
  if (/\bsurvey\b|share\s+your\s+.{0,60}experience|gift\s+card/i.test(subject) &&
      !/invitation|invited|bid\s+invite|\btenders?\b|\brf[qp]\b|request\s+for\s+(?:quote|quotation|proposal)/i.test(subject)) return null;
  // v102 - a GC telling the subs it will not bid ("Westland Will Not Be Submitting a Bid - Lubicon...")
  // (audit, 10 Nov: judged by the SUBJECT, plus that one exact sentence in the body. An invitation that
  // says "let us know if your company is not bidding" is still an invitation and must not be dropped.)
  var withdrawn = /will\s+not\s+be\s+submitting\s+a\s+bid|\bis\s+not\s+(?:bidding|submitting)\b|has\s+withdrawn|no\s+longer\s+(?:bidding|tendering)/i.test(subject) ||
                  /will\s+not\s+be\s+submitting\s+a\s+bid\s+on\b/i.test(body.slice(0, 600));
  var signal = /invitation\s+to\s+(?:tender|bid)|invited\s+(?:you\s+)?to\s+bid|bid\s+invite|\btenders?\b|\bbid\s+(?:closes|closing|due|date)\b|\brfq\b|\brfp\b|request\s+for\s+(?:quote|quotation|proposal)|\baddend(?:um|a)\b/i.test(head);
  if (!platform && !signal) return null;
  var strong = platform || /invitation\s+to\s+(?:tender|bid)|bid\s+invite|\btender\b/i.test(subject);
  // the closing date: the newest GC message's own words first, then its subject, then the invitation in full
  var close = null, sent = null;
  for (var j = msgs.length - 1; j >= 0; j--) {
    var m = msgs[j];
    if (bidIsUs_(m.getFrom())) {
      if (!sent && j > 0) {
        var own = bidFresh_(m.getPlainBody());
        var files = [];
        try { files = m.getAttachments({ includeInlineImages: false }); } catch (e) { files = []; }
        if (files.length && /\b(bid|tender|pric\w*|quot\w*|proposal)\b/i.test(own) && !/\brfi\b|\bquestions?\b|clarif/i.test(own)) sent = m.getDate();
      }
      continue;
    }
    if (BID_.SKIP_FROM.test(m.getFrom())) continue;
    var c = bidFindClose_(bidFresh_(m.getPlainBody()), m.getDate());
    if (c) { c.on = m.getDate(); close = c; break; }
  }
  if (!close) {
    var newest = null;
    for (var n = msgs.length - 1; n >= 0; n--) if (!bidIsUs_(msgs[n].getFrom())) { newest = msgs[n]; break; }
    var ns = String(newest.getSubject() || '');
    var subjC = bidFindClose_(ns, newest.getDate()) || bidFindClose_(ns.replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)*(\d{4}-\d{2}-\d{2})\s*-/i, 'closing $1 -'), newest.getDate());
    if (subjC) { subjC.on = newest.getDate(); close = subjC; }
  }
  if (!close) { var full = bidFindClose_(body, first.getDate()); if (full) { full.on = first.getDate(); close = full; } }
  return { id: th.getId(), from: bidAddr_(from), gc: bidGc_(from, body), project: bidProject_(subject, body) || bidClean_(subject),
    where: bidWhere_(body), subject: bidClean_(subject), close: close, sent: sent, strong: strong, platform: platform,
    withdrawn: withdrawn, on: first.getDate(), last: th.getLastMessageDate() };
}
function bidMatch_(rows, info) {
  var dom = (info.from.split('@')[1] || ''), words = bidWords_(info.project);
  if (!words.length) return null;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].v, vd = (String(v[BC_.from] || '').split('@')[1] || '');
    if (!vd || vd !== dom) continue;
    var w2 = bidWords_(v[BC_.proj]); if (!w2.length) continue;
    var shared = words.filter(function (w) { return w2.indexOf(w) >= 0; }).length;
    if (shared >= 2 && shared >= Math.ceil(Math.min(words.length, w2.length) * 0.6)) return rows[i];
  }
  return null;
}
function bidWhen_(d, timed) {
  var tz = bidTz_();
  return Utilities.formatDate(d, tz, 'EEE MMM d') + (timed ? ', ' + Utilities.formatDate(d, tz, 'h:mm a') : '');
}

/* The sweep. Gmail is read outside the lock; the tab is written inside it. Returns a one-line summary. */
function bidsSweep_(now) {
  now = now || new Date();
  var DAY = 86400000, props = PropertiesService.getScriptProperties();
  var skip = {};
  try { skip = JSON.parse(props.getProperty(BID_.SKIP_PROP) || '{}') || {}; } catch (e) { skip = {}; }
  var known = {};
  bidRows_(bidSheet_()).forEach(function (x) {
    var last = fuDate_(x.v[BC_.last]);
    String(x.v[BC_.th] || '').split(/[\s,]+/).filter(Boolean).forEach(function (t) { known[t] = last ? last.getTime() : 0; });
  });
  var threads = GmailApp.search('newer_than:' + BID_.LOOKBACK_DAYS + 'd ' + BID_.QUERY, 0, 60);
  var infos = [];
  threads.forEach(function (th) {
    var id = th.getId(), lastMs = th.getLastMessageDate().getTime();
    if (known[id] != null && known[id] >= lastMs) return;                 // nothing new on a bid we have
    if (known[id] == null && skip[id] && skip[id] >= lastMs) return;      // already looked: not a bid
    var info = null;
    try { info = bidReadThread_(th, now); } catch (e) { return; }
    if (!info) { skip[id] = lastMs; return; }
    infos.push(info);
  });
  infos.sort(function (a, b) { return (a.close && a.close.on ? a.close.on.getTime() : 0) - (b.close && b.close.on ? b.close.on.getTime() : 0); });
  var out = { added: [], moved: [], sent: [], noted: [] };
  withLock_(function () {
    var sh = bidSheet_(), rows = bidRows_(sh), byThread = {};
    rows.forEach(function (x) { String(x.v[BC_.th] || '').split(/[\s,]+/).filter(Boolean).forEach(function (t) { byThread[t] = x; }); });
    infos.forEach(function (info) {
      var have = byThread[info.id] || bidMatch_(rows, info);
      var stamp = new Date().toISOString();
      /* v102 - a GC's "we will not be submitting a bid" is never a new bid. On the invitation from
       * that same GC it marks the bid not bidding (if nobody had decided yet) and says why. */
      if (info.withdrawn) {
        if (!have || lc_(have.v[BC_.gc]) !== lc_(info.gc)) { skip[info.id] = info.last.getTime(); return; }
        var w = have.v, why = info.gc + ' is not submitting a bid (email of ' + bidWhen_(info.on || now, false) + ')';
        if (String(w[BC_.th] || '').split(/[\s,]+/).indexOf(info.id) < 0) w[BC_.th] = (String(w[BC_.th] || '') + ',' + info.id).replace(/^,/, '');
        byThread[info.id] = have;
        if (String(w[BC_.note] || '').indexOf(why) < 0) w[BC_.note] = why + (w[BC_.note] ? ' · ' + w[BC_.note] : '');
        if (lc_(w[BC_.st]) === 'new' || !w[BC_.st]) w[BC_.st] = 'passed';
        w[BC_.last] = info.last.toISOString(); w[BC_.upd] = stamp; w[BC_.updBy] = 'inbox';
        sh.getRange(have.row, 1, 1, BID_HEADERS_.length).setValues([w]);
        out.noted.push(w[BC_.proj]);
        return;
      }
      if (!have) {
        if (!info.close && !info.strong) { skip[info.id] = info.last.getTime(); return; }
        if (info.close && info.close.at.getTime() < now.getTime() - BID_.SKIP_PAST_DAYS * DAY) { skip[info.id] = info.last.getTime(); return; }
        var v = new Array(BID_HEADERS_.length).fill('');
        v[BC_.id] = 'b' + info.id; v[BC_.added] = stamp; v[BC_.src] = 'email'; v[BC_.gc] = txt_(info.gc);
        v[BC_.proj] = txt_(info.project); v[BC_.where] = txt_(info.where);
        v[BC_.closes] = info.close ? info.close.at.toISOString() : ''; v[BC_.timed] = !!(info.close && info.close.timed);
        v[BC_.st] = info.sent ? 'sent' : 'new'; v[BC_.th] = info.id; v[BC_.from] = info.from; v[BC_.subj] = txt_(info.subject);
        v[BC_.said] = info.close ? txt_(info.close.said) : ''; v[BC_.by] = info.close ? 'email' : '';
        v[BC_.saidAt] = info.close && info.close.on ? info.close.on.toISOString() : '';
        v[BC_.note] = info.close ? '' : 'No closing date found in the email - add it';
        if (info.sent) v[BC_.note] = 'Our bid went out ' + bidWhen_(info.sent, false);
        v[BC_.upd] = stamp; v[BC_.updBy] = 'inbox'; v[BC_.last] = info.last.toISOString();
        sh.appendRow(v);
        var x = { row: sh.getLastRow(), v: v }; rows.push(x); byThread[info.id] = x;
        out.added.push(info.project);
        return;
      }
      var r = have.v, changed = false;
      if (String(r[BC_.th] || '').split(/[\s,]+/).indexOf(info.id) < 0) { r[BC_.th] = (String(r[BC_.th] || '') + ',' + info.id).replace(/^,/, ''); byThread[info.id] = have; changed = true; }
      var prevOn = fuDate_(r[BC_.saidAt]);
      if (info.close && !(prevOn && info.close.on && info.close.on.getTime() <= prevOn.getTime())) {   // an older email never moves it back
        var cur = fuDate_(r[BC_.closes]), newAt = info.close.at;
        var differs = !cur || Math.abs(cur.getTime() - newAt.getTime()) > 60000 || (info.close.timed && !(r[BC_.timed] === true || lc_(r[BC_.timed]) === 'true'));
        if (differs && lc_(r[BC_.by]) === 'hand') {
          var said = 'The email of ' + bidWhen_(info.close.on || now, false) + ' says ' + bidWhen_(newAt, info.close.timed);
          if (String(r[BC_.note] || '').indexOf(said) < 0) { r[BC_.note] = said; changed = true; out.noted.push(r[BC_.proj]); }
        } else if (differs) {
          if (cur) { r[BC_.note] = 'Moved from ' + bidWhen_(cur, r[BC_.timed] === true || lc_(r[BC_.timed]) === 'true') + ' (email of ' + bidWhen_(info.close.on || now, false) + ')'; out.moved.push(r[BC_.proj]); }
          else if (/^No closing date found/.test(String(r[BC_.note] || ''))) r[BC_.note] = '';
          r[BC_.closes] = newAt.toISOString(); r[BC_.timed] = !!info.close.timed; r[BC_.said] = txt_(info.close.said); r[BC_.by] = 'email';
          changed = true;
        }
        if (info.close.on && String(r[BC_.saidAt]) !== info.close.on.toISOString()) { r[BC_.saidAt] = info.close.on.toISOString(); changed = true; }
      }
      if (info.sent && (lc_(r[BC_.st]) === 'new' || lc_(r[BC_.st]) === 'bidding' || !r[BC_.st])) {
        r[BC_.st] = 'sent'; r[BC_.note] = 'Our bid went out ' + bidWhen_(info.sent, false) + (r[BC_.note] ? ' · ' + r[BC_.note] : '');
        changed = true; out.sent.push(r[BC_.proj]);
      }
      var lastIso = info.last.toISOString();
      if (String(r[BC_.last]) !== lastIso) { r[BC_.last] = lastIso; changed = true; }
      if (changed) {
        r[BC_.upd] = new Date().toISOString(); r[BC_.updBy] = 'inbox';
        sh.getRange(have.row, 1, 1, BID_HEADERS_.length).setValues([r]);
      }
    });
  });
  // the not-a-bid memory: keep it small
  Object.keys(skip).forEach(function (k) { if (now.getTime() - skip[k] > (BID_.LOOKBACK_DAYS + 5) * DAY) delete skip[k]; });
  var keys = Object.keys(skip).sort(function (a, b) { return skip[a] - skip[b]; });
  while (keys.length && JSON.stringify(skip).length > 8000) delete skip[keys.shift()];
  props.setProperty(BID_.SKIP_PROP, JSON.stringify(skip));
  props.setProperty(BID_.LAST_PROP, now.toISOString());
  bidsCacheDrop_();
  var msg = 'Bids: ' + infos.length + ' thread(s) read' + (out.added.length ? ', added ' + out.added.join('; ') : '') +
    (out.moved.length ? ', closing moved on ' + out.moved.join('; ') : '') + (out.sent.length ? ', marked sent ' + out.sent.join('; ') : '') +
    (out.noted.length ? ', email disagrees with the date typed on ' + out.noted.join('; ') : '');
  if (out.added.length || out.moved.length || out.sent.length || out.noted.length) log_({ email: 'system' }, 'bidsSweep', '', '', msg);
  return msg;
}

/* action: bidSave  payload: { id, project, gc, where, closes (ISO or ''), timed, status, note }
 * Adds a bid by hand (the app makes the id, 'h...', so a replayed tap updates the same row) or changes
 * one. Only the fields sent are changed. A closing date set here is Paul's and the inbox leaves it. */
function bidSave_(user, p) {
  requirePerm_(user, 'approveHours');
  p = p || {};
  var id = String(p.id || '').trim();
  if (!/^[bh][\w-]{4,60}$/.test(id)) throw new Error('That bid has no id.');
  if (p.status != null && BID_.STATUSES.indexOf(String(p.status)) < 0) throw new Error('Unknown status: ' + p.status);
  var closes = null;
  if (p.closes != null && p.closes !== '') { closes = new Date(p.closes); if (isNaN(closes)) throw new Error('That closing date could not be read.'); }
  var sh = bidSheet_(), rows = bidRows_(sh), have = null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i].v[BC_.id]) === id) { have = rows[i]; break; }
  var stamp = new Date().toISOString(), r;
  if (!have) {
    if (!/^h/.test(id)) throw new Error('That bid is not on the Bids tab any more.');
    if (!String(p.project || '').trim()) throw new Error('Put in the project name.');
    r = new Array(BID_HEADERS_.length).fill('');
    r[BC_.id] = id; r[BC_.added] = stamp; r[BC_.src] = 'hand'; r[BC_.st] = 'new';
  } else r = have.v.slice();
  if (p.project != null) r[BC_.proj] = txt_(String(p.project).trim().slice(0, 200));
  if (p.gc != null) r[BC_.gc] = txt_(String(p.gc).trim().slice(0, 120));
  if (p.where != null) r[BC_.where] = txt_(String(p.where).trim().slice(0, 120));
  if (p.note != null) r[BC_.note] = txt_(String(p.note).trim().slice(0, 500));
  if (p.status != null) r[BC_.st] = String(p.status);
  if (p.closes != null) {
    var was = fuDate_(r[BC_.closes]), wasT = r[BC_.timed] === true || lc_(r[BC_.timed]) === 'true', nowT = !!p.timed;
    var same = (!closes && !was) || (closes && was && Math.abs(closes - was) < 60000 && wasT === nowT);
    if (!same) {
      r[BC_.closes] = closes ? closes.toISOString() : ''; r[BC_.timed] = closes ? nowT : false; r[BC_.by] = 'hand';
      if (/^(Moved from|The email of|No closing date found)/.test(String(r[BC_.note] || '')) && p.note == null) r[BC_.note] = '';
    }
  }
  r[BC_.upd] = stamp; r[BC_.updBy] = user.email;
  if (have) sh.getRange(have.row, 1, 1, BID_HEADERS_.length).setValues([r]);
  else sh.appendRow(r);
  bidsCacheDrop_();
  log_(user, 'bidSave', String(r[BC_.proj] || ''), id, (have ? 'changed' : 'added by hand') +
    (p.status != null ? ' · ' + p.status : '') + (p.closes != null ? ' · closes ' + (closes ? bidWhen_(closes, !!p.timed) : 'not set') : ''));
  return { ok: true, bid: bidObj_(r) };
}
/* Today's bids, never allowed to stop the screen loading. */
function todayBids_() { try { return bidsForToday_(new Date()); } catch (e) { return { list: [], checked: '', error: String(e && e.message || e) }; } }

// ================================ ESTIMATES (v89) ================================================
/* Paul, 7 Nov 2026: "stop putting appointment in front of the jobs. i need to know when i look at
 * the calendar who is on the calendar. we're going to stop categorizing appointments and estimates.
 * we should have an estimate tab for any requests for the estimates that comes through we can send
 * it that way. even from the email."
 *
 * So:
 *  - A calendar booking is titled by WHO it is: "Karen Eastman · R26201 — Replace the panel". No
 *    APPOINTMENT / ESTIMATE / RETURN in front. A visit to look at a job before it is priced carries
 *    no job number (Paul's call: the number comes with the customer's yes), so it reads
 *    "Karen Eastman — Replace the panel". retitleCalendar_ renames what is already booked.
 *  - Someone asking for an estimate - from the website form, or by email (the inbox sweep files
 *    those through requestAdd with type ESTIMATE) - lands on the app's ESTIMATES tab instead of
 *    Requests. From there Paul sends the price: a branded email with the job, the price he set
 *    (the ball park is the starting point) and two buttons, "Yes, book it" / "No thanks".
 *  - A yes turns it into a job waiting to be booked on Requests, and Paul gets an email. A no
 *    files it as declined. Paul can also mark either by hand when the customer phones.
 * The Type column stays on the Requests tab because it is what decides whether booking mints a job
 * number; it is no longer shown or chosen anywhere. */

SHEETS.QUOTES = 'Estimates Sent';
var QUOTE_HEADERS_ = ['Request ID', 'Sent at', 'Sent by', 'To', 'Low', 'High', 'Message', 'Token', 'Answer', 'Answered at'];

/* "Karen Eastman · R26201 — Replace the panel": who, the job number when it has one, what. */
function reqEvTitle_(v, po) {
  var name = String(v[4] || '').trim() || 'Customer';
  var num = String(po == null ? (v[23] || '') : po).trim();
  var scope = String(v[8] || '').trim();
  return name + (num ? ' · ' + num : '') + (scope ? ' — ' + scope : '');
}

function quoteSheet_() {
  var sh = masterSheet_(SHEETS.QUOTES);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, QUOTE_HEADERS_.length).setValues([QUOTE_HEADERS_]).setFontWeight('bold');
  return sh;
}
/* The latest estimate sent for each request: { requestId: { row, sentAt, by, to, low, high, message, answer, answeredAt } } */
function quoteMap_() {
  var sh = quoteSheet_(), last = sh.getLastRow(), out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, QUOTE_HEADERS_.length).getValues().forEach(function (r, i) {
    var id = String(r[0] || ''); if (!id) return;
    out[id] = { row: i + 2, sentAt: String(r[1] || ''), by: String(r[2] || ''), to: String(r[3] || ''),
      low: Number(r[4]) || 0, high: Number(r[5]) || 0, message: String(r[6] || ''),
      answer: String(r[8] || ''), answeredAt: String(r[9] || '') };
  });
  return out;
}
function quoteMoney_(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-CA'); }
function quotePriceText_(low, high) {
  low = Number(low) || 0; high = Number(high) || 0;
  if (low && high && Math.round(low) !== Math.round(high)) return quoteMoney_(low) + ' – ' + quoteMoney_(high);
  return quoteMoney_(high || low);
}

/* Everything for the Estimates tab. */
function estimateList_(user, p) {
  requirePerm_(user, 'approveHours');
  var sh = reqSheet_(), last = sh.getLastRow();
  var out = { leads: [], visits: [], sent: [], declined: [] };
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, REQ_HEADERS.length).getValues();
  var q = quoteMap_(), now = Date.now(), cutoff = now - 120 * 86400000, recent = now - 30 * 86400000;
  vals.forEach(function (r) {
    var type = String(r[3] || '').toUpperCase(), st = String(r[14] || '');
    var rec = function () {
      var o = { id: r[0], received: r[1], entryNo: r[2], customer: r[4], phone: r[5], email: r[6], address: r[7],
        scope: r[8], hours: Number(r[9]) || 0, priceLow: Number(r[11]) || 0, priceHigh: Number(r[12]) || 0,
        start: r[15], end: r[16], detail: r[21], company: r[22] || '', po: r[23] || '', eventId: String(r[18] || ''),
        status: st, crew: Math.max(1, Number(r[29]) || 1) };
      var s = q[String(r[0])]; if (s) o.quote = s;
      return poFill_(o);
    };
    if (type === 'ESTIMATE' && st === 'pending' && !String(r[30] || '').trim()) out.leads.push(rec());
    else if (type === 'ESTIMATE' && st === 'scheduled' && !String(r[23] || '').trim() &&
             (!r[15] || new Date(r[15]).getTime() > cutoff)) out.visits.push(rec());
    else if (st === 'quoted') out.sent.push(rec());
    else if (st === 'quote declined') { var o = rec(); if (!o.quote || new Date(o.quote.answeredAt || o.quote.sentAt).getTime() > recent) out.declined.push(o); }
  });
  out.leads.sort(function (a, b) { return String(b.received).localeCompare(String(a.received)); });
  out.visits.sort(function (a, b) { return String(b.start).localeCompare(String(a.start)); });
  out.sent.sort(function (a, b) { return String((b.quote || {}).sentAt).localeCompare(String((a.quote || {}).sentAt)); });
  return out;
}

/* Send the price. payload: { id, low, high, message, preview } - preview returns the email without
 * sending it, so the screen shows exactly what the customer will get. */
function estimateSend_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values, st = String(v[14] || '');
  if (st === 'cancelled' || st === 'dismissed') throw new Error('That request was closed.');
  if (String(v[23] || '').trim()) throw new Error('That one is already a job (' + v[23] + ') - it does not need an estimate.');
  var to = String(p.email || v[6] || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('There is no email address for ' + (v[4] || 'this customer') + ' - add one with Change the details first.');
  var low = Math.max(0, Number(p.low) || 0), high = Math.max(0, Number(p.high) || 0);
  if (!low && !high) throw new Error('Put in the price.');
  if (low && high && high < low) { var t = low; low = high; high = t; }
  var base = appWebUrl_();
  if (!base) throw new Error('The app address is not available, so the Yes button could not be made.');
  var token = p.preview ? 'PREVIEW' : confirmToken_();
  var yes = base + '?quote=' + token + '&a=yes', no = base + '?quote=' + token + '&a=no';
  var first = String(v[4] || '').trim().split(' ')[0];
  var price = quotePriceText_(low, high);
  var intro = String(p.message || '').trim() || 'Thanks for asking us to look at this. Here is our estimate:';
  var lines = [String(v[8] || ''), String(v[7] || ''),
    (low && high && Math.round(low) !== Math.round(high)) ? 'The final price depends on what we find on site.' : ''];
  var subject = 'Your estimate from PRO Electrical' + (v[8] ? ' — ' + String(v[8]).slice(0, 60) : '');
  var htmlBody = custEmailHtml_({
    heading: first ? ('Hi ' + first + ',') : 'Hello,',
    intro: intro, when: price, lines: lines,
    buttonsIntro: 'Would you like us to go ahead? Just tap one:',
    buttons: [{ label: 'Yes, book it', url: yes, kind: 'yes' }, { label: 'No thanks', url: no, kind: 'plain' }],
    footNote: 'Tap Yes and we will be in touch to pick a day. Questions? Just reply to this email or call 780-625-5880.'
  });
  if (p.preview) return { preview: true, to: to, subject: subject, html: htmlBody, price: price };
  var body = 'Hi ' + first + ',\n\n' + intro + '\n\n  ' + price + '\n' +
    lines.filter(String).map(function (x) { return '  ' + x + '\n'; }).join('') +
    '\nWould you like us to go ahead?\n\nYES, book it:\n  ' + yes + '\n\nNo thanks:\n  ' + no + '\n\n' +
    'Questions? Just reply to this email or call 780-625-5880.\n\n' +
    '— PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca  ·  780-625-5880';
  MailApp.sendEmail({ to: to, subject: subject, body: body, htmlBody: htmlBody,
    name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0] });
  quoteSheet_().appendRow([String(v[0]), new Date().toISOString(), user.email, txt_(to), low, high,
    txt_(String(p.message || '')), token, '', '']);
  loc.sheet.getRange(loc.row, 12, 1, 2).setValues([[low, high]]);
  loc.sheet.getRange(loc.row, 15).setValue('quoted');
  if (!String(v[6] || '').trim()) loc.sheet.getRange(loc.row, 7).setValue(txt_(to));
  reqMapsDrop_();
  log_(user, 'estimateSend', v[4] || '', '', price + ' to ' + to);
  return { sent: true, to: to, price: price };
}

/* A yes or a no - from the customer's button, or marked by hand when they phone.
 * yes: it becomes a job waiting to be booked on Requests (the number is minted when it is booked).
 * no:  filed as declined. Paul hears about a button answer by email. */
function quoteDecide_(v, row, sh, answer, how) {
  var yes = answer === 'yes';
  if (yes) {
    sh.getRange(row, 4).setValue('APPOINTMENT');
    sh.getRange(row, 15).setValue('pending');
    sh.getRange(row, 16, 1, 6).setValues([['', '', '', '', '', '']]);   // no time, no event: book it fresh
    var note = 'Said yes to the estimate ' + quotePriceText_(v[11], v[12]) + ' (' + how + ', ' + fmtDate_(new Date()) + ').';
    sh.getRange(row, 22).setValue(txt_(String(v[21] || '') ? (String(v[21]) + '  -  ' + note) : note));
  } else {
    sh.getRange(row, 15).setValue('quote declined');
  }
  reqMapsDrop_();
}
function quoteAnswer_(token, answer) {
  answer = answer === 'yes' ? 'yes' : 'no';
  if (!token || token === 'PREVIEW') return confirmPage_('That link is no longer valid. Give us a call at PRO Electrical and we\'ll sort it out.', false);
  var qs = quoteSheet_(), last = qs.getLastRow();
  if (last < 2) return confirmPage_('That link is no longer valid.', false);
  var rows = qs.getRange(2, 1, last - 1, QUOTE_HEADERS_.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][7]) !== String(token)) continue;
    if (rows[i][8]) return confirmPage_(rows[i][8] === 'yes' ? 'Thanks - we already have your yes and will be in touch to book a day.'
                                                             : 'Thanks - we already have your answer.', true);
    qs.getRange(i + 2, 9, 1, 2).setValues([[answer, new Date().toISOString()]]);
    var loc = reqRow_(String(rows[i][0]));
    if (loc && String(loc.values[14]) === 'quoted') {
      var v = loc.values;
      quoteDecide_(v, loc.row, loc.sheet, answer, 'tapped in the email');
      try {
        MailApp.sendEmail({ to: CONFIG.ADMIN_EMAILS.join(','),
          subject: (answer === 'yes' ? '✅ YES to the estimate: ' : 'No to the estimate: ') + (v[4] || 'customer') + ' — ' + quotePriceText_(v[11], v[12]),
          body: (v[4] || 'The customer') + (answer === 'yes'
            ? ' said YES to the estimate. It is on the Requests tab, waiting for a day - book it there and it gets its job number.\n\n'
            : ' said no thanks to the estimate. It is filed as declined on the Estimates tab.\n\n') +
            (v[8] ? '  ' + v[8] + '\n' : '') + (v[7] ? '  ' + v[7] + '\n' : '') + (v[5] ? '  ' + v[5] + '\n' : '') +
            (v[6] ? '  ' + v[6] + '\n' : '') });
      } catch (e) {}
      log_({ email: 'customer' }, 'estimateAnswer', v[4] || '', '', answer);
    }
    return answer === 'yes'
      ? confirmPage_('Thank you! We\'ll be in touch shortly to pick a day for the work.', true)
      : confirmPage_('Thanks for letting us know. If anything changes, we\'re only a call away.', true);
  }
  return confirmPage_('That link is no longer valid. Give us a call at PRO Electrical and we\'ll sort it out.', false);
}
/* payload: { id, answer: 'yes'|'no' } - the customer phoned instead of tapping. */
function estimateMark_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var st = String(loc.values[14] || ''), isEst = String(loc.values[3] || '').toUpperCase() === 'ESTIMATE';
  // waiting on an emailed price, a request not answered yet, or a visit to look that has happened
  var waiting = st === 'quoted' || st === 'quote declined' || (isEst && (st === 'pending' || st === 'scheduled'));
  if (!waiting || String(loc.values[23] || '').trim()) throw new Error('That one is not waiting on an answer.');
  var answer = p.answer === 'yes' ? 'yes' : 'no';
  quoteDecide_(loc.values, loc.row, loc.sheet, answer, 'marked by ' + user.email.split('@')[0]);
  var q = quoteMap_()[String(loc.values[0])];
  if (q && !q.answer) quoteSheet_().getRange(q.row, 9, 1, 2).setValues([[answer, new Date().toISOString()]]);
  log_(user, 'estimateMark', loc.values[4] || '', '', answer);
  return { ok: true, answer: answer };
}

/* Rename what is already on the calendar: from now on, and only bookings the app made (a title that
 * starts APPOINTMENT / ESTIMATE / RETURN). payload: { dryRun } lists them without changing anything. */
function retitleCalendar_(user, p) {
  requireAdmin_(user);
  var cal = visitCal_(), from = new Date(), to = new Date(Date.now() + 190 * 86400000);
  from.setHours(0, 0, 0, 0);
  var rows = {};
  var sh = reqSheet_(), last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, REQ_HEADERS.length).getValues().forEach(function (r) { if (r[18]) rows[String(r[18])] = r; });
  var done = [];
  cal.getEvents(from, to).forEach(function (ev) {
    var t = String(ev.getTitle() || ''), m = /^\s*(APPOINTMENT|ESTIMATE|RETURN)\s*[—-]\s*/i.exec(t);
    if (!m) return;
    var r = rows[String(ev.getId())], nt;
    if (r) nt = reqEvTitle_(r);
    else {
      var rest = t.slice(m[0].length), cont = /\(cont'd\)/i.test(rest);
      rest = rest.replace(/\s*\(cont'd\)\s*/ig, ' ').trim();
      var pm = /\b([RCIM]\d{5})\b/.exec(rest), po = pm ? pm[1] : '';
      var bits = rest.replace(/\b[RCIM]\d{5}\b/, '').replace(/^\s*\d{1,4}\s+/, '').trim().split(' — ');
      nt = (bits[0] || 'Customer').trim() + (po ? ' · ' + po : '') + (bits.slice(1).join(' — ') ? ' — ' + bits.slice(1).join(' — ') : '') +
           (/^RETURN$/i.test(m[1]) || cont ? ' (return visit)' : '');
    }
    if (nt && nt !== t) { done.push({ was: t, now: nt, when: ev.getStartTime().toISOString() }); if (!p || !p.dryRun) ev.setTitle(nt); }
  });
  log_(user, 'retitleCalendar', '', '', (p && p.dryRun ? 'dry run: ' : '') + done.length + ' bookings');
  return { changed: done.length, list: done, dryRun: !!(p && p.dryRun) };
}

// ---------------------------------- Job photo browser ------------------------------------------

// p: { jobSite } → all photos/videos in that job's Drive folder, newest first (admin +
// bookkeeper — same audience as the Jobs tab). The files live in the script owner's
// Drive; the first time another admin/bookkeeper opens a job's photos, they're granted
// view access on the FOLDER (self-healing share) so thumbnails render for them too.
function jobMedia_(user, p) {
  if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
    throw new Error('Not allowed.');
  var name = String(p.jobSite || '').trim();
  if (!name) throw new Error('No job given.');
  var master = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
  var safe = name.replace(/[\\\/:*?"<>|]/g, '-').trim() || 'Unassigned';
  var it = master.getFoldersByName(safe);
  if (!it.hasNext()) return { files: [], folderUrl: '' };
  var folder = it.next();
  try { folder.addViewer(user.email); } catch (e) {} // idempotent; no-op for the owner
  var files = [], fit = folder.getFiles(), n = 0;
  while (fit.hasNext() && n < 200) {
    var f = fit.next();
    files.push({ id: f.getId(), name: f.getName(), url: f.getUrl(),
      date: f.getDateCreated().toISOString(),
      by: String(f.getDescription() || '').replace(/^By\s+/, '').split(' — ')[0],
      isVideo: /^video\//.test(f.getMimeType() || '') });
    n++;
  }
  files.sort(function(a, b){ return a.date < b.date ? 1 : -1; }); // newest first
  return { files: files, folderUrl: folder.getUrl() };
}

// ---------------------------------- JHA (Job Hazard Assessment) -------------------------------
/* Digital tailgate JHA for the jobs that need the paper trail. One JHA per job per day; anyone
 * on site starts it, everyone signs before work (finger-drawn signature). Every signature
 * regenerates the filed PDF in the job's Drive folder (JHA subfolder), so the filed copy always
 * shows the full crew — that PDF is the evidence you hand an OHS officer or investigator. */

function jhaSheet_() {
  var sh = masterSheet_(SHEETS.JHA);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,9).setValues([[
    'JhaID','Date','Job Site','PO#','Created By','Data (JSON)','Signatures (JSON)','PDF URL','Created At'
  ]]).setFontWeight('bold');
  return sh;
}
function jhaDateStr_(v) { return (v instanceof Date) ? fmtDate_(v) : String(v || ''); }

function jhaList_(user, p) {
  var sh = jhaSheet_(), last = sh.getLastRow();
  if (last < 2) return { jhas: [] };
  var n = Math.min(last - 1, 120); // the most recent 120 forms is plenty of history for the app
  var rows = sh.getRange(last - n + 1, 1, n, 9).getValues();
  var out = [];
  for (var i = rows.length - 1; i >= 0; i--) { // newest first
    var r = rows[i], sigs = [], data = {};
    try { sigs = JSON.parse(r[6] || '[]'); } catch (e) {}
    try { data = JSON.parse(r[5] || '{}'); } catch (e) {}
    out.push({
      id: r[0], date: jhaDateStr_(r[1]), jobSite: r[2], po: r[3], createdBy: r[4], data: data,
      sigs: sigs.map(function(s){ return { name: s.name, email: s.email, at: s.at }; }),
      signedByMe: sigs.some(function(s){ return lc_(s.email) === lc_(user.email); }),
      pdfUrl: r[7]
    });
  }
  return { jhas: out };
}

function jhaCreate_(user, p) {
  // p: { jobSite, poNumber, hazards:[{hazard,controls}], custom:[{hazard,controls}], notes, sigDataUrl }
  var jobSite = String(p.jobSite || '').trim();
  if (!jobSite) throw new Error('Pick the job this JHA is for.');
  var hazards = (p.hazards || []).slice(0, 40);
  var custom  = (p.custom || []).filter(function(c){ return String(c.hazard || '').trim(); }).slice(0, 20);
  if (!hazards.length && !custom.length) throw new Error('Check at least one hazard (or add your own).');
  if (!p.sigDataUrl) throw new Error('Sign the form to file it — yours is the first signature on it.');
  var today = fmtDate_(new Date());
  // One JHA per job per day: split forms split the signatures, which weakens the paper trail.
  var sh = jhaSheet_(), last = sh.getLastRow();
  if (last > 1) {
    var check = sh.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < check.length; i++) {
      if (jhaDateStr_(check[i][1]) === today && lc_(check[i][2]) === lc_(jobSite))
        throw new Error('A JHA for ' + jobSite + ' already exists today — open it from the list and sign that one instead.');
    }
  }
  var id = 'jha_' + newId_();
  var clip = function(s, n){ return String(s || '').substring(0, n); };
  var data = {
    hazards: hazards.map(function(h){ return { hazard: clip(h.hazard, 200), controls: clip(h.controls, 500) }; }),
    custom:  custom.map(function(c){ return { hazard: clip(c.hazard, 200), controls: clip(c.controls, 500) }; }),
    notes:   clip(p.notes, 2000)
  };
  if (JSON.stringify(data).length > 45000) throw new Error('This JHA is too long — trim the custom hazards or notes.');
  var sigs = [jhaSaveSig_(jobSite, id, user, p.sigDataUrl)];
  sh.appendRow([id, today, txt_(jobSite), txt_(String(p.poNumber || '')), user.email,
    JSON.stringify(data), JSON.stringify(sigs), '', new Date().toISOString()]);
  var pdfUrl = jhaPdf_(id); // build + file the PDF now so the evidence exists even if nobody else signs
  log_(user, 'jhaCreate', jobSite, id, (hazards.length + custom.length) + ' hazards');
  return { id: id, pdfUrl: pdfUrl };
}

function jhaSign_(user, p) {
  if (!p.jhaId) throw new Error('No JHA given.');
  if (!p.sigDataUrl) throw new Error('Draw your signature first.');
  var loc = jhaRow_(p.jhaId);
  if (!loc) throw new Error('JHA not found — refresh the list.');
  var sigs = [];
  try { sigs = JSON.parse(loc.values[6] || '[]'); } catch (e) {}
  if (sigs.some(function(s){ return lc_(s.email) === lc_(user.email); }))
    throw new Error('You have already signed this JHA.');
  sigs.push(jhaSaveSig_(loc.values[2], p.jhaId, user, p.sigDataUrl));
  loc.sheet.getRange(loc.row, 7).setValue(JSON.stringify(sigs));
  var pdfUrl = jhaPdf_(p.jhaId); // refile so the PDF always shows the full crew
  log_(user, 'jhaSign', String(loc.values[2]), p.jhaId, '');
  return { ok: true, pdfUrl: pdfUrl, sigCount: sigs.length };
}

function jhaRow_(id) {
  var sh = jhaSheet_(), last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, 9).getValues();
  for (var i = 0; i < vals.length; i++) if (vals[i][0] === id) return { sheet: sh, row: i + 2, values: vals[i] };
  return null;
}

function jhaFolder_(jobSite) {
  var job = ensureJobFolder_(jobSite || 'Unassigned');
  var it = job.getFoldersByName('JHA');
  return it.hasNext() ? it.next() : job.createFolder('JHA');
}

function jhaSaveSig_(jobSite, jhaId, user, dataUrl) {
  var m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Signature image not readable — try signing again.');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 200 * 1024) throw new Error('Signature image too large — clear and sign again.');
  var name = null;
  try { var rec = getEmployeeRecordCached_(user.email); name = rec && rec.name; } catch (e) {}
  var f = jhaFolder_(String(jobSite)).createFile(Utilities.newBlob(bytes, 'image/' + m[1],
    jhaId + '-sig-' + user.email.split('@')[0] + (m[1] === 'png' ? '.png' : '.jpg')));
  f.setDescription('JHA signature — ' + user.email);
  return { name: name || user.email.split('@')[0], email: lc_(user.email), at: new Date().toISOString(), fileId: f.getId() };
}

function jhaPdf_(id) {
  var loc = jhaRow_(id);
  if (!loc) return '';
  var r = loc.values, data = {}, sigs = [];
  try { data = JSON.parse(r[5] || '{}'); } catch (e) {}
  try { sigs = JSON.parse(r[6] || '[]'); } catch (e) {}
  var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); };
  var hazRows = (data.hazards || []).concat(data.custom || []).map(function(h){
    return '<tr><td>' + esc(h.hazard) + '</td><td>' + esc(h.controls) + '</td></tr>';
  }).join('');
  var sigCells = sigs.map(function(s){
    var img = '<i style="color:#999">(signature image unavailable)</i>';
    try {
      var b = DriveApp.getFileById(s.fileId).getBlob();
      img = '<img src="data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) + '" style="height:50px">';
    } catch (e) {}
    return '<td style="width:33%;vertical-align:bottom">' + img +
      '<div style="border-top:1px solid #333;margin-top:4px;padding-top:3px;font-size:10px"><b>' + esc(s.name) + '</b><br>' +
      esc(s.email) + '<br>' + esc(new Date(s.at).toLocaleString()) + '</div></td>';
  });
  var sigRows = '';
  for (var i = 0; i < sigCells.length; i += 3) sigRows += '<tr>' + sigCells.slice(i, i + 3).join('') + '</tr>';
  var dateStr = jhaDateStr_(r[1]);
  var html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}' +
    'th{background:#eee}h1{font-size:18px;margin:0}h2{font-size:13px;margin:16px 0 6px}' +
    '</style></head><body>' +
    '<h1>Job Hazard Assessment</h1>' +
    '<p style="margin:4px 0 14px;color:#444">PRO Electrical Services — daily tailgate hazard assessment</p>' +
    '<table><tr><th style="width:25%">Job / customer</th><td>' + esc(r[2]) + '</td></tr>' +
    (r[3] ? '<tr><th>PO #</th><td>' + esc(r[3]) + '</td></tr>' : '') +
    '<tr><th>Date</th><td>' + esc(dateStr) + '</td></tr>' +
    '<tr><th>Started by</th><td>' + esc(r[4]) + '</td></tr></table>' +
    '<h2>Identified hazards &amp; controls</h2>' +
    '<table><tr><th style="width:45%">Hazard</th><th>Controls in place</th></tr>' + (hazRows || '<tr><td colspan="2">—</td></tr>') + '</table>' +
    (data.notes ? '<h2>Notes (muster point, first aid, permits)</h2><p>' + esc(data.notes).replace(/\n/g, '<br>') + '</p>' : '') +
    '<h2>Crew acknowledgement — I took part in this hazard assessment and understand the hazards and controls before starting work</h2>' +
    '<table>' + (sigRows || '<tr><td>No signatures yet.</td></tr>') + '</table>' +
    '<p style="color:#777;font-size:9px;margin-top:14px">Filed digitally by the PCW/PRO Timesheet app · regenerated ' + esc(new Date().toLocaleString()) + '</p>' +
    '</body></html>';
  var pdf = Utilities.newBlob(html, 'text/html', 'jha.html').getAs('application/pdf')
    .setName('JHA ' + dateStr + ' — ' + String(r[2]).replace(/[\\\/:*?"<>|]/g, '-') + '.pdf');
  var folder = jhaFolder_(r[2]);
  // Replace the previous copy so the job folder holds ONE current PDF per JHA, never stale duplicates.
  var oldId = (String(loc.sheet.getRange(loc.row, 8).getValue() || '').match(/[-\w]{25,}/) || [])[0];
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  var file = folder.createFile(pdf);
  sigs.forEach(function(s){ try { file.addViewer(s.email); } catch (e) {} }); // signers can open their own filed form
  var url = file.getUrl();
  loc.sheet.getRange(loc.row, 8).setValue(url);
  return url;
}

// ---------------------------------- Schedule (job calendar) ------------------------------------
/* The schedule IS the admin's Google Calendar (admin@proes.ca — the one the AI books into).
 * The script runs as that account, so CalendarApp reads it directly; no extra auth. The app
 * adds the missing layer: per-event crew assignment, stored in the Schedule sheet keyed by
 * calendar event ID, so calendar edits (AI or human) never touch assignments and vice versa.
 * Crew see only events they're assigned to (with who else is coming); admins see everything
 * and assign by tapping. Newly-assigned employees get a short email. */

function schedSheet_() {
  var sh = masterSheet_(SHEETS.SCHED);
  if (sh.getLastRow() === 0)
    sh.getRange(1,1,1,4).setValues([['EventID','Assigned JSON','Assigned By','Updated At']]).setFontWeight('bold');
  return sh;
}
function schedAssignments_() {
  var sh = schedSheet_(), last = sh.getLastRow(), map = {};
  if (last < 2) return map;
  var vals = sh.getRange(2,1,last-1,2).getValues();
  for (var i=0;i<vals.length;i++){
    var emails = []; try { emails = JSON.parse(vals[i][1] || '[]'); } catch(e){}
    map[String(vals[i][0])] = { emails: emails.map(lc_), row: i+2 };
  }
  return map;
}
function employeeNameMap_() {
  var sh = masterSheet_(SHEETS.EMPLOYEES), last = sh.getLastRow(), map = {};
  if (last < 2) return map;
  sh.getRange(2,1,last-1,2).getValues().forEach(function(r){ map[lc_(r[0])] = String(r[1] || r[0]); });
  return map;
}

function scheduleList_(user, p) {
  var start = new Date(); start.setHours(0,0,0,0);
  if (p.startDate && /^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) start = new Date(p.startDate + 'T00:00:00');
  var end = new Date(start.getTime() + 14 * 86400000); // default: 2-week list window
  if (p.endDate && /^\d{4}-\d{2}-\d{2}$/.test(p.endDate)) end = new Date(p.endDate + 'T00:00:00');
  // Sane bounds: max 62-day span, a year back, ~6 months ahead — keeps calendar reads fast.
  var today = new Date(); today.setHours(0,0,0,0);
  var minS = new Date(today.getTime() - 370*86400000), maxE = new Date(today.getTime() + 190*86400000);
  if (start < minS) start = minS;
  if (start > new Date(maxE.getTime() - 86400000)) start = new Date(maxE.getTime() - 86400000);
  if (end > maxE) end = maxE;
  if (end <= start) end = new Date(start.getTime() + 86400000);
  if (end - start > 62*86400000) end = new Date(start.getTime() + 62*86400000);
  // v58 - THIS WAS THE WRONG CALENDAR, and it was the only place in the script that used it.
  // Every booking path creates its events on CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]);
  // this one read getDefaultCalendar(), which is whatever calendar the ACCOUNT RUNNING THE SCRIPT
  // happens to have as its default. When those are not the same calendar, the Schedule tab shows
  // an almost empty fortnight while the jobs sit safely on the other one. visitCal_ is the same
  // lookup the rest of the script uses, and it still falls back to the default if the named
  // calendar cannot be reached.
  var events = visitCal_().getEvents(start, end);
  var asg = schedAssignments_(), names = employeeNameMap_();
  var canAssign = user.role === 'admin';
  var seesAll = canAssign || (user.permissions && user.permissions.viewAllEmployees);
  var out = [];
  events.forEach(function(ev){
    var id = String(ev.getId());
    var emails = (asg[id] && asg[id].emails) || [];
    if (!seesAll && emails.indexOf(lc_(user.email)) === -1) return; // crew: assigned jobs only
    out.push({ id: id, title: ev.getTitle() || '(no title)',
      start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
      allDay: !!ev.isAllDayEvent(), location: ev.getLocation() || '', desc: ev.getDescription() || '',
      assigned: emails.map(function(e){ return { email: e, name: names[e] || e.split('@')[0] }; }),
      confirm: (function(){ try { return schedConfirmFromColour_(ev.getColor()); } catch (e) { return 'none'; } })(),   // v92
      recurring: (function(){ try { return !!ev.isRecurringEvent(); } catch (e) { return false; } })() });            // v94
  });
  // Time off: admins see every pending request + approved leave touching the window (so
  // nobody gets assigned while away); crew see just their own recent requests.
  var timeOff = [];
  var tsh = toSheet_(), tlast = tsh.getLastRow();
  if (tlast > 1) {
    var trows = tsh.getRange(2,1,tlast-1,9).getValues();
    var winS = fmtDate_(start), winE = fmtDate_(end);
    for (var i = trows.length - 1; i >= 0 && timeOff.length < 60; i--) {
      var r = trows[i];
      var rec2 = { id: r[0], email: lc_(r[1]), name: names[lc_(r[1])] || String(r[1]).split('@')[0],
        start: jhaDateStr_(r[2]), end: jhaDateStr_(r[3]), reason: String(r[4]||''), status: String(r[5]) };
      if (seesAll) {
        if (rec2.status === 'pending' || (rec2.status === 'approved' && rec2.end >= winS && rec2.start < winE)) timeOff.push(rec2);
      } else if (rec2.email === lc_(user.email) && rec2.status !== 'cancelled') {
        if (timeOff.length < 10) timeOff.push(rec2);
      }
    }
  }
  return { events: out, canAssign: canAssign, holidays: abHolidays_(start, end), timeOff: timeOff };
}

function scheduleAssign_(user, p) {
  requireAdmin_(user); // scheduling is the admin's call
  if (!p.eventId) throw new Error('No event given.');
  var emails = (p.emails || []).map(lc_).filter(Boolean).slice(0, 30);
  var sh = schedSheet_(), asg = schedAssignments_();
  var prev = (asg[p.eventId] && asg[p.eventId].emails) || [];
  var now = new Date().toISOString();
  if (asg[p.eventId]) sh.getRange(asg[p.eventId].row, 2, 1, 3).setValues([[JSON.stringify(emails), user.email, now]]);
  else sh.appendRow([String(p.eventId), JSON.stringify(emails), user.email, now]);
  // Email only the people NEWLY added — reshuffling one name must not re-spam the whole crew.
  var added = emails.filter(function(e){ return prev.indexOf(e) === -1; });
  if (p.notify !== false) added.forEach(function(e){
    try {
      MailApp.sendEmail(e, 'New job assignment — ' + String(p.title || 'job'),
        'Hi,\n\nYou\'ve been scheduled for:\n\n  ' + String(p.title || 'a job') +
        (p.when ? ('\n  ' + p.when) : '') + (p.location ? ('\n  ' + p.location) : '') +
        '\n\nOpen the timesheet app (Schedule tab) for the full details' +
        (p.appUrl ? (':\n' + p.appUrl) : '.') + '\n\n— PRO Electrical scheduling');
    } catch (err) {}
  });
  log_(user, 'scheduleAssign', emails.join(', '), '', String(p.title || '').substring(0, 80));
  return { ok: true, assigned: emails, notified: added.length };
}

// ---------------------------- Return visits (v34) ----------------------------------------------
/* "We booked 2 hours, the job isn't done, when can we come back?"
 *
 * The tech ticks a box on the clock-out review, says how long the rest will take, and the app
 * reads Paul's calendar and offers the first few openings that actually fit. They agree one with
 * the customer standing there, and it lands on the calendar before they drive away.
 *
 * Deliberately conservative about what counts as free: an all-day event blocks the whole day,
 * every booking gets TRAVEL_BUFFER_MIN of clearance either side, and only ONE slot per day is
 * offered. Suggesting a time that turns out to be taken is far worse than missing one that was
 * free — you have already promised it to the customer by then. */

/* v36 - the working day is now the ball-park sequence's day, so the app and the estimating
 * skill stop disagreeing about when Paul works: Mon-Fri 08:30-12:30 and 13:00-18:00.
 *
 * Lunch is a PAUSE, not a wall. A 5.5 hr job booked at 08:30 runs 08:30-12:30, breaks, and
 * finishes 13:00-14:30 - so the wall-clock end is half an hour past the working hours. That is
 * why the arithmetic below adds the lunch back on instead of treating the day as two windows
 * a job has to fit inside one of. A full day is 9 working hours (08:30-18:00 less lunch). */
var VISIT_ = {
  DAY_START_H: 8,   DAY_START_M: 30,       // 08:30
  DAY_END_H:  18,   DAY_END_M:  0,         // 18:00, Mon-Fri
  LUNCH_START_H: 12, LUNCH_START_M: 30,    // 12:30
  LUNCH_END_H:  13,  LUNCH_END_M:  0,      // 13:00
  TRAVEL_BUFFER_MIN: 30,                   // clearance either side of an existing booking
  HORIZON_DAYS: 45,                        // how far ahead to look
  MAX_SLOTS: 6
};

function visitDayBounds_(d) {
  var at = function (h, m) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0).getTime();
  };
  return {
    s:  at(VISIT_.DAY_START_H,   VISIT_.DAY_START_M),
    e:  at(VISIT_.DAY_END_H,     VISIT_.DAY_END_M),
    ls: at(VISIT_.LUNCH_START_H, VISIT_.LUNCH_START_M),
    le: at(VISIT_.LUNCH_END_H,   VISIT_.LUNCH_END_M)
  };
}

/* How much of [a, b) is lunch. */
function visitLunchIn_(a, b, ls, le) {
  var lo = Math.max(a, ls), hi = Math.min(b, le);
  return hi > lo ? (hi - lo) : 0;
}

/* Working milliseconds between two wall-clock times on one day - lunch does not count. */
function visitWorkMs_(a, b, ls, le) {
  return Math.max(0, (b - a) - visitLunchIn_(a, b, ls, le));
}

/* Wall-clock end of `needMs` of WORK starting at `a`: the lunch it spans is added back on. */
function visitWorkEnd_(a, needMs, ls, le) {
  var end = a + needMs;
  var lunch = visitLunchIn_(a, end, ls, le);
  if (lunch) end += lunch;                       // pushed past lunch; re-check nothing new is spanned
  return end;
}

function visitCal_() {
  var cal = CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]) || CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('Cannot reach the calendar — Paul may need to re-approve calendar access.');
  return cal;
}

/* Approved time off for ONE person, as a { 'YYYY-MM-DD': reason } map. The person booking is the
 * one who will drive back, so their own leave is what must not be booked over. */
function visitLeaveDays_(email, from, to) {
  var out = {}, sh = toSheet_(), last = sh.getLastRow();
  if (last < 2) return out;
  var rows = sh.getRange(2, 1, last - 1, 9).getValues();
  var fromS = fmtDate_(from), toS = fmtDate_(to);
  for (var i = 0; i < rows.length; i++) {
    if (lc_(rows[i][1]) !== lc_(email)) continue;
    if (String(rows[i][5]) !== 'approved') continue;
    var s = jhaDateStr_(rows[i][2]), e = jhaDateStr_(rows[i][3]);
    if (!s) continue;
    if (e < fromS || s > toS) continue;
    for (var d = new Date(s + 'T12:00:00'); fmtDate_(d) <= (e || s); d = new Date(d.getTime() + 86400000)) {
      out[fmtDate_(d)] = String(rows[i][4] || 'time off');
      if (fmtDate_(d) >= toS) break;
    }
  }
  return out;
}

/**
 * action: "visitSlots"
 * payload: { hours: 3, afterDate: "2026-09-29" (optional), count: 4 (optional) }
 *
 * Returns the first open windows on Paul's calendar that fit `hours`, skipping weekends,
 * Alberta stat holidays and the caller's own approved leave. Read-only — books nothing.
 */
function visitSlots_(user, p) {
  var hours = Math.max(0.5, Math.min(40, Number(p && p.hours) || 2));
  var count = Math.max(1, Math.min(VISIT_.MAX_SLOTS, Number(p && p.count) || 4));

  var from = new Date(); from.setHours(0, 0, 0, 0);
  from = new Date(from.getTime() + 86400000);                    // never offer today
  if (p && p.afterDate && /^\d{4}-\d{2}-\d{2}$/.test(p.afterDate)) {
    var a = new Date(p.afterDate + 'T00:00:00');
    if (a.getTime() > from.getTime()) from = a;
  }
  var to = new Date(from.getTime() + VISIT_.HORIZON_DAYS * 86400000);

  var events = visitCal_().getEvents(from, to);
  var busy = [];
  events.forEach(function (ev) {
    try {
      if (ev.isAllDayEvent()) {
        busy.push({ s: ev.getAllDayStartDate().getTime(), e: ev.getAllDayEndDate().getTime(),
                    allDay: true, title: ev.getTitle() || '' });
      } else {
        busy.push({ s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime(),
                    allDay: false, title: ev.getTitle() || '' });
      }
    } catch (err) {}
  });

  var hol = {}; abHolidays_(from, to).forEach(function (h) { hol[h.date] = h.name; });
  var leave = visitLeaveDays_(user.email, from, to);

  var fullDay = (VISIT_.DAY_END_H + VISIT_.DAY_END_M / 60)
              - (VISIT_.DAY_START_H + VISIT_.DAY_START_M / 60)
              - ((VISIT_.LUNCH_END_H + VISIT_.LUNCH_END_M / 60)
                 - (VISIT_.LUNCH_START_H + VISIT_.LUNCH_START_M / 60));   // 9 working hours
  var multiDay = hours > fullDay + 0.01;
  var perVisit = multiDay ? fullDay : hours;
  var needMs = perVisit * 3600000;

  var slots = [], skipped = [];
  for (var d = new Date(from); d.getTime() < to.getTime() && slots.length < count;
       d = new Date(d.getTime() + 86400000)) {
    var dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    var ds = fmtDate_(d);
    if (hol[ds])   { skipped.push({ date: ds, why: hol[ds] }); continue; }
    if (leave[ds]) { skipped.push({ date: ds, why: 'you are off — ' + leave[ds] }); continue; }

    var b = visitDayBounds_(d), ws = b.s, we = b.e, ls = b.ls, le = b.le;
    var blocks = busy.filter(function (x) { return x.e > ws && x.s < we; })
                     .sort(function (x, y) { return x.s - y.s; });

    var cursor = ws, free = [];
    for (var i = 0; i < blocks.length; i++) {
      var pad = blocks[i].allDay ? 0 : VISIT_.TRAVEL_BUFFER_MIN * 60000;
      var bs = Math.max(ws, blocks[i].s - pad);
      var be = Math.min(we, blocks[i].e + pad);
      if (bs > cursor) free.push({ s: cursor, e: bs });
      if (be > cursor) cursor = be;
    }
    if (cursor < we) free.push({ s: cursor, e: we });

    for (var j = 0; j < free.length; j++) {
      // The window has to hold needMs of WORK. A window straddling 12:30-13:00 is half an hour
      // longer on the clock than it is in working time, and a job placed in it finishes half an
      // hour later - so measure in working time and put the lunch back when setting the end.
      if (visitWorkMs_(free[j].s, free[j].e, ls, le) >= needMs - 60000) {   // 1 min tolerance
        var endAt = visitWorkEnd_(free[j].s, needMs, ls, le);
        if (endAt > free[j].e + 60000) continue;                // lunch pushed it past the window
        slots.push({
          start: new Date(free[j].s).toISOString(),
          end:   new Date(endAt).toISOString(),
          windowEnd: new Date(free[j].e).toISOString(),
          overLunch: visitLunchIn_(free[j].s, endAt, ls, le) > 0,
          wholeDay: (free[j].s <= ws && free[j].e >= we),
          hours: Math.round(perVisit * 100) / 100
        });
        break;                                                  // one offer per day, earliest fit
      }
    }
  }

  return {
    slots: slots, hours: hours, perVisit: Math.round(perVisit * 100) / 100,
    multiDay: multiDay,
    daysNeeded: multiDay ? Math.ceil(hours / fullDay) : 1,
    workday: { start: pad2_(VISIT_.DAY_START_H) + ':' + pad2_(VISIT_.DAY_START_M),
               end:   pad2_(VISIT_.DAY_END_H)   + ':' + pad2_(VISIT_.DAY_END_M),
               lunch: pad2_(VISIT_.LUNCH_START_H) + ':' + pad2_(VISIT_.LUNCH_START_M) + '–' +
                      pad2_(VISIT_.LUNCH_END_H)   + ':' + pad2_(VISIT_.LUNCH_END_M),
               days: 'Mon–Fri', bufferMin: VISIT_.TRAVEL_BUFFER_MIN },
    horizonDays: VISIT_.HORIZON_DAYS,
    skipped: skipped.slice(0, 12)
  };
}

/* Did this person actually work this job? Anyone on the crew can book a return visit for a job
 * they have been on — that is the whole point, they are standing in front of the customer — but
 * not for somebody else's job. Admins are not restricted. */
function visitWorkedJob_(user, po, site) {
  if (user.role === 'admin') return true;
  var sh = getEmployeeSheet_(lc_(user.email), false);
  if (!sh) return false;
  var last = sh.getLastRow();
  if (last <= ENTRY_HEADER_ROW) return false;
  var take = Math.min(last - ENTRY_HEADER_ROW, 400);
  var rows = sh.getRange(last - take + 1, 1, take, ENTRY_HEADERS.length).getValues();
  var wantPo = poKeyV_(po), wantSite = lc_(site);
  for (var i = 0; i < rows.length; i++) {
    if (wantPo   && poKeyV_(rows[i][COL['PO#'] - 1]) === wantPo) return true;
    if (!wantPo && wantSite && lc_(rows[i][COL['Customer/Job Site'] - 1]) === wantSite) return true;
  }
  return false;
}
function poKeyV_(v) { return String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

/* Write a Schedule-sheet assignment without the admin gate scheduleAssign_ enforces. The person
 * booking their own return visit is assigning themselves, which needs no approval. */
function visitAssignSelf_(eventId, email) {
  try {
    var sh = schedSheet_(), asg = schedAssignments_(), now = new Date().toISOString();
    var emails = [lc_(email)];
    if (asg[eventId]) sh.getRange(asg[eventId].row, 2, 1, 3).setValues([[JSON.stringify(emails), email, now]]);
    else sh.appendRow([String(eventId), JSON.stringify(emails), email, now]);
    return true;
  } catch (e) { return false; }
}

/* The customer's email off the PO Log row, or ''. */
function visitCustomerEmail_(po) {
  try {
    if (!po || !CONFIG.PO_EMAIL_COL) return '';
    var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
    var sh = poTab_(ss, CONFIG.PO_SHEET_NAME); if (!sh) return '';
    var hdr = poHeader_(sh, 'po number');
    var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
    var last = sh.getLastRow(); if (last <= headerRow) return '';
    var wide = Math.max(CONFIG.PO_EMAIL_COL, CONFIG.PO_NUMBER_COL);
    var vals = sh.getRange(headerRow + 1, 1, last - headerRow, wide).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (poKeyV_(vals[i][CONFIG.PO_NUMBER_COL - 1]) === poKeyV_(po))
        return String(vals[i][CONFIG.PO_EMAIL_COL - 1] || '').trim();
    }
  } catch (e) {}
  return '';
}

/* The job's existing booking, so a return visit continues it instead of looking like a
 * different job. Matched on the PO first (it is in the title AND the description of anything
 * the app booked), falling back to the job-site name. Takes the LATEST one, so a second return
 * visit continues the first rather than the original call. */
function visitFindOriginal_(cal, po, site) {
  var now = Date.now();
  var evs = cal.getEvents(new Date(now - 180 * 86400000), new Date(now + 180 * 86400000));
  var wantPo = poKeyV_(po), wantSite = lc_(site).trim();
  var best = null, bestScore = 0;
  for (var i = 0; i < evs.length; i++) {
    var ev = evs[i], score = 0;
    try {
      var t = String(ev.getTitle() || '');
      // A PO in the title or the description is conclusive.
      if (wantPo && (poKeyV_(t).indexOf(wantPo) >= 0 ||
                     poKeyV_(ev.getDescription() || '').indexOf(wantPo) >= 0)) score = 2;
      // Otherwise the job name in the TITLE only, and only when it is long enough to mean
      // something — a three-letter customer name matches half the calendar by accident.
      else if (wantSite.length >= 4 && lc_(t).indexOf(wantSite) >= 0) score = 1;
      if (!score) continue;
      if (score > bestScore ||
          (score === bestScore && best && ev.getStartTime().getTime() > best.getStartTime().getTime())) {
        best = ev; bestScore = score;
      }
    } catch (e) {}
  }
  return best;
}

/**
 * action: "visitBook"
 * payload: { po, jobSite, start (ISO), hours, note, notifyCustomer: false, location }
 *
 * Creates the return-visit event on Paul's calendar and assigns the booker to it.
 * Re-checks the slot immediately before writing: the tech may have spent five minutes talking
 * to the customer, and Paul may have booked something into that gap meanwhile.
 */
function visitBook_(user, p, opts) {
  var po   = String((p && p.po) || '').trim();
  var site = String((p && p.jobSite) || '').trim();
  if (!po && !site) throw new Error('No job given.');

  var start = new Date(String((p && p.start) || ''));
  if (isNaN(start.getTime())) throw new Error('No start time given.');
  if (start.getTime() < Date.now() && !(opts && opts.allowPast))      // v51
    throw new Error('That slot has already passed — pick another.');

  var hours = Math.max(0.5, Math.min(12, Number(p && p.hours) || 2));
  var end = new Date(start.getTime() + hours * 3600000);

  if (!visitWorkedJob_(user, po, site))
    throw new Error('You can only book a return visit for a job you have worked on.');

  var cal = visitCal_();
  var clash = cal.getEvents(start, end).filter(function (ev) {
    try { return !ev.isAllDayEvent(); } catch (e) { return true; }
  });
  if (clash.length && !(opts && opts.allowClash))      // v40 - bumpApply has already moved the jobs out
    throw new Error('That slot was taken while you were booking — "' +
                    (clash[0].getTitle() || 'something else') + '". Pick another.');

  // The return visit is always its OWN event — a calendar event cannot stretch from Monday
  // afternoon to Thursday morning without blacking out the days between. It carries the
  // original booking's colour, its name plus "(cont'd)", its location, AND its description,
  // so anything Paul added to the first booking (a note about what to bring, a gate code, who
  // to ask for) comes with it to the second visit instead of being retyped or forgotten.
  var orig = null;
  try { orig = visitFindOriginal_(cal, po, site); } catch (e) {}

  var baseTitle = orig ? String(orig.getTitle() || '') : '';
  var title = baseTitle
    ? (/\(cont'd/i.test(baseTitle) ? baseTitle : baseTitle + " (cont'd)")
    : ((site || 'Job') + (po ? ' · ' + po : '') + ' (return visit)');   // v89 - who it is, not RETURN

  var carried = '';
  if (orig) {
    try { carried = String(orig.getDescription() || '').trim(); } catch (e) {}
    // A previous continuation already carries its own RETURN VISIT header. Strip everything
    // down to and including its "FROM THE ORIGINAL BOOKING" rule, so the third visit shows the
    // job's own notes once rather than a stack of headers from every visit before it.
    carried = carried.replace(/^[\s\S]*?={6,}\s*FROM THE ORIGINAL BOOKING\s*={6,}\s*/i, '').trim();
  }

  var header = [
    'RETURN VISIT — the job was not finished on the previous call.',
    po   ? ('PO: ' + po) : '',
    site ? ('Job: ' + site) : '',
    'Booked for ' + hours + ' hr' + (hours === 1 ? '' : 's') +
      (orig ? (', continuing ' + fmtDate_(orig.getStartTime()) + '.') : '.'),
    (p && p.note) ? ('\nWhat is left:\n' + String(p.note).substring(0, 1500)) : '',
    'Booked from the timesheet app by ' + String(user.email).split('@')[0] +
      ' on ' + fmtDate_(new Date()) + ', with the customer.'
  ].filter(String).join('\n');

  var body = header + (carried
    ? ('\n\n' + Array(61).join('=') + '\nFROM THE ORIGINAL BOOKING\n' + Array(61).join('=') + '\n' + carried)
    : '');

  var ev = cal.createEvent(title, start, end,
    { description: body,
      location: String((p && p.location) || '') || (orig ? String(orig.getLocation() || '') : '') });
  var evId = ev.getId();
  // Same colour as the booking it continues. '' is the calendar default, which a new event
  // already has, so there is nothing to set.
  try { var c0 = orig ? String(orig.getColor() || '') : ''; if (c0) ev.setColor(c0); } catch (e) {}

  visitAssignSelf_(evId, user.email);

  var custNote = '';
  if (p && p.notifyCustomer) {
    var to = String(p.customerEmail || '').trim() || visitCustomerEmail_(po);
    if (!to) custNote = 'no customer email on file — not notified';
    else {
      try {
        var rvIntro = 'Thanks for having us out. We could not finish the work in the time we had, ' +
                      'so we have booked the return visit in:';
        var rvLines = ['About ' + hours + ' hour' + (hours === 1 ? '' : 's') + ' on site', site];
        MailApp.sendEmail({
          to: to,
          subject: 'Booked: your PRO Electrical return visit — ' + whenText_(start),
          body: 'Hi,\n\n' + rvIntro + '\n\n  ' + whenText_(start) + '\n' +
                rvLines.filter(String).map(function (t) { return '  ' + t + '\n'; }).join('') +
                '\nIf that does not suit, just reply to this email and we will move it.\n\n' +
                '— PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca  ·  780-625-5880',
          htmlBody: custEmailHtml_({
            heading: 'Hello,', intro: rvIntro, when: whenText_(start), lines: rvLines,
            footNote: 'If that does not suit, just reply to this email and we will move it.'
          }),
          name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0] });
        custNote = 'customer notified at ' + to;
      } catch (e) { custNote = 'customer email failed: ' + e.message; }
    }
  }

  log_(user, 'visitBook', site, po, title + ' @ ' + start.toISOString() +
       (custNote ? ('  ·  ' + custNote) : ''));

  return { ok: true, continues: !!orig, eventId: evId, title: title,
           start: start.toISOString(), end: end.toISOString(), hours: hours, custNote: custNote };
}

// ---- Time off requests + Alberta stat holidays (shown in the Schedule tab) ----
/* Crew request time off in the app; admins approve/deny from the Schedule tab and see who's
 * off on any day they're assigning. Alberta's nine general (stat) holidays are computed and
 * shown to everyone — no lookups to maintain. */

function toSheet_() {
  var sh = masterSheet_(SHEETS.TIMEOFF);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,9).setValues([[
    'ReqID','Email','Start Date','End Date','Reason','Status','Requested At','Decided By','Decided At'
  ]]).setFontWeight('bold');
  return sh;
}
function toRow_(id) {
  var sh = toSheet_(), last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2,1,last-1,9).getValues();
  for (var i=0;i<vals.length;i++) if (String(vals[i][0]) === String(id)) return { sheet: sh, row: i+2, values: vals[i] };
  return null;
}

function timeOffRequest_(user, p) {
  var s = String(p.startDate || '').trim(), e = String(p.endDate || s).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw new Error('Pick the dates.');
  if (e < s) throw new Error('End date is before the start date.');
  if ((new Date(e) - new Date(s)) > 60 * 86400000) throw new Error('That is over 60 days — talk to Paul directly for leave that long.');
  var id = 'to_' + newId_();
  /* v102 - an admin puts time off on the calendar by hand (Paul, 9 Nov), for anyone on the team:
   * it goes in already approved, decided by the admin, and nobody is emailed. */
  if (p.forEmail || p.approved) {
    requireAdmin_(user);
    var who = lc_(p.forEmail || user.email), now = new Date().toISOString();
    toSheet_().appendRow([id, who, s, e, String(p.reason || '').substring(0, 300), 'approved', now, user.email, now]);
    log_(user, 'timeOffRequest', who, id, s + '..' + e + ' (added approved by hand)');
    return { ok: true, id: id, approved: true };
  }
  toSheet_().appendRow([id, lc_(user.email), s, e, String(p.reason || '').substring(0, 300),
    'pending', new Date().toISOString(), '', '']);
  var name = null; try { var rec = getEmployeeRecordCached_(user.email); name = rec && rec.name; } catch (err) {}
  name = name || user.email.split('@')[0];
  CONFIG.ADMIN_EMAILS.forEach(function(a){
    try { MailApp.sendEmail(a, 'Time-off request — ' + name,
      name + ' is asking for time off:\n\n  ' + s + (e !== s ? (' to ' + e) : '') +
      (p.reason ? ('\n  Reason: ' + p.reason) : '') +
      '\n\nApprove or deny it in the app: Requests tab.'); } catch (err) {}
  });
  log_(user, 'timeOffRequest', user.email, id, s + '..' + e);
  return { ok: true, id: id };
}

function timeOffCancel_(user, p) {
  var loc = toRow_(p.reqId);
  if (!loc) throw new Error('Request not found.');
  if (lc_(loc.values[1]) !== lc_(user.email)) throw new Error('Not your request.');
  if (loc.values[5] !== 'pending') throw new Error('Only pending requests can be cancelled.');
  loc.sheet.getRange(loc.row, 6).setValue('cancelled');
  log_(user, 'timeOffCancel', user.email, String(p.reqId), '');
  return { ok: true };
}

function timeOffDecide_(user, p) {
  requireAdmin_(user);
  var loc = toRow_(p.reqId);
  if (!loc) throw new Error('Request not found.');
  if (loc.values[5] !== 'pending') throw new Error('Already decided.');
  var status = p.approve ? 'approved' : 'denied';
  loc.sheet.getRange(loc.row, 6, 1, 4).setValues([[status, loc.values[6], user.email, new Date().toISOString()]]);
  // ^ col 6 = Status; keep Requested At; then Decided By/At (cols 8,9 via width-4 write starting at 6)
  var s = jhaDateStr_(loc.values[2]), e = jhaDateStr_(loc.values[3]);
  try { MailApp.sendEmail(lc_(loc.values[1]), 'Time off ' + status + ' — ' + s + (e !== s ? (' to ' + e) : ''),
    'Your time-off request for ' + s + (e !== s ? (' to ' + e) : '') + ' was ' + status.toUpperCase() +
    ' by ' + user.email + '.' + (p.note ? ('\n\nNote: ' + p.note) : '') + '\n\n— PRO Electrical scheduling'); } catch (err) {}
  log_(user, 'timeOffDecide', String(loc.values[1]), String(p.reqId), status);
  return { ok: true, status: status };
}

// ---- Allowances (3.3): employee claims → admin approval → payroll export column ----
var ALLOWANCE_TYPES = { phone: 'Cellphone', food: 'Food', km: 'Mileage', other: 'Other' };
function allowSheet_() {
  var sh = masterSheet_(SHEETS.ALLOW);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,11).setValues([[
    'ID','Email','Date','Type','Km','Amount','Note','Status','Requested At','Decided By','Decided At']]).setFontWeight('bold');
  return sh;
}
function allowRow_(id) {
  var sh = allowSheet_(), last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2,1,last-1,11).getValues();
  for (var i=0;i<vals.length;i++) if (String(vals[i][0]) === String(id)) return { sheet: sh, row: i+2, values: vals[i] };
  return null;
}
function allowanceClaim_(user, p) {
  var type = String(p.type || '');
  if (!ALLOWANCE_TYPES[type]) throw new Error('Pick the allowance type.');
  var elig = (user.permissions && user.permissions.allowances) || {};
  if (user.role !== 'admin' && !elig[type]) throw new Error('Your account is not set up for that allowance — ask an admin.');
  var d = String(p.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Pick the date.');
  var cfg = allowCfg_();
  var km = 0, amount = 0, note = String(p.note || '').substring(0, 200);
  if (type === 'km') {
    km = Number(p.km) || 0;
    if (km <= 0 || km > 2000) throw new Error('Enter the kilometres driven (1–2000).');
    if (!note) throw new Error('Where did you drive to? Add the destination.');
    amount = Math.round(km * (Number(cfg.km) || CONFIG.MILEAGE_RATE) * 100) / 100;
  } else {
    amount = Number(p.amount) || 0;
    if (amount <= 0 || amount > 5000) throw new Error('Enter the amount (up to $5000).');
    amount = Math.round(amount * 100) / 100;
  }
  // Meals: a receipt photo is the rule, and anything over the CRA reasonable amount is flagged
  // rather than blocked — a $26 meal in a camp town is real, it just needs Paul's eyes.
  var photoUrl = '';
  if (type === 'food') {
    if (cfg.mealNeedsPhoto && !p.dataBase64) throw new Error('Take a photo of the meal receipt first.');
    photoUrl = allowPhoto_(user, p, 'Meal receipt');
    if (photoUrl) note = note ? (note + ' — ' + photoUrl) : photoUrl;
    if (cfg.meal && amount > Number(cfg.meal))
      note = '⚠ over the $' + cfg.meal + ' meal cap. ' + note;
  }
  var id = 'al_' + newId_();
  allowSheet_().appendRow([id, lc_(user.email), d, type, km || '', amount,
    note, 'pending', new Date().toISOString(), '', '']);
  log_(user, 'allowanceClaim', user.email, id, ALLOWANCE_TYPES[type] + ' $' + amount);
  return { ok: true, id: id, amount: amount };
}
function allowanceCancel_(user, p) {
  var loc = allowRow_(p.id);
  if (!loc) throw new Error('Claim not found.');
  if (lc_(loc.values[1]) !== lc_(user.email)) throw new Error('Not your claim.');
  if (loc.values[7] !== 'pending') throw new Error('Only pending claims can be cancelled.');
  loc.sheet.getRange(loc.row, 8).setValue('cancelled');
  return { ok: true };
}
function allowanceDecide_(user, p) {
  requireAdmin_(user);
  var loc = allowRow_(p.id);
  if (!loc) throw new Error('Claim not found.');
  if (loc.values[7] !== 'pending') throw new Error('Already decided.');
  var status = p.approve ? 'approved' : 'denied';
  loc.sheet.getRange(loc.row, 8, 1, 4).setValues([[status, loc.values[8], user.email, new Date().toISOString()]]);
  log_(user, 'allowanceDecide', String(loc.values[1]), String(p.id), status);
  return { ok: true, status: status };
}
function allowanceList_(user, p) {
  var sh = allowSheet_(), last = sh.getLastRow(), out = [];
  var isAdmin = user.role === 'admin';
  var names = isAdmin ? employeeNameMap_() : {};
  if (last > 1) {
    var vals = sh.getRange(2,1,last-1,11).getValues();
    for (var i = vals.length-1; i >= 0 && out.length < 60; i--) {
      var r = vals[i];
      var rec = { id: r[0], email: lc_(r[1]), date: jhaDateStr_(r[2]), type: String(r[3]),
        typeName: ALLOWANCE_TYPES[String(r[3])] || String(r[3]), km: Number(r[4])||0,
        amount: Number(r[5])||0, note: String(r[6]||''), status: String(r[7]) };
      if (isAdmin) { rec.name = names[rec.email] || rec.email.split('@')[0];
        if (rec.status === 'pending' || out.length < 30) out.push(rec); }
      else if (rec.email === lc_(user.email) && rec.status !== 'cancelled') { if (out.length < 15) out.push(rec); }
    }
  }
  return { claims: out, mileageRate: CONFIG.MILEAGE_RATE,
    eligible: (user.role==='admin') ? Object.keys(ALLOWANCE_TYPES)
      : Object.keys((user.permissions&&user.permissions.allowances)||{}).filter(function(k){ return user.permissions.allowances[k] && ALLOWANCE_TYPES[k]; }) };
}

function allowanceTotal_(email, period) {
  var sh = allowSheet_(), last = sh.getLastRow(), sum = 0;
  if (last > 1) {
    var vals = sh.getRange(2,1,last-1,11).getValues();
    for (var i=0;i<vals.length;i++){
      if (lc_(vals[i][1]) !== lc_(email) || String(vals[i][7]) !== 'approved') continue;
      var d = jhaDateStr_(vals[i][2]);
      if (d && periodKey_(new Date(d + 'T12:00:00')) === period) sum += Number(vals[i][5]) || 0;
    }
  }
  return Math.round(sum * 100) / 100;
}

// Re-file a receipt that was stashed on the phone when Drive filing failed at scan time.
// Same PDF, same per-job folder, same name-based dedupe — no AI call needed (already scanned).
function fileReceipt_(user, p) {
  if (!p.dataBase64) throw new Error('No photo received.');
  var receiptUrl = '';
  var parent = p.jobSite ? ensureJobFolder_(p.jobSite) : DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
  var it = parent.getFoldersByName('Receipts');
  var folder = it.hasNext() ? it.next() : parent.createFolder('Receipts');
  var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var pdfName = 'Receipt — ' + (p.vendor || 'supplier').replace(/[\\\/:*?"<>|]/g,'-') + ' — ' + (p.date || fmtDate_(new Date())) +
    (p.jobSite ? (' — ' + String(p.jobSite).replace(/[\\\/:*?"<>|]/g,'-')) : '') + '.pdf';
  var dup = folder.getFilesByName(pdfName);
  if (dup.hasNext()) return { receiptUrl: dup.next().getUrl() }; // already synced from another try
  var html = '<html><head><meta charset="utf-8"><style>body{font-family:Arial;font-size:11px;color:#111}h1{font-size:15px;margin:0 0 2px}</style></head><body>' +
    '<h1>Receipt — ' + esc(p.vendor || 'supplier') + '</h1>' +
    '<p style="margin:2px 0 8px;color:#444">' + esc(p.date || fmtDate_(new Date())) +
    (Number(p.total) ? (' · Total $' + Number(p.total).toFixed(2)) : '') +
    (p.jobSite ? (' · Job: ' + esc(p.jobSite) + (p.poNumber ? (' (PO ' + esc(p.poNumber) + ')') : '')) : '') +
    ' · Scanned by ' + esc(user.email.split('@')[0]) + ' · synced from phone</p>' +
    '<img src="data:' + (p.mimeType || 'image/jpeg') + ';base64,' + p.dataBase64 + '" style="width:100%;max-width:640px"></body></html>';
  var file = folder.createFile(Utilities.newBlob(html, 'text/html', 'r.html').getAs('application/pdf').setName(pdfName));
  file.setDescription('Scanned by ' + user.email + ' (phone-synced)');
  try { file.addViewer(user.email); } catch (e) {}
  log_(user, 'fileReceipt', String(p.jobSite||''), '', pdfName);
  return { receiptUrl: file.getUrl() };
}

// ---- 3.6: invoice request relay — the app button asks Claude to build the invoice ----

/* ---------------------- Archiving a finished job (v26) -----------------------------------
 * Until now a job folder only moved to "2. Completed invoices" if a person ran the invoice
 * skill AND remembered its last step. On 2026-09-11 that step was missed and the KFC job sat
 * in "1. Ongoing Invoice" with its invoice already built. The app now does it, in the same
 * breath as closing the PO Log row, so there is nothing to remember.
 * ----------------------------------------------------------------------------------------*/

var MONTH_NAMES_ = ['January','February','March','April','May','June','July','August',
                    'September','October','November','December'];

/* <Completed>/<YYYY>/<N. Month>, resolved BY NAME each time. Returns null rather than creating
 * anything: these are Paul's folders and a silent mkdir in the wrong place hides a job. */
function completedMonthFolder_(when) {
  // v86 - a bare 'YYYY-MM-DD' is that day in Alberta, read at noon. new Date('2026-11-01') is
  // midnight UTC, which here is 6 pm on Oct 31, so a job invoiced on the 1st of a month was
  // archived into the PREVIOUS month's folder (and Jan 1 into last year's). jobInvoiced_ hands
  // this a bare date every time it falls back to today, so it was not only Claude's payloads.
  var ws = (typeof when === 'string') ? when.trim() : '';
  var d = /^\d{4}-\d{2}-\d{2}$/.test(ws) ? new Date(ws + 'T12:00:00') : new Date(when);
  if (isNaN(d.getTime())) d = new Date();
  var root = DriveApp.getFolderById(CONFIG.PO_COMPLETED_FOLDER_ID);
  var yIt = root.getFoldersByName(String(d.getFullYear()));
  if (!yIt.hasNext()) return { error: 'no ' + d.getFullYear() + ' folder in Completed invoices' };
  var want = (d.getMonth() + 1) + '. ' + MONTH_NAMES_[d.getMonth()];
  var mIt = yIt.next().getFoldersByName(want);
  if (!mIt.hasNext()) return { error: 'no "' + want + '" folder for ' + d.getFullYear() };
  return { folder: mIt.next(), label: d.getFullYear() + ' / ' + want };
}

/* Move every folder this job owns. Refuses on a name collision in the destination, which
 * almost always means the job was already archived — two folders of the same name in one
 * month is worse than a job left behind, because nobody notices the duplicate. */
function archiveJobFolders_(jobSite, poNumber, invoiceDate) {
  var dest = completedMonthFolder_(invoiceDate);
  if (dest.error) return { moved: [], skipped: [], error: dest.error };
  var never = CONFIG.PO_NEVER_ARCHIVE.map(lc_);
  var moved = [], skipped = [];
  jobPoFolders_(jobSite, poNumber).forEach(function (f) {
    var nm = f.getName();
    if (nm === 'Supplier POs') return;                       // lives under the media folder
    if (never.indexOf(lc_(nm)) >= 0) { skipped.push(nm + ' (not a job folder)'); return; }
    try {
      if (dest.folder.getFoldersByName(nm).hasNext()) {
        skipped.push(nm + ' (already in ' + dest.label + ')'); return;
      }
      f.moveTo(dest.folder);
      moved.push(nm);
    } catch (e) { skipped.push(nm + ' (' + e.message + ')'); }
  });
  return { moved: moved, skipped: skipped, to: dest.label };
}

/* Called by the invoice build once the QuickBooks invoice is CONFIRMED created. Closes the PO
 * Log row and archives the folders. Idempotent: run it twice and the second run reports the
 * folders as already archived instead of doing anything. */
function jobInvoiced_(user, p) {
  requireAdmin_(user);
  var po = String(p.po || '').trim(), job = String(p.jobSite || '').trim();
  if (!po && !job) throw new Error('No job given.');
  if (!p.invoiceNo) throw new Error('No invoice number — the invoice must exist first.');
  poReopenedSet_(po, '');                                  // v102 - invoiced again: the reopen hold ends
  var when = p.invoiceDate || fmtDate_(new Date());
  var out = { po: po, jobSite: job, invoiceNo: String(p.invoiceNo), log: '', moved: [], skipped: [] };

  // 1. the PO Log row: QuickBooks number, end date, status
  try {
    var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
    var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
    var hdr = poHeader_(sh, 'po number');
    var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
    var last = sh.getLastRow(), found = 0;
    if (last > headerRow) {
      var vals = sh.getRange(headerRow+1, 1, last-headerRow, CONFIG.PO_STATUS_COL).getValues();
      for (var i = 0; i < vals.length; i++) {
        var rowPo = lc_(vals[i][CONFIG.PO_NUMBER_COL-1]).replace(/[^a-z0-9]/g,'');
        var rowNm = lc_(vals[i][CONFIG.PO_CUSTOMER_COL-1]);
        var wantPo = lc_(po).replace(/[^a-z0-9]/g,'');
        if ((wantPo && rowPo === wantPo) || (!wantPo && job && rowNm === lc_(job))) {
          var r = headerRow + 1 + i;
          if (CONFIG.PO_QB_COL)      sh.getRange(r, CONFIG.PO_QB_COL).setValue(txt_(String(p.invoiceNo)));
          if (CONFIG.PO_ENDDATE_COL && p.endDate) sh.getRange(r, CONFIG.PO_ENDDATE_COL).setValue(fmtDate_(p.endDate));
          if (CONFIG.PO_STATUS_COL)  sh.getRange(r, CONFIG.PO_STATUS_COL).setValue('Invoiced');
          out.log = 'row ' + r + ' → Invoiced, QuickBooks #' + p.invoiceNo;
          found = r; break;
        }
      }
    }
    if (!found) out.log = 'no PO Log row matched — nothing updated';
    try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}
  } catch (e) { out.log = 'PO Log update FAILED: ' + e.message; }

  // 2. the folders. A failure here must not undo step 1 — the invoice is still real.
  try {
    var a = archiveJobFolders_(job, po, when);
    out.moved = a.moved; out.skipped = a.skipped; out.to = a.to || ''; if (a.error) out.archiveError = a.error;
  } catch (e) { out.archiveError = e.message; }

  log_(user, 'jobInvoiced', job, po, 'inv ' + p.invoiceNo + ' · ' + out.log +
    ' · moved: ' + (out.moved.join(', ') || 'none') + (out.archiveError ? (' · ' + out.archiveError) : ''));
  return out;
}

/* v33 - the Status cell on its own.
 *
 * jobInvoiced_ always writes 'Invoiced', which is right the moment a job is billed. 'Closed'
 * means the money arrived. Nothing in the app could write 'Closed', so every job that got paid
 * stayed wrong until somebody edited the sheet by hand - which on 2026-09-21 had left $17,003 of
 * UNPAID work sitting under a "Closed" label, and R26177 reading "Invoiced" after it was paid.
 *
 * This deliberately does NOT ask QuickBooks anything. Working out which invoices are paid needs a
 * connection Apps Script does not have; Claude already has it. Claude decides, this writes.
 *
 * payload: { po: 'R26177', status: 'Closed' }
 */
function jobSetStatus_(user, p) {
  requireAdmin_(user);
  var po = String(p.po || '').trim();
  if (!po) throw new Error('No PO number given.');

  var status = String(p.status || '').trim();
  var ALLOWED = ['In progress', 'Invoiced', 'Closed'];
  if (ALLOWED.indexOf(status) < 0) throw new Error('status must be one of: ' + ALLOWED.join(', '));

  var before = poLogStatus_(po);
  if (before === status) {
    return { po: po, was: before, now: status, log: 'already read "' + status + '" - no change' };
  }

  /* v102 (10 Nov) - A JOB PAUL REOPENED STAYS OPEN. The app's Reopen button puts a Closed or Invoiced
   * job back to In progress for more work on the same number. The PO Log sweep (a Claude task, which
   * signs in with the key as 'claude-task') sees an invoice number beside "In progress" and used to
   * set it straight back to Invoiced and Closed - House on the Hill C26197, reopened 9 Nov and booked
   * for the 10th. A task is now told no for such a job; a person in the app still can, and a new
   * invoice (jobInvoiced) ends the hold. */
  var byTask = lc_(user && user.email) === 'claude-task', held = poReopened_()[po.toUpperCase()];
  if (byTask && status !== 'In progress' && before === 'In progress' && held) {
    return { po: po, was: before, now: before, held: true,
      log: 'reopened in the app on ' + held + ' - left "In progress", NOT changed. Paul reopened it on purpose; leave it alone until it is invoiced again.' };
  }

  var note = poLogSetStatus_(po, status);
  if (!byTask) poReopenedSet_(po, (status === 'In progress' && /^(closed|invoiced|cancelled)$/i.test(before)) ? fmtDate_(new Date()) : '');
  try { CacheService.getScriptCache().remove('jobCosts'); } catch (e) {}   // v102 - the Jobs tab must show the new status at once
  log_(user, 'jobSetStatus', '', po, (before || '(blank)') + ' -> ' + status + ' · ' + note);
  return { po: po, was: before, now: status, log: note };
}
/* The jobs reopened in the app: { PO: day reopened }. C26197 was reopened the night before this existed. */
function poReopened_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('po_reopened') || '{"C26197":"2026-11-09"}') || {}; }
  catch (e) { return {}; }
}
function poReopenedSet_(po, day) {
  var m = poReopened_(), k = String(po || '').trim().toUpperCase();
  if (!k || (!day && !m[k])) return;
  if (day) m[k] = String(day); else delete m[k];
  try { PropertiesService.getScriptProperties().setProperty('po_reopened', JSON.stringify(m)); } catch (e) {}
}

/* v33 - fill a blank Start Date and/or End Date from evidence.
 *
 * Start Date normally means "when the job was booked": createPo_ stamps the day the PO was raised,
 * approval writes the scheduled appointment, and poLogSetStart_ moves it when a job is rescheduled.
 * End Date means "the last day anyone worked the job".
 *
 * This ONLY writes into a cell that is currently EMPTY. It never overwrites a booked date, never
 * corrects one Paul typed, and never touches anything else on the row. A row the app booked already
 * has a Start Date, so it is left alone; the only rows this can fill are ones nothing ever booked.
 *
 * payload: { po: 'R26176', startDate: '2026-09-02T12:00:00', endDate: '2026-09-08T12:00:00' }
 * Either date may be omitted. Send dates with a midday time - see fmtDate_ for why.
 */
function jobSetDates_(user, p) {
  requireAdmin_(user);
  var po = String(p.po || '').trim();
  if (!po) throw new Error('No PO number given.');
  if (!p.startDate && !p.endDate) throw new Error('Nothing to write: send startDate, endDate, or both.');

  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
  if (!sh) throw new Error('PO Log tab not found');
  var hdr = poHeader_(sh, 'po number');
  var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
  var last = sh.getLastRow();
  if (last <= headerRow) return { po: po, log: 'PO Log is empty' };

  var col = sh.getRange(headerRow + 1, CONFIG.PO_NUMBER_COL, last - headerRow, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() !== po) continue;

    var r = headerRow + 1 + i, wrote = [], skipped = [];

    if (p.startDate && CONFIG.PO_STARTDATE_COL) {
      var cur = String(sh.getRange(r, CONFIG.PO_STARTDATE_COL).getValue()).trim();
      if (cur) skipped.push('start already ' + cur);
      else { sh.getRange(r, CONFIG.PO_STARTDATE_COL).setValue(fmtDate_(p.startDate)); wrote.push('start ' + fmtDate_(p.startDate)); }
    }
    if (p.endDate && CONFIG.PO_ENDDATE_COL) {
      var curE = String(sh.getRange(r, CONFIG.PO_ENDDATE_COL).getValue()).trim();
      if (curE) skipped.push('end already ' + curE);
      else { sh.getRange(r, CONFIG.PO_ENDDATE_COL).setValue(fmtDate_(p.endDate)); wrote.push('end ' + fmtDate_(p.endDate)); }
    }

    try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}
    var msg = 'row ' + r + ': ' + (wrote.length ? wrote.join(', ') : 'nothing written') +
              (skipped.length ? ' (' + skipped.join('; ') + ')' : '');
    log_(user, 'jobSetDates', '', po, msg);
    return { po: po, row: r, wrote: wrote, skipped: skipped, log: msg };
  }
  return { po: po, log: 'no PO Log row matched - nothing updated' };
}

/* The Status currently on a PO Log row, or '' when the PO is not found. Matches exactly the way
 * poLogSetStatus_ does, so the two can never disagree about which row they mean. */
function poLogStatus_(po) {
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_SHEET_NAME); if (!sh) return '';
  var hdr = poHeader_(sh, 'po number');
  var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
  var last = sh.getLastRow();
  if (last <= headerRow || !CONFIG.PO_STATUS_COL) return '';
  var vals = sh.getRange(headerRow + 1, 1, last - headerRow, CONFIG.PO_STATUS_COL).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][CONFIG.PO_NUMBER_COL - 1]).trim() === String(po).trim())
      return String(vals[i][CONFIG.PO_STATUS_COL - 1]).trim();
  }
  return '';
}

/* v37 - invoicing happens in TWO passes, and the request email says which one.
 *
 * INITIAL DRAFT - every part on its own line at COST, consumables collapsed onto one Misc. line
 * whose description names them all, no markup. Paul opens it in QuickBooks and corrects it:
 * adds what was missed, removes what went back, fixes quantities and hours.
 * FINAL DRAFT - reads back whatever Paul LEFT on that invoice, keeps the hours, rolls the parts
 * into the usual single Materials line and applies the markup tier to the corrected parts total.
 * The same invoice is rewritten, so the number does not change. Neither pass sends anything.
 *
 * The email is the whole instruction: it is picked up in a fresh session with no memory of this
 * one, so it has to stand on its own. */
function invoiceRequest_(user, p) {
  requireAdmin_(user);
  var po = String(p.po || '').trim(), job = String(p.jobSite || '').trim();
  if (!po && !job) throw new Error('No job given.');
  var stage = String(p.stage || 'initial').toLowerCase() === 'final' ? 'final' : 'initial';
  var label = stage === 'final' ? 'FINAL DRAFT' : 'INITIAL DRAFT';

  var what = stage === 'final'
    ? 'Claude: run the quickbook-invoice-building task, FINAL DRAFT pass, for this job.\n\n' +
      '  - Find the invoice built for this PO at the initial-draft pass.\n' +
      '  - REFUSE and report back if it has already been sent to the customer or paid.\n' +
      '  - Read back the lines Paul has LEFT on it - he may have added, removed or changed parts,\n' +
      '    quantities and hours. What is on the invoice now is the truth, not what you first put there.\n' +
      '  - Keep the labour lines as they stand.\n' +
      '  - Replace every part line with the usual single "Electrical Parts:Materials" line, short\n' +
      '    plain-English summary in the description, and apply the markup tier to the corrected\n' +
      '    parts total.\n' +
      '  - Clear the "INITIAL DRAFT - NOT FOR SENDING" note out of the MEMO (PrivateNote). Leave\n' +
      '    the customer message alone - it already carries only the job line.\n' +
      '  - Rewrite the SAME invoice - do not create a second one. Do NOT send it.'
    : 'Claude: run the quickbook-invoice-building task, INITIAL DRAFT pass, for this job.\n\n' +
      (p._list ? '  - PARTS: use ONLY the list Paul confirmed in the app (below, and from the\n' +
                 '    invoiceMaterials action). His quantities are final for this pass; do not re-read the POs.\n'
               : '  - Gather the job POs, the approved hours and the parts as usual.\n') +
      '  - Put EVERY real part on its own line, at COST. No markup at this pass.\n' +
      '  - Collapse the consumables onto ONE "Misc." line whose description names all of them.\n' +
      '  - Labour lines as usual, so Paul can correct the hours too.\n' +
      '  - Put "INITIAL DRAFT - NOT FOR SENDING" in the MEMO (PrivateNote), NEVER in the\n' +
      '    customer message. CustomerMemo is the message the customer reads; PrivateNote is\n' +
      '    the internal Memo. The customer message carries only the job line, e.g.\n' +
      '    "Job ' + (po || 'Rnnnnn') + ' - <job address>".\n' +
      '  - THE CUSTOMER RECORD: fill any BLANK contact field on the QuickBooks customer from\n' +
      '    the PO Log row for this job - email, phone, billing address. NEVER overwrite a field\n' +
      '    that already has a value; report the disagreement instead. No customer record in\n' +
      '    QuickBooks yet: create one from the PO Log row.\n' +
      '  - Do not put a billing email on the invoice - that is what arms QuickBooks to send it.\n' +
      '  - Do NOT send it. Paul corrects it in QuickBooks, then taps Final draft in the app.';

  MailApp.sendEmail(CONFIG.ADMIN_EMAILS[0],
    '[INVOICE REQUEST — ' + label + '] ' + (po || '(no PO)') + ' — ' + job,
    'Invoice ' + label.toLowerCase() + ' requested from the timesheet app.\n\n' +
    '  Job: ' + job + '\n  PO: ' + (po || 'none') +
    '\n  Stage: ' + label +
    '\n  Requested by: ' + user.email + '\n  At: ' + new Date().toLocaleString() +
    '\n\n' + what + (p._list ? '\n\n' + p._list : ''));
  // v40 - start Claude now instead of waiting for the hourly run. The email above stays as the
  // record and as the fallback the hourly run still reads. Final drafts stay a human step.
  var fire = stage === 'initial' ? invoiceFire_(po, job, stage, user.email, p._list) : { fired: false, note: '' };
  log_(user, 'invoiceRequest', job, po, label + (fire.fired ? ' · Claude started' : (fire.note ? ' · ' + fire.note : '')));
  return { ok: true, stage: stage, fired: !!fire.fired, sessionUrl: fire.sessionUrl || '', note: fire.note || '' };
}

// Alberta's nine general holidays, computed for any year (Easter via the standard computus).
function easter_(y){ var a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1; return new Date(y,mo-1,da); }
function nthMonday_(y, month, n){ var d=new Date(y, month, 1); var off=(8-d.getDay())%7; return new Date(y, month, 1+off+(n-1)*7); }
function abHolidays_(start, end) {
  var out = [];
  for (var y = start.getFullYear(); y <= end.getFullYear(); y++) {
    var gf = new Date(easter_(y).getTime() - 2*86400000);
    var may24 = new Date(y,4,24); var vic = new Date(may24.getTime() - ((may24.getDay()+6)%7)*86400000);
    [[new Date(y,0,1),"New Year's Day"], [nthMonday_(y,1,3),'Family Day'], [gf,'Good Friday'],
     [vic,'Victoria Day'], [new Date(y,6,1),'Canada Day'], [nthMonday_(y,8,1),'Labour Day'],
     [nthMonday_(y,9,2),'Thanksgiving'], [new Date(y,10,11),'Remembrance Day'], [new Date(y,11,25),'Christmas Day']
    ].forEach(function(h){ if (h[0] >= start && h[0] < end) out.push({ date: fmtDate_(h[0]), name: h[1] }); });
  }
  return out;
}

// ---------------------------------- Onboarding -------------------------------------------------
/* New-hire onboarding: a checklist (defined in the 'Onboarding' sheet tab — edit it there, no
 * code changes needed) of videos, readings and tasks. Videos live in Drive/YouTube; the app
 * embeds them so the employee never leaves the app. Progress is nag-not-block: they can clock
 * in from day one, but a banner sits on their Clock tab until everything required is done and
 * they sign. Completion files a signed PDF training record — evidence for WCB/OHS. */

// Starter checklist for electricians / field crew. Seeded once into the Onboarding sheet;
// after that the SHEET is the source of truth — edit titles, add video links, reorder there.
// Columns: Order | Title | Type (video/read/task) | Details | Link | Required
var SEED_ONBOARDING = [
  [1,'Welcome to PRO Electrical','read',
   'Welcome aboard. We are a small crew doing commercial, residential and industrial electrical work across the Peace Country, plus Peace Country Wagyu on the farm side. Your boss is Paul (admin@proes.ca). If you are ever unsure about anything — safety, scope, pay, a customer — ask early. Nobody has ever been in trouble here for asking a question.','','Y'],
  [2,'First-day paperwork','task',
   'Send the office: a void cheque or direct-deposit form, your SIN for payroll, an emergency contact name and number, and photos/copies of any tickets you hold (trade cert, first aid, fall protection, etc.).','','Y'],
  [3,'How to use this app','read',
   'Clock in when you start, clock out when you stop — the app picks the job from the PO list. Use Start Break for lunch. If you buy materials, scan the receipt with the Receipt button so the office is never the bottleneck. Attach photos of your work to your entries. On bigger jobs, sign the daily JHA in the JHA tab before you start work.','','Y'],
  [4,'PPE — what you wear','read',
   'Every site, every day: CSA-approved footwear and safety glasses. Hard hat and hi-vis whenever the site requires them or equipment is moving. Gloves appropriate to the task. You supply boots; we supply the rest — if anything is missing or worn out, tell Paul before you need it, not after.','','Y'],
  [5,'Electrical safety fundamentals','read',
   'Test before touch, every time. Lockout/tagout before working on circuits — your lock, your key. No energized work unless you are qualified, it is genuinely unavoidable, and the right PPE is on. Treat every conductor as live until YOU have proven it dead. If a task feels beyond your ticket or comfort, stop and call.','','Y'],
  [6,'Ladders, lifts & working at heights','read',
   'Inspect ladders before use; 3-point contact; right ladder for the job (fiberglass around electrical). Above 3 m, fall protection rules apply — if you have not been trained on the equipment on site, say so before going up, and we will sort it.','','Y'],
  [7,'Jobsite conduct & etiquette','read',
   'Show up when you said you would — clock in honestly. Customers: friendly, professional, no pricing talk (send them to Paul). Phones: calls and app use are fine, scrolling on the clock is not. Leave every work area cleaner than you found it. Other trades: coordinate, do not feud.','','Y'],
  [8,'Vehicles & driving','read',
   'Seatbelts always, phone down while driving — no exceptions. Company vehicles come back fueled and tidy. Any ticket or incident in a company vehicle gets reported to Paul the same day.','','Y'],
  [9,'If someone gets hurt — incident reporting','read',
   'Every injury and every near miss gets reported to Paul immediately, no matter how small — a band-aid cut today is how we prevent a hospital trip next month. Know where the first aid kit is on your site. Serious injury: 911 first, Paul second. Nobody gets in trouble for reporting.','','Y'],
  [10,'Daily hazard assessments (JHA)','read',
   'On larger jobs we file a digital JHA every morning from the JHA tab: whoever leads the day starts it, everyone signs before work. It is two minutes, and it is the document that protects you and the company if anything ever happens.','','Y'],
  [11,'Pay, hours & overtime','read',
   'Pay periods are semi-monthly (1st–15th, 16th–end). Overtime after 44 hours in a week, per Alberta standards. Live punches are trusted; manual entries need approval. Questions about your hours: check the Entries tab first, then ask.','','Y'],
  [12,'Welcome video from Paul','video','A short hello and tour of how we work.','','N'],
  [13,'Tool & ladder safety walkthrough','video','Hands-on walkthrough of our most-used gear.','','N'],
];

function obSheet_() {
  var sh = masterSheet_(SHEETS.ONBOARD);
  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1,6).setValues([['Order','Title','Type','Details','Link','Required']]).setFontWeight('bold');
    sh.getRange(2,1,SEED_ONBOARDING.length,6).setValues(SEED_ONBOARDING);
  }
  return sh;
}
function obLogSheet_() {
  var sh = masterSheet_(SHEETS.ONBOARDLOG);
  if (sh.getLastRow() === 0)
    sh.getRange(1,1,1,4).setValues([['Email','Done JSON','Completed At','PDF URL']]).setFontWeight('bold');
  return sh;
}
function obItems_() {
  var sh = obSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2,1,last-1,6).getValues(), out = [];
  rows.forEach(function(r){
    if (!String(r[1]).trim()) return;                       // blank row
    var type = lc_(r[2]) || 'read';
    if (type === 'video' && !String(r[4]).trim()) return;   // video with no link yet — hidden until Paul adds one
    out.push({ id:'ob'+r[0], order:Number(r[0])||999, title:String(r[1]), type:type,
      details:String(r[3]||''), link:String(r[4]||'').trim(), required: lc_(r[5]) !== 'n' });
  });
  out.sort(function(a,b){ return a.order-b.order; });
  return out;
}
function obLogRow_(email) {
  var sh = obLogSheet_(), last = sh.getLastRow();
  if (last > 1) {
    var vals = sh.getRange(2,1,last-1,4).getValues();
    for (var i=0;i<vals.length;i++) if (lc_(vals[i][0]) === lc_(email)) return { sheet:sh, row:i+2, values:vals[i] };
  }
  return null;
}

function onboardingGet_(user) {
  var items = obItems_();
  var loc = obLogRow_(user.email);
  if (!loc) {
    // First open: create their row and self-heal Drive sharing on any linked files so the
    // embedded player just works — no "request access" wall for the new hire.
    obLogSheet_().appendRow([lc_(user.email), '{}', '', '']);
    items.forEach(function(it){
      var m = /drive\.google\.com\/(?:file\/d\/|open\?id=)([-\w]{25,})/.exec(it.link);
      if (m) { try { DriveApp.getFileById(m[1]).addViewer(user.email); } catch(e){} }
    });
    loc = obLogRow_(user.email);
  }
  var done = {}; try { done = JSON.parse(loc.values[1] || '{}'); } catch(e){}
  return { items: items, done: done,
    completedAt: loc.values[2] ? String(loc.values[2]) : '',
    pdfUrl: String(loc.values[3] || '') };
}

function onboardingCheck_(user, p) {
  if (!p.itemId) throw new Error('No item given.');
  if (!obItems_().some(function(it){ return it.id === p.itemId; })) throw new Error('Unknown checklist item — refresh and try again.');
  var loc = obLogRow_(user.email);
  if (!loc) { onboardingGet_(user); loc = obLogRow_(user.email); }
  var done = {}; try { done = JSON.parse(loc.values[1] || '{}'); } catch(e){}
  if (p.done === false) delete done[p.itemId];
  else done[p.itemId] = new Date().toISOString();
  loc.sheet.getRange(loc.row, 2).setValue(JSON.stringify(done));
  return { ok:true, done:done };
}

function onboardingComplete_(user, p) {
  if (!p.sigDataUrl) throw new Error('Draw your signature first.');
  var loc = obLogRow_(user.email);
  if (!loc) throw new Error('Open your onboarding checklist first.');
  if (loc.values[2]) throw new Error('Your onboarding is already complete.');
  var items = obItems_(), done = {};
  try { done = JSON.parse(loc.values[1] || '{}'); } catch(e){}
  var missing = items.filter(function(it){ return it.required && !done[it.id]; });
  if (missing.length) throw new Error('Still to do: ' + missing.map(function(m){ return m.title; }).join(', '));
  // Signature + PDF record, filed under Onboarding Records in the master Drive folder.
  var m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(p.sigDataUrl || ''));
  if (!m) throw new Error('Signature image not readable — try signing again.');
  var master = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
  var it2 = master.getFoldersByName('Onboarding Records');
  var folder = it2.hasNext() ? it2.next() : master.createFolder('Onboarding Records');
  var name = null; try { var rec = getEmployeeRecordCached_(user.email); name = rec && rec.name; } catch(e){}
  name = name || user.email.split('@')[0];
  var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var rowsHtml = items.map(function(it){
    var at = done[it.id] ? new Date(done[it.id]).toLocaleString() : (it.required ? '—' : 'optional, not done');
    return '<tr><td>' + esc(it.title) + '</td><td>' + esc(at) + '</td></tr>';
  }).join('');
  var now = new Date();
  var html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px;text-align:left}' +
    'th{background:#eee}h1{font-size:18px;margin:0}h2{font-size:13px;margin:16px 0 6px}</style></head><body>' +
    '<h1>Employee Onboarding Record</h1>' +
    '<p style="margin:4px 0 14px;color:#444">PRO Electrical Services — new-hire orientation &amp; safety training</p>' +
    '<table><tr><th style="width:25%">Employee</th><td>' + esc(name) + ' (' + esc(user.email) + ')</td></tr>' +
    '<tr><th>Completed</th><td>' + esc(now.toLocaleString()) + '</td></tr></table>' +
    '<h2>Items completed</h2><table><tr><th>Item</th><th>Completed at</th></tr>' + rowsHtml + '</table>' +
    '<h2>Acknowledgement — I completed this orientation, understand the safety practices and expectations above, and agree to work by them</h2>' +
    '<img src="data:image/' + m[1] + ';base64,' + m[2] + '" style="height:56px"><div style="border-top:1px solid #333;max-width:260px;padding-top:3px;font-size:10px"><b>' +
    esc(name) + '</b><br>' + esc(user.email) + '<br>' + esc(now.toLocaleString()) + '</div>' +
    '<p style="color:#777;font-size:9px;margin-top:14px">Filed digitally by the PCW/PRO Timesheet app</p></body></html>';
  var pdf = Utilities.newBlob(html, 'text/html', 'ob.html').getAs('application/pdf')
    .setName('Onboarding — ' + name.replace(/[\\\/:*?"<>|]/g,'-') + ' — ' + fmtDate_(now) + '.pdf');
  var file = folder.createFile(pdf);
  try { file.addViewer(user.email); } catch(e){}
  loc.sheet.getRange(loc.row, 3, 1, 2).setValues([[now.toISOString(), file.getUrl()]]);
  log_(user, 'onboardingComplete', user.email, '', items.length + ' items');
  return { ok:true, pdfUrl: file.getUrl() };
}

function onboardingStatus_(user) {
  if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
    throw new Error('Not allowed.');
  var items = obItems_(), reqIds = items.filter(function(i){ return i.required; }).map(function(i){ return i.id; });
  var emps = [];
  var sh = masterSheet_(SHEETS.EMPLOYEES), last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2,1,last-1,6).getValues().forEach(function(r){
      if (String(r[3]) !== 'true' && r[3] !== true) return;           // inactive
      if (lc_(r[2]) === 'bookkeeper') return;                         // subcontracted — not onboarded
      emps.push({ email: lc_(r[0]), name: String(r[1] || r[0]) });
    });
  }
  var out = emps.map(function(e){
    var loc = obLogRow_(e.email), done = {};
    if (loc) { try { done = JSON.parse(loc.values[1] || '{}'); } catch(err){} }
    return { email: e.email, name: e.name,
      done: reqIds.filter(function(id){ return done[id]; }).length, total: reqIds.length,
      completedAt: loc && loc.values[2] ? String(loc.values[2]) : '',
      pdfUrl: loc ? String(loc.values[3] || '') : '' };
  });
  return { employees: out };
}

// ---------------------------------- Media upload -----------------------------------------------

function uploadMedia_(user, p) {
  // p: { jobSite, filename, mimeType, dataBase64, employeeEmail?, entryId? }
  // Attaching media to ANOTHER employee's entry is an edit of their record — gate it the
  // same way as entry edits (admins pass automatically via requirePerm_).
  if (p.employeeEmail && lc_(p.employeeEmail) !== lc_(user.email)) requirePerm_(user, 'editPastEntries');
  var folder = ensureJobFolder_(p.jobSite || 'Unassigned');
  var bytes = Utilities.base64Decode(p.dataBase64);
  var blob = Utilities.newBlob(bytes, p.mimeType || 'application/octet-stream', p.filename || ('upload-' + newId_()));
  var file = folder.createFile(blob);
  file.setDescription('By ' + user.email + (p.entryId ? (' — entry ' + p.entryId) : ''));
  // Share with the uploader (and the entry's employee, if uploaded on their behalf) so the
  // 📎 links in the app open for them — files live in the admin's Drive ("Execute as me")
  // and are otherwise private.
  try { file.addViewer(user.email); } catch (e) {}
  if (p.employeeEmail && lc_(p.employeeEmail) !== lc_(user.email)) {
    try { file.addViewer(lc_(p.employeeEmail)); } catch (e) {}
  }
  // attach link to the entry's Media cell if provided
  if (p.entryId) {
    var email = (p.employeeEmail || user.email).toLowerCase();
    var loc = findEntryRow_(email, p.entryId);
    if (loc) {
      var existing = loc.values[COL['Media']-1];
      loc.sheet.getRange(loc.row, COL['Media']).setValue(appendNote_(existing, file.getUrl()));
    }
  }
  log_(user, 'uploadMedia', user.email, p.entryId || '', p.filename || '');
  return { url: file.getUrl(), id: file.getId() };
}

function ensureJobFolder_(name) {
  var master = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
  var safe = String(name).replace(/[\\\/:*?"<>|]/g, '-').trim() || 'Unassigned';
  var it = master.getFoldersByName(safe);
  return it.hasNext() ? it.next() : master.createFolder(safe);
}

// ---------------------------------- Employees / admin ------------------------------------------

function listEmployees_(user) {
  if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
    throw new Error('Not allowed.');
  var sh = masterSheet_(SHEETS.EMPLOYEES);
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var vals = sh.getRange(2,1,last-1,6).getValues();
    vals.forEach(function(r){
      if (!r[0]) return;
      out.push({ email: lc_(r[0]), name: r[1], role: r[2], active: r[3] === true || r[3] === 'TRUE' || r[3] === 'true',
        hourlyRate: Number(r[4]) || 0, permissions: safeJson_(r[5]) });
    });
  }
  return { employees: out };
}

function addEmployee_(user, p) {
  requirePerm_(user, 'manageEmployees');
  if (!p.email) throw new Error('Email required.');
  if ((p.role && p.role !== 'employee') || p.permissions) requireAdmin_(user); // only admins mint admins/bookkeepers
  var perms = p.permissions || defaultPermissions_(p.role || 'employee');
  if (p.canChooseCompany) perms.viewAllCompanies = true; // per-hire: may they choose between companies?
  if (p.homeCompany && CONFIG.COMPANIES.some(function(c){ return lc_(c) === lc_(p.homeCompany); }))
    perms.homeCompany = p.homeCompany; // single-company hire: which company they book (e.g. PCW farmhand)
  var rec = upsertEmployee_({ email: lc_(p.email), name: p.name || p.email, role: p.role || 'employee',
    active: true, hourlyRate: Number(p.hourlyRate) || 0,
    permissions: perms });
  getEmployeeSheet_(rec.email, true); // create their tab now
  // Email invite with setup instructions (frontend sends its own URL as p.appUrl, so
  // nothing needs configuring here). Sent from the script owner's account; replies go
  // to the admin who added them. Never blocks the add if mail fails — logged instead.
  var invited = false;
  if (p.sendInvite !== false) {
    try {
      var url = String(p.appUrl || '').trim();
      var isBk = rec.role === 'bookkeeper';
      var body = 'Hi ' + (rec.name || '') + ',\n\n' +
        'You\'ve been added to the PCW / PRO Timesheet' + (isBk ? ' as the bookkeeper' : '') + '.\n\n' +
        'Getting set up takes 2 minutes:\n' +
        '  1. On your phone, open this link in Chrome:\n     ' + (url || '(ask ' + user.email + ' for the app link)') + '\n' +
        '  2. Sign in with your Google account — this email address (' + rec.email + ').\n' +
        '  3. In Chrome\'s menu (three dots), tap "Add to Home screen" so it opens like an app.\n\n' +
        (isBk ? 'You\'ll be able to view everyone\'s hours for payroll under the Team and Hours tabs.\n\n'
              : 'Tap Clock In when you start work and Clock Out when you\'re done — your hours go straight to payroll.\n\n') +
        'Questions? Just reply to this email.\n\n— ' + (user.name || user.email);
      MailApp.sendEmail(rec.email, 'Welcome to the PCW / PRO Timesheet', body, { replyTo: user.email });
      invited = true;
      log_(user, 'inviteEmailed', rec.email, '', '');
    } catch (e) { log_(user, 'inviteEmailFailed', rec.email, '', e.message); }
  }
  log_(user, 'addEmployee', p.email, '', p.role || 'employee');
  refreshMaster_();
  return { employee: rec, invited: invited };
}

function updateEmployee_(user, p) {
  requirePerm_(user, 'manageEmployees');
  // manageEmployees alone must NOT be a path to power: role/permission changes are admin-only,
  // and rate changes need the setRates permission (admins pass both automatically).
  if (p.role !== undefined || p.permissions) requireAdmin_(user);
  if (p.hourlyRate !== undefined) requirePerm_(user, 'setRates');
  var rec = getEmployeeRecord_(lc_(p.email));
  if (!rec) throw new Error('Employee not found.');
  ['name','role','active','hourlyRate'].forEach(function(f){ if (p[f] !== undefined) rec[f] = p[f]; });
  if (p.permissions) rec.permissions = p.permissions;
  upsertEmployee_(rec);
  log_(user, 'updateEmployee', p.email, '', '');
  refreshMaster_();
  return { employee: rec };
}

/* Hard delete or reset — for wrongly-added accounts and fresh starts. Deactivate (below)
 * stays the default because it PRESERVES history; these two destroy it, so they're admin-only
 * with guardrails: never yourself, never an admin account (demote first). */
function deleteEmployee_(user, p) {
  requireAdmin_(user);
  var email = lc_(p.email);
  if (!email) throw new Error('No employee given.');
  if (email === lc_(user.email)) throw new Error("You can't delete your own account.");
  var rec = getEmployeeRecord_(email);
  if (!rec) throw new Error('Employee not found.');
  if (rec.role === 'admin') throw new Error("Admins can't be deleted directly — change their role to employee first.");
  var mode = p.mode === 'reset' ? 'reset' : 'delete';
  var ss = masterSs_();
  var tab = getEmployeeSheet_(email, false);
  if (tab) ss.deleteSheet(tab); // their entire hours history — gone
  var ol = obLogRow_(email);    // onboarding progress — gone (a reset re-onboards them)
  if (ol) ol.sheet.deleteRow(ol.row);
  if (mode === 'delete') {
    var sh = masterSheet_(SHEETS.EMPLOYEES), last = sh.getLastRow();
    if (last > 1) {
      var vals = sh.getRange(2,1,last-1,1).getValues();
      for (var i = vals.length-1; i >= 0; i--) if (lc_(vals[i][0]) === email) sh.deleteRow(i+2);
    }
  }
  // Their pending time-off requests would otherwise sit in the approval queue forever.
  var tsh = toSheet_(), tlast = tsh.getLastRow();
  if (tlast > 1) {
    var tvals = tsh.getRange(2, 1, tlast-1, 6).getValues();
    for (var k = 0; k < tvals.length; k++)
      if (lc_(tvals[k][1]) === email && tvals[k][5] === 'pending') tsh.getRange(k+2, 6).setValue('cancelled');
  }
  try { CacheService.getScriptCache().remove('emp_' + email); } catch (e) {} // kill their live session promptly
  refreshMaster_();
  log_(user, mode === 'delete' ? 'deleteEmployee' : 'resetEmployee', email, '', tab ? 'entries tab deleted' : 'no entries tab');
  return { ok: true, mode: mode };
}

function removeEmployee_(user, p) {
  requirePerm_(user, 'manageEmployees');
  var rec = getEmployeeRecord_(lc_(p.email));
  if (!rec) throw new Error('Employee not found.');
  rec.active = false; // soft-remove: keep their tab + history intact
  upsertEmployee_(rec);
  log_(user, 'removeEmployee', p.email, '', 'deactivated');
  refreshMaster_();
  return { ok: true };
}

function setPermissions_(user, p) {
  requireAdmin_(user); // granting permissions IS granting power — admin only
  var rec = getEmployeeRecord_(lc_(p.email));
  if (!rec) throw new Error('Employee not found.');
  rec.permissions = p.permissions || rec.permissions;
  upsertEmployee_(rec);
  log_(user, 'setPermissions', p.email, '', '');
  return { employee: rec };
}

function setHourlyRate_(user, p) {
  requirePerm_(user, 'setRates');
  var rec = getEmployeeRecord_(lc_(p.email));
  if (!rec) throw new Error('Employee not found.');
  rec.hourlyRate = Number(p.hourlyRate) || 0;
  upsertEmployee_(rec);
  log_(user, 'setHourlyRate', p.email, '', String(rec.hourlyRate));
  refreshMaster_();
  return { employee: rec };
}

function pendingApprovals_(user) {
  requirePerm_(user, 'approveHours');
  var emps = listEmployees_(user).employees;
  var pending = [];
  emps.forEach(function(emp){
    // Wide window (a year) so an old pending manual entry can't silently fall out of the
    // approvals list while still sitting 'pending' in the sheet. Still capped at the last
    // 400 rows per tab by listEntries_, so the cost stays bounded.
    var res = listEntries_(user, { email: emp.email, days: 366 }).entries;
    res.forEach(function(e){ if (e.Status === 'pending') { e._employee = emp.email; e._name = emp.name; pending.push(e); } });
  });
  // v74 - and what was changed on each of them, so approving is not done on trust. One read for
  // the whole list, whatever its length.
  if (pending.length) {
    var edits = editLogLatest_();
    pending.forEach(function (e) {
      var rec = edits[String(e.EntryID)];
      if (rec) e._edit = { at: rec.at, by: rec.by, reason: rec.reason, changes: rec.changes };
    });
  }
  return { pending: pending };
}

function activityLog_(user, p) {
  requireAdmin_(user);
  var sh = masterSheet_(SHEETS.LOG);
  var last = sh.getLastRow();
  var n = Math.min(p.limit || 200, last-1);
  if (n <= 0) return { log: [] };
  var vals = sh.getRange(last-n+1, 1, n, 6).getValues();
  return { log: vals.map(function(r){ return { time: r[0], actor: r[1], action: r[2], target: r[3], entryId: r[4], detail: r[5] }; }).reverse() };
}

// ---------------------------------- Hours overview (in-app, no CSV needed) ---------------------

// p: { month: 'YYYY-MM' } (defaults to the current month). Admin + bookkeeper.
// One row per ACTIVE employee (bookkeepers excluded — subcontracted, not on payroll):
// approved + pending hours for that month and estimated pay at their current rate.
function hoursOverview_(user, p) {
  if (user.role !== 'admin' && !(user.permissions && user.permissions.viewAllEmployees))
    throw new Error('Not allowed.');
  var m = String(p.month || '').match(/^(\d{4})-(\d{2})$/);
  var now = new Date();
  var y  = m ? Number(m[1]) : now.getFullYear();
  var mo = m ? Number(m[2]) - 1 : now.getMonth();
  var start = new Date(y, mo, 1), end = new Date(y, mo + 1, 1);
  var days = Math.max(1, Math.ceil((Date.now() - start.getTime()) / 86400000) + 1);
  var emps = listEmployees_(user).employees.filter(function(e){ return e.active && e.role !== 'bookkeeper'; });
  var rows = emps.map(function(emp){
    var entries = listEntries_(user, { email: emp.email, days: days, maxRows: 20000 }).entries;
    var inMonth = entries.filter(function(e){ var t=new Date(e.ClockIn||e.Date); return !isNaN(t)&&t>=start&&t<end; });
    var approvedR = weeklyRounded_(inMonth, function(e){ return e.Status==='approved'&&e.Hours; });
    var pendingR  = weeklyRounded_(inMonth, function(e){ return e.Status==='pending'&&e.Hours; });
    return { email: emp.email, name: emp.name, rate: Number(emp.hourlyRate) || 0,
      approved: approvedR, pending: pendingR,
      estPay: Math.round(approvedR * (Number(emp.hourlyRate) || 0) * 100) / 100 };
  });
  var totals = { approved: 0, pending: 0, estPay: 0 };
  rows.forEach(function(r){ totals.approved += r.approved; totals.pending += r.pending; totals.estPay += r.estPay; });
  totals.approved = Math.round(totals.approved * 100) / 100;
  totals.pending  = Math.round(totals.pending  * 100) / 100;
  totals.estPay   = Math.round(totals.estPay   * 100) / 100;
  return { month: y + '-' + pad2_(mo + 1), rows: rows, totals: totals };
}

// ---------------------------------- Payroll export --------------------------------------------

function exportPayroll_(user, p) {
  requirePerm_(user, 'exportPayroll');
  var period = p.periodKey || periodKey_(new Date());
  var emps = listEmployees_(user).employees;
  var rows = [['Employee','Email','Role','Rate','Period','Regular Hrs','OT Hrs','Total Hrs (wk-rounded ¼h up)','Est. Pay','Allowances','Approved Only']];
  emps.forEach(function(emp){
    if (emp.role === 'bookkeeper') return; // subcontracted — not on payroll
    // days:400 + full row read: the default 60-day/400-row window silently zeroed out any
    // export of a period older than ~2 months — wrong payroll numbers with no error.
    var all = listEntries_(user, { email: emp.email, days: 400, maxRows: 20000 }).entries;
    // Weekly totals rounded UP to the quarter hour (3.5), then summed for the period.
    var total = weeklyRounded_(all, function(e){ return e.PeriodKey === period && e.Status === 'approved' && e.Hours; });
    var reg = total, ot = 0; // per-entry OT is flagged separately; export keeps total for reconciliation
    var pay = Math.round(total * (Number(emp.hourlyRate)||0) * 100) / 100;
    var allow = allowanceTotal_(emp.email, period);
    rows.push([emp.name, emp.email, emp.role, emp.hourlyRate, period, reg, ot, total, pay, allow, 'yes']);
  });
  var csv = rows.map(function(r){ return r.map(csvCell_).join(','); }).join('\n');
  return { csv: csv, period: period };
}

// ---------------------------------- Summaries --------------------------------------------------

function refreshSummaries_(userLike) {
  try { writeTabSummary_((userLike.email||'').toLowerCase()); } catch(e){}
  // Master Summary rebuild reads EVERY employee tab — too expensive to run on each clock
  // in/out. Throttle to at most once per 5 minutes; the sheet is a dashboard, not a ledger
  // (payroll export always recomputes from the tabs directly, so it is never stale).
  try {
    var cache = CacheService.getScriptCache();
    if (!cache.get('masterFresh')) { refreshMaster_(); cache.put('masterFresh', '1', 300); }
  } catch (e) { refreshMaster_(); }
}

function writeTabSummary_(email) {
  var sh = getEmployeeSheet_(email, false);
  if (!sh) return;
  var cur = periodKey_(new Date());
  // The summary block only changes when the pay period rolls over (the formulas are live) —
  // skip the ~8 write ops on every clock in/out otherwise. Shaves ~0.5s off each mutation.
  try {
    if (CacheService.getScriptCache().get('sum_' + email) === cur) return;
  } catch (e) {}
  var prev = prevPeriodKey_(new Date());
  // Summary block in rows 2..5 referencing the PeriodKey + Hours columns of the entries table (live formulas).
  var pkCol = a1Col_(COL['PeriodKey']);
  var hrCol = a1Col_(COL['Hours']);
  var stCol = a1Col_(COL['Status']);
  var dataStart = ENTRY_HEADER_ROW + 1;
  var rng = pkCol + dataStart + ':' + pkCol + 100000;
  var hrRng = hrCol + dataStart + ':' + hrCol + 100000;
  var stRng = stCol + dataStart + ':' + stCol + 100000;
  sh.getRange('A2').setValue('Current period ('+cur+')');
  sh.getRange('B2').setFormula('=SUMIFS('+hrRng+','+rng+',"'+cur+'",'+stRng+',"approved")');
  sh.getRange('A3').setValue('Previous period ('+prev+')');
  sh.getRange('B3').setFormula('=SUMIFS('+hrRng+','+rng+',"'+prev+'",'+stRng+',"approved")');
  sh.getRange('A4').setValue('Pending (this period)');
  sh.getRange('B4').setFormula('=SUMIFS('+hrRng+','+rng+',"'+cur+'",'+stRng+',"pending")');
  sh.getRange('A5').setValue('OT weekly threshold');
  sh.getRange('B5').setValue(CONFIG.OT_WEEKLY_THRESHOLD);
  try { CacheService.getScriptCache().put('sum_' + email, cur, 21600); } catch (e) {}
}

function refreshMaster_() {
  var sh = masterSheet_(SHEETS.MASTER);
  sh.clearContents();
  var cur = periodKey_(new Date());
  sh.getRange(1,1,1,6).setValues([['Employee','Email','Role','Rate','Current Period ('+cur+') Approved Hrs','Est. Pay']]);
  var emps = listEmployees_({ role:'admin', permissions: defaultPermissions_('admin') }).employees;
  var out = [];
  emps.forEach(function(emp){
    if (!emp.active || emp.role === 'bookkeeper') return; // bookkeeper is subcontracted, not payroll
    var entries = listEntries_({ role:'admin', email:'system', permissions:defaultPermissions_('admin') }, { email: emp.email }).entries;
    var total = 0;
    entries.forEach(function(e){ if (e.PeriodKey === cur && e.Status === 'approved') total += Number(e.Hours)||0; });
    var pay = Math.round(total * (Number(emp.hourlyRate)||0) * 100)/100;
    out.push([emp.name, emp.email, emp.role, emp.hourlyRate, total, pay]);
  });
  if (out.length) sh.getRange(2,1,out.length,6).setValues(out);
}

// ---------------------------------- Employee registry helpers ----------------------------------

// Cached read of the employee record for per-request auth. Reading the Employees sheet added
// ~300-500ms to EVERY api call; role/permission changes now take ≤2 min to propagate (fine).
// upsertEmployee_ invalidates the cache, so edits made through the app apply immediately.
function getEmployeeRecordCached_(email) {
  var key = 'emp_' + lc_(email);
  try {
    var hit = CacheService.getScriptCache().get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  var rec = getEmployeeRecord_(email);
  try { if (rec) CacheService.getScriptCache().put(key, JSON.stringify(rec), 120); } catch (e) {}
  return rec;
}

function getEmployeeRecord_(email) {
  var sh = masterSheet_(SHEETS.EMPLOYEES);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2,1,last-1,6).getValues();
  for (var i=0;i<vals.length;i++){
    if (lc_(vals[i][0]) === lc_(email)) {
      var role = vals[i][2] || 'employee';
      return { row: i+2, email: lc_(vals[i][0]), name: vals[i][1], role: role,
        active: (vals[i][3]===true||String(vals[i][3]).toLowerCase()==='true'),
        hourlyRate: Number(vals[i][4])||0, permissions: safeJson_(vals[i][5]) || defaultPermissions_(role) };
    }
  }
  return null;
}

function upsertEmployee_(rec) {
  var sh = masterSheet_(SHEETS.EMPLOYEES);
  if (!rec.permissions) rec.permissions = defaultPermissions_(rec.role);
  var existing = getEmployeeRecord_(rec.email);
  var rowVals = [lc_(rec.email), txt_(rec.name || rec.email), rec.role || 'employee',
    rec.active !== false, Number(rec.hourlyRate)||0, JSON.stringify(rec.permissions)];
  if (existing) sh.getRange(existing.row,1,1,6).setValues([rowVals]);
  else sh.appendRow(rowVals);
  try { CacheService.getScriptCache().remove('emp_' + lc_(rec.email)); } catch (e) {}
  return getEmployeeRecord_(rec.email);
}

// ---------------------------------- Sheet plumbing ---------------------------------------------

/* v54 - OPEN THE WORKBOOK ONCE.
 * openById and getSheetByName were called afresh every time any code wanted a tab, and there are
 * 25 call sites - log_ alone calls one on every action. Within a single execution the workbook
 * cannot change identity and a tab cannot change name, so both are now looked up once and kept.
 * Nothing about the behaviour changes; it is the same object either way. */
var MASTER_SS_ = null, MASTER_TABS_ = null;
function masterSs_() {
  if (MASTER_SS_) return MASTER_SS_;
  if (!CONFIG.MASTER_SPREADSHEET_ID) throw new Error('MASTER_SPREADSHEET_ID not set. Run initializeSpreadsheet().');
  MASTER_SS_ = SpreadsheetApp.openById(CONFIG.MASTER_SPREADSHEET_ID);
  return MASTER_SS_;
}
function masterSheet_(name) {
  if (!MASTER_TABS_) MASTER_TABS_ = {};
  if (MASTER_TABS_[name]) return MASTER_TABS_[name];
  var ss = masterSs_();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  MASTER_TABS_[name] = sh;
  return sh;
}
function tabNameForEmail_(email) {
  // Human-friendly tab name from the employee's stored name if available, else email local-part.
  var rec = null;
  try { rec = getEmployeeRecord_(email); } catch(e){}
  var base = (rec && rec.name) ? rec.name : email.split('@')[0];
  return base.substring(0, 90).replace(/[\[\]\*\/\\\?:]/g,' ').trim() || email;
}
function getEmployeeSheet_(email, createIfMissing) {
  var ss = masterSs_();
  // We store the tab name in the Employees row? For robustness we search by an EntryID convention:
  // tabs are named by display name; find via a hidden note on A1 that stores the email.
  var sheets = ss.getSheets();
  for (var i=0;i<sheets.length;i++){
    var note = sheets[i].getRange('A1').getNote();
    if (note && note.indexOf('email:'+email) === 0) return sheets[i];
  }
  if (!createIfMissing) return null;
  var name = uniqueSheetName_(ss, tabNameForEmail_(email));
  var sh = ss.insertSheet(name);
  sh.getRange('A1').setValue(tabNameForEmail_(email)).setFontWeight('bold').setFontSize(14);
  sh.getRange('A1').setNote('email:'+email); // stable identity, survives rename/reorder
  sh.getRange(ENTRY_HEADER_ROW,1,1,ENTRY_HEADERS.length).setValues([ENTRY_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(ENTRY_HEADER_ROW);
  writeTabSummary_(email);
  return sh;
}
function uniqueSheetName_(ss, base) {
  var name = base, n = 2;
  while (ss.getSheetByName(name)) { name = base + ' (' + n + ')'; n++; }
  return name;
}

function appendEntry_(user, entry) {
  var sh = getEmployeeSheet_(user.email, true);
  var row = ENTRY_HEADERS.map(function(h){ return entry[h] !== undefined ? txt_(entry[h]) : ''; });
  sh.appendRow(row);
}
function findEntryRow_(email, entryId) {
  var sh = getEmployeeSheet_(email, false);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last <= ENTRY_HEADER_ROW) return null;
  var ids = sh.getRange(ENTRY_HEADER_ROW+1, COL['EntryID'], last-ENTRY_HEADER_ROW, 1).getValues();
  for (var i=0;i<ids.length;i++){
    if (String(ids[i][0]) === String(entryId)) { // String(): Sheets converts digit-only IDs to numbers
      var r = ENTRY_HEADER_ROW+1+i;
      return { sheet: sh, row: r, values: sh.getRange(r,1,1,ENTRY_HEADERS.length).getValues()[0] };
    }
  }
  return null;
}
// v30 — the entry a given tap created, if it exists (ClockIn is stamped with the phone's tap
// time to the millisecond, so a match within a second is the same tap). Scans from the bottom:
// a replay is always about a recent entry.
function findEntryByClockIn_(email, at) {
  var t = new Date(at); if (isNaN(t)) return null;
  var sh = getEmployeeSheet_(email, false);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last <= ENTRY_HEADER_ROW) return null;
  var n = Math.min(60, last - ENTRY_HEADER_ROW);
  var vals = sh.getRange(last - n + 1, 1, n, ENTRY_HEADERS.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (vals[i][COL['ClockIn']-1] && sameInstant_(vals[i][COL['ClockIn']-1], t)) return rowToEntry_(vals[i]);
  }
  return null;
}
function sameInstant_(a, b) {
  var ta = (a instanceof Date) ? a.getTime() : new Date(a).getTime();
  var tb = (b instanceof Date) ? b.getTime() : new Date(b).getTime();
  return !isNaN(ta) && !isNaN(tb) && Math.abs(ta - tb) < 1500;
}
function findOpenEntry_(email) {
  var sh = getEmployeeSheet_(email, false);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last <= ENTRY_HEADER_ROW) return null;
  var vals = sh.getRange(ENTRY_HEADER_ROW+1,1,last-ENTRY_HEADER_ROW,ENTRY_HEADERS.length).getValues();
  for (var i=vals.length-1;i>=0;i--){
    if (vals[i][COL['ClockIn']-1] && !vals[i][COL['ClockOut']-1] && vals[i][COL['Source']-1] === 'live' && vals[i][COL['Status']-1] !== 'deleted')   // v97
      return rowToEntry_(vals[i]);
  }
  return null;
}
function rowToEntry_(r) {
  var e = {}; ENTRY_HEADERS.forEach(function(h,i){ e[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
  return e;
}

// ---------------------------------- Activity log ----------------------------------------------
/* ================= MATERIALS: COMPANY INVENTORY, PRICING, JOB USAGE ==========================
 * The model (Paul, Sept 2026 — replaces the earlier per-job inventory):
 *   ONE company inventory lives in the Materials Price List spreadsheet, keyed by OUR OWN
 *   in-house SKU (BRK-004, WIRE-012 …) because suppliers change their part numbers and we don't.
 *   • Scanning a supplier PO ADDS the items to inventory at their purchase price, records the
 *     purchase against the job it was bought for ("Job POs" tab), and files the PDF in the job's
 *     Drive folder. Newest price always wins.
 *   • Taking material onto a job SUBTRACTS from inventory and writes a "Job usage" row. Material
 *     pulled from stock with no PO behind it works identically — that is the whole point.
 *   • Invoicing charges the USED quantity only; whatever was bought and not used simply stays in
 *     inventory, because it was never taken out.
 *   • Returning to a supplier does NOT move inventory on its own — the credit note PO does, when
 *     it is scanned or swept from the inbox. Otherwise the same return would be counted twice.
 *   • v29 — a QUOTE / estimate updates the PRICE LIST the same way an invoice does (newest price
 *     wins, whichever kind of document it came from; "Price source" says which) but is NOT a
 *     purchase: nothing goes into inventory and nothing is written to Job POs. Every quote line
 *     is logged on Price history with Type = Quote and counts toward Lowest / Best price.
 * A daily ~12:00 trigger (setupDailySweep) reads supplier invoice AND quote emails into the same
 * pipeline; the app's one "Scan receipt / estimate" button feeds it too (scanSupplierDoc_).
 * =========================================================================================== */

// "Materials" tab — the inventory + pricing master (1-based column numbers).
// v29 inserted "Price source" right after Price (see plMigrate_), so everything from
// "Last bought from" onward moved one column to the right. Header NAMES are unchanged on
// purpose: the Feed Calculator price feed finds its columns by header text.
var M_SKU=1, M_DESC=2, M_UNIT=3, M_INV=4, M_PRICE=5, M_SRC=6, M_SUP=7, M_DATE=8,
    M_LO=9, M_LOSUP=10, M_HI=11, M_HISUP=12, M_PARTS=13, M_CHECK=14, M_COLS=14;
var MAT_TAB='Materials', POS_TAB='Job POs', USE_TAB='Job usage', HIST_TAB='Price history',
    BEST_TAB='Best price', SWEEP_TAB='Sweep log';
var POS_HEADERS=['ID','Date','Job site','PO#','Supplier','Invoice #','SKU (ours)','Description',
  'Qty bought','Unit price','Added by','Document'];
var USE_HEADERS=['ID','Date','Job site','PO#','SKU (ours)','Description','Qty used','Unit price',
  'Taken by','Status'];
// Price history: one row per line of every invoice, receipt, credit note AND quote (v29).
// 'Type' is Invoice / Receipt / Quote; a credit note is an Invoice row with Credit note? = yes.
var HIST_HEADERS=['SKU (ours)','Supplier','Their part #','Description','Purchase date',
  'Unit price','Invoice #','Qty','Credit note?','Type'];
var H_SKU=1, H_SUP=2, H_PART=3, H_DESC=4, H_DATE=5, H_PRICE=6, H_DOC=7, H_QTY=8, H_CREDIT=9, H_TYPE=10, H_COLS=10;
var BEST_HEADERS=['SKU (ours)','Description','Buy it from','Their price','Every supplier we have used',
  'Most expensive','You save'];

// Who may see dollar figures (supplier costs, the price list): admins + the bookkeeper.
// Crew pick materials and enter quantities without ever seeing a price (Charles, Sept 2026).
function canSeePrices_(user){ return user && (user.role === 'admin' || user.role === 'bookkeeper'); }

function plSs_(){ return SpreadsheetApp.openById(CONFIG.PRICELIST_SPREADSHEET_ID); }
function plTab_(name, headers) {
  var ss = plSs_(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); if (headers) sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold'); }
  if (headers && sh.getLastRow() === 0) sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
  return sh;
}
function matTab_(){ plMigrate_(); return plTab_(MAT_TAB); }
function matRows_() {
  var sh = matTab_(), last = sh.getLastRow();
  if (last < 2) return { sheet: sh, rows: [] };
  return { sheet: sh, rows: sh.getRange(2,1,last-1,M_COLS).getValues() };
}
function histTab_(){ plMigrate_(); return plTab_(HIST_TAB, HIST_HEADERS); }

/* ---- v29 one-time layout migration, run lazily (once per execution) by the first price-list
 * read. Idempotent: it looks at the header cells and only changes what is missing.
 *   Materials:     inserts "Price source" after "Price" and backfills it from Price history
 *                  ("Invoice 14494442" where the SKU/supplier/date line up, else blank).
 *   Price history: adds the "Type" column and backfills "Invoice" on every existing row.
 * Sheets shifts formulas and the Best price tab's values are plain numbers, so nothing else
 * needs touching. ------------------------------------------------------------------------ */
var plMigrated_ = false;
function plMigrate_() {
  plResolveCols_();              // v50 - read the Materials columns off its real header row first
  if (plMigrated_) return;
  // Header check happens INSIDE the lock — two first requests must not both insert the column.
  // Nothing is swallowed: if the layout cannot be brought to v29, the request FAILS rather than
  // writing 14-column rows into a 13-column sheet.
  withLock_(plMigrateLocked_);
  plMigrated_ = true;
}
function plMigrateLocked_() {
  try {
    var ss = plSs_(), mat = ss.getSheetByName(MAT_TAB);
    if (mat && mat.getLastColumn() >= 5) {
      var hdr = mat.getRange(1, 1, 1, Math.max(mat.getLastColumn(), 6)).getValues()[0];
      if (lc_(hdr[M_SRC-1]) !== 'price source') {
        // Only ever insert into the layout we expect — an insert is irreversible.
        if (lc_(hdr[M_PRICE-1]) !== 'price' || lc_(hdr[M_SRC-1]) !== 'last bought from')
          throw new Error('Materials tab header is not the expected layout (E1 "Price", F1 "Last bought from") — not migrating.');
        mat.insertColumnAfter(M_PRICE);
        mat.getRange(1, M_SRC).setValue('Price source').setFontWeight('bold');
        mat.setColumnWidth(M_SRC, 150);
        var last = mat.getLastRow();
        if (last >= 2) {
          // Backfill from the history: same SKU + supplier + date → that document's number.
          var hist = ss.getSheetByName(HIST_TAB), byKey = {};
          if (hist && hist.getLastRow() >= 2) {
            hist.getRange(2, 1, hist.getLastRow()-1, 9).getValues().forEach(function(h){
              var k = lc_(h[H_SKU-1]) + '|' + lc_(h[H_SUP-1]) + '|' + dstr_(h[H_DATE-1]);
              if (!byKey[k] && h[H_DOC-1] !== '') byKey[k] = String(h[H_DOC-1]);
            });
          }
          var rows = mat.getRange(2, 1, last-1, M_DATE).getValues();
          var src = rows.map(function(r){
            var k = lc_(r[M_SKU-1]) + '|' + lc_(r[M_SUP-1]) + '|' + dstr_(r[M_DATE-1]);
            return [byKey[k] ? ('Invoice ' + byKey[k]) : ''];
          });
          mat.getRange(2, M_SRC, src.length, 1).setValues(src);
        }
        try { CacheService.getScriptCache().remove('materials_v3'); } catch (e) {}
      }
    }
    var hist2 = ss.getSheetByName(HIST_TAB);
    if (hist2 && hist2.getLastRow() >= 1) {
      if (hist2.getMaxColumns() < H_TYPE) hist2.insertColumnsAfter(hist2.getMaxColumns(), H_TYPE - hist2.getMaxColumns()); // a 9-column grid cannot take column 10
      var th = hist2.getRange(1, 1, 1, Math.max(hist2.getLastColumn(), H_TYPE)).getValues()[0];
      if (lc_(th[H_TYPE-1]) !== 'type') {
        if (String(th[H_TYPE-1] || '') !== '') throw new Error('Price history column J already holds "' + th[H_TYPE-1] + '" — expected it empty for the Type column; not migrating.');
        hist2.getRange(1, H_TYPE).setValue('Type').setFontWeight('bold');
        var n = hist2.getLastRow() - 1;
        if (n > 0) {
          var types = hist2.getRange(2, H_TYPE, n, 1).getValues().map(function(v){ return [v[0] === '' ? 'Invoice' : v[0]]; });
          hist2.getRange(2, H_TYPE, n, 1).setValues(types);
        }
      }
    }
    // Verify before anyone writes. v50 - the header no longer has to read exactly
    // "Price source": it only has to be FINDABLE. A column nobody can identify still refuses
    // the write, because writing a price into an unknown column is worse than not writing it.
    if (mat && mat.getLastRow() >= 1) {
      var vh = mat.getRange(1, 1, 1, Math.max(1, mat.getLastColumn())).getValues()[0];
      if (!hdrResolve_(vh, MAT_FIELDS_.M_SRC) && lc_(mat.getRange(1, M_SRC).getValue()) !== 'price source')
        throw new Error('The Materials tab has no column that reads like "Price source" — refusing to write. ' +
                        'Run checkHeaders() to see what the script can and cannot find.');
    }
  } catch (e) { plMigrated_ = false; throw e; }   // the request fails loudly; nothing half-migrated is written to
}

/* ---- dates ------------------------------------------------------------------------------
 * Sheets turns a "2026-09-10" string into a real Date the moment setValues() writes it, so a
 * cell read back is sometimes a Date and sometimes text. Every comparison goes through dstr_
 * — String(Date) starts with the weekday name, and "2026-09-10" >= "Wed Jan 07 2026 …" was
 * false, which is why a newer purchase silently failed to replace an older price. */
function dstr_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : fmtDate_(v);
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : fmtDate_(d);
}
function ymd_(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  var dt = new Date(y, m-1, d);
  if (dt.getMonth() !== m-1 || dt.getDate() !== d) return '';   // Feb 30 etc.
  return fmtDate_(dt);
}
/* Is this date one we would believe on a document that reached us on `anchor`? Not more than
 * DATE_MAX_AGE_DAYS old, and not after tomorrow (time-zone slop). */
function datePlausible_(iso, anchor) {
  if (!iso) return false;
  var d = new Date(iso + 'T12:00:00'), a = anchor ? new Date(anchor) : new Date();
  if (isNaN(d.getTime())) return false;
  var diff = (a.getTime() - d.getTime()) / 86400000;      // days before the anchor
  return diff <= (CONFIG.DATE_MAX_AGE_DAYS || 365) && diff >= -1.5;
}
/* Resolve the date on a supplier document.
 *   printed  – the date exactly as the AI saw it on the page ("09/10/26", "Sep 10, 2026")
 *   iso      – the AI's own reading of it (YYYY-MM-DD), used as a fallback
 *   supplier – canonical supplier name → CONFIG.SUPPLIER_DATE_FORMAT
 *   anchor   – when the document reached us (email date, or now for a phone scan)
 * Returns { date, flag }. date is '' when nothing plausible could be read; flag says why the
 * caller must ask a person instead of saving. */
function parseDocDate_(printed, iso, supplier, anchor) {
  var p = String(printed || '').trim(), fmt = (CONFIG.SUPPLIER_DATE_FORMAT || {})[supplier] || '';
  var cands = [];                                   // [{iso, why}] in preference order
  var m;
  if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(p))) {                  // 2026-09-10
    cands.push({ iso: ymd_(+m[1], +m[2], +m[3]), why: 'year first' });
  } else if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(p))) {           // 09/10/2026 or 10/09/2026
    var a = +m[1], b = +m[2], y = +m[3];
    var mdy = { iso: ymd_(y, a, b), why: 'month first' }, dmy = { iso: ymd_(y, b, a), why: 'day first' };
    cands = fmt === 'DMY' ? [dmy, mdy] : [mdy, dmy];
  } else if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2})(?!\d)/.exec(p))) {     // 09/10/26 — the ambiguous one (a trailing time is ignored)
    var x = +m[1], z = +m[2], w = +m[3];
    var opts = {
      MDY: { iso: ymd_(2000 + w, x, z), why: 'month first' },
      DMY: { iso: ymd_(2000 + w, z, x), why: 'day first' },
      YMD: { iso: ymd_(2000 + x, z, w), why: 'year first' }
    };
    var order = fmt === 'DMY' ? ['DMY', 'MDY', 'YMD'] : fmt === 'MDY' ? ['MDY', 'DMY', 'YMD'] : ['MDY', 'DMY', 'YMD'];
    order.forEach(function(k){ cands.push(opts[k]); });
  } else if (p) {                                                                  // "Sep 10, 2026", "10 Sep 2026"
    var d = new Date(p.replace(/(\d+)(st|nd|rd|th)/g, '$1'));
    if (!isNaN(d.getTime())) cands.push({ iso: fmtDate_(d), why: 'as printed' });
  }
  var isoClean = dstr_(iso);
  if (isoClean) cands.push({ iso: isoClean, why: 'AI reading' });
  cands = cands.filter(function(c){ return c.iso; });
  // The supplier's known format wins when it is plausible; otherwise the plausible reading
  // that lands closest to the day the document reached us; otherwise nothing.
  if (fmt && cands.length && datePlausible_(cands[0].iso, anchor)) return { date: cands[0].iso, flag: '' };
  var best = null, bestGap = Infinity, aT = (anchor ? new Date(anchor) : new Date()).getTime();
  cands.forEach(function(c){
    if (!datePlausible_(c.iso, anchor)) return;
    var gap = Math.abs(aT - new Date(c.iso + 'T12:00:00').getTime());
    if (gap < bestGap) { bestGap = gap; best = c; }
  });
  if (best) return { date: best.iso, flag: '' };
  var seen = cands.length ? cands[0].iso : (p || isoClean || '');
  return { date: '', flag: 'The date on this document reads "' + (p || isoClean || '?') + '"' +
    (seen ? ' (' + seen + ')' : '') + ' — more than a year old or in the future. Check it before saving.' };
}

/* ---- in-house SKU: category prefix + running number, matching the sheet Claude built ---- */
var SKU_CATS = [
  ['RCPT',  /receptacle|outlet\b|tamper.?resist|\bgfci\b|\bplug\b/],
  ['SWCH',  /\bswitch\b|dimmer|\b[34].?way\b|occupancy sensor|photocell/],
  ['BRK',   /breaker|\bafci\b/],
  ['PNL',   /loadcent|panelboard|\bpanel\b|meter (base|socket)|disconnect|transformer/],
  ['LIGHT', /\blamp\b|bulb|\bled\b|luminaire|fixture|wall ?pack|pot ?light|downlight|troffer|ballast|driver\b/],
  ['WIRE',  /nmd90|rw90|\bteck\b|acwu|rwu90|nmwu|romex|thhn|conductor|\bcable\b|\bwire\b/],
  ['CONDT', /\bemt\b|conduit|liquid.?tight|\bflex\b|\bbx\b/],
  ['CONN',  /connector|coupling|coupler|fitting|adapt(er|or)|bushing|locknut|nipple|elbow/],
  ['BOX',   /\bbox\b|enclosure|handy|octagon|junction|\bring\b/],
  ['COVER', /cover|\bplate\b|faceplate|blank\b/],
  ['STRAP', /strap|clamp|hanger|minerallac|strut|bracket|support/],
  ['TERM',  /\blug\b|terminal|ground(ing)? bar|bonding|marrette|wire.?nut|ferrule|split bolt/],
  ['FUSE',  /\bfuse/], ['TAPE', /\btape\b|marker|label|zip ?tie/],
  ['HEAT',  /heater|thermostat|baseboard|heat ?trace/], ['FAN', /\bfan\b|ventilat|exhaust/],
  ['TOOL',  /\bbit\b|blade|drill|\bsaw\b|knife|\btool\b|tester/], ['SCRW', /screw|anchor|\bbolt\b|washer/]
];
function skuCat_(desc, sku) {
  var h = lc_(desc) + ' ' + lc_(sku);
  for (var i = 0; i < SKU_CATS.length; i++) if (SKU_CATS[i][1].test(h)) return SKU_CATS[i][0];
  return 'MISC';
}
function nextSku_(cat, rows) {
  var max = 0, re = new RegExp('^' + cat + '-(\\d+)$', 'i');
  rows.forEach(function(r){ var m = re.exec(String(r[M_SKU-1]||'').trim()); if (m) max = Math.max(max, Number(m[1])); });
  var n = String(max + 1); while (n.length < 3) n = '0' + n;
  return cat + '-' + n;
}
/* v102 - WHAT THE THING IS DECIDES THE UNIT, not the drawer it was filed in. Paul, 9 Nov:
 * "connectors are counted as lengths and conduits counted as pieces rather than lengths."
 * "1\" TECK CONN" and "CABLE CONN 25/BOX" file under WIRE (for the words teck and cable) and every
 * WIRE row was metres, so the job screen showed four connectors as 13 ft. And EECOL and Bartle &
 * Gibson bill PVC and EMT conduit by the foot (20 at $2.76 is 20 ft), which was filed as "ea".
 * The price list was corrected by hand the same day (41 fittings to ea, 9 conduits to ft). */
var UNIT_PIECE_ = /\bconn\b|connector|locknut|bushing|fitting|coupling|elbow|nipple|adapt(er|or)|strap|clamp|staple|\blug\b|end ?cap|splice|\bclips?\b|wire ?nut|marrette|\blever\b|knife|plier|lubricant|\bbody\b|\bhub\b|bracket|bender|auger|\bbit\b/;
function matUnit_(desc, cat) {
  var d = lc_(desc).replace(/\b\d+\s*\/\s*(box|pk|pack|bag|roll)\b/g, ' ');
  if (/\bper m\b|\/m\b/.test(d)) return 'm';
  if (/\bper ft\b|\/ft\b|per foot/.test(d)) return 'ft';
  if (UNIT_PIECE_.test(d)) return /\bkit\b/.test(d) ? 'kit' : 'ea';
  if (cat === 'WIRE') return /\broll\b/.test(d) ? 'roll' : 'm';
  if (/\bcut\b/.test(d) && /cable|wire|cord|teck|nmd|rw90|acwu|soow/.test(d)) return 'm';   // "cut lengths" - not a flush-cut plier
  if (cat === 'CONDT' && /conduit|\bemt\b|liquid.?tight/.test(d)) return 'ft';
  if (/\broll\b/.test(d)) return 'roll';
  if (/\bkit\b/.test(d)) return 'kit';
  return 'ea';
}
/* Two supplier part numbers are the same part when they are equal, when one is the other with
 * a manufacturer prefix ("IBV BC2104-LLE-2" vs "BC2104-LLE-2"), or when both are the same
 * digits ignoring leading zeros (B&G's 0771127 comes back from the sheet as 771127).
 * A plain substring test used to say BC2104-LLE (1-gang) was inside BC2104-LLE-2 (2-gang) and
 * merged the two boxes into one SKU — see repairBadPurchaseDates for the clean-up. */
function partEq_(entry, key) {
  var e = lc_(entry).replace(/\s+/g, ' '), k = lc_(key).replace(/\s+/g, ' ');
  if (!e || !k) return false;
  if (e === k) return true;
  var esc = function(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  // whole "word" inside the entry: bounded by start/end, space, brackets or punctuation — but
  // NOT a hyphen, so BC2104-LLE never matches BC2104-LLE-2.
  var whole = function(kk){ return new RegExp('(^|[\\s(\\[,;/])' + esc(kk) + '($|[\\s)\\],;/])').test(e) ||
                                   new RegExp('(^|[\\s(\\[,;/])' + esc(kk) + '($|[\\s)\\],;/])').test(e.replace(/(^|[^0-9])0+(\d)/g, '$1$2')); };
  if (whole(k)) return true;
  if (/^\d{5,}$/.test(k.replace(/[\s\-]/g, ''))) {          // numeric part numbers: leading zeros don't count
    var kz = k.replace(/^0+/, '');
    if (kz.length >= 4 && whole(kz)) return true;
  }
  return false;
}
// Match an incoming supplier line against an existing row: supplier part number first (exact and
// reliable — same supplier preferred), then an identical description. Anything looser is left
// to Paul's CHECK column — silently merging two different parts would corrupt both the count
// and the price.
function matFind_(rows, supplier, sku, desc) {
  var key = String(sku || '').trim(), d = lc_(desc), sup = lc_(supplier);
  if (key) {
    var anySup = -1;
    for (var i = 0; i < rows.length; i++) {
      var parts = String(rows[i][M_PARTS-1] || '').split(/\s*·\s*/);
      for (var k = 0; k < parts.length; k++) {
        var m = /^([^:]+):\s*(.+)$/.exec(parts[k].trim());
        var pSup = m ? lc_(m[1]) : '', pNo = m ? m[2] : parts[k];
        if (!partEq_(pNo, key)) continue;
        if (pSup === sup) return i;
        if (anySup < 0) anySup = i;
      }
    }
    if (anySup >= 0) return anySup;
  }
  if (d) for (var j = 0; j < rows.length; j++) if (lc_(rows[j][M_DESC-1]) === d) return j;
  return -1;
}
/* Adds a line to the company price list and, for purchases, to inventory. Returns what changed
 * so the app can show "old price → new price" for every line.
 *   qty      may be negative (a credit note), which takes stock back out; ignored for quotes
 *   srcLabel "Invoice PR 0443558" / "Receipt 1226464" / "Quote Pro 0267382" — goes in Price source
 *   opts.noInventory  a quote: prices only, the count on hand is untouched
 *   opts.credit       a credit note: stock moves, but a refund is not a price signal — Price,
 *                     Price source and Lowest/Highest are left alone (the purchase set them)
 * Newest price wins, whatever kind of document it came from: the Price column is replaced when
 * this document's date is the same or later than the date already on the row. Lowest/Highest
 * see every price regardless of date. */
function matUpsert_(iv, supplier, sku, desc, qty, price, dateStr, srcLabel, opts) {
  opts = opts || {};
  var i = matFind_(iv.rows, supplier, sku, desc);
  var partTag = supplier + (sku ? (': ' + sku) : '');
  qty = Number(qty) || 0; price = Number(price) || 0;
  var priceSignal = price > 0 && !opts.credit;
  var date = dstr_(dateStr) || fmtDate_(new Date());
  if (i < 0) {
    var cat = skuCat_(desc, sku), house = nextSku_(cat, iv.rows);
    var row = new Array(M_COLS).fill('');
    row[M_SKU-1]=house; row[M_DESC-1]=txt_(desc); row[M_UNIT-1]=matUnit_(desc, cat);
    row[M_INV-1]=opts.noInventory ? 0 : Math.max(0, qty); row[M_PRICE-1]=priceSignal ? price : ''; row[M_SRC-1]=priceSignal ? (srcLabel || '') : '';
    row[M_SUP-1]=priceSignal ? supplier : ''; row[M_DATE-1]=priceSignal ? date : '';
    row[M_PARTS-1]=partTag;
    iv.sheet.appendRow(row);
    iv.rows.push(row);                       // keep the in-memory copy in step for this batch
    return { sku: house, isNew: true, oldPrice: null, newPrice: priceSignal ? price : 0, changed: priceSignal, replaced: priceSignal, oldSrc: '' };
  }
  var r = iv.rows[i], rowNo = i + 2;
  var inv = opts.noInventory ? (Number(r[M_INV-1])||0) : Math.max(0, (Number(r[M_INV-1])||0) + qty);
  var oldPrice = Number(r[M_PRICE-1]) || 0, oldDate = dstr_(r[M_DATE-1]);
  var oldSrc = (r[M_SRC-1] ? String(r[M_SRC-1]) + ' ' : '') + String(r[M_SUP-1] || '') + (oldDate ? ' ' + oldDate : '');
  var newer = !oldDate || date >= oldDate;
  var lo = Number(r[M_LO-1])||0, hi = Number(r[M_HI-1])||0;
  var loSup = r[M_LOSUP-1] || '', hiSup = r[M_HISUP-1] || '';
  if (priceSignal) {
    if (!lo || price < lo) { lo = price; loSup = supplier; }
    if (!hi || price > hi) { hi = price; hiSup = supplier; }
  }
  // Record this supplier's part number once (same whole-word test as matFind_, so
  // "EECOL: BC2104-LLE" is added beside "EECOL: BC2104-LLE-2" instead of being mistaken for it).
  var parts = String(r[M_PARTS-1] || '');
  if (sku) {
    var have = parts.split(/\s*·\s*/).some(function(t){
      var m = /^([^:]+):\s*(.+)$/.exec(t.trim());
      return m && lc_(m[1]) === lc_(supplier) && partEq_(m[2], sku);
    });
    if (!have) parts = parts ? (parts + ' · ' + partTag) : partTag;
  }
  r[M_INV-1]=inv;
  var replaced = false;
  if (newer && priceSignal) { r[M_PRICE-1]=price; r[M_SRC-1]=srcLabel || ''; r[M_SUP-1]=supplier; r[M_DATE-1]=date; replaced = true; }
  r[M_LO-1]=lo; r[M_LOSUP-1]=loSup; r[M_HI-1]=hi; r[M_HISUP-1]=hiSup; r[M_PARTS-1]=parts;
  iv.sheet.getRange(rowNo, M_INV, 1, M_PARTS - M_INV + 1)
    .setValues([[r[M_INV-1], r[M_PRICE-1], r[M_SRC-1], r[M_SUP-1], r[M_DATE-1], lo, loSup, hi, hiSup, parts]]);
  return { sku: String(r[M_SKU-1]), isNew: false, oldPrice: oldPrice, newPrice: Number(r[M_PRICE-1]) || 0,
    changed: replaced && Math.abs(oldPrice - price) > 0.00001, replaced: replaced, oldSrc: oldSrc.trim() };
}
/* Text that must stay text: a bare invoice or part number like 0771127 turns into the number
 * 771127 the moment Sheets sees it (the leading zero is gone for good, and 14501305 stops
 * matching '14501305' as a string). A leading apostrophe is how Sheets marks "keep as typed". */
function asText_(v) {
  var s = String(v == null ? '' : v);
  return /^[0-9][0-9\s.\-]*$/.test(s) ? ("'" + s) : txt_(s);
}
/* Returns '' on success, else a one-line reason. A missing history row is not fatal to the
 * filing (inventory and Job POs are already written) but it must not be invisible either —
 * the sweep summary and the app's result screen show it. */
function histAppend_(rowsOut) {
  if (!rowsOut.length) return '';
  try {
    var sh = histTab_();
    sh.getRange(sh.getLastRow()+1, 1, rowsOut.length, H_COLS).setValues(rowsOut);
    return '';
  } catch (e) { return 'Price history could not be written: ' + (e && e.message ? e.message : e); }
}
/* Best price tab (v29). It was built once by hand in Sept 2026 and nothing kept it current; now
 * every filed document refreshes the rows it touched. Per SKU: the latest price from each
 * supplier — quotes count, credit notes do not — cheapest first. */
function bestPriceRefresh_(skus) {
  if (!skus || !skus.length) return;
  try {
    var want = {}; skus.forEach(function(s){ if (s) want[String(s)] = 1; });
    var hist = histTab_(), n = hist.getLastRow() - 1;
    var per = {};                                   // sku -> supplier -> {price, date}
    var descOf = {};
    if (n > 0) hist.getRange(2, 1, n, H_COLS).getValues().forEach(function(h){
      var sku = String(h[H_SKU-1] || '');
      if (!want[sku] || lc_(h[H_CREDIT-1]) === 'yes') return;
      var price = Number(h[H_PRICE-1]) || 0; if (price <= 0) return;
      var sup = String(h[H_SUP-1] || '').trim() || 'Supplier', date = dstr_(h[H_DATE-1]);
      per[sku] = per[sku] || {};
      var cur = per[sku][sup];
      if (!cur || date >= cur.date) per[sku][sup] = { price: price, date: date };
      if (!descOf[sku] && h[H_DESC-1]) descOf[sku] = String(h[H_DESC-1]);
    });
    // Descriptions from the Materials tab are the tidy ones — prefer them.
    var mat = matRows_();
    mat.rows.forEach(function(r){ var k = String(r[M_SKU-1] || ''); if (want[k] && r[M_DESC-1]) descOf[k] = String(r[M_DESC-1]); });
    var best = plTab_(BEST_TAB, BEST_HEADERS), lastB = best.getLastRow();
    var rowOf = {};
    if (lastB >= 2) best.getRange(2, 1, lastB-1, 1).getValues().forEach(function(v, i){ if (v[0]) rowOf[String(v[0])] = i + 2; });
    var fmt = function(p){ return '$' + Number(p).toFixed(2); };
    Object.keys(want).forEach(function(sku){
      var sups = per[sku]; if (!sups) return;
      var list = Object.keys(sups).map(function(s){ return { sup: s, price: sups[s].price }; })
        .sort(function(a, b){ return a.price - b.price; });
      if (!list.length) return;
      var lo = list[0], hi = list[list.length - 1];
      var row = [sku, txt_(descOf[sku] || ''), lo.sup, lo.price,
        list.map(function(x){ return x.sup + ' ' + fmt(x.price); }).join(' · '),
        hi.price, Math.round((hi.price - lo.price) * 100) / 100];
      if (rowOf[sku]) best.getRange(rowOf[sku], 1, 1, BEST_HEADERS.length).setValues([row]);
      else { best.appendRow(row); rowOf[sku] = best.getLastRow(); }
    });
  } catch (e) {}
}

// One Gemini call reads the photographed supplier document. Understands EECOL's per-100 (C)
// and per-1000 (M) price codes and normalizes everything to a true per-each price.
/* Calls Gemini with a prompt plus one image/PDF, walking CONFIG.GEMINI_MODELS until one
 * answers. Returns the model's raw text. Distinguishes the failure kinds, because "check your
 * API key" sent us hunting in the wrong place for a model that had simply been retired. */
function geminiCall_(prompt, b64, mime) {
  if (!CONFIG.GEMINI_API_KEY) throw new Error('AI scanning is not set up — no GEMINI_API_KEY in Code.gs.');
  var payload = {
    contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: mime, data: b64 } } ] }],
    generationConfig: { temperature: 0 }
  };
  return JSON.stringify(geminiGenerate_(payload));   // same shape as the old resp.getContentText() — whatever calls geminiCall_ still JSON.parses it the same way
}

/* Run from the editor: reports which model answers and what the key can reach. */
function testGemini() {
  var out = [];
  var tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  (CONFIG.GEMINI_MODELS || []).forEach(function(m){
    try {
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m +
        ':generateContent?key=' + encodeURIComponent(CONFIG.GEMINI_API_KEY);
      var r = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
        payload: JSON.stringify({ contents:[{ parts:[{ text:'Reply with the single word OK.' },
          { inline_data:{ mime_type:'image/png', data: tiny } }] }] }), muteHttpExceptions: true });
      out.push(m + ': HTTP ' + r.getResponseCode() + (r.getResponseCode()===200 ? ' ✓ WORKS' : ''));
    } catch (e) { out.push(m + ': ' + e.message); }
  });
  var msg = out.join('  |  ');
  Logger.log(msg);
  return msg;
}

/* The per-each price of one line. The AI is asked for the price AS PRINTED plus the PER code
 * (E = each, C = per 100, M = per 1000) and the line total; the arithmetic is done here, and the
 * line total is used to check it — whichever divisor (1, 100, 1000) reproduces qty × price =
 * line total is the right one, even if the PER column was misread. */
function num_(v) { if (typeof v === 'number') return v; var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function eachPrice_(it) {
  // Magnitudes only — a credit note prints negatives; the sign belongs to the document, not the price.
  var printed = Math.abs(num_(it.price_printed)), qty = Math.abs(num_(it.qty)), tot = Math.abs(num_(it.line_total));
  var per = String(it.per || '').trim().toUpperCase();
  var divPer = per === 'C' ? 100 : per === 'M' ? 1000 : 1;
  if (printed > 0 && qty > 0 && tot > 0) {
    var divs = [divPer, 1, 100, 1000], hit = null;
    for (var i = 0; i < divs.length; i++) {
      var e = printed / divs[i];
      if (Math.abs(qty * e - tot) / tot < 0.02) { hit = e; break; }
    }
    if (hit != null) return Math.round(hit * 100000) / 100000;
  }
  if (printed > 0) return Math.round((printed / divPer) * 100000) / 100000;
  return Math.abs(num_(it.unit_price));
}

/* One AI read of a supplier document — invoice, receipt, credit note OR quote. `anchor` is
 * when the document reached us (email date, or now), which the date parser measures against. */
function geminiExtractDoc_(b64, mime, anchor) {
  var prompt =
    'This photo/PDF is a document from a Canadian electrical or building supplier (EECOL, Bartle & Gibson, ' +
    'Home Hardware, Northern Metallic, B.A. Robinson, or similar) addressed to PRO Electrical. It may be an ' +
    'invoice, a purchase order, a till receipt, a credit/return note, or a QUOTE / quotation / estimate. ' +
    'Reply with ONLY this JSON, no other text: {"supplier":"...","doc_type":"invoice",' +
    '"doc_no":"...","date_printed":"...","date":"YYYY-MM-DD","po_ref":"...",' +
    '"items":[{"sku":"...","description":"...","qty":1,"price_printed":0.00,"per":"E","line_total":0.00,"unit_price":0.00}]} . ' +
    'doc_type: "invoice" (invoice or packing slip for goods bought), "receipt" (a till/point-of-sale receipt), ' +
    '"credit" (a credit or return note), "quote" (a quote, quotation, estimate, proposal or price list — nothing was bought), ' +
    'or "other" (statement, payment receipt, spec sheet, drawing). ' +
    'A store "Sales Invoice" or point-of-sale invoice that lists items (e.g. Home Hardware / "PEACE RIVER HHBC") is an ' +
    '"invoice" even when it shows it was paid at the till; use "other" only when there are no material lines at all. ' +
    'doc_no: the invoice / receipt / credit / quote number exactly as printed, with any prefix (e.g. "PR 0443558", "Pro 0267382", "14501305"). ' +
    'date_printed: the document date EXACTLY as printed, character for character (e.g. "09/10/26" or "Sep 10, 2026") — do not reformat it. ' +
    'date: your best reading of that date as YYYY-MM-DD. ' +
    'po_ref: the customer purchase-order / job reference printed on it (e.g. I26156, C26011, TOOLS, SHOP), else "". ' +
    'items: every material line (skip freight, fuel surcharges, fees, deposits, subtotals, taxes). ' +
    'price_printed is the unit price figure exactly as printed on the line; per is the PER / UM code beside it: ' +
    '"E" (each), "C" (per 100), "M" (per 1000) or "" if there is none; line_total is the extended amount for the line; ' +
    'unit_price is your best TRUE PER-EACH price (e.g. 8068.43 per C means 80.6843 each). ' +
    'description: plain Canadian electrical trade names, expanded from shorthand. qty = quantity shipped or quoted.';
  var data = JSON.parse(geminiCall_(prompt, b64, mime)), text = '';
  try { text = data.candidates[0].content.parts[0].text; }
  catch (e) { throw new Error('AI scan returned no result — try a clearer photo.'); }
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
  var parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error('Could not read the document — try a straighter, better-lit photo.'); }
  return normalizeExtract_(parsed, anchor);
}
/* Turns the AI's JSON (or a copy of it the app sends back on a confirm round) into the shape the
 * filing code uses. Safe to call twice. */
function normalizeExtract_(parsed, anchor) {
  if (typeof parsed === 'string') parsed = safeJson_(parsed);
  parsed = parsed || {};
  var supplierRaw = String(parsed.supplier || '').trim();
  var sup = canonSupplier_(supplierRaw);
  var docType = lc_(parsed.doc_type || parsed.docType || 'invoice');
  if (['invoice', 'receipt', 'credit', 'quote', 'other'].indexOf(docType) < 0) docType = 'invoice';
  var printed = String(parsed.date_printed || parsed.datePrinted || '').trim();
  var iso = String(parsed.date || parsed.invoice_date || '').trim();
  var dt = parseDocDate_(printed, iso, sup, anchor);
  var items = (parsed.items || []).map(function(it){
    var price = (it.price_printed != null || it.per) ? eachPrice_(it) : Math.abs(num_(it.unit_price) || num_(it.price));
    var qty = Math.abs(num_(it.qty));                     // credit notes print negatives; the sign is applied by poFile_
    return { sku: String(it.sku || '').trim(), desc: String(it.description || it.desc || '').trim(),
      qty: qty, price: price,
      // keep the raw figures so a confirm round can be re-normalized without a second AI call
      price_printed: it.price_printed, per: it.per, line_total: it.line_total, unit_price: it.unit_price, description: it.description || it.desc };
  }).filter(function(x){ return x.desc && x.price > 0; });
  return {
    supplier: supplierRaw, supplierName: sup,
    invoiceNo: String(parsed.doc_no || parsed.invoice_no || parsed.invoiceNo || '').trim(),
    datePrinted: printed, dateRead: iso, date: dt.date, dateFlag: dt.flag,
    poRef: String(parsed.po_ref || parsed.poRef || '').trim(),
    docType: docType, items: items,
    raw: { supplier: supplierRaw, doc_type: docType, doc_no: String(parsed.doc_no || parsed.invoice_no || parsed.invoiceNo || '').trim(),
      date_printed: printed, date: iso, po_ref: String(parsed.po_ref || parsed.poRef || '').trim(),
      items: (parsed.items || []) }
  };
}
// Older name, kept for anything that still calls it.
function geminiExtractPO_(b64, mime) { return geminiExtractDoc_(b64, mime, null); }

function canonSupplier_(s) {
  s = lc_(s);
  if (s.indexOf('eecol') >= 0) return 'EECOL';
  if (s.indexOf('bartle') >= 0 || s.indexOf('b&g') >= 0 || s.indexOf('billtrust') >= 0) return 'Bartle & Gibson';
  // Home Hardware invoices name the branch, not the chain — "PEACE RIVER HHBC".
  if (s.indexOf('home hardware') >= 0 || s.indexOf('hhbc') >= 0 || s.indexOf('home building') >= 0) return 'Home Hardware';
  if (s.indexOf('northern metallic') >= 0 || s.indexOf('northern') >= 0 || s.indexOf('nmp') >= 0) return 'Northern Metallic';
  if (s.indexOf('robinson') >= 0) return 'B.A. Robinson';
  if (s.indexOf('gregg') >= 0) return 'Gregg Distributors';
  if (s.indexOf('acklands') >= 0 || s.indexOf('grainger') >= 0) return 'Acklands-Grainger';
  return String(s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Supplier');
}
// "Invoice PR 0443558" / "Receipt 1226464" / "Quote Pro 0267382" — what goes in Price source.
function docLabel_(docType, docNo) {
  var kind = docType === 'quote' ? 'Quote' : docType === 'receipt' ? 'Receipt' : docType === 'credit' ? 'Credit' : 'Invoice';
  return (kind + ' ' + String(docNo || '')).trim();
}
function histType_(docType) { return docType === 'quote' ? 'Quote' : docType === 'receipt' ? 'Receipt' : 'Invoice'; }
// Same document? Supplier + number, ignoring case, spaces, punctuation and leading zeros — and
// ignoring a letter prefix when the number itself is long enough to identify the document, so
// "PR 0443558" (printed) and "0443558" / "IN0443558" (read another day) are the same invoice.
function docKey_(sup, no) {
  var s = lc_(no).replace(/[^a-z0-9]/g, '');
  var digits = s.replace(/\D/g, '').replace(/^0+/, '');
  return lc_(sup) + '|' + (digits.length >= 5 ? digits : s.replace(/^([a-z]*)0+/, '$1'));
}

/* Files a purchase (invoice / receipt / credit note): stock in, price refreshed, purchase
 * recorded against the job, history row per line. Returns {added, duplicate, lines}. */
function poFile_(user, jobSite, poNumber, ex, source, docUrl) {
  var sup = ex.supplierName || canonSupplier_(ex.supplier);
  var posSh = plTab_(POS_TAB, POS_HEADERS);
  var last = posSh.getLastRow();
  if (ex.invoiceNo && last >= 2) {                       // already filed? never double-count stock
    var key = docKey_(sup, ex.invoiceNo);
    var seen = posSh.getRange(2, 5, last-1, 2).getValues();
    for (var i = 0; i < seen.length; i++)
      if (docKey_(seen[i][0], seen[i][1]) === key)
        return { added: 0, duplicate: true, lines: [] };
  }
  var iv = matRows_();
  var docType = ex.docType === 'credit' ? 'credit' : ex.docType === 'receipt' ? 'receipt' : 'invoice';
  var sign = (docType === 'credit') ? -1 : 1;             // a credit note takes stock back out
  var date = dstr_(ex.date) || fmtDate_(new Date()), out = [], hist = [], lines = [], skus = [];
  var label = docLabel_(docType, ex.invoiceNo);
  ex.items.forEach(function(it){
    var u = matUpsert_(iv, sup, it.sku, it.desc, sign * it.qty, it.price, date, label, { credit: sign < 0 });
    out.push([newId_(), date, jobSite || 'Stock', poNumber || '', sup, asText_(ex.invoiceNo),
      u.sku, txt_(it.desc), sign * it.qty, it.price, user ? user.email : 'system', docUrl || '']);
    hist.push([u.sku, sup, asText_(it.sku), txt_(it.desc), date, it.price, asText_(ex.invoiceNo),
      sign * it.qty, sign < 0 ? 'yes' : '', histType_(docType)]);
    lines.push({ sku: u.sku, desc: it.desc, qty: it.qty, price: it.price, oldPrice: u.oldPrice,
      newPrice: u.newPrice, changed: u.changed, isNew: u.isNew, kept: !u.replaced, oldSrc: u.oldSrc });
    skus.push(u.sku);
  });
  if (out.length) posSh.getRange(posSh.getLastRow()+1, 1, out.length, POS_HEADERS.length).setValues(out);
  var warn = histAppend_(hist);
  bestPriceRefresh_(skus);
  try { CacheService.getScriptCache().remove('materials_v3'); } catch (e) {}
  return { added: out.length, duplicate: false, lines: lines, warn: warn };
}

/* Files a QUOTE / estimate (v29): prices only. Newest price wins exactly as for an invoice —
 * the Price column, Price source, Lowest/Highest and the Best price tab all see it — but nothing
 * is added to inventory and nothing is written to Job POs, because nothing was bought.
 * Dedupe on supplier + quote number; a revised quote (same number, later date) replaces the
 * earlier quote's history rows and re-prices the SKUs it touched. */
function quoteFile_(user, jobSite, poNumber, ex, source, docUrl) {
  var sup = ex.supplierName || canonSupplier_(ex.supplier);
  var date = dstr_(ex.date) || fmtDate_(new Date());
  var hist = histTab_(), n = hist.getLastRow() - 1, key = docKey_(sup, ex.invoiceNo);
  var priorRows = [], priorDate = '', priorSkus = {}, priorSig = [];
  if (ex.invoiceNo && n > 0) {
    hist.getRange(2, 1, n, H_COLS).getValues().forEach(function(h, i){
      if (lc_(h[H_TYPE-1]) !== 'quote') return;
      if (docKey_(h[H_SUP-1], h[H_DOC-1]) !== key) return;
      priorRows.push(i + 2);
      var d = dstr_(h[H_DATE-1]); if (d > priorDate) priorDate = d;
      if (h[H_SKU-1]) priorSkus[String(h[H_SKU-1])] = 1;
      priorSig.push(lc_(h[H_PART-1]).replace(/^'/, '') + '|' + lc_(h[H_DESC-1]) + '|' + (Number(h[H_PRICE-1]) || 0) + '|' + (Number(h[H_QTY-1]) || 0));
    });
  }
  if (priorRows.length) {
    if (date < priorDate) return { added: 0, duplicate: true, replaced: false, lines: [] };   // older than what we hold
    if (date === priorDate) {                             // same day: a duplicate unless the lines differ (a same-day revision)
      var sig = ex.items.map(function(it){ return lc_(it.sku) + '|' + lc_(it.desc) + '|' + (Number(it.price) || 0) + '|' + (Number(it.qty) || 0); });
      if (sig.length === priorSig.length && sig.sort().join('\n') === priorSig.sort().join('\n'))
        return { added: 0, duplicate: true, replaced: false, lines: [] };
    }
  }
  var iv = matRows_(), rowsOut = [], lines = [], skus = [], label = docLabel_('quote', ex.invoiceNo);
  ex.items.forEach(function(it){
    var u = matUpsert_(iv, sup, it.sku, it.desc, 0, it.price, date, label, { noInventory: true });
    rowsOut.push([u.sku, sup, asText_(it.sku), txt_(it.desc), date, it.price, asText_(ex.invoiceNo),
      it.qty, '', 'Quote']);
    lines.push({ sku: u.sku, desc: it.desc, qty: it.qty, price: it.price, oldPrice: u.oldPrice,
      newPrice: u.newPrice, changed: u.changed, isNew: u.isNew, kept: !u.replaced, oldSrc: u.oldSrc });
    skus.push(u.sku); priorSkus[u.sku] = 1;
  });
  // New rows go on the END first, then the superseded rows come out bottom-up — so a failed
  // append can never leave the quote missing from history, and the earlier row numbers still hold.
  var warn = histAppend_(rowsOut);
  var replaced = false;
  if (priorRows.length && !warn) {
    for (var r = priorRows.length - 1; r >= 0; r--) hist.deleteRow(priorRows[r]);
    replaced = true;
    // Every SKU the old quote touched is re-derived from history (newest price wins, Lowest /
    // Highest recomputed) — a superseded low price must not linger in Lowest.
    rebuildSkuPricing_(Object.keys(priorSkus));
  }
  bestPriceRefresh_(Object.keys(priorSkus));
  try { CacheService.getScriptCache().remove('materials_v3'); } catch (e) {}
  return { added: rowsOut.length, duplicate: false, replaced: replaced, lines: lines, warn: warn };
}
/* Route by document type. */
function docFile_(user, jobSite, poNumber, ex, source, docUrl) {
  return ex.docType === 'quote' ? quoteFile_(user, jobSite, poNumber, ex, source, docUrl)
                                : poFile_(user, jobSite, poNumber, ex, source, docUrl);
}

/* The customer's folder in Paul's PO archive ("1. Ongoing Invoice") — the same folder the
 * invoice build reads from. Reuses whatever folder already matches this job (named '26156',
 * 'I26156', 'KFC (June)' — see poFolderMatches_) and only creates one, named for the PO, when
 * the job has none yet. Returns null when we could not resolve a job, so an unidentified
 * invoice is never dropped into some customer's folder. */
function poArchiveFolder_(jobSite, poNumber) {
  if (!poNumber && !jobSite) return null;
  if (lc_(jobSite) === 'stock') return null;
  try {
    var hits = jobPoFolders_(jobSite, poNumber).filter(function (f) {
      return f.getName() !== 'Supplier POs';          // that one lives under the media folder
    });
    // v41 - a folder carrying the JOB NUMBER beats one that only shares the customer's name
    // ("Patrick" would otherwise match any folder with Patrick in it).
    var seq = String(poNumber || '').replace(/[^0-9]/g, '');
    if (seq.length >= 5) {
      var byNo = hits.filter(function (f) { return f.getName().replace(/[^0-9]/g, '').indexOf(seq) >= 0; });
      if (byNo.length) return byNo[0];
      // a job number was given and no folder has it: make "R26184" rather than borrow a name match
      return DriveApp.getFolderById(CONFIG.PO_ARCHIVE_FOLDER_ID)
        .createFolder(String(poNumber).replace(/[\\\/:*?"<>|]/g, '-').trim());
    }
    if (hits.length) return hits[0];
    if (!poNumber) return null;                        // a name alone is too weak to create on
    var safe = String(poNumber).replace(/[\\\/:*?"<>|]/g, '-').trim();
    return DriveApp.getFolderById(CONFIG.PO_ARCHIVE_FOLDER_ID).createFolder(safe);
  } catch (e) { return null; }
}

/* Files the document itself in Drive. Purchases go where they always did (the job's archive
 * folder, else <job>/Supplier POs, else the master folder's Supplier POs). Quotes are named
 * "EECOL — Quote Pro 0267382 — KFC — 2026-09-15.pdf" and ALWAYS go to a Quotes folder under
 * the master media folder — never among a job's PO documents. */
/* v45/v47 - purchases that belong to no customer job on the PO Log.
 * The reference printed on the supplier invoice decides the folder in the PO archive
 * ("1. Ongoing Invoice"):
 *   SHOP / STOCK / SUPPLIES, or no reference at all  -> "Shop Supplies"
 *   TOOLS -> "Tools", PAUL -> "Paul", PCW / FARM -> "PCW"
 *   anything else (a client's name, a number)          -> a folder with THAT name, reused if one
 *                                                          already exists (any upper/lower case)
 * Before we get here, poRefResolve_ has already checked that the reference is not a job: a job
 * number, a PO Log contact or company name, or the last digits of one job's number.
 * The stock count is unchanged: these still land on "Stock" in the inventory. */
var SHOP_FOLDER_ = 'Shop Supplies';
var REVIEW_FOLDER_ = 'Needs review';   // v91 - supplier documents whose reference names no job
function internalPoFolderName_(ref) {
  var raw = String(ref || '').replace(/[\\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
  var r = lc_(raw).replace(/[^a-z0-9]/g, '');
  if (!r || /^(shop|shops|stock|supplies|shopsupplies|shopsupply|consumables|na|none|nopo)$/.test(r)) return SHOP_FOLDER_;
  if (/^tools?$/.test(r)) return 'Tools';
  if (r === 'paul') return 'Paul';
  if (r === 'pcw' || r === 'farm' || r === 'pcwagyu') return 'PCW';
  // v91 - a reference that is plainly not a client's name ("REEL FOR ORDER 3997990", an order or
  // quote number, a return) used to become a folder of its own beside the job folders. It goes to
  // one 'Needs review' folder instead, and the Sweep log line says what the reference was.
  if (/\d{4,}/.test(raw) || /\b(order|reel|return|returnable|deposit|core|quote|invoice|ref|pickup|cash|account|credit)\b/i.test(raw))
    return REVIEW_FOLDER_;
  return raw;                                                   // v47 - the client's own folder
}
function internalPoFolder_(ref) {
  var nm = internalPoFolderName_(ref); if (!nm) return null;
  var root = DriveApp.getFolderById(CONFIG.PO_ARCHIVE_FOLDER_ID), it = root.getFoldersByName(nm);
  if (it.hasNext()) return it.next();
  var want = lc_(nm).replace(/\s+/g, ' '), all = root.getFolders();       // "pcw" finds "PCW"
  while (all.hasNext()) { var f = all.next(); if (lc_(f.getName()).replace(/\s+/g, ' ') === want) return f; }
  return root.createFolder(nm);
}

function filePoDoc_(blob, jobSite, sup, invoiceNo, dateStr, poNumber, docType, poRef) {
  try {
    var isQuote = docType === 'quote';
    var stem = (sup + ' — ' + (isQuote ? docLabel_('quote', invoiceNo) : (invoiceNo || 'PO')) +
      (isQuote && jobSite && jobSite !== 'Stock' ? ' — ' + jobSite : '') + ' — ' +
      (dstr_(dateStr) || fmtDate_(new Date()))).replace(/[\\\/:*?"<>|]/g,'-') +
      (String(blob.getContentType()).indexOf('pdf') >= 0 ? '.pdf' : '.jpg');
    if (isQuote) {
      // Never into a customer's PO folder: the job screen and the invoice build read those as
      // purchase documents, and a quote is not one. One Quotes folder under the master folder.
      var mq = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID), itq = mq.getFoldersByName('Quotes');
      var qf = itq.hasNext() ? itq.next() : mq.createFolder('Quotes');
      var dq = qf.getFilesByName(stem);
      if (dq.hasNext()) return dq.next().getUrl();
      return qf.createFile(blob.copyBlob().setName(stem)).getUrl();
    }
    var arch = poArchiveFolder_(jobSite, poNumber);
    if (arch) {
      var ad = arch.getFilesByName(stem);
      if (ad.hasNext()) return ad.next().getUrl();
      return arch.createFile(blob.copyBlob().setName(stem)).getUrl();
    }
    if (!poNumber && (!jobSite || lc_(jobSite) === 'stock')) {
      var shop = null; try { shop = internalPoFolder_(poRef); } catch (e) {}
      if (shop) {
        var sd = shop.getFilesByName(stem);
        if (sd.hasNext()) return sd.next().getUrl();
        return shop.createFile(blob.copyBlob().setName(stem)).getUrl();
      }
    }
    var parent = jobSite && jobSite !== 'Stock' ? ensureJobFolder_(jobSite)
      : DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
    var it = parent.getFoldersByName('Supplier POs');
    var folder = it.hasNext() ? it.next() : parent.createFolder('Supplier POs');
    var dup = folder.getFilesByName(stem);
    if (dup.hasNext()) return dup.next().getUrl();
    return folder.createFile(blob.copyBlob().setName(stem)).getUrl();
  } catch (e) { return ''; }
}

/* ---- In-app scan (v29): one endpoint for "Receipt (we bought it)" and "Estimate / quote".
 *   p.kind        'receipt' | 'quote'  — what the person said the document is
 *   p.dataBase64, p.mimeType, p.jobSite, p.poNumber
 *   p.extract     on a confirm round: the AI's JSON from the first round (no second AI call)
 *   p.confirmed   true once the person has answered the warnings
 *   p.dateOverride 'YYYY-MM-DD' typed by the person when the printed date could not be trusted
 *   p.queued      replayed from the phone's offline queue (no one is watching)
 * First round: read the document. If the AI's idea of the document disagrees with the button
 * pressed, or the date is implausible, NOTHING is saved — the warnings and the extraction go
 * back to the app, which asks. The confirm round sends the same photo + the extraction + the
 * answers, and this saves. With no warnings the first round saves straight away, as before. */
function scanSupplierDoc_(user, p) {
  if (!CONFIG.GEMINI_API_KEY) throw new Error('Scanning is not set up yet — see CONFIG.GEMINI_API_KEY.');
  if (!p.dataBase64) throw new Error('No photo received.');
  plMigrate_();                                            // layout first, before the AI read and before any lock
  var kind = (p.kind === 'quote' || p.kind === 'estimate') ? 'quote' : 'receipt';
  if (p.legacy && !p.extract) {
    // An old app build (or its offline queue) cannot answer a confirm step. It could only ever
    // scan purchases — but if the AI reads a quote, file it as the quote it is rather than
    // inventing a purchase (the pre-v29 code refused quotes outright).
    var exL = geminiExtractDoc_(p.dataBase64, p.mimeType || 'image/jpeg', null);
    if (exL.docType === 'quote') kind = 'quote';
    p.extract = exL.raw; p.kind = kind;
  }
  var mime = p.mimeType || 'image/jpeg';
  var ex = p.extract ? normalizeExtract_(p.extract, null)
                     : geminiExtractDoc_(p.dataBase64, mime, null);
  if (ex.docType === 'other' || !ex.items.length)
    throw new Error('That does not look like a supplier invoice, receipt or quote with material lines — try again with the itemized page.');
  var warnings = [];
  var aiSaysQuote = ex.docType === 'quote';
  if (aiSaysQuote !== (kind === 'quote')) warnings.push({ code: 'type', aiType: ex.docType,
    text: aiSaysQuote
      ? 'This reads like a QUOTE / estimate (' + docLabel_('quote', ex.invoiceNo) + '), but you tapped Receipt. Nothing was bought on a quote — which is it?'
      : 'This reads like a ' + (ex.docType === 'credit' ? 'credit note' : ex.docType) + ' (' + docLabel_(ex.docType, ex.invoiceNo) + ') for goods bought, but you tapped Estimate. Which is it?' });
  if (p.dateOverride) {
    var ov = /^\d{4}-\d{2}-\d{2}$/.test(String(p.dateOverride).trim()) ? dstr_(String(p.dateOverride).trim()) : '';
    if (!ov) throw new Error('That date could not be read — use YYYY-MM-DD.');
    ex.date = ov; ex.dateFlag = '';
  }
  if (!ex.date || ex.dateFlag) warnings.push({ code: 'date', text: ex.dateFlag || 'No date could be read on this document.',
    suggested: fmtDate_(new Date()) });
  var showP = canSeePrices_(user);
  if (p.legacy) { p.confirmed = true; if (!ex.date) { ex.date = fmtDate_(new Date()); ex.dateFlag = ''; } }   // an old app build cannot answer
  else if (p.confirmed && (!ex.date || ex.dateFlag)) throw new Error('Enter the document date before saving.');
  if (warnings.length && !p.confirmed) {
    // Dry-run: what would change, so the person sees old → new before deciding.
    var iv = matRows_(), sup = ex.supplierName;
    var preview = ex.items.map(function(it){
      var i = matFind_(iv.rows, sup, it.sku, it.desc), o = { desc: it.desc, qty: it.qty };
      o.sku = i >= 0 ? String(iv.rows[i][M_SKU-1]) : '(new)';
      if (showP) { o.price = it.price; o.oldPrice = i >= 0 ? (Number(iv.rows[i][M_PRICE-1]) || 0) : null; }
      return o;
    });
    return { needsConfirm: true, kind: kind, warnings: warnings, extract: ex.raw, supplier: sup,
      docType: ex.docType, invoiceNo: ex.invoiceNo, date: ex.date || '', datePrinted: ex.datePrinted,
      items: preview };
  }
  // The person's answer wins over the AI's guess.
  if (kind === 'quote') ex.docType = 'quote';
  else if (ex.docType === 'quote') ex.docType = 'invoice';
  if (!ex.date) ex.date = fmtDate_(new Date());
  var supName = ex.supplierName;
  // v41 - not clocked in on a job (or on Stock) but the receipt carries a job number: it goes to
  // THAT job - its folder (created by job number if needed), its record, and the stock count.
  if (kind !== 'quote' && !p.poNumber && ex.poRef && (!p.jobSite || lc_(p.jobSite) === 'stock')) {
    try { var hj = poRefResolve_(poJobIndex_(), ex.poRef); if (hj) { p.poNumber = hj.po; p.jobSite = hj.site; p._refNote = poRefNote_(hj, ex.poRef); } } catch (e) {}
  }
  var jobSite = kind === 'quote' ? (p.jobSite || '') : p.jobSite;
  var docUrl = filePoDoc_(Utilities.newBlob(Utilities.base64Decode(p.dataBase64), mime),
    jobSite, supName, ex.invoiceNo, ex.date, p.poNumber, ex.docType, ex.poRef);
  var res = withLock_(function(){ return docFile_(user, jobSite, p.poNumber, ex, 'app scan', docUrl); });
  log_(user, kind === 'quote' ? 'scanSupplierQuote' : 'scanSupplierPO', p.jobSite || '', '',
    supName + ' ' + docLabel_(ex.docType, ex.invoiceNo) + ': ' + ex.items.length + ' line(s)' +
    (res.duplicate ? ' (already filed — skipped)' : res.replaced ? ' (revised quote — replaced)' : ''));
  return { added: res.added, duplicate: res.duplicate, replaced: !!res.replaced, kind: kind, docType: ex.docType,
    warn: [res.warn || '', p._refNote || ''].filter(String).join(' · '),
    supplier: supName, invoiceNo: ex.invoiceNo, date: ex.date, poUrl: docUrl, credit: ex.docType === 'credit',
    jobSite: kind === 'quote' ? '' : (p.jobSite || 'Stock'),
    items: res.lines.map(function(l){
      var o = { sku: l.sku, desc: l.desc, qty: l.qty, isNew: l.isNew };
      if (showP) { o.price = l.price; o.oldPrice = l.oldPrice; o.newPrice = l.newPrice; o.changed = l.changed; o.kept = l.kept; o.oldSrc = l.oldSrc; }
      return o; }) };
}
// Older name, kept for anything that still calls it.
function scanSupplierPO_(user, p) { p.kind = p.kind || 'receipt'; return scanSupplierDoc_(user, p); }

/* The searchable company inventory — this is what the crew pick from on a job. Everyone may see
 * item names and how many are on hand; only admins/bookkeeper get the dollar figures. */
function inventoryList_(user, p) {
  var all = null;
  try { var hit = CacheService.getScriptCache().get('materials_v3'); if (hit) all = JSON.parse(hit); } catch (e) {}
  if (!all) {
    var iv = matRows_();
    all = iv.rows.map(function(r){ return { k: String(r[M_SKU-1]||''), d: String(r[M_DESC-1]||''),
      u: String(r[M_UNIT-1]||'ea'), n: Number(r[M_INV-1])||0, p: Number(r[M_PRICE-1])||0,
      s: String(r[M_SUP-1]||''), dt: dstr_(r[M_DATE-1]), src: String(r[M_SRC-1]||''),
      lo: Number(r[M_LO-1])||0, los: String(r[M_LOSUP-1]||'') };
    }).filter(function(x){ return x.k || x.d; });
    // v29 — cache key bumped ('materials_v3'): the layout gained the Price source column.
    try { CacheService.getScriptCache().put('materials_v3', JSON.stringify(all), 600); } catch (e) {}
  }
  var q = lc_(p.q || ''), items = all;
  if (q) {
    var toks = q.split(/\s+/).filter(String);
    items = all.filter(function(it){
      var hay = lc_(it.k + ' ' + it.d);
      return toks.every(function(t){ return hay.indexOf(t) >= 0; });
    });
  }
  if (p.inStock) items = items.filter(function(it){ return it.n > 0; });
  var showP = canSeePrices_(user);
  var lim = Math.min(Number(p.limit) || 60, 200);
  return { items: items.slice(0, lim).map(function(it){
      var o = { sku: it.k, desc: it.d, unit: it.u, onHand: it.n };
      if (showP) { o.price = it.p; o.supplier = it.s; o.lo = it.lo; o.loSup = it.los; o.date = it.dt; o.src = it.src || ''; }
      return o; }), total: items.length };
}
// The price list screen is the same data, admins only, always with prices.
function priceList_(user, p) {
  if (!canSeePrices_(user)) throw new Error('The price list is for admins and the bookkeeper.');
  return inventoryList_(user, p);
}

/* Take material onto a job: stock out, one "Job usage" row. qty may be negative to undo.
 * Works for material bought for this job AND for anything pulled off the shelf with no PO. */
function takeMaterial_(user, p) {
  var sku = String(p.sku || '').trim();
  var qty = Number(p.qty) || 0;
  if (!sku) throw new Error('No material given.');
  if (!qty) throw new Error('Enter how many you used.');
  var iv = matRows_(), idx = -1;
  for (var i = 0; i < iv.rows.length; i++) if (String(iv.rows[i][M_SKU-1]).trim() === sku) { idx = i; break; }
  if (idx < 0) throw new Error('That material is not in the list any more.');
  var r = iv.rows[idx];
  var onHand = Number(r[M_INV-1]) || 0;
  // Going below zero is allowed but flagged: the shelf is often ahead of the paperwork, and
  // blocking a crew member mid-job over a count they can't fix on site would be worse.
  var left = onHand - qty;
  iv.sheet.getRange(idx + 2, M_INV).setValue(left);
  var useSh = plTab_(USE_TAB, USE_HEADERS);
  useSh.appendRow([newId_(), fmtDate_(clientTime_(p.at)), p.jobSite || 'Stock', p.poNumber || '',
    sku, r[M_DESC-1], qty, Number(r[M_PRICE-1])||0, user.email, qty < 0 ? 'correction' : 'used']);
  try { CacheService.getScriptCache().remove('materials_v3'); } catch (e) {}
  log_(user, 'takeMaterial', p.jobSite || '', '', sku + ' × ' + qty + ' → ' + left + ' left');
  return { sku: sku, onHand: left, low: left < 0 };
}
/* Flags stock as going back to the supplier. Deliberately does NOT move inventory — the credit
 * note PO does that when it is scanned or swept in, so a return is never counted twice. */
function returnToSupplier_(user, p) {
  var sku = String(p.sku || '').trim(), qty = Number(p.qty) || 0;
  if (!sku || !qty) throw new Error('Pick the item and how many are going back.');
  var iv = matRows_(), desc = '';
  for (var i = 0; i < iv.rows.length; i++) if (String(iv.rows[i][M_SKU-1]).trim() === sku) { desc = iv.rows[i][M_DESC-1]; break; }
  var useSh = plTab_(USE_TAB, USE_HEADERS);
  useSh.appendRow([newId_(), fmtDate_(new Date()), p.jobSite || 'Stock', p.poNumber || '', sku, desc,
    qty, '', user.email, 'to return — awaiting credit note']);
  log_(user, 'returnToSupplier', p.jobSite || '', '', sku + ' × ' + qty);
  return { ok: true };
}

/* Everything a job bought and everything it used — the job-detail "Materials & POs" screen,
 * and the reconciliation the invoice builder repeats on its own side. */

/* ---------------------- Job PO documents (v24) -------------------------------------------
 * The PDFs and phone photos of a job's supplier POs live in two different places:
 *   1. MASTER_DRIVE_FOLDER_ID / <job site> / Supplier POs   <- what the app files itself
 *   2. PO_ARCHIVE_FOLDER_ID / <folder named for the job>    <- Paul's own filing, older jobs
 * Looking in only the first is why a job like Fuel Co showed nothing and offered no button.
 * ----------------------------------------------------------------------------------------*/

/* Does this folder name belong to this job? The archive's names are inconsistent, so match the
 * way a person would: the 5-digit sequence out of the PO first (26156 matches '26156',
 * 'I26156' and 'I26156 Fuel Co'), then the job-site name. Sequence beats name — a name match is
 * weaker evidence and 'KFC' would otherwise pull in an unrelated 'KFC signage' folder. */
function poFolderMatches_(folderName, jobSite, poNumber) {
  var n = lc_(folderName);
  var seq = String(poNumber || '').replace(/[^0-9]/g, '');
  if (seq.length >= 5 && n.replace(/[^0-9]/g, '').indexOf(seq) >= 0) return true;
  var site = lc_(jobSite || '').replace(/[^a-z0-9]/g, '');
  return !!(site && n.replace(/[^a-z0-9]/g, '').indexOf(site) >= 0);
}

/* Every folder that belongs to this job, across both roots. A job can own more than one
 * (the KFC job owns both 'KFC (June)' and 'C26011'), so this returns a list, not a folder. */
function jobPoFolders_(jobSite, poNumber) {
  var out = [], seen = {};
  var add = function (f) { var id = f.getId(); if (!seen[id]) { seen[id] = 1; out.push(f); } };
  try {
    var master = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID).getFoldersByName(String(jobSite || ''));
    if (jobSite && master.hasNext()) {
      var sub = master.next().getFoldersByName('Supplier POs');
      if (sub.hasNext()) add(sub.next());
    }
  } catch (e) {}
  try {
    var it = DriveApp.getFolderById(CONFIG.PO_ARCHIVE_FOLDER_ID).getFolders();
    while (it.hasNext()) {
      var f = it.next();
      var nm = f.getName();
      if (nm.charAt(0) === '0' || nm.charAt(0) === '1') continue;   // '0. Staging', '1. No PO'
      if (poFolderMatches_(nm, jobSite, poNumber)) add(f);
    }
  } catch (e) {}
  // v28 — a job that has already been invoiced lives under Completed jobs / <year> / <N. Month>,
  // and until now nothing looked there. Two things went wrong because of it: the sweep could not
  // find the folder for a late supplier invoice, so it created a FRESH one back in "1. Ongoing
  // Invoice" (KFC C26011 on 2026-09-12 — a closed job that looked reopened); and the app's
  // "Bought for this job" went empty the moment a job was archived. Only scan it when the live
  // roots found nothing, so the common case still costs one listing.
  if (!out.length) {
    try {
      var years = DriveApp.getFolderById(CONFIG.PO_COMPLETED_FOLDER_ID).getFolders();
      while (years.hasNext()) {
        var months = years.next().getFolders();
        while (months.hasNext()) {
          var jobs = months.next().getFolders();
          while (jobs.hasNext()) {
            var jf = jobs.next();
            if (poFolderMatches_(jf.getName(), jobSite, poNumber)) add(jf);
          }
        }
      }
    } catch (e) {}
  }
  return out;
}

/* The documents themselves, deduped. The same invoice is often in both roots (the sweep files
 * a copy next to the job, Paul keeps the original), and the crew sometimes photograph a PO that
 * was already filed as a PDF. Showing it twice makes a job look like it bought twice as much.
 * Dedupe by Drive file id first, then by a normalised name+size, which catches real copies. */
function jobPoDocs_(jobSite, poNumber, rowDocs) {
  var docs = [], seenId = {}, seenKey = {};
  var norm = function (s) { return lc_(s).replace(/\.(pdf|jpe?g|png)$/, '').replace(/[^a-z0-9]/g, ''); };
  var push = function (f) {
    var id = f.getId(); if (seenId[id]) return; seenId[id] = 1;
    var key = norm(f.getName()) + '|' + f.getSize();
    if (seenKey[key]) return; seenKey[key] = 1;
    docs.push({ name: f.getName(), url: f.getUrl(), id: id,
      date: fmtDate_(f.getDateCreated()),
      kind: String(f.getMimeType()).indexOf('image') >= 0 ? 'photo' : 'pdf' });
  };
  jobPoFolders_(jobSite, poNumber).forEach(function (folder) {
    try { var it = folder.getFiles(); while (it.hasNext()) push(it.next()); } catch (e) {}
  });
  // Links already recorded on the Job POs rows — usually the same files, occasionally one that
  // was filed somewhere else entirely, so fold them in under the same dedupe.
  (rowDocs || []).forEach(function (url) {
    var m = String(url || '').match(/[-\w]{25,}/);
    if (!m || seenId[m[0]]) return;
    try { push(DriveApp.getFileById(m[0])); } catch (e) {}
  });
  docs.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  return docs;
}

function jobMaterials_(user, p) {
  var site = lc_(p.jobSite || ''), po = lc_(p.poNumber || '');
  var showP = canSeePrices_(user);
  var match = function(rowSite, rowPo){
    return (site && lc_(rowSite) === site) || (po && lc_(rowPo) === po);
  };
  var bought = [], used = [], folderUrl = '';
  var posSh = plTab_(POS_TAB, POS_HEADERS), lastP = posSh.getLastRow();
  if (lastP >= 2) posSh.getRange(2,1,lastP-1,POS_HEADERS.length).getValues().forEach(function(r){
    if (!match(r[2], r[3])) return;
    var o = { date: r[1], supplier: r[4], invoice: r[5], sku: r[6], desc: r[7], qty: Number(r[8])||0, doc: r[11] };
    if (showP) o.price = Number(r[9])||0;
    bought.push(o);
  });
  var useSh = plTab_(USE_TAB, USE_HEADERS), lastU = useSh.getLastRow();
  if (lastU >= 2) useSh.getRange(2,1,lastU-1,USE_HEADERS.length).getValues().forEach(function(r){
    if (!match(r[2], r[3])) return;
    var o = { id: r[0], date: r[1], sku: r[4], desc: r[5], qty: Number(r[6])||0, who: r[8], status: r[9] };
    if (showP) o.price = Number(r[7])||0;
    used.push(o);
  });
  var folders = [], docs = [];
  if (p.withFolder) {
    try {
      folders = jobPoFolders_(p.jobSite, p.poNumber).map(function (f) {
        return { name: f.getName(), url: f.getUrl() };
      });
      if (folders.length) folderUrl = folders[0].url;   // kept for older app builds
      docs = jobPoDocs_(p.jobSite, p.poNumber, bought.map(function (b) { return b.doc; }));
    } catch (e) {}
  }
  return { bought: bought, used: used, folderUrl: folderUrl, folders: folders, docs: docs };
}

/* ============================================================================================
 * v71 - THE PARTS THAT WERE BOUGHT FOR THIS JOB  (action: "jobParts")
 *
 * Charles, 21 Oct: clocked in to a job, the materials screen should open with the parts off that
 * job's own supplier POs, so he ticks off what actually went in rather than searching the whole
 * shelf for things he knows he bought for this job. Whatever he does not log stays where it
 * already is - in inventory - because every purchase, job-filed or not, is added to the count on
 * hand when its invoice is swept in (matUpsert_), and only logging a part as used takes it off.
 * So "if I do not use all of them, they go in the inventory" needs no new bookkeeping: the
 * leftover simply never leaves the shelf.
 *
 * One row per part, not one per invoice line: the House on the Hill job has the same wire on four
 * EECOL invoices, and what the person needs to see is "bought 150 m, 60 logged, 90 left".
 *   bought  = every Job POs line for this job (by PO number, or by job site when there is no PO)
 *   used    = every Job usage line for this job, minus anything flagged to go back to the supplier
 *   left    = bought - used, floored at zero
 *   onHand  = the shop count for that part, which is a different number and says so
 * Crew get no prices and no invoice numbers (canSeePrices_); the part, the supplier and how much
 * is left are theirs to see, the paperwork is not.
 * ==========================================================================================*/
function jobParts_(user, p) {
  p = p || {};
  var site = lc_(p.jobSite || ''), po = lc_(p.poNumber || '');
  if (!site && !po) return { parts: [], jobSite: '', poNumber: '' };
  var showP = canSeePrices_(user);
  var match = function (rowSite, rowPo) {
    return (po && lc_(rowPo) === po) || (site && lc_(rowSite) === site);
  };
  var keyOf = function (sku, desc) { return String(sku || '').trim().toUpperCase() || lc_(desc); };
  var map = {}, order = [];

  var posSh = plTab_(POS_TAB, POS_HEADERS), lastP = posSh.getLastRow();
  if (lastP >= 2) posSh.getRange(2, 1, lastP - 1, POS_HEADERS.length).getValues().forEach(function (r) {
    if (!match(r[2], r[3])) return;
    var k = keyOf(r[6], r[7]); if (!k) return;
    var rec = map[k];
    if (!rec) { rec = map[k] = { sku: String(r[6] || '').trim(), desc: String(r[7] || '').trim(),
      bought: 0, used: 0, sups: [], invs: [], last: '', price: 0 }; order.push(k); }
    rec.bought += Number(r[8]) || 0;
    if (!rec.desc) rec.desc = String(r[7] || '').trim();
    if (!rec.sku) rec.sku = String(r[6] || '').trim();
    var sup = String(r[4] || '').trim(); if (sup && rec.sups.indexOf(sup) < 0) rec.sups.push(sup);
    var inv = String(r[5] || '').trim(); if (inv && rec.invs.indexOf(inv) < 0) rec.invs.push(inv);
    var d = dstr_(r[1]); if (d && d > rec.last) { rec.last = d; }
    var pr = Number(r[9]) || 0; if (pr) rec.price = pr;                 // the latest line's price
  });
  if (!order.length) return { parts: [], jobSite: p.jobSite || '', poNumber: p.poNumber || '' };

  var useSh = plTab_(USE_TAB, USE_HEADERS), lastU = useSh.getLastRow();
  if (lastU >= 2) useSh.getRange(2, 1, lastU - 1, USE_HEADERS.length).getValues().forEach(function (r) {
    if (!match(r[2], r[3])) return;
    // "to return - awaiting credit note" is stock going back to the supplier, not parts that
    // went into the job. A negative row is a correction and is meant to subtract.
    if (lc_(r[9]).indexOf('to return') === 0) return;
    var k = keyOf(r[4], r[5]);
    if (!k || !map[k]) return;              // used something that came off the shelf, not off this job's POs
    map[k].used += Number(r[6]) || 0;
  });

  var iv = matRows_(), bySku = {}, byDesc = {};
  iv.rows.forEach(function (r) {
    var sk = String(r[M_SKU-1] || '').trim().toUpperCase(); if (sk && !bySku[sk]) bySku[sk] = r;
    var d = lc_(r[M_DESC-1]); if (d && !byDesc[d]) byDesc[d] = r;
  });
  var r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
  var parts = order.map(function (k) {
    var rec = map[k];
    var row = bySku[String(rec.sku || '').toUpperCase()] || byDesc[lc_(rec.desc)] || null;
    // v80 - the name a person uses, kept apart from the supplier's shouting. The app shows the
    // plain one and puts the supplier text underneath it in small type; before this there was
    // only "ABB BC52151-K 4IN SQ. BOX C/W COMBO KNOCKOUTS" and no way to show anything shorter.
    var o = { sku: rec.sku || (row ? String(row[M_SKU-1] || '') : ''), desc: rec.desc,
      name: row ? String(row[M_DESC-1] || '').trim() : '',
      unit: row ? String(row[M_UNIT-1] || '') : '',
      bought: r2(rec.bought), used: r2(rec.used), left: r2(Math.max(0, rec.bought - rec.used)),
      onHand: row ? r2(row[M_INV-1]) : null,
      supplier: rec.sups.join(', '), date: rec.last };
    if (showP) { o.price = r2(rec.price); o.invoice = rec.invs.join(', '); }
    return o;
  });
  // Anything still outstanding first - that is what somebody standing on the job needs.
  parts.sort(function (a, b) {
    if ((a.left > 0) !== (b.left > 0)) return a.left > 0 ? -1 : 1;
    return lc_(a.desc) < lc_(b.desc) ? -1 : 1;
  });
  return { parts: parts, jobSite: p.jobSite || '', poNumber: p.poNumber || '' };
}

/* ------------------------- Daily supplier-email sweep (time trigger) --------------------------
 * Run setupDailySweep() ONCE from the editor (as Paul) — it installs a daily ~12:00 trigger and
 * that run also grants the Gmail permission.
 *
 * v29 — reads QUOTES as well as invoices. The Gmail search still finds threads by supplier
 * domain (CONFIG.SUPPLIER_FROM); inside a thread only messages whose SENDER is at a supplier
 * domain are read (CONFIG.SUPPLIER_DOMAINS) — a rep's own address in a reply thread counts,
 * Paul's own replies do not. Subjects are never matched: "Quote", "Quotation", "Estimate",
 * EECOL's "Pro 0267382" and a bare reply all look the same to us; the PDF says what it is.
 *
 * Each processed MESSAGE is recorded on the price list's hidden "Sweep log" tab, so a revised
 * quote arriving as a reply in an already-handled thread is still picked up (thread labels
 * alone would have hidden it). Threads processed before this log existed are skipped by date.
 * ----------------------------------------------------------------------------------------- */
function setupDailySweep() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'sweepSupplierEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sweepSupplierEmails').timeBased().everyHours(2).create();   // v91 - was a stray hourly one; 12 a day
  sweepSupplierEmails();
}
/* Run this from the editor to see exactly what the sweep does and why. Returns a readable
 * summary — the Apps Script execution log shows it, and it is also written to the Activity Log. */
/* The editor's test runs the sweep ITSELF, not the wrapper above, so a failure shows you the
   real error instead of being swallowed as a wobble. */
function testSweep() { var r = sweepSupplierEmailsRun_(); Logger.log(r); return r; }

function sweepLogTab_() {
  var sh = plTab_(SWEEP_TAB, ['Message ID', 'Processed', 'From', 'Subject', 'Result']);
  try { if (!sh.isSheetHidden()) sh.hideSheet(); } catch (e) {}
  return sh;
}
function senderDomainOk_(from) {
  var f = String(from || '').toLowerCase();
  var addr = /<([^>]+)>/.exec(f);                     // "Robbie Bergersen <robbie.bergersen@eecol.com>" — the address, not the display name
  var m = /@([^>\s]+)/.exec(addr ? addr[1] : f);
  var dom = m ? m[1] : '';
  return !!dom && (CONFIG.SUPPLIER_DOMAINS || []).some(function(d){ return dom.indexOf(lc_(d)) >= 0; });
}
function labelOrCreate_(name) {
  try { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); } catch (e) { return null; }
}

/* ============================================================================================
 * v73 - WHEN GOOGLE HICCUPS, DO NOT WAKE ANYBODY.
 *
 * The trigger that runs this fires every hour, and Apps Script mails a DAILY digest of any run
 * that ended in an error. On 20 Oct at 20:02 one run died on "We're sorry, a server error
 * occurred" - Google's own backend, nothing to do with this script - and the 21:02 run picked up
 * everything it had missed, because every message this sweep reads is recorded on the Sweep log
 * and the next run re-reads the same threads. One failure in about 190 runs that week, and the
 * only trace of it was an email the next morning about something already fixed.
 *
 * So a TRANSIENT failure is now caught, written to the Activity Log, and swallowed: Google sees
 * a clean run and sends nothing. It is rethrown - and therefore reported - only once it has
 * failed SWEEP_GIVEUP_ times in a row, which means it is NOT recovering on its own and somebody
 * does need to know. Anything that is not a Google wobble (a bug, a missing tab, a permission
 * taken away, execution time exceeded) is rethrown at once: those never self-heal, and hiding
 * them is how a broken sweep stays broken for a month.
 *
 * Charles, 22 Oct: "if one of the sweep gets what was missed, I would prefer to not be told."
 * ==========================================================================================*/
var SWEEP_TRANSIENT_ = /server error|internal error|please wait a bit|try again later|temporarily unavailable|timed ?out|invoked too many times|rate limit|backend error|failed while accessing document|currently being edited|lock timeout|acquire(?: the)? lock/i;
var SWEEP_FAIL_KEY_ = 'sweepFails';
var SWEEP_GIVEUP_ = 3;
function sweepSupplierEmails() {
  var props = null, fails = 0;
  try { props = PropertiesService.getScriptProperties(); fails = Number(props.getProperty(SWEEP_FAIL_KEY_) || 0); } catch (e) {}
  try {
    var out = sweepSupplierEmailsRun_();
    if (props && fails) { try { props.deleteProperty(SWEEP_FAIL_KEY_); } catch (e) {} }   // working again
    return out;
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (!SWEEP_TRANSIENT_.test(msg)) {
      try { log_({ email: 'daily-sweep' }, 'sweepSupplierEmails', '', '', 'FAILED, not a Google wobble: ' + msg); } catch (e) {}
      throw err;
    }
    fails++;
    if (props) { try { props.setProperty(SWEEP_FAIL_KEY_, String(fails)); } catch (e) {} }
    var note = 'Google wobbled: ' + msg + ' | run ' + fails + ' of ' + SWEEP_GIVEUP_ + ' in a row - ' +
      (fails >= SWEEP_GIVEUP_ ? 'it is not recovering, reporting it.'
                              : 'the next run picks up whatever this one missed, nobody emailed.');
    try { log_({ email: 'daily-sweep' }, 'sweepSupplierEmails', '', '', note); } catch (e) {}
    if (fails >= SWEEP_GIVEUP_) throw err;
    return note;
  }
}
function sweepSupplierEmailsRun_(opts) {
  opts = opts || {};
  var rep = { threads: 0, pdfs: 0, filed: 0, dup: 0, quotes: 0, skipped: 0, review: 0, failed: 0, errors: [], days: Number(opts.days) || 4 };
  plMigrate_();                                            // layout first, before any lock is taken
  var doneLabel = labelOrCreate_(CONFIG.SUPPLIER_DONE_LABEL);
  if (!doneLabel) rep.errors.push('could not find or create label "' + CONFIG.SUPPLIER_DONE_LABEL + '" — nothing will be marked processed');
  var quoteLabel = labelOrCreate_(CONFIG.QUOTE_DONE_LABEL);
  var reviewLabel = labelOrCreate_(CONFIG.SUPPLIER_REVIEW_LABEL);
  // Two bounded searches: threads not yet handled (as before), plus handled threads that have
  // had a NEW message in the window — a revised quote in a reply. The per-message log decides
  // what inside them is actually new (messages already logged cost nothing).
  var base = 'in:anywhere has:attachment filename:pdf newer_than:' + rep.days + 'd ' + CONFIG.SUPPLIER_FROM;
  var qA = base + ' -label:"' + CONFIG.SUPPLIER_DONE_LABEL + '"';
  var qB = base + ' label:"' + CONFIG.SUPPLIER_DONE_LABEL + '"';
  rep.query = qA + '  ||  ' + qB;
  var threads = [], seenTh = {};
  [qA, qB].forEach(function(qq){
    try { GmailApp.search(qq, 0, 30).forEach(function(t){ var id = t.getId(); if (!seenTh[id]) { seenTh[id] = 1; threads.push(t); } }); }
    catch (e) { rep.errors.push('search failed: ' + e.message); }
  });
  rep.threads = threads.length;
  var jobsByPo = {};
  try {
    // v41 - one shared index (see poJobIndex_): every PO Log row counts, named or not, and a
    // job number that is not on the PO Log yet still files to its own job-number folder.
    jobsByPo = poJobIndex_();
  } catch (e) { rep.errors.push('PO Log could not be read (' + e.message + ') — everything files to Stock this run'); }
  // The per-message log. A thread already carrying the "processed" label is re-examined only
  // when it has a message inside the window (query B); messages in it that were already read are
  // in the log and skipped. On the very first run after v29 the last few days of handled threads
  // are re-read once — invoices and quotes dedupe on supplier + number, so nothing doubles.
  var logSh = sweepLogTab_(), seenMsg = {};
  try {
    var n = logSh.getLastRow() - 1;
    if (n > 0) logSh.getRange(2, 1, n, 1).getValues().forEach(function(v){ if (v[0]) seenMsg[String(v[0])] = 1; });
  } catch (e) { rep.errors.push('Sweep log could not be read (' + e.message + ') — handled emails may be re-read this run'); }
  // v91 - a one-off re-read of named messages (refileSkippedSupplierInvoices): their threads join
  // this run and their "already read" marks are lifted.
  (opts.retryMids || []).forEach(function (mid) {
    mid = String(mid || '').replace(/^'/, '').trim(); if (!mid) return;
    delete seenMsg[mid];
    try { var th = GmailApp.getMessageById(mid).getThread(); if (!seenTh[th.getId()]) { seenTh[th.getId()] = 1; threads.push(th); rep.threads++; } }
    catch (e) { rep.errors.push('could not open message ' + mid + ': ' + e.message); }
  });
  var logRows = [];
  var sys = { email: 'daily-sweep', role: 'admin', permissions: {} };
  threads.forEach(function(th){
    var handledPO = false, handledQuote = false, needsReview = false, threadFailed = false, subj = '';
    try { subj = th.getFirstMessageSubject(); } catch (e) {}
    var msgs = [];
    try { msgs = th.getMessages(); } catch (e) { rep.errors.push('could not open "' + subj + '": ' + e.message); return; }
    msgs.forEach(function(msg){
      var mid = '', from = '', when = null;
      try { mid = msg.getId(); from = msg.getFrom(); when = msg.getDate(); } catch (e) {}
      if (!mid || seenMsg[mid]) return;
      if (!senderDomainOk_(from)) return;                            // Paul's own reply, a forward…
      var results = [], settled = false, failed = false;            // settled = a PDF reached a final outcome; failed = one did not
      var atts = [];
      try { atts = msg.getAttachments({ includeInlineImages: false }); }
      catch (e) { rep.errors.push('could not read attachments of "' + subj + '": ' + e.message); failed = true; }
      atts.forEach(function(att){
        if (String(att.getContentType()).indexOf('pdf') < 0) return;
        rep.pdfs++;
        try {
          var ex = geminiExtractDoc_(Utilities.base64Encode(att.getBytes()), 'application/pdf', when);
          // v91 - checked Nov 7: the three Home Hardware "Sales Invoice" emails this sweep leaves alone
          // (Ref 1229278, 1230501, 1232014) are HOUSE-ACCOUNT PAYMENT receipts - PRO paying its HH
          // account - with no material lines, so "other" is right and nothing was lost. Do not force
          // them to invoices: a payment line would be filed as a purchase.
          if (ex.docType === 'other' || !ex.items.length) {
            rep.skipped++;
            var why = subj + ' / ' + att.getName() + ' → read as "' + ex.docType + '" with ' + ex.items.length + ' item(s); left alone';
            rep.errors.push(why); results.push(why); settled = true;
            return;
          }
          var sup = ex.supplierName;
          if (!ex.date) {                                             // v29 — implausible date: do not file
            rep.review++; needsReview = true;
            var msgR = 'NEEDS REVIEW: ' + sup + ' ' + docLabel_(ex.docType, ex.invoiceNo) + ' — ' + ex.dateFlag +
              ' Not filed; scan it in the app to confirm the date.';
            rep.errors.push(msgR); results.push(msgR); settled = true;
            return;
          }
          var hit = poRefResolve_(jobsByPo, ex.poRef);                 // v47 - job number, then PO Log name, then last digits
          var jobSite = (hit && hit.site) ? hit.site : 'Stock';       // never file to a blank job
          var url = filePoDoc_(att.copyBlob(), ex.docType === 'quote' ? (hit ? hit.site : '') : jobSite, sup,
            ex.invoiceNo, ex.date, hit ? hit.po : '', ex.docType, ex.poRef);
          var res = withLock_(function(){ return docFile_(sys, jobSite, hit ? hit.po : '', ex, 'email sweep', url); });
          var line;
          if (res.duplicate) rep.dup++;
          if (ex.docType === 'quote') {
            if (!res.duplicate) rep.quotes++;
            handledQuote = true;
            line = 'QUOTE: ' + sup + ' ' + docLabel_('quote', ex.invoiceNo) + ' (' + ex.date + ') → ' +
              (res.duplicate ? 'already on file' : (res.replaced ? 'revised — replaced, ' : '') + res.added + ' price(s)');
          } else {
            if (!res.duplicate) rep.filed++;
            handledPO = true;
            line = 'OK: ' + sup + ' ' + docLabel_(ex.docType, ex.invoiceNo) + ' (' + ex.date + ') → ' + jobSite +
              ' (' + (res.duplicate ? 'already filed' : res.added + ' item(s)') + ')';
          }
          if (!url) line += ' [PDF NOT saved to Drive]';
          var refNote = poRefNote_(hit, ex.poRef); if (refNote) line += ' [' + refNote + ']';
          if (res.warn) line += ' [' + res.warn + ']';
          rep.errors.push(line); results.push(line); settled = true;
        } catch (e) {
          var f = 'FAILED on "' + subj + '" / ' + att.getName() + ': ' + (e && e.message ? e.message : e);
          rep.errors.push(f); results.push(f); failed = true; rep.failed++;   // retried tomorrow
        }
      });
      // A message is logged (never re-read) only when every PDF in it reached a final outcome.
      // One transient failure (AI 429, Drive hiccup) leaves the whole message for tomorrow; the
      // PDFs that did succeed dedupe on supplier + number when they are read again.
      if (failed) threadFailed = true;
      else if (settled) {
        seenMsg[mid] = 1;
        logRows.push(["'" + mid, fmtDate_(new Date()), String(from).slice(0, 80), String(subj).slice(0, 120), results.join(' | ').slice(0, 900)]);
      }
    });
    // Invoices: one pass, everything done — items into inventory + price history, PDF into the
    // customer's folder, and the email filed exactly as Paul's classifier filed it —
    // '3. Bills - Invoices', marked read, out of the inbox. 'App/POs processed' is the marker.
    // Quotes: labelled 'App/Quotes processed' (+ the processed marker) but LEFT in the inbox,
    // unread — Paul is usually still acting on a quote. A thread that needs a person gets the
    // review label and is left where it is, unread.
    // The "processed" marker is withheld while any PDF in the thread failed transiently, so
    // query A finds the thread again tomorrow (archived or not — the search is in:anywhere).
    try {
      if (handledQuote && quoteLabel) th.addLabel(quoteLabel);
      if (handledPO) {
        var filed = GmailApp.getUserLabelByName(CONFIG.SUPPLIER_FILED_LABEL);
        if (filed) th.addLabel(filed);
        else rep.errors.push('label "' + CONFIG.SUPPLIER_FILED_LABEL + '" not found — left unfiled');
        if (!needsReview && !threadFailed) { try { th.markRead(); } catch (e) {} th.moveToArchive(); }   // a review thread stays in the inbox
      }
      if ((handledPO || handledQuote) && !threadFailed && doneLabel) th.addLabel(doneLabel);
      if (needsReview && reviewLabel) th.addLabel(reviewLabel);
    } catch (e) { rep.errors.push('could not label "' + subj + '": ' + e.message); }
  });
  if (logRows.length) {
    try { logSh.getRange(logSh.getLastRow()+1, 1, logRows.length, 5).setValues(logRows); }
    catch (e) { rep.errors.push('Sweep log could not be written (' + e.message + ') — these emails will be re-read tomorrow'); }
  }
  var summary = 'sweep: ' + rep.threads + ' thread(s), ' + rep.pdfs + ' PDF(s), ' + rep.filed +
    ' invoice(s) filed, ' + rep.quotes + ' quote(s), ' + rep.dup + ' already on file, ' + rep.skipped + ' skipped, ' +
    rep.review + ' need review, ' + rep.failed + ' failed (retry tomorrow). ' + rep.errors.join(' | ');
  // Failures used to vanish without trace; now every run leaves a line you can read.
  try { log_({ email: 'daily-sweep' }, 'sweepSupplierEmails', '', '', summary); } catch (e) {}
  return summary;
}

/* ------------------------- One-time repair, Sept 2026 (run from the editor) -----------------
 * The old sweep read EECOL's "09/10/26" and Bartle & Gibson's "11/09/26" as year-first and
 * filed four September-2026 invoices under 2009, 2011 and August. Corrections, confirmed
 * against the emails the PDFs arrived in (EECOL mails invoices at ~01:00 the next morning,
 * Billtrust at ~02:30):
 *   EECOL PR 0443558, PR 0443559   2009-10-26 → 2026-09-10
 *   B&G 14501305                   2011-09-26 → 2026-09-11
 *   B&G 14494442                   2026-08-09 → 2026-09-08
 * Fixes the rows on Price history and Job POs, then re-derives Price / Price source / Last
 * bought from / Last bought / Lowest / Highest for every SKU those documents touched from the
 * full history (newest price wins), and refreshes those rows on Best price.
 * Safe to run more than once. Returns a readable summary. */
function repairBadPurchaseDates() { return withLock_(repairBadPurchaseDatesLocked_); }
function repairBadPurchaseDatesLocked_() {
  plMigrate_();
  var fixes = [
    { sup: 'EECOL', no: 'PR 0443558', date: '2026-09-10' },
    { sup: 'EECOL', no: 'PR 0443559', date: '2026-09-10' },
    { sup: 'Bartle & Gibson', no: '14501305', date: '2026-09-11' },
    { sup: 'Bartle & Gibson', no: '14494442', date: '2026-09-08' }
  ];
  var byKey = {}; fixes.forEach(function(f){ byKey[docKey_(f.sup, f.no)] = f.date; });
  var out = [], touched = {};
  var hist = histTab_(), n = hist.getLastRow() - 1;
  if (n > 0) {
    var hv = hist.getRange(2, 1, n, H_COLS).getValues(), fixedH = 0;
    hv.forEach(function(h, i){
      var d = byKey[docKey_(h[H_SUP-1], h[H_DOC-1])]; if (!d) return;
      touched[String(h[H_SKU-1])] = 1;
      if (dstr_(h[H_DATE-1]) !== d) { hist.getRange(i + 2, H_DATE).setValue(d); fixedH++; }
    });
    out.push('Price history: ' + fixedH + ' date(s) corrected');
  }
  var pos = plTab_(POS_TAB, POS_HEADERS), np = pos.getLastRow() - 1;
  if (np > 0) {
    var pv = pos.getRange(2, 1, np, POS_HEADERS.length).getValues(), fixedP = 0;
    pv.forEach(function(r, i){
      var d = byKey[docKey_(r[4], r[5])]; if (!d) return;
      if (dstr_(r[1]) !== d) { pos.getRange(i + 2, 2).setValue(d); fixedP++; }
    });
    out.push('Job POs: ' + fixedP + ' date(s) corrected');
  }
  // Those same invoices also exposed the part-number substring bug: EECOL's 1-gang box
  // (BC2104-LLE) was filed under the 2-gang box's SKU (BC2104-LLE-2). Give it its own row.
  out.push(splitPartOutOfSku_('BOX-007', 'EECOL', 'BC2104-LLE', '2-1/2" deep 1G device box', touched));
  var skus = Object.keys(touched);
  out.push('Re-pricing ' + skus.length + ' SKU(s): ' + rebuildSkuPricing_(skus));
  bestPriceRefresh_(skus);
  try { CacheService.getScriptCache().remove('materials_v3'); } catch (e) {}
  var summary = out.join(' | ');
  Logger.log(summary);
  try { log_({ email: 'repair' }, 'repairBadPurchaseDates', '', '', summary); } catch (e) {}
  return summary;
}
/* Moves every history / Job POs line whose supplier part number is EXACTLY `partNo` out of
 * `fromSku` into a brand-new SKU, moving the quantity bought with it. Idempotent: does nothing
 * once no such line is left under fromSku. `touched` (optional) collects SKUs to re-price. */
function splitPartOutOfSku_(fromSku, supplier, partNo, newDesc, touched) {
  var hist = histTab_(), n = hist.getLastRow() - 1, moveH = [], docs = {};
  if (n > 0) hist.getRange(2, 1, n, H_COLS).getValues().forEach(function(h, i){
    if (String(h[H_SKU-1]) !== fromSku) return;
    if (!partEq_(String(h[H_PART-1] || ''), partNo)) return;          // same whole-word test the matcher uses (IBV BC2104-LLE counts, BC2104-LLE-2 does not)
    moveH.push(i + 2);
    docs[docKey_(h[H_SUP-1], h[H_DOC-1]) + '|' + lc_(h[H_DESC-1])] = 1;
  });
  if (!moveH.length) return fromSku + ': nothing to split';
  var iv = matRows_(), fromIdx = -1, existing = -1;
  for (var i = 0; i < iv.rows.length; i++) {
    var sk = String(iv.rows[i][M_SKU-1]);
    if (sk === fromSku) fromIdx = i;
    else if (existing < 0 && matFind_([iv.rows[i]], supplier, partNo, '') === 0) existing = i;   // a half-done earlier run already made the row
  }
  if (fromIdx < 0) return fromSku + ': row not found';
  var from = iv.rows[fromIdx], cat = fromSku.replace(/-.*$/, '');
  var newSku = existing >= 0 ? String(iv.rows[existing][M_SKU-1]) : nextSku_(cat, iv.rows);
  // Job POs lines for the same supplier + document + description carry the quantities.
  var pos = plTab_(POS_TAB, POS_HEADERS), np = pos.getLastRow() - 1, posRows = [], movedQty = 0;
  if (np > 0) pos.getRange(2, 1, np, POS_HEADERS.length).getValues().forEach(function(r, i){
    if (String(r[6]) !== fromSku) return;
    if (!docs[docKey_(r[4], r[5]) + '|' + lc_(r[7])]) return;
    posRows.push(i + 2); movedQty += Number(r[8]) || 0;
  });
  // Materials first (the row that makes a re-run recognisable), then the pointers.
  if (existing < 0) {
    var row = new Array(M_COLS).fill('');
    row[M_SKU-1] = newSku; row[M_DESC-1] = txt_(newDesc); row[M_UNIT-1] = from[M_UNIT-1] || 'ea';
    row[M_INV-1] = Math.max(0, movedQty); row[M_PARTS-1] = supplier + ': ' + partNo;
    iv.sheet.appendRow(row);
  }                                                        // an existing row keeps its count — it was set when it was made
  var parts = String(from[M_PARTS-1] || '').split(/\s*·\s*/).filter(function(t){
    var m = /^([^:]+):\s*(.+)$/.exec(t.trim());
    return !(m && lc_(m[1]) === lc_(supplier) && partEq_(m[2], partNo));
  }).join(' · ');
  iv.sheet.getRange(fromIdx + 2, M_INV).setValue(Math.max(0, (Number(from[M_INV-1]) || 0) - movedQty));
  iv.sheet.getRange(fromIdx + 2, M_PARTS).setValue(parts);
  posRows.forEach(function(rowNo){ pos.getRange(rowNo, 7).setValue(newSku); });
  moveH.forEach(function(rowNo){ hist.getRange(rowNo, H_SKU).setValue(newSku); });
  if (touched) { touched[fromSku] = 1; touched[newSku] = 1; }
  return fromSku + ': ' + partNo + ' split out as ' + newSku + ' (' + moveH.length + ' history line(s), ' +
    posRows.length + ' PO line(s), ' + movedQty + ' moved to its inventory; Job usage rows untouched)';
}
/* Re-derive the price columns of the given SKUs from Price history alone: the latest row (by
 * date, then by sheet order) sets Price / Price source / Last bought from / Last bought; every
 * non-credit row feeds Lowest / Highest. Inventory and part numbers are left alone. */
function rebuildSkuPricing_(skus) {
  var want = {}; skus.forEach(function(s){ want[String(s)] = 1; });
  var hist = histTab_(), n = hist.getLastRow() - 1, latest = {}, lo = {}, hi = {};
  if (n > 0) hist.getRange(2, 1, n, H_COLS).getValues().forEach(function(h){
    var sku = String(h[H_SKU-1] || ''); if (!want[sku]) return;
    var price = Number(h[H_PRICE-1]) || 0; if (price <= 0 || lc_(h[H_CREDIT-1]) === 'yes') return;
    var date = dstr_(h[H_DATE-1]), sup = String(h[H_SUP-1] || '');
    var type = lc_(h[H_TYPE-1]) === 'quote' ? 'quote' : lc_(h[H_TYPE-1]) === 'receipt' ? 'receipt' : 'invoice';
    if (!latest[sku] || date >= latest[sku].date) latest[sku] = { date: date, price: price, sup: sup, src: docLabel_(type, h[H_DOC-1]) };
    if (!lo[sku] || price < lo[sku].price) lo[sku] = { price: price, sup: sup };
    if (!hi[sku] || price > hi[sku].price) hi[sku] = { price: price, sup: sup };
  });
  var iv = matRows_(), changed = 0;
  iv.rows.forEach(function(r, i){
    var sku = String(r[M_SKU-1] || ''); if (!want[sku] || !latest[sku]) return;
    var L = latest[sku];
    var vals = [[L.price, L.src, L.sup, L.date, lo[sku].price, lo[sku].sup, hi[sku].price, hi[sku].sup]];
    iv.sheet.getRange(i + 2, M_PRICE, 1, M_HISUP - M_PRICE + 1).setValues(vals);
    changed++;
  });
  return changed + ' row(s) updated';
}

/* ============================ ALLOWANCES (v18 rework) ========================================
 * Admin ticks which allowances a person may claim and sets the amounts in one place (Admin →
 * Allowance settings). Cellphone is posted automatically once a month and needs no approval —
 * it is a fixed monthly benefit, not a claim. Meals need a receipt photo and are capped at the
 * CRA reasonable amount. Mileage takes date, km and destination. ============================ */

function allowCfg_() {
  var d = { phone: 30, phoneEvery: 'month', meal: 23, mealNeedsPhoto: true, km: 0.60, other: 0 };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('allowCfg');
    if (raw) { var o = JSON.parse(raw); Object.keys(d).forEach(function(k){ if (o[k] !== undefined) d[k] = o[k]; }); }
  } catch (e) {}
  return d;
}
function allowCfgGet_(user){ requireAdmin_(user); return { cfg: allowCfg_() }; }
function allowCfgSet_(user, p) {
  requireAdmin_(user);
  var cur = allowCfg_(), next = {};
  ['phone','meal','km','other'].forEach(function(k){ next[k] = p[k] !== undefined ? Number(p[k]) || 0 : cur[k]; });
  next.phoneEvery = p.phoneEvery || cur.phoneEvery;
  next.mealNeedsPhoto = p.mealNeedsPhoto !== undefined ? !!p.mealNeedsPhoto : cur.mealNeedsPhoto;
  PropertiesService.getScriptProperties().setProperty('allowCfg', JSON.stringify(next));
  log_(user, 'allowCfgSet', '', '', JSON.stringify(next));
  return { cfg: next };
}

// Files a claim photo (meal receipts) into Drive → Allowances/<year-month>.
function allowPhoto_(user, p, label) {
  if (!p.dataBase64) return '';
  try {
    var master = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
    var it = master.getFoldersByName('Allowances');
    var folder = it.hasNext() ? it.next() : master.createFolder('Allowances');
    var ym = fmtDate_(new Date()).substring(0,7);
    var it2 = folder.getFoldersByName(ym);
    var sub = it2.hasNext() ? it2.next() : folder.createFolder(ym);
    var f = sub.createFile(Utilities.newBlob(Utilities.base64Decode(p.dataBase64),
      p.mimeType || 'image/jpeg', label + ' — ' + user.email.split('@')[0] + ' — ' + fmtDate_(new Date()) + '.jpg'));
    return f.getUrl();
  } catch (e) { return ''; }
}

/* Cellphone: posted automatically, already approved, once per calendar month, for anyone whose
 * permissions carry allowances.phone. Runs on bootstrap so it needs no separate trigger. */
/* Date cells are the single most common source of silent comparison bugs here: Sheets may hand
 * back a real Date, an ISO string, or a locale string like "Thu Sep 11 2026". Normalise to
 * YYYY-MM-DD before comparing anything. */
function dateKey_(v) {
  if (!v && v !== 0) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return fmtDate_(v);
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var d = new Date(s);
  return isNaN(d.getTime()) ? s : fmtDate_(d);
}

function allowMonthlyPhone_(user) {
  try {
    var perms = user.permissions || {};
    if (!perms.allowances || !perms.allowances.phone) return;
    var cfg = allowCfg_();
    if (!cfg.phone) return;
    var ym = fmtDate_(new Date()).substring(0,7);
    var props = PropertiesService.getScriptProperties();
    var pk = 'phoneAl_' + lc_(user.email);
    if (props.getProperty(pk) === ym) return;      // fast path: no sheet read at all
    withLock_(function(){                          // two phones opening at once must not both post
      if (props.getProperty(pk) === ym) return;
      var sh = allowSheet_(), last = sh.getLastRow();
      if (last >= 2) {
        var vals = sh.getRange(2,1,last-1,11).getValues();
        for (var i = 0; i < vals.length; i++) {
          // The Date column returns a real Date once Sheets has parsed it, so String() on it gives
          // "Thu Sep 11 2026…" — which is why the original comparison against "2026-09" never
          // matched and a row was appended on EVERY app open (v18 bug, fixed in v19).
          if (lc_(vals[i][1]) === lc_(user.email) && String(vals[i][3]) === 'phone' &&
              dateKey_(vals[i][2]).substring(0,7) === ym) { props.setProperty(pk, ym); return; }
        }
      }
      sh.appendRow([newId_(), user.email, fmtDate_(new Date()), 'phone', '', cfg.phone,
        'Monthly cellphone allowance', 'approved', new Date().toISOString(), 'automatic', new Date().toISOString()]);
      props.setProperty(pk, ym);
    });
  } catch (e) {}
}

/* One-time tidy-up for the v18 duplicate-cellphone bug: keeps the FIRST automatic phone row per
 * person per month and deletes the rest. Safe to run more than once; never touches a claim
 * anyone actually submitted (only rows stamped 'automatic'). Run it from the editor. */
function cleanupDuplicateAllowances() {
  var sh = allowSheet_(), last = sh.getLastRow();
  if (last < 2) { Logger.log('Nothing to clean.'); return 'Nothing to clean.'; }
  var vals = sh.getRange(2, 1, last - 1, 11).getValues();
  var keep = {}, drop = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[3]) !== 'phone' || String(r[9]) !== 'automatic') continue;
    var key = lc_(r[1]) + '|' + dateKey_(r[2]).substring(0, 7);
    if (keep[key]) drop.push(i + 2); else keep[key] = true;
  }
  for (var d = drop.length - 1; d >= 0; d--) sh.deleteRow(drop[d]);   // bottom-up: rows don't shift
  var msg = 'Removed ' + drop.length + ' duplicate cellphone row(s); kept ' + Object.keys(keep).length + '.';
  Logger.log(msg);
  return msg;
}

/* ============================ ALBERTA GENERAL HOLIDAY PAY ====================================
 * Alberta pays the AVERAGE DAILY WAGE: wages in the 4 weeks before the holiday ÷ days worked,
 * overtime excluded. A holiday only counts if it falls on a REGULAR day of work — the "5 of 9"
 * rule: the employee worked that weekday at least 5 times in the previous 9 weeks.
 * We post it as an approved entry on the holiday so payroll and the app both see it. ========= */

// Every employee row, without the permission gate listEmployees_ applies (internal use only).
function allEmployeeRecords_() {
  var sh = masterSheet_(SHEETS.EMPLOYEES), last = sh.getLastRow(), out = [];
  if (last < 2) return out;
  sh.getRange(2,1,last-1,6).getValues().forEach(function(r){
    if (!r[0]) return;
    out.push({ email: lc_(r[0]), name: r[1], role: r[2],
      active: r[3] === true || r[3] === 'TRUE' || r[3] === 'true',
      hourlyRate: Number(r[4]) || 0, permissions: safeJson_(r[5]) || {} });
  });
  return out;
}

function statPayRun_(user, p) {
  requireAdmin_(user);
  var year = Number(p.year) || new Date().getFullYear();
  var holidays = abHolidays_(new Date(year,0,1), new Date(year+1,0,1)); // [{date,name}]
  var emps = allEmployeeRecords_().filter(function(e){ return e.active; });
  var posted = [], skipped = [];
  holidays.forEach(function(h){
    var hd = new Date(h.date + 'T12:00:00');
    if (hd > new Date()) return;                  // future holidays wait their turn
    emps.forEach(function(emp){
      var res = statPayFor_(emp, h, hd);
      if (res.posted) posted.push(res); else skipped.push(res);
    });
  });
  log_(user, 'statPayRun', '', '', year + ': ' + posted.length + ' posted, ' + skipped.length + ' skipped');
  return { year: year, posted: posted, skipped: skipped };
}
function statPayFor_(emp, h, hd) {
  var name = emp.name || emp.email;
  var sh = getEmployeeSheet_(emp.email, false);
  if (!sh) return { posted: false, who: name, holiday: h.name, why: 'no timesheet tab' };
  var last = sh.getLastRow();
  var rows = last > ENTRY_HEADER_ROW
    ? sh.getRange(ENTRY_HEADER_ROW+1, 1, last-ENTRY_HEADER_ROW, ENTRY_HEADERS.length).getValues() : [];
  // already posted?
  for (var i = 0; i < rows.length; i++)
    if (String(rows[i][COL['Date']-1]).substring(0,10) === h.date &&
        /general holiday/i.test(String(rows[i][COL['Notes']-1] || '')))
      return { posted: false, who: name, holiday: h.name, why: 'already posted' };

  var dow = hd.getDay();
  var nineWeeksAgo = new Date(hd.getTime() - 63*86400000);
  var fourWeeksAgo = new Date(hd.getTime() - 28*86400000);
  var sameDowCount = 0, wages = 0, daysWorked = {};
  rows.forEach(function(r){
    var d = r[COL['Date']-1]; if (!d) return;
    var dt = new Date(String(d).substring(0,10) + 'T12:00:00');
    if (isNaN(dt)) return;
    var hrs = Number(r[COL['Hours']-1]) || 0;
    if (hrs <= 0) return;
    if (dt >= nineWeeksAgo && dt < hd && dt.getDay() === dow) sameDowCount++;
    if (dt >= fourWeeksAgo && dt < hd) {
      wages += hrs * (Number(emp.hourlyRate) || 0);
      daysWorked[String(d).substring(0,10)] = true;
    }
  });
  if (sameDowCount < 5)
    return { posted: false, who: name, holiday: h.name, why: 'not a regular work day (worked it ' + sameDowCount + ' of the last 9 weeks)' };
  var nDays = Object.keys(daysWorked).length;
  if (!nDays) return { posted: false, who: name, holiday: h.name, why: 'no days worked in the 4 weeks before' };
  var avgWage = wages / nDays;
  var rate = Number(emp.hourlyRate) || 0;
  var avgHours = rate > 0 ? Math.round((avgWage / rate) * 100) / 100 : 0;
  if (!avgHours) return { posted: false, who: name, holiday: h.name, why: 'no hourly rate set' };

  var row = new Array(ENTRY_HEADERS.length).fill('');
  row[COL['EntryID']-1] = newId_();
  row[COL['Date']-1] = h.date;
  row[COL['Day']-1] = dayName_(hd);
  row[COL['Hours']-1] = avgHours;
  row[COL['Gross Hours']-1] = avgHours;
  row[COL['Break Hrs']-1] = 0;
  row[COL['Company']-1] = (emp.permissions && emp.permissions.homeCompany) || CONFIG.COMPANIES[0];
  row[COL['Notes']-1] = 'General holiday pay — ' + h.name + ' (Alberta average daily wage)';
  row[COL['Status']-1] = 'approved';
  row[COL['Source']-1] = 'stat';
  row[COL['PeriodKey']-1] = periodKey_(hd);
  row[COL['Approved By']-1] = 'automatic';
  row[COL['Approved At']-1] = new Date().toISOString();
  sh.appendRow(row);
  return { posted: true, who: name, holiday: h.name, hours: avgHours,
    amount: Math.round(avgHours * rate * 100) / 100 };
}

/* ================= ESTIMATE / APPOINTMENT REQUESTS (from the website) =========================
 * The ball-park sequence no longer books straight onto the calendar. It files the lead here;
 * an admin checks the AI's hours, picks the slot, assigns the crew, and only THEN does the
 * calendar event get created and the crew notified. ========================================== */

var REQ_HEADERS = ['ID','Received','Entry #','Type','Customer','Phone','Email','Address','Scope',
  'Est. hours','Materials','Price low','Price high','Suggested start','Status','Scheduled start',
  'Scheduled end','Assigned','Event ID','Decided By','Decided At','Detail','Company','PO','Est. row',
  'Confirm','Confirm token','Notified at','Booked hours','Crew',
  'Bumped from','Bumped by','Told customer'];
// v46 — 'PO' and 'Est. row' were added for the estimate-to-job conversion. The live sheet predates
// them, so widen the header row in place rather than only writing it on a brand-new sheet.
function reqSheet_() {
  var sh = masterSheet_(SHEETS.REQUESTS);
  // A new tab has 26 columns and the layout is now 33 (v51 added three): reading or writing past
  // the last column throws, so grow the grid first. One-time; a no-op once done.
  if (sh.getMaxColumns() < REQ_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), REQ_HEADERS.length - sh.getMaxColumns());
  if (sh.getLastRow() === 0) { sh.getRange(1,1,1,REQ_HEADERS.length).setValues([REQ_HEADERS]).setFontWeight('bold'); return sh; }
  if (sh.getLastColumn() < REQ_HEADERS.length) {
    sh.getRange(1,1,1,REQ_HEADERS.length).setValues([REQ_HEADERS]).setFontWeight('bold');
  }
  return sh;
}
function reqRow_(id) {
  var t = reqScan_();                               // v61 - the shared copy, not a fresh read
  for (var i = 0; i < t.rows.length; i++)
    if (String(t.rows[i][0]) === String(id)) return { sheet: t.sheet, row: i + 2, values: t.rows[i] };
  return null;
}
// Called by the ball-park sequence (or by hand) to file a new lead.
function requestAdd_(user, p) {
  requireAdmin_(user);
  var sh = reqSheet_();
  // v90 - a request picked out of the inbox (entryNo "email:<threadId>") is filed once. The sweep
  // runs twice a day and the email stays in the inbox, so without this it would be filed every run.
  var en = String(p.entryNo || '').trim();
  if (/^email:/i.test(en)) {
    var lastR = sh.getLastRow();
    if (lastR >= 2) {
      var got = sh.getRange(2, 1, lastR - 1, 3).getValues();
      for (var gi = 0; gi < got.length; gi++)
        if (String(got[gi][2]).trim().toLowerCase() === en.toLowerCase()) return { id: got[gi][0], duplicate: true };
    }
  }
  var id = newId_();
  sh.appendRow([id, new Date().toISOString(), p.entryNo || '', p.type || 'ESTIMATE',
    txt_(p.customer || ''), txt_(p.phone || ''), txt_(p.email || ''), txt_(p.address || ''),
    txt_(p.scope || ''), Number(p.hours) || 0, txt_(p.materials || ''),
    Number(p.priceLow) || 0, Number(p.priceHigh) || 0, p.suggestedStart || '', 'pending',
    '', '', '', '', '', '', txt_(p.detail || ''), txt_(p.company || ''),
    '', '', '', '', '', '', Math.max(1, Number(p.crew) || 1)]);
  log_(user, 'requestAdd', p.customer || '', '', (p.type||'') + ' ' + (p.entryNo||''));
  return { id: id };
}
/* ============ WHAT THE PO LOG KNOWS AND THE APP DOES NOT (v83) ============================
 * Charles, 2 Nov: "why is the info recorded in the PO Log for Paddy not showing on the app?"
 *
 * Because it has only ever travelled one way. The app WRITES a booking's phone, email, address
 * and scope to the PO Log; nothing has ever read them back. R26195 is the case in point: the
 * Requests row carries the name, the time and the PO and nothing else, while the PO Log row
 * typed by hand has the email, the phone, 83368 RR 201 and the whole scope of work. The app was
 * showing a blank card beside a full sheet row.
 *
 * So a booking now falls back to its own PO Log row for anything it is missing. FALLBACK, never
 * overwrite: what the customer themselves put on the website form stays the truth, and the sheet
 * only fills the gaps. One read of the PO Log per call, shared by every row on it. */
var PO_FILL_ = null;
function poFillMap_() {
  if (PO_FILL_) return PO_FILL_;
  PO_FILL_ = {};
  try {
    var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.PO_SHEET_NAME);
    if (!sh) return PO_FILL_;
    poSyncCols_(sh);
    var last = sh.getLastRow();
    var width = Math.max(CONFIG.PO_NUMBER_COL, CONFIG.PO_CONTACT_COL || 0, CONFIG.PO_CUSTOMER_COL,
      CONFIG.PO_PROJECT_COL || 0, CONFIG.PO_EMAIL_COL || 0, CONFIG.PO_PHONE_COL || 0,
      CONFIG.PO_ADDRESS_COL || 0, CONFIG.PO_DESC_COL || 0, CONFIG.PO_STATUS_COL || 0);
    if (last < 2) return PO_FILL_;
    sh.getRange(1, 1, last, width).getValues().forEach(function (r) {
      var po = String(r[CONFIG.PO_NUMBER_COL-1] || '').trim();
      if (!po || lc_(po) === 'po number') return;
      PO_FILL_[po.toUpperCase()] = {
        contact: String(r[(CONFIG.PO_CONTACT_COL||1)-1] || '').trim(),
        company: String(r[CONFIG.PO_CUSTOMER_COL-1] || '').trim(),
        project: CONFIG.PO_PROJECT_COL ? String(r[CONFIG.PO_PROJECT_COL-1] || '').trim() : '',
        email:   CONFIG.PO_EMAIL_COL   ? String(r[CONFIG.PO_EMAIL_COL-1]   || '').trim() : '',
        phone:   CONFIG.PO_PHONE_COL   ? String(r[CONFIG.PO_PHONE_COL-1]   || '').trim() : '',
        address: CONFIG.PO_ADDRESS_COL ? String(r[CONFIG.PO_ADDRESS_COL-1] || '').trim() : '',
        scope:   CONFIG.PO_DESC_COL    ? String(r[CONFIG.PO_DESC_COL-1]    || '').trim() : '',
        status:  CONFIG.PO_STATUS_COL  ? String(r[CONFIG.PO_STATUS_COL-1]  || '').trim() : ''
      };
    });
  } catch (e) {}
  return PO_FILL_;
}
/* Fill the blanks on one packed booking from its PO Log row. Returns the same object. */
function poFill_(o) {
  if (!o || !o.po) return o;
  var row = poFillMap_()[String(o.po).trim().toUpperCase()];
  if (!row) return o;
  var fromLog = [];
  ['phone','email','address','scope','company'].forEach(function (k) {
    if (!String(o[k] || '').trim() && row[k]) { o[k] = row[k]; fromLog.push(k); }
  });
  if (!String(o.customer || '').trim() && (row.contact || row.company)) o.customer = row.contact || row.company;
  if (row.project && !String(o.project || '').trim()) o.project = row.project;
  if (row.status) o.poStatus = row.status;
  // The app says where a detail came from, so nobody wonders why a card filled itself in.
  if (fromLog.length) o.fromPoLog = fromLog;
  return o;
}

function requestList_(user, p) {
  requirePerm_(user, 'approveHours');
  var sh = reqSheet_(), last = sh.getLastRow();
  if (last < 2) return { requests: [] };
  var vals = sh.getRange(2,1,last-1,REQ_HEADERS.length).getValues();
  var want = p && p.all ? null : 'pending';
  var out = [], estimates = [], booked = [], collateral = [];   // v51
  var cutoff = Date.now() - 120 * 86400000;   // estimate calls stay bookable for ~4 months
  var pack = function (r) {
    return { id: r[0], received: r[1], entryNo: r[2], type: r[3], customer: r[4], phone: r[5],
      email: r[6], address: r[7], scope: r[8], hours: Number(r[9])||0, materials: r[10],
      priceLow: Number(r[11])||0, priceHigh: Number(r[12])||0, suggested: r[13], status: r[14],
      start: r[15], end: r[16], assigned: String(r[17]||'').split(',').filter(String), detail: r[21],
      company: r[22] || '', po: r[23] || '',
      confirm: String(r[25] || '') || 'none', notifiedAt: r[27] || '', bookedHours: Number(r[28]) || 0,
      crew: Math.max(1, Number(r[29]) || 1),
      bumpedFrom: r[30] || '', bumpedBy: r[31] || '', told: r[32] || '',     // v51
      project: '',
      // v57 - the calendar event id. Without it the Schedule tab can show a booking but has no
      // way to find the JOB behind it, which is why Move it and Cancel job only existed on the
      // Requests tab: a calendar event was a dead end.
      eventId: String(r[18] || '') };
  };
  var packed = pack;
  pack = function (r) { return poFill_(packed(r)); };   // v83 - the PO Log fills what is blank
  vals.forEach(function(r){
    // v46 — an estimate call that has been held but never turned into a job stays visible in its
    // own list, so "they said yes" has somewhere to land instead of being retyped by hand.
    var isOpenEstimate = String(r[14]) === 'scheduled' &&
      String(r[3]).toUpperCase() === 'ESTIMATE' && !String(r[23] || '').trim() &&
      (!r[15] || new Date(r[15]).getTime() > cutoff);
    if (isOpenEstimate) estimates.push(pack(r));
    // v46 — booked jobs from today on, so their confirmation colour is visible and a job the
    // customer knocked back can be moved without hunting through the calendar.
    var isBooked = String(r[14]) === 'scheduled' && String(r[3]).toUpperCase() === 'APPOINTMENT' &&
      r[15] && new Date(r[15]).getTime() > (Date.now() - 2 * 86400000);
    if (isBooked) booked.push(pack(r));
    if (want && String(r[14]) !== want) return;
    // v51 - a job that lost its slot to another booking is not a new lead: it is a job with a PO,
    // a customer who is expecting us, and no time. It gets its own group at the top of the tab.
    if (String(r[14]) === 'pending' && String(r[30] || '').trim()) { collateral.push(pack(r)); return; }
    if (String(r[3]).toUpperCase() === 'ESTIMATE' && String(r[14]) === 'pending') return;   // v89 - on the Estimates tab
    out.push(pack(r));
  });
  collateral.sort(function(a,b){ return String(a.bumpedFrom).localeCompare(String(b.bumpedFrom)); });
  out.sort(function(a,b){ return String(b.received).localeCompare(String(a.received)); });
  estimates.sort(function(a,b){ return String(b.start).localeCompare(String(a.start)); });
  booked.sort(function(a,b){ return String(a.start).localeCompare(String(b.start)); });
  var calls = [];
  try { if (user.role === 'admin') calls = callList_(user).calls; } catch (e) {}    // v40
  return { requests: out, estimates: estimates, booked: booked, calls: calls,
           collateral: collateral };    // v51
}

/* v46 — BOOK THE JOB AFTER AN ESTIMATE CALL.
 * The estimate call happened, the customer said yes, and the job needs a PO. Converting in place
 * keeps the customer details, the scope and the ball-park figures that were already checked once,
 * so nothing is retyped and the Estimate row and the PO Log row stay tied to the same lead.
 * The old estimate-call event is left alone — it happened. */
function requestBook_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values;
  if (String(v[14]) !== 'scheduled') throw new Error('That estimate call has not been scheduled yet — schedule it first.');
  if (String(v[23] || '').trim()) throw new Error('That one already has a PO (' + v[23] + ').');
  var hours = Number(p.hours) || Number(v[9]) || 1;
  var start = new Date(p.start);
  if (isNaN(start)) throw new Error('Pick a date and time.');
  var end = new Date(start.getTime() + hours * 3600000);

  var slotNote = slotGuard_(user, 'APPOINTMENT', start, end, '',
    { bump: !!p.bump, allowPast: !!p.allowPast });   // v36 a real job needs a real gap; v51 unless Paul said bump
  loc.sheet.getRange(loc.row, 4).setValue('APPOINTMENT');
  v[3] = 'APPOINTMENT';
  var crew = Math.max(1, Number(p.crew) || (p.assign || []).length || Number(v[29]) || 1);
  loc.sheet.getRange(loc.row, 29, 1, 2).setValues([[hours, crew]]); v[28] = hours; v[29] = crew;

  var title = reqEvTitle_(v, '');     // v89 - who it is; the job number goes on once it is minted below
  var body = [
    'Booked appointment — quoted first, customer approved.',
    'Customer: ' + v[4] + (v[5] ? ('  ·  ' + v[5]) : '') + (v[6] ? ('  ·  ' + v[6]) : ''),
    v[7] ? ('Address: ' + v[7]) : '',
    v[8] ? ('Scope: ' + v[8]) : '',
    'Estimated ' + hours + ' hr' + (hours === 1 ? '' : 's') +
      (Number(v[11]) ? ('  ·  quoted $' + Number(v[11]).toFixed(0) + '–$' + Number(v[12]).toFixed(0)) : ''),
    v[10] ? ('Materials: ' + v[10]) : '',
    v[15] ? ('Estimate call was ' + fmtDate_(v[15]) + '.') : '',
    v[23] ? ('PO: ' + v[23]) : '',   // v34 - the PO on the event, so a return visit can find its own booking
    '', 'Booked from the timesheet app by ' + user.email.split('@')[0] + '.'
  ].concat(detailAttachLines_(v[21]))          // v36 - the customer's photos + the original email
   .filter(function (x) { return x !== undefined && x !== null; }).join('\n');
  var cal = CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]);
  if (!cal) throw new Error('Cannot reach the calendar — Paul may need to re-approve calendar access.');
  var ev = cal.createEvent(title, start, end, { description: body, location: String(v[7] || '') });
  var evId = ev.getId();
  var emails = (p.assign || []).map(lc_).filter(String);
  if (emails.length) {
    try { scheduleAssign_(user, { eventId: evId, emails: emails, title: title,
      start: start.toISOString(), notify: p.notify !== false }); } catch (e) {}
  }

  // The job booking replaces the call on the request row; the call itself stays on the calendar.
  loc.sheet.getRange(loc.row, 16, 1, 6).setValues([[ start.toISOString(), end.toISOString(),
    emails.join(','), evId, user.email, new Date().toISOString() ]]);

  var po = null, poNote = '';
  try {
    po = poLogAddFromRequest_(v, start);
    poNote = 'PO ' + po.po + ' (' + po.type + ')';
    loc.sheet.getRange(loc.row, 24).setValue(po.po);
    title = reqEvTitle_(v, po.po); try { ev.setTitle(title); } catch (e) {}   // v89
    // v34 - the PO is minted AFTER the event exists, so stamp it on now. Without this the
    // calendar never carries the PO and a return visit cannot find the booking it continues.
    try { ev.setDescription(body + '\nPO: ' + po.po); } catch (e) {}
    var estRow = Number(v[24]) || 0;
    if (estRow) { var st = poEstimateMarkWon_(estRow, po.po); if (st) poNote += '  ·  ' + st; }
  } catch (e) { poNote = 'PO Log write FAILED: ' + e.message; }

  v[18] = evId;
  var bumped = [], bumpProblems = [];
  if (p.bump) {
    var brB = bumpToRequests_(user, start, end, evId, title);     // v51
    bumped = brB.sent; bumpProblems = brB.problems;
    if (bumped.length) bumpBackEmail_(bumped, title, start.toISOString());
  }
  var custNote = p.notifyCustomer === false ? '' : confirmNotifyCustomer_(loc, v, start, end, 'booked');
  log_(user, 'requestBook', v[4], '', title + ' @ ' + start.toISOString() + '  ·  ' + poNote +
    (custNote ? ('  ·  ' + custNote) : '') +
    (bumped.length ? ('  ·  ' + bumped.length + ' sent back to Requests') : ''));
  return { id: p.id, eventId: evId, start: start.toISOString(), end: end.toISOString(), title: title,
    po: po ? po.po : '', poNote: poNote, custNote: custNote, slotNote: slotNote,
    bumped: bumped, bumpProblems: bumpProblems };
}

/* Close the Estimate-tab row out as won, so the estimate list is not a graveyard of jobs that
 * were actually booked. Never throws — the PO Log row is what matters. */
function poEstimateMarkWon_(row, po) { return poEstimateSetStatus_(row, 'Won', po); }
function poEstimateSetStatus_(row, status, po) {
  // v91 - the tab's Status dropdown allows Requested / Sent / Accepted / Denied / Closed and refused
  // the 'Won' / 'Lost' / 'Cancelled' this code wrote, so no bid outcome ever landed.
  var EST_WORD_ = { won: 'Accepted', lost: 'Denied', cancelled: 'Closed', canceled: 'Closed' };
  status = EST_WORD_[lc_(status)] || status;
  try {
    var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
    var sh = poTab_(ss, CONFIG.PO_ESTIMATE_SHEET_NAME);
    if (!sh || !row) return '';
    var hdr = poHeader_(sh, 'project number');
    if (!hdr) return '';
    var c = hdr.col;
    if (c['status']) sh.getRange(row, c['status']).setValue(status);
    if (po && c['project number'] && !String(sh.getRange(row, c['project number']).getValue()).trim()) {
      sh.getRange(row, c['project number']).setValue(txt_(po));
    }
    return 'Estimate row ' + row + ' marked ' + status;
  } catch (e) { return 'Estimate row not updated: ' + e.message; }
}

/* ============================================================================================
 * PO LOG WRITE-BACK  (v23)
 * Approving a website lead used to stop at the calendar — Paul then retyped the same customer
 * into the PO Log by hand. Now the app writes it:
 *   APPOINTMENT -> burns the next PO number and fills the "PO Log" tab
 *   ESTIMATE    -> fills the "Estimate" tab (no PO number: nothing is booked yet)
 * Both happen only when a HUMAN taps Schedule, so a junk form submission can never consume a
 * PO number — that number becomes the QuickBooks invoice number and is permanent.
 * ==========================================================================================*/

/* Tab lookup that survives renaming. The live workbook's tabs have been called 'Estimate',
 * 'Estimates' and 'ProES - Estimate' at various points; an exact getSheetByName would return
 * null and the write would silently do nothing. */
function poTab_(ss, wanted) {
  var exact = ss.getSheetByName(wanted);
  if (exact) { if (lc_(wanted) === lc_(CONFIG.PO_SHEET_NAME)) poSyncCols_(exact); return exact; }
  var want = lc_(wanted), tabs = ss.getSheets();
  for (var i = 0; i < tabs.length; i++) if (lc_(tabs[i].getName()).indexOf(want) >= 0) return tabs[i];
  return null;
}

/* These tabs carry a title + PO-numbering-guide preamble above the real table, so the header
 * is NOT row 1. Find it by looking for a distinctive header label, and hand back both the row
 * number and a name->column map so a reordered column can never write into the wrong field. */
function poHeader_(sh, label) {
  var last = sh.getLastRow(), wide = Math.max(1, sh.getLastColumn());
  if (last < 1) return null;
  var vals = sh.getRange(1, 1, Math.min(last, 40), wide).getValues();
  var want = lc_(label);
  // v50 - a renamed or mistyped header no longer hides the table. Try the robust row finder
  // first; the exact scan below still runs when it finds nothing, so nothing changes on a
  // sheet nobody has touched.
  if (lc_(label) === 'po number') {
    var rr = poHeaderRow_(sh);
    if (rr) {
      var m0 = {};
      for (var q = 0; q < vals[rr - 1].length; q++) { var hq = lc_(vals[rr - 1][q]); if (hq) m0[hq] = q + 1; }
      for (var fk in PO_FIELDS_) {                     // logical keys too: cols['po number'] AND cols['po']
        var fc = hdrResolve_(vals[rr - 1], PO_FIELDS_[fk]);
        if (fc && !m0[PO_FIELDS_[fk][0]]) m0[PO_FIELDS_[fk][0]] = fc;
      }
      return { row: rr, col: m0 };
    }
  }
  for (var r = 0; r < vals.length; r++) {
    for (var c = 0; c < vals[r].length; c++) {
      if (lc_(vals[r][c]) === want) {
        var map = {};
        for (var i = 0; i < vals[r].length; i++) { var h = lc_(vals[r][i]); if (h) map[h] = i + 1; }
        return { row: r + 1, col: map };
      }
    }
  }
  return null;
}

/* First row at or below the header that has nothing in the key column. The PO Log is pre-seeded
 * with blank numbered rows, so appending at getLastRow() would leave a gap and skip them. */
function poFirstFreeRow_(sh, headerRow, keyCol) {
  var last = sh.getLastRow();
  if (last <= headerRow) return headerRow + 1;
  var vals = sh.getRange(headerRow + 1, keyCol, last - headerRow, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (!String(vals[i][0] || '').trim()) return headerRow + 1 + i;
  return last + 1;
}

/* Next PO number. The log runs ONE shared sequence across every type — R26155, I26156, C26157,
 * R26158 — so the counter is the highest ### in the whole column, whatever letter precedes it.
 * Taking the next free gap instead would hand out a number a later job is already entitled to. */
function poNextNumber_(prefix) {
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
  if (!sh) throw new Error('PO Log tab not found in the PO workbook.');
  var hdr = poHeader_(sh, 'po number');
  var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
  var last = sh.getLastRow(), max = 0;
  if (last > headerRow) {
    var vals = sh.getRange(headerRow + 1, CONFIG.PO_NUMBER_COL, last - headerRow, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var m = String(vals[i][0] || '').trim().match(/^([A-Za-z])(\d{2})(\d{3,})$/);
      if (m) { var n = parseInt(m[3], 10); if (n > max) max = n; }
    }
  }
  var yy = String(new Date().getFullYear()).slice(-2);
  var seq = String(max + 1);
  while (seq.length < CONFIG.PO_SEQ_MIN_DIGITS) seq = '0' + seq;
  return String(prefix || 'R').toUpperCase() + yy + seq;
}

/* Company name present -> Commercial, otherwise Residential (Charles, Sept 2026). Paul can
 * change the letter in the log; we never guess Industrial from a web form. */
function poTypeFor_(company) {
  return String(company || '').trim() ? 'Commercial' : 'Residential';
}

/* APPOINTMENT: burn a PO number and fill everything the form gave us. Locked, because two
 * admins approving at once would otherwise read the same highest number and both take it. */
function poLogAddFromRequest_(v, startIso) {
  return withLock_(function () {
    var company = String(v[22] || '').trim();
    // v102 - a new job for a customer we already have keeps the letter of the job it was picked
    // from (Fuel Co is I26156, so their next job is an I too); everyone else: company -> C, else R.
    var tm = /PO type: (Commercial|Residential|Industrial|Mix)\b/.exec(String(v[21] || ''));
    var type    = tm ? tm[1] : poTypeFor_(company);
    var prefix  = CONFIG.PO_TYPE_LETTERS[type] || 'R';
    var po      = poNextNumber_(prefix);
    var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
    var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
    var hdr = poHeader_(sh, 'po number');
    var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
    var row = poFirstFreeRow_(sh, headerRow, CONFIG.PO_NUMBER_COL);
    var put = function (col, val) { if (col && val !== '' && val != null) sh.getRange(row, col).setValue(txt_(val)); };
    put(CONFIG.PO_NUMBER_COL,    po);
    put(CONFIG.PO_CONTACT_COL,   v[4]);                       // Customer
    put(CONFIG.PO_CUSTOMER_COL,  company);                    // Company Name (blank on residential)
    // v67 - Project Name is left ALONE. This used to copy the whole scope paragraph from the
    // website form into it, and that column is what the crew now read on the job picker, so it
    // has to be the short name Paul gives the job - written by a person, or by us when asked,
    // never by the script on its own. The scope still goes in Description of Work below.
    put(CONFIG.PO_STARTDATE_COL, startIso ? fmtDate_(startIso) : '');
    put(CONFIG.PO_TYPE_COL,      type);
    put(CONFIG.PO_EMAIL_COL,     v[6]);
    put(CONFIG.PO_PHONE_COL,     v[5]);
    put(CONFIG.PO_ADDRESS_COL,   v[7]);
    put(CONFIG.PO_DESC_COL,      v[8]);
    put(CONFIG.PO_STATUS_COL,    'In progress');
    try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}  // so the job shows in the app now
    PO_WHO_MAP_ = null;                            // v53 - a new PO Log row exists now
    return { po: po, row: row, type: type };
  });
}

/* ESTIMATE: no PO number — nothing is booked. The row lands on the Estimate tab so Paul can
 * see what is out for quote and what it was ball-parked at. */
function poEstimateAddFromRequest_(v, startIso) {
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_ESTIMATE_SHEET_NAME);
  if (!sh) return { skipped: 'no Estimate tab in the PO workbook' };
  var hdr = poHeader_(sh, 'project number');
  if (!hdr) return { skipped: 'could not find the header row on the Estimate tab' };
  var c = hdr.col;
  var keyCol = c['status'] || c['project number'] || 1;
  var row = poFirstFreeRow_(sh, hdr.row, keyCol);
  var lo = Number(v[11]) || 0, hi = Number(v[12]) || 0;
  // One figure where the scenarios agree; the range as text where they don't, because writing
  // either end alone would quietly hide the swing the estimate is warning about.
  var cost = (lo && hi && Math.round(lo) !== Math.round(hi))
    ? ('$' + Math.round(lo) + ' – $' + Math.round(hi)) : (hi || lo || '');
  var put = function (col, val) { if (col && val !== '' && val != null) sh.getRange(row, col).setValue(txt_(val)); };
  put(c['status'],                     'Requested');
  put(c['project name'],               v[8]);                 // scope one-liner
  put(c['company name'],               v[22]);
  put(c['contact person'],             v[4]);
  put(c['email'],                      v[6]);
  put(c['phone'],                      v[5]);
  put(c['due date for the estimate'],  startIso ? fmtDate_(startIso) : '');  // the review call
  put(c['estimate cost'],              cost);
  return { row: row, cost: cost };
}

/* Books it: creates the calendar event on the admin calendar, assigns the crew (reusing the
 * Schedule tab's own assignment + notification path), and closes the request. */
/* ============================================================================================
 * v36 - NOTHING GOES INTO THE PAST, AND AN APPOINTMENT DOES NOT GO ON TOP OF SOMETHING ELSE.
 *
 * requestSchedule_ used to take whatever time it was handed and create the event - no check that
 * the time had not already passed, no check that the slot was free. That is how four test jobs
 * landed in the past and over a job that was already running. A suggested slot goes stale the
 * moment the lead sits a day or two, and nobody notices until the crew is sent to the wrong hour.
 *
 * Estimate calls are DELIBERATELY still allowed to overlap - a 30-minute phone call does not need
 * Paul off the tools (Charles, Sept 2026) - but the reply now says what it lands on, so it is a
 * decision rather than a surprise.
 * ========================================================================================== */

/* Real bookings overlapping [start, end). All-day events are ignored: they are notes, not jobs.
 * Touching is not overlapping - a job ending at 10:00 does not block one starting at 10:00. */
function slotClashes_(start, end, ignoreEventId) {
  var out = [];
  try {
    var evs = visitCal_().getEvents(new Date(start.getTime() - 60000), new Date(end.getTime() + 60000));
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      try {
        if (ev.isAllDayEvent()) continue;
        if (ignoreEventId && String(ev.getId()) === String(ignoreEventId)) continue;
        if (ev.getEndTime().getTime() <= start.getTime()) continue;
        if (ev.getStartTime().getTime() >= end.getTime()) continue;
        out.push({ title: ev.getTitle() || '(untitled)', start: ev.getStartTime().toISOString() });
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

/* Throws when the booking must not happen. Returns a warning string when it may happen but the
 * person doing it should be told. Returns '' when the slot is clean. */
function slotGuard_(user, type, start, end, ignoreEventId, opts) {
  opts = opts || {};
  // v51 - an emergency call Paul adds by hand may be booked after hours, this morning, or on top
  // of a job that is already there. He says so with {bump:true, allowPast:true}; without it the
  // rules below are exactly what they were.
  if (!opts.allowPast && start.getTime() < Date.now() - 60000)
    throw new Error('That time has already passed. Pick a time in the future - a slot suggested '
      + 'a day or two ago goes stale, which is how a job ends up booked into yesterday.');

  var clashes = slotClashes_(start, end, ignoreEventId);
  if (!clashes.length) return '';

  var names = clashes.map(function (c) { return '"' + c.title + '" (' + whenText_(c.start) + ')'; }).join(', ');

  // v51 - booked on purpose over what is there. The caller sends the jobs in the way back to
  // Requests after this booking lands; say so rather than refusing.
  if (opts.bump) return 'Booked over ' + names + '.';

  // v40 - an estimate call now gets an EMPTY spot too (Paul, Sept 29 2026). Refuse, and hand back
  // open times of the same length.
  if (String(type).toUpperCase() !== 'APPOINTMENT') {
    var mins = Math.round((end.getTime() - start.getTime()) / 60000), openC = '';
    try {
      var rc = openSlots_(user, { minutes: mins, kind: 'call', count: 3 });
      if (rc.slots.length) openC = '  Open for ' + mins + ' min: ' +
        rc.slots.map(function (x) { return whenText_(x.start); }).join('  ·  ') + '.';
    } catch (e) {}
    throw new Error('That time is taken by ' + names + '.' + openC);
  }

  // An appointment means someone drives out. Refuse, and hand back times that actually work.
  var hrs = Math.max(0.5, (end.getTime() - start.getTime()) / 3600000);
  var open = '';
  try {
    var r = visitSlots_(user, { hours: hrs, count: 3, afterDate: fmtDate_(start) });
    if (r && r.slots && r.slots.length)
      open = '  Next open for ' + hrs + ' hr: ' +
             r.slots.map(function (x) { return whenText_(x.start); }).join('  ·  ') + '.';
  } catch (e) {}
  throw new Error('That slot is taken by ' + names + '.' + open);
}

/* v36 - the customer's photos, back on the calendar event.
 *
 * When the ball-park sequence created the calendar event itself it wrote its whole estimate block
 * into the description, photo links and all. Since the lead started going to the app instead, the
 * app builds a tidy short description from the request's own columns - and quietly drops the
 * photos, which are only in the Detail column. Paul opens the event on site and there is nothing
 * to look at. This puts them back: the links, not the whole estimate, so the event stays readable.
 */
function detailPhotoLinks_(detail) {
  var out = [], seen = {};
  String(detail || '').replace(/https:\/\/proes\.ca\/wp-content\/uploads\/forminator\/[^\s"'<>]+/g,
    function (u) { if (!seen[u]) { seen[u] = 1; out.push(u); } return u; });
  return out;
}
function detailGmailLink_(detail) {
  var m = String(detail || '').match(/https:\/\/mail\.google\.com\/[^\s"'<>]+/);
  return m ? m[0] : '';
}
/* The lines to append to a calendar event's description for this request. */
function detailAttachLines_(detail) {
  var photos = detailPhotoLinks_(detail), gmail = detailGmailLink_(detail), out = [];
  if (photos.length) {
    out.push('');
    out.push('PHOTOS FROM THE CUSTOMER (' + photos.length + '):');
    for (var i = 0; i < photos.length; i++) out.push('  ' + photos[i]);
  }
  if (gmail) { out.push(''); out.push('Original enquiry: ' + gmail); }
  return out;
}

function requestSchedule_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values;
  if (String(v[14]) === 'scheduled') throw new Error('That one is already on the calendar.');
  var hours = Number(p.hours) || Number(v[9]) || 1;
  var start = new Date(p.start);
  if (isNaN(start)) throw new Error('Pick a date and time.');
  // v46 — the approver can override what the form said: "Estimate" is often what a customer
  // clicks when they mean "come and do it". The choice is written back to the request row so
  // the record shows what was actually booked, and it decides PO Log vs Estimate tab below.
  var formType = String(v[3] || 'ESTIMATE').toUpperCase();
  var askType  = String(p.type || '').toUpperCase();
  var type = (askType === 'APPOINTMENT' || askType === 'ESTIMATE') ? askType : formType;
  var switched = type !== formType;
  if (switched) { loc.sheet.getRange(loc.row, 4).setValue(type); v[3] = type; }
  // Col 10 keeps the AI's guess untouched; Paul's figure goes in col 29 so the monthly estimate
  // audit can compare the two against the clocked hours. Col 30 is how many people are on it:
  // whoever was actually assigned, else what the estimate assumed. The clock records man-hours
  // across the crew, so the audit needs the head count to compare like with like.
  var crew = Math.max(1, Number(p.crew) || (p.assign || []).length || Number(v[29]) || 1);
  loc.sheet.getRange(loc.row, 29, 1, 2).setValues([[hours, crew]]); v[28] = hours; v[29] = crew;
  // v46 — an ESTIMATE blocks the 30-minute review call, not the whole job; "hours" stays the
  // job length for the Estimate tab and for booking the job later.
  // v40 - Paul picks the call length: 15 min, 30 min, 1 h or 2 h (30 min when not said).
  var callMin = [15, 30, 60, 120].indexOf(Number(p.callMinutes)) >= 0 ? Number(p.callMinutes) : 30;
  var block = type === 'ESTIMATE' ? callMin / 60 : hours;
  var end = new Date(start.getTime() + block * 3600000);
  var slotNote = slotGuard_(user, type, start, end, '',
    { bump: !!p.bump, allowPast: !!p.allowPast });   // v40 throws on past / on ANY clash; v51 unless Paul said bump
  // v89 - titled by WHO it is. A visit to look first has no job number; a job gets its number below.
  var title = reqEvTitle_(v, type === 'APPOINTMENT' ? String(v[23] || '') : '');
  var body = [
    type === 'ESTIMATE' ? ('Estimate call (' + (callMin < 60 ? callMin + ' min' : (callMin / 60) + ' h') + ') — job not booked yet.') : 'Booked appointment.',
    switched ? ('Form said ' + formType + '; booked as ' + type + ' by ' + user.email.split('@')[0] + '.') : '',
    'Customer: ' + v[4] + (v[5] ? ('  ·  ' + v[5]) : '') + (v[6] ? ('  ·  ' + v[6]) : ''),
    v[7] ? ('Address: ' + v[7]) : '',
    v[8] ? ('Scope: ' + v[8]) : '',
    (type === 'ESTIMATE' ? 'Estimated job length ' : 'Estimated ') + hours + ' hr' + (hours === 1 ? '' : 's') +
      (Number(v[11]) ? ('  ·  provisional $' + Number(v[11]).toFixed(0) + '–$' + Number(v[12]).toFixed(0)) : ''),
    v[10] ? ('Materials: ' + v[10]) : '',
    '', 'Scheduled from the timesheet app by ' + user.email.split('@')[0] + '.'
  ].concat(detailAttachLines_(v[21]))          // v36 - the customer's photos + the original email
   .filter(function (x) { return x !== undefined && x !== null; }).join('\n');
  var cal = CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]);
  if (!cal) throw new Error('Cannot reach the calendar — Paul may need to re-approve calendar access.');
  var ev = cal.createEvent(title, start, end, { description: body, location: String(v[7] || '') });
  var evId = ev.getId();
  var emails = (p.assign || []).map(lc_).filter(String);
  if (emails.length) {
    try { scheduleAssign_(user, { eventId: evId, emails: emails, title: title,
      start: start.toISOString(), notify: p.notify !== false }); } catch (e) {}
  }
  loc.sheet.getRange(loc.row, 15, 1, 7).setValues([[ 'scheduled', start.toISOString(), end.toISOString(),
    emails.join(','), evId, user.email, new Date().toISOString() ]]);
  reqMapsDrop_();                                  // v53
  // v23 — write it through to the PO Log workbook. Wrapped: a failure here must never lose the
  // calendar event that was just created, so it degrades to a warning Paul can act on.
  var po = null, poNote = '';
  try {
    if (type === 'APPOINTMENT') {
      // v51 - a job that came back off the calendar already HAS its number. The PO number becomes
      // the QuickBooks invoice number: it is minted once and never changes, so rebooking one
      // re-dates its existing PO Log row instead of burning the next number.
      var had = String(v[23] || '').trim();
      if (had) {
        poNote = 'PO ' + had + ' kept - ' + poLogSetStart_(had, start);
      } else {
        po = poLogAddFromRequest_(v, start); poNote = 'PO ' + po.po + ' (' + po.type + ')';
        loc.sheet.getRange(loc.row, 24).setValue(po.po);
        title = reqEvTitle_(v, po.po); try { ev.setTitle(title); } catch (e) {}   // v89
      }
    } else {
      var est = poEstimateAddFromRequest_(v, start);
      poNote = est.skipped ? ('Estimate tab skipped: ' + est.skipped) : 'Estimate tab row ' + est.row;
      // v46 — remember which Estimate-tab row this is, so booking the job later can stamp it Won.
      if (est.row) loc.sheet.getRange(loc.row, 25).setValue(est.row);
    }
  } catch (e) { poNote = 'PO Log write FAILED: ' + e.message; }
  // v46 — a booked job asks the customer whether the time works; an estimate call does not
  // (Paul is phoning them anyway, and a "confirm your call" email is noise).
  v[18] = evId;
  // v51 - it has a time again, so it is no longer waiting for one: the displacement marks go.
  try { loc.sheet.getRange(loc.row, REQ_BUMPFROM_, 1, 3).setValues([['', '', '']]); } catch (e) {}
  // v51 - and anything THIS booking landed on top of goes back to Requests, unscheduled, with
  // its PO intact. Never throws: the booking Paul just made must survive a failure here.
  var bumped = [], bumpProblems = [];
  if (p.bump) {
    var br = bumpToRequests_(user, start, end, evId, title);
    bumped = br.sent; bumpProblems = br.problems;
    if (bumped.length) bumpBackEmail_(bumped, title, start.toISOString());
  }
  var custNote = (type === 'APPOINTMENT' && p.notifyCustomer !== false)
    ? confirmNotifyCustomer_(loc, v, start, end, 'booked') : '';
  log_(user, 'requestSchedule', v[4], '', title + ' @ ' + start.toISOString() +
    (switched ? ('  ·  switched from ' + formType) : '') + (poNote ? ('  ·  ' + poNote) : '') +
    (custNote ? ('  ·  ' + custNote) : '') +
    (bumped.length ? ('  ·  ' + bumped.length + ' sent back to Requests') : '') +
    (bumpProblems.length ? ('  ·  could not move: ' + bumpProblems.join('; ')) : ''));
  return { id: p.id, eventId: evId, start: start.toISOString(), end: end.toISOString(), title: title,
    po: po ? po.po : String(v[23] || ''), poNote: poNote, custNote: custNote, slotNote: slotNote,
    bumped: bumped, bumpProblems: bumpProblems };
}

/* ============================================================================================
 * CUSTOMER CONFIRMATION  (v46)
 * A booked job is not really booked until the customer says the time works. When a job is
 * booked or moved, the customer gets an email with two links — Yes / No — and the calendar
 * event is colour-coded so the answer is visible at a glance without opening anything:
 *   AMBER (orange)  waiting on them
 *   GREEN           they confirmed
 *   RED             they said no / asked to move it
 * The links carry a random one-off token, hit doGet, and need no login from the customer.
 * Columns on the Requests tab: 26 Confirm, 27 Confirm token, 28 Notified at.
 * ==========================================================================================*/

var CONFIRM_COL_ = 26, CONFIRM_TOKEN_COL_ = 27, CONFIRM_SENT_COL_ = 28;

function confirmColour_(state) {
  if (state === 'confirmed') return CalendarApp.EventColor.GREEN;
  if (state === 'declined')  return CalendarApp.EventColor.RED;
  if (state === 'cancelled') return CalendarApp.EventColor.GRAY;   // v35 - the customer called it off
  return CalendarApp.EventColor.ORANGE;   // waiting
}

/* Recolour the booked job. Never throws: a colour is a convenience, the booking is the record. */
function confirmSetColour_(eventId, state) {
  try {
    if (!eventId) return;
    var cal = CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]) || CalendarApp.getDefaultCalendar();
    var ev = cal.getEventById(eventId);
    if (ev) ev.setColor(confirmColour_(state));
  } catch (e) {}
}

/* v35 - the customer has THREE answers, not two: yes, reschedule, cancel. Anything else - an
 * old email that still says &a=no, a truncated link, a mail client that mangled the query - falls
 * back to "reschedule", which only ever means "Paul, ring them". Never to cancel: guessing a
 * cancellation off a malformed link is the one mistake here that costs real money. */
function confirmVerb_(a) {
  var v = String(a || '').toLowerCase();
  if (v === 'yes') return 'yes';
  if (v === 'cancel') return 'cancel';
  return 'reschedule';                       // covers 'no' from emails sent before v35
}
function confirmState_(verb) {
  return verb === 'yes' ? 'confirmed' : verb === 'cancel' ? 'cancelled' : 'declined';
}

function confirmToken_() { return Utilities.getUuid().replace(/-/g, '').substring(0, 24); }

// The public /exec URL of this Web App. Pinned rather than asked for at run time, because
// ScriptApp.getService().getUrl() returns the /dev URL when run from the editor, and a /dev link
// in a customer's email dead-ends at a Google login. Update only if a brand-new deployment is
// created (a "New version" of the existing one keeps this URL).
var CONFIRM_BASE_URL_ = 'https://script.google.com/macros/s/AKfycbxEZMh2MuzbfGFyuiwmJO1KMLffrj4_rWXYW8JXTew61EKsBKZ5SVoN7tlUH9peKq8f/exec';
function appWebUrl_() {
  if (CONFIRM_BASE_URL_) return CONFIRM_BASE_URL_;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/**
 * Email the customer their booked (or moved) time with Yes / No links, mark the request as
 * waiting, and turn the calendar event amber. Returns a short note for the caller's log.
 * Never throws — losing the email must not lose the booking.
 */
/* v35 - the customer's appointment email.
 *
 * It used to be plain text with two raw script.google.com URLs pasted into the body. On a phone
 * they wrapped over four lines, and a long unexplained googleusercontent link in an email asking
 * you to click it is exactly what a phishing message looks like - which is a poor first
 * impression from the electrician you just hired.
 *
 * Now: one branded card with two real buttons. The links, tokens and handler are UNCHANGED, so
 * confirmAnswer_ and the calendar colours carry on exactly as before. The same words also go out
 * as the plain-text part, links included, so a text-only client can still answer.
 */
function eEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The shared shell for anything PRO sends a customer. Keeps the booking email, the reschedule
 * email and the return-visit email looking like the same company wrote them.
 *   o = { heading, intro, when, lines[], buttons[{label,url,kind}], footNote }
 */
function custEmailHtml_(o) {
  var NAVY = '#1F3864', BLUE = '#2E75B6', LINE = '#d9e1ed',
      MUTED = '#5b6b85', TEXT = '#1a2947', PAGE = '#eef2f8';

  var lines = (o.lines || []).filter(String).map(function (t) {
    return '<tr><td style="padding:3px 0;color:' + TEXT + ';font-size:15px;line-height:1.45">' +
           eEsc_(t) + '</td></tr>';
  }).join('');

  // Traffic light, the same convention the app's clock buttons use: green = go, amber = wait,
  // red = stop. The greens and reds are a shade darker than the app's --ok / --bad so white text
  // stays legible on a phone outdoors; the amber carries dark text, because no yellow a customer
  // would call yellow is readable underneath white.
  var KIND = {
    yes:    { bg: '#15803d', fg: '#ffffff', br: '#15803d' },   // green
    wait:   { bg: '#eab308', fg: '#3f2d00', br: '#eab308' },   // yellow
    cancel: { bg: '#b91c1c', fg: '#ffffff', br: '#b91c1c' }    // red
  };
  var buttons = (o.buttons || []).map(function (b) {
    var k  = KIND[b.kind] || { bg: '#ffffff', fg: NAVY, br: LINE };
    var bg = k.bg, fg = k.fg, br = k.br;
    return '<tr><td style="padding:5px 0">' +
      '<a href="' + eEsc_(b.url) + '" style="display:block;padding:15px 18px;border-radius:12px;' +
      'background:' + bg + ';color:' + fg + ';border:1px solid ' + br + ';text-decoration:none;' +
      'font-size:16px;font-weight:700;text-align:center;font-family:-apple-system,BlinkMacSystemFont,' +
      "'Segoe UI',Roboto,Arial,sans-serif\">" + eEsc_(b.label) + '</a></td></tr>';
  }).join('');

  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:' + PAGE + ';">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + PAGE + ';padding:20px 12px">' +
  '<tr><td align="center">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;' +
  'border:1px solid ' + LINE + ';border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,' +
  "'Segoe UI',Roboto,Arial,sans-serif\">" +

  '<tr><td style="background:' + NAVY + ';padding:18px 22px">' +
    '<div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.3px">PRO Electrical Services</div>' +
    '<div style="color:#9fc0e8;font-size:13px;margin-top:2px">Peace River, Alberta</div>' +
  '</td></tr>' +

  '<tr><td style="padding:22px 22px 6px">' +
    '<div style="color:' + NAVY + ';font-size:20px;font-weight:700;margin-bottom:8px">' + eEsc_(o.heading) + '</div>' +
    '<div style="color:' + TEXT + ';font-size:15px;line-height:1.5">' + eEsc_(o.intro) + '</div>' +
  '</td></tr>' +

  (o.when ? '<tr><td style="padding:14px 22px 4px">' +
    '<div style="background:#eef4fc;border-left:4px solid ' + BLUE + ';border-radius:8px;padding:14px 16px">' +
    '<div style="color:' + NAVY + ';font-size:18px;font-weight:700">' + eEsc_(o.when) + '</div></div></td></tr>' : '') +

  (lines ? '<tr><td style="padding:12px 22px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    lines + '</table></td></tr>' : '') +

  (buttons ? '<tr><td style="padding:16px 22px 4px">' +
    (o.buttonsIntro ? '<div style="color:' + MUTED + ';font-size:14px;margin-bottom:8px">' +
      eEsc_(o.buttonsIntro) + '</div>' : '') +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + buttons + '</table></td></tr>' : '') +

  (o.footNote ? '<tr><td style="padding:14px 22px 0;color:' + MUTED + ';font-size:14px;line-height:1.5">' +
    eEsc_(o.footNote) + '</td></tr>' : '') +

  '<tr><td style="padding:18px 22px 22px">' +
    '<div style="border-top:1px solid ' + LINE + ';padding-top:14px;color:' + MUTED + ';font-size:13px;line-height:1.6">' +
    'PRO Electrical Services<br>Peace River, AB &nbsp;&middot;&nbsp; ' +
    '<a href="mailto:admin@proes.ca" style="color:' + BLUE + ';text-decoration:none">admin@proes.ca</a>' +
    ' &nbsp;&middot;&nbsp; <a href="tel:+17806255880" style="color:' + BLUE + ';text-decoration:none">780-625-5880</a>' +
    '</div></td></tr>' +

  '</table></td></tr></table></body></html>';
}

function confirmNotifyCustomer_(loc, v, start, end, mode, message) {
  try {
    var email = String(v[6] || '').trim();
    if (!email) { loc.sheet.getRange(loc.row, CONFIRM_COL_).setValue('no email'); return 'no customer email — not notified'; }
    var base = appWebUrl_();
    if (!base) return 'app URL unavailable — customer not notified';
    var token = confirmToken_();
    var yes    = base + '?confirm=' + token + '&a=yes';
    var resched = base + '?confirm=' + token + '&a=reschedule';
    var cancel  = base + '?confirm=' + token + '&a=cancel';
    var when = whenText_(start);
    var hrs = Math.round(((new Date(end) - new Date(start)) / 3600000) * 10) / 10;
    var moved = mode === 'moved';
    var subject = (moved ? 'Changed: ' : 'Booked: ') + 'your PRO Electrical appointment — ' + when;
    var first = String(v[4] || '').trim().split(' ')[0];
    // v64 - Paul can write his own sentence. Only this paragraph: the time, the address, the
    // three Yes/Reschedule/Cancel buttons and their one-off tokens are built here and stay built
    // here, because an edited link is a link that no longer works.
    var intro = String(message || '').trim() || (moved
      ? 'We have had to move your appointment. Here is the new time:'
      : 'Your electrical work is booked in. Here is the time:');
    var lines = [
      hrs ? ('About ' + hrs + ' hour' + (hrs === 1 ? '' : 's') + ' on site') : '',
      String(v[7] || ''),
      String(v[8] || '')
    ];

    var htmlBody = custEmailHtml_({
      heading: (first ? ('Hi ' + first + ',') : 'Hello,'),
      intro: intro,
      when: when,
      lines: lines,
      buttonsIntro: 'Does that time work for you? Just tap one:',
      buttons: [ { label: 'Yes, that works',   url: yes,     kind: 'yes' },
                 { label: 'Reschedule',        url: resched, kind: 'wait' },
                 { label: 'Cancel the job',    url: cancel,  kind: 'cancel' } ],
      footNote: 'If you need another time, tap Reschedule and we will call you to sort it out. ' +
                'You can also just reply to this email.'
    });

    // Plain-text part, for clients that will not render HTML. The links stay in it, on their own
    // lines, so a text-only reader can still answer.
    var body =
      'Hi ' + first + ',\n\n' + intro + '\n\n' +
      '  ' + when + '\n' +
      lines.filter(String).map(function (t) { return '  ' + t + '\n'; }).join('') +
      '\nDoes that time work for you? Just tap one:\n\n' +
      'YES, that works:\n  ' + yes + '\n\n' +
      'RESCHEDULE:\n  ' + resched + '\n\n' +
      'CANCEL the job:\n  ' + cancel + '\n\n' +
      'If you need another time, tap Reschedule and we will call you to sort it out. ' +
      'You can also just reply to this email.\n\n' +
      '— PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca  ·  780-625-5880';

    MailApp.sendEmail({ to: email, subject: subject, body: body, htmlBody: htmlBody,
      name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0] });
    loc.sheet.getRange(loc.row, CONFIRM_COL_, 1, 3)
      .setValues([['waiting', token, new Date().toISOString()]]);
    confirmSetColour_(v[18], 'waiting');
    return 'customer emailed (' + email + ') — waiting on their yes/no';
  } catch (e) {
    return 'customer NOT notified: ' + e.message;
  }
}

/* The customer tapped Yes or No. Finds the request by token, records the answer, recolours the
 * event, and tells Paul. Returns the HTML page the customer sees. */
function confirmAnswer_(token, answer) {
  var sh = reqSheet_(), last = sh.getLastRow();
  if (last < 2) return confirmPage_('That link is no longer valid.', false);
  var vals = sh.getRange(2, 1, last - 1, REQ_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][CONFIRM_TOKEN_COL_ - 1]) !== String(token) || !token) continue;
    var v = vals[i], row = i + 2;
    var state = confirmState_(answer);
    var unchanged = String(v[CONFIRM_COL_ - 1]) === state;
    sh.getRange(row, CONFIRM_COL_).setValue(state);
    confirmSetColour_(v[18], state);

    // v35 - a cancellation does NOT free the calendar slot or touch the PO Log on its own. The
    // customer tapping a link in an email is a message, not an instruction to unwind the job:
    // Paul rings them, then cancels properly from the app, which is what writes the PO Log.
    var SAY = {
      confirmed: { subj: '✅ Confirmed: ',          did: 'confirmed the appointment.',
                   next: '\nThe calendar event is green. Nothing to do.' },
      declined:  { subj: '⛔ Needs a new time: ',   did: 'says that time does not work and wants to reschedule.',
                   next: '\nThe calendar event is red. Give them a call, then move it from the app (Requests > Booked > Move it).' },
      cancelled: { subj: '⚫ CANCELLED by the customer: ',
                   did: 'has CANCELLED the job.',
                   next: '\nThe calendar event is grey and the slot is STILL BOOKED — nothing has been freed.' +
                         '\nRing them to confirm, then use Cancel job in the app (Requests > Booked), which frees the' +
                         '\nslot and marks the PO Log.' }
    };
    var say = SAY[state] || SAY.declined;

    if (!unchanged) try {
      MailApp.sendEmail({
        to: CONFIG.ADMIN_EMAILS.join(','),
        subject: say.subj + (v[4] || 'customer') + ' — ' + whenText_(v[15]),
        body: (v[4] || 'The customer') + ' ' + say.did +
              '\n\n  ' + whenText_(v[15]) + '\n' + (v[8] ? ('  ' + v[8] + '\n') : '') +
              (v[7] ? ('  ' + v[7] + '\n') : '') + (v[5] ? ('  ' + v[5] + '\n') : '') +
              (v[23] ? ('  ' + v[23] + '\n') : '') + say.next
      });
    } catch (e) {}

    if (state === 'confirmed')
      return confirmPage_('Thanks — you\'re confirmed for ' + whenText_(v[15]) + '. See you then.', true);
    if (state === 'cancelled')
      return confirmPage_('That\'s cancelled — thanks for letting us know. ' +
                          'We\'ll be in touch to confirm, and you\'re welcome back any time.', true);
    return confirmPage_('No problem — we\'ll call you to find a time that works better.', true);
  }
  return confirmPage_('That link is no longer valid. Give us a call at PRO Electrical and we\'ll sort it out.', false);
}

function confirmPage_(msg, good) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem;' +
    'margin:12vh auto;padding:0 1.5rem;text-align:center;color:#1f3864">' +
    '<div style="font-size:2.6rem;margin-bottom:.4rem">' + (good ? '✅' : '⚠️') + '</div>' +
    '<p style="font-size:1.1rem">' + msg.replace(/[<>]/g, '') + '</p>' +
    '<p style="color:#6b7280;font-size:.9rem;margin-top:2rem">PRO Electrical Services · Peace River, AB</p>' +
    '</div>').setTitle('PRO Electrical');
}

/* Move a booked job. Updates the calendar event in place, re-asks the customer, and puts the
 * job back to amber — a time the customer has not seen yet is not a confirmed time. */
function requestReschedule_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values;
  if (String(v[14]) !== 'scheduled') throw new Error('That one is not on the calendar.');
  var hours = Number(p.hours) || Number(v[28]) || Number(v[9]) || 1;
  var start = new Date(p.start);
  if (isNaN(start)) throw new Error('Pick a date and time.');
  // v60 - an ESTIMATE is a phone call, not the job. Moving one used to block out the whole
  // estimated job length (hours), so a 30-minute call about a 6-hour job swallowed the day.
  // The call length is what moves; `hours` stays the job's size, for the Estimate tab.
  var isEst = String(v[3] || '').toUpperCase() === 'ESTIMATE';
  var callMin = [15, 30, 60, 120].indexOf(Number(p.callMinutes)) >= 0 ? Number(p.callMinutes)
              : Math.max(15, Math.min(120, Math.round(((new Date(v[16]) - new Date(v[15])) / 60000) || 30)));
  var block = isEst ? (callMin / 60) : hours;
  var end = new Date(start.getTime() + block * 3600000);
  // v36 - same rules when moving one, but the job's OWN event must not count as a clash.
  var slotNote = slotGuard_(user, v[3], start, end, v[18],
    { bump: !!p.bump, allowPast: !!p.allowPast });   // v51
  var cal = CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]) || CalendarApp.getDefaultCalendar();
  var ev = v[18] ? cal.getEventById(String(v[18])) : null;
  if (ev) { ev.setTime(start, end); }
  else {
    var title = reqEvTitle_(v);   // v89
    ev = cal.createEvent(title, start, end, { description: 'Rebooked from the timesheet app.', location: String(v[7] || '') });
    loc.sheet.getRange(loc.row, 19).setValue(ev.getId());
    v[18] = ev.getId();
  }
  loc.sheet.getRange(loc.row, 16, 1, 2).setValues([[start.toISOString(), end.toISOString()]]);
  loc.sheet.getRange(loc.row, 29).setValue(hours);
  if (Number(p.crew)) loc.sheet.getRange(loc.row, 30).setValue(Math.max(1, Number(p.crew)));
  loc.sheet.getRange(loc.row, 20, 1, 2).setValues([[user.email, new Date().toISOString()]]);
  v[15] = start.toISOString();
  // The PO Log start date follows the job, or the sheet quietly disagrees with the calendar.
  var poNote = '';
  try { if (String(v[23] || '').trim()) poNote = poLogSetStart_(String(v[23]), start); } catch (e) { poNote = 'PO Log date not updated: ' + e.message; }
  var bumped = [], bumpProblems = [];
  if (p.bump) {
    var brR = bumpToRequests_(user, start, end, String(v[18] || ''),   // v51
      String(v[4] || v[3] || 'a job'));
    bumped = brR.sent; bumpProblems = brR.problems;
    if (bumped.length) bumpBackEmail_(bumped, String(v[4] || 'a job'), start.toISOString());
  }
  var note = (p.notify === false) ? 'customer not emailed (you asked)' : confirmNotifyCustomer_(loc, v, start, end, 'moved');
  log_(user, 'requestReschedule', v[4], '', whenText_(start) + '  ·  ' + note + (poNote ? ('  ·  ' + poNote) : '') +
    (bumped.length ? ('  ·  ' + bumped.length + ' sent back to Requests') : ''));
  return { id: p.id, start: start.toISOString(), end: end.toISOString(), note: note, poNote: poNote,
    slotNote: slotNote, bumped: bumped, bumpProblems: bumpProblems };
}

/* Keep the PO Log's start date in step with a moved job. */
function poLogSetStart_(po, start) {
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
  if (!sh) return 'PO Log tab not found';
  var hdr = poHeader_(sh, 'po number');
  var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
  var last = sh.getLastRow();
  if (last <= headerRow) return '';
  var col = sh.getRange(headerRow + 1, CONFIG.PO_NUMBER_COL, last - headerRow, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() === String(po).trim()) {
      // v51 - an empty start means the job has lost its slot: clear the cell rather than
      // writing fmtDate_('') , which is 'NaN-NaN-NaN'.
      var cell = (start === '' || start == null) ? '' : txt_(fmtDate_(start));
      sh.getRange(headerRow + 1 + i, CONFIG.PO_STARTDATE_COL).setValue(cell);
      return cell ? 'PO Log start date updated' : 'PO Log start date cleared';
    }
  }
  return 'PO ' + po + ' not found on the PO Log';
}

/* Ask the customer again without moving anything — for the one that never answered. */
function requestRenotify_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values;
  if (!v[15]) throw new Error('That one has no booked time yet.');
  var note = confirmNotifyCustomer_(loc, v, new Date(v[15]), new Date(v[16] || v[15]),
    (p && p.mode === 'moved') ? 'moved' : 'booked',                             // v94 - after a drag the subject says Changed
    p && p.message);                                                            // v64
  log_(user, 'requestRenotify', v[4], '', note);
  return { id: p.id, note: note };
}

/* ============================================================================================
 * v51 - A DISPLACED JOB GOES BACK TO "REQUESTS", UNSCHEDULED
 *
 * Until now, booking on top of a job moved that job to the same time the next work day and put
 * its customer on a call list. The customer therefore had a time nobody had agreed to, and the
 * chain could run three or four jobs deep in one tap.
 *
 * Now a displaced job loses its slot and goes back to the Requests tab with no time at all. Its
 * PO number, its customer and its scope come with it; only the booking is gone. Paul picks it up
 * there and either chooses a time himself or takes the next opening - and if the time he picks is
 * taken, THAT job comes back the same way. One step at a time, each one his decision.
 *
 * Three columns are added to the Requests tab to carry it: the time it lost, what took it, and
 * whether the customer has been told. Nothing reads them but the Requests tab.
 * ==========================================================================================*/

var REQ_BUMPFROM_ = 31, REQ_BUMPBY_ = 32, REQ_TOLD_ = 33;

/* The Requests row whose calendar event this is, or null. */
function reqRowByEvent_(evId) {
  if (!evId) return null;
  var t = reqScan_();                               // v61 - the shared copy, not a fresh read
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][18]) === String(evId))
      return { sheet: t.sheet, row: i + 2, values: t.rows[i] };
  }
  return null;
}

/* A return visit booked from the clock-out screen creates a calendar event and no Requests row,
 * so when one is displaced there is nothing in Requests to put it on. This mints that row from
 * the event itself plus the PO Log, so it lands with its customer and phone number intact. */
function reqRowFromEvent_(user, ev, po) {
  var title = '', desc = '', loc = '';
  try { title = ev.getTitle() || ''; desc = ev.getDescription() || ''; loc = ev.getLocation() || ''; } catch (e) {}
  var who = bumpWho_(po, String(ev.getId()), title, desc);
  var email = '';
  try { email = visitCustomerEmail_(po); } catch (e) {}
  var hrs = 0;
  try { hrs = Math.round(((ev.getEndTime() - ev.getStartTime()) / 3600000) * 100) / 100; } catch (e) {}
  var sh = reqSheet_(), id = newId_();
  var row = [];
  for (var k = 0; k < REQ_HEADERS.length; k++) row.push('');
  row[0] = id; row[1] = new Date().toISOString(); row[3] = 'APPOINTMENT';
  row[4] = txt_(who.customer || title); row[5] = txt_(who.phone || ''); row[6] = txt_(email);
  row[7] = txt_(loc); row[8] = txt_(who.job || '');
  row[9] = hrs; row[14] = 'scheduled';
  row[15] = ev.getStartTime().toISOString(); row[16] = ev.getEndTime().toISOString();
  row[18] = String(ev.getId()); row[23] = po || ''; row[28] = hrs; row[29] = 1;
  sh.appendRow(row);
  reqMapsDrop_();                                  // v53 - a new event id now has a row
  return { sheet: sh, row: sh.getLastRow(), values: row };
}

/* Take one booked job off the calendar and put it back in Requests with no time.
 * payload: { id } or { eventId }, plus { by } - what displaced it, for the card to show.
 * The PO number is NEVER changed: it is the invoice number and the job keeps it. */
function requestUnschedule_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = p.id ? reqRow_(p.id) : reqRowByEvent_(p.eventId);
  var cal = visitCal_();
  var ev = null, evId = String(p.eventId || (loc && loc.values[18]) || '');
  if (evId) { try { ev = cal.getEventById(evId); } catch (e) {} }
  if (!loc) {
    if (!ev) throw new Error('That booking is not on the calendar and not in Requests - nothing to move.');
    var d0 = ''; try { d0 = ev.getDescription() || ''; } catch (e) {}
    loc = reqRowFromEvent_(user, ev, bumpPoOf_(ev.getTitle(), d0));
  }
  var v = loc.values;
  var was = String(v[15] || '') || (ev ? ev.getStartTime().toISOString() : '');
  var notes = [];
  if (ev) { try { ev.deleteEvent(); notes.push('slot freed'); } catch (e) { notes.push('calendar NOT freed: ' + e.message); } }
  else notes.push('no calendar event found');

  // Back to the waiting list: the time, the crew and the confirmation all go; the PO stays.
  loc.sheet.getRange(loc.row, 15).setValue('pending');
  loc.sheet.getRange(loc.row, 16, 1, 4).setValues([['', '', '', '']]);       // start, end, assigned, event id
  loc.sheet.getRange(loc.row, 26, 1, 2).setValues([['', '']]);               // confirm, token
  loc.sheet.getRange(loc.row, REQ_BUMPFROM_, 1, 3)
    .setValues([[was, txt_(String(p.by || 'another job')), '']]);
  reqMapsDrop_();                                  // v53 - the event id on that row is gone now
  // The PO Log start date no longer means anything until it is rebooked.
  try { if (String(v[23] || '').trim()) poLogSetStart_(String(v[23]), ''); } catch (e) {}
  // The Call List stays the running record of who lost a slot and when. It is filed CLOSED:
  // "to call" is the old model's open list, and this job's follow-up now lives on the Requests
  // tab, where it has a time to be given as well as a phone call to be made.
  try {
    callSheet_().appendRow([newId_(), new Date().toISOString(), String(v[23] || ''),
      txt_(String(v[4] || '')), txt_(String(v[5] || '')), txt_(String(v[8] || '')), was, '',
      evId, String(v[0] || ''), 'displaced by ' + String(p.by || 'another job'),
      'back to Requests', new Date().toISOString(), String(user.email || '')]);
  } catch (e) {}
  log_(user, 'requestUnschedule', String(v[4] || ''), String(v[23] || ''),
       'was ' + whenText_(was) + ' - displaced by ' + (p.by || '?') + ' - ' + notes.join('; '));
  return { id: String(v[0]), po: String(v[23] || ''), customer: String(v[4] || ''),
           phone: String(v[5] || ''), email: String(v[6] || ''), job: String(v[8] || ''),
           title: String(v[4] || v[8] || ''), was: was,
           hours: Number(v[28]) || Number(v[9]) || 0, note: notes.join('; ') };
}

/* action: "requestUnschedule" - Paul takes a booked job off the calendar himself and parks it
 * back in Requests. Same thing a displacement does, done on purpose. */
function requestUnscheduleAction_(user, p) {
  var r = requestUnschedule_(user, { id: p.id, eventId: p.eventId, by: p.by || 'you took it off the calendar' });
  return r;
}

/* Every JOB a booking at [start, end) would displace. Estimate calls and anything that is not a
 * job are left where they are - the same rule bumpIsJob_ has always used. */
function bumpTargets_(start, end, ignoreEventId) {
  var out = [];
  try {
    var evs = visitCal_().getEvents(new Date(start.getTime() - 60000), new Date(end.getTime() + 60000));
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      try {
        if (ev.isAllDayEvent()) continue;
        if (ignoreEventId && String(ev.getId()) === String(ignoreEventId)) continue;
        if (ev.getEndTime().getTime() <= start.getTime()) continue;
        if (ev.getStartTime().getTime() >= end.getTime()) continue;
        var d = ''; try { d = ev.getDescription() || ''; } catch (e2) {}
        if (!bumpIsJob_(ev.getTitle(), d)) continue;
        out.push({ eventId: String(ev.getId()), title: ev.getTitle() || '(untitled)',
                   start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
                   po: bumpPoOf_(ev.getTitle(), d) });
      } catch (e3) {}
    }
  } catch (e) {}
  return out;
}

/* Send every one of them back to Requests. Never throws: a booking that has already happened
 * must not be undone because one displaced job could not be written. */
function bumpToRequests_(user, start, end, ignoreEventId, byTitle) {
  var sent = [], problems = [];
  bumpTargets_(start, end, ignoreEventId).forEach(function (t) {
    try { sent.push(requestUnschedule_(user, { eventId: t.eventId, by: byTitle || 'another job' })); }
    catch (e) { problems.push(t.title + ': ' + e.message); }
  });
  return { sent: sent, problems: problems };
}

/* Paul has rung or emailed the customer whose job was moved.
 * payload: { id, how: 'called' | 'email' } */
function requestTellCustomer_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values, how = String(p.how || 'called').toLowerCase();
  if (how === 'email') {
    var to = String(v[6] || '').trim();
    if (!to) throw new Error('No email address on file for ' + (v[4] || 'this customer') + ' - ring them instead.');
    var first = String(v[4] || '').trim().split(' ')[0];
    var intro = 'We have had to move your appointment and we are sorry for the short notice. ' +
                'Your job has NOT been cancelled - we are finding you a new time now and will be in touch to agree it.';
    var lines = [String(v[8] || ''), String(v[7] || '')];
    var wasTxt = v[REQ_BUMPFROM_ - 1] ? ('Was ' + whenText_(v[REQ_BUMPFROM_ - 1])) : '';
    MailApp.sendEmail({
      to: to,
      subject: 'We need to move your PRO Electrical appointment',
      body: 'Hi ' + first + ',\n\n' + intro + '\n\n' +
            (wasTxt ? ('  ' + wasTxt + '\n') : '') +
            lines.filter(String).map(function (t) { return '  ' + t + '\n'; }).join('') +
            '\nReply to this email or give us a call and we will sort out a time that suits you.\n\n' +
            '- PRO Electrical Services\n  Peace River, AB  -  admin@proes.ca  -  780-625-5880',
      htmlBody: custEmailHtml_({
        heading: (first ? ('Hi ' + first + ',') : 'Hello,'), intro: intro,
        when: wasTxt, lines: lines,
        footNote: 'Reply to this email or give us a call and we will find a time that suits you.'
      }),
      name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0] });
  }
  loc.sheet.getRange(loc.row, REQ_TOLD_)
    .setValue((how === 'email' ? 'emailed ' : 'called ') + fmtDate_(new Date()));
  log_(user, 'requestTellCustomer', String(v[4] || ''), String(v[23] || ''), how);
  return { ok: true, how: how, id: String(p.id) };
}

/* One day of the calendar, for the day-view picker: what is booked, what it is, and whether it
 * is a job that would be displaced. Read-only. payload: { date: 'YYYY-MM-DD' } */
function schedDay_(user, p) {
  requirePerm_(user, 'approveHours');
  var ds = String(p && p.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) throw new Error('Pick a day.');
  var d0 = new Date(ds + 'T00:00:00'), d1 = new Date(d0.getTime() + 86400000);
  var b = visitDayBounds_(d0);
  var hol = {}; abHolidays_(d0, d1).forEach(function (h) { hol[h.date] = h.name; });
  var leave = visitLeaveDays_(CONFIG.ADMIN_EMAILS[0], d0, d1);
  var out = [];
  try {
    visitCal_().getEvents(d0, d1).forEach(function (ev) {
      try {
        var allDay = ev.isAllDayEvent();
        var desc = ''; try { desc = ev.getDescription() || ''; } catch (e) {}
        var po = bumpPoOf_(ev.getTitle(), desc);
        var who = { customer: '', phone: '' };
        try { if (po) who = bumpWho_(po, String(ev.getId()), ev.getTitle(), desc); } catch (e2) {}
        out.push({ eventId: String(ev.getId()), title: ev.getTitle() || '(untitled)',
          start: allDay ? '' : ev.getStartTime().toISOString(),
          end: allDay ? '' : ev.getEndTime().toISOString(), allDay: !!allDay,
          location: ev.getLocation() || '', po: po,
          isJob: !allDay && bumpIsJob_(ev.getTitle(), desc),
          customer: who.customer || '', phone: who.phone || '',
          detail: String(desc).substring(0, 900) });
      } catch (e3) {}
    });
  } catch (e) {}
  out.sort(function (x, y) { return String(x.start).localeCompare(String(y.start)); });
  return { date: ds, events: out,
    day: { start: new Date(b.s).toISOString(), end: new Date(b.e).toISOString(),
           lunchStart: new Date(b.ls).toISOString(), lunchEnd: new Date(b.le).toISOString() },
    holiday: hol[ds] || '', leave: leave[ds] || '',
    weekend: d0.getDay() === 0 || d0.getDay() === 6 };
}

/* v52 - ONE MONTH, for the picker's calendar grid.
 * Paul wants to see the month first and tap into a day, the way a calendar works, rather than
 * stepping through one day at a time. This is the cheap read behind the grid: how many jobs each
 * day carries and whether it is a weekend, a stat holiday or a day he is off. The day's actual
 * bookings still come from schedDay_ when he taps one, so the month call stays small.
 * Read-only. payload: { month: 'YYYY-MM' } */
function schedMonth_(user, p) {
  requirePerm_(user, 'approveHours');
  var ms = String(p && p.month || '');
  if (!/^\d{4}-\d{2}$/.test(ms)) throw new Error('Pick a month.');
  var y = Number(ms.substring(0, 4)), mo = Number(ms.substring(5, 7)) - 1;
  var d0 = new Date(y, mo, 1), d1 = new Date(y, mo + 1, 1);
  var hol = {}; abHolidays_(d0, d1).forEach(function (h) { hol[h.date] = h.name; });
  var leave = visitLeaveDays_(CONFIG.ADMIN_EMAILS[0], d0, d1);
  // Stepping a day at a time by adding 86400000 ms lands on the wrong day twice a year, when the
  // clocks change - once repeating a date and once skipping one. Building each day from its day
  // NUMBER has no such Sunday in it.
  var days = {}, order = [];
  for (var i = 1; i <= 31; i++) {
    var d = new Date(y, mo, i);
    if (d.getMonth() !== mo) break;
    var k = fmtDate_(d);
    days[k] = { date: k, day: i, dow: d.getDay(), jobs: 0, other: 0,
                firstStart: '', lastEnd: '', holiday: hol[k] || '', leave: leave[k] || '',
                weekend: d.getDay() === 0 || d.getDay() === 6 };
    order.push(k);
  }
  try {
    visitCal_().getEvents(d0, d1).forEach(function (ev) {
      try {
        var allDay = ev.isAllDayEvent();
        var k = fmtDate_(allDay ? ev.getAllDayStartDate() : ev.getStartTime());
        var row = days[k]; if (!row) return;            // a multi-day event counts on day one
        var desc = ''; try { desc = ev.getDescription() || ''; } catch (e) {}
        if (!allDay && bumpIsJob_(ev.getTitle(), desc)) {
          row.jobs++;
          var si = ev.getStartTime().toISOString(), ei = ev.getEndTime().toISOString();
          if (!row.firstStart || si < row.firstStart) row.firstStart = si;
          if (!row.lastEnd || ei > row.lastEnd) row.lastEnd = ei;
        } else { row.other++; }
      } catch (e2) {}
    });
  } catch (e) {}
  var out = order.map(function (k) { return days[k]; });
  return { month: ms, days: out, firstDow: out.length ? out[0].dow : 0,
           today: fmtDate_(new Date()) };
}

/* Paul adds a job or a phone call himself - an emergency call, or anything that never came
 * through the website. A JOB burns the next PO number and fills the PO Log; a CALL does not
 * (nothing is sold yet). Either can be given a time straight away, and an emergency may be
 * booked outside working hours and on top of an existing job.
 * payload: { kind:'job'|'call', customer, phone, email, address, scope, company, detail,
 *            hours, crew, start, assign[], notify, notifyCustomer, bump, emergency } */
function requestAddManual_(user, p) {
  requirePerm_(user, 'approveHours');
  var kind = String(p.kind || 'job').toLowerCase() === 'call' ? 'call' : 'job';
  var customer = String(p.customer || '').trim();
  /* v72 - "Schedule a job" on a customer who already has one open: the number they already have
   * is KEPT. A PO number becomes the QuickBooks invoice number, so it is minted once and never
   * re-minted; requestSchedule_ has honoured an existing number on the row since v51 (it re-dates
   * that PO Log row instead of taking the next one), so all this has to do is write it down.
   * Refused for a job that is closed, invoiced or cancelled - that work needs its own number.
   * This sits ABOVE the name checks on purpose: the PO Log row can supply the name. */
  var keepPo = String(p.po || '').trim();
  if (keepPo) {
    if (kind === 'call') throw new Error('An estimate call is not booked against a job number.');
    var known = null;
    getPoCustomers_().forEach(function (c) { if (!known && lc_(c.po) === lc_(keepPo)) known = c; });
    if (!known) throw new Error('Job ' + keepPo + ' is not on the PO Log.');
    if (!/in.?progress/i.test(String(known.status || '')))
      throw new Error('Job ' + keepPo + ' is "' + (known.status || 'blank') + '", not in progress. ' +
                      'Work on a job that is closed or invoiced needs its own number.');
    if (!customer) customer = String(known.name || '').trim();
  }
  if (!customer) throw new Error('Who is it for? Give at least a name.');
  if (/^[A-Z]{1,2}-?\s?\d{5,}$/i.test(customer))
    throw new Error('"' + customer + '" is a job number, not a name.');
  var hours = Math.max(0.25, Math.min(12, Number(p.hours) || (kind === 'call' ? 0.5 : 2)));
  var detail = String(p.detail || '');
  if (p.poType && CONFIG.PO_TYPE_LETTERS[p.poType])                    // v102 - see poLogAddFromRequest_
    detail = (detail ? (detail + '  -  ') : '') + 'PO type: ' + p.poType +
      (p.fromPo ? ' (same customer as ' + String(p.fromPo).replace(/[^A-Z0-9]/gi, '') + ')' : '') + '.';
  if (p.emergency) detail = (detail ? (detail + '  -  ') : '') +
    'EMERGENCY - added by hand by ' + String(user.email).split('@')[0] + ' on ' + fmtDate_(new Date()) + '.';
  var sh = reqSheet_(), id = newId_();
  var row = [];
  for (var k = 0; k < REQ_HEADERS.length; k++) row.push('');
  row[0] = id; row[1] = new Date().toISOString();
  row[3] = kind === 'call' ? 'ESTIMATE' : 'APPOINTMENT';
  row[4] = txt_(customer); row[5] = txt_(String(p.phone || '')); row[6] = txt_(String(p.email || ''));
  row[7] = txt_(String(p.address || '')); row[8] = txt_(String(p.scope || ''));
  row[9] = hours; row[14] = 'pending'; row[21] = txt_(detail);
  row[22] = txt_(String(p.company || '')); row[28] = hours;
  row[29] = Math.max(1, Number(p.crew) || 1);
  if (keepPo) row[23] = txt_(keepPo);          // v72 - scheduled onto the job it already has
  sh.appendRow(row);
  var res = { id: id, kind: kind, po: keepPo, kept: !!keepPo, booked: null, bumped: [], bumpProblems: [] };
  log_(user, 'requestAddManual', customer, keepPo, kind + (p.emergency ? ' (emergency)' : '') +
       (keepPo ? (' on existing ' + keepPo) : '') + (p.start ? (' @ ' + p.start) : ' - not booked yet'));
  if (!p.start) return res;
  var book = kind === 'call'
    ? requestSchedule_(user, { id: id, start: p.start, hours: hours, type: 'ESTIMATE',
        callMinutes: Math.round(hours * 60), assign: p.assign || [], notify: p.notify,
        notifyCustomer: false, bump: !!p.bump, allowPast: !!p.emergency })
    : requestSchedule_(user, { id: id, start: p.start, hours: hours, type: 'APPOINTMENT',
        assign: p.assign || [], notify: p.notify, notifyCustomer: p.notifyCustomer !== false,
        bump: !!p.bump, allowPast: !!p.emergency });
  res.po = book.po || ''; res.booked = book;
  res.bumped = book.bumped || []; res.bumpProblems = book.bumpProblems || [];
  return res;
}

/* Who to tell, once a booking has pushed jobs off the calendar. One email, the list in it, so
 * Paul has it in writing as well as on the Requests tab. Never throws. */
function bumpBackEmail_(sent, byTitle, whenIso) {
  try {
    var lines = sent.map(function (m) {
      return '- ' + (m.customer || m.title || '(no name)') +
             (m.phone ? ('  -  ' + m.phone) : '  -  (no phone on file)') +
             (m.email ? ('  -  ' + m.email) : '') +
             '\n    ' + (m.po ? (m.po + ' - ') : '') + (m.job || '') +
             '\n    was ' + whenText_(m.was) + '  ->  now waiting in Requests';
    }).join('\n\n');
    MailApp.sendEmail(CONFIG.ADMIN_EMAILS[0],
      sent.length + ' job' + (sent.length === 1 ? '' : 's') + ' need' + (sent.length === 1 ? 's' : '') +
        ' a new time - ' + byTitle + ' took the slot',
      'To make room for ' + byTitle + ' on ' + whenText_(whenIso) + ', ' +
      (sent.length === 1 ? 'this job' : 'these ' + sent.length + ' jobs') +
      ' came off the calendar. Nothing has been rebooked - they are waiting in the app under\n' +
      'Requests > "Needs a new time", each with Pick a time and Next opening, and a Call / Email\n' +
      'button for the customer. Their job numbers have not changed.\n\n' +
      lines + '\n\n- PRO timesheet app');
  } catch (e) {}
}


/* ============================================================================================
 * ESTIMATE AUDIT + RECALIBRATION  (v46)
 * Three hour figures exist for every website job and had never been put side by side:
 *   AI hours      what the ball-park guessed              (Requests col 10, never overwritten)
 *   Booked hours  what Paul changed it to when scheduling (Requests col 29)
 *   Actual hours  what the crew clocked against the PO     (timesheet entries, via jobCosts_)
 * Monthly, this writes one row per PO'd job to the 'Estimate Audit' tab, works out how far
 * off the guesses run, and stores a correction on the 'Calibration' tab that the ball-park
 * sweep reads before estimating the next lead. So the estimates learn from the clock.
 * ==========================================================================================*/

var AUDIT_SHEET_ = 'Estimate Audit', CALIB_SHEET_ = 'Calibration';
var AUDIT_HEADERS_ = ['PO','Customer','Scope','Booked date','Crew','AI man-hrs','Booked man-hrs',
  'Actual man-hrs','Actual ÷ AI','Actual ÷ Booked','Settled?','Job status','Audited at'];

/** Install the monthly trigger (run once): 1st of the month, ~7 AM. */
function setupEstimateAuditTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'estimateAuditMonthly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('estimateAuditMonthly').timeBased().onMonthDay(1).atHour(7).create();
  Logger.log('Estimate audit trigger installed: monthly on the 1st, ~7 AM');
}

/** Manual run — same as the monthly job. */
function runEstimateAuditNow() { estimateAuditMonthly(); }

function estimateAuditMonthly() {
  var user = { email: 'system-audit', role: 'admin', permissions: defaultPermissions_('admin') };
  var result = estimateAudit_(user);
  estimateAuditEmail_(result);
}

/* Core: pair every PO'd request with its clocked hours, upsert the audit tab, recalibrate. */
function estimateAudit_(user) {
  // Actual hours per PO (approved + pending — pending is still time worked).
  var actual = {};
  try { CacheService.getScriptCache().remove('jobCosts'); } catch (e) {}
  var jobs = jobCosts_(user, { days: 3650 }).jobs || [];
  jobs.forEach(function (j) {
    if (!j.po) return;
    actual[String(j.po).trim()] = (actual[String(j.po).trim()] || 0) + (Number(j.hours) || 0) + (Number(j.pending) || 0);
  });
  var poStatus = {};
  try { getPoCustomers_().forEach(function (c) { if (c.po) poStatus[String(c.po).trim()] = String(c.status || ''); }); } catch (e) {}

  var sh = reqSheet_(), last = sh.getLastRow();
  var rows = [], now = new Date(), nowIso = now.toISOString();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, REQ_HEADERS.length).getValues();
    vals.forEach(function (r) {
      var po = String(r[23] || '').trim();
      if (!po) return;                                   // no PO = never became a job
      // The clock sums every worker's hours, so both estimates are converted to man-hours
      // before comparing — a 3-hour job with two people on it is 6 clocked hours, not 3.
      var crew = Math.max(1, Number(r[29]) || 1);
      var ai = (Number(r[9]) || 0) * crew, booked = (Number(r[28]) || Number(r[9]) || 0) * crew,
          act = actual[po] || 0;
      var status = poStatus[po] || '';
      var start = r[15] ? new Date(r[15]) : null;
      var ageDays = start && !isNaN(start) ? (now - start) / 86400000 : 0;
      // "Settled" = the clock has stopped: invoiced/closed on the PO Log, or the job started
      // more than 21 days ago and has hours on it. In-progress jobs are listed but not scored.
      var settled = act > 0 && (/invoic|closed|complete|done|paid/i.test(status) || ageDays > 21);
      rows.push([po, r[4], r[8], start && !isNaN(start) ? fmtDate_(start) : '', crew,
        Math.round(ai * 100) / 100, Math.round(booked * 100) / 100,
        Math.round(act * 100) / 100,
        (ai && act) ? Math.round(act / ai * 100) / 100 : '',
        (booked && act) ? Math.round(act / booked * 100) / 100 : '',
        settled ? 'yes' : (act > 0 ? 'in progress' : 'no hours yet'),
        status, nowIso]);
    });
  }
  rows.sort(function (a, b) { return String(b[3]).localeCompare(String(a[3])); });

  // Rewrite the audit tab in full — it is derived data, and a full rewrite cannot drift.
  var ash = masterSheet_(AUDIT_SHEET_);
  ash.clearContents();
  ash.getRange(1, 1, 1, AUDIT_HEADERS_.length).setValues([AUDIT_HEADERS_]).setFontWeight('bold');
  if (rows.length) ash.getRange(2, 1, rows.length, AUDIT_HEADERS_.length).setValues(rows);

  var calib = estimateCalibrate_(rows);
  estimateCalibWrite_(calib);
  return { rows: rows, calib: calib };
}

/* Turn the settled rows into a correction the estimator can use. Median, not mean, because one
 * job that blew up should not swing the whole factor. Only trusted once there are 5 jobs. */
function estimateCalibrate_(rows) {
  var settled = rows.filter(function (r) { return r[10] === 'yes' && r[8] !== '' ; });
  var cutoff = Date.now() - 365 * 86400000;
  settled = settled.filter(function (r) { return !r[3] || new Date(r[3]).getTime() > cutoff; });
  var bucket = function (ai) { return ai < 2 ? 'small (<2 hr)' : ai <= 6 ? 'medium (2–6 hr)' : 'large (>6 hr)'; };
  // bucket on the AI man-hours in column 5
  var groups = { all: [] , 'small (<2 hr)': [], 'medium (2–6 hr)': [], 'large (>6 hr)': [] };
  settled.forEach(function (r) { groups.all.push(r); groups[bucket(Number(r[5]))].push(r); });
  var stats = function (list) {
    var n = list.length;
    if (!n) return { n: 0 };
    var rAi = list.map(function (r) { return Number(r[8]); }).sort(function (a, b) { return a - b; });
    var rBk = list.map(function (r) { return Number(r[9]) || Number(r[8]); }).sort(function (a, b) { return a - b; });
    var med = function (a) { return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
    var mape = function (a) { return Math.round(a.reduce(function (s, x) { return s + Math.abs(x - 1); }, 0) / a.length * 100); };
    return { n: n, medAi: Math.round(med(rAi) * 100) / 100, medBooked: Math.round(med(rBk) * 100) / 100,
             errAi: mape(rAi), errBooked: mape(rBk) };
  };
  var all = stats(groups.all);
  var mult = all.n >= 5 ? Math.min(2, Math.max(0.5, all.medAi)) : 1;   // clamp: never wild
  var buckets = {};
  Object.keys(groups).forEach(function (k) { if (k !== 'all') buckets[k] = stats(groups[k]); });
  // The 8 most recent settled jobs, as examples the estimator can pattern-match on.
  var examples = settled.slice(0, 8).map(function (r) {
    return String(r[2] || r[1]).substring(0, 70) + ' (' + r[4] + '-man) -> guessed ' + r[5] +
      ' man-hr, actual ' + r[7] + ' man-hr';
  });
  return { n: all.n, multiplier: Math.round(mult * 100) / 100, all: all, buckets: buckets,
           examples: examples, computedAt: new Date().toISOString() };
}

/* Key/value tab the ball-park sweep (and the Claude skill) read before estimating. */
function estimateCalibWrite_(c) {
  var sh = masterSheet_(CALIB_SHEET_);
  sh.clearContents();
  var direction = c.multiplier > 1.05 ? 'LOW (jobs take longer than guessed)'
                : c.multiplier < 0.95 ? 'HIGH (jobs finish faster than guessed)' : 'about right';
  var lines = [
    ['Key', 'Value', 'Meaning'],
    ['multiplier', c.multiplier, 'Multiply the raw AI man-hour estimate by this. 1 = no correction. Only trusted once 5+ jobs are settled.'],
    ['jobs_settled', c.n, 'Settled jobs in the last 12 months this is based on'],
    ['ai_direction', direction, 'Which way the AI guesses run'],
    ['ai_median_ratio', c.all.n ? c.all.medAi : '', 'Median actual ÷ AI hours'],
    ['ai_typical_error_pct', c.all.n ? c.all.errAi : '', 'Typical % miss of the AI guess'],
    ['paul_median_ratio', c.all.n ? c.all.medBooked : '', 'Median actual ÷ booked (Paul\'s adjusted) hours'],
    ['paul_typical_error_pct', c.all.n ? c.all.errBooked : '', 'Typical % miss of the booked hours'],
    ['computed_at', c.computedAt, '']
  ];
  Object.keys(c.buckets).forEach(function (k) {
    var b = c.buckets[k];
    lines.push(['bucket_' + k.split(' ')[0], b.n ? (b.medAi + ' (n=' + b.n + ')') : 'n/a', 'Median actual ÷ AI for ' + k + ' jobs']);
  });
  c.examples.forEach(function (ex, i) { lines.push(['example_' + (i + 1), ex, 'Recent settled job']); });
  sh.getRange(1, 1, lines.length, 3).setValues(lines);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
}

/* Read the calibration back as {multiplier, n, direction, examples[], bucketsText}. Used by the
 * sweep script through the sheet directly; exposed here for the app / Claude if wanted. */
function estimateCalibRead_() {
  try {
    var sh = masterSheet_(CALIB_SHEET_), last = sh.getLastRow();
    if (last < 2) return null;
    var out = { examples: [], buckets: [] };
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      var k = String(r[0]), v = r[1];
      if (k === 'multiplier') out.multiplier = Number(v) || 1;
      else if (k === 'jobs_settled') out.n = Number(v) || 0;
      else if (k === 'ai_direction') out.direction = String(v);
      else if (k.indexOf('example_') === 0) out.examples.push(String(v));
      else if (k.indexOf('bucket_') === 0) out.buckets.push(k.replace('bucket_', '') + ': ' + v);
    });
    return out;
  } catch (e) { return null; }
}

function estimateAuditEmail_(res) {
  var c = res.calib, rows = res.rows;
  var settled = rows.filter(function (r) { return r[10] === 'yes'; });
  var inProg = rows.filter(function (r) { return r[10] !== 'yes'; });
  var pct = function (x) { return x ? (Math.round((x - 1) * 100) >= 0 ? '+' : '') + Math.round((x - 1) * 100) + '%' : '—'; };
  var lines = ['Monthly estimate audit — ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy'), ''];
  if (!c.n) {
    lines.push('No settled jobs to score yet. A job counts once it has clocked hours and is either invoiced or 21+ days past its start.');
  } else {
    lines.push('Based on ' + c.n + ' settled job' + (c.n === 1 ? '' : 's') + ' (last 12 months):');
    lines.push('  AI ball-park:   actual hours ran ' + pct(c.all.medAi) + ' vs the guess (typical miss ' + c.all.errAi + '%)');
    lines.push('  Your booked hrs: actual hours ran ' + pct(c.all.medBooked) + ' vs what you booked (typical miss ' + c.all.errBooked + '%)');
    lines.push('');
    lines.push('Correction now applied to new ball-parks: ×' + c.multiplier +
      (c.n < 5 ? '  (held at 1.0 until 5 jobs are settled)' : ''));
    Object.keys(c.buckets).forEach(function (k) {
      var b = c.buckets[k]; if (b.n) lines.push('  ' + k + ': ' + pct(b.medAi) + ' (n=' + b.n + ')');
    });
  }
  lines.push('');
  if (settled.length) {
    lines.push('SETTLED JOBS (PO · customer · AI → booked → actual, in man-hours):');
    settled.slice(0, 25).forEach(function (r) {
      lines.push('  ' + r[0] + ' · ' + r[1] + ' · ' + r[5] + ' → ' + r[6] + ' → ' + r[7] +
        ' man-hr (' + r[4] + '-man)' + (r[8] !== '' ? ('  (' + pct(Number(r[8])) + ' vs AI)') : ''));
    });
    lines.push('');
  }
  if (inProg.length) {
    lines.push('STILL OPEN (not scored yet):');
    inProg.slice(0, 15).forEach(function (r) { lines.push('  ' + r[0] + ' · ' + r[1] + ' · ' + r[7] + ' man-hr so far — ' + r[10]); });
    lines.push('');
  }
  lines.push('Full table: "Estimate Audit" tab of the timesheet master sheet. The correction lives on the "Calibration" tab.');
  MailApp.sendEmail({ to: CONFIG.ADMIN_EMAILS[0], subject: 'Estimate audit — ' +
    (c.n ? ('ball-parks run ' + pct(c.all.medAi) + ', correction ×' + c.multiplier) : 'nothing to score yet'),
    body: lines.join('\n') });
}

/* v46 — CANCEL A BOOKED JOB.
 * The customer rang off after it was booked. Frees the calendar slot, marks the PO Log row
 * Cancelled, tells whoever was assigned, and takes it off the Booked list. The PO NUMBER is
 * kept: it is an invoice number and the sequence must never hand the same one out twice, so a
 * cancelled job keeps its number and simply reads Cancelled. */
function requestCancel_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values;
  if (String(v[14]) !== 'scheduled') throw new Error('That one is not currently booked.');
  var reason = String(p.reason || '').trim();
  var notes = [];

  // 1. Free the calendar slot.
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.ADMIN_EMAILS[0]) || CalendarApp.getDefaultCalendar();
    var ev = v[18] ? cal.getEventById(String(v[18])) : null;
    if (ev) { ev.deleteEvent(); notes.push('calendar cleared'); }
    else notes.push('no calendar event found');
  } catch (e) { notes.push('calendar NOT cleared: ' + e.message); }

  // 2. Mark the money side, whichever tab this job lives on.
  var po = String(v[23] || '').trim();
  if (po) {
    try { notes.push(poLogSetStatus_(po, 'Cancelled')); } catch (e) { notes.push('PO Log not updated: ' + e.message); }
  } else if (Number(v[24])) {
    try { notes.push(poEstimateSetStatus_(Number(v[24]), 'Cancelled')); } catch (e) {}
  }

  // 3. Tell the crew who were told to go.
  var crew = String(v[17] || '').split(',').filter(String);
  if (crew.length && p.notifyCrew !== false) {
    try {
      MailApp.sendEmail({
        to: crew.join(','),
        cc: CONFIG.ADMIN_EMAILS[0],
        subject: 'CANCELLED: ' + (v[4] || 'job') + ' — ' + whenText_(v[15]),
        body: 'This job has been cancelled and is off the calendar.\n\n' +
              '  ' + (v[4] || '') + (po ? ('  ·  ' + po) : '') + '\n' +
              '  Was: ' + whenText_(v[15]) + '\n' +
              (v[7] ? ('  ' + v[7] + '\n') : '') +
              (v[8] ? ('  ' + v[8] + '\n') : '') +
              (reason ? ('\nReason: ' + reason + '\n') : '') +
              '\nNothing to do — do not travel to this one.'
      });
      notes.push('crew told');
    } catch (e) { notes.push('crew NOT told: ' + e.message); }
  }

  // 4. Tell the customer, only if asked — usually they are the one who cancelled.
  if (p.notifyCustomer === true && String(v[6] || '').trim()) {
    try {
      MailApp.sendEmail({
        to: String(v[6]).trim(),
        subject: 'Cancelled: your PRO Electrical appointment — ' + whenText_(v[15]),
        body: 'Hi ' + String(v[4] || '').split(' ')[0] + ',\n\n' +
              'We have cancelled the appointment that was booked for ' + whenText_(v[15]) + '.\n' +
              (reason ? ('\n' + reason + '\n') : '') +
              '\nIf that is not right, or you would like to book another time, just reply to this ' +
              'email or give us a call.\n\n— PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca',
        name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0]
      });
      notes.push('customer told');
    } catch (e) { notes.push('customer NOT told: ' + e.message); }
  }

  // 5. Close the request out. Status 'cancelled' drops it off every list in the app.
  loc.sheet.getRange(loc.row, 15).setValue('cancelled');
  loc.sheet.getRange(loc.row, 20, 1, 2).setValues([[user.email, new Date().toISOString()]]);
  loc.sheet.getRange(loc.row, CONFIRM_COL_).setValue('cancelled');

  log_(user, 'requestCancel', v[4], '', (po ? po + '  ·  ' : '') + whenText_(v[15]) +
    (reason ? ('  ·  ' + reason) : '') + '  ·  ' + notes.join('; '));
  return { id: p.id, po: po, note: notes.join('; ') };
}

/* Set a PO Log row's status by its PO number. */
function poLogSetStatus_(po, status) {
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
  if (!sh) return 'PO Log tab not found';
  var hdr = poHeader_(sh, 'po number');
  var headerRow = hdr ? hdr.row : CONFIG.PO_HEADER_ROWS;
  var last = sh.getLastRow();
  if (last <= headerRow) return '';
  var col = sh.getRange(headerRow + 1, CONFIG.PO_NUMBER_COL, last - headerRow, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() === String(po).trim()) {
      if (CONFIG.PO_STATUS_COL) {
        var cell = sh.getRange(headerRow + 1 + i, CONFIG.PO_STATUS_COL);
        cell.setValue(poCanon_(cell, poStatus_(status)));   // v39 - one of the five words, always
      }
      try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}
      return 'PO Log marked ' + poStatus_(status);
    }
  }
  return 'PO ' + po + ' not found on the PO Log';
}

function requestDismiss_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values, note = '';
  loc.sheet.getRange(loc.row, 15).setValue('dismissed');
  loc.sheet.getRange(loc.row, 20, 1, 2).setValues([[user.email, new Date().toISOString()]]);
  // v46 — a quoted estimate that didn't go ahead closes its Estimate-tab row out as Lost, so the
  // Estimate tab shows what is genuinely still out for quote.
  if (String(v[14]) === 'scheduled' && Number(v[24]) && !String(v[23] || '').trim()) note = poEstimateSetStatus_(Number(v[24]), 'Lost');
  log_(user, 'requestDismiss', v[4], '', String(p.reason || '') + (note ? ('  ·  ' + note) : ''));
  return { ok: true };
}

// ---------------------------------- Activity log ----------------------------------------------

function log_(user, action, target, entryId, detail) {
  try {
    var sh = masterSheet_(SHEETS.LOG);
    if (sh.getLastRow() === 0) sh.appendRow(['Time','Actor','Action','Target','EntryID','Detail']);
    sh.appendRow([new Date().toISOString(), user.email, action, target, entryId, detail]);
  } catch(e) {}
}

// ---------------------------------- Pay period logic (change here only) ------------------------

// 3.5: weekly totals round UP to the quarter hour (employee-favouring, Alberta-safe).
function roundQ_(h){ return Math.ceil(h*4 - 1e-9)/4; }
function weeklyRounded_(entries, filterFn) {
  var weeks = {};
  entries.forEach(function(e){
    if (!filterFn(e)) return;
    var t = new Date(e.ClockIn || e.Date); if (isNaN(t)) return;
    var ws = startOfWeek_(t).getTime();
    weeks[ws] = (weeks[ws] || 0) + (Number(e.Hours) || 0);
  });
  var total = 0;
  Object.keys(weeks).forEach(function(k){ total += roundQ_(weeks[k]); });
  return Math.round(total * 100) / 100;
}
function periodKey_(d) {
  d = new Date(d);
  var y = d.getFullYear(), m = d.getMonth()+1;
  if (CONFIG.PAY_PERIOD_TYPE === 'MONTHLY') return y + '-' + pad2_(m) + '-M'; // -M keeps the key text — bare '2026-08' becomes a Date in Sheets and matching dies
  // SEMI_MONTHLY: 1–15 = 'A', 16–end = 'B'
  var half = d.getDate() <= 15 ? 'A' : 'B';
  return y + '-' + pad2_(m) + '-' + half;
}
function prevPeriodKey_(d) {
  d = new Date(d);
  if (CONFIG.PAY_PERIOD_TYPE === 'MONTHLY') { d.setMonth(d.getMonth()-1); return periodKey_(d); }
  if (d.getDate() <= 15) { d.setDate(0); return periodKey_(d); } // go to prior month, day>15 => B
  d.setDate(1); return periodKey_(d); // same month first half
}

// ---------------------------------- OT flag ----------------------------------------------------

function weekOvertimeFlag_(email, when) {
  var sh = getEmployeeSheet_(email, false);
  if (!sh) return false;
  var start = startOfWeek_(when), end = new Date(start); end.setDate(end.getDate()+7);
  var last = sh.getLastRow();
  if (last <= ENTRY_HEADER_ROW) return false;
  var vals = sh.getRange(ENTRY_HEADER_ROW+1,1,last-ENTRY_HEADER_ROW,ENTRY_HEADERS.length).getValues();
  var total = 0;
  vals.forEach(function(r){
    var ci = r[COL['ClockIn']-1]; if (!ci) return;
    var t = new Date(ci);
    if (t >= start && t < end && r[COL['Status']-1] !== 'rejected' && r[COL['Status']-1] !== 'deleted') total += Number(r[COL['Hours']-1])||0;
  });
  return total > CONFIG.OT_WEEKLY_THRESHOLD;
}
function startOfWeek_(d){ d=new Date(d); var day=d.getDay(); var diff=(day===0?6:day-1); d.setHours(0,0,0,0); d.setDate(d.getDate()-diff); return d; } // Monday start

// ---------------------------------- Forgot-to-clock-out sweep (time trigger) -------------------

/* v30 — Run setupForgotClockoutReminder() ONCE from the editor: installs the every-2-hours
 * trigger for forgotClockoutSweep below. The Activity Log shows it has never run (no
 * forgotClockoutReminder rows), so a lost clock-out went unnoticed for days.
 * v31 — the sweep fires at STILL_CLOCKED_IN_EMAIL_HOURS (24 h) and the email goes to the
 * employee AND every admin. From the office's side a clock-out that never arrived from the
 * phone looks exactly like a forgotten one — the entry is simply still open — so this one
 * email is the safety net for both, and says so. Re-running setup is harmless. */
function setupForgotClockoutReminder() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'forgotClockoutSweep') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('forgotClockoutSweep').timeBased().everyHours(2).create();
  forgotClockoutSweep();
}
/* Every admin: the seed list plus anyone made an admin in the Employees tab. Lower-cased,
 * de-duplicated, minus `except` (so the employee is never both To and Cc). */
function adminEmails_(except) {
  var set = {};
  (CONFIG.ADMIN_EMAILS || []).forEach(function(a){ if (a) set[lc_(a)] = true; });
  try {
    listEmployees_({ role:'admin', permissions: defaultPermissions_('admin') }).employees.forEach(function(e){
      if (e.active && e.role === 'admin' && e.email) set[lc_(e.email)] = true;
    });
  } catch (e) {}
  if (except) delete set[lc_(except)];
  return Object.keys(set);
}
/* One email, To: the employee, Cc: the admins. Never throws — an email must not break a punch. */
function alertMail_(employeeEmail, subject, body) {
  var cc = adminEmails_(employeeEmail);
  try {
    MailApp.sendEmail(employeeEmail, subject, body, cc.length ? { cc: cc.join(','), name: 'PCW / PRO Timesheet' } : { name: 'PCW / PRO Timesheet' });
    return [employeeEmail].concat(cc);
  } catch (e) { return []; }
}
function hoursText_(h) { h = Number(h) || 0; return h >= 48 ? (Math.round(h / 24 * 10) / 10) + ' days' : Math.round(h) + ' hours'; }
function whenText_(iso) {
  var d = new Date(iso); if (isNaN(d)) return String(iso || '');
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'EEE MMM d, h:mm a');
}
function forgotClockoutSweep() {
  var emps = listEmployees_({ role:'admin', permissions: defaultPermissions_('admin') }).employees;
  var now = new Date();
  var limit = Number(CONFIG.STILL_CLOCKED_IN_EMAIL_HOURS) || 24;
  emps.forEach(function(emp){
    if (!emp.active || emp.role === 'bookkeeper') return; // no punch reminders for the bookkeeper
    var open = findOpenEntry_(emp.email);
    if (!open || !open.ClockIn) return;
    var hrs = (now - new Date(open.ClockIn)) / 3600000;
    if (hrs < limit) return;
    // v30 — one email per open entry per day, not one every run.
    var props = PropertiesService.getScriptProperties(), key = 'fcr_' + open.EntryID;
    var lastSent = Number(props.getProperty(key) || 0);
    if (now.getTime() - lastSent < 20 * 3600000) return;
    try { props.setProperty(key, String(now.getTime())); } catch (e) {}
    var site = open['Customer/Job Site'] || open.Company || '';
    var sent = alertMail_(emp.email,
      'Still clocked in ' + hoursText_(hrs) + ' — ' + emp.name + (site ? ' at ' + site : ''),
      'Hi ' + emp.name + ',\n\n' +
      'The timesheet still shows you CLOCKED IN since ' + whenText_(open.ClockIn) + (site ? ' at "' + site + '"' : '') +
      ' — that is ' + hoursText_(hrs) + ' ago, and no clock-out has reached the office.\n\n' +
      'This means one of two things:\n' +
      '  1. The clock-out was tapped but is still waiting on your phone (no signal at the time). ' +
      'Open the app where you have signal — it sends by itself, or tap the "waiting to send" banner and Send now.\n' +
      '  2. It was forgotten. Open the app, tap the red "Still clocked in since…" banner and enter the time you actually stopped. ' +
      'It goes to the admin for approval like any late fix.\n\n' +
      'Admins are copied on this email so the hours get sorted out either way.\n' +
      '(Entry ' + open.EntryID + ')\n');
    log_({email:'system'}, 'forgotClockoutReminder', emp.email, open.EntryID, Math.round(hrs) + 'h → ' + (sent.length ? sent.join(', ') : 'email failed'));
  });
}

// ---------------------------------- Late / stuck punches (v31) --------------------------------

/* A punch is "late" when the phone delivers it STUCK_PUNCH_HOURS or more after it was tapped
 * (payload.queuedAt is the phone's queue time, sent by the app's flushQueue and by the service
 * worker). The punch is saved as normal — this only makes sure someone hears about it, because
 * a day-old clock-out arriving means the phone could not send for a day. Called from doPost
 * after a successful punch; never for a replay (duplicate) — that email already went. */
function noteLatePunch_(user, action, p, result) {
  try {
    if (!p || !p.queuedAt || (result && result.duplicate)) return;
    var queued = Number(p.queuedAt); if (!queued) return;
    var hrs = (Date.now() - queued) / 3600000;
    if (hrs < (Number(CONFIG.STUCK_PUNCH_HOURS) || 24)) return;
    var what = { clockIn: 'clock-in', clockOut: 'clock-out', switchJobSite: 'job switch', startBreak: 'break start', endBreak: 'break end' }[action] || action;
    // A whole day's punches usually arrive late together — one email per person per day, every one logged.
    var props = PropertiesService.getScriptProperties(), key = 'late_' + lc_(user.email);
    var last = Number(props.getProperty(key) || 0), quiet = Date.now() - last < 20 * 3600000;
    if (!quiet) { try { props.setProperty(key, String(Date.now())); } catch (e) {} }
    var sent = quiet ? [] : alertMail_(user.email,
      'A ' + what + ' from ' + user.name + ' arrived ' + hoursText_(hrs) + ' late',
      'Hi ' + user.name + ',\n\n' +
      'Your ' + what + ' tapped ' + whenText_(p.at || queued) + (p.jobSite ? ' at "' + p.jobSite + '"' : '') +
      ' only reached the office now — ' + hoursText_(hrs) + ' after it was tapped. It waited on the phone that long ' +
      'because the app could not get through.\n\n' +
      'It is saved with the original time, so nothing is lost — but please check that entry, and if this keeps ' +
      'happening tell an admin: the phone may not be getting signal at that site.\n' +
      'Any other punches from that phone arriving late today are logged, without another email.\n' +
      (p.entryId ? '(Entry ' + p.entryId + ')\n' : ''));
    log_(user, 'LATE ' + action, user.email, String(p.entryId || ''), Math.round(hrs) + 'h after tap at=' + String(p.at || '') + ' → ' + (quiet ? 'logged (emailed earlier today)' : (sent.length ? sent.join(', ') : 'email failed')));
  } catch (e) {}
}
/* The phone reports a punch that has been waiting on it for STUCK_PUNCH_HOURS and still has
 * not been accepted (it can reach the office — otherwise this call could not arrive — but the
 * punch itself keeps failing, e.g. an older shift is blocking the clock-in). One email per
 * punch per day. */
function punchStuck_(user, p) {
  p = p || {};
  var key = 'stuck_' + lc_(user.email) + '_' + String(p.at || p.queuedAt || '');
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(key) || 0);
  if (Date.now() - last < 20 * 3600000) return { emailed: false, throttled: true };
  try { props.setProperty(key, String(Date.now())); } catch (e) {}
  var hrs = p.queuedAt ? (Date.now() - Number(p.queuedAt)) / 3600000 : (Number(p.hours) || 0);
  var what = { clockIn: 'clock-in', clockOut: 'clock-out', switchJobSite: 'job switch', startBreak: 'break start', endBreak: 'break end' }[p.action] || String(p.action || 'punch');
  var sent = alertMail_(user.email,
    'NOT SAVED: a ' + what + ' from ' + user.name + ' has been stuck for ' + hoursText_(hrs),
    'Hi ' + user.name + ',\n\n' +
    'A ' + what + ' you tapped ' + whenText_(p.at || p.queuedAt) + (p.jobSite ? ' at "' + p.jobSite + '"' : '') +
    ' has been waiting on your phone for ' + hoursText_(hrs) + ' and the office still does not have it.\n\n' +
    'The app keeps trying, but the last answer was:\n    ' + String(p.lastError || 'no answer') + '\n\n' +
    'What to do: open the app, tap the banner at the top and press "Send now". If it still will not go, ' +
    'enter the time by hand (Entries → Manual entry) and reply to this email so an admin can sort it out.\n' +
    (p.entryId ? '(Entry ' + p.entryId + ')\n' : ''));
  log_(user, 'STUCK ' + String(p.action || 'punch'), user.email, String(p.entryId || ''), Math.round(hrs) + 'h at=' + String(p.at || '') + ' err=' + String(p.lastError || '') + ' → ' + (sent.length ? sent.join(', ') : 'email failed'));
  return { emailed: sent.length > 0 };
}

// ---------------------------------- Weekly backup (time trigger) -------------------------------

function weeklyBackup() {
  // Install a weekly time-driven trigger for this. Copies the master spreadsheet into a
  // "Backups" folder under the master Drive folder; keeps the 8 most recent copies.
  var master = DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID);
  var it = master.getFoldersByName('Backups');
  var folder = it.hasNext() ? it.next() : master.createFolder('Backups');
  var file = DriveApp.getFileById(CONFIG.MASTER_SPREADSHEET_ID);
  file.makeCopy('Timesheet backup ' + fmtDate_(new Date()), folder);
  // prune to newest 8
  var backups = [];
  var files = folder.getFiles();
  while (files.hasNext()) backups.push(files.next());
  backups.sort(function(a,b){ return b.getDateCreated() - a.getDateCreated(); });
  for (var i = 8; i < backups.length; i++) backups[i].setTrashed(true);
  log_({email:'system'}, 'weeklyBackup', '', '', backups.length + ' kept');
}

function shareExistingMediaWithUploaders() {
  // One-time back-fill (run from the editor): uploads made before auto-sharing existed are
  // only visible to the admin. Grants each file's uploader view access, keyed off the
  // "By <email> — entry <id>" description stamp every upload carries.
  var n = 0;
  (function walk(folder) {
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var m = /^By (\S+@\S+)/.exec(f.getDescription() || '');
      if (m) { try { f.addViewer(m[1]); n++; } catch (e) {} }
    }
    var subs = folder.getFolders();
    while (subs.hasNext()) {
      var sub = subs.next();
      if (sub.getName() !== 'Backups') walk(sub); // backups are sheet copies, not media
    }
  })(DriveApp.getFolderById(CONFIG.MASTER_DRIVE_FOLDER_ID));
  Logger.log('shareExistingMediaWithUploaders: shared ' + n + ' file(s).');
}

// ---------------------------------- v2 migration (run once from editor) ------------------------

function migrateTabsV2() {
  // Rewrites the header row on every employee tab to include the v2 columns
  // (Gross Hours / Break Hrs / Breaks JSON). Existing data is untouched — new columns
  // simply start empty. Safe to run more than once.
  var ss = masterSs_();
  var n = 0;
  ss.getSheets().forEach(function(sh){
    var note = sh.getRange('A1').getNote();
    if (!note || note.indexOf('email:') !== 0) return;
    sh.getRange(ENTRY_HEADER_ROW, 1, 1, ENTRY_HEADERS.length).setValues([ENTRY_HEADERS]).setFontWeight('bold');
    n++;
  });
  Logger.log('migrateTabsV2: updated headers on ' + n + ' employee tab(s).');
}

// ---------------------------------- One-time initializer ---------------------------------------

function initializeSpreadsheet() {
  var ss;
  if (CONFIG.MASTER_SPREADSHEET_ID) ss = SpreadsheetApp.openById(CONFIG.MASTER_SPREADSHEET_ID);
  else { ss = SpreadsheetApp.create('PCW-PRO Timesheet Data'); Logger.log('Created MASTER_SPREADSHEET_ID: ' + ss.getId()); }

  ensureSheet_(ss, SHEETS.EMPLOYEES, ['Email','Name','Role','Active','Hourly Rate','Permissions (JSON)']);
  ensureSheet_(ss, SHEETS.MASTER, ['Employee','Email','Role','Rate','Current Period Approved Hrs','Est. Pay']);
  ensureSheet_(ss, SHEETS.LOG, ['Time','Actor','Action','Target','EntryID','Detail']);
  ensureSheet_(ss, SHEETS.SETTINGS, ['Key','Value']);
  ensureSheet_(ss, SHEETS.MATERIALS, ['Item','SKU','Unit','Aliases','Source','Added By','Added At']);
  ensureSheet_(ss, SHEETS.MATLOG, ['Time','Employee','EntryID','Job Site','PO#','Item','Qty','Unit','Status','Resolved By']);
  ensureSheet_(ss, SHEETS.JHA, ['JhaID','Date','Job Site','PO#','Created By','Data (JSON)','Signatures (JSON)','PDF URL','Created At']);
  ensureSheet_(ss, SHEETS.ONBOARD, ['Order','Title','Type','Details','Link','Required']);
  ensureSheet_(ss, SHEETS.ONBOARDLOG, ['Email','Done JSON','Completed At','PDF URL']);
  ensureSheet_(ss, SHEETS.SCHED, ['EventID','Assigned JSON','Assigned By','Updated At']);
  ensureSheet_(ss, SHEETS.TIMEOFF, ['ReqID','Email','Start Date','End Date','Reason','Status','Requested At','Decided By','Decided At']);
  ensureSheet_(ss, SHEETS.ALLOW, ['ID','Email','Date','Type','Km','Amount','Note','Status','Requested At','Decided By','Decided At']);

  // seed admins + bookkeepers
  CONFIG.ADMIN_EMAILS.forEach(function(e){ if(!getEmployeeRecordIn_(ss, e)) appendEmp_(ss, e, e.split('@')[0], 'admin'); });
  CONFIG.BOOKKEEPER_EMAILS.forEach(function(e){ if(!getEmployeeRecordIn_(ss, e)) appendEmp_(ss, e, e.split('@')[0], 'bookkeeper'); });

  var def = ss.getSheetByName('Sheet1'); if (def && def.getLastRow()===0) ss.deleteSheet(def);
  Logger.log('Initialized. MASTER_SPREADSHEET_ID = ' + ss.getId());
  return ss.getId();
}
function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
  return sh;
}
function getEmployeeRecordIn_(ss, email) {
  var sh = ss.getSheetByName(SHEETS.EMPLOYEES); var last = sh.getLastRow();
  if (last<2) return null;
  var vals = sh.getRange(2,1,last-1,1).getValues();
  for (var i=0;i<vals.length;i++) if (lc_(vals[i][0])===lc_(email)) return i+2;
  return null;
}
function appendEmp_(ss, email, name, role) {
  ss.getSheetByName(SHEETS.EMPLOYEES).appendRow([lc_(email), name, role, true, 0, JSON.stringify(defaultPermissions_(role))]);
}

// ---------------------------------- Small utilities --------------------------------------------

// Prefixed so an ID can NEVER look like a pure number: Sheets silently converts number-like
// strings to real numbers on write, and a numeric cell then fails string comparison on read —
// which made ~1 in 43 entries (all-digit hex IDs) unfindable at clock-out. The 'e' prefix
// prevents it for new IDs; findEntryRow_'s String() compare rescues old numeric-converted rows.
function newId_(){ return 'e' + Utilities.getUuid().replace(/-/g,'').substring(0,8); }
// Client-supplied event time (offline punches sync late, so server-receive time is wrong).
// Trusted within a sane window: not in the future (clock skew) and not absurdly old.
function clientTime_(at) {
  var now = new Date();
  if (!at) return now;
  var d = new Date(at);
  if (isNaN(d)) return now;
  if (d.getTime() > now.getTime() + 5*60000) return now;      // future = skewed phone clock
  if (d.getTime() < now.getTime() - 14*86400000) return now;  // >2 weeks stale = implausible
  return d;
}
// Neutralize spreadsheet formula injection: a user-typed value starting with = + or @ would
// otherwise be interpreted as a live formula executing under the script owner's account.
function txt_(v){ return (typeof v === 'string' && /^[=+@]/.test(v)) ? ("'" + v) : v; }
function lc_(s){ return String(s||'').toLowerCase().trim(); }
function pad2_(n){ return (n<10?'0':'')+n; }
// v33 - a bare 'YYYY-MM-DD' is now returned unchanged. new Date('2026-09-05') parses as
// midnight UTC, which in Mountain time is the evening of the 4th, so the old round-trip
// wrote the day BEFORE the one it was given - silently, while reporting success. Four End
// Dates landed a day early on 2026-09-21 this way. Date objects and datetime strings are
// unaffected; only the date-only string path changed.
function fmtDate_(d){
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return d.trim();
  d=new Date(d); return d.getFullYear()+'-'+pad2_(d.getMonth()+1)+'-'+pad2_(d.getDate());
}
function dayName_(d){ return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d).getDay()]; }
function gpsStr_(g){ return (g && g.lat!=null) ? (g.lat.toFixed(5)+','+g.lng.toFixed(5)+(g.acc?(' ±'+Math.round(g.acc)+'m'):'')) : ''; }
function appendNote_(existing, add){ return existing ? (existing + ' | ' + add) : add; }
function combineDateTime_(date, time){ if(!date||!time) return ''; return new Date(date+'T'+time+':00').toISOString(); }
function keyFor_(header){ return { 'Customer/Job Site':'jobSite','PO#':'poNumber','Company':'company','Notes':'notes','ClockIn':'clockIn','ClockOut':'clockOut','Date':'date' }[header] || header; }
function safeJson_(s){ try { return typeof s==='object'? s : JSON.parse(s); } catch(e){ return null; } }
function csvCell_(v){ v = v==null?'':String(v); if (/^[=+@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; } // ' disarms =formula names in Excel
function a1Col_(n){ var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; }
function similar_(a,b){ // cheap "did you mean": token overlap or short edit distance on first token
  if (Math.abs(a.length-b.length) > 4) { /* still allow token overlap */ }
  var at=a.split(/\s+/), bt=b.split(/\s+/);
  for (var i=0;i<at.length;i++) for (var j=0;j<bt.length;j++){
    if (at[i].length>=3 && bt[j].length>=3 && (at[i].indexOf(bt[j])>=0 || bt[j].indexOf(at[i])>=0)) return true;
    if (lev_(at[i],bt[j]) <= 2 && Math.min(at[i].length,bt[j].length)>=4) return true;
  }
  return false;
}
function lev_(a,b){ var m=a.length,n=b.length,dp=[]; for(var i=0;i<=m;i++){dp[i]=[i];} for(var j=0;j<=n;j++){dp[0][j]=j;}
  for(var i=1;i<=m;i++)for(var j=1;j<=n;j++){ dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); } return dp[m][n]; }


/* ============================================================================================
 * v50 - COLUMNS ARE FOUND BY WHAT THEY MEAN
 *
 * Until now every write to the PO Log and the price list needed an EXACT header - "PO Number",
 * to the character. A double space, a renamed column, "PO #", or a typo someone fixed later and
 * the whole sequence stopped: no PO Log row for the customer, no new parts, no inventory.
 *
 * Now each column is found by what it MEANS. Every header in the row is scored against the
 * names that column is known by, and the best takes it - provided it is clearly better than the
 * runner-up. Nothing is ever guessed between two equally plausible columns: that falls back to
 * the column number the code always used, so this can only do better than the old behaviour,
 * never worse. Run checkHeaders() from the editor to see what resolved to what.
 * ==========================================================================================*/

/* "P.O.  Number " -> "po number".  hdrSquash_ -> "ponumber" */
function hdrNorm_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function hdrSquash_(s) { return hdrNorm_(s).replace(/ /g, ''); }

/* Edit distance that counts an adjacent swap as ONE change, because "Dtae" for "Date" and
 * "Nmae" for "Name" are the typos people actually make. lev_ is left alone - poNameNear_ uses
 * it on customer names, where a swap really is two changes. */
function levSwap_(a, b) {
  var m = a.length, n = b.length, dp = [];
  for (var i = 0; i <= m; i++) { dp[i] = [i]; }
  for (var j = 0; j <= n; j++) { dp[0][j] = j; }
  for (var i = 1; i <= m; i++) for (var j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + 1);
  }
  return dp[m][n];
}

/* How well one header label matches one name this column is known by. 0 = no match.
 * A TYPO on the real label must beat a longer header that merely CONTAINS the name, or
 * "PO Numbr" resolves to "PO Number in Quickbooks". So: typo 68-80, containment 45-80. */
function hdrScore_(header, name) {
  var h = hdrNorm_(header), n = hdrNorm_(name);
  if (!h || !n) return 0;
  if (h === n) return 100;
  var hs = hdrSquash_(h), ns = hdrSquash_(n);
  if (hs === ns) return 90;
  var tol = ns.length >= 9 ? 2 : ns.length >= 5 ? 1 : 0;
  if (tol) {
    var d = levSwap_(hs, ns);
    if (d > 0 && d <= tol) return 80 - ((d - 1) * 12);
  } else if (ns.length >= 4 && levSwap_(hs, ns) === 1 && lev_(hs, ns) === 2) {
    return 78;   // a SWAP on a short label ("Unti" for "Unit"). A substitution that short is
                 // not forgiven - on four letters it is too often a different word entirely.
  }
  if (Math.min(hs.length, ns.length) >= 4) {
    if (h.indexOf(n) >= 0 || n.indexOf(h) >= 0) {
      var ratio = Math.min(h.length, n.length) / Math.max(h.length, n.length);
      return 45 + Math.round(ratio * 35);
    }
    if (hs.indexOf(ns) >= 0 || ns.indexOf(hs) >= 0) {
      var r2 = Math.min(hs.length, ns.length) / Math.max(hs.length, ns.length);
      return 43 + Math.round(r2 * 35);
    }
  }
  return 0;
}

/* headers: the header row as an array. names: every label this column is known by, best first.
 * Returns a 1-based column number, or 0 when nothing is clearly best. */
function hdrResolve_(headers, names, minScore, margin) {
  minScore = minScore || 55; margin = margin == null ? 10 : margin;
  var best = { col: 0, score: 0 }, second = 0;
  for (var i = 0; i < headers.length; i++) {
    var s = 0;
    for (var k = 0; k < names.length; k++) s = Math.max(s, hdrScore_(headers[i], names[k]));
    if (s > best.score) { second = best.score; best = { col: i + 1, score: s }; }
    else if (s > second) second = s;
  }
  if (best.score < minScore) return 0;
  if (best.score - second < margin) return 0;          // two equally plausible: do not guess
  return best.col;
}

/* What every PO Log column is known by. First name is the one on the sheet today. */
var PO_FIELDS_ = {
  PO_NUMBER_COL:    ['po number', 'po', 'job number', 'purchase order number', 'po no'],
  PO_CONTACT_COL:   ['contact person', 'contact', 'customer', 'client'],
  PO_CUSTOMER_COL:  ['company name', 'company', 'business name', 'business'],
  PO_PROJECT_COL:   ['project name', 'project', 'work place', 'job name'],
  PO_STARTDATE_COL: ['start date', 'start', 'date started', 'begin date'],
  PO_ENDDATE_COL:   ['end date', 'end', 'date finished', 'completion date'],
  PO_QB_COL:        ['po number in quickbooks', 'quickbooks po number', 'quickbooks', 'qb po', 'qb number'],
  PO_TYPE_COL:      ['type', 'job type', 'category'],
  PO_EMAIL_COL:     ['email address', 'email', 'e mail'],
  PO_PHONE_COL:     ['phone number', 'phone', 'telephone', 'cell', 'contact number'],
  PO_ADDRESS_COL:   ['job address', 'address', 'site address', 'location'],
  PO_DESC_COL:      ['description of work', 'description', 'work description', 'scope'],
  PO_STATUS_COL:    ['status', 'job status', 'state']
};

/* The header row of a PO-Log-shaped tab. The old code looked for the exact text "PO Number";
 * now any row whose cells resolve to several known PO Log columns counts, so a renamed or
 * mistyped header no longer hides the table. 0 when nothing looks like a header. */
function poHeaderRow_(sh) {
  try {
    var last = Math.min(sh.getLastRow(), 40), wide = Math.max(1, sh.getLastColumn());
    if (last < 1) return 0;
    var vals = sh.getRange(1, 1, last, wide).getValues();
    var bestRow = 0, bestHits = 0;
    for (var r = 0; r < vals.length; r++) {
      var hits = 0;
      for (var k in PO_FIELDS_) if (hdrResolve_(vals[r], PO_FIELDS_[k])) hits++;
      if (hits > bestHits) { bestHits = hits; bestRow = r + 1; }
    }
    return bestHits >= 3 ? bestRow : 0;        // three recognisable columns is a header row
  } catch (e) { return 0; }
}

/* Correct CONFIG's PO Log column numbers from the sheet's actual header row. Runs once per
 * execution. A column that cannot be resolved keeps the number it always had, so a sheet
 * nobody has touched behaves exactly as before. Never throws. */
var poColsSynced_ = false;
function poSyncCols_(sh) {
  if (poColsSynced_) return;
  try {
    if (!sh) return;
    var row = poHeaderRow_(sh);
    if (!row) return;
    var headers = sh.getRange(row, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    var moved = [];
    for (var key in PO_FIELDS_) {
      var c = hdrResolve_(headers, PO_FIELDS_[key]);
      if (c && c !== CONFIG[key]) { moved.push(key + ' ' + CONFIG[key] + '->' + c); CONFIG[key] = c; }
    }
    poColsSynced_ = true;
    if (moved.length) {
      try { log_({ email: 'system' }, 'poSyncCols', '', '', 'PO Log columns re-read: ' + moved.join(', ')); } catch (e) {}
    }
  } catch (e) {}
}

/* What every price-list Materials column is known by. */
var MAT_FIELDS_ = {
  M_SKU:   ['sku ours', 'sku', 'our sku', 'item code', 'part code'],
  M_DESC:  ['description', 'item', 'material'],
  M_UNIT:  ['unit', 'uom', 'unit of measure'],
  M_INV:   ['inventory', 'on hand', 'qty on hand', 'stock', 'count'],
  M_PRICE: ['price', 'unit price', 'cost', 'last price'],
  M_SRC:   ['price source', 'source', 'price from'],
  M_SUP:   ['last bought from', 'supplier', 'vendor', 'bought from'],
  M_DATE:  ['last bought', 'last purchase date', 'purchase date', 'date bought'],
  M_LO:    ['lowest', 'lowest price', 'cheapest price'],
  M_LOSUP: ['cheapest at', 'lowest at', 'cheapest from'],
  M_HI:    ['highest', 'highest price', 'dearest price'],
  M_HISUP: ['dearest at', 'highest at', 'dearest from'],
  M_PARTS: ['supplier part numbers', 'supplier part number', 'their part', 'part numbers'],
  M_CHECK: ['check', 'review', 'flag']
};

/* Correct the M_* column numbers from the Materials tab's real header row. Same contract as
 * poSyncCols_: once per execution, unresolved columns keep their old number, never throws.
 * This is what lets a new part be added and the count updated even after someone has renamed
 * a header or dropped a column in. */
var matColsSynced_ = false;
function plResolveCols_() {
  if (matColsSynced_) return;
  try {
    var sh = plSs_().getSheetByName(MAT_TAB);
    if (!sh || sh.getLastRow() < 1) return;
    var headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    var cur = { M_SKU: M_SKU, M_DESC: M_DESC, M_UNIT: M_UNIT, M_INV: M_INV, M_PRICE: M_PRICE,
                M_SRC: M_SRC, M_SUP: M_SUP, M_DATE: M_DATE, M_LO: M_LO, M_LOSUP: M_LOSUP,
                M_HI: M_HI, M_HISUP: M_HISUP, M_PARTS: M_PARTS, M_CHECK: M_CHECK };
    var got = {}, moved = [], maxCol = 0;
    for (var key in MAT_FIELDS_) {
      var c = hdrResolve_(headers, MAT_FIELDS_[key]);
      got[key] = c || cur[key];
      if (c && c !== cur[key]) moved.push(key + ' ' + cur[key] + '->' + c);
      if (got[key] > maxCol) maxCol = got[key];
    }
    M_SKU = got.M_SKU; M_DESC = got.M_DESC; M_UNIT = got.M_UNIT; M_INV = got.M_INV;
    M_PRICE = got.M_PRICE; M_SRC = got.M_SRC; M_SUP = got.M_SUP; M_DATE = got.M_DATE;
    M_LO = got.M_LO; M_LOSUP = got.M_LOSUP; M_HI = got.M_HI; M_HISUP = got.M_HISUP;
    M_PARTS = got.M_PARTS; M_CHECK = got.M_CHECK;
    M_COLS = Math.max(M_COLS, maxCol);          // a row read must still cover every column
    matColsSynced_ = true;
    if (moved.length) {
      try { log_({ email: 'system' }, 'plResolveCols', '', '', 'Price list columns re-read: ' + moved.join(', ')); } catch (e) {}
    }
  } catch (e) {}
}

/* Run from the editor. Says, in plain words, which column every field resolved to on both
 * sheets and which ones fell back - so a header that has drifted is visible BEFORE it matters.
 * Read-only: it changes nothing. */
function checkHeaders() {
  var out = [];
  try {
    var sh = poTab_(SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID), CONFIG.PO_SHEET_NAME);
    var row = poHeaderRow_(sh);
    out.push('PO LOG  (tab "' + sh.getName() + '", header row ' + (row || '?') + ')');
    if (row) {
      var H = sh.getRange(row, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
      for (var k in PO_FIELDS_) {
        var c = hdrResolve_(H, PO_FIELDS_[k]);
        out.push('  ' + (c ? 'OK      ' : 'FALLBACK') + '  ' + k.replace(/^PO_|_COL$/g, '') +
                 ' -> col ' + (c || CONFIG[k]) + (c ? ' "' + H[c - 1] + '"' : ' (nothing matched; using the old number)'));
      }
    } else out.push('  COULD NOT FIND A HEADER ROW - every field falls back to its old column number.');
  } catch (e) { out.push('PO LOG: could not be read - ' + e.message); }
  try {
    matColsSynced_ = false; plResolveCols_();
    var ms = plSs_().getSheetByName(MAT_TAB);
    var MH = ms.getRange(1, 1, 1, Math.max(1, ms.getLastColumn())).getValues()[0];
    out.push('', 'PRICE LIST  (tab "' + MAT_TAB + '")');
    for (var k2 in MAT_FIELDS_) {
      var c2 = hdrResolve_(MH, MAT_FIELDS_[k2]);
      out.push('  ' + (c2 ? 'OK      ' : 'FALLBACK') + '  ' + k2.replace(/^M_/, '') +
               ' -> col ' + c2 + (c2 ? ' "' + MH[c2 - 1] + '"' : ' (nothing matched; using the old number)'));
    }
  } catch (e2) { out.push('PRICE LIST: could not be read - ' + e2.message); }
  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}


/* ============================================================================================
 * v38 - CLAUDE CAN EDIT THE PO LOG  (poLogFind / poLogUpdate / poLogAdd, inbound key)
 *
 * Until now the key only opened four narrow doors (requestAdd, jobInvoiced, jobSetStatus,
 * jobSetDates), so Claude could not add a PO by hand or correct a contact, phone or address.
 * These three close that gap, and they are still deliberately fenced:
 *   - every cell is found by its HEADER label, never a hard-coded column, so a reordered
 *     or renamed column can never receive the wrong field;
 *   - the PO Number cell itself is never rewritten - renumbering an existing PO would break
 *     QuickBooks, the Drive folders and the timesheets that point at it;
 *   - a cell with a dropdown gets the dropdown's OWN spelling ("in progress" -> "In progress"),
 *     and a value that is not on the list is refused with the allowed values named, instead of
 *     the sheet throwing halfway through a row (the R26191 half-row, Sept 29 2026);
 *   - text starting with = + @ is written as text, never as a formula;
 *   - every change is written to the Activity Log with before -> after.
 * ==========================================================================================*/

// Friendly names Claude may use -> the PO Log header label they mean. Any exact header label
// (case-insensitive) is also accepted, so a column Charles adds later works without a code change.
var PO_FIELD_ALIASES_ = {
  contact: 'contact person', company: 'company name', customer: 'company name',
  project: 'project name', start: 'start date', startdate: 'start date',
  end: 'end date', enddate: 'end date', qb: 'po number in quickbooks',
  qbpo: 'po number in quickbooks', quickbooks: 'po number in quickbooks',
  type: 'type', email: 'email address', phone: 'phone number',
  address: 'job address', description: 'description of work', desc: 'description of work',
  status: 'status'
};
var PO_DATE_HEADERS_ = ['start date', 'end date'];

// v39 - the Status dropdown was removed (Paul, Sept 29 2026), so the script is now what keeps
// Status to these five exact words. The app counts Invoiced/Closed as finished and skips
// Cancelled when checking for duplicates, so a stray spelling would quietly miscount a job.
var PO_STATUSES_ = ['Estimated', 'In progress', 'Invoiced', 'Closed', 'Cancelled'];
var PO_STATUS_COLOURS_ = {            // background, text  (used by setupPoStatusColours)
  'Estimated':   ['#e8eaed', '#3c4043'],
  'In progress': ['#fef7e0', '#b06000'],
  'Invoiced':    ['#e8f0fe', '#1967d2'],
  'Closed':      ['#e6f4ea', '#137333'],
  'Cancelled':   ['#fce8e6', '#c5221f']
};

/* One of the five Status words in its exact spelling, or a readable error. 'canceled',
 * ' closed ' and 'IN PROGRESS' are all accepted and written the proper way. */
function poStatus_(v) {
  var want = lc_(v).replace(/\s+/g, ' ');
  if (want === 'canceled') want = 'cancelled';
  for (var i = 0; i < PO_STATUSES_.length; i++) if (lc_(PO_STATUSES_[i]) === want) return PO_STATUSES_[i];
  throw new Error('"' + v + '" is not a PO Log status. Use one of: ' + PO_STATUSES_.join(', '));
}

/* Normalise a PO for comparison: 'r26 184', 'R-26184' and 'R26184' are the same job. */
function poKey_(po) { return String(po || '').toUpperCase().replace(/[\s\-]/g, ''); }

/* The dropdown's own spelling of a value, or the value unchanged when the cell has no list.
 * Throws a readable error when the list rejects the value. */
function poCanon_(range, value) {
  if (value === '' || value == null) return value;
  var rule = null;
  try { rule = range.getDataValidation(); } catch (e) { return value; }
  if (!rule) return value;
  var T = SpreadsheetApp.DataValidationCriteria, type = rule.getCriteriaType(), opts = null;
  if (type === T.VALUE_IN_LIST) {
    opts = rule.getCriteriaValues()[0] || [];
  } else if (type === T.VALUE_IN_RANGE) {
    var src = rule.getCriteriaValues()[0];
    opts = [];
    if (src) src.getValues().forEach(function (r) { r.forEach(function (v) { if (String(v).trim()) opts.push(v); }); });
  } else {
    return value;                                  // not a dropdown (e.g. a date rule) - leave it
  }
  var want = lc_(value);
  for (var i = 0; i < opts.length; i++) if (lc_(opts[i]) === want) return String(opts[i]);
  if (rule.getAllowInvalid()) return value;        // "show a warning" lists accept anything
  throw new Error('"' + value + '" is not allowed in ' + range.getA1Notation() +
                  '. Allowed: ' + opts.map(String).join(', '));
}

/* Open the PO Log and hand back { sh, headerRow, cols: {label -> col} }. */
function poLogOpen_() {
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID);
  var sh = poTab_(ss, CONFIG.PO_SHEET_NAME);
  if (!sh) throw new Error('PO Log tab not found in the PO workbook.');
  var hdr = poHeader_(sh, 'po number');
  if (!hdr) throw new Error('Could not find the "PO Number" header row on the PO Log.');
  return { sh: sh, headerRow: hdr.row, cols: hdr.col };
}

/* Sheet row of a PO, or 0. */
function poLogRowOf_(t, po) {
  var last = t.sh.getLastRow(), key = poKey_(po);
  if (!key || last <= t.headerRow) return 0;
  var pc = t.cols['po number'] || CONFIG.PO_NUMBER_COL;
  var vals = t.sh.getRange(t.headerRow + 1, pc, last - t.headerRow, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (poKey_(vals[i][0]) === key) return t.headerRow + 1 + i;
  return 0;
}

/* v102 - A NEW JOB FOR A CUSTOMER WE ALREADY HAVE (Paul, 9 Nov: "an option on adding a new work
 * order on existing customer but different project or PO ... it will automatically fill in their
 * information except the site address and name"). Read only: who they are, off the row of any of
 * their jobs, closed ones included. The app fills the booking form with it; booking takes the next
 * PO number and writes a new PO Log row as for any new customer. */
function customerFromPo_(user, p) {
  requirePerm_(user, 'approveHours');
  var t = poLogOpen_(), r = poLogRowOf_(t, String(p.po || '').trim());
  if (!r) throw new Error('Job ' + (p.po || '') + ' is not on the PO Log.');
  var o = poLogRowObj_(t, r), byLc = {};
  Object.keys(o).forEach(function (k) { byLc[lc_(k)] = String(o[k] == null ? '' : o[k]).trim(); });
  var g = function (k) { return byLc[k] || ''; };
  return { po: g('po number'), contact: g('contact person'), company: g('company name'), phone: g('phone number'),
           email: g('email address'), address: g('job address'), project: g('project name'), status: g('status') };
}

/* One row as { header label: display value }. */
function poLogRowObj_(t, row) {
  var width = t.sh.getLastColumn();
  var heads = t.sh.getRange(t.headerRow, 1, 1, width).getValues()[0];
  var vals  = t.sh.getRange(row, 1, 1, width).getDisplayValues()[0];
  var o = {};
  for (var i = 0; i < heads.length; i++) { var h = String(heads[i] || '').trim(); if (h) o[h] = vals[i]; }
  return o;
}

/* Turn { contact: 'x', 'Phone Number': 'y' } into [{ label, col, value }]; unknown keys throw
 * BEFORE anything is written, so a typo can never leave a half-updated row. */
function poLogResolveFields_(t, fields) {
  var out = [];
  Object.keys(fields || {}).forEach(function (k) {
    var label = lc_(k);
    if (!t.cols[label]) label = PO_FIELD_ALIASES_[label.replace(/[\s_#.]/g, '')] || label;
    if (label === 'po number') throw new Error('The PO Number itself cannot be changed.');
    var col = t.cols[label];
    if (!col) throw new Error('No PO Log column called "' + k + '". Columns: ' +
                              Object.keys(t.cols).join(', '));
    var v = fields[k];
    if (v != null && v !== '' && PO_DATE_HEADERS_.indexOf(label) >= 0) v = fmtDate_(v);
    if (v != null && v !== '' && label === 'status') v = poStatus_(v);        // v39
    out.push({ label: label, col: col, value: (v == null ? '' : txt_(typeof v === 'string' ? v.trim() : v)) });
  });
  return out;
}

/* READ one PO row.  payload: { po: 'R26184' }  or  { name: 'Koltin' } (contact/company search) */
function poLogFind_(user, p) {
  requireAdmin_(user);
  var t = poLogOpen_();
  if (p.po) {
    var r = poLogRowOf_(t, p.po);
    if (!r) return { found: false, po: p.po };
    return { found: true, row: r, data: poLogRowObj_(t, r) };
  }
  var q = lc_(p.name);
  if (!q) throw new Error('Send po or name.');
  var last = t.sh.getLastRow(), hits = [];
  if (last <= t.headerRow) return { found: false, matches: [] };
  var cC = t.cols['contact person'], cN = t.cols['company name'], pc = t.cols['po number'];
  var vals = t.sh.getRange(t.headerRow + 1, 1, last - t.headerRow, t.sh.getLastColumn()).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    var hay = lc_((cC ? vals[i][cC - 1] : '') + ' ' + (cN ? vals[i][cN - 1] : ''));
    if (hay.indexOf(q) >= 0) hits.push({ row: t.headerRow + 1 + i, po: vals[i][pc - 1] });
  }
  return { found: hits.length > 0, matches: hits.slice(0, 20) };
}

/* EDIT an existing PO row.
 * payload: { po: 'R26184', fields: { contact: 'Koltin Hachey', phone: '780-555-0100',
 *                                    status: 'Invoiced', 'End Date': '2026-09-29' },
 *            onlyBlank: false }
 * onlyBlank: true fills empty cells only and reports the ones it skipped.
 * An empty string clears that cell. */
function poLogUpdate_(user, p) {
  requireAdmin_(user);
  if (!p.po) throw new Error('No PO number given.');
  if (!p.fields || !Object.keys(p.fields).length) throw new Error('No fields to write.');
  return withLock_(function () {
    var t = poLogOpen_();
    var row = poLogRowOf_(t, p.po);
    if (!row) throw new Error('PO ' + p.po + ' is not on the PO Log.');
    var todo = poLogResolveFields_(t, p.fields);
    // Validate every dropdown value first - all or nothing.
    todo.forEach(function (f) { f.value = poCanon_(t.sh.getRange(row, f.col), f.value); });
    var changes = [], skipped = [];
    todo.forEach(function (f) {
      var cell = t.sh.getRange(row, f.col), before = String(cell.getDisplayValue());
      if (p.onlyBlank && before.trim()) { skipped.push(f.label + ' already "' + before + '"'); return; }
      if (String(f.value) === before) return;
      if (f.value === '') cell.clearContent(); else cell.setValue(f.value);
      changes.push(f.label + ': "' + before + '" -> "' + f.value + '"');
    });
    try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}
    var msg = changes.length ? changes.join(' · ') : 'no change';
    log_(user, 'poLogUpdate', '', poKey_(p.po), msg + (skipped.length ? ' (skipped: ' + skipped.join('; ') + ')' : ''));
    return { po: poKey_(p.po), row: row, changed: changes, skipped: skipped, data: poLogRowObj_(t, row) };
  });
}

/* ADD a new PO (burns the next number in the shared sequence).
 * payload: { type: 'Residential'|'Commercial'|'Industrial'|'Mix',
 *            fields: { contact, company, project, start, email, phone, address, description, status },
 *            force: false }
 * Refuses a customer that already has an open row unless force: true. */
function poLogAdd_(user, p) {
  requireAdmin_(user);
  var f = p.fields || {};
  var who = String(f.contact || f.company || f['Contact person'] || f['Company Name'] || '').trim();
  if (!who) throw new Error('A new PO needs at least a contact or company name.');
  if (/^[A-Z]{1,2}-?\s?\d{5,}$/i.test(who)) throw new Error('"' + who + '" looks like a PO number, not a customer name.');
  var typeName = String(p.type || f.type || (f.company ? 'Commercial' : 'Residential')).trim();
  typeName = typeName.charAt(0).toUpperCase() + typeName.slice(1).toLowerCase();
  var letter = CONFIG.PO_TYPE_LETTERS[typeName];
  if (!letter) throw new Error('type must be one of: ' + Object.keys(CONFIG.PO_TYPE_LETTERS).join(', '));

  return withLock_(function () {
    var t = poLogOpen_();
    if (!p.force) {
      try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}
      var dup = getPoCustomers_().filter(function (c) {
        return lc_(c.name) === lc_(who) && !/^(closed|cancell?ed)$/i.test(c.status);
      });
      if (dup.length) return { duplicate: true, existing: dup[0],
        note: 'This customer already has an open PO. Send force: true to add another anyway.' };
    }
    var fields = {}; Object.keys(f).forEach(function (k) { fields[k] = f[k]; });
    delete fields.type; fields['type'] = typeName;
    if (!fields.status && !fields.Status) fields.status = 'In progress';
    if (!fields.start && !fields.startDate && !fields['Start Date']) fields.start = fmtDate_(new Date());
    var todo = poLogResolveFields_(t, fields);                 // throws on a bad key, before the number is burned
    var po = poNextNumber_(letter);
    var row = poFirstFreeRow_(t.sh, t.headerRow, t.cols['po number'] || CONFIG.PO_NUMBER_COL);
    todo.forEach(function (x) { x.value = poCanon_(t.sh.getRange(row, x.col), x.value); });   // all-or-nothing
    t.sh.getRange(row, t.cols['po number'] || CONFIG.PO_NUMBER_COL).setValue(po);
    todo.forEach(function (x) { if (x.value !== '') t.sh.getRange(row, x.col).setValue(x.value); });
    try { CacheService.getScriptCache().remove('poCustomers'); } catch (e) {}
    log_(user, 'poLogAdd', '', po, who + ' (' + typeName + ') row ' + row);
    return { po: po, row: row, data: poLogRowObj_(t, row) };
  });
}


/* ============================================================================================
 * v39 - RUN ONCE FROM THE EDITOR:  setupPoStatusColours
 * Colours the PO Log Status column by its text (conditional formatting), so a status written by
 * the app, by Claude or by hand is coloured the same way and can never drift out of step.
 * Also: removes any leftover dropdown on that column, and tidies existing statuses to the exact
 * five words ("in progress " -> "In progress"). Anything it cannot recognise is left alone and
 * listed in the log. Safe to run again: it replaces only its own Status-column colour rules.
 * ==========================================================================================*/
function setupPoStatusColours() {
  var t = poLogOpen_();
  var sc = t.cols['status'];
  if (!sc) throw new Error('No "Status" column found on the PO Log.');
  var first = t.headerRow + 1, rows = Math.max(t.sh.getMaxRows() - t.headerRow, 1);
  var col = t.sh.getRange(first, sc, rows, 1);

  col.clearDataValidations();

  // tidy existing values
  var vals = col.getValues(), fixed = 0, unknown = [];
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0] || '');
    if (!v.trim()) continue;
    try { var good = poStatus_(v); if (good !== v) { vals[i][0] = good; fixed++; } }
    catch (e) { unknown.push('row ' + (first + i) + ': "' + v + '"'); }
  }
  if (fixed) col.setValues(vals);

  // colour rules: keep every rule that is not ours, replace ours
  var mine = function (rule) {
    return rule.getRanges().some(function (r) { return r.getColumn() === sc && r.getNumColumns() === 1; });
  };
  var rules = t.sh.getConditionalFormatRules().filter(function (r) { return !mine(r); });
  PO_STATUSES_.forEach(function (s) {
    var c = PO_STATUS_COLOURS_[s];
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s).setBackground(c[0]).setFontColor(c[1])
      .setRanges([col]).build());
  });
  t.sh.setConditionalFormatRules(rules);

  var msg = 'Status column ' + col.getA1Notation() + ': dropdown removed, ' + PO_STATUSES_.length +
            ' colour rules set, ' + fixed + ' value(s) tidied' +
            (unknown.length ? '. NOT recognised (left as is): ' + unknown.join('; ') : '.');
  Logger.log(msg);
  return msg;
}


/* ============================================================================================
 * v40 - PAUL'S SEPT 29 LIST
 *   2. openSlots        - real open times for an estimate call (15 / 30 / 60 / 120 min) or a job
 *   3. inventory        - clock-out materials take stock off the shelf (see logMaterials_)
 *   4. bumpPlan/Apply   - book a return visit at ANY day + time; a job already there moves to the
 *                         same time on the next work day, and so on down the line. Nothing moves
 *                         until Paul confirms the plan. Every moved customer lands on the Call List.
 *   5. invoice fire     - the Build Initial Draft button starts Claude straight away (routine API)
 * ==========================================================================================*/

/* ---------- 2. OPEN SLOTS -------------------------------------------------------------------
 * action: "openSlots"
 * payload: { minutes: 30, kind: 'call' | 'job', count: 6, at: ISO (optional), afterDate: 'YYYY-MM-DD' }
 *   call - no travel buffer, today allowed (from 15 min from now), up to 2 offers a day
 *   job  - 30 min travel either side, never today, 1 offer a day (same rules as return visits)
 * Returns { slots: [{start, end}], atFits: bool|null, atWhy: '' } - read-only, books nothing.
 * Timed events block; all-day events do not (they are notes - same rule as slotClashes_).
 * Weekends, Alberta stat holidays and Paul's approved time off are skipped. */
var SLOT_STEP_MIN_ = 15;

function slotBusy_(from, to) {
  var busy = [];
  visitCal_().getEvents(from, to).forEach(function (ev) {
    try {
      if (ev.isAllDayEvent()) return;
      busy.push({ s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime(),
                  id: String(ev.getId()), title: ev.getTitle() || '' });
    } catch (e) {}
  });
  return busy;
}

/* Does [s, s+needMs of work) fit on that day against `busy`? '' when it does, else why not. */
function slotFitsWhy_(s, needMs, busy, bufMs, hol, leave, notBefore, noLunch) {
  var d = new Date(s), dow = d.getDay(), ds = fmtDate_(d);
  if (s < notBefore) return 'that time has passed';
  if (dow === 0 || dow === 6) return 'that is a weekend';
  if (hol[ds]) return ds + ' is ' + hol[ds];
  if (leave[ds]) return 'you are off that day (' + leave[ds] + ')';
  var b = visitDayBounds_(d);
  if (s < b.s) return 'that is before the workday starts';
  if (s >= b.ls && s < b.le) return 'that is lunch';
  var end = visitWorkEnd_(s, needMs, b.ls, b.le);
  if (end > b.e + 60000) return 'it runs past the end of the workday';
  if (noLunch && s < b.ls && end > b.ls) return 'it runs into lunch';        // a call is not split around lunch
  for (var i = 0; i < busy.length; i++) {
    if (busy[i].s - bufMs < end && busy[i].e + bufMs > s) return 'it clashes with "' + busy[i].title + '"';
  }
  return '';
}

function openSlots_(user, p) {
  var kind = (p && p.kind === 'job') ? 'job' : 'call';
  var minutes = Math.max(15, Math.min(9 * 60, Math.round(Number(p && p.minutes) || 30)));
  var needMs = minutes * 60000;
  var count = Math.max(1, Math.min(10, Number(p && p.count) || 6));
  var perDay = kind === 'call' ? 2 : 1;
  var bufMs = (kind === 'job' ? VISIT_.TRAVEL_BUFFER_MIN : 0) * 60000;
  var step = SLOT_STEP_MIN_ * 60000;

  var now = Date.now();
  var notBefore = Math.ceil((now + 15 * 60000) / step) * step;        // a call: from 15 min out
  var from = new Date(); from.setHours(0, 0, 0, 0);
  if (kind === 'job') { from = new Date(from.getTime() + 86400000); notBefore = from.getTime(); }
  if (p && p.afterDate && /^\d{4}-\d{2}-\d{2}$/.test(p.afterDate)) {
    var a = new Date(p.afterDate + 'T00:00:00');
    if (a.getTime() > from.getTime()) from = a;
  }
  var at = (p && p.at) ? new Date(p.at) : null;
  if (at && isNaN(at.getTime())) at = null;
  var scanFrom = at && at.getTime() < from.getTime() ? new Date(at.getFullYear(), at.getMonth(), at.getDate()) : from;
  var to = new Date(from.getTime() + 30 * 86400000);

  var busy = slotBusy_(new Date(scanFrom.getTime() - 86400000), new Date(to.getTime() + 86400000));
  var hol = {}; abHolidays_(scanFrom, to).forEach(function (h) { hol[h.date] = h.name; });
  var leave = visitLeaveDays_(CONFIG.ADMIN_EMAILS[0], scanFrom, to);

  var out = { minutes: minutes, kind: kind, slots: [], atFits: null, atWhy: '' };
  if (at) {
    var why = slotFitsWhy_(at.getTime(), needMs, busy, bufMs, hol, leave, notBefore, kind === 'call');
    out.atFits = !why; out.atWhy = why;
  }
  for (var d = new Date(from); d.getTime() < to.getTime() && out.slots.length < count;
       d = new Date(d.getTime() + 86400000)) {
    var b = visitDayBounds_(d), taken = 0, t = Math.max(b.s, notBefore);
    t = Math.ceil(t / step) * step;
    while (t < b.e && taken < perDay && out.slots.length < count) {
      if (!slotFitsWhy_(t, needMs, busy, bufMs, hol, leave, notBefore, kind === 'call')) {
        var end = visitWorkEnd_(t, needMs, b.ls, b.le);
        out.slots.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() });
        taken++;
        t = Math.ceil((end + 60 * 60000) / step) * step;              // the next offer at least an hour later
      } else t += step;
    }
  }
  return out;
}

/* ---------- 4. BUMPING ----------------------------------------------------------------------
 * Only JOBS move. An estimate call, a personal appointment or anything else on the calendar
 * stays where it is; a moved job may end up sitting over one, and the plan says so.
 * A job is: a booked appointment, a return visit, or any event carrying a PO number. */
function bumpIsJob_(title, desc) {
  var t = String(title || '');
  if (/^\s*ESTIMATE\b/i.test(t)) return false;
  if (/^\s*APPOINTMENT\b/i.test(t) || /\(cont'd\)/i.test(t) || /^\s*RETURN\b/i.test(t)) return true;
  return /\b[RCIM]-?\s?\d{5}\b/.test(t + ' ' + String(desc || ''));
}
function bumpPoOf_(title, desc) {
  var m = /\b([RCIM])-?\s?(\d{5})\b/.exec(String(title || '') + ' ' + String(desc || ''));
  return m ? (m[1] + m[2]) : '';
}

/* The next work day after `ms` (weekends, stat holidays, Paul's leave skipped), same clock time. */
function bumpNextWorkDay_(ms, hol, leave) {
  var d = new Date(ms);
  for (var i = 0; i < 30; i++) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, d.getHours(), d.getMinutes(), 0);
    var ds = fmtDate_(d), dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !hol[ds] && !leave[ds]) return d.getTime();
  }
  throw new Error('Could not find a work day within 30 days.');
}

/* ============================================================================================
 * v53 - ONE READ INSTEAD OF N.  (This is a performance fix, not a behaviour change.)
 *
 * bumpWho_ answers one question about one calendar event: whose job is this, what is their phone
 * number, and what is the job. It did it by opening the PO LOG WORKBOOK, finding its header row,
 * finding the PO's row, reading that row, and then reading EVERY row of the Requests tab - about
 * six range reads and a cross-workbook open, every single time it was called.
 *
 * Nothing called it once. schedDay_ calls it per booking on the day, so opening a Tuesday with
 * six jobs on it meant six PO Log opens and six full Requests reads before the screen could
 * paint. bumpPlan_ does the same per job it would displace. That is where the seconds went.
 *
 * Both tables are now read ONCE per execution and held in the two maps below. The answers are
 * identical - same columns, same order of preference, same fallbacks to the event title - and
 * every caller gets the saving without being touched. The Requests map is dropped whenever that
 * tab is written, so a displacement that mints a row can never read a stale one back.
 * ==========================================================================================*/
var PO_WHO_MAP_ = null, REQ_EVENT_MAP_ = null;

/* PO number -> { customer, phone, job }, the whole PO Log in one read. */
function poWhoMap_() {
  if (PO_WHO_MAP_) return PO_WHO_MAP_;
  var map = {};
  try {
    var t = poLogOpen_(), last = t.sh.getLastRow(), wide = Math.max(1, t.sh.getLastColumn());
    if (last > t.headerRow) {
      var heads = t.sh.getRange(t.headerRow, 1, 1, wide).getValues()[0];
      var vals = t.sh.getRange(t.headerRow + 1, 1, last - t.headerRow, wide).getDisplayValues();
      var ix = {};
      for (var h = 0; h < heads.length; h++) {
        var hn = lc_(heads[h]); if (hn) ix[hn] = h;
      }
      // The v50 resolver already put the logical columns on t.cols, so a renamed or mistyped
      // header is found here exactly as it is everywhere else.
      var col = function (label, cfgKey) {
        if (ix[label] != null) return ix[label];
        if (t.cols[label]) return t.cols[label] - 1;
        return (cfgKey && CONFIG[cfgKey]) ? CONFIG[cfgKey] - 1 : null;
      };
      var cPo = col('po number', 'PO_NUMBER_COL'), cC = col('contact person', 'PO_CONTACT_COL'),
          cN = col('company name', 'PO_CUSTOMER_COL'), cPh = col('phone number', 'PO_PHONE_COL'),
          cPr = col('project name', 'PO_PROJECT_COL'), cD = col('description of work', 'PO_DESC_COL');
      for (var i = 0; i < vals.length; i++) {
        var k = poKey_(cPo == null ? '' : vals[i][cPo]);
        if (!k || map[k]) continue;                 // first row wins, as poLogRowOf_ does
        var at = function (c) { return c == null ? '' : String(vals[i][c] || '').trim(); };
        map[k] = { customer: at(cC) || at(cN), phone: at(cPh), job: at(cPr) || at(cD) };
      }
    }
  } catch (e) {}
  PO_WHO_MAP_ = map;
  return map;
}

/* Calendar event id -> the Requests row behind it, the whole tab in one read. */
function reqEventMap_() {
  if (REQ_EVENT_MAP_) return REQ_EVENT_MAP_;
  var map = {};
  try {
    var sh = reqSheet_(), last = sh.getLastRow();
    if (last >= 2) {
      var v = sh.getRange(2, 1, last - 1, REQ_HEADERS.length).getValues();
      for (var i = 0; i < v.length; i++) {
        var k = String(v[i][18] || ''); if (!k || map[k]) continue;
        map[k] = { requestId: String(v[i][0]), customer: String(v[i][4] || ''),
                   phone: String(v[i][5] || ''), job: String(v[i][8] || '') };
      }
    }
  } catch (e) {}
  REQ_EVENT_MAP_ = map;
  return map;
}
/* Called after anything writes the Requests tab. */
function reqMapsDrop_() { REQ_EVENT_MAP_ = null; REQ_SCAN_ = null; }   // v61

/* Who to ring about a moved job: name, phone and what the job is. PO Log first, then the
 * Requests row the event came from, then whatever the event itself says. */
function bumpWho_(po, evId, title, desc) {
  var out = { customer: '', phone: '', job: '', requestId: '' };
  try {
    if (po) {
      var w = poWhoMap_()[poKey_(po)];
      if (w) { out.customer = w.customer; out.phone = w.phone; out.job = w.job; }
    }
  } catch (e) {}
  try {
    if (evId) {
      var r = reqEventMap_()[String(evId)];
      if (r) {
        out.requestId = r.requestId;
        if (!out.customer) out.customer = r.customer;
        if (!out.phone) out.phone = r.phone;
        if (!out.job) out.job = r.job;
      }
    }
  } catch (e) {}
  if (!out.phone) { var m = /(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/.exec(String(desc || '')); if (m) out.phone = m[1]; }
  if (!out.customer) out.customer = String(title || '').replace(/^\s*(APPOINTMENT|ESTIMATE|RETURN)\s*[—-]\s*/i, '')
                       .replace(/\b[RCIM]-?\s?\d{5}\b/g, '').replace(/\((return visit|cont'd)\)/ig, '')
                       .split(' — ')[0].replace(/[\s·]+$/, '').trim();   // v89 - "Name · R26201 — scope" too
  if (!out.job) out.job = String(title || '').split(' — ').slice(-1)[0];
  return out;
}

/* Work out the whole chain without touching anything.
 * payload: { start: ISO, hours: 2, po, jobSite }   - a NEW return visit at that time, or
 *          { start: ISO, eventId }                 - move an EXISTING job there (keeps its length)
 */
function bumpCompute_(user, p) {
  requireAdmin_(user);
  var start = new Date(String((p && p.start) || ''));
  if (isNaN(start.getTime())) throw new Error('Pick a day and a time.');
  if (start.getTime() < Date.now() - 60000) throw new Error('That time has already passed.');

  var cal = visitCal_();
  var horizon = new Date(start.getTime() + 75 * 86400000);
  var evs = [];
  cal.getEvents(new Date(start.getTime() - 86400000), horizon).forEach(function (ev) {
    try {
      if (ev.isAllDayEvent()) return;
      var d = ''; try { d = ev.getDescription() || ''; } catch (e) {}
      evs.push({ id: String(ev.getId()), title: ev.getTitle() || '(untitled)', desc: d,
                 s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime(),
                 job: bumpIsJob_(ev.getTitle(), d) });
    } catch (e) {}
  });

  var mover;
  if (p.eventId) {
    var me = null;
    for (var i = 0; i < evs.length; i++) if (evs[i].id === String(p.eventId)) { me = evs[i]; break; }
    if (!me) { var ev0 = cal.getEventById(String(p.eventId)); if (!ev0) throw new Error('That booking is not on the calendar any more.');
      me = { id: String(ev0.getId()), title: ev0.getTitle(), desc: ev0.getDescription() || '',
             s: ev0.getStartTime().getTime(), e: ev0.getEndTime().getTime(), job: true }; evs.push(me); }
    mover = { kind: 'move', id: me.id, title: me.title, s: start.getTime(), e: start.getTime() + (me.e - me.s),
              fromS: me.s, fromE: me.e };
  } else {
    var hours = Math.max(0.25, Math.min(12, Number(p.hours) || 0));
    if (!hours) throw new Error('Say how many hours the return visit needs.');
    var b0 = visitDayBounds_(start);
    mover = { kind: 'new', id: '', title: 'Return visit — ' + (p.po ? p.po + ' ' : '') + (p.jobSite || ''),
              s: start.getTime(), e: visitWorkEnd_(start.getTime(), hours * 3600000, b0.ls, b0.le) };
  }

  var from0 = new Date(start); from0.setHours(0, 0, 0, 0);
  var hol = {}; abHolidays_(from0, horizon).forEach(function (h) { hol[h.date] = h.name; });
  var leave = visitLeaveDays_(CONFIG.ADMIN_EMAILS[0], from0, horizon);
  var sd = fmtDate_(start);
  var warnings = [];
  if (start.getDay() === 0 || start.getDay() === 6) warnings.push(sd + ' is a weekend.');
  if (hol[sd]) warnings.push(sd + ' is ' + hol[sd] + '.');
  if (leave[sd]) warnings.push('You are off on ' + sd + ' (' + leave[sd] + ').');

  // pos: where every event sits NOW in the plan. The mover is fixed; everything it lands on moves.
  var pos = {};
  evs.forEach(function (x) { pos[x.id] = { s: x.s, e: x.e }; });
  if (mover.id) pos[mover.id] = { s: mover.s, e: mover.e };
  var moves = {}, order = [], queue = [{ id: mover.id || '__new__', s: mover.s, e: mover.e }], guard = 0;
  var now = Date.now();
  while (queue.length) {
    if (++guard > 200) throw new Error('The chain of moves is too long to work out — book this one by hand.');
    var cur = queue.shift();
    for (var j = 0; j < evs.length; j++) {
      var x = evs[j];
      if (!x.job || x.id === cur.id || x.id === mover.id) continue;
      var at = pos[x.id];
      if (at.s < now) continue;                                          // never move something already started
      if (!(at.s < cur.e && at.e > cur.s)) continue;                     // not in the way
      var ns = bumpNextWorkDay_(at.s, hol, leave), ne = ns + (at.e - at.s);
      if (ns > horizon.getTime()) throw new Error('The chain runs past ' + fmtDate_(horizon) + ' — book this one by hand.');
      while (ns < mover.e && ne > mover.s) { ns = bumpNextWorkDay_(ns, hol, leave); ne = ns + (at.e - at.s); }   // never onto the fixed booking
      if (!moves[x.id]) { moves[x.id] = { from: { s: x.s, e: x.e } }; order.push(x.id); }
      pos[x.id] = { s: ns, e: ne };
      queue.push({ id: x.id, s: ns, e: ne });
    }
  }

  // What each moved job (and the new visit) ends up sitting over that does NOT move.
  var overlaps = function (id, s, e) {
    return evs.filter(function (y) {
      if (y.id === id) return false;
      var q = pos[y.id]; if (!(q.s < e && q.e > s)) return false;
      return !y.job;                                                     // only things that never move
    }).map(function (y) { return y.title; });
  };
  var mOver = overlaps(mover.id || '__new__', mover.s, mover.e);
  if (mOver.length) warnings.push('The ' + (mover.kind === 'new' ? 'return visit' : 'job') + ' sits over: ' + mOver.join(', ') + '.');

  var list = order.map(function (id) {
    var x = null; for (var k = 0; k < evs.length; k++) if (evs[k].id === id) { x = evs[k]; break; }
    var po = bumpPoOf_(x.title, x.desc), who = bumpWho_(po, id, x.title, x.desc);
    var over = overlaps(id, pos[id].s, pos[id].e);
    return { eventId: id, title: x.title, po: po, customer: who.customer, phone: who.phone, job: who.job,
             requestId: who.requestId,
             from: new Date(moves[id].from.s).toISOString(), fromEnd: new Date(moves[id].from.e).toISOString(),
             to: new Date(pos[id].s).toISOString(), toEnd: new Date(pos[id].e).toISOString(),
             sitsOver: over };
  });

  var sig = JSON.stringify([mover.kind, mover.id, mover.s, mover.e, list.map(function (m) { return [m.eventId, m.to]; })]);
  var hash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sig)).substring(0, 16);
  return { mover: { kind: mover.kind, eventId: mover.id, title: mover.title,
                    start: new Date(mover.s).toISOString(), end: new Date(mover.e).toISOString(),
                    from: mover.fromS ? new Date(mover.fromS).toISOString() : '' },
           moves: list, warnings: warnings, hash: hash };
}

/* ============================================================================================
 * v51 - ONE RULE EVERYWHERE.
 *
 * bumpCompute_ worked out a CHAIN: the job in the way moved to the next work day, whatever that
 * landed on moved again, and so on, up to 200 deep. It is left below for reference but nothing
 * calls it any more. A booking now displaces only the jobs it actually sits on, and each of them
 * goes back to Requests with no time - the same thing that happens when Paul books an emergency
 * from the Requests tab. Nobody gets a time they did not agree to.
 * ==========================================================================================*/

/* The window a booking would occupy, and what it is. Shared by the preview and the booking. */
function bumpMover_(user, p) {
  var start = new Date(String((p && p.start) || ''));
  if (isNaN(start.getTime())) throw new Error('Pick a day and a time.');
  if (!(p && p.allowPast) && start.getTime() < Date.now() - 60000)
    throw new Error('That time has already passed.');
  var cal = visitCal_();
  if (p.eventId) {
    var ev = cal.getEventById(String(p.eventId));
    if (!ev) throw new Error('That booking is not on the calendar any more.');
    var len = ev.getEndTime().getTime() - ev.getStartTime().getTime();
    return { kind: 'move', eventId: String(ev.getId()), title: ev.getTitle() || '(untitled)',
             s: start.getTime(), e: start.getTime() + len, fromS: ev.getStartTime().getTime() };
  }
  var hours = Math.max(0.25, Math.min(12, Number(p.hours) || 0));
  if (!hours) throw new Error('Say how many hours the return visit needs.');
  var b0 = visitDayBounds_(start);
  return { kind: 'new', eventId: '', fromS: 0,
           title: 'Return visit — ' + (p.po ? (p.po + ' ') : '') + (p.jobSite || ''),
           s: start.getTime(), e: visitWorkEnd_(start.getTime(), hours * 3600000, b0.ls, b0.le) };
}

/* action: "bumpPlan" - read-only preview: what would this booking push off the calendar?
 * The shape is unchanged so the app's review screen keeps working; `to` is now always empty,
 * because a displaced job gets no new time - it goes back to Requests for Paul to decide. */
function bumpPlan_(user, p) {
  requireAdmin_(user);
  var m = bumpMover_(user, p);
  var s = new Date(m.s), e = new Date(m.e);
  var d0 = new Date(s); d0.setHours(0, 0, 0, 0);
  var d1 = new Date(d0.getTime() + 86400000), ds = fmtDate_(s);
  var hol = {}; abHolidays_(d0, d1).forEach(function (h) { hol[h.date] = h.name; });
  var leave = visitLeaveDays_(CONFIG.ADMIN_EMAILS[0], d0, d1);
  var warnings = [];
  if (s.getDay() === 0 || s.getDay() === 6) warnings.push(ds + ' is a weekend.');
  if (hol[ds]) warnings.push(ds + ' is ' + hol[ds] + '.');
  if (leave[ds]) warnings.push('You are off on ' + ds + ' (' + leave[ds] + ').');
  var b = visitDayBounds_(s);
  if (m.s < b.s || m.e > b.e) warnings.push('That runs outside your working day.');
  var list = bumpTargets_(s, e, m.eventId).map(function (t) {
    var who = { customer: '', phone: '', job: '', requestId: '' };
    try { who = bumpWho_(t.po, t.eventId, t.title, ''); } catch (err) {}
    return { eventId: t.eventId, title: t.title, po: t.po, customer: who.customer, phone: who.phone,
             job: who.job, requestId: who.requestId, from: t.start, fromEnd: t.end,
             to: '', toEnd: '', sitsOver: [] };
  });
  var sig = JSON.stringify([m.kind, m.eventId, m.s, m.e,
    list.map(function (x) { return x.eventId; })]);
  var hash = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sig)).substring(0, 16);
  return { mover: { kind: m.kind, eventId: m.eventId, title: m.title,
                    start: s.toISOString(), end: e.toISOString(),
                    from: m.fromS ? new Date(m.fromS).toISOString() : '' },
           moves: list, warnings: warnings, hash: hash, toRequests: true };
}

/* action: "bumpApply" - payload as bumpPlan + { hash } from the preview Paul confirmed, plus
 * { note, notifyCustomer } for a new return visit. Refuses if the calendar changed since.
 * The booking Paul asked for goes in FIRST, so a failure while clearing the others out can
 * never lose it. Then every job it sits on goes back to Requests. */
function bumpApply_(user, p) {
  var plan = bumpPlan_(user, p);
  if (!p.hash || p.hash !== plan.hash) {
    var e = new Error('The calendar changed since you looked at the plan — check the new one and confirm again.');
    e.plan = plan; throw e;
  }
  var cal = visitCal_();
  var result = { moved: 0, problems: [], mover: plan.mover, sentBack: [], toRequests: true };
  if (plan.mover.kind === 'move') {
    var evM = cal.getEventById(plan.mover.eventId);
    if (!evM) throw new Error('That booking is not on the calendar any more.');
    evM.setTime(new Date(plan.mover.start), new Date(plan.mover.end));
    bumpSyncRecords_(plan.mover.eventId, bumpPoOf_(evM.getTitle(), evM.getDescription()),
                     new Date(plan.mover.start), new Date(plan.mover.end));
    if (p.callId) callSet_(p.callId, 'rescheduled', user.email, plan.mover.start);
  } else {
    var hrs = Math.max(0.25, Math.min(12, Number(p.hours) || 0));
    result.booking = visitBook_(user, { po: p.po, jobSite: p.jobSite, start: plan.mover.start, hours: hrs,
      note: p.note, notifyCustomer: !!p.notifyCustomer, location: p.location },
      { allowClash: true, allowPast: !!p.allowPast });
  }
  var ignore = plan.mover.eventId || (result.booking && result.booking.eventId) || '';
  var br = bumpToRequests_(user, new Date(plan.mover.start), new Date(plan.mover.end),
                           ignore, plan.mover.title);
  result.sentBack = br.sent; result.moved = br.sent.length; result.problems = br.problems;
  if (br.sent.length) bumpBackEmail_(br.sent, plan.mover.title, plan.mover.start);
  log_(user, 'bumpApply', p.jobSite || '', p.po || '', plan.mover.title + ' @ ' + plan.mover.start +
       ' · ' + br.sent.length + ' sent back to Requests' +
       (br.problems.length ? (' · problems: ' + br.problems.join('; ')) : ''));
  return result;
}

/* Keep the Requests row and the PO Log start date in step with a moved job. */
function bumpSyncRecords_(evId, po, s, e) {
  try {
    var sh = reqSheet_(), last = sh.getLastRow();
    if (last >= 2) {
      var col = sh.getRange(2, 19, last - 1, 1).getValues();
      for (var i = 0; i < col.length; i++) if (String(col[i][0]) === String(evId)) {
        sh.getRange(i + 2, 16, 1, 2).setValues([[s.toISOString(), e.toISOString()]]); break;
      }
    }
  } catch (err) {}
  try { if (po) poLogSetStart_(po, s); } catch (err) {}
}

/* ---------- CALL LIST - customers whose job was moved and who need a ring ----------------- */
var CALL_TAB_ = 'Call List';
var CALL_HEADERS_ = ['ID', 'Created', 'PO', 'Customer', 'Phone', 'Job', 'Was', 'Now', 'Event ID',
                     'Request ID', 'Why', 'Status', 'Done at', 'Done by'];
function callSheet_() {
  var sh = masterSheet_(CALL_TAB_);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, CALL_HEADERS_.length).setValues([CALL_HEADERS_]).setFontWeight('bold');
  return sh;
}
function callAdd_(m, why) {
  var sh = callSheet_(), last = sh.getLastRow();
  // One open line per booking: a job bumped twice before Paul rings shows its latest time.
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, CALL_HEADERS_.length).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][8]) === String(m.eventId) && String(v[i][11]) === 'to call') {
        sh.getRange(i + 2, 8).setValue(m.to); return;
      }
    }
  }
  sh.appendRow([newId_(), new Date().toISOString(), m.po || '', txt_(m.customer || ''), txt_(m.phone || ''),
                txt_(m.job || ''), m.from, m.to, m.eventId, m.requestId || '', why || 'bumped', 'to call', '', '']);
}
function callSet_(id, status, by, now) {
  var sh = callSheet_(), last = sh.getLastRow(); if (last < 2) return false;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) {
    if (now) sh.getRange(i + 2, 8).setValue(now);
    sh.getRange(i + 2, 12, 1, 3).setValues([[status, new Date().toISOString(), by]]);
    return true;
  }
  return false;
}
/* action: "callList" - the open ones, oldest first. */
function callList_(user) {
  requireAdmin_(user);
  var sh = callSheet_(), last = sh.getLastRow(), out = [];
  if (last < 2) return { calls: out };
  sh.getRange(2, 1, last - 1, CALL_HEADERS_.length).getValues().forEach(function (v) {
    if (String(v[11]) !== 'to call') return;
    out.push({ id: String(v[0]), po: String(v[2]), customer: String(v[3]), phone: String(v[4]), job: String(v[5]),
               was: String(v[6]), now: String(v[7]), eventId: String(v[8]), requestId: String(v[9]) });
  });
  return { calls: out };
}
/* action: "callDone" - { id } Paul rang them and the new day works. */
function callDone_(user, p) {
  requireAdmin_(user);
  if (!callSet_(p.id, 'called', user.email)) throw new Error('That call is not on the list any more.');
  log_(user, 'callDone', '', '', String(p.id));
  return { ok: true };
}

function bumpEmail_(moves, mover) {
  try {
    var lines = moves.map(function (m) {
      return '• ' + (m.customer || m.title) + (m.phone ? '  —  ' + m.phone : '  —  (no phone on file)') +
             '\n    ' + (m.po ? m.po + ' · ' : '') + (m.job || '') +
             '\n    was ' + whenText_(m.from) + '  →  now ' + whenText_(m.to) +
             (m.sitsOver && m.sitsOver.length ? '\n    note: now sits over ' + m.sitsOver.join(', ') : '');
    }).join('\n\n');
    MailApp.sendEmail(CONFIG.ADMIN_EMAILS[0],
      'Call ' + moves.length + ' customer' + (moves.length === 1 ? '' : 's') + ' — their job was moved',
      'To make room for ' + mover.title + ' on ' + whenText_(mover.start) + ', these jobs moved to the next work day.\n' +
      'Ring each customer. If the new day does not suit them, open the app > Requests > "Call these customers" > Reschedule.\n\n' +
      lines + '\n\n— PRO timesheet app');
  } catch (e) {}
}

/* ---------- 5. INVOICE - START CLAUDE NOW ---------------------------------------------------
 * The Build Initial Draft button used to email a request that an hourly routine picked up - up
 * to an hour's wait. Now it also fires that routine straight away through its API trigger.
 * Set once in Project Settings > Script properties:
 *   INVOICE_FIRE_URL    https://api.anthropic.com/v1/claude_code/routines/<id>/fire
 *   INVOICE_FIRE_TOKEN  the token shown when the API trigger was added (sk-ant-oat01-...)
 * Without them nothing changes: the email still goes and the hourly run still picks it up. */
function invoiceFire_(po, job, stage, by, list) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('INVOICE_FIRE_URL'), tok = props.getProperty('INVOICE_FIRE_TOKEN');
  if (!url || !tok) return { fired: false, note: 'instant start not set up — the hourly run will pick it up' };
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + tok, 'anthropic-version': '2023-06-01',
                 'anthropic-beta': 'experimental-cc-routine-2026-04-01' },
      payload: JSON.stringify({ text:
        'INVOICE REQUEST — ' + (stage === 'final' ? 'FINAL DRAFT' : 'INITIAL DRAFT') + '\n' +
        'PO: ' + (po || '(none)') + '\nJob: ' + job + '\nRequested by: ' + by +
        '\nAt: ' + new Date().toISOString() + '\nSource: timesheet app button' +
        (list ? '\n\n' + list : '') })
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      var j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) {}
      return { fired: true, sessionUrl: j.claude_code_session_url || '' };
    }
    return { fired: false, note: 'instant start failed (' + code + ') — the hourly run will pick it up' };
  } catch (e) {
    return { fired: false, note: 'instant start failed (' + e.message + ') — the hourly run will pick it up' };
  }
}


/* v40 - 3. CLOCK-OUT MATERIALS COME OFF THE SHELF.
 * Every part on the clock-out list that is in the Materials Price List (by its SKU, or by its exact
 * description) is taken off Inventory and written to "Job usage", tagged with the time entry.
 * A resend of the same entry (offline retry, or an edit) only takes the DIFFERENCE, so nothing is
 * ever counted twice. Parts not in the price list are logged as before and flagged for review. */
function invTakeForEntry_(user, p) {
  var out = { taken: [], notFound: [] };
  var entry = String(p.entryId || '').trim();
  var items = (p.items || []).filter(function (it) { return it && Number(it.qty) > 0 && String(it.name || it.sku || '').trim(); });
  if (!items.length) return out;
  var iv = matRows_(), bySku = {}, byDesc = {};
  iv.rows.forEach(function (r, i) {
    var s = String(r[M_SKU-1] || '').trim(), d = lc_(r[M_DESC-1]);
    if (s) bySku[s.toUpperCase()] = i;
    if (d && byDesc[d] === undefined) byDesc[d] = i;
  });
  var useSh = plTab_(USE_TAB, USE_HEADERS), tag = entry ? ('used · entry ' + entry) : 'used';
  var already = {};
  if (entry) {
    var n = useSh.getLastRow() - 1;
    if (n > 0) useSh.getRange(2, 1, n, USE_HEADERS.length).getValues().forEach(function (r) {
      if (String(r[9]) === tag) already[String(r[4])] = (already[String(r[4])] || 0) + (Number(r[6]) || 0);
    });
  }
  var when = fmtDate_(new Date());
  items.forEach(function (it) {
    var idx = it.sku ? bySku[String(it.sku).trim().toUpperCase()] : undefined;
    if (idx === undefined) idx = bySku[String(it.name || '').trim().toUpperCase()];
    if (idx === undefined) idx = byDesc[lc_(it.name)];
    if (idx === undefined) { out.notFound.push(String(it.name || it.sku)); return; }
    var r = iv.rows[idx], sku = String(r[M_SKU-1]).trim();
    var want = Number(it.qty) || 0, delta = want - (already[sku] || 0);
    if (delta <= 0) return;                                   // already taken for this entry
    var left = (Number(r[M_INV-1]) || 0) - delta;
    iv.sheet.getRange(idx + 2, M_INV).setValue(left); r[M_INV-1] = left;
    useSh.appendRow([newId_(), when, txt_(p.jobSite || 'Stock'), p.poNumber || '', sku, r[M_DESC-1],
                     delta, Number(r[M_PRICE-1]) || 0, user.email, tag]);
    already[sku] = (already[sku] || 0) + delta;
    out.taken.push(sku + ' ×' + delta + (left < 0 ? ' (now ' + left + ' — count is behind)' : ''));
  });
  try { CacheService.getScriptCache().remove('materials_v3'); } catch (e) {}
  return out;
}


/* ============================================================================================
 * v41 - EVERY PURCHASE FILES TO ITS JOB NUMBER
 * The customer PO printed on a supplier invoice or credit note (R26184, r26 184, C-26011, I26156)
 * decides the job. It is matched against the PO Log:
 *   1. the exact PO number;
 *   2. the five digits alone (the year + sequence), so a wrong letter - I26156 for C26156 - still
 *      finds the job, exactly as the old filing script did;
 *   3. not on the PO Log at all but shaped like a job number: it is STILL a job. The PDF goes to a
 *      folder named with that job number in "1. Ongoing Invoice" (created if needed), and the
 *      material is recorded against that number.
 * The job's name is the Company Name, else the Contact, else the job number itself - a blank
 * name never sends a purchase to Stock again.
 * ==========================================================================================*/
function poJobIndex_() {
  var idx = { byKey: {}, byDigits: {}, dupDigits: {}, byName: {} };
  var t = poLogOpen_(), sh = t.sh, last = sh.getLastRow();
  if (last <= t.headerRow) return idx;
  var pc = t.cols['po number'] || CONFIG.PO_NUMBER_COL;
  var cc = t.cols['company name'] || CONFIG.PO_CUSTOMER_COL;
  var kc = t.cols['contact person'] || CONFIG.PO_CONTACT_COL;
  var sc = t.cols['status'] || CONFIG.PO_STATUS_COL;
  sh.getRange(t.headerRow + 1, 1, last - t.headerRow, sh.getLastColumn()).getValues().forEach(function (r) {
    var po = String(r[pc - 1] || '').trim(); if (!po) return;
    if (/^cancell?ed$/i.test(String(r[sc - 1] || '').trim())) return;      // a cancelled number is not a job
    var key = lc_(po).replace(/[^a-z0-9]/g, ''); if (!key) return;
    var site = String(r[cc - 1] || '').trim() || String(r[kc - 1] || '').trim() || po;
    var job = { site: site, po: po, status: String(r[sc - 1] || '').trim() };
    idx.byKey[key] = job;
    // v42 - by name too (contact AND company), so an entry saved with only the customer's name can
    // be tied to its job when exactly one PO Log row carries that name.
    [String(r[kc - 1] || ''), String(r[cc - 1] || '')].forEach(function (nm) {
      var n = lc_(nm).replace(/\s+/g, ' '); if (!n) return;
      (idx.byName[n] = idx.byName[n] || []).push(job);
    });
    var d = key.replace(/\D/g, '');
    if (d.length === 5) { if (idx.byDigits[d]) idx.dupDigits[d] = 1; else idx.byDigits[d] = job; }
  });
  return idx;
}
function poJobLookup_(idx, ref) {
  var r = lc_(ref).replace(/[^a-z0-9]/g, '');
  if (!r || !idx) return null;
  if (idx.byKey && idx.byKey[r]) return idx.byKey[r];
  var d = r.replace(/\D/g, '');
  if (d.length === 5 && idx.byDigits && idx.byDigits[d] && !(idx.dupDigits || {})[d]) return idx.byDigits[d];
  var m = /^([a-z])?(\d{5})$/.exec(r);
  if (m) { var po = (m[1] || '').toUpperCase() + m[2]; return { site: po, po: po, unlisted: true }; }
  return null;                                                        // TOOLS, SHOP, PCW, blank ...
}

/* v47 - a supplier invoice's reference is checked against the jobs before it is treated as a
 * client folder name: 1. a job number on the PO Log; 2. a PO Log contact or company name (one
 * job with that name, or one OPEN one); 3. the last 3-4 digits of exactly one job's number
 * ("RT6172" -> R26172); 4. a 5-digit number not on the log yet. Else null. */
function poRefResolve_(idx, ref) {
  var hit = poJobLookup_(idx, ref);
  if (hit && !hit.unlisted) return hit;
  if (!idx) return hit;
  var n = lc_(ref).replace(/[^a-z0-9&' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (n && /[a-z]/.test(n)) {
    var norm = function (x) { return lc_(x).replace(/[^a-z0-9&' ]/g, ' ').replace(/\s+/g, ' ').trim(); };
    var uniq = {};
    Object.keys(idx.byName || {}).forEach(function (k) {
      if (norm(k) === n) idx.byName[k].forEach(function (j) { uniq[poKey_(j.po)] = j; });
    });
    var list = Object.keys(uniq).map(function (k) { return uniq[k]; });
    if (list.length > 1) list = list.filter(function (j) { return !/^(closed|cancell?ed)$/i.test(j.status); });
    if (list.length === 1) return list[0];
  }
  // v47 - A JOB NUMBER WITH A TYPO IN THE FRONT. The last 3 digits are the job and are always
  // right; the letter + year in front ("R26") is where typos happen: RT6172, C26172, R25172, 26172,
  // 6172 all mean R26172. Several jobs ending in the same 3 digits -> the one whose front matches,
  // else the one still open; if that does not settle it, no guess.
  var d = String(ref || '').replace(/\D/g, '');
  var looksNo = /^[a-z]{0,3}[ \-#]*\d{3,6}$/i.test(String(ref || '').trim());
  if ((!hit || hit.unlisted) && looksNo && d.length >= 3 && idx.byKey) {
    var tail = d.slice(-3), seen = {};
    var cand = Object.keys(idx.byKey).map(function (k) { return idx.byKey[k]; }).filter(function (j) {
      var jd = String(j.po).replace(/\D/g, ''), pk = poKey_(j.po);
      if (jd.slice(-3) !== tail || seen[pk]) return false; seen[pk] = 1; return true;
    });
    if (cand.length > 1) {
      var same = cand.filter(function (j) { return String(j.po).replace(/\D/g, '') === d; });
      if (same.length) cand = same;
    }
    if (cand.length > 1) cand = cand.filter(function (j) { return !/^(closed|invoiced|cancell?ed)$/i.test(j.status); });
    if (cand.length === 1) {
      var t = JSON.parse(JSON.stringify(cand[0]));
      if (poKey_(t.po) !== poKey_(ref)) t.readAs = String(ref).trim();
      return t;
    }
  }
  // v47 - TYPO IN A NAME: "Laboucan", "Isac Laboucan", "Dairy Qeen" still find their job when
  // exactly one job is that close. Flagged (fuzzy) so the report says it was a near match.
  var special = /^(Shop Supplies|Tools|Paul|PCW)$/.test(internalPoFolderName_(ref));   // never fuzzy-match SHOP, TOOLS, PAUL, PCW
  if (n && /[a-z]{3}/.test(n) && !hit && !special) {
    var fz = poNameNear_(idx, n);
    if (fz) return fz;
  }
  // A different last 3 digits is a different job, never a typo: no guess and no flag.
  return hit;
}
/* The PO Log name closest to a reference, allowing small typos, when ONE job is that close.
 * Whole name: 1 letter off for short names, 2 for longer. Or every word of the reference
 * (3+ letters) matches a word of the name within 1 letter - "laboucan" -> "isaac laboucan-aviron". */
function poNameNear_(idx, n) {
  var norm = function (x) { return lc_(x).replace(/[^a-z0-9&' ]/g, ' ').replace(/\s+/g, ' ').trim(); };
  var refW = n.split(' ').filter(function (w) { return w.length >= 3; });
  if (!refW.length || !refW.some(function (w) { return w.length >= 4; })) return null;
  var tol = n.length <= 6 ? 1 : 2, found = {};
  Object.keys(idx.byName || {}).forEach(function (k) {
    var key = norm(k); if (!key) return;
    var ok = lev_(n, key) <= tol;
    if (!ok) {
      var kw = key.split(/[ \-]/).filter(String);
      ok = refW.every(function (w) { return kw.some(function (x) { return x === w || (w.length >= 4 && lev_(w, x) <= 1); }); });
    }
    if (ok) idx.byName[k].forEach(function (j) { found[poKey_(j.po)] = { j: j, name: k }; });
  });
  var list = Object.keys(found).map(function (k) { return found[k]; });
  if (list.length > 1) list = list.filter(function (x) { return !/^(closed|cancell?ed)$/i.test(x.j.status); });
  if (list.length !== 1) return null;
  var out = JSON.parse(JSON.stringify(list[0].j)); out.fuzzy = String(list[0].name).trim();
  return out;
}
function poRefNote_(hit, ref) {
  if (!hit) return '';
  if (hit.fuzzy) return 'reference "' + ref + '" read as ' + hit.po + ' · ' + String(hit.site).trim() + ' (close to "' + hit.fuzzy + '") - check it';
  if (hit.readAs) return 'printed "' + hit.readAs + '", filed to ' + hit.po;
  return '';
}


/* ============================================================================================
 * v42 - A JOB NUMBER TYPED AS THE JOB NAME
 * The crew sometimes type "R26184" into the job box instead of picking "R26184 · Koltin Hachey"
 * from the list. The entry then carried "R26184" as its NAME and no PO#, so the Jobs screen showed
 * a nameless "R26184" beside the real Koltin Hachey job, split in two, and since v38 (which stops
 * a PO number being made into a new customer) that is exactly what a typed number produces.
 * Now a typed job number that is on the PO Log becomes that job: PO# filled, name from the log.
 * ==========================================================================================*/
function jobResolveTyped_(p) {
  try {
    var site = String(p.jobSite || '').trim();
    if (!site) return;
    if (!/^[A-Za-z]{0,2}[\s\-]?\d{2}\s?\d{3}$/.test(site)) {
      // a NAME with no PO: tie it to the job only when exactly one OPEN PO Log row has that name
      if (p.poNumber) return;
      var open = (poJobIndex_().byName[lc_(site).replace(/\s+/g, ' ')] || [])
        .filter(function (j) { return !/^(closed|invoiced|cancell?ed)$/i.test(j.status); });
      if (open.length === 1) { p.poNumber = open[0].po; p.jobSite = open[0].site; p.newCustomer = false; }
      return;
    }
    var hit = poJobLookup_(poJobIndex_(), site);
    if (!hit || hit.unlisted) return;                                               // not on the PO Log: leave it alone
    if (p.poNumber && poKey_(p.poNumber) !== poKey_(hit.po)) return;               // a DIFFERENT PO was picked: do not guess
    p.poNumber = hit.po;
    p.jobSite = hit.site;
    p.newCustomer = false;                                                          // it is an existing job, never a new customer
  } catch (e) {}
}

/* action "repairJobNames" (inbound key or admin) - fixes entries ALREADY saved with a job number as
 * the name. payload { dryRun: true } lists what it would change without writing.
 * Only touches rows whose Customer/Job Site is exactly a job number found on the PO Log. The PO#
 * cell is set to that job unless it already holds a DIFFERENT job that IS on the PO Log (then the
 * row is only reported). Hours, dates, status and approvals are never touched. */
function repairJobNames_(user, p) {
  requireAdmin_(user);
  var idx = poJobIndex_(), ss = masterSs_(), changed = [], skipped = [];
  ss.getSheets().forEach(function (sh) {
    var note = ''; try { note = sh.getRange('A1').getNote() || ''; } catch (e) {}
    if (note.indexOf('email:') !== 0) return;                                       // not an employee tab
    var last = sh.getLastRow(); if (last <= ENTRY_HEADER_ROW) return;
    var cs = COL['Customer/Job Site'], cp = COL['PO#'];
    var rng = sh.getRange(ENTRY_HEADER_ROW + 1, 1, last - ENTRY_HEADER_ROW, ENTRY_HEADERS.length);
    var vals = rng.getValues();
    vals.forEach(function (r, i) {
      var site = String(r[cs - 1] || '').trim(), po = String(r[cp - 1] || '').trim();
      if (!site) return;
      // payload { except: ['Peter Harder'] } leaves those job names alone this run
      if (p && p.except && [].concat(p.except).some(function (x) { return lc_(x) === lc_(site); })) return;
      var hit;
      if (!/^[A-Za-z]{0,2}[\s\-]?\d{2}\s?\d{3}$/.test(site)) {
        if (po) return;                                                             // named AND numbered: fine
        var cand = idx.byName[lc_(site).replace(/\s+/g, ' ')] || [];
        var uniq = {}; cand.forEach(function (j) { uniq[poKey_(j.po)] = j; });
        var list = Object.keys(uniq).map(function (k) { return uniq[k]; });
        if (list.length > 1) { skipped.push(sh.getName() + ' ' + String(r[COL['Date'] - 1]).slice(0, 10) + ': "' + site + '" matches ' + list.map(function (j) { return j.po; }).join(' and ') + ' - left for you'); return; }
        if (list.length !== 1) return;                                              // PRO, PCW, test entries...
        hit = list[0];
      } else hit = poJobLookup_(idx, site);
      if (!hit || hit.unlisted) return;
      var poHit = po ? poJobLookup_(idx, po) : null;
      if (po && poKey_(po) !== poKey_(hit.po) && poHit && !poHit.unlisted) {
        skipped.push(sh.getName() + ' ' + String(r[COL['Date'] - 1]).slice(0, 10) + ': job "' + site + '" but PO# ' + po + ' (' + poHit.site + ') - left for you');
        return;
      }
      var row = ENTRY_HEADER_ROW + 1 + i;
      changed.push(sh.getName() + ' ' + String(r[COL['Date'] - 1]).slice(0, 10) + ': "' + site + '"' + (po && poKey_(po) !== poKey_(hit.po) ? ' (PO# ' + po + ')' : '') +
                   ' -> ' + hit.po + ' · ' + hit.site + ' (' + (Number(r[COL['Hours'] - 1]) || 0) + ' h)');
      if (!p || !p.dryRun) {
        sh.getRange(row, cs).setValue(txt_(hit.site));
        sh.getRange(row, cp).setValue(hit.po);
      }
    });
  });
  if (!p || !p.dryRun) {
    try { CacheService.getScriptCache().removeAll(['jobCosts', 'poCustomers']); } catch (e) {}
    log_(user, 'repairJobNames', '', '', changed.length + ' fixed' + (skipped.length ? ', ' + skipped.length + ' left' : ''));
  }
  return { dryRun: !!(p && p.dryRun), changed: changed, skipped: skipped };
}


/* ============================================================================================
 * v44 - PURCHASES FILED TO "STOCK" THAT BELONG TO A JOB
 * Until v40/v41 a supplier invoice for a job with no Company Name (every residential job) was
 * recorded on the Job POs tab as "Stock", so the job's Materials screen showed nothing bought and
 * its PDF sat in the general Supplier POs folder. This finds each such invoice's job number and
 * moves it: the Job POs rows get the job name + PO, and the PDF moves into the job-number folder.
 * Inventory counts are NOT touched (the stock was counted when the invoice came in, and stays).
 * Where the job number comes from, in order:
 *   1. the row's own PO# cell;
 *   2. the email the sweep read it from ("Invoice #26-444145, Purchase Order R26186");
 *   3. the old filing script's log (App Script PO classification: Invoice # -> Customer PO);
 *   4. reading the PDF again with the AI (at most `aiLimit` per run, default 12).
 * TOOLS / SHOP / PCW / PAUL and anything with no job number stay on Stock.
 * payload { dryRun: true } lists what it would do. Run again to continue if it says "more".
 * ==========================================================================================*/
var CLASSIFY_SHEET_ID_ = '1JXZddbvOWhB0oj9YuRN_My64GYZVT1n7FhtlzCn_zMw';
function invKey_(s) { return String(s || '').replace(/\D/g, '').replace(/^0+/, ''); }

function repairJobPOs_(user, p) {
  requireAdmin_(user);
  p = p || {};
  var t0 = Date.now(), idx = poJobIndex_(), refByInv = {};
  // 2. the sweep's own log: the subject carries EECOL's "Purchase Order X"
  try {
    var sl = sweepLogTab_(), n = sl.getLastRow() - 1;
    if (n > 0) sl.getRange(2, 1, n, 5).getValues().forEach(function (r) {
      var m = /Purchase Order\s+([A-Za-z0-9][A-Za-z0-9 \-]{2,12})/i.exec(String(r[3] || ''));
      if (!m) return;
      String(r[4] || '').replace(/\d[\d ]{5,}\d/g, function (d) { refByInv[invKey_(d)] = m[1].trim(); return d; });
    });
  } catch (e) {}
  // 3. the old filing script's log
  try {
    var cs = SpreadsheetApp.openById(CLASSIFY_SHEET_ID_).getSheets()[0], cn = cs.getLastRow() - 1;
    if (cn > 0) cs.getRange(2, 1, cn, 5).getValues().forEach(function (r) {
      var k = invKey_(r[3]); if (k && r[4] && !refByInv[k]) refByInv[k] = String(r[4]).trim();
    });
  } catch (e) {}

  var sh = plTab_(POS_TAB, POS_HEADERS), last = sh.getLastRow();
  if (last < 2) return { changed: [], unknown: [] };
  var vals = sh.getRange(2, 1, last - 1, POS_HEADERS.length).getValues();
  var groups = {};                                   // one decision per supplier invoice
  vals.forEach(function (r, i) {
    var site = lc_(r[2]);
    if (site && site !== 'stock') return;
    var k = lc_(r[4]) + '|' + invKey_(r[5]);
    (groups[k] = groups[k] || { sup: r[4], inv: r[5], rows: [], po: '', doc: '' }).rows.push(i);
    if (String(r[3] || '').trim()) groups[k].po = String(r[3]).trim();
    if (r[11]) groups[k].doc = String(r[11]);
  });

  var changed = [], unknown = [], internal = [], shopMoved = [], ai = 0, aiLimit = (p.aiLimit != null && p.aiLimit !== "") ? Math.max(0, Number(p.aiLimit) || 0) : 12, more = false;
  Object.keys(groups).forEach(function (k) {
    var g = groups[k], ref = g.po || refByInv[invKey_(g.inv)] || '', how = g.po ? 'PO# on the row' : (ref ? 'supplier email / filing log' : '');
    if (!ref && g.doc) {
      if (ai >= aiLimit || Date.now() - t0 > 240000) { more = true; unknown.push(g.sup + ' ' + g.inv + ' (not read yet)'); return; }
      try {
        var id = (/\/d\/([A-Za-z0-9_-]{20,})/.exec(g.doc) || [])[1];
        if (id) {
          var f = DriveApp.getFileById(id), blob = f.getBlob(); ai++;
          var ex = geminiExtractDoc_(Utilities.base64Encode(blob.getBytes()), blob.getContentType() || 'application/pdf', null);
          ref = String(ex.poRef || ''); how = 'read from the PDF';
        }
      } catch (e) {}
    }
    var hit = ref ? poRefResolve_(idx, ref) : null;
    if (!hit) {
      // v45/v47 - no customer job: the PDF goes to the folder its reference names (Shop Supplies,
      // Tools, Paul, PCW, or the client's own name); the stock count stays on Stock.
      var fname = g.doc ? internalPoFolderName_(ref) : '';
      if (fname) {
        shopMoved.push(g.sup + ' ' + g.inv + (ref ? ' ("' + ref + '")' : ' (no PO)') + ' → ' + fname + ' folder');
        if (!p.dryRun) try {
          var sid = (/\/d\/([A-Za-z0-9_-]{20,})/.exec(g.doc) || [])[1], sf = internalPoFolder_(ref);
          if (sid && sf) DriveApp.getFileById(sid).moveTo(sf);
        } catch (e) {}
        return;
      }
      (ref ? internal : unknown).push(g.sup + ' ' + g.inv + (ref ? ' → "' + ref + '" (stays on Stock)' : ' (no job number found)'));
      return;
    }
    changed.push(g.sup + ' ' + g.inv + ' → ' + hit.po + ' · ' + hit.site + ' (' + g.rows.length + ' line(s), ' + how + ')' +
      (poRefNote_(hit, ref) ? ' [' + poRefNote_(hit, ref) + ']' : ''));
    if (p.dryRun) return;
    g.rows.forEach(function (i) {
      sh.getRange(i + 2, 3, 1, 2).setValues([[txt_(hit.site), hit.po]]);
    });
    try {                                              // the PDF goes into the job-number folder
      var fid = (/\/d\/([A-Za-z0-9_-]{20,})/.exec(g.doc) || [])[1];
      var dest = poArchiveFolder_(hit.site, hit.po);
      if (fid && dest) DriveApp.getFileById(fid).moveTo(dest);
    } catch (e) {}
  });
  if (!p.dryRun) {
    try { CacheService.getScriptCache().removeAll(['jobCosts', 'materials_v3']); } catch (e) {}
    log_(user, 'repairJobPOs', '', '', changed.length + ' invoice(s) moved to their job' + (more ? ' (more to do)' : ''));
  }
  return { dryRun: !!p.dryRun, changed: changed, toShopFolders: shopMoved, stayOnStock: internal, unknown: unknown, more: more, aiReads: ai };
}


/* ============================================================================================
 * v46 - PAUL CONFIRMS THE PARTS BEFORE THE INITIAL DRAFT
 * Build Initial Draft now opens the job's supplier-PO lines in the app, one line each with an
 * editable quantity (0 = not charged; lines can be added). Saving writes that list to the
 * "Invoice lists" tab of the Materials Price List and starts Claude, which builds the part lines
 * from THIS list only - Paul's quantities, the POs' unit cost - and then fetches the hours.
 *   invoiceMaterialsSave (app, admin)  { po, jobSite, items:[{sku, desc, qty, unit, supplier, invoice}] }
 *   invoiceMaterials     (app + inbound key) { po, jobSite } -> the saved list, newest save only
 * ==========================================================================================*/
var INVL_TAB = 'Invoice lists';
var INVL_HEADERS = ['Saved at', 'PO#', 'Job site', 'SKU (ours)', 'Description', 'Qty to bill',
                    'Unit cost', 'Line cost', 'Supplier', 'Invoice #', 'Qty bought', 'Saved by'];
function invlKey_(po, job) { return po ? 'po:' + poKey_(po) : 'job:' + lc_(job); }

function invoiceMaterials_(user, p) {
  requireAdmin_(user);
  var po = String(p.po || p.poNumber || '').trim(), job = String(p.jobSite || '').trim();
  if (!po && !job) throw new Error('Send po or jobSite.');
  var want = invlKey_(po, job), sh = plTab_(INVL_TAB, INVL_HEADERS), last = sh.getLastRow();
  var items = [], savedAt = '', savedBy = '';
  if (last >= 2) sh.getRange(2, 1, last - 1, INVL_HEADERS.length).getValues().forEach(function (r) {
    if (invlKey_(String(r[1] || '').trim(), String(r[2] || '')) !== want) return;
    savedAt = r[0] instanceof Date ? r[0].toISOString() : String(r[0]); savedBy = String(r[11] || '');
    items.push({ sku: String(r[3] || ''), desc: String(r[4] || ''), qty: Number(r[5]) || 0,
                 unit: r[6] === '' ? null : Number(r[6]), line: r[7] === '' ? null : Number(r[7]),
                 supplier: String(r[8] || ''), invoice: String(r[9] || ''), bought: r[10] === '' ? null : Number(r[10]) });
  });
  var billed = items.filter(function (i) { return i.qty > 0; });
  var total = billed.reduce(function (a, i) { return a + (i.line || 0); }, 0);
  return { found: items.length > 0, po: po, jobSite: job, savedAt: savedAt, savedBy: savedBy,
           items: billed, zeroed: items.length - billed.length, partsCost: Math.round(total * 100) / 100 };
}

function invoiceMaterialsSave_(user, p) {
  requireAdmin_(user);
  var po = String(p.po || '').trim(), job = String(p.jobSite || '').trim();
  if (!po && !job) throw new Error('No job given.');
  var items = (p.items || []).map(function (it) {
    var qty = Math.max(0, Number(it.qty) || 0), unit = (it.unit === '' || it.unit == null) ? '' : Number(it.unit);
    return { sku: String(it.sku || '').trim(), desc: String(it.desc || '').trim(), qty: qty, unit: unit,
             supplier: String(it.supplier || '').trim(), invoice: String(it.invoice || '').trim(),
             bought: it.bought == null ? '' : Number(it.bought) };
  }).filter(function (it) { return it.desc || it.sku; });
  var want = invlKey_(po, job), now = new Date();
  withLock_(function () {
    var sh = plTab_(INVL_TAB, INVL_HEADERS), last = sh.getLastRow();
    if (last >= 2) {                                         // a re-save replaces the earlier list
      var keys = sh.getRange(2, 2, last - 1, 2).getValues();
      for (var i = keys.length - 1; i >= 0; i--)
        if (invlKey_(String(keys[i][0] || '').trim(), String(keys[i][1] || '')) === want) sh.deleteRow(i + 2);
    }
    if (items.length) sh.getRange(sh.getLastRow() + 1, 1, items.length, INVL_HEADERS.length).setValues(items.map(function (it) {
      var line = it.unit === '' ? '' : Math.round(it.unit * it.qty * 100) / 100;
      return [now, po, txt_(job), it.sku, it.desc, it.qty, it.unit, line, it.supplier, it.invoice, it.bought, user.email];
    }));
  });
  var billed = items.filter(function (it) { return it.qty > 0; });
  var total = 0;
  var lines = billed.map(function (it) {
    var line = it.unit === '' ? null : it.unit * it.qty; if (line != null) total += line;
    return '  ' + it.qty + ' x ' + it.desc + (it.sku ? ' [' + it.sku + ']' : '') +
      (it.unit === '' ? ' (no cost on file)' : ' @ $' + it.unit.toFixed(2) + ' = $' + line.toFixed(2)) +
      (it.supplier || it.invoice ? '  (' + [it.supplier, it.invoice].filter(String).join(' ') + ')' : '');
  });
  p._list = 'MATERIALS CONFIRMED BY PAUL IN THE APP - ' + billed.length + ' line(s), parts cost $' + total.toFixed(2) +
    (items.length - billed.length ? ' (' + (items.length - billed.length) + ' PO line(s) set to 0 - not billed)' : '') + ':\n' +
    (lines.join('\n') || '  (none - labour only)');
  p.stage = 'initial';
  var r = invoiceRequest_(user, p);
  r.lines = billed.length; r.partsCost = Math.round(total * 100) / 100;
  return r;
}


/* ============================================================================================
 * v48 - ONE PLACE FOR EVERYTHING THAT NEEDS AN ADMIN'S OK
 * The app's Requests tab shows, above the website leads: hours waiting for approval (new manual
 * entries, edited entries sent back for re-approval), time-off requests and allowance claims.
 * Same approve/deny actions as before (approveEntry, rejectEntry, timeOffDecide, allowanceDecide).
 * ==========================================================================================*/
/* ============================================================================================
 * v76 - NEO'S REPORT  (the inbox, three times a day, on the Requests tab)
 *
 * A scheduled task reads what is still sitting in the inbox, decides what a person actually has
 * to deal with, writes a one-line summary and a suggested reply for each, and posts the lot here
 * with the inbound key. The app shows it on the Requests tab; Paul edits a reply and sends it, or
 * saves it as a draft, or says Ignore or Remind me later.
 *
 * THIS TAB IS ALSO THE MEMORY, which is the whole reason the report is stored rather than emailed:
 *   ignored  - never shown again WHILE the newest message is the one that was ignored. If the
 *              person writes again the thread comes back, because a follow-up is new information
 *              (Charles, 27 Oct: "gone - unless they write again").
 *   later    - shown again on the very next sweep.
 *   replied  - we answered it; it only comes back if they write again.
 *   new      - the current report.
 * Anything the sweep no longer finds, and that carries no decision, is dropped: a fresh report
 * replaces the old one, so there are never two of Neo's reports in the app.
 * ==========================================================================================*/
var NEO_HEADERS = ['ID','Sweep at','Thread','Last message','From','Subject','Email date',
                   'Why it needs you','Summary','Suggested reply','Link','Status',
                   'Decided at','Decided by','Answered at'];
var NEO_SWEEP_KEY_ = 'neoLastSweep';   // v78 - when the last sweep ran, whether or not it found anything
var NEO_ = { ID:0, SWEPT:1, THREAD:2, MSG:3, FROM:4, SUBJ:5, DATE:6, WHY:7, SUM:8, REPLY:9,
             LINK:10, STATUS:11, DECIDED:12, BY:13, SENT:14 };
function neoSheet_() {
  var sh = masterSheet_(SHEETS.NEO);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,NEO_HEADERS.length).setValues([NEO_HEADERS]).setFontWeight('bold');
  return sh;
}
function neoRows_() {
  var sh = neoSheet_(), last = sh.getLastRow();
  return { sheet: sh, rows: last < 2 ? [] : sh.getRange(2,1,last-1,NEO_HEADERS.length).getValues() };
}
/* action: "neoReportPost"  (inbound key, or an admin)
 * payload: { sweepAt, items: [{ threadId, msgId, from, subject, date, why, summary, reply, link }] }
 * Replaces the open report, keeps the memory, and says what it did with each thread. */
function neoReportPost_(user, p) {
  requireAdmin_(user);   // the inbound-key caller arrives as an admin (see keyUser in doPost)
  p = p || {};
  var items = (p.items || []).filter(function (it) { return it && it.threadId; });
  // v91 - the sweep posted the same report 3-5 times a slot (its curl did not follow Google's
  // redirect, so it never saw the answer and sent it again). The same report within 20 minutes is
  // answered with the first answer and nothing is rewritten.
  var fpKey = '';
  try {
    fpKey = 'neo_fp_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
      JSON.stringify(items.map(function (it) { return [it.threadId, it.msgId || '', it.summary || '']; })))).slice(0, 22);
    var prevOut = CacheService.getScriptCache().get(fpKey);
    if (prevOut) { var po_ = JSON.parse(prevOut); po_.replay = true; return po_; }
  } catch (e) {}
  var sweptAt = String(p.sweepAt || new Date().toISOString());
  var t = neoRows_(), was = {};
  t.rows.forEach(function (r) {
    var th = String(r[NEO_.THREAD] || ''); if (!th) return;
    was[th] = { status: lc_(r[NEO_.STATUS]), msg: String(r[NEO_.MSG] || ''), row: r };
  });
  var keep = [], out = { posted: 0, heldBack: 0, revived: 0, carried: 0 };
  // 1. the memory: a thread we have ignored or answered stays out of the report until the next
  //    message on it, so the row (and its decision) is carried forward untouched.
  t.rows.forEach(function (r) {
    var st = lc_(r[NEO_.STATUS]);
    if (st === 'ignored' || st === 'replied' || st === 'drafted') { keep.push(r.slice()); out.carried++; }
  });
  // 2. the new report
  items.forEach(function (it) {
    var th = String(it.threadId), msg = String(it.msgId || ''), prev = was[th];
    if (prev && (prev.status === 'ignored' || prev.status === 'replied' || prev.status === 'drafted')) {
      if (prev.msg && msg && prev.msg === msg) { out.heldBack++; return; }   // nothing new has arrived
      // they wrote again: the decision is spent, so the carried row goes and this one takes its place
      keep = keep.filter(function (r) { return String(r[NEO_.THREAD] || '') !== th; });
      out.carried--; out.revived++;
    }
    var row = new Array(NEO_HEADERS.length).fill('');
    // v91 - the same email still waiting keeps the id it had, so an item Paul has open in the app
    // is not "no longer in the report" because the sweep ran again.
    row[NEO_.ID]     = (prev && (prev.status === 'new' || prev.status === 'later') && prev.msg === msg && prev.row[NEO_.ID]) ? prev.row[NEO_.ID] : newId_();
    row[NEO_.SWEPT]  = sweptAt;
    row[NEO_.THREAD] = th;
    row[NEO_.MSG]    = msg;
    row[NEO_.FROM]   = txt_(String(it.from || ''));
    row[NEO_.SUBJ]   = txt_(String(it.subject || ''));
    row[NEO_.DATE]   = String(it.date || '');
    row[NEO_.WHY]    = txt_(String(it.why || ''));
    row[NEO_.SUM]    = txt_(String(it.summary || ''));
    row[NEO_.REPLY]  = txt_(String(it.reply || ''));
    row[NEO_.LINK]   = String(it.link || ('https://mail.google.com/mail/u/0/#all/' + th));
    row[NEO_.STATUS] = 'new';
    keep.push(row); out.posted++;
  });
  // 3. write the tab back in one go
  var sh = t.sheet, last = sh.getLastRow();
  if (last > 1) sh.getRange(2,1,last-1,NEO_HEADERS.length).clearContent();
  if (keep.length) sh.getRange(2,1,keep.length,NEO_HEADERS.length).setValues(keep);
  log_(user, 'neoReportPost', '', '', out.posted + ' item(s) posted, ' + out.heldBack +
       ' held back (ignored or answered), ' + out.revived + ' revived (they wrote again)');
  // v78 - when the sweep ran, kept apart from what it found. A sweep that finds nothing leaves no
  // row behind, so the tab cannot say whether it ran at all, and the app could not tell "nothing
  // needs you" from "never deployed" - which is exactly what it showed Charles.
  try { PropertiesService.getScriptProperties().setProperty(NEO_SWEEP_KEY_, sweptAt); } catch (e) {}
  out.sweepAt = sweptAt;
  try { if (fpKey) CacheService.getScriptCache().put(fpKey, JSON.stringify(out), 1200); } catch (e) {}
  return out;
}
/* action: "neoReport" - the open report for the app. */
function neoReport_(user) {
  requirePerm_(user, 'approveHours');
  var t = neoRows_(), items = [], sweptAt = '';
  t.rows.forEach(function (r) {
    if (lc_(r[NEO_.STATUS]) !== 'new') return;
    var at = String(r[NEO_.SWEPT] || ''); if (at > sweptAt) sweptAt = at;
    items.push({ id: String(r[NEO_.ID]), threadId: String(r[NEO_.THREAD]), from: String(r[NEO_.FROM] || ''),
      subject: String(r[NEO_.SUBJ] || ''), date: String(r[NEO_.DATE] || ''), why: String(r[NEO_.WHY] || ''),
      summary: String(r[NEO_.SUM] || ''), reply: String(r[NEO_.REPLY] || ''), link: String(r[NEO_.LINK] || '') });
  });
  var lastSweep = '';
  try { lastSweep = PropertiesService.getScriptProperties().getProperty(NEO_SWEEP_KEY_) || ''; } catch (e) {}
  return { sweepAt: sweptAt, lastSweep: lastSweep || sweptAt, items: items };
}
function neoFind_(t, id) {
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i][NEO_.ID]) === String(id)) return i + 2;
  return 0;
}
/* action: "neoDecide"  payload: { id, action: 'ignore' | 'later' } */
function neoDecide_(user, p) {
  requirePerm_(user, 'approveHours');
  var want = lc_(p && p.action) === 'later' ? 'later' : 'ignored';
  var t = neoRows_(), row = neoFind_(t, p && p.id);
  if (!row) throw new Error('That item is not in the report any more — pull it down to refresh.');
  t.sheet.getRange(row, NEO_.STATUS + 1, 1, 3).setValues([[want, new Date().toISOString(), user.email]]);
  log_(user, 'neoDecide', '', String(p.id), want);
  return { ok: true, status: want };
}
/* action: "neoReply"  payload: { id, body, draft }
 * Sends (or drafts) the reply on the original thread, as the account this script runs as. */
function neoReply_(user, p) {
  requirePerm_(user, 'approveHours');
  var body = String((p && p.body) || '').trim();
  if (!body) throw new Error('Nothing to send — write the reply first.');
  var t = neoRows_(), row = neoFind_(t, p && p.id);
  if (!row) throw new Error('That item is not in the report any more — pull it down to refresh.');
  var r = t.rows[row - 2], threadId = String(r[NEO_.THREAD] || '');
  var th = null;
  try { th = GmailApp.getThreadById(threadId); } catch (e) {}
  if (!th) throw new Error('That email thread could not be opened — it may have been deleted.');
  var draft = !!(p && p.draft);
  try {
    if (draft) th.createDraftReply(body);
    else th.reply(body);
  } catch (e) {
    throw new Error((draft ? 'Could not save the draft: ' : 'Could not send it: ') + e.message);
  }
  var now = new Date().toISOString();
  t.sheet.getRange(row, NEO_.STATUS + 1, 1, 3).setValues([[draft ? 'drafted' : 'replied', now, user.email]]);
  t.sheet.getRange(row, NEO_.SENT + 1).setValue(now);
  t.sheet.getRange(row, NEO_.REPLY + 1).setValue(txt_(body));      // what was actually sent
  log_(user, 'neoReply', String(r[NEO_.FROM] || ''), String(p.id),
       (draft ? 'draft saved on' : 'replied on') + ' "' + String(r[NEO_.SUBJ] || '') + '"');
  return { ok: true, draft: draft };
}

/* ===================== A NOTIFICATION WHEN NEO FINDS SOMETHING (v79) ========================
 * Charles, 29 Oct, choosing between a text and a push: "Push notification". So the phone itself
 * is told, with no carrier, no Twilio account and nobody's number written down anywhere.
 *
 * THIS SCRIPT DOES NOT SEND THE PUSH, and cannot. A push is signed with VAPID, which is ECDSA
 * over P-256, and its payload is sealed with ECDH + AES128GCM; Apps Script's Utilities does HMAC
 * and RSA and neither of those. The sweep that writes the report already runs somewhere with a
 * real crypto library, so it sends the push as its last step and this script is only the address
 * book: the app files a subscription here, the sweep reads it on the inbound key, and tells us
 * when a push service says a subscription is dead so the row can be marked and skipped.
 *
 * A subscription is ONE BROWSER ON ONE PHONE. The endpoint is its identity - re-subscribing on
 * the same phone returns the same endpoint, so the row is updated rather than duplicated - and
 * it is a capability, not a secret of ours: anyone holding it and the VAPID private key can make
 * that phone buzz. Hence admins only, and the tab goes under the same protection as the rest. */
var PUSH_HEADERS = ['Endpoint','p256dh','auth','Who','Label','Added','Status'];
var PUSH_ = { EP:0, KEY:1, AUTH:2, WHO:3, LABEL:4, ADDED:5, STATUS:6 };
function pushSheet_() {
  var sh = masterSheet_(SHEETS.PUSH);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,PUSH_HEADERS.length).setValues([PUSH_HEADERS]).setFontWeight('bold');
  return sh;
}
function pushRows_() {
  var sh = pushSheet_(), last = sh.getLastRow();
  return { sheet: sh, rows: last < 2 ? [] : sh.getRange(2,1,last-1,PUSH_HEADERS.length).getValues() };
}
function pushFind_(t, endpoint) {
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i][PUSH_.EP]) === String(endpoint)) return i + 2;
  return 0;
}
/* action: "pushSubscribe"  payload: { endpoint, p256dh, auth, label } */
function pushSubscribe_(user, p) {
  requirePerm_(user, 'approveHours');
  p = p || {};
  var ep = String(p.endpoint || '').trim();
  if (!/^https:\/\//.test(ep)) throw new Error('That phone did not give a usable address to send to.');
  if (!String(p.p256dh || '').trim() || !String(p.auth || '').trim())
    throw new Error('That subscription is missing its keys — turn it off and on again.');
  var t = pushRows_(), row = pushFind_(t, ep), now = new Date().toISOString();
  var vals = [ep, String(p.p256dh), String(p.auth), lc_(user.email), txt_(String(p.label || '')),
               now, 'on'];
  if (row) {
    vals[PUSH_.ADDED] = t.rows[row-2][PUSH_.ADDED] || now;   // same phone: keep the day it was first added
    t.sheet.getRange(row, 1, 1, PUSH_HEADERS.length).setValues([vals]);
  } else {
    t.sheet.getRange(t.sheet.getLastRow() + 1, 1, 1, PUSH_HEADERS.length).setValues([vals]);
  }
  log_(user, 'pushSubscribe', '', '', (row ? 'renewed' : 'added') + ' ' + (p.label || 'a phone'));
  return { ok: true, renewed: !!row };
}
/* action: "pushUnsubscribe"  payload: { endpoint } - the person turned it off in the app. */
function pushUnsubscribe_(user, p) {
  requirePerm_(user, 'approveHours');
  var t = pushRows_(), row = pushFind_(t, String((p && p.endpoint) || ''));
  if (!row) return { ok: true, gone: true };
  t.sheet.getRange(row, PUSH_.STATUS + 1).setValue('off');
  log_(user, 'pushUnsubscribe', '', '', 'turned off');
  return { ok: true };
}
/* action: "pushSubs" (inbound key) - who to tell, for the sweep. */
function pushSubs_(user) {
  requireAdmin_(user);
  var out = [];
  pushRows_().rows.forEach(function (r) {
    if (lc_(r[PUSH_.STATUS]) !== 'on') return;
    out.push({ endpoint: String(r[PUSH_.EP]), p256dh: String(r[PUSH_.KEY]), auth: String(r[PUSH_.AUTH]),
               who: String(r[PUSH_.WHO] || ''), label: String(r[PUSH_.LABEL] || '') });
  });
  return { subs: out };
}
/* action: "pushDrop" (inbound key)  payload: { endpoint, why }
 * The push service answered 404 or 410: that subscription no longer exists. Marked rather than
 * deleted, so "it stopped telling me" has an answer on the tab months later. */
function pushDrop_(user, p) {
  requireAdmin_(user);
  var t = pushRows_(), row = pushFind_(t, String((p && p.endpoint) || ''));
  if (!row) return { ok: true, gone: true };
  t.sheet.getRange(row, PUSH_.STATUS + 1).setValue('gone');
  log_(user, 'pushDrop', '', '', String((p && p.why) || 'the push service says it is gone'));
  return { ok: true };
}

function approvalsAll_(user) {
  requirePerm_(user, 'approveHours');
  var out = { entries: pendingApprovals_(user).pending, timeOff: [], allowances: [], newParts: [] };
  // v80 - a part nobody had heard of, typed on the job. It is already ON the job and on the
  // invoice; what is waiting is its NAME, so it belongs on the Requests tab with everything
  // else that waits on a person, not behind a button in the settings.
  try { out.newParts = pendingMaterials_(user).pending; } catch (e) {}
  if (user.role !== 'admin') return out;              // time off + allowances are admin decisions
  var names = employeeNameMap_();
  try {
    var tsh = toSheet_(), tlast = tsh.getLastRow();
    if (tlast > 1) tsh.getRange(2, 1, tlast - 1, 9).getValues().forEach(function (r) {
      if (String(r[5]) !== 'pending') return;
      var em = lc_(r[1]);
      out.timeOff.push({ id: r[0], email: em, name: names[em] || em.split('@')[0],
        start: jhaDateStr_(r[2]), end: jhaDateStr_(r[3]), reason: String(r[4] || ''),
        requestedAt: r[6] instanceof Date ? r[6].toISOString() : String(r[6] || '') });
    });
  } catch (e) {}
  try {
    var ash = allowSheet_(), alast = ash.getLastRow();
    if (alast > 1) ash.getRange(2, 1, alast - 1, 11).getValues().forEach(function (r) {
      if (String(r[7]) !== 'pending') return;
      var em = lc_(r[1]);
      out.allowances.push({ id: r[0], email: em, name: names[em] || em.split('@')[0], date: jhaDateStr_(r[2]),
        type: String(r[3]), typeName: ALLOWANCE_TYPES[String(r[3])] || String(r[3]), km: Number(r[4]) || 0,
        amount: Number(r[5]) || 0, note: String(r[6] || '') });
    });
  } catch (e) {}
  return out;
}

/* ============================================================================================
 * v56 - GOOGLE CONTACTS  (contactLookup / contactAdd)
 *
 * The overnight sweep has been calling these two actions for weeks and getting "Not signed in."
 * back. There was no permission problem and no account problem: THE ACTIONS DID NOT EXIST. The
 * key path refuses an action it does not know, the request then fell through to the sign-in
 * branch, and the sign-in branch reported the only failure it understands. v55 made that message
 * honest; this builds the thing it was asking for.
 *
 * Built on the PEOPLE API, not ContactsApp. ContactsApp still works but Google marks it
 * deprecated and points at the People API advanced service, and a sweep that runs unattended
 * every night is the last place to put a dependency that is on its way out.
 *
 * SETUP - ONCE, BY HAND, OR NONE OF THIS RUNS:
 *   1. Apps Script editor, left sidebar, Services  +  ->  People API  ->  Add.
 *      The identifier must stay the default, "People".
 *   2. Run contactsSelfTest() from the editor and approve the permission prompt when it asks
 *      for access to contacts. Nothing can authorize a scheduled run; it has to be a human once.
 * contactsSelfTest() says plainly which of those two steps is missing.
 *
 * THE RULE, the same one the QuickBooks customer record follows: FILL BLANKS, NEVER OVERWRITE.
 * A contact that already has a phone number keeps it even when the PO Log says otherwise - the
 * person who typed it into their phone knew something the form did not - and the disagreement is
 * reported instead. And a client is never added twice: matched on email, then phone, then name.
 * ==========================================================================================*/

var CONTACT_GROUP_ = 'PRO Clients';
var PEOPLE_CACHE_ = null;

/* The People advanced service, or a refusal that says exactly what to do about it. */
function peopleSvc_() {
  if (typeof People === 'undefined' || !People || !People.People) {
    throw new Error('The People API is not switched on for this script. In the Apps Script ' +
      'editor: Services (left sidebar) > + > People API > Add, leaving the identifier as ' +
      '"People". Then run contactsSelfTest() once and approve the contacts permission.');
  }
  return People;
}

function digits_(v) { return String(v || '').replace(/[^0-9]/g, '').slice(-10); }

/* v68 - WHO MUST NEVER BECOME A CLIENT CONTACT.
 * Two website-form TESTS were written into Google Contacts as clients: one submitted with
 * Charles's own address became a contact called "Test Test", and one submitted with the Wagyu
 * address and no name in the form became a contact called "PCW" (with no name to use, the old
 * code fell back to the company). Gmail takes a sender's display name from Contacts, so from
 * then on their own mail arrived under those names - which is how this was noticed.
 * Our own addresses are never a client, so a form carrying one is never written to Contacts. */
var CONTACT_INHOUSE_DOMAINS_ = ['proes.ca', 'pcwagyu.com'];
function contactInHouse_(email) {
  var e = lc_(String(email || '').trim());
  if (!e || e.indexOf('@') < 0) return '';
  if (CONFIG.ADMIN_EMAILS.map(lc_).indexOf(e) >= 0) return 'an admin address';
  if ((CONFIG.BOOKKEEPER_EMAILS || []).map(lc_).indexOf(e) >= 0) return 'the bookkeeper address';
  var dom = e.split('@')[1] || '';
  for (var i = 0; i < CONTACT_INHOUSE_DOMAINS_.length; i++)
    if (dom === CONTACT_INHOUSE_DOMAINS_[i]) return 'one of our own domains (' + dom + ')';
  // The crew's personal addresses are in the Employees tab, which catches a gmail address that
  // no domain rule could. A sheet that will not read must not disable the rest of the guard.
  try { if (employeeNameMap_()[e]) return 'an employee address'; } catch (ex) {}
  return '';
}
/* v68 - a form filled in to see whether the form works: "Test", the same word twice, one letter. */
function contactLooksTest_(name) {
  var n = String(name || '').trim();
  if (!n) return '';
  if (n.replace(/[^A-Za-z]/g, '').length < 2) return 'too short to be a name';
  if (/\b(test|testing|asdf|qwerty|aaaa?)\b/i.test(n)) return 'it says "' + n + '"';
  var w = n.toLowerCase().split(/\s+/);
  if (w.length === 2 && w[0] === w[1]) return 'the same word twice';
  return '';
}

/* Everyone in the account's contacts, read once per execution. */
function peopleAll_() {
  if (PEOPLE_CACHE_) return PEOPLE_CACHE_;
  var P = peopleSvc_(), out = [], token = null, guard = 0;
  do {
    var r = P.People.Connections.list('people/me', {
      pageSize: 1000, pageToken: token || undefined,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,addresses,memberships'
    });
    (r.connections || []).forEach(function (c) { out.push(c); });
    token = r.nextPageToken;
  } while (token && ++guard < 20);
  PEOPLE_CACHE_ = out;
  return out;
}

function contactPack_(c) {
  var nm = (c.names || [])[0] || {};
  var org = (c.organizations || [])[0] || {};
  return {
    resourceName: c.resourceName,
    name: String(nm.displayName || ((nm.givenName || '') + ' ' + (nm.familyName || '')).trim()),
    company: String(org.name || ''),
    emails: (c.emailAddresses || []).map(function (e) { return String(e.value || ''); }).filter(String),
    phones: (c.phoneNumbers || []).map(function (p) { return String(p.value || ''); }).filter(String),
    addresses: (c.addresses || []).map(function (a) { return String(a.formattedValue || ''); }).filter(String)
  };
}

/* v69 - Charles's rule, in his words: "if the name exist, add the info to that name. If the
 * email exist, do not correct the info but complete what is missing. Same thing if the phone
 * number exist. Do not create new contact when some information already is in the contact."
 *
 * So ANY of the three - name, email, phone - already in the address book means this is somebody
 * we already have, and the only thing that happens is that empty fields get filled. A name is
 * compared on what it says rather than character for character, because "McGregor " and
 * "mcgregor" are the same man and the old exact-string test said they were not. */
function contactNameKey_(v) {
  return String(v || '').replace(/\s+/g, ' ').replace(/[.,;:'"()\[\]]/g, '').trim().toLowerCase();
}
function contactBaseName_(v) {
  var s = String(v || '').split(/\s[—–-]\s|,/)[0];
  var k = contactNameKey_(s);
  return k.indexOf(' ') > 0 ? k : '';               // a bare first name is never enough (two Ricks)
}
/* Every contact this could be, strongest first, each with WHY it matched. */
function contactCandidates_(p) {
  p = p || {};
  var email = lc_(String(p.email || '').trim()), phone = digits_(p.phone), nkey = contactNameKey_(p.name);
  var all = peopleAll_(), out = [];
  for (var i = 0; i < all.length; i++) {
    var c = all[i], k = contactPack_(c), why = '', rank = 0;
    if (email && k.emails.some(function (e) { return lc_(e) === email; })) { why = 'the same email (' + email + ')'; rank = 3; }
    else if (phone && phone.length >= 7 && k.phones.some(function (x) { return digits_(x) === phone; })) { why = 'the same phone (' + p.phone + ')'; rank = 2; }
    else if (nkey && contactNameKey_(k.name) === nkey) { why = 'the same name (' + k.name + ')'; rank = 1; }
    // v91 - "Angelica Alberto — THE BEAUTY BAR & CO." and "Jeniffer Bringas, manager" are those
    // people: the name is compared on the part before the dash or the comma as well.
    else if (nkey && contactBaseName_(k.name) && contactBaseName_(k.name) === contactBaseName_(p.name)) { why = 'the same name (' + k.name + ')'; rank = 1; }
    if (rank) out.push({ c: c, k: k, why: why, rank: rank });
  }
  out.sort(function (a, b) { return b.rank - a.rank; });
  return out;
}
/* The one contact this is, or null - the strongest match. */
function contactMatch_(p) {
  var l = contactCandidates_(p);
  return l.length ? l[0].c : null;
}
/* v70 - NEARLY the same name: every word of the shorter one is in the longer one, and they
 * share a word of five letters or more. "McGregor" and "McGregor Hostetler" pass (and that is a
 * real pair - the PO Log has both). "Rick" and "Rick Findlay" do NOT: a bare first name is not
 * enough to call two people the same, and there are two Ricks on the log already.
 * A near match is never merged automatically - it is reported, and nothing is written, because a
 * duplicate contact is a tidying job while the wrong email on somebody's card is a letter sent
 * to the wrong person. force: true goes ahead and creates. */
function contactNearName_(a, b) {
  var wa = contactNameKey_(a).split(' ').filter(String), wb = contactNameKey_(b).split(' ').filter(String);
  if (!wa.length || !wb.length) return false;
  var shortW = wa.length <= wb.length ? wa : wb, longW = wa.length <= wb.length ? wb : wa;
  if (shortW.join(' ') === longW.join(' ')) return false;            // identical is an exact match, not a near one
  for (var i = 0; i < shortW.length; i++) if (longW.indexOf(shortW[i]) < 0) return false;
  for (var j = 0; j < shortW.length; j++) if (shortW[j].length >= 5) return true;
  return false;
}
/* A business already in the book under its own name. Reported, never written to: a contact
 * person's email does not belong on the company's card unless somebody says so. */
function contactCompanyCard_(company, exceptResource) {
  var ckey = contactNameKey_(company);
  if (!ckey) return null;
  var all = peopleAll_();
  for (var i = 0; i < all.length; i++) {
    var k = contactPack_(all[i]);
    if (k.resourceName === exceptResource) continue;
    if (contactNameKey_(k.name) === ckey || contactNameKey_(k.company) === ckey) return k;
  }
  return null;
}

/* The "PRO Clients" group, made if it is not there yet. */
function contactGroup_(wanted) {
  var P = peopleSvc_(), want = lc_(wanted || CONTACT_GROUP_);
  try {
    var r = P.ContactGroups.list({ pageSize: 200, groupFields: 'name' });
    var gs = r.contactGroups || [];
    for (var i = 0; i < gs.length; i++) {
      if (lc_(gs[i].formattedName || gs[i].name) === want) return gs[i].resourceName;
    }
  } catch (e) {}
  try {
    var made = P.ContactGroups.create({ contactGroup: { name: wanted || CONTACT_GROUP_ } });
    return made.resourceName;
  } catch (e) { return ''; }
}

function contactInGroup_(groupResource, personResource) {
  if (!groupResource || !personResource) return '';
  try {
    peopleSvc_().ContactGroups.Members.modify({ resourceNamesToAdd: [personResource] }, groupResource);
    return 'in ' + (CONTACT_GROUP_);
  } catch (e) { return 'group not set: ' + e.message; }
}

/**
 * action: "contactLookup"
 * payload: { email | phone | name, company }
 * Read-only. Returns the match and everything on it, so a caller can see what is already there
 * before deciding to write.
 */
function contactLookup_(user, p) {
  peopleSvc_();
  p = p || {};
  var cands = contactCandidates_(p);
  if (!cands.length) return { found: false, searched: { email: p.email || '', phone: p.phone || '', name: p.name || '' } };
  // v69 - the whole list, with the reason, so a caller can see a duplicated address book for
  // what it is instead of being handed one of two contacts with no way to tell.
  return { found: true, contact: cands[0].k, matchedOn: cands[0].why,
    others: cands.slice(1).map(function (x) { return { name: x.k.name, resourceName: x.k.resourceName, why: x.why }; }) };
}

/**
 * action: "contactAdd"
 * payload: { name, company, email, phone, address, group }
 * Adds the client to Google Contacts and to the PRO Clients group. If they are already there it
 * fills only the fields that are EMPTY and reports anything that disagrees - it never overwrites,
 * and it never makes a second copy of a person.
 */
function contactAdd_(user, p) {
  var P = peopleSvc_();
  p = p || {};
  var name = String(p.name || '').trim(), company = String(p.company || '').trim();
  if (!name && !company) throw new Error('A contact needs at least a name or a company.');
  if (/^[A-Z]{1,2}-?\s?\d{5,}$/i.test(name)) throw new Error('"' + name + '" is a job number, not a person.');
  var email = String(p.email || '').trim(), phone = String(p.phone || '').trim(),
      address = String(p.address || '').trim();

  // v68 - our own people are not clients. Nothing is written; the caller is told why.
  var inHouse = contactInHouse_(email);
  if (inHouse && !p.force) {
    log_(user, 'contactAdd', name || company, '', 'SKIPPED - ' + email + ' is ' + inHouse);
    return { created: false, updated: false, skipped: 'in-house',
      reason: email + ' is ' + inHouse + ', so nothing was written to Google Contacts. ' +
              'Send force: true if this really is a client.' };
  }

  // A form with no person name on it is filed under the company (that is what the create path
  // below does too), so that is the name to look for - otherwise a second "KFC" gets created.
  var cands = contactCandidates_({ email: email, phone: phone, name: name || company });
  /* v69 - TWO contacts already hold this person's details (a duplicated address book - the log
     shows "Isaac Laboucan-Aviron  2 match(es)"). Writing to one of them would be a coin flip and
     filling both would spread the duplication, so nothing is written and both are named. */
  var tied = cands.filter(function (x) { return cands.length && x.rank === cands[0].rank; });
  if (tied.length > 1) {
    var who = tied.map(function (x) { return x.k.name + ' (' + x.k.resourceName + ')'; }).join(' and ');
    log_(user, 'contactAdd', name || company, '', 'SKIPPED - ' + tied.length + ' contacts match: ' + who);
    return { created: false, updated: false, skipped: 'ambiguous',
      matchedOn: cands[0].why, candidates: tied.map(function (x) { return x.k; }),
      reason: tied.length + ' contacts already match on ' + cands[0].why + ' - ' + who +
              '. Nothing was written; merge them in Google Contacts, or say which one to use.' };
  }
  var found = cands.length ? cands[0].c : null;
  var matchedOn = cands.length ? cands[0].why : '';

  /* v70 - nothing matched outright, but somebody with nearly this name is already there.
     Report it and write nothing, rather than quietly making a second card for one person. */
  if (!found) {
    var near = null, lookFor = name || company, allC = peopleAll_();
    for (var ni = 0; ni < allC.length && !near; ni++) {
      var nk = contactPack_(allC[ni]);
      if (contactNearName_(nk.name, lookFor)) near = nk;
    }
    if (near && !p.force) {
      log_(user, 'contactAdd', lookFor, '', 'SKIPPED - nearly "' + near.name + '" (' + near.resourceName + ')');
      return { created: false, updated: false, skipped: 'possible-duplicate',
        candidates: [near],
        reason: '"' + lookFor + '" is nearly "' + near.name + '", already in Contacts (' +
                (near.emails.join(', ') || 'no email') + '). Nothing was written. Send force: true ' +
                'if they really are two different people, or say to use the existing one.' };
    }
  }
  var group = contactGroup_(p.group || CONTACT_GROUP_);

  if (!found) {
    // v68 - and a test entry does not become a contact either.
    var testish = contactLooksTest_(name || company);
    if (testish && !p.force) {
      log_(user, 'contactAdd', name || company, '', 'SKIPPED - looks like a test (' + testish + ')');
      return { created: false, updated: false, skipped: 'test-name',
        reason: '"' + (name || company) + '" looks like a test entry (' + testish + '), so no ' +
                'contact was created. Send force: true to add it anyway.' };
    }
    var bits = name.split(/\s+/);
    var person = { names: [{ givenName: bits[0] || company, familyName: bits.slice(1).join(' ') }] };
    if (email) person.emailAddresses = [{ value: email }];
    if (phone) person.phoneNumbers = [{ value: phone }];
    if (company) person.organizations = [{ name: company }];
    if (address) person.addresses = [{ formattedValue: address }];
    var made = P.People.createContact(person);
    PEOPLE_CACHE_ = null;
    var g1 = contactInGroup_(group, made.resourceName);
    log_(user, 'contactAdd', name || company, '', 'created · ' + g1);
    return { created: true, resourceName: made.resourceName, name: name || company, group: g1 };
  }

  // Already there. Fill what is blank; leave what is not; say what disagrees.
  var k = contactPack_(found), add = {}, fields = [], filled = [], clash = [];
  if (email) {
    if (!k.emails.length) { add.emailAddresses = [{ value: email }]; fields.push('emailAddresses'); filled.push('email'); }
    else if (!k.emails.some(function (e) { return lc_(e) === lc_(email); }))
      clash.push('email: contact has ' + k.emails.join(', ') + ', the job says ' + email);
  }
  if (phone) {
    if (!k.phones.length) { add.phoneNumbers = [{ value: phone }]; fields.push('phoneNumbers'); filled.push('phone'); }
    else if (!k.phones.some(function (x) { return digits_(x) === digits_(phone); }))
      clash.push('phone: contact has ' + k.phones.join(', ') + ', the job says ' + phone);
  }
  /* v68 - Charles's rule, written down: WHAT IS IN CONTACTS WINS, and we only ever fill an
     empty spot. The name was already never overwritten; now it is also FILLED when the contact
     has none at all (an address-book entry that is just an email address), and a name that
     disagrees is reported rather than written. */
  if (name && !k.name && !contactLooksTest_(name)) {
    var nb = name.split(/\s+/);
    add.names = [{ givenName: nb[0], familyName: nb.slice(1).join(' ') }];
    fields.push('names'); filled.push('name');
  } else if (name && k.name && lc_(k.name) !== lc_(name)) {
    clash.push('name: the contact says ' + k.name + ', the form says ' + name + ' (kept the contact)');
  }
  if (company && !k.company) { add.organizations = [{ name: company }]; fields.push('organizations'); filled.push('company'); }
  else if (company && lc_(k.company) !== lc_(company))
    clash.push('company: contact has ' + k.company + ', the job says ' + company);
  if (address && !k.addresses.length) { add.addresses = [{ formattedValue: address }]; fields.push('addresses'); filled.push('address'); }

  var note = '';
  if (fields.length) {
    try {
      add.etag = found.etag;                       // People refuses an update without the etag
      P.People.updateContact(add, found.resourceName, { updatePersonFields: fields.join(',') });
      PEOPLE_CACHE_ = null;
      note = 'filled ' + filled.join(', ');
    } catch (e) { note = 'could not update: ' + e.message; }
  } else note = 'nothing to fill';

  var g2 = contactInGroup_(group, found.resourceName);
  var coCard = null;
  try { coCard = contactCompanyCard_(company, found.resourceName); } catch (e) {}
  log_(user, 'contactAdd', name || company, '', 'existing (' + matchedOn + ') · ' + note +
       (clash.length ? ' · disagrees: ' + clash.join(' | ') : ''));
  return { created: false, updated: filled.length > 0, resourceName: found.resourceName,
           name: k.name || name, matchedOn: matchedOn, filled: filled, disagreements: clash,
           companyContact: coCard ? { name: coCard.name, resourceName: coCard.resourceName } : null,
           group: g2, note: note };
}

/** v61 — HOW SLOW IS IT, REALLY?
 * Run from the Apps Script editor. Finds the next booking on the calendar, calls eventInfo_ on
 * it exactly as the app does, and logs how many milliseconds each part took. "No answer from the
 * server" in the app is its own 30-second timeout firing — this says whether the call is slow,
 * or failing outright, and which step is to blame. */
function eventInfoSelfTest() {
  var t0 = Date.now(), user = { email: CONFIG.ADMIN_EMAILS[0], role: 'admin',
                                permissions: defaultPermissions_('admin') };
  var from = new Date(), to = new Date(from.getTime() + 30 * 86400000);
  var evs;
  try { evs = visitCal_().getEvents(from, to); }
  catch (e) { Logger.log('x Cannot reach the calendar: ' + e.message); return; }
  Logger.log('calendar read: ' + (Date.now() - t0) + ' ms, ' + evs.length + ' event(s) in the next 30 days');
  if (!evs.length) { Logger.log('Nothing booked ahead - book something and run this again.'); return; }
  for (var i = 0; i < Math.min(evs.length, 3); i++) {
    var ev = evs[i], t1 = Date.now();
    try {
      var info = eventInfo_(user, { eventId: String(ev.getId()) });
      Logger.log('- "' + info.title + '"  ' + (Date.now() - t1) + ' ms  kind=' + info.kind +
                 '  po=' + (info.po || '-') + '  customer=' + (info.customer || '-') +
                 '  enquiry=' + (info.detail ? (info.detail.length + ' chars') : 'none'));
    } catch (e) {
      Logger.log('- "' + ev.getTitle() + '"  FAILED after ' + (Date.now() - t1) + ' ms: ' + e.message);
    }
  }
  Logger.log('total ' + (Date.now() - t0) + ' ms. The app gives up at 30000 ms (75000 from v66).');
}

/** Run this from the editor once after adding the People service. It says what is missing. */
function contactsSelfTest() {
  try { peopleSvc_(); } catch (e) { Logger.log('✗ ' + e.message); return; }
  try {
    var n = peopleAll_().length;
    Logger.log('✓ People API reachable — ' + n + ' contacts in the account.');
  } catch (e) {
    Logger.log('✗ The People service is added but not authorized yet: ' + e.message +
               '\n  Run this function again and approve the contacts permission when asked.');
    return;
  }
  var g = contactGroup_(CONTACT_GROUP_);
  Logger.log(g ? ('✓ Group "' + CONTACT_GROUP_ + '" ready (' + g + ')')
               : ('✗ Could not find or create the group "' + CONTACT_GROUP_ + '".'));
  Logger.log('✓ contactLookup and contactAdd are ready for the sweeps.');
}

/* ============================================================================================
 * v68 - PUT A CONTACT'S NAME BACK  (run from the Apps Script editor)
 *
 * Two website-form tests were written into Contacts under the wrong names, and Gmail shows a
 * sender under the name Contacts holds, so Charles's and Hannah's own mail started arriving as
 * "Test Test" and "PCW". This renames those contacts back. It changes ONLY the name: every
 * email, phone, company and address on the contact is left exactly as it is.
 *
 *   1. contactsFixReport()  - says what it found and what it would do. Changes nothing.
 *   2. contactsFixApply()   - makes the renames.
 *
 * Both print to the execution log (View > Logs). If the rename leaves two contacts with the
 * same name, Google Contacts > "Merge & fix" joins them in one click - the script does not
 * merge or delete anything on its own.
 * ==========================================================================================*/
/* What to look for, and what to do with it. 'right' renames the contact and touches nothing
 * else; 'remove: true' deletes the contact outright. The Activity Log shows this script has
 * CREATED exactly one contact from a test form - "Test 1 Appointment", people/c102738742546907694,
 * on 9 Oct 18:14Z, from the test submitted with Hannah's address. Every other contactAdd in the
 * log says "existing contact", and the existing-contact path has never been able to write a name.
 * The other two names are in the list because Charles saw them; the report says what is actually
 * there before anything is changed. */
var CONTACT_NAME_FIXES_ = [
  { wrong: 'Test 1 Appointment', right: 'Hannah Olivares'  },
  { wrong: 'Test Test',          right: 'Charles Marinier' },
  { wrong: 'PCW',                right: 'Hannah Olivares'  }
];
/* Names from the test leads in the Requests tab - reported if any of them is in Contacts. */
var CONTACT_SUSPECTS_ = ['Test 1 Appointment', 'Test 2 Estimate', 'Test 3 Appointment',
  'Test 4 Estimate', 'Test Test', 'Test With New Buttons', 'Test Two', 'PCW'];

function contactsFixReport() { contactsFix_(false); }
function contactsFixApply()  { contactsFix_(true);  }

function contactsFix_(apply) {
  try { peopleSvc_(); } catch (e) { Logger.log('✗ ' + e.message); return; }
  var all;
  try { all = peopleAll_(); }
  catch (e) { Logger.log('✗ Could not read Contacts: ' + e.message); return; }
  Logger.log((apply ? 'APPLYING' : 'REPORT ONLY') + ' - ' + all.length + ' contacts in the account.');

  // Everything that LOOKS like a test lead, whether or not it is in the fix list above. This is
  // the part to read first: it says what is actually in Contacts, with the addresses attached,
  // so nobody has to guess whose contact it is.
  var sus = [];
  all.forEach(function (c) {
    var k = contactPack_(c);
    var hit = contactLooksTest_(k.name) || (CONTACT_SUSPECTS_.map(lc_).indexOf(lc_(k.name)) >= 0);
    if (hit) sus.push(k);
  });
  Logger.log('--- contacts that look like a test lead: ' + sus.length);
  sus.forEach(function (k) {
    Logger.log('    "' + k.name + '"  ' + k.resourceName +
      '\n      email:   ' + (k.emails.join(', ') || 'none') +
      '\n      phone:   ' + (k.phones.join(', ') || 'none') +
      '\n      company: ' + (k.company || 'none'));
  });

  CONTACT_NAME_FIXES_.forEach(function (fix) {
    var wrong = lc_(fix.wrong), right = String(fix.right || '').trim();
    var hits = [], already = [];
    all.forEach(function (c) {
      var k = contactPack_(c);
      if (lc_(k.name) === wrong) hits.push({ c: c, k: k });
      else if (lc_(k.name) === lc_(right)) already.push(k);
    });
    Logger.log('--- "' + fix.wrong + '"  ->  "' + right + '"');
    hits.forEach(function (h) {
      Logger.log('    found ' + h.k.resourceName +
        '\n      email:   ' + (h.k.emails.join(', ') || 'none') +
        '\n      phone:   ' + (h.k.phones.join(', ') || 'none') +
        '\n      company: ' + (h.k.company || 'none') +
        '\n      address: ' + (h.k.addresses.join(' / ') || 'none'));
    });
    if (!hits.length) {
      Logger.log('    nothing in Contacts is called that - already put right, or spelled differently.');
      return;
    }
    if (hits.length > 1) {
      Logger.log('    MORE THAN ONE contact has that name, so nothing was changed. Say which ' +
                 'resourceName above is the right one and I will narrow this down.');
      return;
    }
    if (already.length) {
      Logger.log('    note: ' + already.length + ' other contact(s) are already called "' + right +
                 '" (' + (already[0].emails.join(', ') || 'no email on it') + '). After the rename ' +
                 'there will be two - Google Contacts > "Merge & fix" joins them in one click.');
    }
    if (!apply) {
      Logger.log(fix.remove ? '    would DELETE it. Run contactsFixApply() to do it.'
                            : '    would rename it. Run contactsFixApply() to do it.');
      return;
    }
    var h = hits[0], nb = right.split(/\s+/);
    if (fix.remove) {
      try {
        peopleSvc_().People.deleteContact(h.k.resourceName);
        PEOPLE_CACHE_ = null;
        Logger.log('    DELETED ' + h.k.resourceName + '.');
        try { log_({ email: 'system' }, 'contactDelete', '', h.k.resourceName, fix.wrong); } catch (e) {}
      } catch (e) { Logger.log('    could not delete: ' + e.message); }
      return;
    }
    try {
      peopleSvc_().People.updateContact(
        { names: [{ givenName: nb[0], familyName: nb.slice(1).join(' ') }], etag: h.c.etag },
        h.k.resourceName, { updatePersonFields: 'names' });
      PEOPLE_CACHE_ = null;
      Logger.log('    RENAMED to "' + right + '". Nothing else on the contact was touched.');
      try { log_({ email: 'system' }, 'contactRename', '', h.k.resourceName, fix.wrong + ' -> ' + right); } catch (e) {}
    } catch (e) {
      Logger.log('    could not rename: ' + e.message);
    }
  });
  Logger.log(apply ? 'Done. Check Gmail: a message from either address should show the right name now.'
                   : 'Nothing was changed. contactsFixApply() makes the renames.');
}

/* ============================================================================================
 * v58 - CORRECT A JOB'S DETAILS  (action: "requestUpdate")
 *
 * The app has had a "✏️ Correct details" button since v47 and it has never worked: it calls
 * requestUpdate, and requestUpdate was never written. Tapping it got "Unknown action:
 * requestUpdate" - the same shape of fault as contactAdd, an app calling something nobody built.
 *
 * It corrects WHO and WHAT, never WHEN: the date, the time and the hours belong to "Move it",
 * which has to re-check the slot and re-ask the customer. This writes the Requests row, re-titles
 * the calendar event, and carries the contact details through to the PO Log row.
 *
 * The calendar DESCRIPTION is deliberately left alone. It carries the customer's own words, their
 * photo links and anything Paul typed onto the event himself; rebuilding it from the row would
 * quietly throw all of that away to fix a phone number.
 * ==========================================================================================*/
function requestUpdate_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var sh = loc.sheet, row = loc.row, v = loc.values;

  // col -> [name, new value]. A field the caller leaves out keeps what it had.
  var keep = function (sent, had) { return String(sent == null ? had : sent).trim(); };
  var want = {
    5:  ['customer',  keep(p.customer,  v[4])],
    6:  ['phone',     keep(p.phone,     v[5])],
    7:  ['email',     keep(p.email,     v[6]).toLowerCase()],
    8:  ['address',   keep(p.address,   v[7])],
    9:  ['scope',     keep(p.scope,     v[8])],
    11: ['materials', keep(p.materials, v[10])],
    23: ['company',   keep(p.company,   v[22])]
  };
  if (!want[5][1]) throw new Error('The customer needs a name.');
  if (/^[A-Z]{1,2}-?\s?\d{5,}$/i.test(want[5][1]))
    throw new Error('"' + want[5][1] + '" is a job number, not a customer name.');

  var changed = [];
  // v60 - the numbers Paul quoted. Col 10 is the AI's original guess and col 29 is what he
  // booked it at; both are editable here because a quote corrected on the phone has to land
  // somewhere. Changing them never moves the calendar - that is what "Move it" is for.
  var nums = { 10: ['hours', p.hours], 12: ['priceLow', p.priceLow],
               13: ['priceHigh', p.priceHigh], 29: ['bookedHours', p.bookedHours] };
  Object.keys(nums).forEach(function (col) {
    var c = Number(col), sent = nums[col][1];
    if (sent == null || sent === '') return;
    var nv = Number(sent); if (isNaN(nv) || nv < 0) return;
    if (Number(v[c - 1] || 0) === nv) return;
    sh.getRange(row, c).setValue(nv);
    changed.push(nums[col][0]); v[c - 1] = nv;
  });
  Object.keys(want).forEach(function (col) {
    var c = Number(col), idx = c - 1, nv = want[col][1];
    if (String(v[idx] == null ? '' : v[idx]).trim() === nv) return;
    sh.getRange(row, c).setValue(txt_(nv));
    changed.push(want[col][0]);
    v[idx] = nv;
  });
  reqMapsDrop_();                                   // v53 cache: this row just moved

  var notes = [];

  // The calendar event: its title and where to drive to. Never its description.
  var evId = String(v[18] || '');
  if (evId && String(v[14]) === 'scheduled') {
    try {
      var ev = visitCal_().getEventById(evId);
      if (!ev) notes.push('calendar event not found');
      else {
        var type = String(v[3] || 'APPOINTMENT').toUpperCase();
        var title = reqEvTitle_(v, type === 'APPOINTMENT' ? String(v[23] || '') : '');   // v89
        if (ev.getTitle() !== title) { ev.setTitle(title); notes.push('calendar title updated'); }
        if (String(ev.getLocation() || '') !== String(v[7] || '')) {
          ev.setLocation(String(v[7] || '')); notes.push('calendar location updated');
        }
      }
    } catch (e) { notes.push('calendar NOT updated: ' + e.message); }
  }

  // The PO Log row, for a job that has a number. Contact details only - never the dates,
  // never the status, and never the PO number itself.
  var po = String(v[23] || '').trim();
  if (po && changed.length) {
    try {
      var fields = {};
      if (changed.indexOf('customer') >= 0) fields['Contact person'] = v[4];
      if (changed.indexOf('company') >= 0) fields['Company Name'] = v[22];
      if (changed.indexOf('phone') >= 0) fields['Phone Number'] = v[5];
      if (changed.indexOf('email') >= 0) fields['Email Address'] = v[6];
      if (changed.indexOf('address') >= 0) fields['Job Address'] = v[7];
      if (changed.indexOf('scope') >= 0) fields['Description of Work'] = v[8];
      if (Object.keys(fields).length) {
        var r = poLogUpdate_({ role: 'admin', email: user.email }, { po: po, fields: fields });
        notes.push('PO Log ' + po + ': ' + (r.changed.length ? r.changed.length + ' field(s)' : 'no change'));
      }
    } catch (e) { notes.push('PO Log ' + po + ' NOT updated: ' + e.message); }
  } else if (String(v[3]).toUpperCase() === 'ESTIMATE' && changed.length) {
    notes.push('Estimate tab not updated - it keeps what was quoted');
  }

  log_(user, 'requestUpdate', v[4], po, (changed.length ? changed.join(', ') : 'no change') +
       (notes.length ? ' · ' + notes.join(' · ') : ''));
  return { id: String(p.id), changed: changed, note: notes.join(' · '),
           customer: v[4], company: v[22], phone: v[5], email: v[6], address: v[7],
           scope: v[8], materials: v[10], hours: Number(v[9]) || 0,
           priceLow: Number(v[11]) || 0, priceHigh: Number(v[12]) || 0,
           bookedHours: Number(v[28]) || 0 };
}

/* ============================================================================================
 * v60 - CHANGE WHAT A REQUEST IS  (action: "requestSetType")
 *
 * The website form is a poor guide to what a customer actually wants - "Book an Appointment" is
 * the form's name, not their choice - so a lead often sits under the wrong label. Relabelling is
 * safe only while nothing has been spent on it, and this refuses the two cases where it is not:
 *
 *   APPOINTMENT -> ESTIMATE with a PO already issued. The job number IS the QuickBooks invoice
 *   number. It cannot be handed back, so the honest route is to cancel the job, which retires
 *   that number and frees the calendar, rather than quietly relabelling a job that has one.
 *
 *   ESTIMATE -> APPOINTMENT on a scheduled call. That is a real conversion: it has to burn the
 *   next PO number and write the PO Log row, which is what requestBook_ does. Flipping the label
 *   alone would leave a booked job with no number and nothing to invoice against.
 * ==========================================================================================*/
function requestSetType_(user, p) {
  requirePerm_(user, 'approveHours');
  var loc = reqRow_(p.id); if (!loc) throw new Error('Request not found.');
  var v = loc.values;
  var want = String(p.type || '').toUpperCase();
  if (want !== 'APPOINTMENT' && want !== 'ESTIMATE')
    throw new Error('Type must be APPOINTMENT or ESTIMATE.');
  var now = String(v[3] || '').toUpperCase();
  var po = String(v[23] || '').trim();
  if (now === want) return { id: String(p.id), type: want, changed: false, note: 'already ' + want };

  if (want === 'ESTIMATE' && po)
    throw new Error('This job already has its number (' + po + '), and a job number becomes the ' +
      'QuickBooks invoice number - it cannot be handed back. If it should not go ahead, cancel ' +
      'the job instead: that frees the calendar and marks ' + po + ' Cancelled, and the number is ' +
      'retired rather than reused.');

  if (want === 'APPOINTMENT' && String(v[14]) === 'scheduled' && !po)
    throw new Error('Use "They said yes - book the job" on this one. That burns the next PO ' +
      'number and writes its PO Log row; changing the label on its own would leave a booked job ' +
      'with no number and nothing to invoice against.');

  loc.sheet.getRange(loc.row, 4).setValue(want);
  reqMapsDrop_();
  var note = '';
  if (String(v[18] || '') && String(v[14]) === 'scheduled') {
    try {
      var ev = visitCal_().getEventById(String(v[18]));
      if (ev) {
        ev.setTitle(reqEvTitle_(v, want === 'APPOINTMENT' ? String(v[23] || '') : ''));   // v89
        note = 'calendar title updated';
      }
    } catch (e) { note = 'calendar NOT updated: ' + e.message; }
  }
  log_(user, 'requestSetType', v[4], po, now + ' -> ' + want + (note ? (' · ' + note) : ''));
  return { id: String(p.id), type: want, changed: true, note: note };
}

/* ============================================================================================
 * v59 - A CALENDAR EVENT IS A JOB, WHATEVER BOOKED IT
 *
 * v57 taught the Schedule tab to find the job behind a booking by matching the calendar event id
 * against the Requests tab. That works for anything booked from a website lead and fails for
 * everything else - and the most common "everything else" is a RETURN VISIT, which visitBook_
 * creates as a calendar event with no Requests row at all. So the jobs Paul most often wants to
 * move (the ones he booked standing in a customer's kitchen) were the ones he could not touch.
 *
 * eventInfo_ answers "what is this booking" for ANY event:
 *   kind 'request' - a Requests row owns this exact event. Full Move / Cancel / Correct, as v57.
 *   kind 'visit'   - a return visit. No row of its own, but its PO leads to the original lead,
 *                    so the customer, the phone number and the ORIGINAL ENQUIRY all come back,
 *                    and it can be moved or called off on its own.
 *   kind 'other'   - something typed straight into Google Calendar. Shown, not edited.
 *
 * The distinction matters for money. Cancelling a BOOKED JOB marks its PO Log row Cancelled.
 * Cancelling a RETURN VISIT must not: the first visit happened, the hours are real and the job
 * still gets invoiced under the same number. It only means nobody is driving out on the 13th.
 * For the same reason moving a return visit leaves the PO Log start date alone - that date is
 * when the job started, not when the last visit happens to be.
 * ==========================================================================================*/

/* v61 - ONE READ OF THE REQUESTS TAB, SHARED.
 * eventInfo_ was reading that tab twice on every tap - once narrow for the event id, once in
 * full for the PO - on top of opening the calendar, and on a cold Apps Script start the whole
 * call could pass the app's 30-second timeout and come back as "No answer from the server".
 * The tab is now read once per execution and every lookup walks the same copy in memory.
 * reqMapsDrop_ clears it whenever the tab is written, so nothing reads a stale row. */
var REQ_SCAN_ = null;
function reqScan_() {
  if (REQ_SCAN_) return REQ_SCAN_;
  var sh = reqSheet_(), last = sh.getLastRow();
  REQ_SCAN_ = { sheet: sh, rows: (last < 2) ? [] : sh.getRange(2, 1, last - 1, REQ_HEADERS.length).getValues() };
  return REQ_SCAN_;
}

/* The Requests row carrying this PO, or null. */
function reqRowByPo_(po) {
  var key = poKey_(po); if (!key) return null;
  var t = reqScan_();
  for (var i = 0; i < t.rows.length; i++) {
    if (poKey_(t.rows[i][23]) === key) return { sheet: t.sheet, row: i + 2, values: t.rows[i] };
  }
  return null;
}

/* action: "eventInfo"  payload: { eventId }   Read-only. */
function eventInfo_(user, p) {
  requirePerm_(user, 'approveHours');
  var id = String(p && p.eventId || ''); if (!id) throw new Error('No event given.');
  var ev = null;
  try { ev = visitCal_().getEventById(id); } catch (e) {}
  if (!ev) throw new Error('That booking is not on the calendar any more.');

  var title = ev.getTitle() || '', desc = '';
  try { desc = ev.getDescription() || ''; } catch (e) {}
  var out = {
    eventId: id, title: title, location: ev.getLocation() || '', desc: desc,
    start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
    allDay: !!ev.isAllDayEvent(),
    hours: Math.round(((ev.getEndTime() - ev.getStartTime()) / 3600000) * 100) / 100,
    po: bumpPoOf_(title, desc), isJob: bumpIsJob_(title, desc),
    kind: 'other', requestId: '', jobRequestId: '', type: '',
    customer: '', phone: '', email: '', address: '', company: '', materials: '',
    scope: '', detail: '', entryNo: '', confirm: '', estHours: 0, priceLow: 0, priceHigh: 0
  };

  // Does a Requests row own this very event?
  var own = reqRowByEvent_(id);
  var row = own;
  if (own) out.kind = 'request';
  else if (out.po) {
    // A return visit: no row of its own, but the PO leads to the lead it continues.
    row = reqRowByPo_(out.po);
    if (row) out.kind = 'visit';
  }
  if (row) {
    var v = row.values;
    // requestId is set ONLY when the row owns this very event, because it is what Move and
    // Cancel act on - a return visit must never move the booking it continues.
    if (out.kind === 'request') out.requestId = String(v[0] || '');
    // jobRequestId is the JOB's row either way. Correcting a customer's phone number is a fact
    // about the job, not about one trip to it, so a return visit edits the same row.
    out.jobRequestId = String(v[0] || '');
    out.type = String(v[3] || '').toUpperCase();
    out.entryNo = String(v[2] || '');
    out.customer = String(v[4] || ''); out.phone = String(v[5] || '');
    out.email = String(v[6] || ''); out.address = String(v[7] || '');
    out.scope = String(v[8] || ''); out.detail = String(v[21] || '');
    out.company = String(v[22] || ''); out.materials = String(v[10] || '');
    out.confirm = String(v[25] || '');
    out.estHours = Number(v[28]) || Number(v[9]) || 0;
    out.priceLow = Number(v[11]) || 0; out.priceHigh = Number(v[12]) || 0;
    if (!out.po) out.po = String(v[23] || '');
  }
  // v83 - whatever is STILL blank, the job's own PO Log row usually knows: the email, the phone,
  // the address and the scope somebody typed straight into the sheet. It used to be consulted
  // only when even the customer's NAME was missing, so a booking with a name and nothing else -
  // R26195 Paddy, 2 Nov - showed an empty card beside a full row. Gaps only, never an overwrite.
  poFill_(out);
  return out;
}

/* Tell the customer their return visit moved. Never throws. */
function visitMoveEmail_(to, customer, start, hours, job, message) {
  if (!to) return 'no customer email on file - not notified';
  try {
    var first = String(customer || '').trim().split(' ')[0];
    var intro = String(message || '').trim() ||
      'We have moved the return visit to finish your job. Nothing else changes.';
    var lines = [job || '', 'About ' + hours + ' hour' + (hours === 1 ? '' : 's') + ' on site'];
    MailApp.sendEmail({
      to: to, subject: 'Your PRO Electrical return visit has moved - ' + whenText_(start),
      body: 'Hi ' + first + ',\n\n' + intro + '\n\n  ' + whenText_(start) + '\n' +
            lines.filter(String).map(function (t) { return '  ' + t + '\n'; }).join('') +
            '\nIf that does not suit, just reply to this email and we will move it again.\n\n' +
            '- PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca  ·  780-625-5880',
      htmlBody: custEmailHtml_({
        heading: (first ? ('Hi ' + first + ',') : 'Hello,'), intro: intro,
        when: whenText_(start), lines: lines,
        footNote: 'If that does not suit, just reply to this email and we will move it again.' }),
      name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0] });
    return 'customer emailed at ' + to;
  } catch (e) { return 'customer email failed: ' + e.message; }
}

/* action: "eventMove"  payload: { eventId, start, hours, notifyCustomer, bump }
 * Moves a booking that has no Requests row of its own - a return visit, or anything else on the
 * calendar. The PO Log start date is NOT touched: that is when the job started. */
function eventMove_(user, p) {
  requirePerm_(user, 'approveHours');
  var info = eventInfo_(user, { eventId: p.eventId });
  if (info.kind === 'request') throw new Error('That one has a request behind it - move it with requestReschedule so the PO Log and the customer confirmation stay in step.');
  var start = new Date(p.start);
  if (isNaN(start)) throw new Error('Pick a date and time.');
  var hours = Math.max(0.25, Math.min(12, Number(p.hours) || info.hours || 2));
  var end = new Date(start.getTime() + hours * 3600000);
  var slotNote = slotGuard_(user, 'APPOINTMENT', start, end, info.eventId,
    { bump: !!p.bump, allowPast: !!p.allowPast });

  var ev = visitCal_().getEventById(info.eventId);
  if (!ev) throw new Error('That booking is not on the calendar any more.');
  var was = ev.getStartTime().toISOString();
  ev.setTime(start, end);

  var bumped = [], bumpProblems = [];
  if (p.bump) {
    var br = bumpToRequests_(user, start, end, info.eventId, info.title);
    bumped = br.sent; bumpProblems = br.problems;
    if (bumped.length) bumpBackEmail_(bumped, info.title, start.toISOString());
  }
  var note = (p.notifyCustomer === false) ? 'customer not emailed (you asked)'
    : visitMoveEmail_(info.email || visitCustomerEmail_(info.po), info.customer, start, hours, info.scope);
  log_(user, 'eventMove', info.customer || info.title, info.po,
       whenText_(was) + ' -> ' + whenText_(start) + ' · ' + note);
  return { eventId: info.eventId, start: start.toISOString(), end: end.toISOString(),
           was: was, note: note, slotNote: slotNote, bumped: bumped, bumpProblems: bumpProblems };
}

/* ============================================================================================
 * v92 - THE BLOCK CALENDAR (Paul, 7 Nov): "drag and drop jobs as they come to a different date"
 *
 * scheduleMove moves ONE booking to the time it was dropped on, keeps its length, and does
 * nothing else on its own: no slot check (two jobs can run at once - Paul: "two jobs can go at
 * once"), no bump, and NO EMAIL - telling the customer is a separate tap in the app. A moved
 * booking is "not confirmed yet": its event turns amber and, when a Requests row is behind it,
 * that row's Confirm column says waiting, its booked times follow and so does the PO Log start
 * date. An undo sends the old time back with the old state in p.confirm.
 *
 * scheduleConfirm is Paul saying what the customer said - on the phone, by text, in person:
 * confirmed (green), waiting (amber) or declined, i.e. needs a new time (red). The same colours
 * and the same Confirm column the customer's own Yes / Reschedule buttons write.
 * ==========================================================================================*/
function schedConfirmFromColour_(c) {
  c = String(c || '');
  if (c === '10' || c === String(CalendarApp.EventColor.GREEN)) return 'confirmed';
  if (c === '11' || c === String(CalendarApp.EventColor.RED)) return 'declined';
  if (c === '8' || c === String(CalendarApp.EventColor.GRAY)) return 'cancelled';
  if (c === '6' || c === String(CalendarApp.EventColor.ORANGE)) return 'waiting';
  return 'none';   // v94 - the calendar default: booked, nobody was asked to confirm
}
function reqRowByEvent_(eventId) {
  var t = reqScan_();
  for (var i = 0; i < t.rows.length; i++)
    if (String(t.rows[i][18]) === String(eventId) && String(t.rows[i][14]) === 'scheduled')
      return { sheet: t.sheet, row: i + 2, values: t.rows[i] };
  return null;
}
function scheduleMove_(user, p) {
  requirePerm_(user, 'approveHours');
  if (!p.eventId) throw new Error('No booking given.');
  var start = new Date(p.start);
  if (isNaN(start)) throw new Error('No new time given.');
  var ev = visitCal_().getEventById(String(p.eventId));
  if (!ev) throw new Error('That booking is not on the calendar any more.');
  if (ev.isAllDayEvent()) throw new Error('An all-day booking cannot be dragged to a time. Open it to change it.');
  if (ev.isRecurringEvent()) throw new Error('That is a repeating event - every one of them shares the same id, so it has to be moved in Google Calendar.');
  var was = ev.getStartTime(), dur = ev.getEndTime().getTime() - was.getTime();
  var end = new Date(start.getTime() + dur);
  var state = ['confirmed', 'waiting', 'declined'].indexOf(String(p.confirm || '')) >= 0 ? String(p.confirm) : 'waiting';
  ev.setTime(start, end);
  try { ev.setColor(confirmColour_(state)); } catch (e) {}
  var poNote = '', who = ev.getTitle(), po = '';
  var loc = reqRowByEvent_(p.eventId);
  if (loc) {
    var v = loc.values;
    loc.sheet.getRange(loc.row, 16, 1, 2).setValues([[start.toISOString(), end.toISOString()]]);
    loc.sheet.getRange(loc.row, 20, 1, 2).setValues([[user.email, new Date().toISOString()]]);
    loc.sheet.getRange(loc.row, CONFIRM_COL_).setValue(state);
    // v94 - the Yes / Reschedule / Cancel links in the email the customer already has were about
    // the OLD time. Left live, a Yes tapped tomorrow would turn the NEW time green though they never
    // saw it. The token goes; the old links now answer "that link is no longer valid, give us a
    // call", and Email them the time mints a fresh one.
    if (String(v[CONFIRM_TOKEN_COL_ - 1] || '').trim()) loc.sheet.getRange(loc.row, CONFIRM_TOKEN_COL_).setValue('');
    po = String(v[23] || '').trim();
    try { if (po) poNote = poLogSetStart_(po, start); } catch (e) { poNote = 'PO Log date not updated: ' + e.message; }
    try { reqMapsDrop_(); } catch (e) {}
    who = v[4] || who;
  }
  log_(user, 'scheduleMove', who, po, whenText_(was) + ' -> ' + whenText_(start) + ' · ' + state +
       ' · customer not emailed' + (poNote ? (' · ' + poNote) : ''));
  return { eventId: String(p.eventId), start: start.toISOString(), end: end.toISOString(),
           was: was.toISOString(), confirm: state, poNote: poNote };
}
function scheduleConfirm_(user, p) {
  requirePerm_(user, 'approveHours');
  var state = String(p.state || '');
  if (['confirmed', 'waiting', 'declined'].indexOf(state) < 0) throw new Error('Unknown status.');
  var ev = visitCal_().getEventById(String(p.eventId || ''));
  if (!ev) throw new Error('That booking is not on the calendar any more.');
  if (ev.isRecurringEvent()) throw new Error('That is a repeating event - change it in Google Calendar.');
  ev.setColor(confirmColour_(state));
  var loc = reqRowByEvent_(p.eventId);
  if (loc) { loc.sheet.getRange(loc.row, CONFIRM_COL_).setValue(state); try { reqMapsDrop_(); } catch (e) {} }
  log_(user, 'scheduleConfirm', loc ? loc.values[4] : ev.getTitle(), loc ? String(loc.values[23] || '') : '',
       state + ' (set in the app)');
  return { eventId: String(p.eventId), confirm: state };
}

/* v93 - THE YEAR AT A GLANCE (Paul, 7 Nov). One read of the calendar for a whole year, folded
 * into booked hours and bookings per day, so the app can shade twelve small months without
 * asking for them two months at a time (scheduleList caps a request at 62 days). All-day events
 * are left out - they are holidays and time off, not work. Crew count only what they are on. */
function scheduleYear_(user, p) {
  var nowY = new Date().getFullYear(), y = Number(p && p.year) || nowY;
  if (y < nowY - 2 || y > nowY + 1) throw new Error('The year view goes from ' + (nowY - 2) + ' to ' + (nowY + 1) + '.');
  var start = new Date(y, 0, 1), end = new Date(y + 1, 0, 1);
  var events = visitCal_().getEvents(start, end);
  var asg = schedAssignments_();
  var seesAll = user.role === 'admin' || (user.permissions && user.permissions.viewAllEmployees);
  var hours = {}, jobs = {};
  events.forEach(function (ev) {
    if (ev.isAllDayEvent()) return;
    if (!seesAll) {
      var em = (asg[String(ev.getId())] && asg[String(ev.getId())].emails) || [];
      if (em.indexOf(lc_(user.email)) === -1) return;
    }
    var s = ev.getStartTime(), e = ev.getEndTime(), k = fmtDate_(s);
    hours[k] = Math.round(((hours[k] || 0) + Math.max(0, (e - s) / 3600000)) * 100) / 100;
    jobs[k] = (jobs[k] || 0) + 1;
  });
  return { year: y, hours: hours, jobs: jobs, holidays: abHolidays_(start, end), canAssign: user.role === 'admin' };
}

/* v95 - ANOTHER DAY ON THE SAME JOB (Paul, 7 Nov): "if we were there that day and need more days
 * to finish it, I should be able to add more without moving the original one."
 * scheduleAddDay copies ONE booking onto another day: same name with (cont'd), same address,
 * same notes, same crew, same length unless told otherwise. The original does not move. No slot
 * check (two jobs can run at once), no email to anyone - telling the customer is the same
 * deliberate tap as after a move. The new day has the calendar's default colour, so the app shows
 * it blue, Booked. It is an ordinary return visit afterwards: the PO in its title ties its hours
 * and parts to the same job and invoice, and the app moves or calls it off on its own. */
function scheduleAddDay_(user, p) {
  requirePerm_(user, 'approveHours');
  var cal = visitCal_();
  var src = cal.getEventById(String((p && p.eventId) || ''));
  if (!src) throw new Error('That booking is not on the calendar any more.');
  if (src.isAllDayEvent()) throw new Error('An all-day booking cannot be continued from here.');
  if (src.isRecurringEvent()) throw new Error('That is a repeating event - add days in Google Calendar.');
  var start = new Date(p.start);
  if (isNaN(start)) throw new Error('Pick a day and a start time.');
  var hours = Number(p.hours) || ((src.getEndTime() - src.getStartTime()) / 3600000);
  hours = Math.max(0.5, Math.min(12, hours));
  var end = new Date(start.getTime() + hours * 3600000);
  var base = String(src.getTitle() || 'Job').trim();
  var title = /\(cont'd\)\s*$/i.test(base) ? base : base + " (cont'd)";
  var desc = '';
  try { desc = String(src.getDescription() || ''); } catch (e) {}
  var carried = desc.replace(/^[\s\S]*?={6,}\s*FROM THE ORIGINAL BOOKING\s*={6,}\s*/i, '').trim();
  var po = '';
  try { po = bumpPoOf_(base, desc) || ''; } catch (e) {}
  var header = [
    'RETURN VISIT - another day on the same job, added from the Schedule tab.',
    po ? ('PO: ' + po) : '',
    'Booked for ' + hours + ' hr' + (hours === 1 ? '' : 's') + ', continuing ' + fmtDate_(src.getStartTime()) + '. The first day stays where it is.',
    'Added by ' + String(user.email).split('@')[0] + ' on ' + fmtDate_(new Date()) + '.'
  ].filter(String).join('\n');
  var body = header + (carried ? ('\n\n' + Array(61).join('=') + '\nFROM THE ORIGINAL BOOKING\n' + Array(61).join('=') + '\n' + carried) : '');
  var ev = cal.createEvent(title, start, end, { description: body, location: String(src.getLocation() || '') });
  var evId = String(ev.getId());
  // Same crew as the day it continues, written without emailing them again.
  var asg = schedAssignments_(), names = employeeNameMap_();
  var crew = (asg[String(src.getId())] && asg[String(src.getId())].emails) || [];
  if (crew.length) {
    try { schedSheet_().appendRow([evId, JSON.stringify(crew), user.email, new Date().toISOString()]); } catch (e) {}
  }
  log_(user, 'scheduleAddDay', base, po, whenText_(start) + ' · ' + hours + ' h · continues ' + whenText_(src.getStartTime()));
  return { eventId: evId, title: title, start: start.toISOString(), end: end.toISOString(), allDay: false,
           location: String(src.getLocation() || ''), desc: body, confirm: 'none', recurring: false,
           assigned: crew.map(function (e) { return { email: e, name: names[e] || e.split('@')[0] }; }) };
}

/* v96 - NOBODY WAITS ON THE OFFICE (Paul, 7 Nov: "whatever it takes to keep anyone waiting for
 * more than .7 seconds").
 * eventInfoMany - the job details for many bookings in ONE call, so the app can fetch the month's
 * jobs in the background and open a job's details from the phone at the tap instead of asking the
 * office then. Same answer, booking by booking, as eventInfo; a booking that fails is left out.
 * keepWarm - a five-minute timer during working hours. An Apps Script project that has not run
 * for a while takes 10-20 s to answer its first call; one that runs every few minutes does not.
 * It does nothing but run. It installs itself the first time the app opens, like the Today timer. */
function eventInfoMany_(user, p) {
  requirePerm_(user, 'approveHours');
  var ids = ((p && p.ids) || []).map(String).filter(Boolean).slice(0, 60), out = {};
  for (var i = 0; i < ids.length; i++) {
    try { out[ids[i]] = eventInfo_(user, { eventId: ids[i] }); } catch (e) {}
  }
  return { infos: out };
}
function keepWarm() {
  var h = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Edmonton', 'H'));
  if (h < 6 || h >= 20) return;   // 6 am to 8 pm; overnight the first tap can take its time
  try { CacheService.getScriptCache().put('warm', String(Date.now()), 600); } catch (e) {}
}
function warmEnsureTrigger_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); if (cache.get('warm_trig')) return; } catch (e) {}
  try {
    withLock_(function () {
      var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'keepWarm'; });
      if (!has) {
        ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();
        log_({ email: 'system' }, 'warmTimer', 'keepWarm', '', '5-minute keep-awake timer installed');
      }
    });
    if (cache) cache.put('warm_trig', '1', 21600);
  } catch (e) {}
}

/* action: "leadEmail"  payload: { id } or { detail }
 *
 * WHAT THE CUSTOMER ACTUALLY WROTE. The Requests row stores the ball-park block - a tidy
 * CUSTOMER / SCOPE / ESTIMATE summary written by Claude from the form - and not one word of the
 * customer's own. Their phrasing matters: "the breaker keeps going" and "replace the panel" get
 * written up the same way and mean very different jobs.
 *
 * The block does carry a link back to the form email, so the original can be fetched on demand.
 * That works for every lead already on file, not just the ones filed from today on.
 * Read-only, and it never throws on a missing email - a lead with no link is normal for anything
 * Paul typed in himself. */
function leadEmail_(user, p) {
  requirePerm_(user, 'approveHours');
  var detail = String((p && p.detail) || '');
  if (!detail && p && p.id) {
    var loc = reqRow_(String(p.id));
    if (loc) detail = String(loc.values[21] || '');
  }
  if (!detail) return { found: false, why: 'Nothing on file for this one.' };
  var m = /mail\.google\.com\/mail\/[^\s"'<>]*?([0-9a-f]{12,24})/i.exec(detail);
  if (!m) return { found: false, why: 'This lead has no link back to an email - it was probably added by hand.' };
  var mid = m[1], msg = null;
  try { msg = GmailApp.getMessageById(mid); } catch (e) {}
  if (!msg) { try { var th = GmailApp.getThreadById(mid); if (th) { var ms = th.getMessages(); msg = ms && ms[0]; } } catch (e) {} }
  if (!msg) return { found: false, why: 'The original email could not be opened. It may have been deleted.', id: mid };
  var body = '';
  try { body = String(msg.getPlainBody() || ''); } catch (e) {}
  var atts = [];
  try {
    msg.getAttachments({ includeInlineImages: false }).forEach(function (a) {
      atts.push({ name: a.getName(), size: a.getSize() });
    });
  } catch (e) {}
  return { found: true, id: mid, subject: String(msg.getSubject() || ''),
           from: String(msg.getFrom() || ''), date: msg.getDate().toISOString(),
           body: body.substring(0, 20000), attachments: atts,
           link: 'https://mail.google.com/mail/#all/' + mid };
}

/* action: "eventTell"  payload: { eventId, how: 'called' | 'email' }
 *
 * Paul has just changed something and wants the customer to know. The phone does the ringing -
 * this only records that it happened - and the email it sends is the right one for the kind of
 * booking: a booked job gets the proper confirmation with its Yes / No buttons, so the job goes
 * back to amber until they answer; a return visit gets the plainer "we have moved it" note,
 * which has no buttons because there is nothing for them to confirm.
 *
 * Either way it leaves a mark on the job's row, so "did anyone actually ring them" has an answer
 * three weeks later when nobody remembers. */
function eventTell_(user, p) {
  requirePerm_(user, 'approveHours');
  var how = String(p.how || 'called').toLowerCase() === 'email' ? 'email' : 'called';
  var info = eventInfo_(user, { eventId: p.eventId });
  var note = '';
  if (how === 'email') {
    var to = String(info.email || '').trim() || visitCustomerEmail_(info.po);
    if (!to) throw new Error('No email address on file for ' +
      (info.customer || 'this customer') + ' - ring them instead.');
    var booked = (info.kind === 'request' && info.requestId);

    // v64 - SHOW IT BEFORE IT GOES. Nothing is sent and no confirmation token is spent; this
    // just builds the letter so Paul can read it and change the wording first. The buttons are
    // drawn as labels here because their links are minted fresh at the moment of sending - a
    // token handed out in a preview would be a token the customer could answer with twice.
    if (p.preview) {
      var first = String(info.customer || '').trim().split(' ')[0];
      var hrsP = Math.round((Number(info.hours) || 0) * 10) / 10;
      var suggest = booked
        ? 'We have had to move your appointment. Here is the new time:'
        : 'We have moved the return visit to finish your job. Nothing else changes.';
      var body = [
        'Hi ' + (first || 'there') + ',',
        '',
        '<<your message>>',
        '',
        '  ' + whenText_(info.start),
        hrsP ? ('  About ' + hrsP + ' hour' + (hrsP === 1 ? '' : 's') + ' on site') : '',
        info.address ? ('  ' + info.address) : '',
        info.scope ? ('  ' + info.scope) : '',
        ''
      ].filter(function (x) { return x !== ''; }).join('\n');
      body += booked
        ? '\n\nDoes that time work for you? Just tap one:\n' +
          '   [ Yes, that works ]   [ Reschedule ]   [ Cancel the job ]\n\n' +
          'If you need another time, tap Reschedule and we will call you to sort it out. ' +
          'You can also just reply to this email.'
        : '\n\nIf that does not suit, just reply to this email and we will move it again.';
      body += '\n\n- PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca  ·  780-625-5880';
      return { preview: true, to: to, customer: info.customer,
        subject: booked ? ('Changed: your PRO Electrical appointment — ' + whenText_(info.start))
                        : ('Your PRO Electrical return visit has moved - ' + whenText_(info.start)),
        suggestion: suggest, body: body, kind: booked ? 'booked' : 'visit',
        buttons: booked };
    }

    if (booked) {
      try { note = requestRenotify_(user, { id: info.requestId, message: p.message, mode: 'moved' }).note || 'emailed'; }
      catch (e) { note = 'email failed: ' + e.message; }
    } else {
      note = visitMoveEmail_(to, info.customer, info.start, info.hours, info.scope, p.message);
    }
    if (/failed/i.test(note)) throw new Error(note);
  } else {
    note = 'marked as called';
  }
  try {
    if (info.jobRequestId) {
      var loc = reqRow_(info.jobRequestId);
      if (loc) {
        loc.sheet.getRange(loc.row, REQ_TOLD_)
          .setValue((how === 'email' ? 'emailed ' : 'called ') + fmtDate_(new Date()));
        reqMapsDrop_();
      }
    }
  } catch (e) {}
  log_(user, 'eventTell', info.customer || info.title, info.po, how + ' · ' + note);
  return { ok: true, how: how, note: note, customer: info.customer,
           phone: info.phone, email: info.email || '' };
}

/* action: "eventCancel"  payload: { eventId, reason, notifyCustomer }
 * Calls off a return visit. The PO Log is deliberately left alone - the job is not cancelled,
 * only this trip to it, and the hours already worked still get invoiced under the same number. */
function eventCancel_(user, p) {
  requirePerm_(user, 'approveHours');
  var info = eventInfo_(user, { eventId: p.eventId });
  if (info.kind === 'request') throw new Error('That one has a request behind it - cancel it with requestCancel so the PO Log row is marked Cancelled too.');
  var ev = visitCal_().getEventById(info.eventId);
  if (!ev) throw new Error('That booking is not on the calendar any more.');
  var was = ev.getStartTime().toISOString();
  var reason = String(p.reason || '').trim();
  var note = '';
  var to = info.email || visitCustomerEmail_(info.po);
  if (p.notifyCustomer && to) {
    try {
      var first = String(info.customer || '').trim().split(' ')[0];
      var intro = 'We have had to call off the return visit booked for ' + whenText_(was) + '.' +
                  (reason ? (' ' + reason) : '') +
                  ' Your job is not finished with us - we will be in touch to agree a new time.';
      MailApp.sendEmail({
        to: to, subject: 'Your PRO Electrical return visit on ' + whenText_(was) + ' is cancelled',
        body: 'Hi ' + first + ',\n\n' + intro + '\n\n' +
              '- PRO Electrical Services\n  Peace River, AB  ·  admin@proes.ca  ·  780-625-5880',
        htmlBody: custEmailHtml_({ heading: (first ? ('Hi ' + first + ',') : 'Hello,'),
          intro: intro, lines: [info.scope || ''],
          footNote: 'Reply to this email or give us a call and we will sort out a new time.' }),
        name: 'PRO Electrical Services', replyTo: CONFIG.ADMIN_EMAILS[0] });
      note = 'customer emailed at ' + to;
    } catch (e) { note = 'customer email failed: ' + e.message; }
  } else note = p.notifyCustomer ? 'no customer email on file - not notified' : 'customer not emailed';

  try { ev.deleteEvent(); } catch (e) { throw new Error('Could not remove it from the calendar: ' + e.message); }
  log_(user, 'eventCancel', info.customer || info.title, info.po,
       'return visit ' + whenText_(was) + ' called off' + (reason ? (' · ' + reason) : '') + ' · ' + note);
  return { eventId: info.eventId, was: was, note: note,
           poNote: info.po ? (info.po + ' left as it is - the job is still open') : '' };
}

/* ============================================================================================
 * V91 - THE NOV 7 AUDIT FIXES  (Paul: "fix it all")
 *
 * Run setupFixesV91() ONCE from the editor after deploying. It:
 *   - replaces the supplier sweep's stray hourly trigger with one every 2 hours,
 *   - installs a daily 5 am refresh of the Cost tab on the PO Log, and runs it once now,
 *   - re-reads the Home Hardware invoices the sweep left alone, so they are filed.
 * deleteBrokenContactsV91() is separate: it removes the two contacts that hold a phone number in
 * the email field (Paul said yes, Nov 7). Both go to Google Contacts' trash for 30 days.
 * ==========================================================================================*/

/* ---- Today: an entry somebody needs to correct, or null ----
 * Two shapes, both from the audit:
 *   long - one entry over 16 hours (a forgotten clock-out: 280.57 h on R26167, 122.79 h on R26159)
 *   brk  - a break that was started and never ended, so it was closed by the clock-out. Before v91
 *          the whole rest of the shift counted as break (Paul, C26197: 4.07 h); since v91 it counts
 *          as zero. Either way the real break has to be put in by a person.
 * Editing the entry clears it: the long one stops being long, and the break one is only shown
 * while nobody has edited the entry since it was clocked out. */
function todayFixCheck_(e) {
  var tz = Session.getScriptTimeZone();
  var cin = e.ClockIn ? new Date(e.ClockIn) : null, cout = e.ClockOut ? new Date(e.ClockOut) : null;
  if (!cin || !cout || isNaN(cin) || isNaN(cout)) return null;
  var gross = Number(e['Gross Hours']) || Math.round(((cout - cin) / 3600000) * 100) / 100;
  if (gross > 16) {
    return { why: 'long', gross: gross, hours: Number(e.Hours) || 0,
      short: gross + ' h on one entry',
      text: gross + ' hours on one entry, ' + Utilities.formatDate(cin, tz, 'EEE MMM d, h:mm a') + ' to ' +
            Utilities.formatDate(cout, tz, 'EEE MMM d, h:mm a') + '.',
      suggest: 'Almost certainly a forgotten clock-out. Open the entry and set the time the work really stopped.' };
  }
  var arr = []; try { arr = JSON.parse(e['Breaks JSON'] || '[]') || []; } catch (x) { arr = []; }
  for (var i = 0; i < arr.length; i++) {
    var b = arr[i]; if (!b || !b.s || !b.e) continue;
    var span = (new Date(b.e) - new Date(b.s)) / 3600000;
    var closedByClockOut = b.auto || (sameInstant_(b.e, cout) && span >= 0.25);
    if (!closedByClockOut) continue;
    var edited = e['Last Edited At'] ? new Date(e['Last Edited At']) : null;
    if (edited && !isNaN(edited) && edited - cout > 3600000) continue;   // someone has corrected it since
    var bh = Number(e['Break Hrs']) || 0;
    return { why: 'brk', gross: gross, hours: Number(e.Hours) || 0, breakHrs: bh,
      short: 'break never ended',
      text: 'A break started at ' + Utilities.formatDate(new Date(b.s), tz, 'h:mm a') + ' on ' +
            Utilities.formatDate(cin, tz, 'EEE MMM d') + ' was never ended, so it ran to the clock-out (' +
            (Math.round(span * 100) / 100) + ' h). The entry counts ' + Math.round(bh * 60) + ' min of break and ' +
            (Number(e.Hours) || 0) + ' h worked.',
      suggest: 'Open the entry and put in the break that was really taken.' };
  }
  return null;
}

/* ---- Today: punches the office refused that never landed afterwards (last 7 days) ---- */
function todayRefused_(byEmail, emps, now) {
  var sh = masterSheet_(SHEETS.LOG), last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(2500, last - 1);
  var vals = sh.getRange(last - n + 1, 1, n, 6).getValues();
  var names = {}; emps.forEach(function (e) { names[lc_(e.email)] = e.name; });
  var cutoff = now.getTime() - 7 * 86400000, out = [], seen = {};
  vals.forEach(function (r) {
    var act = String(r[2] || '');
    if (act.indexOf('REFUSED ') !== 0) return;
    var t = new Date(r[0]); if (isNaN(t) || t.getTime() < cutoff) return;
    var who = lc_(r[3] || r[1]), what = act.slice(8), detail = String(r[5] || '');
    var m = /\| at=(\S+)/.exec(detail), at = m ? m[1] : '';
    if (!at) return;
    var key = 'refused:' + who + ':' + at;
    if (seen[key]) return; seen[key] = true;
    var list = byEmail[who] || [];
    var landed = list.some(function (e) {
      if (what === 'clockIn' || what === 'switchJobSite') return e.ClockIn && sameInstant_(e.ClockIn, at);
      if (what === 'clockOut') return (e.ClockOut && sameInstant_(e.ClockOut, at)) ||
        (String(e.EntryID) === String(r[4]) && !!e.ClockOut);
      if (what === 'startBreak' || what === 'endBreak') {
        var arr = []; try { arr = JSON.parse(e['Breaks JSON'] || '[]') || []; } catch (x) {}
        return arr.some(function (b) { return (b.s && sameInstant_(b.s, at)) || (b.e && sameInstant_(b.e, at)); });
      }
      return true;
    });
    if (landed) return;
    var nm = names[who] || who;
    out.push({ kind: 'refused', key: key, email: who, name: nm, action: what, at: at, entryId: String(r[4] || ''),
      error: detail.replace(/\s*\| at=\S+/, '').slice(0, 200), label: nm + ' · ' + what + ' refused' });
  });
  return out;
}

/* ---- The Cost tab on the PO Log, kept current ----
 * Nothing wrote it: payroll was $2,823 behind and the five newest jobs had no row. Each PO Log job
 * now gets a row; columns B-G mirror the PO Log, Material Cost is what the supplier POs filed to the
 * job add up to, Payroll Cost is hours x each person's cost rate (approved + pending, the same
 * figure the Jobs tab shows). Amount Invoiced stays a person's to type; Gross Profit is worked out
 * when it is there. Nothing is ever deleted. */
function costTabRefresh() {
  var t0 = Date.now();
  var sys = { email: 'system', role: 'admin', permissions: defaultPermissions_('admin') };
  try { CacheService.getScriptCache().remove('jobCosts'); } catch (e) {}
  var costs = jobCosts_(sys, { days: 3650 });
  var list = Array.isArray(costs) ? costs : (costs.jobs || costs.list || []);
  var byD = {};
  list.forEach(function (j) {
    var d = String(j.po || '').replace(/\D/g, '');
    if (d.length !== 5) return;
    var b = byD[d] || (byD[d] = { mat: 0, pay: 0 });
    b.mat += Number(j.materials) || 0;
    b.pay += (Number(j.cost) || 0) + (Number(j.pendingCost) || 0);
  });
  var t = poLogOpen_(), pl = t.sh, plast = pl.getLastRow();
  if (plast <= t.headerRow) return 'PO Log is empty';
  var C = function (label, dflt) { return t.cols[label] || dflt; };
  var cPo = C('po number', CONFIG.PO_NUMBER_COL), cCon = C('contact person', CONFIG.PO_CONTACT_COL),
      cCo = C('company name', CONFIG.PO_CUSTOMER_COL), cS = C('start date', CONFIG.PO_STARTDATE_COL),
      cE = C('end date', CONFIG.PO_ENDDATE_COL), cQb = C('po number in quickbooks', CONFIG.PO_QB_COL),
      cTy = C('type', CONFIG.PO_TYPE_COL), cSt = C('status', CONFIG.PO_STATUS_COL);
  var jobsRows = pl.getRange(t.headerRow + 1, 1, plast - t.headerRow, pl.getLastColumn()).getDisplayValues();
  var ss = SpreadsheetApp.openById(CONFIG.PO_SPREADSHEET_ID), cs = ss.getSheetByName('Cost');
  if (!cs) return 'No Cost tab';
  var clast = Math.max(cs.getLastRow(), 7), hdrRow = 0;
  var top = cs.getRange(1, 1, Math.min(20, clast), 1).getValues();
  for (var i = 0; i < top.length; i++) if (lc_(top[i][0]) === 'po number') { hdrRow = i + 1; break; }
  if (!hdrRow) return 'Cost tab: no "PO Number" header';
  var existing = clast > hdrRow ? cs.getRange(hdrRow + 1, 1, clast - hdrRow, 11).getValues() : [];
  var rowOf = {};
  existing.forEach(function (r, k) { var d = String(r[0] || '').replace(/\D/g, ''); if (d.length === 5 && !rowOf[d]) rowOf[d] = hdrRow + 1 + k; });
  var r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
  var updated = 0, added = 0, adds = [];
  jobsRows.forEach(function (r) {
    var po = String(r[cPo - 1] || '').trim(), d = po.replace(/\D/g, '');
    if (d.length !== 5) return;
    var st = lc_(r[cSt - 1]);
    if (st === 'cancelled') return;
    var hasWork = String(r[cCon - 1] || r[cCo - 1] || '').trim();
    if (!hasWork) return;                                       // an unissued reserve number
    var c = byD[d] || { mat: 0, pay: 0 };
    var vals = [po, r[cCon - 1], r[cCo - 1], r[cS - 1], r[cE - 1], r[cQb - 1], cTy ? r[cTy - 1] : '', r2(c.mat) || '', r2(c.pay) || ''];
    var at = rowOf[d];
    if (at) {
      cs.getRange(at, 1, 1, 9).setValues([vals]);
      var inv = existing[at - hdrRow - 1][9];
      cs.getRange(at, 11).setValue(inv !== '' && !isNaN(Number(inv)) ? r2(Number(inv) - (Number(vals[7]) || 0) - (Number(vals[8]) || 0)) : '');
      updated++;
    } else {
      adds.push(vals.concat(['', '']));
    }
  });
  if (adds.length) {
    var firstFree = hdrRow + 1;
    var colA = cs.getRange(hdrRow + 1, 1, Math.max(1, cs.getMaxRows() - hdrRow), 1).getValues();
    for (var k = colA.length - 1; k >= 0; k--) if (String(colA[k][0]).trim()) { firstFree = hdrRow + 2 + k; break; }
    cs.getRange(firstFree, 1, adds.length, 11).setValues(adds);
    added = adds.length;
  }
  var msg = 'Cost tab: ' + updated + ' row(s) refreshed, ' + added + ' added (' + (Date.now() - t0) + ' ms)';
  log_(sys, 'costTabRefresh', '', '', msg);
  return msg;
}

/* ---- Re-read the supplier invoices the sweep left alone as "other" (one-off, safe to repeat) ---- */
function refileSkippedSupplierInvoices() {
  var sh = sweepLogTab_(), last = sh.getLastRow();
  if (last < 2) return 'Sweep log is empty';
  var mids = [];
  sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
    var res = String(r[4] || ''), who = String(r[2] || '') + ' ' + String(r[3] || '');
    if (res.indexOf('read as "other"') < 0) return;
    if (!/home ?hardware|hhbc|sales invoice/i.test(who + ' ' + res)) return;
    if (/statement/i.test(who + ' ' + res)) return;              // statements are rightly left alone
    var mid = String(r[0] || '').replace(/^'/, '').trim();
    if (mid && mids.indexOf(mid) < 0) mids.push(mid);
  });
  if (!mids.length) return 'Nothing to re-read';
  var out = sweepSupplierEmailsRun_({ retryMids: mids, days: 1 });
  log_({ email: 'system' }, 'refileSkippedSupplierInvoices', '', '', mids.length + ' message(s) re-read: ' + String(out).slice(0, 400));
  return out;
}

/* ---- The two broken contacts (phone in the email field, address in the phone field) ----
 * Paul, Nov 7: delete them; the correct 'Eva Marie Wall' and 'Paddy Harrison' already exist.
 * Each is checked before it goes: it must still have no real email address. */
function deleteBrokenContactsV91() {
  var P = peopleSvc_(), out = [];
  ['people/c3812073422219254250', 'people/c48467297412190905'].forEach(function (rn) {
    try {
      var c = P.People.get(rn, { personFields: 'names,emailAddresses,phoneNumbers' });
      var k = contactPack_(c);
      if (k.emails.some(function (e) { return e.indexOf('@') >= 0; })) { out.push(rn + ' (' + k.name + ') kept - it has a real email now'); return; }
      P.People.deleteContact(rn);
      out.push(rn + ' (' + k.name + ') deleted - it held ' + k.emails.join(', ') + ' as an email');
    } catch (e) { out.push(rn + ': ' + e.message); }
  });
  PEOPLE_CACHE_ = null;
  log_({ email: 'admin@proes.ca' }, 'deleteBrokenContactsV91', '', '', out.join(' | '));
  return out.join('\n');
}

/* ---- Run once after deploying v91 ---- */
function setupFixesV91() {
  var out = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'sweepSupplierEmails' || h === 'costTabRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sweepSupplierEmails').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('costTabRefresh').timeBased().everyDays(1).atHour(5).create();
  out.push('Triggers: supplier sweep every 2 hours, Cost tab daily at 5 am');
  try { out.push(costTabRefresh()); } catch (e) { out.push('Cost tab: ' + e.message); }
  try { out.push('Home Hardware re-read: ' + String(refileSkippedSupplierInvoices()).slice(0, 600)); } catch (e) { out.push('Re-read: ' + e.message); }
  try { CacheService.getScriptCache().remove(TODAY_.CACHE_KEY); todayRebuild_(); out.push('Today rebuilt'); } catch (e) { out.push('Today: ' + e.message); }
  var msg = out.join('\n');
  Logger.log(msg);
  log_({ email: 'admin@proes.ca' }, 'setupFixesV91', '', '', msg.slice(0, 900));
  return msg;
}
