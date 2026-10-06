// extras.js - missed-hours requests (with admin approval) and past timecards.
// Mounted from index.js with one line; creates its own table on first use.
const ejs = require('ejs');
const { visibleSql, canManage } = require('./scope');

const MAX_DAYS_BACK = 45;    // how far back an employee may request missed hours
const MAX_SHIFT_HOURS = 16;  // longest single request allowed
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = n => String(n).padStart(2, '0');
const toMin = t => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
const spanHours = r => ((toMin(r.end_time) - toMin(r.start_time)) / 60).toFixed(2);

// ---------- Page templates (same water.css look as the rest of the app) ----------
const head = title =>
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>' + title + '</title>' +
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css">' +
    '</head><body><p><a href="/dashboard">&larr; Back to dashboard</a></p>';

const FORM_TPL = head('Request Missed Hours') + `
<h2>Request Missed Hours</h2>
<p>Use this if you forgot to clock in or out. Your request stays <strong>pending</strong> until an administrator approves it, and only approved hours count toward your pay.</p>
<% if (message) { %><p><strong><%= message %></strong></p><% } %>
<form action="/requests" method="POST">
  <label for="work_date">Date worked</label>
  <input type="date" id="work_date" name="work_date" required>
  <label for="start_time">Start time</label>
  <input type="time" id="start_time" name="start_time" required>
  <label for="end_time">End time</label>
  <input type="time" id="end_time" name="end_time" required>
  <p>Worked past midnight? Submit two requests, one for each day.</p>
  <label for="note">Reason</label>
  <input type="text" id="note" name="note" maxlength="200" placeholder="e.g. Forgot to clock in" required>
  <button type="submit">Submit for approval</button>
</form>
<h3>My Requests</h3>
<table>
  <thead><tr><th>Date</th><th>Time</th><th>Hours</th><th>Reason</th><th>Status</th></tr></thead>
  <tbody>
  <% requests.forEach(r => { %>
    <tr><td><%= r.work_date %></td><td><%= r.start_time %> - <%= r.end_time %></td><td><%= r.hours %></td><td><%= r.note %></td><td><%= r.status %></td></tr>
  <% }) %>
  </tbody>
</table>
</body></html>`;

const ADMIN_TPL = head('Pending Hour Requests') + `
<h2>Pending Hour Requests</h2>
<% if (message) { %><p><strong><%= message %></strong></p><% } %>
<% if (!pending.length) { %>
  <p>No requests are waiting for approval.</p>
<% } else { %>
<table>
  <thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Hours</th><th>Reason</th><th>Decision</th></tr></thead>
  <tbody>
  <% pending.forEach(r => { %>
    <tr>
      <td><%= r.name %></td><td><%= r.work_date %></td><td><%= r.start_time %> - <%= r.end_time %></td><td><%= r.hours %></td><td><%= r.note %></td>
      <td>
        <form action="/admin/requests/<%= r.id %>/approve" method="POST" style="display:inline"><button type="submit">Approve</button></form>
        <form action="/admin/requests/<%= r.id %>/deny" method="POST" style="display:inline"><button type="submit">Deny</button></form>
      </td>
    </tr>
  <% }) %>
  </tbody>
</table>
<% } %>
<h3>Recently Reviewed</h3>
<table>
  <thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Hours</th><th>Status</th><th>Reviewed by</th></tr></thead>
  <tbody>
  <% reviewed.forEach(r => { %>
    <tr><td><%= r.name %></td><td><%= r.work_date %></td><td><%= r.start_time %> - <%= r.end_time %></td><td><%= r.hours %></td><td><%= r.status %></td><td><%= r.reviewer || '' %></td></tr>
  <% }) %>
  </tbody>
</table>
</body></html>`;

