// Repair queue: every repair logged through the Repair Logger form becomes an active ticket here.
const bench = require('./bench');

const STATUSES = ['Awaiting Assignment', 'Awaiting Diagnostic', 'Awaiting Repair', 'Awaiting Parts', 'Diagnostic in Progress', 'Quality Assurance Inspection',
    'Repair in Progress', 'Need to Order Parts', 'Repaired - Ready for Pickup', 'Unrepairable', 'Returned to Student'];
const CLOSED = ['Unrepairable', 'Returned to Student'];
const GRADES = ['6', '7', '8', '9', '10', '11', '12', 'Other'];
const FIRST = 'Awaiting Assignment', READY = 'Repaired - Ready for Pickup', PARTS = ['Awaiting Parts', 'Need to Order Parts'];
const OLD = { 'New': FIRST, 'Diagnosing': 'Diagnostic in Progress', 'Waiting on parts': 'Awaiting Parts', 'In repair': 'Repair in Progress', 'Testing': 'Quality Assurance Inspection', 'Ready to return': READY, 'Returned': 'Returned to Student' };
const PRIORITIES = ['Normal', 'High'];
const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const multi = (s, n) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, n || 1000);
const tone = s => s === READY || s === 'Returned to Student' ? 'ok' : PARTS.includes(s) || s === 'Unrepairable' ? 'warn' : s === FIRST ? 'bad' : '';
const sid = s => String(s == null ? '' : s).trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
const nameOf = t => [t.student_first, t.student_last].filter(Boolean).join(' ');

