// printing.js - prints a completed timecard on the district's Miscellaneous Payroll Claim Form.
//
//   /timecards/print   preview the form for a date range; the Print button opens the browser's
//                      print window, where "Save as PDF" makes a PDF.
//
// Filled in automatically: printed name, work description, hourly rate, date, hours, amount, totals.
// Left blank for people to complete: claimant signature, address, approved by, date, and the
// Assistant Superintendent budget-code columns.
const { manageableAccounts } = require('./scope');

// Short names used in the "Work-Describe" column. Anything not listed prints as stored.
const SITE_SHORT = {
    'Glacier High School': 'GHS',
    'Flathead High School': 'FHS',
    'Linderman Education Center': 'Linderman'
};
const PROGRAM_SHORT = {
    'Student Tech Work Bench': 'Student Tech Bench'
};

const ROWS_PER_SHEET = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => '$' + n.toFixed(2);
const fmtDate = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return m + '/' + d + '/' + y; };
const msBetween = (a, b) => Date.parse(b.replace(' ', 'T') + 'Z') - Date.parse(a.replace(' ', 'T') + 'Z');
const cents = n => Math.round(n * 100) / 100;

function describeFor(site, program) {
    if (!site && !program) return '';
    return [SITE_SHORT[site] || site || '', PROGRAM_SHORT[program] || program || ''].filter(Boolean).join(' ');
}

// Turn clock punches into completed shifts. Hours are rounded to 2 decimals first, and the
// amount is worked out from those hours, so every printed row can be checked by hand.
function buildShifts(logs, rate) {
    const shifts = [];
    for (let i = 0; i < logs.length; i++) {
        if (logs[i].action === 'CLOCK_IN' && logs[i + 1] && logs[i + 1].action === 'CLOCK_OUT') {
            const hours = cents(msBetween(logs[i].timestamp, logs[i + 1].timestamp) / 3600000);
            shifts.push({ date: fmtDate(logs[i].local), hours, amount: cents(hours * rate) });
            i++;
        }
    }
    return shifts;
}

const CSS = `
@page { size: letter landscape; margin: 0.3in; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; margin: 0; }
.controls { background: #f2f2f2; border-bottom: 1px solid #bbb; padding: 10px 16px; font-size: 14px; }
.controls label { margin-right: 6px; }
.controls input, .controls select { margin-right: 14px; padding: 4px; font-size: 14px; }
.controls button { padding: 6px 14px; font-size: 14px; cursor: pointer; }
.controls .hint { font-size: 12px; color: #444; margin-top: 6px; }
.sheet { width: 10.3in; margin: 0 auto; padding: 8px 0; page-break-after: always; }
.sheet:last-child { page-break-after: auto; }
table { border-collapse: collapse; }
.head { width: 100%; }
.head td { vertical-align: top; }
.title { font-size: 17px; font-weight: bold; text-align: center; line-height: 1.25; }
.district { font-size: 12.5px; text-align: center; line-height: 1.5; margin-top: 8px; }
.cert { font-size: 11.5px; margin-bottom: 0; }
.lines { width: 100%; font-size: 14px; }
.lines td { padding: 0.27in 0 0; vertical-align: bottom; white-space: nowrap; }
.lines td:first-child { padding-right: 10px; }
.lines td.fill { width: 100%; border-bottom: 1px solid #000; padding-left: 8px; font-size: 15px; }
.lines td.sm { width: 1.1in; border-bottom: 1px solid #000; }
.lines td.lbl { text-align: center; font-size: 12px; padding-top: 2px; }
.law { font-size: 8.5px; line-height: 1.5; margin: 6px 0 4px; }
.law td { vertical-align: top; padding: 0 6px 0 0; }
.grid { width: 100%; table-layout: fixed; border: 2px solid #000; }
.grid th, .grid td { border: 1px solid #000; text-align: center; padding: 1px 3px; font-size: 11px; overflow: hidden; }
.grid th { font-size: 11.5px; height: 0.3in; }
.grid td.big { height: 0.35in; }
.grid td.half { height: 0.175in; }
.grid td.left { text-align: left; padding-left: 5px; }
.grid th.sup { font-weight: normal; font-size: 10px; text-align: left; padding-left: 4px; height: 0.2in; }
.grid td.nob { border: none; }
.grid td.tot { height: 0.2in; font-weight: bold; font-size: 11px; }
.grid td.totlbl { font-weight: bold; font-style: italic; font-size: 12px; }
.foot { width: 100%; font-size: 8.5px; margin-top: 3px; }
.foot td { padding: 0; }
@media print { .controls { display: none; } .sheet { padding: 0; } }
`;

