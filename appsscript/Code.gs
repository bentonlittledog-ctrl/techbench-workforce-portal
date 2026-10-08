/**
 * Tech Bench forms for the master administrative sheet.
 *
 * Opens two forms, served by Google to people signed in with their district account:
 *   .../exec?page=order    adds a line to "Order Sheet"
 *   .../exec?page=repair   adds a line to "Repair Logger"
 * The dropdown choices are read from the sheet's own dropdowns, and every submission is also recorded on a
 * "Portal Log" tab with the signed-in person's email.
 *
 * SETUP (once):
 *  1. In this spreadsheet: Extensions > Apps Script. Delete what is there, paste this whole file, and Save.
 *  2. Deploy > New deployment > type "Web app".
 *       Execute as: Me      Who has access: Anyone within your district (sd5.k12.mt.us)
 *     Click Deploy, approve the permissions, and copy the Web app URL (ends in /exec).
 *  3. In Render's environment settings add:   SHEET_FORM_URL = the Web app URL
 *     The portal's "Order a part" and "Log a repair" menu items then open these forms.
 *
 * After you change this code later: Deploy > Manage deployments > pencil > Version: New version > Deploy.
 *
 * (Optional) doPost below lets the portal itself send rows, but that needs access set to "Anyone", which many
 * districts block. You do not need it for the forms above.
 */

