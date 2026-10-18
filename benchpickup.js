// Pickup sign-off, the no-login status page, monthly school statements, and the admin health check.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bench = require('./bench');
const tiers = require('./tiers');
const L = require('./ticketlib');
const { CLOSED, READY, one, multi } = L;

const RELATIONS = ['Student', 'Parent or guardian', 'Teacher or staff', 'Someone else'];
const FRIENDLY = {
    'Awaiting Assignment': ['Checked in', 'Your device is checked in and waiting for a technician.', 1],
    'Awaiting Diagnostic': ['Checked in', 'Your device is checked in and waiting to be looked at.', 1],
    'Diagnostic in Progress': ['Being diagnosed', 'A technician is working out what is wrong.', 2],
    'Awaiting Repair': ['Waiting to be repaired', 'We know the problem and the repair is next in line.', 2],
    'Awaiting Parts': ['Waiting on a part', 'The repair needs a part that we are waiting for.', 2],
    'Need to Order Parts': ['Waiting on a part', 'The repair needs a part that we are ordering.', 2],
    'Repair in Progress': ['Being repaired', 'A technician is repairing your device.', 3],
    'Quality Assurance Inspection': ['Final checks', 'The repair is done and is being checked.', 3],
    'Repaired - Ready for Pickup': ['Ready for pickup', 'Your device is repaired. Please pick it up at the Tech Bench.', 4],
    'Returned to Student': ['Returned', 'Your device has been picked up.', 5],
    'Unrepairable': ['Could not be repaired', 'We were not able to repair this device. Please see the Tech Bench.', 5]
};
const STEPS = ['Checked in', 'Being looked at', 'Being repaired', 'Ready for pickup'];

// lightweight per-address limit for the public page
const hits = new Map();
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); if (hits.size > 5000) hits.clear(); return a.length > 40; };

async function dirSize(dir) {
    let bytes = 0, files = 0;
    try { for (const f of await fs.promises.readdir(dir)) { const st = await fs.promises.stat(path.join(dir, f)).catch(() => null); if (st && st.isFile()) { bytes += st.size; files++; } } } catch (e) {}
    return { bytes, files };
}
const mb = b => Math.round(b / 1048576 * 10) / 10;
const ago = ms => { const h = ms / 3600000; return h < 1 ? Math.round(ms / 60000) + ' minutes ago' : h < 48 ? Math.round(h) + ' hours ago' : Math.round(h / 24) + ' days ago'; };

