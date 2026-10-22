// Shift limits and overtime approval.
// Every person has a shift limit (their own, or the district default). A shift is never blocked for running long.
// If someone clocks out more than 5 minutes past their limit, the timecard is credited with the limit only, and the extra time
// goes to a supervisor to approve (Pending requests). Up to 5 minutes over is simply counted. Approving moves the clock-out to the real time.
const TOLERANCE_MIN = 5;
const pad = n => String(n).padStart(2, '0');
const utcStamp = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
const parseUtc = s => { const t = Date.parse(String(s).replace(' ', 'T') + 'Z'); return isNaN(t) ? null : t; };
const human = min => { const h = Math.floor(min / 60), m = Math.round(min % 60); return (h ? h + ' h ' : '') + m + ' min'; };
const hhmm = min => Math.floor(min / 60) + ':' + pad(Math.round(min % 60));

let ready = null;
async function ensure(db) {
    if (!ready) ready = db.exec(`CREATE TABLE IF NOT EXISTS overtime_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, in_log_id INTEGER, out_log_id INTEGER,
            in_ts TEXT NOT NULL, capped_out TEXT NOT NULL, actual_out TEXT NOT NULL, minutes INTEGER NOT NULL, limit_hours REAL,
            status TEXT NOT NULL DEFAULT 'PENDING', approved_minutes INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, reviewed_by INTEGER, reviewed_at TEXT, note TEXT DEFAULT '');
        CREATE INDEX IF NOT EXISTS idx_overtime_status ON overtime_requests(status, employee_id);
        CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_by TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor_id INTEGER, actor_name TEXT, target_id INTEGER, target_name TEXT, action TEXT NOT NULL, details TEXT, reason TEXT);`).catch(e => { ready = null; throw e; });
    return ready;
}
const audit = (db, actorId, actorName, targetId, targetName, action, details) =>
    db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)', [actorId || null, actorName || 'System', targetId || null, targetName || '', action, details, '']);

// ----- limits -----
const limitFor = (db, id) => require('./autoclock').limitFor(db, id);
async function ownLimit(db, id) { await ensure(db); const r = await db.get('SELECT value FROM app_settings WHERE key = ?', ['shiftlimit_' + id]); const v = r ? parseFloat(r.value) : NaN; return v >= 1 && v <= 16 ? v : null; }
async function setLimit(db, who, id, hours) {
    await ensure(db);
    if (hours == null) await db.run('DELETE FROM app_settings WHERE key = ?', ['shiftlimit_' + id]);
    else await db.run('INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,CURRENT_TIMESTAMP,?)', ['shiftlimit_' + id, String(hours), who || '']);
}

// ----- clocking out -----
// Called by /punch when someone clocks out. Returns what to store and what to tell the person.
//   { stamp: null }                         -> store the real time (nothing special)
//   { stamp, over: {...}, note }            -> store `stamp` (the limit), then call record() with the new log id
async function decide(db, employeeId, now = new Date()) {
    await ensure(db);
    const inRow = await db.get("SELECT id, timestamp FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1", [employeeId]);
    const last = await db.get("SELECT action FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1", [employeeId]);
    if (!inRow || !last || last.action !== 'CLOCK_IN') return { stamp: null };
    const inMs = parseUtc(inRow.timestamp); if (inMs == null) return { stamp: null };
    const limit = await limitFor(db, employeeId);
    const limitMs = limit * 3600000, durMs = now.getTime() - inMs;
    const overMin = (durMs - limitMs) / 60000;
    if (overMin <= TOLERANCE_MIN) return { stamp: null };
    return {
        stamp: utcStamp(new Date(inMs + limitMs)),
        over: { inLogId: inRow.id, inTs: inRow.timestamp, cappedOut: utcStamp(new Date(inMs + limitMs)), actualOut: utcStamp(now), minutes: Math.round(overMin), limit },
        note: 'You worked ' + human(Math.round(overMin)) + ' past your ' + limit + '-hour shift limit. ' + limit + ' hours were added to your timecard, and the extra ' + human(Math.round(overMin)) + ' was sent to your supervisor for approval.'
    };
}
async function record(db, employeeId, outLogId, over, name) {
    await ensure(db);
    const r = await db.run('INSERT INTO overtime_requests (employee_id, in_log_id, out_log_id, in_ts, capped_out, actual_out, minutes, limit_hours) VALUES (?,?,?,?,?,?,?,?)',
        [employeeId, over.inLogId, outLogId, over.inTs, over.cappedOut, over.actualOut, over.minutes, over.limit]);
    await audit(db, null, 'System', employeeId, name, 'OVERTIME_REQUESTED', 'Clocked out ' + human(over.minutes) + ' past the ' + over.limit + '-hour limit. Timecard credited with the limit; the extra time is waiting for approval.');
    return r.lastID;
}

