// Administrator on/off switches for what an account may use.
// An administrator can only turn OFF things the account would otherwise have (from its type and its site/program assignments);
// they can never grant more than the assignments allow. Turning a switch back on removes the restriction.
const bench = require('./bench');
const education = require('./education');

const KEYS = ['clock', 'requests', 'learn', 'bench', 'bench_order', 'bench_manage'];
// Which pages each switch protects. Anything under /bench needs "bench"; the rest are narrower.
const RULES = [
    { key: 'clock', test: (m, p) => m === 'POST' && p === '/punch', what: 'Clocking in and out' },
    { key: 'requests', test: (m, p) => p === '/requests' || p.startsWith('/requests/'), what: 'Requesting missed hours' },
    { key: 'learn', test: (m, p) => p === '/learn' || p.startsWith('/learn/') || p === '/links' || p.startsWith('/links/'), what: 'Learn guides and quick links' },
    { key: 'bench_manage', test: (m, p) => /^\/bench\/(report|import|setup)/.test(p) || p === '/bench/ticket/delete', what: 'This Tech Bench admin page' },
    { key: 'bench_order', test: (m, p) => /^\/bench\/(order|repair)/.test(p), what: 'Ordering parts and logging repairs' },
    { key: 'bench', test: (m, p) => p === '/bench' || p.startsWith('/bench/'), what: 'The Tech Bench' }
];

let ensured = null;
async function ensure(db) {
    if (!ensured) ensured = db.exec(`CREATE TABLE IF NOT EXISTS permission_denials (
        employee_id INTEGER NOT NULL, perm TEXT NOT NULL, set_by INTEGER, set_by_name TEXT DEFAULT '', at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (employee_id, perm))`).catch(e => { ensured = null; throw e; });
    return ensured;
}
async function denied(db, id) {
    await ensure(db);
    return new Set((await db.all('SELECT perm FROM permission_denials WHERE employee_id = ?', [id])).map(r => r.perm));
}

// Runs on every request after sign-in: remembers the restrictions and blocks the pages they cover.
function middleware(getDb) {
    return async (req, res, next) => {
        req.permDenied = new Set();
        if (!req.session || !req.session.userID) return next();
        try {
            req.permDenied = await denied(getDb(), req.session.userID);
            if (!req.permDenied.size || req.session.district === 1) return next();
            const hit = RULES.find(r => req.permDenied.has(r.key) && r.test(req.method, req.path));
            if (!hit) return next();
            if (req.method !== 'GET') return res.status(403).type('html').send('<p style="font-family:sans-serif;padding:24px">' + hit.what + ' is turned off for your account. Ask your manager. <a href="/dashboard">Back to the dashboard</a></p>');
            return res.redirect('/dashboard');
        } catch (e) { return next(e); }
    };
}

// Rows for the admin's switch panel: what the account has by default, what is restricted, and what this editor may change.
async function rowsFor(db, target, editor) {
    const fake = { userID: target.id, admin: target.is_admin === 1 ? 1 : 0, district: target.is_district === 1 ? 1 : 0 };
    const ctx = { admin: fake.admin === 1, district: fake.district === 1,
        resources: await education.hasResources(db, fake).catch(() => false), bench: await bench.hasBench(db, fake).catch(() => false) };
    ctx.benchReady = ctx.bench && bench.ready();
    const off = await denied(db, target.id);
    const isSelf = editor.userID === target.id, targetDistrict = ctx.district;
    return require('./profile').permissionsFor(ctx).map(x => {
        const row = { key: x.key, group: x.group, label: x.label, detail: x.detail, base: x.on, on: x.on && !(x.key && off.has(x.key)), editable: false, why: '' };
        if (!x.key) row.why = x.on ? 'Set by the account type.' : 'Not part of this account type.';
        else if (targetDistrict) row.why = 'District administrators cannot be restricted.';
        else if (isSelf) row.why = 'You cannot change your own permissions.';
        else if (x.key === 'bench_manage' && editor.district !== 1) { row.why = 'Only a district administrator can change this.'; }
        else if (!x.on) row.why = x.key === 'requests' ? 'Managers do not use this.' : x.key === 'bench_order' && ctx.bench && !bench.ready() ? 'The sheet connection is not set up yet.' : 'Not part of this account. Add a site and program first.';
        else row.editable = true;
        return row;
    });
}

// Applies the switches the editor submitted. `allow` = keys left ON. Returns a list of plain-language changes.
async function apply(db, editor, target, allow) {
    const rows = await rowsFor(db, target, editor), on = new Set(allow), changes = [];
    for (const r of rows) {
        if (!r.editable) continue;
        const want = on.has(r.key);
        if (want === r.on) continue;
        if (want) await db.run('DELETE FROM permission_denials WHERE employee_id = ? AND perm = ?', [target.id, r.key]);
        else await db.run('INSERT OR REPLACE INTO permission_denials (employee_id, perm, set_by, set_by_name) VALUES (?,?,?,?)', [target.id, r.key, editor.userID, editor.name || '']);
        changes.push((want ? 'turned on ' : 'turned off ') + r.label.toLowerCase());
    }
    return changes;
}

module.exports = { KEYS, RULES, ensure, denied, middleware, rowsFor, apply };
