// "My profile": basic details and a read-only list of what the signed-in person is allowed to do.
// Student ID and assigned periods are set by a manager on the account edit page; people cannot change them here.
const bench = require('./bench');
const education = require('./education');

let ensured = null;
async function ensure(db) {
    if (!ensured) ensured = (async () => {
        const cols = (await db.all('PRAGMA table_info(employees)')).map(c => c.name);
        if (!cols.includes('student_id')) await db.run("ALTER TABLE employees ADD COLUMN student_id TEXT DEFAULT ''");
        if (!cols.includes('periods')) await db.run("ALTER TABLE employees ADD COLUMN periods TEXT DEFAULT ''");
    })().catch(e => { ensured = null; throw e; });
    return ensured;
}
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
const cleanId = v => String(v == null ? '' : v).replace(/[^0-9A-Za-z-]/g, '').slice(0, 20);
const cleanPeriods = v => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

// One entry per thing the portal gates. `group` only decides the heading it appears under.
function permissionsFor(ctx) {
    const { admin, district, resources, bench: hasBench, benchReady } = ctx;
    const p = (group, key, label, detail, on) => ({ group, key, label, detail, on: !!on });
    return [
        p('Timeclock', 'clock', 'Clock in and out', 'Punch in and out from your dashboard.', true),
        p('Timeclock', null, 'View and print your timecards', 'See past shifts and print a timecard.', true),
        p('Timeclock', 'requests', 'Request missed hours', 'Ask a manager to add hours you forgot to punch.', !admin),
        p('Resources', 'learn', 'Learn guides and quick links', 'Device guides and links for your program.', resources),
        p('Tech Bench', 'bench', 'Use the repair queue', 'See tickets, update status, add notes and photos.', hasBench),
        p('Tech Bench', 'bench_order', 'Order parts and log repairs', 'Use the Order a part and Log a repair forms.', hasBench && benchReady),
        p('Management', null, 'Approve missed-hours requests', 'Review requests from the people you manage.', admin),
        p('Management', null, 'Edit timecards and accounts', 'Fix shifts, reset passwords and edit accounts you manage.', admin),
        p('Management', 'bench_manage', 'Fee report and bench setup', 'Repair fee report, importing old tickets, deleting tickets.', admin && hasBench),
        p('District', null, 'See every school and program', 'Full access across all sites.', district),
        p('District', null, 'Audit log, assignments and backups', 'District-wide settings and the audit trail.', district)
    ];
}

function mount(app, getDb, wrap) {
    app.get('/profile', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const db = getDb(); await ensure(db);
        const me = await db.get('SELECT id, name, username, student_id, periods, is_admin, is_district FROM employees WHERE id = ?', [req.session.userID]);
        if (!me) return res.redirect('/');
        const memberships = await db.all(`SELECT s.name AS site, p.name AS program FROM memberships m JOIN sites s ON s.id = m.site_id JOIN programs p ON p.id = m.program_id WHERE m.employee_id = ? ORDER BY s.name, p.name`, [me.id]);
        const scopes = await db.all(`SELECT s.name AS site, COALESCE(p.name, 'All programs') AS program FROM scopes sc JOIN sites s ON s.id = sc.site_id LEFT JOIN programs p ON p.id = sc.program_id WHERE sc.employee_id = ? ORDER BY s.name, p.name`, [me.id]);
        const ctx = { admin: me.is_admin === 1, district: me.is_district === 1,
            resources: await education.hasResources(db, req.session).catch(() => false), bench: await bench.hasBench(db, req.session).catch(() => false) };
        ctx.benchReady = ctx.bench && bench.ready();
        const off = await require('./perms').denied(db, me.id);
        const perms = permissionsFor(ctx).map(x => x.key && off.has(x.key) && x.on ? Object.assign({}, x, { on: false, note: 'Turned off by an administrator.' }) : x), groups = [];
        if (off.has('bench')) perms.forEach(x => { if ((x.key === 'bench_order' || x.key === 'bench_manage') && x.on) { x.on = false; x.note = 'Needs the repair queue.'; } });
        perms.forEach(x => { let g = groups.find(y => y.name === x.group); if (!g) groups.push(g = { name: x.group, items: [] }); g.items.push(x); });
        res.render('profile', {
            me: { first: firstName(me.name), name: me.name, username: me.username, studentId: me.student_id || '', periods: me.periods || '' },
            role: ctx.district ? 'District administrator' : ctx.admin ? 'Manager' : 'Employee',
            places: memberships, manages: scopes, groups, onCount: perms.filter(x => x.on).length, total: perms.length
        });
    }));
}

module.exports = mount;
module.exports.ensure = ensure;
module.exports.cleanId = cleanId;
module.exports.cleanPeriods = cleanPeriods;
module.exports.permissionsFor = permissionsFor;
