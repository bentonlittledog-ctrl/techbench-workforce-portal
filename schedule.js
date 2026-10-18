// Schedule windows: when each site's students are expected to clock in.
// Two modes per site: "flag" lets the punch through and records it as outside the schedule for managers to review,
// "block" refuses the clock-in. Clocking OUT is never blocked. Managers and district accounts are never restricted.
// Sites with no schedule (and no built-in preset) are unrestricted. Times are Mountain time.
const TZ = 'America/Denver';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const validTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmt12 = t => { const [h, m] = t.split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };

// Built-in starting points, matched on the site name. A saved schedule always wins over these.
const PRESETS = {
    glacier_flathead: { label: 'Glacier / Flathead bell schedule (before school to after school; shorter on early-release days)', days: { 1: ['07:30', '15:35'], 2: ['07:30', '15:35'], 3: ['07:30', '15:35'], 4: ['07:30', '15:35'], 5: ['07:30', '15:35'] }, er: ['07:15', '14:15'] },
    linderman: { label: 'Linderman bell schedule (shorter on early-dismissal days)', days: { 1: ['08:15', '15:15'], 2: ['08:15', '15:15'], 3: ['08:15', '15:15'], 4: ['08:15', '15:15'], 5: ['08:15', '15:15'] }, er: ['08:15', '13:45'] }
};
const presetFor = name => /linderman/i.test(name || '') ? 'linderman' : /glacier|flathead/i.test(name || '') ? 'glacier_flathead' : null;