function sheetHtml(sheet, ctx) {
    const rows = [];
    for (let i = 0; i < ROWS_PER_SHEET; i++) {
        const s = sheet.rows[i];
        rows.push(
            '<tr>' +
            '<td class="big" rowspan="2">' + (s ? esc(ctx.describe) : '') + '</td>' +
            '<td class="big" rowspan="2">' + (s ? money(ctx.rate) : '') + '</td>' +
            '<td class="big" rowspan="2">' + (s ? esc(s.date) : '') + '</td>' +
            '<td class="big" rowspan="2">' + (s ? s.hours.toFixed(2) : '') + '</td>' +
            '<td class="big" rowspan="2">' + (s ? money(s.amount) : '') + '</td>' +
            '<td class="half">&nbsp;</td><td class="half">&nbsp;</td><td class="half">&nbsp;</td></tr>' +
            '<tr><td class="half">&nbsp;</td><td class="half">&nbsp;</td><td class="half">&nbsp;</td></tr>'
        );
    }
    const multi = ctx.totalPages > 1;
    return `
<div class="sheet">
  <table class="head"><tr>
    <td style="width:3.6in; padding-right:0.3in;">
      <div class="title">MISCELLANEOUS<br>PAYROLL CLAIM FORM</div>
      <div class="district">KALISPELL SCHOOL DISTRICT NO. 5<br>233 First Avenue East<br>Kalispell, MT&nbsp; 59901<br>(406) 751-3441</div>
    </td>
    <td>
      <div class="cert">I certify that this claim is correct and just in all respects and that payment has not been received.</div>
      <table class="lines">
        <tr><td>Claimant Signature</td><td class="fill" colspan="3">&nbsp;</td></tr>
        <tr><td>Printed Name</td><td class="fill" colspan="3">${esc(ctx.name)}</td></tr>
        <tr><td>Address</td><td class="fill" colspan="3">&nbsp;</td></tr>
        <tr><td>APPROVED BY:</td><td class="fill">&nbsp;</td><td style="width:0.2in"></td><td class="sm">&nbsp;</td></tr>
        <tr><td></td><td class="lbl">Supervisor</td><td></td><td class="lbl">Date</td></tr>
      </table>
    </td>
  </tr></table>

  <table class="law">
    <tr><td colspan="2">Section 20-9-207 Montana Code Annotated states:</td></tr>
    <tr><td style="width:0.3in">(1)</td><td>The expenditure of district moneys, other than employee contract payments may be authorized when:</td></tr>
    <tr><td>a.</td><td>Payee signed claims, wherein the payee attests to the accuracy of the claim and that the claimant has not received the claim amount, or:</td></tr>
    <tr><td>b.</td><td>The payee has provided the District with an invoice or other document identifying the quantity and the total cost per item on the invoice.</td></tr>
    <tr><td>(2)</td><td>The intention of this section is to provide sufficient documentation for each expenditure of District moneys.</td></tr>
  </table>

  <table class="grid">
    <colgroup>
      <col style="width:19%"><col style="width:8%"><col style="width:9.5%"><col style="width:8%"><col style="width:10.5%">
      <col style="width:17%"><col style="width:19%"><col style="width:9%">
    </colgroup>
    <thead>
      <tr>
        <th rowspan="2">Work-Describe</th><th rowspan="2">Hourly<br>Rate</th><th rowspan="2">Date</th>
        <th rowspan="2">HOURS</th><th rowspan="2">AMOUNT</th>
        <th class="sup" colspan="3">Assistant Superintendent Review Budget Codes &ndash;</th>
      </tr>
      <tr><th>Account Code</th><th>Code Description</th><th>Amount</th></tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
      <tr>
        <td class="nob" colspan="3" rowspan="2"></td>
        <td class="tot">${sheet.rows.length ? sheet.hours.toFixed(2) : '&nbsp;'}</td>
        <td class="tot" rowspan="2">${sheet.rows.length ? money(sheet.amount) : '&nbsp;'}</td>
        <td colspan="2" rowspan="2">&nbsp;</td><td rowspan="2">&nbsp;</td>
      </tr>
      <tr><td class="totlbl">TOTAL</td></tr>
    </tbody>
  </table>
  <table class="foot"><tr>
    <td>${multi ? 'Sheet ' + sheet.number + ' of ' + ctx.totalPages + ' &nbsp;|&nbsp; ' + esc(ctx.rangeLabel) + ' &nbsp;|&nbsp; All sheets: ' +
        ctx.allHours.toFixed(2) + ' hrs, ' + money(ctx.allAmount) : esc(ctx.rangeLabel)}</td>
    <td style="text-align:right">Rev 5/04/16</td>
  </tr></table>
</div>`;
}