const CARD_TPL = head('Past Timecards') + `
<h2>Past Timecards</h2>
<form action="/timecards" method="GET">
  <% if (employees.length) { %>
    <label for="employeeId">Employee</label>
    <select id="employeeId" name="employeeId">
      <% employees.forEach(e => { %>
        <option value="<%= e.id %>" <%= e.id === empId ? 'selected' : '' %>><%= e.name %></option>
      <% }) %>
    </select>
  <% } %>
  <label for="month">Month</label>
  <input type="month" id="month" name="month" value="<%= month %>">
  <button type="submit">View</button>
</form>
<h3><%= empName %> - <%= monthLabel %></h3>
<p>Base rate: $<%= rate %>/hr</p>
<table>
  <thead><tr><th>Date</th><th>Time (Punch Span)</th><th>Hours</th><th>Amount($)</th></tr></thead>
  <tbody>
  <% shifts.forEach(s => { %>
    <tr><td><%= s.date %></td><td><%= s.time %></td><td><%= s.hours %> hrs</td><td>$<%= s.amount %></td></tr>
  <% }) %>
  <% if (!shifts.length) { %><tr><td colspan="4">No completed shifts this month.</td></tr><% } %>
  </tbody>
  <tfoot>
    <tr><td colspan="2" style="text-align:right"><strong>Totals:</strong></td><td><strong><%= totalHours %> hrs</strong></td><td><strong>$<%= totalPay %></strong></td></tr>
  </tfoot>
</table>
</body></html>`;