async function healthChecks(db) {
    await L.ensureSchema(db);
    const dbFile = path.resolve(process.env.DB_PATH || './timecards.db'), dataDir = path.dirname(dbFile);
    const out = [];
    const add = (name, state, detail) => out.push({ name, state, detail });   // state: ok | warn | bad
    // backups
    const bdir = path.join(dataDir, 'backups');
    const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => /^timecards-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort() : [];
    if (!backups.length) add('Daily backup', 'bad', 'No backup file found. Backups are written once a day next to the database.');
    else { const st = fs.statSync(path.join(bdir, backups[backups.length - 1])), age = Date.now() - st.mtimeMs; add('Daily backup', age > 3 * 86400000 ? 'bad' : age > 36 * 3600000 ? 'warn' : 'ok', 'Newest backup ' + ago(age) + ' (' + backups.length + ' kept, ' + mb(st.size) + ' MB each).'); }
    const last = await L.getSetting(db, 'last_backup_download', '');
    add('Last manual download', last ? 'ok' : 'warn', last ? 'Downloaded ' + last + '.' : 'Nobody has downloaded a backup copy yet. Keep one off the server too.');
    // disk
    let dbSize = 0; try { dbSize = fs.statSync(dbFile).size; } catch (e) {}
    const up = await dirSize(L.uploadDir()), bk = await dirSize(bdir);
    add('Database size', 'ok', mb(dbSize) + ' MB');
    add('Repair photos', up.files ? 'warn' : 'ok', up.files + ' photo' + (up.files === 1 ? '' : 's') + ', ' + mb(up.bytes) + ' MB. ' + (up.files ? 'Photos are NOT included in the daily database backups, so back them up separately.' : ''));
    if (fs.promises.statfs) {
        try { const s = await fs.promises.statfs(dataDir), free = s.bavail * s.bsize, total = s.blocks * s.bsize, pct = total ? free / total : 1;
            add('Disk space', pct < 0.05 ? 'bad' : pct < 0.15 ? 'warn' : 'ok', mb(free) + ' MB free of ' + mb(total) + ' MB (' + Math.round(pct * 100) + '% free). Backups use ' + mb(bk.bytes) + ' MB.'); } catch (e) { add('Disk space', 'warn', 'Could not read the disk size.'); }
    }
    // clock-out sweeper
    const lastRun = await L.getSetting(db, 'autoclock_last_run', '');
    const cfgOn = (await L.getSetting(db, 'autoclock_enabled', '1')) === '1';
    const runAge = lastRun ? Date.now() - Date.parse(lastRun.replace(' ', 'T') + 'Z') : null;
    add('Auto clock-out', !cfgOn ? 'warn' : runAge == null ? 'warn' : runAge > 20 * 60000 ? 'bad' : 'ok', !cfgOn ? 'Turned off.' : runAge == null ? 'Has not run yet since the last restart.' : 'Last checked ' + ago(runAge) + '.');
    const stale = (await db.get(`SELECT COUNT(*) AS n FROM logs l WHERE l.action = 'CLOCK_IN' AND l.id = (SELECT id FROM logs x WHERE x.employee_id = l.employee_id ORDER BY x.timestamp DESC, x.id DESC LIMIT 1) AND l.timestamp < datetime('now', '-16 hours')`)).n;
    add('Shifts left open', stale ? 'warn' : 'ok', stale ? stale + ' shift' + (stale === 1 ? ' has' : 's have') + ' been open for over 16 hours.' : 'None.');
    // sheet + email
    const sheet = require('./sheet');
    add('Google Sheet connection', sheet.configured() ? 'ok' : 'warn', sheet.configured() ? 'Connected.' : 'Not set up (the forms are used inside the portal instead).');
    const fails = await db.get("SELECT COUNT(*) AS n FROM sheet_submissions WHERE status != 'ok' AND at > datetime('now', '-7 days')").catch(() => ({ n: 0 }));
    add('Sheet errors this week', fails.n ? 'warn' : 'ok', fails.n ? fails.n + ' submission' + (fails.n === 1 ? '' : 's') + ' did not reach the sheet. See the Sheet connection page.' : 'None.');
    add('Email alerts', require('./notify').configured() ? 'ok' : 'warn', require('./notify').configured() ? 'Ready to send.' : 'Not set up.');
    // security basics
    add('Session secret', process.env.SESSION_SECRET ? 'ok' : 'bad', process.env.SESSION_SECRET ? 'Set in Render.' : 'SESSION_SECRET is not set, so the built-in fallback key is in use. Set it in Render.');
    add('Admin starter password', process.env.ADMIN_PASSWORD ? 'ok' : 'warn', process.env.ADMIN_PASSWORD ? 'Set in Render.' : 'ADMIN_PASSWORD is not set. Make sure the starter admin password was changed.');
    // counts
    const n = async q => (await db.get(q)).n;
    add('Records', 'ok', (await n('SELECT COUNT(*) AS n FROM employees')) + ' accounts, ' + (await n('SELECT COUNT(*) AS n FROM repair_tickets')) + ' repair tickets, ' + (await n('SELECT COUNT(*) AS n FROM logs')) + ' punches.');
    add('Server', 'ok', 'Up ' + Math.round(process.uptime() / 3600 * 10) / 10 + ' hours, Node ' + process.version + ', memory ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB.');
    return out;
}

