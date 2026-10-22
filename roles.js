// roles.js - the five account roles and what each may do in the admin pages.
//
//   0 Employee                 clocks in, uses the portal (is_admin = 0)
//   1 Location Coordinator     a teacher in charge of a school's programs (was "Manager"; is_admin = 1)
//   2 District administrator   everything (is_admin = 1, is_district = 1)
//   3 Student General Manager  head student of one program; fewer permissions than a Location Coordinator (is_admin = 1)
//   4 Student Manager          direct point of contact / task owner in a program; limited, no major edits (is_admin = 1)
//
// Anyone with is_admin = 1 and no saved role is a Location Coordinator, so every existing manager keeps exactly what they had.
// Only district administrators change pay rates or roles. Student roles are limited to specific programs
// (never "all programs"), cannot act on district administrators, Location Coordinators or on themselves.

const NAMES = { 0: 'Employee', 1: 'Location Coordinator', 2: 'District administrator', 3: 'Student General Manager', 4: 'Student Manager' };
const SUPERVISING = [1, 3, 4];                    // roles that have scopes (areas they oversee)
const isStudent = code => code === 3 || code === 4;

const KEYS = ['view', 'requests', 'overtime', 'schedules', 'passwords', 'accounts_view', 'accounts_edit', 'accounts_addremove', 'timecards_edit', 'pay_view', 'bench_admin'];
const PERMS = {
    1: KEYS,
    3: ['view', 'requests', 'overtime', 'schedules', 'passwords', 'accounts_view', 'accounts_edit', 'pay_view', 'bench_admin'],
    4: ['view', 'requests', 'overtime', 'schedules', 'passwords', 'accounts_view']
};

// Which pages each permission protects
const RULES = [
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
    if (!ensured) ensured = db.exec('CREATE TABLE IF NOT EXISTS account_role (employee_id INTEGER PRIMARY KEY, role INTEGER NOT NULL, set_by INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP)')
        .catch(e => { ensured = null; throw e; });
    return ensured;
}

// The role of one account row ({ id, is_admin, is_district })
async function codeOf(db, e) {
    if (e.is_district) return 2;
    if (!e.is_admin) return 0;
    await ensure(db);
    const r = await db.get('SELECT role FROM account_role WHERE employee_id = ?', [e.id]);
    return r && [3, 4].includes(r.role) ? r.role : 1;
}
async function codesFor(db, people) {
    await ensure(db);
    const rows = await db.all('SELECT employee_id, role FROM account_role');
    const m = new Map(rows.map(r => [r.employee_id, r.role]));
    return new Map(people.map(p => [p.id, p.is_district ? 2 : (!p.is_admin ? 0 : ([3, 4].includes(m.get(p.id)) ? m.get(p.id) : 1))]));
}
async function setRole(db, actorId, id, code) {
    await ensure(db);
    if (isStudent(code)) await db.run('INSERT OR REPLACE INTO account_role (employee_id, role, set_by) VALUES (?, ?, ?)', [id, code, actorId || null]);
    else await db.run('DELETE FROM account_role WHERE employee_id = ?', [id]);
}

// Student roles never act on district administrators, Location Coordinators, themselves, or (for a Student Manager) another student.
// A Student General Manager may act on Student Managers in their program.
async function blockedForStudent(db, actorCode, target) {
    const code = await codeOf(db, target);
    if (code === 2 || code === 1 || code === 3) return true;
    if (code === 4 && actorCode === 4) return true;
    return false;
}

function middleware(getDb) {
    return async (req, res, next) => {
        req.sup = { district: false, code: 0, perms: new Set(), student: false, can: () => false };
        try {
            const s = req.session;
            if (!s || !s.userID || s.admin !== 1) return next();
            if (s.district === 1) { req.sup = { district: true, code: 2, perms: new Set(KEYS), student: false, can: () => true }; return next(); }
            const code = await codeOf(getDb(), { id: s.userID, is_admin: 1, is_district: 0 });
            const perms = new Set(PERMS[code] || PERMS[1]);
            req.sup = { district: false, code, perms, student: isStudent(code), can: k => perms.has(k) };
            const hit = RULES.find(r => r.test(req.method, req.path) && !perms.has(r.key));
            if (!hit) return next();
            if (req.method !== 'GET') return res.status(403).type('html').send('<p style="font-family:sans-serif;padding:24px">Your role (' + NAMES[code] + ') does not include this. Ask a district administrator. <a href="/dashboard">Back</a></p>');
            return res.redirect('/dashboard');
        } catch (e) { return next(e); }
    };
}

module.exports = { NAMES, SUPERVISING, KEYS, PERMS, RULES, isStudent, ensure, codeOf, codesFor, setRole, blockedForStudent, middleware };