// "2026-10-07 19:20:00" (UTC from SQLite) -> Mountain time, readable
const fmt = ts => {
    if (!ts) return '';
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return String(ts);
    return d.toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const ageDays = (ts, end) => {
    const a = new Date(String(ts).replace(' ', 'T') + 'Z'), b = end ? new Date(String(end).replace(' ', 'T') + 'Z') : new Date();
    return isNaN(a) ? 0 : Math.max(0, Math.floor((b - a) / 86400000));
};

function mount(app, getDb, wrap) {
    let ready = null;
    async function database() {
        const db = getDb();
        if (!ready) {
            ready = db.exec(`
                CREATE TABLE IF NOT EXISTS repair_tickets (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  closed_at TEXT,
                  created_by INTEGER, created_by_name TEXT,
                  model TEXT NOT NULL, serial TEXT DEFAULT '',
                  complaint TEXT DEFAULT '', parts TEXT DEFAULT '', tier TEXT DEFAULT '',
                  priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Awaiting Assignment',
                  student_first TEXT DEFAULT '', student_last TEXT DEFAULT '', student_id TEXT DEFAULT '', student_grade TEXT DEFAULT '',
                  assigned_to INTEGER, assigned_name TEXT DEFAULT '',
                  source TEXT DEFAULT 'form', sheet_row INTEGER, client_ref TEXT UNIQUE
                );
                CREATE TABLE IF NOT EXISTS ticket_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ticket_id INTEGER NOT NULL,
                  at TEXT DEFAULT CURRENT_TIMESTAMP,
                  user_id INTEGER, user_name TEXT,
                  kind TEXT NOT NULL, text TEXT DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_tickets_status ON repair_tickets(status);
                CREATE INDEX IF NOT EXISTS idx_tickets_serial ON repair_tickets(serial);
                CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);`).then(async () => {
                    const cols = (await db.all('PRAGMA table_info(repair_tickets)')).map(c => c.name);
                    for (const c of ['student_first', 'student_last', 'student_id', 'student_grade']) {
                        if (!cols.includes(c)) await db.exec(`ALTER TABLE repair_tickets ADD COLUMN ${c} TEXT DEFAULT ''`);
                    }
                    for (const k of Object.keys(OLD)) await db.run('UPDATE repair_tickets SET status = ? WHERE status = ?', [OLD[k], k]);   // statuses renamed
                }).catch(err => { ready = null; throw err; });
        }
        await ready;
        return db;
    }
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    async function gate(req, res, json) {
        if (!req.session.userID) { json ? res.status(401).json({ ok: false }) : res.redirect('/'); return null; }
        const db = await database();
        if (!(await bench.hasBench(db, req.session))) { json ? res.status(403).json({ ok: false }) : res.redirect('/dashboard'); return null; }
        return db;
    }
    const event = (db, id, req, kind, text) => db.run(
        'INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)',
        [id, req.session.userID, req.session.name || '', kind, text || '']);
    const touch = (db, id) => db.run('UPDATE repair_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    const getTicket = (db, id) => db.get('SELECT * FROM repair_tickets WHERE id = ?', [parseInt(id, 10) || 0]);

    async function people(db) {
        const pid = (await db.get("SELECT id FROM programs WHERE name = 'Student Tech Work Bench'") || {}).id;
        if (!pid) return [];
        return db.all(`SELECT DISTINCT e.id, e.name FROM employees e
            WHERE e.id IN (SELECT employee_id FROM memberships WHERE program_id = ?)
               OR e.id IN (SELECT employee_id FROM scopes WHERE program_id = ? OR program_id IS NULL)
            ORDER BY e.name`, [pid, pid]);
    }
    async function create(db, req, f, source) {
        const model = one(f.model, 120);
        if (!model) return { ok: false, error: 'Choose the device model.' };
        const ref = one(f.client_ref, 60) || null;
        if (ref) { const dup = await db.get('SELECT id FROM repair_tickets WHERE client_ref = ?', [ref]); if (dup) return { ok: true, id: dup.id, duplicate: true }; }
        const stu = { first: one(f.student_first, 40), last: one(f.student_last, 40), id: sid(f.student_id), grade: GRADES.includes(one(f.student_grade, 10)) ? one(f.student_grade, 10) : '' };
        if (source === 'portal') {
            if (!stu.first || !stu.last) return { ok: false, error: 'Enter the student\'s first and last name.' };
            if (!stu.id) return { ok: false, error: 'Enter the student ID number.' };
            if (!stu.grade) return { ok: false, error: 'Choose the student\'s grade.' };
        }
        const row = parseInt(f.sheet_row, 10);
        const r = await db.run(
            `INSERT INTO repair_tickets (created_by, created_by_name, model, serial, complaint, parts, tier, priority, status, source, sheet_row, client_ref,
                student_first, student_last, student_id, student_grade)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [req.session.userID, req.session.name || '', model, one(f.serial, 40), multi(f.complaint, 600), one(f.parts, 400), one(f.tier, 40),
             PRIORITIES.includes(f.priority) ? f.priority : 'Normal', FIRST, source, row > 0 ? row : null, ref, stu.first, stu.last, stu.id, stu.grade]);
        await event(db, r.lastID, req, 'created', source === 'form' ? 'Logged from the Repair Logger form' : 'Created in the portal');
        if (f.notes && multi(f.notes, 600)) await event(db, r.lastID, req, 'note', multi(f.notes, 600));
        return { ok: true, id: r.lastID };
    }

    // ---------- the queue ----------
    const SORTS = { priority: 'Priority, then oldest', newest: 'Newest first', oldest: 'Oldest first', updated: 'Recently updated', longest: 'Open the longest' };
    const day = ts => { const d = new Date(String(ts || '').replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' }); };   // YYYY-MM-DD in Mountain time
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

    app.get('/bench/queue', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const Q = req.query || {};
        const f = {
            q: one(Q.q, 60),
            status: STATUSES.includes(Q.status) ? Q.status : '',
            assignee: one(Q.assignee, 12),                      // '', 'none', 'me' or an employee id
            priority: PRIORITIES.includes(Q.priority) ? Q.priority : '',
            model: one(Q.model, 120),
            from: isDate(Q.from) ? Q.from : '', to: isDate(Q.to) ? Q.to : '',
            sort: SORTS[Q.sort] ? Q.sort : 'priority'
        };
        let view = ['active', 'mine', 'parts', 'ready', 'closed', 'all'].includes(Q.view) ? Q.view : 'active';
        if (f.status && view !== 'mine') view = 'all';          // picking an exact status overrides the tab
        const me = req.session.userID;
        const all = await db.all('SELECT * FROM repair_tickets ORDER BY id DESC LIMIT 5000');
        const isOpen = t => !CLOSED.includes(t.status);
        const count = {
            active: all.filter(isOpen).length,
            mine: all.filter(t => isOpen(t) && t.assigned_to === me).length,
            parts: all.filter(t => PARTS.includes(t.status)).length,
            ready: all.filter(t => t.status === READY).length,
            closed: all.filter(t => !isOpen(t)).length, all: all.length
        };
        let rows = all.filter(t => view === 'all' ? true : view === 'closed' ? !isOpen(t) : view === 'mine' ? isOpen(t) && t.assigned_to === me
            : view === 'parts' ? PARTS.includes(t.status) : view === 'ready' ? t.status === READY : isOpen(t));
        if (f.q) {
            const n = f.q.toLowerCase();
            rows = rows.filter(t => [t.model, t.serial, t.complaint, t.assigned_name, t.status, '#' + t.id, nameOf(t), t.student_id].join(' ').toLowerCase().includes(n));
        }
        if (f.status) rows = rows.filter(t => t.status === f.status);
        if (f.assignee === 'none') rows = rows.filter(t => !t.assigned_to);
        else if (f.assignee === 'me') rows = rows.filter(t => t.assigned_to === me);
        else if (/^\d+$/.test(f.assignee)) rows = rows.filter(t => String(t.assigned_to) === f.assignee);
        if (f.priority) rows = rows.filter(t => t.priority === f.priority);
        if (f.model) rows = rows.filter(t => t.model === f.model);
        if (f.from) rows = rows.filter(t => day(t.created_at) >= f.from);
        if (f.to) rows = rows.filter(t => day(t.created_at) <= f.to);
        const by = {
            priority: (a, b) => (b.priority === 'High') - (a.priority === 'High') || a.id - b.id,
            newest: (a, b) => b.id - a.id, oldest: (a, b) => a.id - b.id,
            updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id,
            longest: (a, b) => ageDays(b.created_at, b.closed_at) - ageDays(a.created_at, a.closed_at) || a.id - b.id
        };
        const sort = (view === 'closed' || view === 'all') && !Q.sort ? 'newest' : f.sort;   // history views default to newest first
        f.sort = sort;
        rows.sort(by[sort]);
        const total = rows.length;
        rows = rows.slice(0, 300).map(t => Object.assign({}, t, { age: ageDays(t.created_at, t.closed_at), tone: tone(t.status), when: fmt(t.created_at), student: nameOf(t) }));
        const devices = await db.all("SELECT d.name FROM devices d JOIN programs p ON p.id = d.program_id WHERE p.name = 'Student Tech Work Bench' ORDER BY d.brand, d.name").catch(() => []);
        const models = [...new Set(all.map(t => t.model))].sort((a, b) => a.localeCompare(b));
        const filterKeys = ['q', 'status', 'assignee', 'priority', 'model', 'from', 'to'];
        const activeFilters = filterKeys.filter(k => f[k]).length;
        const qs = filterKeys.concat(['sort']).filter(k => f[k] && !(k === 'sort' && !Q.sort)).map(k => k + '=' + encodeURIComponent(f[k])).join('&');
        res.render('bench_queue', { flash: takeFlash(req), view, f, sorts: SORTS, count, rows, total, models, activeFilters, qs, people: await people(db),
            devices: devices.map(d => d.name), statuses: STATUSES, grades: GRADES, priorities: PRIORITIES, me });
    }));

    app.post('/bench/queue/new', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const r = await create(db, req, req.body || {}, 'portal');
        if (!r.ok) { flash(req, r.error, true); return res.redirect('/bench/queue'); }
        res.redirect('/bench/ticket?id=' + r.id);
    }));

    // Called by the page after the Google Repair Logger form reports a successful save
    app.post('/bench/queue/from-form', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const r = await create(db, req, req.body || {}, 'form');
        res.status(r.ok ? 200 : 400).json(r);
    }));

    // ---------- one ticket ----------
    app.get('/bench/ticket', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.query.id);
        if (!t) { flash(req, 'That ticket was not found.', true); return res.redirect('/bench/queue'); }
        const events = (await db.all('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC', [t.id])).map(e => Object.assign({}, e, { when: fmt(e.at) }));
        const history = t.serial ? (await db.all('SELECT id, model, status, complaint, created_at FROM repair_tickets WHERE serial = ? COLLATE NOCASE AND id != ? ORDER BY id DESC LIMIT 10', [t.serial, t.id]))
            .map(h => Object.assign({}, h, { when: fmt(h.created_at) })) : [];
        res.render('bench_ticket', {
            flash: takeFlash(req), t: Object.assign({}, t, { student: nameOf(t), age: ageDays(t.created_at, t.closed_at), tone: tone(t.status), when: fmt(t.created_at), closedWhen: fmt(t.closed_at) }),
            events, history, grades: GRADES, statuses: STATUSES, priorities: PRIORITIES, people: await people(db), me: req.session.userID, isAdmin: req.session.admin === 1
        });
    }));

    const back = (res, id) => res.redirect('/bench/ticket?id=' + id);

    app.post('/bench/ticket/status', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const s = one(req.body.status, 40), note = multi(req.body.note, 600);
        if (!STATUSES.includes(s)) { flash(req, 'Choose a status from the list.', true); return back(res, t.id); }
        if (s !== t.status) {
            await db.run('UPDATE repair_tickets SET status = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [s, CLOSED.includes(s) ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null, t.id]);
            await event(db, t.id, req, 'status', t.status + ' → ' + s);
            flash(req, 'Status is now ' + s + '.');
        }
        if (note) { await event(db, t.id, req, 'note', note); await touch(db, t.id); }
        back(res, t.id);
    }));

    app.post('/bench/ticket/note', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const text = multi(req.body.text, 1000);
        if (!text) flash(req, 'Write something first.', true);
        else { await event(db, t.id, req, 'note', text); await touch(db, t.id); flash(req, 'Note added.'); }
        back(res, t.id);
    }));

    app.post('/bench/ticket/assign', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const want = one(req.body.assignee, 20);
        let id = null, name = '';
        if (want === 'me') { id = req.session.userID; name = req.session.name || ''; }
        else if (want) {
            const p = (await people(db)).find(x => String(x.id) === want);
            if (!p) { flash(req, 'That person is not on the Tech Bench.', true); return back(res, t.id); }
            id = p.id; name = p.name;
        }
        if (id !== t.assigned_to) {
            await db.run('UPDATE repair_tickets SET assigned_to = ?, assigned_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id, name, t.id]);
            await event(db, t.id, req, 'assign', id ? 'Assigned to ' + name : 'Unassigned');
            flash(req, id ? 'Assigned to ' + name + '.' : 'Unassigned.');
        }
        back(res, t.id);
    }));

    app.post('/bench/ticket/edit', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const b = req.body, model = one(b.model, 120);
        if (!model) { flash(req, 'The device model cannot be blank.', true); return back(res, t.id); }
        const grade = GRADES.includes(one(b.student_grade, 10)) ? one(b.student_grade, 10) : t.student_grade;
        const n = { student_grade: grade, student_first: one(b.student_first, 40), student_last: one(b.student_last, 40), student_id: sid(b.student_id), model, serial: one(b.serial, 40), complaint: multi(b.complaint, 600), parts: one(b.parts, 400), tier: one(b.tier, 40), priority: PRIORITIES.includes(b.priority) ? b.priority : t.priority };
        const changed = Object.keys(n).filter(k => String(n[k]) !== String(t[k] == null ? '' : t[k]));
        if (changed.length) {
            await db.run('UPDATE repair_tickets SET model=?, serial=?, complaint=?, parts=?, tier=?, priority=?, student_first=?, student_last=?, student_id=?, student_grade=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
                [n.model, n.serial, n.complaint, n.parts, n.tier, n.priority, n.student_first, n.student_last, n.student_id, n.student_grade, t.id]);
            await event(db, t.id, req, 'edit', 'Changed: ' + changed.join(', '));
            flash(req, 'Ticket updated.');
        }
        back(res, t.id);
    }));

    app.post('/bench/ticket/delete', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        if (req.session.admin !== 1) { flash(req, 'Only managers can delete a ticket.', true); return back(res, req.body && req.body.id); }
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        await db.run('DELETE FROM ticket_events WHERE ticket_id = ?', [t.id]);
        await db.run('DELETE FROM repair_tickets WHERE id = ?', [t.id]);
        flash(req, 'Ticket #' + t.id + ' deleted.');
        res.redirect('/bench/queue');
    }));
}

module.exports = mount;
module.exports.STATUSES = STATUSES;