let ensured = null;
async function ensure(db) {
    if (!ensured) ensured = db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_by TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor_id INTEGER, actor_name TEXT, target_id INTEGER, target_name TEXT, action TEXT NOT NULL, details TEXT, reason TEXT);`).catch(e => { ensured = null; throw e; });
    return ensured;
}
const getVal = async (db, k) => { const r = await db.get('SELECT value FROM app_settings WHERE key = ?', [k]); return r ? r.value : null; };
const setVal = (db, k, v, who) => db.run('INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,CURRENT_TIMESTAMP,?)', [k, String(v), who || '']);

// A site's schedule: { mode: 'off'|'flag'|'block', grace: minutes, days: { 0-6: [start, end] }, preset: bool }
function cleanConfig(c) {
    const out = { mode: ['off', 'flag', 'block'].includes(c && c.mode) ? c.mode : 'flag', grace: 10, days: {} };
    const g = parseInt(c && c.grace, 10); if (g >= 0 && g <= 120) out.grace = g;
    for (let d = 0; d < 7; d++) { const w = c && c.days && c.days[d]; if (w && validTime(w[0]) && validTime(w[1]) && toMin(w[0]) < toMin(w[1])) out.days[d] = [w[0], w[1]]; }
    const e = c && c.er; if (e && validTime(e[0]) && validTime(e[1]) && toMin(e[0]) < toMin(e[1])) out.er = [e[0], e[1]];
    return out;
}
async function getSiteConfig(db, site) {
    await ensure(db);
    const raw = await getVal(db, 'sched_' + site.id);
    if (raw) { try { return Object.assign(cleanConfig(JSON.parse(raw)), { preset: false }); } catch (e) { /* fall through to preset */ } }
    const p = presetFor(site.name);
    return p ? Object.assign(cleanConfig({ mode: 'flag', grace: 10, days: PRESETS[p].days, er: PRESETS[p].er }), { preset: true }) : null;
}
async function saveSiteConfig(db, who, siteId, cfg) { await ensure(db); await setVal(db, 'sched_' + siteId, JSON.stringify(cleanConfig(cfg)), who); }

const noSchoolDays = async db => { await ensure(db); return String(await getVal(db, 'sched_noschool') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)); };
const saveNoSchool = async (db, who, list) => { await ensure(db); await setVal(db, 'sched_noschool', [...new Set(list.filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort().join(','), who); };

// Mountain-time pieces of a moment.
function localParts(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
    return { dow: WEEKDAY[p.weekday], date: p.year + '-' + p.month + '-' + p.day, min: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10) };
}


// ---------- The district calendar (no school, early release, ...) ----------
// Kinds: ER early release, NS no school, PIR no school (staff day), TR trade-off day (no school), MF music festival (no school), FIRST first day.
const NO_SCHOOL = new Set(['NS', 'PIR', 'TR', 'MF']);
const KIND_NAMES = { ER: 'Early release', NS: 'No school', PIR: 'No school (staff day)', TR: 'No school (trade-off day)', MF: 'No school (music festival)', FIRST: 'First day of school' };
const SCHOOL_YEAR = { first: '2026-08-26', last: '2027-06-09', from: '2026-07-01', to: '2027-06-30' };   // the range the seeded calendar covers
async function ensureCalendar(db) {
    await ensure(db);
    await db.exec('CREATE TABLE IF NOT EXISTS school_calendar (date TEXT PRIMARY KEY, kind TEXT NOT NULL, note TEXT DEFAULT \'\')');
    const n = await db.get('SELECT COUNT(*) AS n FROM school_calendar');
    if (!n || !n.n) {
        let rows = []; try { rows = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'calendar_2026_27.json'), 'utf8')); } catch (e) { /* no seed file: the calendar starts empty */ }
        for (const [d, k, note] of rows) await db.run('INSERT OR IGNORE INTO school_calendar (date, kind, note) VALUES (?,?,?)', [d, k, note || '']);
        for (const [k, v] of [['cal_first', SCHOOL_YEAR.first], ['cal_last', SCHOOL_YEAR.last]]) await db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?,?)', [k, v]);
    }
}
async function calendarMap(db) { await ensureCalendar(db); const m = new Map(); (await db.all('SELECT date, kind, note FROM school_calendar')).forEach(r => m.set(r.date, r)); return m; }
async function schoolYear(db) { await ensureCalendar(db); return { first: (await getVal(db, 'cal_first')) || SCHOOL_YEAR.first, last: (await getVal(db, 'cal_last')) || SCHOOL_YEAR.last }; }

// What a given date looks like: { school: bool, kind, note, early: bool }.
function dayInfo(date, dow, cal, year, extraNoSchool) {
    const e = cal.get(date);
    if (e && NO_SCHOOL.has(e.kind)) return { school: false, kind: e.kind, note: e.note };
    if (extraNoSchool && extraNoSchool.includes(date)) return { school: false, kind: 'NS', note: 'No school' };
    if (dow === 0 || dow === 6) return { school: false, kind: 'WEEKEND', note: '' };
    if (date >= SCHOOL_YEAR.from && date <= SCHOOL_YEAR.to) {            // the calendar covers this date: trust it
        if (date < year.first || date > year.last) return { school: false, kind: 'SUMMER', note: 'Summer break' };
        return { school: true, kind: e ? e.kind : '', note: e ? e.note : '', early: !!(e && e.kind === 'ER') };
    }
    return { school: true, kind: e ? e.kind : '', note: e ? e.note : '', early: e ? e.kind === 'ER' : dow === 3 };   // outside the seeded calendar: Wednesdays are early release
}
const windowFor = (cfg, dow, info) => (info.early && cfg.er) ? cfg.er : (cfg.days[dow] || null);
const windowText = w => w ? fmt12(w[0]) + ' to ' + fmt12(w[1]) : null;

// ---------- Which schedule an account follows ----------
// '' = its own school's schedule (default), 'none' = never restricted, 'site:<id>' = another school's schedule.
async function getAssignment(db, id) { await ensure(db); return (await getVal(db, 'sched_emp_' + id)) || ''; }
async function setAssignment(db, who, id, v) { await ensure(db); if (!v) await db.run('DELETE FROM app_settings WHERE key = ?', ['sched_emp_' + id]); else await setVal(db, 'sched_emp_' + id, v, who); }
// The schedules that apply to this account: [{ site, cfg }]. Empty means unrestricted.
async function configsFor(db, id) {
    const a = await getAssignment(db, id);
    if (a === 'none') return [];
    let sites;
    const m = /^site:(\d+)$/.exec(a);
    if (m) sites = await db.all('SELECT id, name FROM sites WHERE id = ?', [parseInt(m[1], 10)]);
    else sites = await db.all('SELECT DISTINCT s.id, s.name FROM memberships m JOIN sites s ON s.id = m.site_id WHERE m.employee_id = ?', [id]);
    const out = [];
    for (const s of sites) { const c = await getSiteConfig(db, s); if (c && c.mode !== 'off') out.push({ site: s, cfg: c }); }
    return out;
}

// Is this clock-in inside the account's schedule? Returns { ok, mode, text }.
async function check(db, employeeId, now = new Date()) {
    await ensure(db);
    const emp = await db.get('SELECT is_admin, is_district FROM employees WHERE id = ?', [employeeId]);
    if (!emp || emp.is_admin || emp.is_district) return { ok: true };
    const configs = await configsFor(db, employeeId);
    if (!configs.length) return { ok: true };
    const t = localParts(now);
    const info = dayInfo(t.date, t.dow, await calendarMap(db), await schoolYear(db), await noSchoolDays(db));
    if (!info.school && info.kind !== 'WEEKEND' && info.kind !== 'SUMMER') return { ok: true, reason: 'no school' };
    if (info.kind === 'SUMMER') return { ok: true, reason: 'summer' };
    if ((await getVal(db, 'sched_allow_' + employeeId)) === t.date) return { ok: true, reason: 'allowed today' };
    for (const { cfg } of configs) { const w = windowFor(cfg, t.dow, info); if (w && t.min >= toMin(w[0]) - cfg.grace && t.min <= toMin(w[1]) + cfg.grace) return { ok: true }; }
    const first = configs[0];
    return { ok: false, mode: first.cfg.mode, site: first.site.name, text: windowText(windowFor(first.cfg, t.dow, info)) || 'no clock-ins today', day: DAYS[t.dow] };
}

// The next days for one account: [{ date, day, kind, label, window }]
async function upcoming(db, employeeId, days = 14, now = new Date()) {
    const configs = await configsFor(db, employeeId), cal = await calendarMap(db), year = await schoolYear(db), extra = await noSchoolDays(db);
    const t0 = localParts(now), out = [];
    const base = new Date(t0.date + 'T12:00:00Z');
    for (let i = 0; i < days; i++) {
        const d = new Date(base.getTime() + i * 86400000), date = d.toISOString().slice(0, 10), dow = d.getUTCDay();
        const info = dayInfo(date, dow, cal, year, extra);
        let label = '', window = null;
        if (!info.school) label = info.kind === 'WEEKEND' ? 'Weekend' : (info.note || KIND_NAMES[info.kind] || 'No school');
        else {
            label = info.early ? 'Early release day' : 'Regular day';
            if (info.note && !/^(Early release)/i.test(info.note)) label += ' · ' + info.note;
            if (configs.length) { const ws = configs.map(c => windowFor(c.cfg, dow, info)).filter(Boolean); if (ws.length) window = windowText([ws.map(w => w[0]).sort()[0], ws.map(w => w[1]).sort().slice(-1)[0]]); else label += ' · no clock-ins'; }
        }
        out.push({ date, day: DAYS[dow], today: i === 0, school: info.school, early: !!info.early, label, window });
    }
    return out;
}

async function audit(db, session, targetId, targetName, action, details) {
    await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)',
        [session ? session.userID : null, session ? session.name || '' : 'System', targetId || null, targetName || '', action, details, '']);
}

// Called by /punch before a clock-in. Returns { allow, message } and records flags/blocks.
async function gate(db, session, now = new Date()) {
    const r = await check(db, session.userID, now);
    if (r.ok) return { allow: true };
    const when = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(now);
    if (r.mode === 'block') {
        await audit(db, null, session.userID, session.name, 'PUNCH_BLOCKED', 'Clock-in refused at ' + when + ' on ' + r.day + ' (' + r.site + ' allows ' + r.text + ').');
        return { allow: false, message: 'You can not clock in right now. ' + r.site + ' clock-ins are allowed ' + r.text + ' on ' + r.day + 's. If you are working outside those hours, ask a manager to allow it.' };
    }
    await audit(db, null, session.userID, session.name, 'OFF_SCHEDULE_PUNCH', 'Clocked in at ' + when + ' on ' + r.day + ', outside the ' + r.site + ' schedule (' + r.text + ').');
    return { allow: true, message: 'You are clocked in, but this is outside your usual schedule (' + r.text + '), so your manager will see it flagged.' };
}

function mount(app, getDb, wrap) {
    const scope = require('./scope');
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const needAdmin = (req, res) => { if (req.session.admin !== 1) { res.redirect(req.session.userID ? '/dashboard' : '/'); return false; } return true; };
    const needDistrict = (req, res) => { if (req.session.district !== 1) { res.redirect(req.session.userID ? '/dashboard' : '/'); return false; } return true; };

    app.get('/admin/schedules', wrap(async (req, res) => {
        if (!needAdmin(req, res)) return;
        const db = getDb(); await ensure(db);
        const sites = await db.all('SELECT id, name FROM sites ORDER BY name');
        const rows = [];
        for (const s of sites) rows.push({ site: s, cfg: await getSiteConfig(db, s) });
        const t = localParts();
        const people = (await scope.manageableAccounts(db, req.session)).filter(a => !a.is_admin && !a.is_district);
        for (const p of people) p.allowed = (await getVal(db, 'sched_allow_' + p.id)) === t.date;
        const recent = await db.all("SELECT datetime(at, 'localtime') AS at, target_name, action, details FROM audit_log WHERE action IN ('OFF_SCHEDULE_PUNCH','PUNCH_BLOCKED') ORDER BY id DESC LIMIT 40");
        await ensureCalendar(db);
        const calendar = await db.all("SELECT date, kind, note FROM school_calendar WHERE date >= ? ORDER BY date", [t.date]);
        res.render('admin_schedules', { flash: takeFlash(req), calendar, KIND_NAMES, rows, DAYS, isDistrict: req.session.district === 1, noSchool: (await noSchoolDays(db)).join('\n'), people, recent, today: t.date, PRESETS });
    }));

    app.post('/admin/schedules', wrap(async (req, res) => {
        if (!needDistrict(req, res)) return;
        const db = getDb(), b = req.body || {};
        const site = await db.get('SELECT id, name FROM sites WHERE id = ?', [parseInt(b.site_id, 10)]);
        if (!site) { flash(req, 'That site was not found.', true); return res.redirect('/admin/schedules'); }
        const days = {};
        for (let d = 0; d < 7; d++) {
            const a = String(b['start_' + d] || '').trim(), z = String(b['end_' + d] || '').trim();
            if (!a && !z) continue;
            if (!validTime(a) || !validTime(z) || toMin(a) >= toMin(z)) { flash(req, DAYS[d] + ': enter a start time before the end time, or leave both blank.', true); return res.redirect('/admin/schedules'); }
            days[d] = [a, z];
        }
        const ea = String(b.er_start || '').trim(), ez = String(b.er_end || '').trim();
        if ((ea || ez) && (!validTime(ea) || !validTime(ez) || toMin(ea) >= toMin(ez))) { flash(req, 'Early release: enter a start time before the end time, or leave both blank.', true); return res.redirect('/admin/schedules'); }
        const cfg = cleanConfig({ mode: b.mode, grace: b.grace, days, er: ea ? [ea, ez] : null });
        await saveSiteConfig(db, req.session.name, site.id, cfg);
        await audit(db, req.session, null, '', 'SCHEDULE_SETTINGS', site.name + ': ' + cfg.mode + ', ' + cfg.grace + ' minute grace, ' + Object.keys(cfg.days).length + ' day(s) set' + (cfg.er ? ', early release ' + cfg.er.join('-') : ''));
        flash(req, 'Saved the ' + site.name + ' schedule.');
        res.redirect('/admin/schedules');
    }));

    app.post('/admin/schedules/noschool', wrap(async (req, res) => {
        if (!needDistrict(req, res)) return;
        const db = getDb();
        const list = String((req.body || {}).dates || '').split(/[\s,;]+/).filter(Boolean);
        await saveNoSchool(db, req.session.name, list);
        await audit(db, req.session, null, '', 'SCHEDULE_NOSCHOOL', list.length + ' no-school date(s) saved');
        flash(req, 'Saved the no-school dates.');
        res.redirect('/admin/schedules');
    }));

    // District edits to the calendar: add or remove a special day.
    app.post('/admin/schedules/calendar', wrap(async (req, res) => {
        if (!needDistrict(req, res)) return;
        const db = getDb(), b = req.body || {}; await ensureCalendar(db);
        const date = String(b.date || '').trim();
        if (b.remove === '1') { await db.run('DELETE FROM school_calendar WHERE date = ?', [date]); await audit(db, req.session, null, '', 'CALENDAR_CHANGE', 'Removed ' + date + ' from the calendar'); flash(req, 'Removed ' + date + '.'); return res.redirect('/admin/schedules'); }
        const kind = String(b.kind || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)) || !Object.keys(KIND_NAMES).includes(kind)) { flash(req, 'Enter a date and pick what kind of day it is.', true); return res.redirect('/admin/schedules'); }
        const note = String(b.note || '').trim().slice(0, 60);
        await db.run('INSERT OR REPLACE INTO school_calendar (date, kind, note) VALUES (?,?,?)', [date, kind, note]);
        await audit(db, req.session, null, '', 'CALENDAR_CHANGE', date + ': ' + KIND_NAMES[kind] + (note ? ' (' + note + ')' : ''));
        flash(req, 'Saved ' + date + ' as ' + KIND_NAMES[kind].toLowerCase() + '.');
        res.redirect('/admin/schedules');
    }));

    // Which schedule one account follows (set from the account's edit page).
    app.post('/admin/accounts/schedule', wrap(async (req, res) => {
        if (!needAdmin(req, res)) return;
        const db = getDb(), id = parseInt((req.body || {}).id, 10), v = String((req.body || {}).schedule || '');
        const back = () => res.redirect('/admin/accounts/edit?id=' + id);
        if (!id || !(await scope.canManage(db, req.session, id))) return res.redirect('/admin/accounts');
        const emp = await db.get('SELECT name FROM employees WHERE id = ?', [id]);
        let label = 'its own school\'s schedule';
        if (v === 'none') label = 'no schedule (never restricted)';
        else if (/^site:\d+$/.test(v)) { const s = await db.get('SELECT name FROM sites WHERE id = ?', [parseInt(v.slice(5), 10)]); if (!s) { flash(req, 'That school was not found.', true); return back(); } label = s.name + ' schedule'; }
        else if (v !== '') { flash(req, 'Pick a schedule from the list.', true); return back(); }
        await setAssignment(db, req.session.name, id, v);
        await audit(db, req.session, id, emp.name, 'SCHEDULE_ASSIGN', 'Now follows ' + label);
        flash(req, 'Saved. ' + emp.name + ' follows ' + label + '.');
        back();
    }));

    // Everyone's schedule tab: their own coming days; managers also see the whole group for any day.
    app.get('/schedule', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const db = getDb(); await ensureCalendar(db);
        const days = await upcoming(db, req.session.userID, 21);
        const me = await db.get('SELECT is_admin, is_district FROM employees WHERE id = ?', [req.session.userID]);
        const sites = await db.all('SELECT DISTINCT s.name FROM memberships m JOIN sites s ON s.id = m.site_id WHERE m.employee_id = ?', [req.session.userID]);
        const asg = await getAssignment(db, req.session.userID);
        let roster = null, rosterDay = null;
        if (req.session.admin === 1) {
            const q = String((req.query || {}).date || '');
            const t = localParts().date;
            rosterDay = /^\d{4}-\d{2}-\d{2}$/.test(q) && !isNaN(Date.parse(q)) ? q : t;
            const people = (await scope.manageableAccounts(db, req.session)).filter(a => !a.is_admin && !a.is_district);
            const cal = await calendarMap(db), year = await schoolYear(db), extra = await noSchoolDays(db);
            const dow = new Date(rosterDay + 'T12:00:00Z').getUTCDay(), info = dayInfo(rosterDay, dow, cal, year, extra);
            roster = { info, rows: [] };
            for (const p of people) {
                const cfgs = await configsFor(db, p.id);
                const ws = info.school ? cfgs.map(c => windowFor(c.cfg, dow, info)).filter(Boolean) : [];
                const sn = cfgs.map(c => c.site.name).join(', ');
                roster.rows.push({ name: p.name, site: sn, window: ws.length ? windowText([ws.map(w => w[0]).sort()[0], ws.map(w => w[1]).sort().slice(-1)[0]]) : (info.school ? (cfgs.length ? 'Not scheduled' : 'No schedule set') : 'Off') });
            }
        }
        res.render('schedule', { days, siteNames: sites.map(s => s.name), assignment: asg, roster, rosterDay, isMgr: req.session.admin === 1 });
    }));

    // A manager lets one account clock in at any time today.
    app.post('/admin/schedules/allow', wrap(async (req, res) => {
        if (!needAdmin(req, res)) return;
        const db = getDb(), id = parseInt((req.body || {}).employee_id, 10);
        if (!(await scope.canManage(db, req.session, id))) { flash(req, 'You can not change that account.', true); return res.redirect('/admin/schedules'); }
        const emp = await db.get('SELECT name FROM employees WHERE id = ?', [id]);
        await ensure(db);
        if ((req.body || {}).undo === '1') { await db.run('DELETE FROM app_settings WHERE key = ?', ['sched_allow_' + id]); flash(req, 'Removed today\'s exception for ' + emp.name + '.'); }
        else { await setVal(db, 'sched_allow_' + id, localParts().date, req.session.name); await audit(db, req.session, id, emp.name, 'SCHEDULE_ALLOW_TODAY', 'Allowed to clock in at any time today'); flash(req, emp.name + ' can clock in at any time today.'); }
        res.redirect('/admin/schedules');
    }));
}

module.exports = mount;
Object.assign(module.exports, { ensureCalendar, calendarMap, dayInfo, upcoming, getAssignment, setAssignment, configsFor, KIND_NAMES, ensure, check, gate, getSiteConfig, saveSiteConfig, saveNoSchool, noSchoolDays, localParts, presetFor, PRESETS, DAYS });