// Tab names and the exact column headings the portal fills in.
var TABS = {
  order: {
    sheet: 'Order Sheet',
    key: 'Manufacturer/Model',
    cols: { model: 'Manufacturer/Model', part: 'Part', qty: 'QTY', notes: 'Notes' }
  },
  repair: {
    sheet: 'Repair Logger',
    key: 'Device Model',
    cols: { model: 'Device Model', serial: 'Serial Number/Asset ID #', parts: 'Necessary', tier: 'Repair Tier', flow: 'Repair Flow', notes: 'Repair Notes' }
  }
};

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var req = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('PORTAL_TOKEN');
    if (!token || req.token !== token) return out_({ ok: false, error: 'Not authorized.' });
    lock.waitLock(20000);
    if (req.action === 'lists') return out_({ ok: true, lists: getLists_() });
    if (req.action === 'order' || req.action === 'repair') return out_(addRow_(TABS[req.action], req.values || {}));
    return out_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// The forms. Opened with ?page=order or ?page=repair
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page === 'repair') ? 'repair' : 'order';
  var embed = !!(e && e.parameter && e.parameter.embed === '1');
  var accent = (e && e.parameter && /^#?[0-9a-fA-F]{6}$/.test(e.parameter.accent || '')) ? '#' + e.parameter.accent.replace('#', '') : '#12843f';
  return HtmlService.createHtmlOutput(pageHtml_(page, embed, accent))
    .setTitle(page === 'repair' ? 'Log a repair' : 'Order a part')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---- Called by the forms (google.script.run) ----
function who_() {
  var e = '';
  try { e = Session.getActiveUser().getEmail(); } catch (x) {}
  return e || 'unknown';
}
function getFormData() {
  var L;
  try { L = getLists_(); } catch (err) { throw new Error('Could not read the sheet lists: ' + (err && err.message ? err.message : err)); }
  ['orderModels', 'orderParts', 'repairModels', 'repairParts', 'tiers', 'flows'].forEach(function (k) { if (!L[k] || !L[k].length) L[k] = []; });
  // If the Repair Logger has no readable model list, use the Order Sheet's so the form is still usable.
  if (!L.repairModels.length) L.repairModels = L.orderModels;
  if (!L.repairParts.length) L.repairParts = L.orderParts;
  return { email: who_(), lists: L };
}
function clean_(s, n) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
function oneOf_(list, v, label) {
  if (!v) throw new Error('Choose ' + label + '.');
  if (list.length && list.indexOf(v) < 0) throw new Error('Choose ' + label + ' from the list.');
  return v;
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function log_(kind, summary, row) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Portal Log');
  if (!sh) { sh = ss.insertSheet('Portal Log'); sh.appendRow(['When', 'Who', 'Form', 'What', 'Row']); }
  sh.appendRow([new Date(), who_(), kind, summary, row]);
}
function submitOrder(v) {
  v = v || {};
  var L = getLists_();
  var model = oneOf_(L.orderModels, clean_(v.model, 120), 'the device model');
  var part = oneOf_(L.orderParts, clean_(v.part, 120), 'the part');
  var qty = /^\d{1,2}$/.test(String(v.qty).trim()) ? parseInt(v.qty, 10) : 0;
  if (!(qty >= 1 && qty <= 99)) throw new Error('Quantity must be a whole number from 1 to 99.');
  var notes = clean_(v.notes, 200);
  var r = withLock_(function () { return addRow_(TABS.order, { model: model, part: part, qty: qty, notes: notes }); });
  log_('order', model + ' | ' + part + ' x' + qty + (notes ? ' | ' + notes : ''), r.row);
  return { ok: true, row: r.row };
}
function submitRepair(v) {
  v = v || {};
  var L = getLists_();
  var model = oneOf_(L.repairModels, clean_(v.model, 120), 'the device model');
  var serial = clean_(v.serial, 40) || 'Unknown';
  var picked = [].concat(v.parts || []).map(function (p) { return clean_(p, 120); }).filter(function (p) { return p; });
  picked.forEach(function (p) { if (L.repairParts.length && L.repairParts.indexOf(p) < 0) throw new Error('"' + p + '" is not in the sheet\'s part list.'); });
  var tier = oneOf_(L.tiers, clean_(v.tier, 40), 'the repair tier');
  var flow = oneOf_(L.flows, clean_(v.flow, 40), 'the repair status');
  var notes = clean_(v.notes, 600);
  var vals = { model: model, serial: serial, parts: picked.join(', '), tier: tier, flow: flow, notes: notes };
  var r = withLock_(function () { return addRow_(TABS.repair, vals); });
  log_('repair', model + ' | ' + serial + ' | ' + (vals.parts || 'no parts') + ' | ' + tier + ' | ' + flow + (notes ? ' | ' + notes : ''), r.row);
  return { ok: true, row: r.row };
}

function pageHtml_(page, embed, accent) {
  var base = '';
  try { base = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  return PAGE_HTML.replace('__PAGE__', page).split('__BASE__').join(base)
    .split('#12843f').join(accent || '#12843f')
    .replace('<body', embed ? '<body class="embed"' : '<body')
    .replace('</style>', '.embed .tabs{display:none}.embed body,body.embed{background:transparent}</style>');
}

var PAGE_HTML = `<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#eef1f6;color:#121a2a}
.wrap{max-width:720px;margin:0 auto;padding:18px 16px 40px}h1{font-size:22px;margin:6px 0 2px}.sub{color:#5d6b82;margin:0 0 16px;font-size:14px}
.tabs{display:flex;gap:8px;margin:0 0 14px}.tabs a{padding:8px 14px;border:1px solid #d9dfe9;border-radius:8px;background:#fff;color:#121a2a;text-decoration:none;font-weight:600;font-size:14px}
.tabs a.on{background:#12843f;border-color:#12843f;color:#fff}
form{background:#fff;border:1px solid #d9dfe9;border-radius:10px;padding:18px}label{display:block;font-size:13px;font-weight:600;color:#5d6b82;margin:14px 0 5px}form>label:first-child{margin-top:0}
select,input[type=text],input[type=number],textarea{width:100%;padding:10px 12px;border:1px solid #d9dfe9;border-radius:6px;font:inherit;background:#fff}
textarea{min-height:90px}.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:2px 12px}.checks label{display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:400;color:#121a2a}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:560px){.two{grid-template-columns:1fr}}
button{margin-top:18px;padding:11px 18px;border:0;border-radius:6px;background:#12843f;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.55;cursor:default}
.msg{padding:10px 14px;border-radius:6px;margin:0 0 14px;border-left:3px solid #12843f;background:#fff}.msg.bad{border-left-color:#c0392b;background:#fde8e6}
</style></head><body><div class="wrap">
<div class="tabs"><a id="t-order" href="__BASE__?page=order" target="_top">Order a part</a><a id="t-repair" href="__BASE__?page=repair" target="_top">Log a repair</a></div>
<h1 id="h"></h1><p class="sub" id="sub">Loading...</p><div id="msg"></div><form id="f" style="display:none"></form>
<script>
var PAGE = '__PAGE__', D = null;
function fail(t) { var m = document.getElementById('msg'); if (m) m.innerHTML = '<div class="msg bad">' + String(t).replace(/</g, '&lt;') + '</div>'; var s = document.getElementById('sub'); if (s) s.textContent = ''; }
window.onerror = function (msg, src, line) { fail('Page error: ' + msg + ' (line ' + line + ')'); };
setTimeout(function () { if (!D) fail('Still loading after 20 seconds. Reload the page; if it keeps happening, tell the person who manages the portal.'); }, 20000);
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function sel(name, list, label) {
  var h = '<label>' + label + '</label>';
  if (!list.length) return h + '<input type="text" name="' + name + '" required>';
  h += '<select name="' + name + '" required><option value="">Choose...</option>';
  list.forEach(function (x) { h += '<option>' + esc(x) + '</option>'; });
  return h + '</select>';
}
function show(t, bad) { el('msg').innerHTML = '<div class="msg' + (bad ? ' bad' : '') + '">' + esc(t) + '</div>'; }
function build() {
  var L = D.lists, f = el('f'), h = '';
  el('t-' + PAGE).className = 'on';
  if (PAGE === 'order') {
    el('h').textContent = 'Order a part';
    el('sub').textContent = 'Adds a line to the Order Sheet. Signed in as ' + D.email + '.';
    h += sel('model', L.orderModels, 'Device model') + sel('part', L.orderParts, 'Part');
    h += '<label>Quantity</label><input type="number" name="qty" min="1" max="99" step="1" value="1" required style="max-width:140px">';
    h += '<label>Notes (why it is needed)</label><input type="text" name="notes" maxlength="200">';
    h += '<button type="submit">Add to Order Sheet</button>';
  } else {
    el('h').textContent = 'Log a repair';
    el('sub').textContent = 'Adds a line to the Repair Logger. Signed in as ' + D.email + '.';
    h += sel('model', L.repairModels, 'Device model');
    h += '<label>Serial number / asset ID (leave blank if unknown)</label><input type="text" name="serial" maxlength="40" autocomplete="off">';
    h += '<label>Parts needed (tick everything that applies, or none)</label><div class="checks">';
    L.repairParts.forEach(function (p) { h += '<label><input type="checkbox" name="parts" value="' + esc(p) + '"> ' + esc(p) + '</label>'; });
    h += '</div><div class="two"><div>' + sel('tier', L.tiers, 'Repair tier') + '</div><div>' + sel('flow', L.flows, 'Status') + '</div></div>';
    h += '<label>Repair notes</label><textarea name="notes" maxlength="600"></textarea><button type="submit">Add to Repair Logger</button>';
  }
  f.innerHTML = h; f.style.display = 'block';
  f.onsubmit = function (ev) {
    ev.preventDefault();
    var b = f.querySelector('button'), v = {};
    b.disabled = true; show('Sending...');
    for (var i = 0; i < f.elements.length; i++) {
      var e = f.elements[i];
      if (!e.name) continue;
      if (e.type === 'checkbox') { if (e.checked) { (v[e.name] = v[e.name] || []).push(e.value); } }
      else v[e.name] = e.value;
    }
    var ok = function (r) { show('Added to the ' + (PAGE === 'order' ? 'Order Sheet' : 'Repair Logger') + ' (row ' + r.row + ').'); f.reset(); if (PAGE === 'order') f.qty.value = 1; b.disabled = false; };
    var bad = function (err) { show(err && err.message ? err.message : String(err), true); b.disabled = false; };
    var run = google.script.run.withSuccessHandler(ok).withFailureHandler(bad);
    if (PAGE === 'order') run.submitOrder(v); else run.submitRepair(v);
  };
}
google.script.run.withSuccessHandler(function (d) { D = d; try { build(); } catch (e) { fail('Could not build the form: ' + e.message); } })
  .withFailureHandler(function (e) { el('sub').textContent = ''; show('Could not load the form: ' + (e && e.message ? e.message : e), true); })
  .getFormData();
</script></div></body></html>
`;

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Finds the heading row (within the first 6 rows) and the column of each wanted heading.
function findHeaders_(sh, wanted) {
  var maxCol = Math.max(sh.getLastColumn(), 1);
  var rows = sh.getRange(1, 1, Math.min(6, sh.getMaxRows()), maxCol).getValues();
  for (var r = 0; r < rows.length; r++) {
    var norm = rows[r].map(function (v) { return String(v).replace(/\s+/g, ' ').trim().toLowerCase(); });
    var cols = {}, all = true;
    for (var k = 0; k < wanted.length; k++) {
      var i = norm.indexOf(wanted[k].toLowerCase());
      if (i < 0) { all = false; break; }
      cols[wanted[k]] = i + 1;
    }
    if (all) return { row: r + 1, cols: cols };
  }
  throw new Error('Could not find these column headings on "' + sh.getName() + '": ' + wanted.join(', '));
}

function addRow_(tab, values) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tab.sheet);
  if (!sh) throw new Error('Tab "' + tab.sheet + '" was not found.');
  var heads = Object.keys(tab.cols).map(function (k) { return tab.cols[k]; });
  var h = findHeaders_(sh, heads);
  // first empty row in the key column, so pre-formatted blank rows (with dropdowns) get used
  var start = h.row + 1;
  var count = Math.max(sh.getMaxRows() - h.row, 1);
  var keyVals = sh.getRange(start, h.cols[tab.key], count, 1).getValues();
  var idx = -1;
  for (var i = 0; i < keyVals.length; i++) { if (String(keyVals[i][0]).trim() === '') { idx = i; break; } }
  if (idx < 0) { sh.insertRowsAfter(sh.getMaxRows(), 1); idx = keyVals.length; }
  var row = start + idx;
  Object.keys(tab.cols).forEach(function (k) {
    if (values[k] === undefined || values[k] === null || values[k] === '') return;
    var cell = sh.getRange(row, h.cols[tab.cols[k]]);
    cell.setValue(values[k]);
  });
  SpreadsheetApp.flush();
  return { ok: true, row: row };
}

// Reads each dropdown's allowed values from the sheet's own data validation.
function listFor_(tab, field) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tab.sheet);
  if (!sh) return [];
  try {
    var h = findHeaders_(sh, [tab.cols[field]]);
    var rule = sh.getRange(h.row + 1, h.cols[tab.cols[field]]).getDataValidation();
    if (!rule) return [];
    var type = rule.getCriteriaType(), v = rule.getCriteriaValues();
    var C = SpreadsheetApp.DataValidationCriteria;
    var list = [];
    if (type === C.VALUE_IN_LIST) list = v[0];
    else if (type === C.VALUE_IN_RANGE) list = v[0].getValues().reduce(function (a, r) { return a.concat(r); }, []);
    return list.map(function (x) { return String(x).trim(); }).filter(function (x) { return x; });
  } catch (err) { return []; }
}

function getLists_() {
  return {
    orderModels: listFor_(TABS.order, 'model'),
    orderParts: listFor_(TABS.order, 'part'),
    repairModels: listFor_(TABS.repair, 'model'),
    repairParts: listFor_(TABS.repair, 'parts'),
    tiers: listFor_(TABS.repair, 'tier'),
    flows: listFor_(TABS.repair, 'flow')
  };
}
