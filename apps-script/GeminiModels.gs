/**
 * GeminiModels.gs — PCW/PRO Timesheet backend
 *
 * Replaces the hand-maintained CONFIG.GEMINI_MODELS list with a self-healing one.
 * Paste this file into the Apps Script project ONCE. After that it looks after itself:
 * no trigger to set, no list to edit when Google renames or retires a model.
 *
 * How it heals:
 *   - The list of usable models is fetched from Google's own models.list endpoint and cached
 *     in Script Properties for 24 h. A retired name simply stops appearing in that list.
 *   - 404 (this name is gone)   → refetch the list immediately and try again, in the same call.
 *   - 503 / 429 (overloaded)    → short sleep, same model once more, then the next model.
 *   - The model that actually answered is moved to the front for next time.
 *   - Every fetch fails         → falls back to the last list that worked, then to a hardcoded
 *                                 pair, so a Google outage delays a scan instead of killing it.
 *
 * SETUP (once):
 *   1. Paste this file in.
 *   2. Make GM_KEY_() below return your API key the same way the rest of the project does.
 *   3. Where the scan code currently loops over CONFIG.GEMINI_MODELS, call geminiGenerate_(payload).
 *   4. Run gmTest_() once from the editor to confirm it answers.
 */

var GM_PROP_ = 'geminiModelCache';
var GM_TTL_MS_ = 24 * 60 * 60 * 1000;
var GM_LAST_RESORT_ = ['gemini-3.6-flash', 'gemini-flash-latest'];

/** Confirmed from Code.gs: the key lives at CONFIG.GEMINI_API_KEY. */
function GM_KEY_() {
  return CONFIG.GEMINI_API_KEY;
}

function gmCache_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(GM_PROP_) || 'null'); }
  catch (e) { return null; }
}
function gmSave_(models, at) {
  PropertiesService.getScriptProperties()
    .setProperty(GM_PROP_, JSON.stringify({ models: models, at: at || Date.now() }));
}

/** Ask Google what exists right now. Vision-capable Flash text models, newest first. */
function gmDiscover_() {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key='
          + encodeURIComponent(GM_KEY_());
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('models.list HTTP ' + res.getResponseCode());

  var names = (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
    .map(function (m) { return String(m.name || '').replace(/^models\//, ''); })
    // Flash tier only, and not the models that cannot read a photo and hand back text.
    .filter(function (n) {
      return /flash/i.test(n) &&
        !/(tts|live|image|audio|embedding|robotics|translate|transcribe|thinking-exp|gemma)/i.test(n);
    });

  // Reading a receipt is OCR, not reasoning, so the cheap tier goes FIRST: Flash-Lite runs about
  // $0.30/$2.50 per million tokens against $1.50/$7.50 for full Flash, and it does not burn
  // thinking tokens (billed as output) on a parts list. Within a tier, newest and stable first.
  // Set GM_PREFER_CHEAP_ = false to flip back to flagship-first if a scan ever reads badly.
  var GM_PREFER_CHEAP_ = true;
  function score(n) {
    var v = parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]) || 0;
    var lite = /lite/i.test(n) ? 1 : 0;
    var tier = GM_PREFER_CHEAP_ ? lite * 1000 : (1 - lite) * 1000;
    return tier + v * 10 + (/preview|exp/i.test(n) ? 0 : 2);
  }
  names.sort(function (a, b) { return score(b) - score(a); });

  if (!names.length) throw new Error('No Flash model offers generateContent');
  gmSave_(names);
  return names;
}

/** The models to try, refreshed at most once a day, never empty. */
function gmModels_() {
  var c = gmCache_();
  if (c && c.models && c.models.length && (Date.now() - c.at) < GM_TTL_MS_) return c.models;
  try { return gmDiscover_(); }
  catch (e) { return (c && c.models && c.models.length) ? c.models : GM_LAST_RESORT_; }
}

/**
 * Send one generateContent payload. Returns the parsed response, or throws with a message the
 * phone app recognises as transient ("No AI model answered …") so the photo is queued, not lost.
 */
function geminiGenerate_(payload) {
  var models = gmModels_(), refreshed = false, last = '';

  for (var i = 0; i < models.length; i++) {
    var m = models[i];

    for (var attempt = 0; attempt < 2; attempt++) {
      var res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + m
          + ':generateContent?key=' + encodeURIComponent(GM_KEY_()),
        { method: 'post', contentType: 'application/json',
          payload: JSON.stringify(payload), muteHttpExceptions: true });

      var code = res.getResponseCode();

      if (code === 200) {
        if (i > 0) {  // this one worked and the ones before it did not — promote it
          var rest = models.filter(function (x) { return x !== m; });
          gmSave_([m].concat(rest), (gmCache_() || {}).at);
        }
        return JSON.parse(res.getContentText());
      }

      // A refused key affects every model, so this is not something to retry — surface it now,
      // with wording that will not match the phone app's "transient, keep trying" patterns.
      if (code === 401 || code === 403) {
        throw new Error('The AI key was refused (HTTP ' + code + ') - the GEMINI_API_KEY in Code.gs needs replacing.');
      }

      last = 'HTTP ' + code + ' from ' + m;

      if (code === 503 || code === 429) {          // overloaded — same model, one more go
        Utilities.sleep(1500 * (attempt + 1));
        continue;
      }
      if (code === 404 && !refreshed) {            // name retired — ask Google what exists now
        refreshed = true;
        try { models = gmDiscover_(); i = -1; } catch (e) {}
      }
      break;                                       // 400/403/anything else: next model
    }
  }
  throw new Error('No AI model answered (' + last + ').');
}

/** Run once from the editor after pasting. Logs the live list and a one-word answer. */
function gmTest_() {
  Logger.log('Models in play: ' + gmModels_().join(', '));
  var r = geminiGenerate_({ contents: [{ parts: [{ text: 'Reply with the single word: ready' }] }] });
  Logger.log('Answer: ' + JSON.stringify(r.candidates && r.candidates[0].content.parts[0].text));
}

/** Only if a bad list ever gets cached: clears it so the next call refetches. */
function gmReset_() {
  PropertiesService.getScriptProperties().deleteProperty(GM_PROP_);
  Logger.log('Model cache cleared.');
}
/* Public wrappers — the editor's Run menu hides any function whose name ends in "_",
   so these give the two you actually need a visible name. */
function testGeminiModels() {
  return gmTest_();
}

function resetGeminiModelCache() {
  return gmReset_();
}