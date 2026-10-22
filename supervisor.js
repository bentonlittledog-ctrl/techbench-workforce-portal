// supervisor.js - one account per person, plus a Supervisor panel limited by permissions.
//
// Everyone has a normal account (clock in, schedule, Tech Bench ...). People who supervise also have the Supervisor panel.
// What a supervisor may do is a list of permissions a district administrator ticks on Edit account.
//   - A supervisor with NO saved permission list keeps everything a manager had before (nothing changes until it is edited).
//   - District administrators always have everything.
//   - "Student manager" is a locked role: fixed permissions, set only by a district administrator, and student managers
//     cannot approve or change the timecards of district administrators or of other student managers.
// Also here: the Account migration page (district only), which merges or retires the old shared logins.

const KEYS = [
    { key: 'view', group: 'Timecards', label: 'See shifts and hours for the people I supervise' },
    { key: 'timecards_edit', group: 'Timecards', label: 'Edit, add and delete timecards' },
    { key: 'overtime', group: 'Timecards', label: 'Approve overtime' },
    { key: 'requests', group: 'Timecards', label: 'Approve missed-hours requests' },
    { key: 'schedules', group: 'Timecards', label: 'Set shift limits and clock-in schedules' },
    { key: 'accounts_view', group: 'People', label: 'Open the Accounts page' },
    { key: 'accounts_edit', group: 'People', label: 'Edit account details and school assignments' },
    { key: 'accounts_addremove', group: 'People', label: 'Add and remove accounts' },
    { key: 'passwords', group: 'People', label: 'Reset passwords' },
    { key: 'rates', group: 'People', label: 'See and change hourly rates and pay' },
    { key: 'bench_admin', group: 'Tech Bench', label: 'Fee report, school statements, imports and settings' }
];
const ALL = KEYS.map(k => k.key);

const ROLES = {
    supervisor: { name: 'Site supervisor (typical)', perms: ['view', 'timecards_edit', 'overtime', 'requests', 'schedules', 'accounts_view', 'accounts_edit', 'passwords'] },
    approver: { name: 'Timecard approver only', perms: ['view', 'overtime', 'requests'] },
    bench_lead: { name: 'Tech Bench lead', perms: ['view', 'overtime', 'schedules', 'bench_admin'] },
    full: { name: 'Full manager access', perms: ALL },
    student_manager: { name: 'Student manager (limited)', locked: true, perms: ['view', 'overtime', 'requests', 'schedules', 'accounts_view', 'passwords'] },
    custom: { name: 'Custom', perms: [] }
};

// Which pages each permission protects (any account that is a supervisor but not district).
const RULES = [
    { key: 'view', test: (m, p) => p === '/supervisor' },
    { key: 'timecards_edit', test: (m, p) => p === '/admin/shifts' || p.startsWith('/admin/shifts/') },
    { key: 'overtime', test: (m, p) => p.startsWith('/admin/overtime/') },
    { key: 'requests', test: (m, p) => p === '/admin/requests' || p.startsWith('/admin/requests/') },
    { key: 'schedules', test: (m, p) => p === '/admin/schedules' || p.startsWith('/admin/schedules/') || p === '/admin/accounts/schedule' || p === '/admin/accounts/shiftlimit' },
    { key: 'accounts_edit', test: (m, p) => m === 'POST' && ['/admin/accounts/save', '/admin/accounts/assign', '/admin/accounts/unassign', '/admin/accounts/permissions'].includes(p) },
    { key: 'accounts_view', test: (m, p) => p === '/admin/accounts' || p === '/admin/accounts/edit' },
    { key: 'accounts_addremove', test: (m, p) => p === '/admin/users/add' || p === '/admin/users/remove' },
    { key: 'passwords', test: (m, p) => p === '/admin/users/reset' },
    { key: 'bench_admin', test: (m, p) => /^\/bench\/(report|import|setup|settings|statements|hours)/.test(p) || p === '/bench/ticket/delete' }
];

