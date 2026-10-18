// Auto clock-out: when someone forgets to clock out, the portal closes the shift for them.
// The shift is credited only up to the limit (max hours, or the daily cutoff if that comes first), never up to the moment it was noticed,
// so a forgotten punch can never turn into a very long paid shift. Managers can still correct the time on Edit timecards.
const DEFAULTS = { enabled: true, maxHours: 8, cutoff: '' };
const pad = n => String(n).padStart(2, '0');
const utcStamp = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
const parseUtc = s => { const t = Date.parse(String(s).replace(' ', 'T') + 'Z'); return isNaN(t) ? null : t; };
const validCutoff = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

let ensured = null;
async function ensure(db) {
    if (!ensured) ensured = (async () => {
        await db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_by TEXT DEFAULT '');
            CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor_id INTEGER, actor_name TEXT, target_id INTEGER, target_name TEXT, action TEXT NOT NULL, details TEXT, reason TEXT);`);
        const cols = (await db.all('PRAGMA table_info(logs)')).map(c => c.name);
        if (!cols.includes('auto')) await db.run('ALTER TABLE logs ADD COLUMN auto INTEGER DEFAULT 0');
    })().catch(e => { ensured = null; throw e; });
    return ensured;
}

async function getSettings(db) {
    await ensure(db);
    const m = {}; (await db.all("SELECT key, value FROM app_settings WHERE key LIKE 'autoclock_%'")).forEach(r => m[r.key] = r.value);
    const hrs = parseFloat(m.autoclock_max_hours);
    return {
        enabled: m.autoclock_enabled === undefined ? DEFAULTS.enabled : m.autoclock_enabled === '1',
        maxHours: hrs >= 1 && hrs <= 16 ? hrs : DEFAULTS.maxHours,
        cutoff: validCutoff(m.autoclock_cutoff) ? m.autoclock_cutoff : DEFAULTS.cutoff
    };
}
async function saveSettings(db, who, v) {
    await ensure(db);
    const set = (k, val) => db.run('INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,CURRENT_TIMESTAMP,?)', [k, String(val), who]);
    await set('autoclock_enabled', v.enabled ? '1' : '0');
    await set('autoclock_max_hours', v.maxHours);
    await set('autoclock_cutoff', v.cutoff || '');
}

// The moment a forgotten shift is closed at: the clock-in plus max hours, or the cutoff time that day, whichever is earlier.
function plannedOut(inStamp, cfg) {
    const inMs = parseUtc(inStamp); if (inMs == null) return null;
    let out = inMs + cfg.maxHours * 3600000;
    if (cfg.cutoff) {
        const d = new Date(inMs), [h, m] = cfg.cutoff.split(':').map(Number);
        const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0).getTime();   // server-local day, like the rest of the portal
        if (c > inMs && c < out) out = c;
    }
    return new Date(out);
}

// Closes every shift that is past its limit. Safe to run as often as you like.
async function sweep(db, now = new Date()) {
    const cfg = await getSettings(db);
    const closed = [];
    if (!cfg.enabled) return { cfg, closed };
    const open = await db.all(`SELECT l.id, l.employee_id, l.timestamp, e.name FROM logs l JOIN employees e ON e.id = l.employee_id
        WHERE l.action = 'CLOCK_IN' AND l.id = (SELECT id FROM logs x WHERE x.employee_id = l.employee_id ORDER BY x.timestamp DESC, x.id DESC LIMIT 1)`);
    for (const o of open) {
        const out = plannedOut(o.timestamp, cfg);
        if (!out || out > now) continue;
        const still = await db.get("SELECT 1 AS x FROM logs WHERE id = ? AND id = (SELECT id FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1)", [o.id, o.employee_id]);
        if (!still) continue;
        await db.run("INSERT INTO logs (employee_id, action, timestamp, auto) VALUES (?, 'CLOCK_OUT', ?, 1)", [o.employee_id, utcStamp(out)]);
        const hrs = ((out.getTime() - parseUtc(o.timestamp)) / 3600000).toFixed(2);
        await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)',
            [null, 'System', o.employee_id, o.name, 'AUTO_CLOCKOUT', 'Forgot to clock out. Closed the shift after ' + hrs + ' hours.', '']);
        closed.push({ id: o.employee_id, name: o.name, hours: Number(hrs) });
    }
    return { cfg, closed };
}

function start(getDb, everyMs = 5 * 60 * 1000) {
    const tick = async () => { try { const db0 = getDb(); const r = await sweep(db0); await db0.run("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('autoclock_last_run', datetime('now'), datetime('now'))"); if (r.closed.length) console.log('Auto clock-out closed ' + r.closed.length + ' forgotten shift(s).'); } catch (e) { console.error('Auto clock-out check failed:', e.message); } };
    setTimeout(tick, 15000).unref();
    setInterval(tick, everyMs).unref();
}

// A short notice for the dashboard when the newest punch was an automatic clock-out.
async function noticeFor(db, employeeId, now = new Date()) {
    await ensure(db);
    const r = await db.get("SELECT action, auto, timestamp, datetime(timestamp, 'localtime') AS local FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1", [employeeId]);
    if (!r || r.action !== 'CLOCK_OUT' || r.auto !== 1) return null;
    const t = parseUtc(r.timestamp);
    if (t == null || now - t > 3 * 86400000) return null;
    return 'You forgot to clock out, so the system clocked you out automatically at ' + r.local + '. If that time is wrong, ask your manager to fix it on Edit timecards.';
}

function mount(app, getDb, wrap) {
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const gate = (req, res) => { if (req.session.district !== 1) { res.redirect(req.session.userID ? '/dashboard' : '/'); return false; } return true; };
    app.get('/admin/autoclock', wrap(async (req, res) => {
        if (!gate(req, res)) return;
        const db = getDb(), cfg = await getSettings(db);
        const recent = await db.all("SELECT datetime(at, 'localtime') AS at, target_name, details FROM audit_log WHERE action = 'AUTO_CLOCKOUT' ORDER BY id DESC LIMIT 25");
        res.render('admin_autoclock', { flash: takeFlash(req), cfg, recent });
    }));
    app.post('/admin/autoclock', wrap(async (req, res) => {
        if (!gate(req, res)) return;
        const db = getDb(), b = req.body || {};
        const maxHours = parseFloat(b.max_hours), cutoff = String(b.cutoff || '').trim();
        if (!(maxHours >= 1 && maxHours <= 16)) { flash(req, 'Enter a number of hours from 1 to 16.', true); return res.redirect('/admin/autoclock'); }
        if (cutoff && !validCutoff(cutoff)) { flash(req, 'Enter the cutoff time like 15:30, or leave it blank.', true); return res.redirect('/admin/autoclock'); }
        const v = { enabled: b.enabled === '1', maxHours: Math.round(maxHours * 4) / 4, cutoff };
        await saveSettings(db, req.session.name || '', v);
        await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)',
            [req.session.userID, req.session.name || '', null, '', 'AUTOCLOCK_SETTINGS', (v.enabled ? 'On' : 'Off') + ', max ' + v.maxHours + ' hours' + (v.cutoff ? ', daily cutoff ' + v.cutoff : ', no daily cutoff'), '']);
        const r = await sweep(db);
        flash(req, 'Saved.' + (r.closed.length ? ' ' + r.closed.length + ' forgotten shift(s) were closed right away.' : ''));
        res.redirect('/admin/autoclock');
    }));
}

module.exports = mount;
Object.assign(module.exports, { ensure, getSettings, saveSettings, plannedOut, sweep, start, noticeFor, DEFAULTS });