// Build the complete page (controls + one or more sheets)
function pageHtml(ctx) {
    const sheets = [];
    const pages = Math.max(1, Math.ceil(ctx.shifts.length / ROWS_PER_SHEET));
    for (let p = 0; p < pages; p++) {
        const rows = ctx.shifts.slice(p * ROWS_PER_SHEET, (p + 1) * ROWS_PER_SHEET);
        sheets.push({
            number: p + 1,
            rows,
            hours: cents(rows.reduce((t, r) => t + r.hours, 0)),
            amount: cents(rows.reduce((t, r) => t + r.amount, 0))
        });
    }
    const full = Object.assign({}, ctx, {
        totalPages: pages,
        allHours: cents(ctx.shifts.reduce((t, r) => t + r.hours, 0)),
        allAmount: cents(ctx.shifts.reduce((t, r) => t + r.amount, 0))
    });

    const people = ctx.people.length
        ? '<label for="employeeId">Employee</label><select id="employeeId" name="employeeId">' +
          ctx.people.map(p => '<option value="' + p.id + '"' + (p.id === ctx.empId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
          '</select>'
        : '';

    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
        '<title>Payroll Claim Form - ' + esc(ctx.name) + '</title><style>' + CSS + '</style></head><body>' +
        '<div class="controls">' +
        '<a href="/dashboard">&larr; Back to dashboard</a>' +
        '<form action="/timecards/print" method="GET" style="margin-top:8px;">' + people +
        '<label for="from">From</label><input type="date" id="from" name="from" value="' + esc(ctx.from) + '">' +
        '<label for="to">To</label><input type="date" id="to" name="to" value="' + esc(ctx.to) + '">' +
        '<label for="describe">Work description</label><input type="text" id="describe" name="describe" maxlength="80" value="' + esc(ctx.describe) + '" style="width:210px;">' +
        '<button type="submit">Update</button> ' +
        '<button type="button" onclick="window.print()" style="background:#2ea44f;color:#fff;border:1px solid #2a8a45;">Print / Save as PDF</button>' +
        '</form>' +
        '<div class="hint">In the print window, choose <strong>Save as PDF</strong> as the destination to make a PDF. The signature, address and approval lines stay blank to be filled in by hand.</div>' +
        '</div>' +
        sheets.map(s => sheetHtml(s, full)).join('\n') +
        '</body></html>';
}

function mount(app, getDb, wrap) {
    app.get('/timecards/print', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const db = getDb();

        // Who can be printed: yourself, plus anyone an admin manages
        let people = [];
        let empId = req.session.userID;
        if (req.session.admin === 1) {
            people = await manageableAccounts(db, req.session);
            if (!people.some(p => p.id === req.session.userID)) {
                const me = await db.get('SELECT id, name FROM employees WHERE id = ?', [req.session.userID]);
                if (me) people.push(me);
            }
            people.sort((a, b) => a.name.localeCompare(b.name));
            const wanted = parseInt(req.query.employeeId, 10);
            if (people.some(p => p.id === wanted)) empId = wanted;
        }

        const emp = await db.get('SELECT id, name, hourly_rate FROM employees WHERE id = ?', [empId]);
        if (!emp) return res.redirect('/dashboard');

        // Date range (defaults to the current month)
        const now = new Date();
        const first = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01';
        const last = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
        let from = DATE_RE.test(req.query.from || '') ? req.query.from : first;
        let to = DATE_RE.test(req.query.to || '') ? req.query.to : last;
        if (to < from) { const t = from; from = to; to = t; }

        // Work description: typed override, otherwise the person's school and assignment
        let describe = String(req.query.describe || '').trim().slice(0, 80);
        if (!describe) {
            let place = await db.get(
                'SELECT s.name AS site, p.name AS program FROM memberships m JOIN sites s ON s.id = m.site_id JOIN programs p ON p.id = m.program_id WHERE m.employee_id = ? ORDER BY m.id LIMIT 1',
                [empId]
            );
            if (!place) {
                place = await db.get(
                    'SELECT s.name AS site, p.name AS program FROM scopes sc JOIN sites s ON s.id = sc.site_id LEFT JOIN programs p ON p.id = sc.program_id WHERE sc.employee_id = ? ORDER BY sc.id LIMIT 1',
                    [empId]
                );
            }
            describe = place ? describeFor(place.site, place.program) : '';
        }

        const logs = await db.all(`
            SELECT action, timestamp, datetime(timestamp, 'localtime') AS local
            FROM logs
            WHERE employee_id = ?
              AND datetime(timestamp, 'localtime') >= ?
              AND datetime(timestamp, 'localtime') < datetime(?, '+1 day')
            ORDER BY timestamp ASC, id ASC
        `, [empId, from + ' 00:00:00', to + ' 00:00:00']);

        res.send(pageHtml({
            people, empId, name: emp.name, rate: emp.hourly_rate, describe, from, to,
            rangeLabel: 'Pay period: ' + fmtDate(from) + ' - ' + fmtDate(to),
            shifts: buildShifts(logs, emp.hourly_rate)
        }));
    }));
}

module.exports = { mount, pageHtml, buildShifts, describeFor };