let ensured = null;
async function ensure(db) {
    if (!ensured) ensured = (async () => {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS sup_role (employee_id INTEGER PRIMARY KEY, role TEXT NOT NULL, set_by INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS sup_perm (employee_id INTEGER NOT NULL, perm TEXT NOT NULL, PRIMARY KEY (employee_id, perm));
            CREATE TABLE IF NOT EXISTS account_retired (employee_id INTEGER PRIMARY KEY, retired_by INTEGER, merged_into INTEGER, note TEXT DEFAULT '', at TEXT DEFAULT CURRENT_TIMESTAMP);
        `);
    })().catch(e => { ensured = null; throw e; });
    return ensured;
}

// What this person may do in the Supervisor panel. Not configured = everything a manager had before.
async function load(db, id) {
    await ensure(db);
    const r = await db.get('SELECT role FROM sup_role WHERE employee_id = ?', [id]);
    if (!r) return { configured: false, role: null, perms: new Set(ALL) };
    const rows = await db.all('SELECT perm FROM sup_perm WHERE employee_id = ?', [id]);
    const perms = r.role === 'student_manager' ? ROLES.student_manager.perms : rows.map(x => x.perm).filter(k => ALL.includes(k));
    return { configured: true, role: r.role, perms: new Set(perms) };
}
async function isStudent(db, id) {
    try { await ensure(db); return !!(await db.get("SELECT 1 FROM sup_role WHERE employee_id = ? AND role = 'student_manager'", [id])); } catch (e) { return false; }
}
// Student managers may not act on district administrators or other student managers.
async function blockedForStudent(db, targetId) {
    const t = await db.get('SELECT is_district FROM employees WHERE id = ?', [targetId]);
    if (!t) return true;
    return t.is_district === 1 || await isStudent(db, targetId);
}
async function setAccess(db, actor, id, role, perms) {
    await ensure(db);
    const ticked = perms.filter(k => ALL.includes(k));
    const list = role === 'student_manager' ? ROLES.student_manager.perms : (role === 'full' ? ALL : (role !== 'custom' && !ticked.length && ROLES[role] ? ROLES[role].perms : ticked));
    await db.run('DELETE FROM sup_perm WHERE employee_id = ?', [id]);
    await db.run('INSERT OR REPLACE INTO sup_role (employee_id, role, set_by) VALUES (?, ?, ?)', [id, role, actor]);
    for (const k of list) await db.run('INSERT INTO sup_perm (employee_id, perm) VALUES (?, ?)', [id, k]);
    return list;
}
async function clearAccess(db, id) { await ensure(db); await db.run('DELETE FROM sup_perm WHERE employee_id = ?', [id]); await db.run('DELETE FROM sup_role WHERE employee_id = ?', [id]); }

// Runs on every request: loads the supervisor's permissions and blocks pages they do not have.
function middleware(getDb) {
    return async (req, res, next) => {
        req.sup = { district: false, perms: new Set(), student: false, can: () => false };
        try {
            const s = req.session;
            if (!s || !s.userID || s.admin !== 1) return next();
            if (s.district === 1) { req.sup = { district: true, perms: new Set(ALL), student: false, can: () => true }; return next(); }
            const a = await load(getDb(), s.userID);
            req.sup = { district: false, perms: a.perms, student: a.role === 'student_manager', role: a.role, can: k => a.perms.has(k) };
            const hit = RULES.find(r => r.test(req.method, req.path) && !a.perms.has(r.key));
            if (!hit) return next();
            const label = (KEYS.find(k => k.key === hit.key) || {}).label || 'This page';
            if (req.method !== 'GET') return res.status(403).type('html').send('<p style="font-family:sans-serif;padding:24px">Your account does not have this permission (' + label.replace(/</g, '') + '). Ask a district administrator. <a href="/dashboard">Back</a></p>');
            return res.redirect('/dashboard');
        } catch (e) { return next(e); }
    };
}

// ---------- matching shared logins to real people ----------
const NOISE = new Set(['supervisor', 'admin', 'administrator', 'manager', 'district', 'sup', 'mgr']);
const tokens = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t && !NOISE.has(t));
function sameHuman(a, b) {
    const x = tokens(a), y = tokens(b);
    if (x.length < 2 || y.length < 2) return false;
    return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}
function looksShared(p) {
    const t = tokens(p.name);
    return t.length < 2 || /\b(admin|administrator|manager|district|office|bench|it|wbl|shared|general)\b/i.test(p.name || '') || /^(admin|administrator|manager|district|it|wbl)/i.test(p.username || '');
}
function suggest(p, people) {
    const hit = people.find(o => o.id !== p.id && !o.retired && sameHuman(p.name, o.name));
    if (hit) return { kind: 'merge', target: hit };
    if (looksShared(p)) return { kind: 'shared' };
    return { kind: 'person' };
}
const STUDENT_RE = /^\s*(enzo\s+vi|benton\s+little)/i;

async function candidates(db) {
    await ensure(db);
    const all = await db.all(`SELECT e.id, e.name, e.username, e.is_admin, e.is_district,
        (SELECT COUNT(*) FROM logs l WHERE l.employee_id = e.id) AS logs,
        (SELECT role FROM sup_role r WHERE r.employee_id = e.id) AS sup_role,
        EXISTS(SELECT 1 FROM account_retired a WHERE a.employee_id = e.id) AS retired
        FROM employees e ORDER BY e.name`);
    return all.map(p => ({ ...p, retired: !!p.retired }));
}

// Turns what the district admin picked into steps (and checks they are safe).
async function plan(db, session, choices) {
    const people = await candidates(db);
    const by = new Map(people.map(p => [p.id, p]));
    const steps = [], problems = [];
    const retiring = new Set(), demoting = new Set();
    for (const c of choices) {
        const p = by.get(c.id);
        if (!p || p.retired || !(p.is_admin || p.is_district) || c.action === 'keep' || !c.action) continue;
        if (p.id === session.userID && c.action !== 'real') { problems.push('You cannot retire, merge or change your own account here. Ask another district administrator.'); continue; }
        if (c.action === 'real') { steps.push({ type: 'real', p }); continue; }
        if (c.action === 'retire') { retiring.add(p.id); steps.push({ type: 'retire', p }); continue; }
        if (c.action === 'student') { if (p.is_district) demoting.add(p.id); steps.push({ type: 'student', p }); continue; }
        if (c.action === 'merge') {
            const t = by.get(c.target);
            if (!t || t.id === p.id || t.retired) { problems.push(p.name + ': choose a different account to merge into.'); continue; }
            retiring.add(p.id); if (p.is_district && !t.is_district) { /* target becomes district */ }
            steps.push({ type: 'merge', p, t });
        }
    }
    // Always keep at least one district administrator who is not being retired or demoted.
    const keep = people.filter(p => p.is_district && !p.retired && !retiring.has(p.id) && !demoting.has(p.id)).length
        + steps.filter(s => s.type === 'merge' && s.p.is_district).length;
    if (!keep) problems.push('There must always be at least one active district administrator.');
    return { steps, problems };
}

function describe(s) {
    if (s.type === 'real') return s.p.name + ' stays a supervisor with a personal side. Give them a school and hourly rate on Edit account if they will clock in.';
    if (s.type === 'retire') return s.p.name + ' (' + s.p.username + ') is retired: nobody can sign in with it, nothing is deleted, and it can be turned back on.';
    if (s.type === 'student') return s.p.name + ' becomes a Student manager: limited Supervisor panel' + (s.p.is_district ? ', and loses district access (assign their school on Sites & assignments)' : '') + '.';
    return s.t.name + ' gets ' + (s.p.is_district ? 'district administrator access' : 'Supervisor access to the same schools') + '. ' + s.p.name + ' (' + s.p.username + ')' + (s.p.logs ? ' has ' + s.p.logs + ' punches that move over, and' : '') + ' is retired.';
}

async function apply(db, session, steps) {
    const sec = require('./security');
    const audit = (target, action, details) => db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [session.userID, session.name || '', target.id, target.name, action, details, '']);
    const ended = [];
    await db.run('BEGIN');
    try {
        for (const s of steps) {
            const p = s.p;
            if (s.type === 'real') { await audit(p, 'MIGRATE_REAL_PERSON', 'Kept as a supervisor with a personal side'); continue; }
            if (s.type === 'student') {
                await db.run('UPDATE employees SET is_admin = 1, is_district = 0 WHERE id = ?', [p.id]);
                await setAccess(db, session.userID, p.id, 'student_manager', []);
                await audit(p, 'MIGRATE_STUDENT_MANAGER', 'Made a Student manager' + (p.is_district ? ' (district access removed)' : ''));
                continue;
            }
            if (s.type === 'retire') {
                await db.run('INSERT OR REPLACE INTO account_retired (employee_id, retired_by, note) VALUES (?, ?, ?)', [p.id, session.userID, 'shared login']);
                await audit(p, 'MIGRATE_RETIRE', 'Retired (can be turned back on)'); ended.push(p.id); continue;
            }
            if (s.type === 'merge') {
                const t = s.t;
                const open = await db.get("SELECT action FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1", [p.id]);
                if (open && open.action === 'CLOCK_IN') throw new Error('open-shift:' + p.name);
                if (p.is_district) await db.run('UPDATE employees SET is_admin = 1, is_district = 1 WHERE id = ?', [t.id]);
                else await db.run('UPDATE employees SET is_admin = 1 WHERE id = ?', [t.id]);
                await db.run('INSERT INTO scopes (employee_id, site_id, program_id) SELECT ?, site_id, program_id FROM scopes WHERE employee_id = ? AND NOT EXISTS (SELECT 1 FROM scopes x WHERE x.employee_id = ? AND x.site_id = scopes.site_id AND x.program_id IS scopes.program_id)', [t.id, p.id, t.id]);
                const cfg = await db.get('SELECT role FROM sup_role WHERE employee_id = ?', [p.id]);
                if (cfg && !p.is_district) {
                    const list = (await db.all('SELECT perm FROM sup_perm WHERE employee_id = ?', [p.id])).map(r => r.perm);
                    await setAccess(db, session.userID, t.id, cfg.role, list);
                } else if (p.is_district) await clearAccess(db, t.id);
                if (p.logs) await db.run('UPDATE logs SET employee_id = ? WHERE employee_id = ?', [t.id, p.id]);
                await db.run('INSERT OR REPLACE INTO account_retired (employee_id, retired_by, merged_into, note) VALUES (?, ?, ?, ?)', [p.id, session.userID, t.id, 'merged']);
                await audit(t, 'MIGRATE_MERGE', 'Took over ' + p.name + ' (' + p.username + '): ' + (p.is_district ? 'district access' : 'supervisor access') + (p.logs ? ', ' + p.logs + ' punches moved' : ''));
                await audit(p, 'MIGRATE_RETIRE', 'Merged into ' + t.name + ' and retired'); ended.push(p.id);
            }
        }
        await db.run('COMMIT');
    } catch (e) { await db.run('ROLLBACK'); throw e; }
    for (const id of ended) await sec.endSessions(db, id).catch(() => {});
}

async function restore(db, session, id) {
    await ensure(db);
    const e = await db.get('SELECT id, name FROM employees WHERE id = ?', [id]);
    const r = await db.get('SELECT merged_into FROM account_retired WHERE employee_id = ?', [id]);
    if (!e || !r) return false;
    await db.run('DELETE FROM account_retired WHERE employee_id = ?', [id]);
    await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [session.userID, session.name || '', e.id, e.name, 'MIGRATE_RESTORE', 'Turned back on' + (r.merged_into ? ' (punches that were moved stay with the merged account)' : ''), '']);
    return true;
}

async function isRetired(db, id) { try { await ensure(db); return !!(await db.get('SELECT 1 FROM account_retired WHERE employee_id = ?', [id])); } catch (e) { return false; } }

function mount(app, getDb, wrap) {
    const needDistrict = (req, res) => { if (req.session.district !== 1) { res.redirect(req.session.userID ? '/dashboard' : '/'); return true; } return false; };
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const take = req => { const f = req.session.flash || null; delete req.session.flash; return f; };

    // Save one supervisor's permissions (district only)
    app.post('/admin/accounts/supervisor', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb(); await ensure(db);
        const id = parseInt(req.body.id, 10);
        const e = await db.get('SELECT id, name, is_admin, is_district FROM employees WHERE id = ?', [id]);
        const back = '/admin/accounts/edit?id=' + id;
        if (!e || id === req.session.userID || e.is_district || !e.is_admin) { flash(req, 'Supervisor access can only be set for another supervisor who is not a district administrator.', true); return res.redirect(e ? back : '/admin/accounts'); }
        const role = String(req.body.role || 'custom');
        if (!ROLES[role]) { flash(req, 'Choose a role.', true); return res.redirect(back); }
        const perms = [].concat(req.body.perm || []).map(String);
        const before = await load(db, id);
        const list = await setAccess(db, req.session.userID, id, role, perms);
        await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.session.userID, req.session.name || '', e.id, e.name, 'SUPERVISOR_ACCESS', ROLES[role].name + ': ' + (list.length ? list.join(', ') : 'nothing') + (before.configured ? '' : ' (was: everything)'), '']);
        flash(req, 'Supervisor access saved.');
        res.redirect(back);
    }));
    app.post('/admin/accounts/supervisor/reset', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb(); await ensure(db);
        const id = parseInt(req.body.id, 10);
        const e = await db.get('SELECT id, name FROM employees WHERE id = ?', [id]);
        if (!e || id === req.session.userID) return res.redirect('/admin/accounts');
        await clearAccess(db, id);
        await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.session.userID, req.session.name || '', e.id, e.name, 'SUPERVISOR_ACCESS', 'Back to full manager access', '']);
        flash(req, 'Back to full manager access.');
        res.redirect('/admin/accounts/edit?id=' + id);
    }));

    // Account migration page
    async function pageData(db, req, extra) {
        const people = await candidates(db);
        const sup = people.filter(p => (p.is_admin || p.is_district) && !p.retired);
        const rows = sup.map(p => {
            const s = suggest(p, people.filter(o => !(o.is_district && !o.is_admin)));
            return { ...p, sug: s, student: STUDENT_RE.test(p.name || ''), self: p.id === req.session.userID };
        });
        return { rows, normals: people.filter(p => !p.retired).map(p => ({ id: p.id, name: p.name, username: p.username })), retired: people.filter(p => p.retired), flash: take(req), plan: null, ...extra };
    }
    app.get('/admin/migration', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        res.render('admin_migration', await pageData(getDb(), req, {}));
    }));
    const readChoices = body => {
        const ids = [].concat(body.id || []).map(n => parseInt(n, 10));
        return ids.map(id => ({ id, action: String(body['action_' + id] || 'keep'), target: parseInt(body['target_' + id], 10) || 0 }));
    };
    app.post('/admin/migration/preview', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb(); const choices = readChoices(req.body);
        const pl = await plan(db, req.session, choices);
        const data = await pageData(db, req, { plan: { steps: pl.steps.map(describe), problems: pl.problems, choices, ok: pl.steps.length > 0 && !pl.problems.length } });
        data.choice = Object.fromEntries(choices.map(c => [c.id, c]));
        res.render('admin_migration', data);
    }));
    app.post('/admin/migration/apply', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb(); const choices = readChoices(req.body);
        const pl = await plan(db, req.session, choices);
        if (!pl.steps.length || pl.problems.length) { flash(req, pl.problems[0] || 'Nothing to apply.', true); return res.redirect('/admin/migration'); }
        try { await apply(db, req.session, pl.steps); }
        catch (e) {
            if (/^open-shift:/.test(e.message)) { flash(req, e.message.slice(11) + ' is still clocked in. Clock them out first, then try again. Nothing was changed.', true); return res.redirect('/admin/migration'); }
            throw e;
        }
        flash(req, 'Done: ' + pl.steps.length + ' change' + (pl.steps.length === 1 ? '' : 's') + ' applied.');
        res.redirect('/admin/migration');
    }));
    app.post('/admin/migration/restore', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const ok = await restore(getDb(), req.session, parseInt(req.body.id, 10));
        flash(req, ok ? 'Account turned back on.' : 'That account is not retired.', !ok);
        res.redirect('/admin/migration');
    }));
}

module.exports = { KEYS, ALL, ROLES, RULES, ensure, load, isStudent, blockedForStudent, setAccess, clearAccess, middleware, mount, suggest, sameHuman, plan, apply, restore, isRetired, candidates, describe, STUDENT_RE };