// ----- supervisor panel -----
async function pendingFor(db, session) {
    await ensure(db);
    const { visibleSql } = require('./scope'), v = visibleSql(session, 'e');
    return (await db.all(`SELECT o.*, e.name, datetime(o.in_ts, 'localtime') AS in_local, datetime(o.capped_out, 'localtime') AS capped_local, datetime(o.actual_out, 'localtime') AS actual_local
        FROM overtime_requests o JOIN employees e ON e.id = o.employee_id WHERE o.status = 'PENDING' AND ${v.sql} ORDER BY o.id ASC`, v.params))
        .map(r => Object.assign(r, { human: human(r.minutes), hhmm: hhmm(r.minutes) }));
}
async function reviewedFor(db, session, limit = 15) {
    await ensure(db);
    const { visibleSql } = require('./scope'), v = visibleSql(session, 'e');
    return (await db.all(`SELECT o.*, e.name, a.name AS reviewer, datetime(o.in_ts, 'localtime') AS in_local FROM overtime_requests o JOIN employees e ON e.id = o.employee_id
        LEFT JOIN employees a ON a.id = o.reviewed_by WHERE o.status != 'PENDING' AND ${v.sql} ORDER BY o.reviewed_at DESC, o.id DESC LIMIT ${parseInt(limit, 10)}`, v.params))
        .map(r => Object.assign(r, { human: human(r.minutes), approvedHuman: r.approved_minutes != null ? human(r.approved_minutes) : '' }));
}
async function mineFor(db, employeeId, limit = 10) {
    await ensure(db);
    return (await db.all(`SELECT o.*, datetime(o.in_ts, 'localtime') AS in_local FROM overtime_requests o WHERE o.employee_id = ? ORDER BY o.id DESC LIMIT ${parseInt(limit, 10)}`, [employeeId]))
        .map(r => Object.assign(r, { human: human(r.minutes), approvedHuman: r.approved_minutes != null ? human(r.approved_minutes) : '' }));
}

