/**
 * Tech Bench portal connection.
 * Lets the timecard portal add rows to "Order Sheet" and "Repair Logger" in this spreadsheet,
 * and read the dropdown choices so the portal's forms always match the sheet.
 *
 * SETUP (once):
 *  1. In this spreadsheet: Extensions > Apps Script. Delete what is there and paste this whole file. Save.
 *  2. Project Settings (gear icon) > Script properties > Add script property:
 *       name  PORTAL_TOKEN     value  (a long random password you make up; you will also give it to the portal)
 *  3. Deploy > New deployment > type "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     Click Deploy, approve the permissions, and copy the Web app URL (ends in /exec).
 *  4. Put the URL and the same password in Render's environment settings:
 *       SHEET_WEBAPP_URL = the Web app URL      SHEET_TOKEN = the PORTAL_TOKEN value
 *
 * After you change this code later: Deploy > Manage deployments > edit > New version.
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

// Opening the web app address in a browser just confirms it is running.
function doGet() { return out_({ ok: true, message: 'Tech Bench portal connection is running.' }); }

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