// ---------- Routes ----------
module.exports = function (app, getDb, wrap) {
    let tableReady = null;

    // Returns the shared db handle after making sure the requests table exists
    async function database() {
        const db = getDb();
        if (!tableReady) {
            tableReady = db.exec(`
                CREATE TABLE IF NOT EXISTS time_requests (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  employee_id INTEGER NOT NULL,
                  work_date TEXT NOT NULL,
                  start_time TEXT NOT NULL,
                  end_time TEXT NOT NULL,
                  note TEXT,
                  status TEXT NOT NULL DEFAULT 'PENDING',
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  reviewed_by INTEGER,
                  reviewed_at TEXT
                )
            `).catch(err => { tableReady = null; throw err; });
        }
        await tableReady;
        return db;
    }

    const needLogin = (req, res) => {
        if (!req.session.userID) { res.redirect('/'); return true; }
        return false;
    };
    const needAdmin = (req, res) => {
        if (req.session.admin !== 1) { res.redirect('/'); return true; }
        return false;
    };

    // --- Employee: request missed hours ---
    async function renderForm(req, res, db, message, status = 200) {
        const rows = await db.all(
            'SELECT * FROM time_requests WHERE employee_id = ? ORDER BY id DESC LIMIT 30',
            [req.session.userID]
        );
        const requests = rows.map(r => ({ ...r, hours: spanHours(r) }));
        res.status(status).send(ejs.render(FORM_TPL, { message, requests }));
    }

    app.get('/requests/new', wrap(async (req, res) => {
        if (needLogin(req, res)) return;
        const db = await database();
        const message = req.query.sent
            ? 'Request submitted. It will count toward your pay once an administrator approves it.'
            : null;
        await renderForm(req, res, db, message);
    }));

    app.post('/requests', wrap(async (req, res) => {
        if (needLogin(req, res)) return;
        const db = await database();
        const { work_date, start_time, end_time } = req.body;
        const note = String(req.body.note || '').trim().slice(0, 200);
        const fail = msg => renderForm(req, res, db, msg, 400);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date || '') || isNaN(new Date(work_date + 'T00:00:00'))) {
            return fail('Please enter a valid date.');
        }
        if (!TIME_RE.test(start_time || '') || !TIME_RE.test(end_time || '')) {
            return fail('Please enter valid start and end times.');
        }
        if (toMin(end_time) <= toMin(start_time)) {
            return fail('End time must be after the start time.');
        }
        if ((toMin(end_time) - toMin(start_time)) / 60 > MAX_SHIFT_HOURS) {
            return fail('A single request can be at most ' + MAX_SHIFT_HOURS + ' hours.');
        }
        if (!note) return fail('Please add a short reason.');

        const start = work_date + ' ' + start_time + ':00';
        const end = work_date + ' ' + end_time + ':00';
        const chk = await db.get(
            "SELECT (datetime(?, 'utc') > datetime('now')) AS future, (datetime(?, 'utc') < datetime('now', ?)) AS tooOld",
            [end, start, '-' + MAX_DAYS_BACK + ' days']
        );
        if (chk.future) return fail('That time is in the future.');
        if (chk.tooOld) return fail('Requests can only go back ' + MAX_DAYS_BACK + ' days. Please ask an administrator.');

        await db.run(
            'INSERT INTO time_requests (employee_id, work_date, start_time, end_time, note) VALUES (?, ?, ?, ?, ?)',
            [req.session.userID, work_date, start_time, end_time, note]
        );
        res.redirect('/requests/new?sent=1');
    }));

    // --- Admin: review requests ---
    app.get('/admin/requests', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const messages = {
            own: "You can't approve your own request. Ask another administrator.",
            conflict: 'That request overlaps existing punches for this employee. Deny it and ask them to submit corrected times.',
            scope: 'That request is outside the areas you manage.',
            done: 'Done.'
        };
        const scope = visibleSql(req.session, 'e');
        const pending = (await db.all(`
            SELECT r.*, e.name FROM time_requests r
            JOIN employees e ON e.id = r.employee_id
            WHERE r.status = 'PENDING' AND ${scope.sql} ORDER BY r.id ASC
        `, scope.params)).map(r => ({ ...r, hours: spanHours(r) }));
        const reviewed = (await db.all(`
            SELECT r.*, e.name, a.name AS reviewer FROM time_requests r
            JOIN employees e ON e.id = r.employee_id
            LEFT JOIN employees a ON a.id = r.reviewed_by
            WHERE r.status != 'PENDING' AND ${scope.sql} ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 20
        `, scope.params)).map(r => ({ ...r, hours: spanHours(r) }));
        res.send(ejs.render(ADMIN_TPL, { pending, reviewed, message: messages[req.query.msg] || null }));
    }));

    app.post('/admin/requests/:id/approve', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const id = parseInt(req.params.id, 10);
        const r = await db.get("SELECT * FROM time_requests WHERE id = ? AND status = 'PENDING'", [id]);
        if (!r) return res.redirect('/admin/requests');
        if (r.employee_id === req.session.userID) return res.redirect('/admin/requests?msg=own');
        if (!(await canManage(db, req.session, r.employee_id))) return res.redirect('/admin/requests?msg=scope');

        const start = r.work_date + ' ' + r.start_time + ':00';
        const end = r.work_date + ' ' + r.end_time + ':00';

        // Refuse if the new shift would overlap or sit inside an existing shift
        const inside = await db.get(
            "SELECT COUNT(*) AS n FROM logs WHERE employee_id = ? AND timestamp > datetime(?, 'utc') AND timestamp < datetime(?, 'utc')",
            [r.employee_id, start, end]
        );
        const before = await db.get(
            "SELECT action FROM logs WHERE employee_id = ? AND timestamp <= datetime(?, 'utc') ORDER BY timestamp DESC, id DESC LIMIT 1",
            [r.employee_id, start]
        );
        const after = await db.get(
            "SELECT action FROM logs WHERE employee_id = ? AND timestamp >= datetime(?, 'utc') ORDER BY timestamp ASC, id ASC LIMIT 1",
            [r.employee_id, end]
        );
        if (inside.n > 0 || (before && before.action === 'CLOCK_IN') || (after && after.action === 'CLOCK_OUT')) {
            return res.redirect('/admin/requests?msg=conflict');
        }

        // Approving adds a normal CLOCK_IN / CLOCK_OUT pair, so all existing totals update by themselves
        await db.run('BEGIN');
        try {
            const upd = await db.run(
                "UPDATE time_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'PENDING'",
                [req.session.userID, id]
            );
            if (upd.changes === 1) {
                await db.run("INSERT INTO logs (employee_id, action, timestamp) VALUES (?, 'CLOCK_IN', datetime(?, 'utc'))", [r.employee_id, start]);
                await db.run("INSERT INTO logs (employee_id, action, timestamp) VALUES (?, 'CLOCK_OUT', datetime(?, 'utc'))", [r.employee_id, end]);
            }
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        res.redirect('/admin/requests?msg=done');
    }));

    app.post('/admin/requests/:id/deny', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const target = await db.get('SELECT employee_id FROM time_requests WHERE id = ?', [parseInt(req.params.id, 10)]);
        if (target && !(await canManage(db, req.session, target.employee_id))) return res.redirect('/admin/requests?msg=scope');
        await db.run(
            "UPDATE time_requests SET status = 'DENIED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'PENDING'",
            [req.session.userID, parseInt(req.params.id, 10)]
        );
        res.redirect('/admin/requests?msg=done');
    }));

    // --- Past timecards (employees: their own; admins: anyone) ---
    app.get('/timecards', wrap(async (req, res) => {
        if (needLogin(req, res)) return;
        const db = await database();
        const isAdmin = req.session.admin === 1;

        const now = new Date();
        const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '')
            ? req.query.month
            : now.getFullYear() + '-' + pad(now.getMonth() + 1);
        const [y, m] = month.split('-').map(Number);
        const nextMonth = m === 12 ? (y + 1) + '-01' : y + '-' + pad(m + 1);
        const startStr = month + '-01 00:00:00';
        const endStr = nextMonth + '-01 00:00:00';

        let empId = req.session.userID;
        let employees = [];
        if (isAdmin) {
            const vis = visibleSql(req.session, 'e');
            employees = await db.all(`SELECT e.id, e.name FROM employees e WHERE (${vis.sql} OR e.id = ?) ORDER BY e.name`, [...vis.params, req.session.userID]);
            const wanted = parseInt(req.query.employeeId, 10);
            if (wanted && employees.some(e => e.id === wanted)) empId = wanted;
        }

        const emp = await db.get('SELECT name, hourly_rate FROM employees WHERE id = ?', [empId]);
        if (!emp) return res.redirect('/dashboard');

        const logs = await db.all(`
            SELECT action, datetime(timestamp, 'localtime') AS ts
            FROM logs
            WHERE employee_id = ?
              AND datetime(timestamp, 'localtime') >= ?
              AND datetime(timestamp, 'localtime') < ?
            ORDER BY timestamp ASC, id ASC
        `, [empId, startStr, endStr]);

        const shifts = [];
        let hoursSum = 0;
        let paySum = 0;
        for (let i = 0; i < logs.length; i++) {
            if (logs[i].action === 'CLOCK_IN' && logs[i + 1] && logs[i + 1].action === 'CLOCK_OUT') {
                const inTime = new Date(logs[i].ts);
                const outTime = new Date(logs[i + 1].ts);
                const hours = (outTime - inTime) / (1000 * 60 * 60);
                const amount = hours * emp.hourly_rate;
                hoursSum += hours;
                paySum += amount;
                shifts.push({
                    date: inTime.toLocaleDateString(),
                    time: inTime.toLocaleTimeString() + ' - ' + outTime.toLocaleTimeString(),
                    hours: hours.toFixed(2),
                    amount: amount.toFixed(2)
                });
                i++;
            }
        }

        res.send(ejs.render(CARD_TPL, {
            employees,
            empId,
            empName: emp.name,
            rate: emp.hourly_rate.toFixed(2),
            month,
            monthLabel: new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
            shifts,
            totalHours: hoursSum.toFixed(2),
            totalPay: paySum.toFixed(2)
        }));
    }));
};
