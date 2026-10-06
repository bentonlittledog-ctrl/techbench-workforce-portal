// editing.js - admin timecard editing with a permanent audit log.
//
// Pages (all admin-only):
//   /admin/shifts        pick an employee and month; add, edit, delete shifts; fix stray punches
//   /admin/audit         district administrators only: every change, who made it, and why
//
// Rules:
//   * Managers can only change accounts inside their own site / program scope.
//   * Nobody can change their own timecard.
//   * Every change needs a reason and is written to the audit log with the old and new times.
//   * Times are validated: end after start, no future times, no overlap with other shifts.
const { canManage, manageableAccounts } = require('./scope');

const MAX_SHIFT_HOURS = 16;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

const pad = n => String(n).padStart(2, '0');
const fmtDate = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return m + '/' + d + '/' + y; };
const fmtTime = s => {
    let h = parseInt(s.slice(11, 13), 10);
    const m = s.slice(14, 16);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
};
const fmtStamp = s => fmtDate(s) + ' ' + fmtTime(s);
const toInput = s => s.slice(0, 16).replace(' ', 'T');
const msBetween = (a, b) => Date.parse(b.replace(' ', 'T') + 'Z') - Date.parse(a.replace(' ', 'T') + 'Z');

module.exports = function (app, getDb, wrap) {
    let ready = null;

    async function database() {
        const db = getDb();
        if (!ready) {
            ready = db.exec(`
                CREATE TABLE IF NOT EXISTS audit_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  at TEXT DEFAULT CURRENT_TIMESTAMP,
                  actor_id INTEGER,
                  actor_name TEXT,
                  target_id INTEGER,
                  target_name TEXT,
                  action TEXT NOT NULL,
                  details TEXT,
                  reason TEXT
                )
            `).catch(err => { ready = null; throw err; });
        }
        await ready;
        return db;
    }

    const needAdmin = (req, res) => {
        if (req.session.admin !== 1) { res.redirect('/'); return true; }
        return false;
    };
    const flash = (req, msg) => { req.session.flash = msg; };
    const takeFlash = req => { const m = req.session.flash || null; delete req.session.flash; return m; };

    // The signed-in admin may change this person's timecard
    async function allowed(db, req, empId) {
        if (!empId || empId === req.session.userID) return false;
        return canManage(db, req.session, empId);
    }

    const getReason = req => String(req.body.reason || '').trim().slice(0, 300);

    async function audit(db, req, target, action, details, reason) {
        await db.run(
            'INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.session.userID, req.session.name || '', target.id, target.name, action, details, reason]
        );
    }

    async function localOf(db, utc) {
        return (await db.get("SELECT datetime(?, 'localtime') AS l", [utc])).l;
    }

    // Load a clock-in / clock-out pair and confirm it really is one shift
    async function loadShift(db, inId, outId) {
        if (!inId || !outId) return null;
        const rows = await db.all(
            "SELECT id, employee_id, action, timestamp, datetime(timestamp, 'localtime') AS local FROM logs WHERE id IN (?, ?)",
            [inId, outId]
        );
        const a = rows.find(r => r.id === inId);
        const b = rows.find(r => r.id === outId);
        if (!a || !b || a.employee_id !== b.employee_id) return null;
        if (a.action !== 'CLOCK_IN' || b.action !== 'CLOCK_OUT' || b.timestamp < a.timestamp) return null;
        const between = await db.get(
            'SELECT COUNT(*) AS n FROM logs WHERE employee_id = ? AND id NOT IN (?, ?) AND timestamp > ? AND timestamp < ?',
            [a.employee_id, inId, outId, a.timestamp, b.timestamp]
        );
        if (between.n > 0) return null;
        return { inRow: a, outRow: b, empId: a.employee_id };
    }

    // Validate a start / end pair (values from datetime-local inputs, in local time)
    async function checkSpan(db, empId, startIn, endIn, excludeIds) {
        if (!LOCAL_RE.test(startIn || '') || !LOCAL_RE.test(endIn || '')) return { error: 'Enter a valid start and end time.' };
        const s = startIn.replace('T', ' ') + ':00';
        const e = endIn.replace('T', ' ') + ':00';
        if (e <= s) return { error: 'The end time must be after the start time.' };

        const u = await db.get(
            "SELECT datetime(?, 'utc') AS s, datetime(?, 'utc') AS e, (datetime(?, 'utc') > datetime('now')) AS future",
            [s, e, e]
        );
        if (!u || !u.s || !u.e) return { error: 'Enter a valid start and end time.' };
        if (u.future) return { error: 'That time is in the future.' };
        if (msBetween(u.s, u.e) / 3600000 > MAX_SHIFT_HOURS) {
            return { error: 'A single shift can be at most ' + MAX_SHIFT_HOURS + ' hours.' };
        }

        const ex = (excludeIds && excludeIds.length) ? excludeIds : [0];
        const marks = ex.map(() => '?').join(',');
        const inside = await db.get(
            'SELECT COUNT(*) AS n FROM logs WHERE employee_id = ? AND id NOT IN (' + marks + ') AND timestamp > ? AND timestamp < ?',
            [empId, ...ex, u.s, u.e]
        );
        const before = await db.get(
            'SELECT action FROM logs WHERE employee_id = ? AND id NOT IN (' + marks + ') AND timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT 1',
            [empId, ...ex, u.s]
        );
        const after = await db.get(
            'SELECT action FROM logs WHERE employee_id = ? AND id NOT IN (' + marks + ') AND timestamp >= ? ORDER BY timestamp ASC, id ASC LIMIT 1',
            [empId, ...ex, u.e]
        );
        if (inside.n > 0 || (before && before.action === 'CLOCK_IN') || (after && after.action === 'CLOCK_OUT')) {
            return { error: 'Those times overlap another shift for this employee.' };
        }
        return { startUtc: u.s, endUtc: u.e, startLocal: s, endLocal: e };
    }

    // ---------- Shift list ----------
    app.get('/admin/shifts', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();

        const people = (await manageableAccounts(db, req.session)).filter(u => u.id !== req.session.userID);
        const wanted = parseInt(req.query.employeeId, 10);
        const empId = people.some(p => p.id === wanted) ? wanted : (people[0] ? people[0].id : null);

        const now = new Date();
        const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '')
            ? req.query.month
            : now.getFullYear() + '-' + pad(now.getMonth() + 1);
        const [y, m] = month.split('-').map(Number);
        const nextMonth = m === 12 ? (y + 1) + '-01' : y + '-' + pad(m + 1);

        let emp = null;
        const shifts = [];
        const strays = [];
        let hoursSum = 0;
        let paySum = 0;

        if (empId) {
            emp = await db.get('SELECT id, name, hourly_rate FROM employees WHERE id = ?', [empId]);
            const logs = await db.all(`
                SELECT id, action, timestamp, datetime(timestamp, 'localtime') AS local
                FROM logs
                WHERE employee_id = ?
                  AND datetime(timestamp, 'localtime') >= ?
                  AND datetime(timestamp, 'localtime') < ?
                ORDER BY timestamp ASC, id ASC
            `, [empId, month + '-01 00:00:00', nextMonth + '-01 00:00:00']);

            for (let i = 0; i < logs.length; i++) {
                const a = logs[i];
                const b = logs[i + 1];
                if (a.action === 'CLOCK_IN' && b && b.action === 'CLOCK_OUT') {
                    const hours = msBetween(a.timestamp, b.timestamp) / 3600000;
                    const amount = hours * emp.hourly_rate;
                    hoursSum += hours;
                    paySum += amount;
                    shifts.push({
                        inId: a.id, outId: b.id,
                        date: fmtDate(a.local),
                        time: fmtTime(a.local) + ' - ' + fmtTime(b.local),
                        hours: hours.toFixed(2),
                        amount: amount.toFixed(2)
                    });
                    i++;
                } else {
                    strays.push({
                        id: a.id,
                        action: a.action,
                        when: fmtStamp(a.local),
                        input: toInput(a.local)
                    });
                }
            }
        }

        res.render('admin_shifts', {
            people, empId, emp, month,
            monthLabel: new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
            shifts, strays,
            totalHours: hoursSum.toFixed(2),
            totalPay: paySum.toFixed(2),
            message: takeFlash(req)
        });
    }));

    const backTo = (empId, month) => '/admin/shifts?employeeId=' + empId + '&month=' + month;

    // ---------- Add a shift ----------
    app.post('/admin/shifts/add', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const empId = parseInt(req.body.employeeId, 10);
        const month = String(req.body.start || '').slice(0, 7);
        const fail = msg => { flash(req, msg); return res.redirect(backTo(empId, month || '')); };

        if (!(await allowed(db, req, empId))) { flash(req, "You can't change that employee's timecard."); return res.redirect('/admin/shifts'); }
        const reason = getReason(req);
        if (reason.length < 3) return fail('Enter a reason for this change.');

        const span = await checkSpan(db, empId, req.body.start, req.body.end, []);
        if (span.error) return fail(span.error);

        const target = await db.get('SELECT id, name FROM employees WHERE id = ?', [empId]);
        await db.run('BEGIN');
        try {
            await db.run("INSERT INTO logs (employee_id, action, timestamp) VALUES (?, 'CLOCK_IN', ?)", [empId, span.startUtc]);
            await db.run("INSERT INTO logs (employee_id, action, timestamp) VALUES (?, 'CLOCK_OUT', ?)", [empId, span.endUtc]);
            await audit(db, req, target, 'ADD_SHIFT',
                'Added shift ' + fmtStamp(span.startLocal) + ' to ' + fmtTime(span.endLocal), reason);
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        flash(req, 'Shift added.');
        res.redirect(backTo(empId, span.startLocal.slice(0, 7)));
    }));

    // ---------- Edit or delete one shift ----------
    app.get('/admin/shifts/edit', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const shift = await loadShift(db, parseInt(req.query.in, 10), parseInt(req.query.out, 10));
        if (!shift || !(await allowed(db, req, shift.empId))) {
            flash(req, "That shift can't be edited.");
            return res.redirect('/admin/shifts');
        }
        const emp = await db.get('SELECT id, name FROM employees WHERE id = ?', [shift.empId]);
        res.render('admin_shift_edit', {
            emp,
            inId: shift.inRow.id,
            outId: shift.outRow.id,
            startInput: toInput(shift.inRow.local),
            endInput: toInput(shift.outRow.local),
            current: fmtStamp(shift.inRow.local) + ' to ' + fmtTime(shift.outRow.local),
            month: shift.inRow.local.slice(0, 7),
            message: takeFlash(req)
        });
    }));

    app.post('/admin/shifts/edit', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const inId = parseInt(req.body.inId, 10);
        const outId = parseInt(req.body.outId, 10);
        const shift = await loadShift(db, inId, outId);
        if (!shift || !(await allowed(db, req, shift.empId))) {
            flash(req, "That shift can't be edited.");
            return res.redirect('/admin/shifts');
        }
        const again = msg => { flash(req, msg); return res.redirect('/admin/shifts/edit?in=' + inId + '&out=' + outId); };

        const reason = getReason(req);
        if (reason.length < 3) return again('Enter a reason for this change.');
        const span = await checkSpan(db, shift.empId, req.body.start, req.body.end, [inId, outId]);
        if (span.error) return again(span.error);

        const target = await db.get('SELECT id, name FROM employees WHERE id = ?', [shift.empId]);
        const before = fmtStamp(shift.inRow.local) + ' to ' + fmtTime(shift.outRow.local);
        await db.run('BEGIN');
        try {
            await db.run('UPDATE logs SET timestamp = ? WHERE id = ?', [span.startUtc, inId]);
            await db.run('UPDATE logs SET timestamp = ? WHERE id = ?', [span.endUtc, outId]);
            await audit(db, req, target, 'EDIT_SHIFT',
                'Changed shift ' + before + ' to ' + fmtStamp(span.startLocal) + ' to ' + fmtTime(span.endLocal), reason);
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        flash(req, 'Shift updated.');
        res.redirect(backTo(shift.empId, span.startLocal.slice(0, 7)));
    }));

    app.post('/admin/shifts/delete', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const inId = parseInt(req.body.inId, 10);
        const outId = parseInt(req.body.outId, 10);
        const shift = await loadShift(db, inId, outId);
        if (!shift || !(await allowed(db, req, shift.empId))) {
            flash(req, "That shift can't be deleted.");
            return res.redirect('/admin/shifts');
        }
        const reason = getReason(req);
        if (reason.length < 3) {
            flash(req, 'Enter a reason for this change.');
            return res.redirect('/admin/shifts/edit?in=' + inId + '&out=' + outId);
        }

        const target = await db.get('SELECT id, name FROM employees WHERE id = ?', [shift.empId]);
        const hours = (msBetween(shift.inRow.timestamp, shift.outRow.timestamp) / 3600000).toFixed(2);
        await db.run('BEGIN');
        try {
            await db.run('DELETE FROM logs WHERE id IN (?, ?)', [inId, outId]);
            await audit(db, req, target, 'DELETE_SHIFT',
                'Deleted shift ' + fmtStamp(shift.inRow.local) + ' to ' + fmtTime(shift.outRow.local) + ' (' + hours + ' hrs)', reason);
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        flash(req, 'Shift deleted.');
        res.redirect(backTo(shift.empId, shift.inRow.local.slice(0, 7)));
    }));

    // ---------- Stray punches (a clock-in with no clock-out, or the reverse) ----------
    async function loadPunch(db, id) {
        return db.get(
            "SELECT id, employee_id, action, timestamp, datetime(timestamp, 'localtime') AS local FROM logs WHERE id = ?",
            [id]
        );
    }

    app.post('/admin/shifts/punch-delete', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const punch = await loadPunch(db, parseInt(req.body.punchId, 10));
        if (!punch || !(await allowed(db, req, punch.employee_id))) {
            flash(req, "That punch can't be changed.");
            return res.redirect('/admin/shifts');
        }
        const month = punch.local.slice(0, 7);
        const reason = getReason(req);
        if (reason.length < 3) { flash(req, 'Enter a reason for this change.'); return res.redirect(backTo(punch.employee_id, month)); }

        const target = await db.get('SELECT id, name FROM employees WHERE id = ?', [punch.employee_id]);
        await db.run('BEGIN');
        try {
            await db.run('DELETE FROM logs WHERE id = ?', [punch.id]);
            await audit(db, req, target, 'DELETE_PUNCH',
                'Deleted ' + (punch.action === 'CLOCK_IN' ? 'clock-in' : 'clock-out') + ' at ' + fmtStamp(punch.local), reason);
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        flash(req, 'Punch deleted.');
        res.redirect(backTo(punch.employee_id, month));
    }));

    app.post('/admin/shifts/complete', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const punch = await loadPunch(db, parseInt(req.body.punchId, 10));
        if (!punch || !(await allowed(db, req, punch.employee_id))) {
            flash(req, "That punch can't be changed.");
            return res.redirect('/admin/shifts');
        }
        const month = punch.local.slice(0, 7);
        const fail = msg => { flash(req, msg); return res.redirect(backTo(punch.employee_id, month)); };
        const reason = getReason(req);
        if (reason.length < 3) return fail('Enter a reason for this change.');

        const isIn = punch.action === 'CLOCK_IN';
        const given = req.body.time;
        const span = isIn
            ? await checkSpan(db, punch.employee_id, toInput(punch.local), given, [punch.id])
            : await checkSpan(db, punch.employee_id, given, toInput(punch.local), [punch.id]);
        if (span.error) return fail(span.error);

        const target = await db.get('SELECT id, name FROM employees WHERE id = ?', [punch.employee_id]);
        const newAction = isIn ? 'CLOCK_OUT' : 'CLOCK_IN';
        const newUtc = isIn ? span.endUtc : span.startUtc;
        const newLocal = isIn ? span.endLocal : span.startLocal;
        await db.run('BEGIN');
        try {
            await db.run('INSERT INTO logs (employee_id, action, timestamp) VALUES (?, ?, ?)', [punch.employee_id, newAction, newUtc]);
            await audit(db, req, target, 'COMPLETE_SHIFT',
                'Added missing ' + (isIn ? 'clock-out' : 'clock-in') + ' at ' + fmtStamp(newLocal) +
                ' to match ' + (isIn ? 'clock-in' : 'clock-out') + ' at ' + fmtStamp(punch.local), reason);
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        flash(req, 'Shift completed.');
        res.redirect(backTo(punch.employee_id, month));
    }));

    // ---------- Audit log (district administrators only) ----------
    app.get('/admin/audit', wrap(async (req, res) => {
        if (req.session.district !== 1) return res.redirect('/');
        const db = await database();
        const rows = await db.all(`
            SELECT datetime(at, 'localtime') AS local, actor_name, target_name, action, details, reason
            FROM audit_log ORDER BY id DESC LIMIT 300
        `);
        res.render('admin_audit', {
            rows: rows.map(r => ({ ...r, when: fmtStamp(r.local) }))
        });
    }));
};