// Result codes: ok | own | scope | gone | stale | conflict
async function approve(db, session, id, minutes) {
    await ensure(db);
    const { canManage } = require('./scope');
    const r = await db.get("SELECT * FROM overtime_requests WHERE id = ? AND status = 'PENDING'", [id]);
    if (!r) return 'gone';
    if (r.employee_id === session.userID) return 'own';
    if (!(await canManage(db, session, r.employee_id))) return 'scope';
    const out = await db.get("SELECT id, action, timestamp FROM logs WHERE id = ?", [r.out_log_id]);
    if (!out || out.action !== 'CLOCK_OUT' || out.timestamp !== r.capped_out) return 'stale';     // a manager already changed this shift
    let m = parseInt(minutes, 10); if (!(m >= 1)) m = r.minutes; m = Math.min(m, r.minutes);
    const newOut = utcStamp(new Date(parseUtc(r.capped_out) + m * 60000));
    const between = await db.get('SELECT COUNT(*) AS n FROM logs WHERE employee_id = ? AND id != ? AND timestamp > ? AND timestamp <= ?', [r.employee_id, r.out_log_id, r.capped_out, newOut]);
    if (between.n > 0) return 'conflict';
    const name = (await db.get('SELECT name FROM employees WHERE id = ?', [r.employee_id])).name;
    await db.run('BEGIN');
    try {
        await db.run("UPDATE overtime_requests SET status = 'APPROVED', approved_minutes = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'PENDING'", [m, session.userID, id]);
        await db.run('UPDATE logs SET timestamp = ? WHERE id = ?', [newOut, r.out_log_id]);
        await db.run('COMMIT');
    } catch (e) { await db.run('ROLLBACK'); throw e; }
    await audit(db, session.userID, session.name, r.employee_id, name, 'OVERTIME_APPROVED', 'Approved ' + human(m) + (m < r.minutes ? ' of ' + human(r.minutes) : '') + ' of overtime. Clock-out moved from ' + r.capped_out + ' to ' + newOut + ' (UTC).');
    return 'ok';
}
async function deny(db, session, id) {
    await ensure(db);
    const { canManage } = require('./scope');
    const r = await db.get("SELECT * FROM overtime_requests WHERE id = ? AND status = 'PENDING'", [id]);
    if (!r) return 'gone';
    if (r.employee_id === session.userID) return 'own';
    if (!(await canManage(db, session, r.employee_id))) return 'scope';
    await db.run("UPDATE overtime_requests SET status = 'DENIED', approved_minutes = 0, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", [session.userID, id]);
    const name = (await db.get('SELECT name FROM employees WHERE id = ?', [r.employee_id])).name;
    await audit(db, session.userID, session.name, r.employee_id, name, 'OVERTIME_DENIED', 'Denied ' + human(r.minutes) + ' of overtime. The timecard keeps the ' + r.limit_hours + '-hour limit.');
    return 'ok';
}

function mount(app, getDb, wrap) {
    const { canManage } = require('./scope');
    const back = (res, code) => res.redirect('/admin/requests?msg=ot_' + code);
    const needAdmin = (req, res) => { if (req.session.admin !== 1) { res.redirect(req.session.userID ? '/dashboard' : '/'); return true; } return false; };
    app.post('/admin/overtime/:id/approve', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        back(res, await approve(getDb(), req.session, parseInt(req.params.id, 10), (req.body || {}).minutes));
    }));
    app.post('/admin/overtime/:id/deny', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        back(res, await deny(getDb(), req.session, parseInt(req.params.id, 10)));
    }));
    // Set or clear one person's shift limit (from their Edit account page).
    app.post('/admin/accounts/shiftlimit', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = getDb(), id = parseInt((req.body || {}).id, 10), raw = String((req.body || {}).hours || '').trim();
        const to = () => res.redirect('/admin/accounts/edit?id=' + id);
        if (!id || !(await canManage(db, req.session, id))) return res.redirect('/admin/accounts');
        const emp = await db.get('SELECT name FROM employees WHERE id = ?', [id]);
        let hours = null;
        if (raw !== '') { hours = Math.round(parseFloat(raw) * 4) / 4; if (!(hours >= 1 && hours <= 16)) { req.session.flash = { msg: 'Enter a shift limit from 1 to 16 hours, or leave it blank to use the district default.', bad: true }; return to(); } }
        await setLimit(db, req.session.name, id, hours);
        await audit(db, req.session.userID, req.session.name, id, emp.name, 'SHIFT_LIMIT', hours == null ? 'Back to the district default limit' : 'Shift limit set to ' + hours + ' hours');
        req.session.flash = { msg: hours == null ? emp.name + ' now uses the district default shift limit.' : 'Saved. ' + emp.name + "'s shift limit is " + hours + ' hours.' };
        to();
    }));
}

module.exports = mount;
Object.assign(module.exports, { ensure, limitFor, ownLimit, setLimit, decide, record, pendingFor, reviewedFor, mineFor, approve, deny, TOLERANCE_MIN, human });