function mount(app, getDb, wrap) {
    async function gate(req, res, managersOnly, json) {
        if (!req.session.userID) { res.redirect('/'); return null; }
        const db = getDb(); await L.ensureSchema(db);
        if (!(await bench.hasBench(db, req.session))) { res.redirect('/dashboard'); return null; }
        if (managersOnly && req.session.admin !== 1) { res.redirect('/bench/queue'); return null; }
        return db;
    }
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const event = (db, id, req, kind, text) => db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [id, req.session.userID, req.session.name || '', kind, text || '']);

    // ----- pickup sign-off -----
    app.post('/bench/ticket/pickup', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await db.get('SELECT * FROM repair_tickets WHERE id = ?', [parseInt(req.body.id, 10) || 0]); if (!t) return res.redirect('/bench/queue');
        const back = () => res.redirect('/bench/ticket?id=' + t.id);
        const by = one(req.body.by, 80), rel = RELATIONS.includes(req.body.rel) ? req.body.rel : '';
        if (t.status !== READY) { flash(req, 'Only a ticket that is Repaired - Ready for Pickup can be handed over.', true); return back(); }
        if (!by || !rel) { flash(req, 'Enter who picked it up and choose their relationship to the student.', true); return back(); }
        const checked = req.body.id_checked === '1' ? 1 : 0, note = multi(req.body.note, 300);
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        await db.run('UPDATE repair_tickets SET status = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP, pickup_by = ?, pickup_rel = ?, pickup_at = ?, pickup_note = ?, pickup_id_checked = ? WHERE id = ?',
            ['Returned to Student', now, by, rel, now, note, checked, t.id]);
        await event(db, t.id, req, 'status', t.status + ' → Returned to Student');
        await event(db, t.id, req, 'pickup', 'Handed over to ' + by + ' (' + rel.toLowerCase() + ')' + (checked ? ', ID checked' : ', ID not checked') + (note ? '. ' + note : ''));
        flash(req, 'Recorded. The ticket is closed as Returned to Student.'); back();
    }));

    // ----- status link -----
    app.post('/bench/ticket/statuslink', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await db.get('SELECT * FROM repair_tickets WHERE id = ?', [parseInt(req.body.id, 10) || 0]); if (!t) return res.redirect('/bench/queue');
        const rotate = req.body.rotate === '1' && req.session.admin === 1;
        if (!t.status_token || rotate) {
            await db.run('UPDATE repair_tickets SET status_token = ? WHERE id = ?', [crypto.randomBytes(10).toString('hex'), t.id]);
            await event(db, t.id, req, 'link', rotate ? 'Made a new status link (the old one stopped working)' : 'Made a status link');
            await L.audit(db, req.session, 'STATUS_LINK', (rotate ? 'Replaced' : 'Created') + ' the status link for ticket #' + t.id);
        }
        res.redirect('/bench/ticket?id=' + t.id + '#statuslink');
    }));

    // Public: no sign-in. Shows only the device model and where it is in the process.
    app.get('/status/:token', wrap(async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
        if (limited(req.ip || 'x')) return res.status(429).type('text').send('Too many requests. Please wait a minute.');
        const token = String(req.params.token || '');
        const db = getDb(); await L.ensureSchema(db);
        const t = /^[a-f0-9]{20}$/.test(token) ? await db.get('SELECT model, status, updated_at, created_at FROM repair_tickets WHERE status_token = ?', [token]) : null;
        if (!t) return res.status(404).render('status_public', { found: false });
        const f = FRIENDLY[t.status] || [t.status, '', 1];
        res.render('status_public', { found: true, model: t.model, title: f[0], text: f[1], step: Math.min(f[2], 4), done: f[2] >= 4, steps: STEPS, checkedIn: L.day(t.created_at), updated: L.day(t.updated_at), returned: t.status === 'Returned to Student', bad: t.status === 'Unrepairable' });
    }));

    // ----- school statements -----
    async function statementData(db, month) {
        const fin = await require('./benchbrain').finishTimes(db);
        const rows = (await db.all('SELECT * FROM repair_tickets ORDER BY id')).filter(t => fin.has(t.id) && L.day(fin.get(t.id)).slice(0, 7) === month);
        const bySchool = new Map();
        for (const t of rows) {
            const key = t.site_name || 'School not recorded', n = tiers.num(t.tier), fee = n ? tiers.TIERS[n].fee : 0;
            if (!bySchool.has(key)) bySchool.set(key, { school: key, items: [], total: 0, byTier: [0, 0, 0, 0, 0] });
            const s = bySchool.get(key); s.items.push({ id: t.id, model: t.model, serial: t.serial, finished: L.day(fin.get(t.id)), tier: n ? tiers.label(n) : 'Tier not set', fee, student: L.nameOf(t) });
            s.total += fee; s.byTier[n || 0]++;
        }
        const schools = [...bySchool.values()].sort((a, b) => a.school.localeCompare(b.school));
        return { schools, grand: schools.reduce((a, s) => a + s.total, 0), count: rows.length };
    }
    const monthOf = q => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(q || '')) ? q : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' }).slice(0, 7);
    app.get('/bench/statements', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const month = monthOf(req.query.month), d = await statementData(db, month);
        const label = new Date(month + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        res.render('bench_statements', { month, label, schools: d.schools, grand: d.grand, count: d.count, TIERS: tiers.TIERS, issued: new Date().toLocaleDateString('en-US') });
    }));
    app.get('/bench/statements.csv', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const month = monthOf(req.query.month), d = await statementData(db, month);
        const lines = [['School', 'Ticket', 'Finished', 'Device', 'Serial', 'Tier', 'Fee'].join(',')];
        d.schools.forEach(s => s.items.forEach(i => lines.push([s.school, i.id, i.finished, i.model, i.serial, i.tier, i.fee].map(L.csvCell).join(','))));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bench-statement-' + month + '.csv"' });
        res.send('﻿' + lines.join('\r\n') + '\r\n');
    }));

    // ----- health check -----
    app.get('/admin/health', wrap(async (req, res) => {
        if (req.session.district !== 1) return res.redirect(req.session.userID ? '/dashboard' : '/');
        const db = getDb();
        const checks = await healthChecks(db);
        res.render('admin_health', { checks, bad: checks.filter(c => c.state === 'bad').length, warn: checks.filter(c => c.state === 'warn').length, now: new Date().toLocaleString('en-US') });
    }));
}

module.exports = mount;
Object.assign(module.exports, { healthChecks, RELATIONS, FRIENDLY });
